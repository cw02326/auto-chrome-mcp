import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
// auto-chrome-mcp fork: iframe 안의 요소까지 찾기 위한 프레임 열거 유틸
import { FRAME_COLLECT_MAX_FRAMES, listChildFrames } from './frame-resolver';

/**
 * auto-chrome-mcp fork: chrome_find — "자연어로 요소 찾기" 도구.
 *
 * 기존 흐름은 chrome_read_page 로 페이지 전체 트리를 읽어서 모델이 그 안에서 대상 요소를
 * 눈으로 골라내는 방식이었다. 대부분의 경우 모델이 원하는 건 "로그인 버튼" 하나인데
 * 수천 토큰짜리 트리를 통째로 읽는 셈이라 낭비가 크고, 트리가 잘리면 아예 못 찾는다.
 *
 * chrome_find 는 helper 에서 평면 후보 목록(ref/role/name/text/좌표…)만 받아와,
 * background 에서 결정적(deterministic) 점수 계산으로 상위 N개만 돌려준다.
 *  - LLM 호출 없음 → 비용 0, 재현 가능
 *  - 한국어/영어 동의어 + 조사 제거 + 오타 허용(편집거리 1)
 *  - 응답에 ref 가 들어가므로 chrome_click_element / chrome_fill_or_select 로 바로 이어진다.
 *
 * TOOL_NAMES 상수에는 orchestrator 가 별도로 추가하므로 여기서는 이름을 문자열로 고정한다.
 */

interface FindParams {
  query?: string;
  tabId?: number;
  windowId?: number;
  maxResults?: number;
  allFrames?: boolean;
}

/** helper(accessibility-tree-helper.js)가 돌려주는 후보 한 건 */
interface RawCandidate {
  ref: string;
  role: string;
  name: string;
  text: string;
  placeholder: string;
  value: string;
  title: string;
  href: string;
  inputType: string;
  cx: number;
  cy: number;
  visible: boolean;
  interactive: boolean;
}

/** 프레임 정보가 붙은 후보 */
interface Candidate extends RawCandidate {
  frameId?: number;
  frameUrl?: string;
}

interface ScoredCandidate {
  candidate: Candidate;
  score: number;
  /** 동점 시 이름이 짧은 쪽 우선 (이름 없는 후보는 뒤로) */
  nameLen: number;
}

/** helper 메시지 action — helper 쪽 리스너와 문자열이 일치해야 한다 */
const FIND_CANDIDATES_ACTION = 'chrome_find_get_candidates';
const HELPER_FILE = 'inject-scripts/accessibility-tree-helper.js';

const DEFAULT_MAX_RESULTS = 5;
const MAX_MAX_RESULTS = 20;
/** 이 점수 미만이면 "찾았다"고 보고하지 않는다(엉뚱한 요소를 클릭하게 만드는 것이 최악) */
const MIN_SCORE = 15;
/** 응답 전체 문자 수 상한 */
const MAX_RESPONSE_CHARS = 8000;
const MAX_NAME_CHARS = 80;
const MAX_TEXT_CHARS = 120;

const MATCH_HINT =
  'use ref with chrome_click_element/chrome_fill_or_select (pass frameId when present); or coordinates with chrome_computer';
const NO_MATCH_SUGGESTION =
  'No candidate scored above the minimum threshold. Simplify the query (e.g. just the visible label text), or try chrome_read_page for the full tree.';

// ---------------------------------------------------------------------------
// 점수 가중치 (한 곳에 모아둔다 — 튜닝 시 여기만 본다)
// ---------------------------------------------------------------------------
const W_EXACT_PHRASE = 100; // 질의 전체가 후보 텍스트에 그대로 포함
const W_ALL_TOKENS = 70; // 모든 토큰이 포함
const W_TOKEN_SUBSTRING = 15; // 토큰 하나당 부분 일치
const W_TOKEN_FUZZY = 8; // 토큰 하나당 편집거리 1 이내 근사 일치
const W_ROLE_EXACT = 40; // 동의어가 지목한 role 과 정확히 일치
const W_ROLE_FAMILY = 20; // 같은 role 계열
const W_NAME_BOOST = 25; // 동의어가 지목한 이름 키워드가 후보 텍스트에 존재
const W_ANY_INTERACTIVE = 20; // '아이콘'처럼 role 을 특정할 수 없고 상호작용만 요구하는 동의어
const W_ACTION_INTERACTIVE = 10; // 질의가 행동을 암시할 때 상호작용 요소 가산
const W_VISIBLE = 10; // 뷰포트 안에 보이는 요소 가산

/**
 * 스크립트 주입이 불가능한 페이지 (wait-for.ts 의 가드와 동일한 목록).
 */
function isRestrictedUrl(url?: string): boolean {
  if (!url) return false;
  return (
    url.startsWith('chrome://') ||
    url.startsWith('edge://') ||
    url.startsWith('devtools://') ||
    url.startsWith('https://chrome.google.com/webstore') ||
    url.startsWith('https://chromewebstore.google.com') ||
    url.startsWith('https://microsoftedge.microsoft.com/')
  );
}

/** 한국어 조사 — 토큰 끝에서 떼어낸다. 긴 것부터 검사해야 '으로'가 '로'로 잘리지 않는다. */
const KOREAN_PARTICLES = ['으로', '를', '을', '이', '가', '은', '는', '의', '에', '로'];

interface SynonymEntry {
  /** 이 동의어가 지목하는 role 들 */
  roles?: string[];
  /** role 대신(또는 함께) 이름에서 찾아야 할 키워드 */
  nameBoost?: string[];
  /** role 을 특정할 수 없고 "상호작용 요소면 된다"는 뜻 */
  anyInteractive?: boolean;
}

/**
 * 한국어/영어 → role 동의어 사전.
 * 사용자가 "로그인 버튼"이라고 쓰면 '버튼'은 role=button 을, '로그인'은 이름 키워드를 지목한다.
 */
const ROLE_SYNONYMS: Record<string, SynonymEntry> = {
  버튼: { roles: ['button'] },
  btn: { roles: ['button'] },
  button: { roles: ['button'] },

  링크: { roles: ['link'] },
  link: { roles: ['link'] },

  입력: { roles: ['textbox', 'searchbox'] },
  입력창: { roles: ['textbox', 'searchbox'] },
  인풋: { roles: ['textbox', 'searchbox'] },
  텍스트박스: { roles: ['textbox', 'searchbox'] },
  input: { roles: ['textbox', 'searchbox'] },
  field: { roles: ['textbox', 'searchbox'] },
  textbox: { roles: ['textbox', 'searchbox'] },
  box: { roles: ['textbox', 'searchbox'] },

  검색: { roles: ['searchbox', 'textbox'], nameBoost: ['search', '검색'] },
  search: { roles: ['searchbox', 'textbox'], nameBoost: ['search', '검색'] },

  체크박스: { roles: ['checkbox'] },
  checkbox: { roles: ['checkbox'] },

  라디오: { roles: ['radio'] },
  radio: { roles: ['radio'] },

  드롭다운: { roles: ['combobox', 'listbox'] },
  선택: { roles: ['combobox', 'listbox'] },
  셀렉트: { roles: ['combobox', 'listbox'] },
  select: { roles: ['combobox', 'listbox'] },
  dropdown: { roles: ['combobox', 'listbox'] },
  combobox: { roles: ['combobox', 'listbox'] },

  이미지: { roles: ['image', 'img'] },
  사진: { roles: ['image', 'img'] },
  image: { roles: ['image', 'img'] },
  img: { roles: ['image', 'img'] },

  아이콘: { anyInteractive: true, nameBoost: ['icon', '아이콘'] },
  icon: { anyInteractive: true, nameBoost: ['icon', '아이콘'] },

  메뉴: { roles: ['menu', 'menuitem'] },
  menu: { roles: ['menu', 'menuitem'] },

  탭: { roles: ['tab'] },
  tab: { roles: ['tab'] },

  제목: { roles: ['heading'] },
  헤딩: { roles: ['heading'] },
  heading: { roles: ['heading'] },
  title: { roles: ['heading'] },

  로그인: { nameBoost: ['로그인', 'login', 'log in', 'signin', 'sign in'] },
  login: { nameBoost: ['로그인', 'login', 'log in', 'signin', 'sign in'] },
  signin: { nameBoost: ['로그인', 'login', 'log in', 'signin', 'sign in'] },

  장바구니: { nameBoost: ['장바구니', 'cart', 'basket', '카트'] },
  cart: { nameBoost: ['장바구니', 'cart', 'basket', '카트'] },
};

/** role 계열 — 정확히 일치하지 않아도 같은 계열이면 부분 점수를 준다 */
const ROLE_FAMILIES: string[][] = [
  ['textbox', 'searchbox', 'combobox', 'listbox', 'spinbutton', 'slider', 'input', 'select'],
  [
    'button',
    'link',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'tab',
    'option',
    'switch',
    'submit',
  ],
  ['checkbox', 'radio', 'switch'],
  ['heading', 'label', 'title', 'text', 'paragraph'],
  ['image', 'img', 'figure'],
  ['menu', 'menubar', 'menuitem', 'navigation'],
];

/** 질의가 "행동"을 암시하는지 판단할 단어들 */
const ACTION_WORDS = [
  '클릭',
  '누르',
  '눌러',
  '선택',
  '입력',
  '검색',
  '제출',
  '전송',
  '로그인',
  '버튼',
  '링크',
  'click',
  'press',
  'tap',
  'type',
  'fill',
  'enter',
  'submit',
  'button',
  'link',
  'login',
  'search',
  'select',
  'choose',
  'open',
];

function normalize(text: unknown): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** 토큰 끝의 한국어 조사 제거 ("로그인을" → "로그인") */
function stripParticle(token: string): string {
  if (!/[가-힣]/.test(token)) return token;
  for (const particle of KOREAN_PARTICLES) {
    // 조사를 떼고도 2글자 이상 남을 때만 자른다 ("회의"의 '의' 같은 오탈락 방지)
    if (token.length > particle.length + 1 && token.endsWith(particle)) {
      return token.slice(0, token.length - particle.length);
    }
  }
  return token;
}

function tokenize(query: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of normalize(query).split(/[\s,./|"'()[\]{}]+/)) {
    if (!raw) continue;
    const token = stripParticle(raw);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/**
 * 편집거리 1 이내인지 판정하는 작은 유계(bounded) 레벤슈타인.
 * 전체 DP 를 돌리지 않고 한 번의 스캔으로 판정한다 — 후보 수 × 토큰 수만큼 호출되므로 비용이 중요하다.
 */
function withinEditDistanceOne(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;

  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (la === lb) {
      i++;
      j++;
    } else if (la > lb) {
      i++;
    } else {
      j++;
    }
  }
  if (i < la || j < lb) edits++;
  return edits <= 1;
}

function sameRoleFamily(roleA: string, roleB: string): boolean {
  if (!roleA || !roleB) return false;
  return ROLE_FAMILIES.some((family) => family.includes(roleA) && family.includes(roleB));
}

/** URL 의 마지막 경로 조각 (예: /account/login?x=1 → "login") */
function hrefTail(href: string): string {
  if (!href) return '';
  const withoutQuery = href.split('?')[0].split('#')[0];
  const parts = withoutQuery.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/** 질의에서 뽑아낸 의도(동의어 해석 결과) */
interface QueryIntent {
  rawQuery: string;
  tokens: string[];
  tokenPhrase: string;
  roles: Set<string>;
  nameBoosts: string[];
  anyInteractive: boolean;
  actionImplied: boolean;
}

function buildIntent(query: string): QueryIntent {
  const rawQuery = normalize(query);
  const tokens = tokenize(query);
  const roles = new Set<string>();
  const nameBoosts: string[] = [];
  let anyInteractive = false;

  for (const token of tokens) {
    const entry = ROLE_SYNONYMS[token];
    if (!entry) continue;
    for (const role of entry.roles || []) roles.add(role);
    for (const boost of entry.nameBoost || []) {
      if (!nameBoosts.includes(boost)) nameBoosts.push(boost);
    }
    if (entry.anyInteractive) anyInteractive = true;
  }

  const actionImplied = ACTION_WORDS.some((word) => rawQuery.includes(word));

  return {
    rawQuery,
    tokens,
    tokenPhrase: tokens.join(' '),
    roles,
    nameBoosts,
    anyInteractive,
    actionImplied,
  };
}

/**
 * 후보 하나의 점수를 계산한다. 전부 결정적이며 LLM 을 쓰지 않는다.
 */
function scoreCandidate(candidate: Candidate, intent: QueryIntent): number {
  const haystackParts = [
    candidate.name,
    candidate.text,
    candidate.placeholder,
    candidate.title,
    candidate.value,
    hrefTail(candidate.href),
  ];
  const haystack = normalize(haystackParts.filter(Boolean).join(' '));

  let score = 0;

  if (haystack) {
    // 1) 구절 일치 — 원문 질의와 조사 제거 토큰 형태를 모두 본다.
    if (
      (intent.rawQuery && haystack.includes(intent.rawQuery)) ||
      (intent.tokenPhrase && haystack.includes(intent.tokenPhrase))
    ) {
      score += W_EXACT_PHRASE;
    }

    // 2) 토큰 단위 일치
    const words = haystack.split(' ').slice(0, 60);
    let matchedTokens = 0;
    for (const token of intent.tokens) {
      if (haystack.includes(token)) {
        matchedTokens++;
        score += W_TOKEN_SUBSTRING;
        continue;
      }
      // 오타 허용은 짧은 토큰에서 오탐이 심하므로 4글자 이상에만 적용
      if (token.length >= 4 && words.some((word) => withinEditDistanceOne(token, word))) {
        score += W_TOKEN_FUZZY;
      }
    }
    if (intent.tokens.length > 0 && matchedTokens === intent.tokens.length) {
      score += W_ALL_TOKENS;
    }
  }

  // 3) role 일치
  const role = normalize(candidate.role);
  if (intent.roles.size > 0) {
    if (intent.roles.has(role)) {
      score += W_ROLE_EXACT;
    } else if (Array.from(intent.roles).some((wanted) => sameRoleFamily(role, wanted))) {
      score += W_ROLE_FAMILY;
    }
    // input type 은 role 이 textbox 로 뭉뚱그려지므로 별도로 한 번 더 본다.
    if (candidate.inputType && intent.roles.has(normalize(candidate.inputType))) {
      score += W_ROLE_FAMILY;
    }
  }

  // 4) 이름 키워드 부스트 (로그인/검색/장바구니 등 role 로는 구분되지 않는 것들)
  if (intent.nameBoosts.length > 0 && haystack) {
    if (intent.nameBoosts.some((boost) => haystack.includes(normalize(boost)))) {
      score += W_NAME_BOOST;
    }
  }

  // 5) '아이콘'처럼 role 을 특정할 수 없는 경우: 상호작용 요소면 가산
  if (intent.anyInteractive && candidate.interactive) score += W_ANY_INTERACTIVE;

  // 6) 행동 암시 질의 + 상호작용 요소
  if (intent.actionImplied && candidate.interactive) score += W_ACTION_INTERACTIVE;

  // 7) 화면에 보이는 요소 우선
  if (candidate.visible) score += W_VISIBLE;

  return score;
}

function clip(text: string, max: number): string {
  const value = String(text ?? '');
  return value.length > max ? value.slice(0, max) + '…' : value;
}

/** 응답에 실을 매치 한 건 */
interface MatchPayload {
  rank: number;
  score: number;
  ref: string;
  role: string;
  name: string;
  text?: string;
  cx: number;
  cy: number;
  frameId?: number;
  frameUrl?: string;
}

function toMatch(scored: ScoredCandidate, rank: number): MatchPayload {
  const c = scored.candidate;
  const match: MatchPayload = {
    rank,
    score: scored.score,
    ref: c.ref,
    role: c.role,
    name: clip(c.name, MAX_NAME_CHARS),
    cx: c.cx,
    cy: c.cy,
  };
  if (c.text) match.text = clip(c.text, MAX_TEXT_CHARS);
  if (typeof c.frameId === 'number') {
    match.frameId = c.frameId;
    if (c.frameUrl) match.frameUrl = clip(c.frameUrl, 120);
  }
  return match;
}

/**
 * Find elements by natural language description (Korean/English), deterministic scoring
 */
class FindTool extends BaseBrowserToolExecutor {
  name = 'chrome_find';

  /**
   * auto-chrome-mcp fork: 하위 iframe 들에서 후보를 수집한다(allFrames=true 일 때만).
   * read_page 와 동일하게 프레임마다 helper 주입을 보장한 뒤 메시지를 보낸다.
   * 실패한 프레임은 조용히 건너뛴다(iframe 하나 때문에 도구 전체가 실패하면 안 된다).
   */
  private async collectFrameCandidates(tabId: number): Promise<Candidate[]> {
    const frames = await listChildFrames(tabId, Math.max(0, FRAME_COLLECT_MAX_FRAMES - 1));
    if (frames.length === 0) return [];

    const settled = await Promise.allSettled(
      frames.map(async (frame): Promise<Candidate[]> => {
        try {
          await this.injectContentScript(tabId, [HELPER_FILE], false, 'ISOLATED', false, [
            frame.frameId,
          ]);
        } catch {
          return [];
        }
        try {
          const resp = await this.sendMessageToTab(
            tabId,
            { action: FIND_CANDIDATES_ACTION },
            frame.frameId,
          );
          if (!resp || resp.success !== true || !Array.isArray(resp.candidates)) return [];
          return (resp.candidates as RawCandidate[]).map((c) => ({
            ...c,
            frameId: frame.frameId,
            frameUrl: frame.frameUrl,
          }));
        } catch {
          return [];
        }
      }),
    );

    const out: Candidate[] = [];
    for (const s of settled) {
      if (s.status === 'fulfilled' && Array.isArray(s.value)) out.push(...s.value);
    }
    return out;
  }

  async execute(args: FindParams): Promise<ToolResult> {
    const params = args || ({} as FindParams);

    const query = typeof params.query === 'string' ? params.query.trim() : '';
    if (!query) {
      return createErrorResponse(
        'query is required: a natural language description of the element (e.g. "로그인 버튼", "search input")',
      );
    }

    const requested = Number(params.maxResults);
    const maxResults =
      Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), MAX_MAX_RESULTS)
        : DEFAULT_MAX_RESULTS;

    // 기본값 true — iframe 안의 로그인/결제 위젯을 놓치지 않기 위함.
    const allFrames = params.allFrames !== false;

    let tab: chrome.tabs.Tab;
    try {
      tab =
        (await this.tryGetTab(params.tabId)) ||
        (await this.getActiveTabOrThrowInWindow(params.windowId));
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error));
    }
    const tabId = tab.id;
    if (typeof tabId !== 'number') {
      return createErrorResponse('Target tab has no id');
    }

    if (isRestrictedUrl(tab.url)) {
      return createErrorResponse(
        'Cannot search elements on special browser pages or web store pages due to security restrictions.',
      );
    }

    try {
      await this.injectContentScript(tabId, [HELPER_FILE], false, 'ISOLATED', allFrames);
    } catch (error) {
      return createErrorResponse(
        `chrome_find failed to inject helper: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const candidates: Candidate[] = [];
    let topFrameError: string | null = null;

    // top frame 은 항상 조회한다. 실패해도 iframe 수집은 계속한다.
    try {
      const resp = await this.sendMessageToTab(tabId, { action: FIND_CANDIDATES_ACTION });
      if (resp && resp.success === true && Array.isArray(resp.candidates)) {
        candidates.push(...(resp.candidates as RawCandidate[]));
      } else {
        topFrameError = String(resp?.error || 'top frame returned no candidates');
      }
    } catch (error) {
      topFrameError = error instanceof Error ? error.message : String(error);
    }

    if (allFrames) {
      try {
        candidates.push(...(await this.collectFrameCandidates(tabId)));
      } catch (error) {
        console.warn('chrome_find allFrames collection failed:', error);
      }
    }

    if (candidates.length === 0) {
      return createErrorResponse(
        `chrome_find could not collect any elements from the page${topFrameError ? `: ${topFrameError}` : ''}`,
      );
    }

    const intent = buildIntent(query);
    const scored: ScoredCandidate[] = [];
    for (const candidate of candidates) {
      const score = scoreCandidate(candidate, intent);
      if (score < MIN_SCORE) continue;
      scored.push({
        candidate,
        score,
        // 동점이면 이름이 짧은 쪽(= 더 정확히 그 요소를 가리키는 쪽)을 위로.
        nameLen: candidate.name ? candidate.name.length : Number.MAX_SAFE_INTEGER,
      });
    }
    scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.nameLen - b.nameLen));

    const basePayload: Record<string, unknown> = {
      success: true,
      tabId,
      query,
      scanned: candidates.length,
    };

    if (scored.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ...basePayload, matches: [], suggestion: NO_MATCH_SUGGESTION }),
          },
        ],
        isError: false,
      };
    }

    let matches = scored.slice(0, maxResults).map((s, i) => toMatch(s, i + 1));
    // auto-chrome-mcp fork: hint 는 응답 전체에 1회만 싣는다 — 이전에는 match 항목마다
    // 118자짜리 문구가 반복돼(maxResults=5 면 5회) 응답 크기를 불필요하게 부풀렸다.
    let text = JSON.stringify({ ...basePayload, matches, hint: MATCH_HINT });
    // 응답 상한 초과 시 순위가 낮은 매치부터 버린다(1위는 항상 남긴다).
    while (text.length > MAX_RESPONSE_CHARS && matches.length > 1) {
      matches = matches.slice(0, matches.length - 1);
      text = JSON.stringify({ ...basePayload, matches, hint: MATCH_HINT, truncated: true });
    }

    return {
      content: [{ type: 'text', text }],
      isError: false,
    };
  }
}

export const findTool = new FindTool();
