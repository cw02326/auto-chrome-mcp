import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import {
  RenderAssist,
  RenderKeepAlive,
  RenderMode,
  withRenderKeepAlive,
} from '@/utils/render-keepalive';
import { BaseBrowserToolExecutor } from '../base-browser';

/**
 * auto-chrome-mcp fork: chrome_scroll_collect — 무한 스크롤/지연 로딩 페이지의 내용을
 * 한 번의 MCP 호출로 모아온다. (스크롤 → 읽기 → 스크롤 → 읽기 왕복 제거)
 *
 * 가상 스크롤(virtualized list)처럼 앞부분 DOM 이 언로드되는 페이지를 위해,
 * 매 패스의 스냅샷을 그대로 이어붙이지 않고 "이미 모은 텍스트와 겹치는 부분"을 찾아
 * 새로 등장한 꼬리만 덧붙인다.
 *
 * 주의: 스크립트 주입이 가능한 페이지에서만 동작한다 (chrome://, edge://, 웹스토어 제외 —
 * screenshot.ts 의 URL 가드와 동일한 목록).
 *
 * TOOL_NAMES 상수에는 orchestrator 가 별도로 추가하므로 여기서는 이름을 문자열로 고정한다.
 */

type CollectMode = 'text' | 'links';

interface ScrollCollectParams {
  tabId?: number;
  maxScrolls?: number;
  delayMs?: number;
  containerSelector?: string;
  stopText?: string;
  collect?: CollectMode;
  maxChars?: number;
  renderMode?: RenderMode;
}

interface CollectedLink {
  text: string;
  href: string;
}

/** 페이지 안에서 한 패스(수집 + 바닥으로 스크롤)를 수행한 결과 */
interface PassResult {
  ok: boolean;
  error?: string;
  scrollHeight: number;
  scrollTop: number;
  text?: string;
  links?: CollectedLink[];
}

const DEFAULT_MAX_SCROLLS = 10;
const MAX_MAX_SCROLLS = 30;
const DEFAULT_DELAY_MS = 700;
const MIN_DELAY_MS = 200;
const MAX_DELAY_MS = 3000;
const DEFAULT_MAX_CHARS = 100000;
const MAX_MAX_CHARS = 300000;
const TRUNCATION_MARKER = '…[truncated]';
/** 겹침 탐색 비용을 제한하기 위한 비교 창 크기 */
const OVERLAP_WINDOW = 2000;
/** 우연한 짧은 일치로 내용이 잘리는 것을 막기 위한 최소 겹침 길이 */
const MIN_OVERLAP = 40;
/** 줄 단위 정렬에서 앵커를 찾을 때 누적본 끝에서 건너뛸 수 있는 줄 수 (스피너 등) */
const MAX_ANCHOR_SKIP_LINES = 3;
/** 스크롤 높이가 이만큼 연속으로 늘지 않으면 종료 */
const NO_GROWTH_LIMIT = 2;

/**
 * 스크립트 주입이 불가능한 페이지 (screenshot.ts 의 가드와 동일한 목록 + devtools/신 웹스토어).
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

/**
 * 페이지 컨텍스트에서 실행: 현재 내용을 수집한 뒤 바닥까지 스크롤한다.
 * 주의: 외부 스코프를 참조하면 안 된다 (executeScript 가 직렬화해 주입하므로).
 */
function collectAndScroll(containerSelector: string | null, collect: CollectMode): PassResult {
  let container: HTMLElement | null = null;
  if (containerSelector) {
    let found: Element | null = null;
    try {
      found = document.querySelector(containerSelector);
    } catch {
      return {
        ok: false,
        error: `Invalid containerSelector: ${containerSelector}`,
        scrollHeight: 0,
        scrollTop: 0,
      };
    }
    if (!found) {
      return {
        ok: false,
        error: `containerSelector not found: ${containerSelector}`,
        scrollHeight: 0,
        scrollTop: 0,
      };
    }
    container = found as HTMLElement;
  }

  const doc = document.documentElement;
  const pageHeight = Math.max(
    doc ? doc.scrollHeight : 0,
    document.body ? document.body.scrollHeight : 0,
  );
  const result: PassResult = {
    ok: true,
    scrollHeight: container ? container.scrollHeight : pageHeight,
    scrollTop: container ? container.scrollTop : window.scrollY,
  };

  if (collect === 'links') {
    const scope: ParentNode = container ? container : document;
    const anchors = Array.from(scope.querySelectorAll('a[href]'));
    const links: CollectedLink[] = [];
    for (const node of anchors) {
      const anchor = node as HTMLAnchorElement;
      const href = anchor.href;
      if (!href) continue;
      links.push({
        text: (anchor.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300),
        href,
      });
    }
    result.links = links;
  } else {
    const source: HTMLElement | null = container ? container : document.body;
    result.text = source ? source.innerText || '' : '';
  }

  try {
    if (container) {
      container.scrollTo({ top: container.scrollHeight, behavior: 'instant' });
    } else {
      window.scrollTo({ top: pageHeight, left: 0, behavior: 'instant' });
    }
  } catch {
    if (container) {
      container.scrollTop = container.scrollHeight;
    } else {
      window.scrollTo(0, pageHeight);
    }
  }

  return result;
}

/** 두 문자열이 앞에서부터 몇 글자까지 같은가. */
function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/** 두 문자열이 뒤에서부터 몇 글자까지 같은가 (limit 이상은 보지 않는다). */
function commonSuffixLength(a: string, b: string, limit: number): number {
  let i = 0;
  while (i < limit && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++;
  return i;
}

/**
 * a 의 접미사이면서 동시에 b 의 접두사인 가장 긴 구간의 길이 (없으면 0).
 * 탐색 비용은 OVERLAP_WINDOW 로 제한하고, 우연한 짧은 일치는 MIN_OVERLAP 으로 거른다.
 */
function overlapLength(a: string, b: string): number {
  const tail = a.slice(-OVERLAP_WINDOW);
  const max = Math.min(tail.length, b.length);
  for (let length = max; length >= MIN_OVERLAP; length--) {
    if (b.startsWith(tail.slice(tail.length - length))) return length;
  }
  return 0;
}

/**
 * 누적본의 **끝부분**이 새 스냅샷 안 어디에 있는지 줄 단위로 찾아, 그 뒤에 새로 붙은 것만 잇는다.
 * 못 찾으면 null.
 *
 * 글자 단위 `overlapLength` 는 두 가지 한계가 있어 이 함수가 필요하다:
 *   - 탐색 창이 OVERLAP_WINDOW(2000자)라 가상 스크롤의 큰 겹침(수 KB)을 놓친다.
 *   - 겹치는 구간이 스냅샷의 **맨 앞**이 아니면(예: 맨 윗줄이 "검색결과 1,234건" 처럼 매번
 *     바뀌는 카운터) 아예 못 찾아, 패스마다 페이지가 통째로 다시 붙는다.
 *
 * 대신 겹침 구간보다 **앞에 있는** 새 스냅샷의 줄(위 카운터의 새 값 등)은 결과에 들어가지 않는다.
 * 같은 자리의 옛 값이 이미 들어 있으므로 정보가 사라지진 않는다.
 */
function mergeByLineAlignment(accumulated: string, snapshot: string): string | null {
  if (!accumulated || !snapshot) return null;

  const accumulatedLines = accumulated.split('\n');
  const endsWithNewline = accumulatedLines[accumulatedLines.length - 1] === '';
  if (endsWithNewline) accumulatedLines.pop();
  if (accumulatedLines.length === 0) return null;

  const snapshotLines = snapshot.split('\n');

  // 앵커는 누적본의 마지막 줄부터. 끝에 스피너 같은 줄이 붙어 있으면 앵커를 못 잡으므로
  // 몇 줄 위까지 물러나며 찾는다(그 줄들은 **버리지 않고** 제자리에 둔다).
  for (let skip = 0; skip <= MAX_ANCHOR_SKIP_LINES && skip < accumulatedLines.length; skip++) {
    const anchorIndex = accumulatedLines.length - 1 - skip;
    const anchorLine = accumulatedLines[anchorIndex];
    if (!anchorLine) continue;

    let bestLines = 0;
    let bestEnd = -1;
    for (let j = 0; j < snapshotLines.length; j++) {
      if (snapshotLines[j] !== anchorLine) continue;
      let matched = 1;
      while (
        matched <= anchorIndex &&
        j - matched >= 0 &&
        accumulatedLines[anchorIndex - matched] === snapshotLines[j - matched]
      ) {
        matched++;
      }
      if (matched > bestLines) {
        bestLines = matched;
        bestEnd = j;
      }
    }
    if (bestLines === 0) continue;

    // 한 줄이 우연히 같은 것(빈 줄·"$52" 같은 값)으로 잘라 버리지 않도록 최소 길이를 둔다.
    const matchedChars = accumulatedLines
      .slice(anchorIndex + 1 - bestLines, anchorIndex + 1)
      .join('\n').length;
    if (matchedChars < MIN_OVERLAP) continue;

    const rest = snapshotLines.slice(bestEnd + 1);
    if (rest.length === 0) return accumulated;
    return (endsWithNewline ? accumulated : accumulated + '\n') + rest.join('\n');
  }

  return null;
}

/**
 * 공통부의 경계를 줄 시작으로 맞춘다. 글자 단위로 자르면 두 항목이 공유하는 앞머리
 * ("상품 " 같은)가 항목에서 떨어져 나가 "…오늘B — 재고 7개…" 처럼 문장이 뭉개진다.
 * 공통 접두사의 접두사·공통 접미사의 접미사는 여전히 공통이므로 잘라도 안전하다.
 */
function snapPrefixToLineStart(text: string, prefixLength: number): number {
  if (prefixLength <= 0) return 0;
  return text.lastIndexOf('\n', prefixLength - 1) + 1;
}

function snapSuffixToLineStart(text: string, suffixLength: number): number {
  if (suffixLength <= 0) return 0;
  const start = text.length - suffixLength;
  if (start === 0 || text.charCodeAt(start - 1) === 10) return suffixLength; // 이미 줄 시작
  const nextLine = text.indexOf('\n', start);
  return nextLine === -1 ? 0 : text.length - (nextLine + 1);
}

/**
 * 이미 모은 텍스트에 새 스냅샷의 "새로운 부분"만 덧붙인다.
 *
 * 1) 스냅샷이 누적본으로 시작하면 (append-only 페이지) 뒤쪽 차이만 추가
 * 2) 누적본의 가장 긴 접미사가 스냅샷의 접두사가 되면 그 지점부터 이어 붙임
 *    (가상 스크롤로 앞부분이 언로드된 경우)
 * 3) 앞·뒤로 공통 부분이 있으면(고정 헤더/푸터) 가운데만 줄 단위로 정렬해 합침 — 새 항목이
 *    **가운데**로 들어오는, 무한 스크롤에서 가장 흔한 모양이다.
 * 4) 그래도 안 되면 전체를 줄 단위로 정렬해 본다 (헤더/푸터가 없는 페이지)
 * 5) 끝내 못 맞추면 구분자와 함께 통째로 추가 (내용 손실 금지)
 *
 * ⚠️ 2)를 3)보다 먼저 본다. 가상 스크롤에서는 앞부분이 사라져 "공통 접두사"가 헤더뿐이라,
 * 3)을 먼저 적용하면 아직 살아 있는 항목들이 두 번 들어간다.
 * ⚠️ "이건 스피너니까 버리자" 같은 길이 기반 추측은 하지 않는다 — 짧은 실제 본문을 지웠다.
 */
export function appendWithOverlap(accumulated: string, snapshot: string): string {
  if (!snapshot) return accumulated;
  if (!accumulated) return snapshot;
  if (snapshot === accumulated) return accumulated;
  if (snapshot.startsWith(accumulated)) return accumulated + snapshot.slice(accumulated.length);
  if (accumulated.endsWith(snapshot)) return accumulated;

  const headOverlap = overlapLength(accumulated, snapshot);
  if (headOverlap > 0) return accumulated + snapshot.slice(headOverlap);

  // 앞·뒤 공통부를 공유하고 가운데만 이어 붙인다. 경계는 줄 단위로 맞춘다.
  const rawPrefixLength = commonPrefixLength(accumulated, snapshot);
  const suffixLimit = Math.min(
    accumulated.length - rawPrefixLength,
    snapshot.length - rawPrefixLength,
  );
  const rawSuffixLength = commonSuffixLength(accumulated, snapshot, suffixLimit);
  const prefixLength = snapPrefixToLineStart(accumulated, rawPrefixLength);
  const suffixLength = snapSuffixToLineStart(accumulated, rawSuffixLength);
  // 합치는 것 자체는 내용을 잃지 않으므로 공통부 합만 보고 적용한다.
  if (prefixLength + suffixLength >= MIN_OVERLAP) {
    const accumulatedMiddle = accumulated.slice(prefixLength, accumulated.length - suffixLength);
    const snapshotMiddle = snapshot.slice(prefixLength, snapshot.length - suffixLength);
    if (!snapshotMiddle) return accumulated;
    // 가운데끼리도 겹친다(가상 스크롤에서 아직 살아 있는 항목, 스피너 앞의 항목들).
    // 줄 단위 정렬로 겹치는 만큼만 빼고 잇는다 — 무엇을 "버릴지" 추측하지 않는다.
    const mergedMiddle =
      mergeByLineAlignment(accumulatedMiddle, snapshotMiddle) ?? accumulatedMiddle + snapshotMiddle;
    return (
      accumulated.slice(0, prefixLength) +
      mergedMiddle +
      accumulated.slice(accumulated.length - suffixLength)
    );
  }

  // 헤더·푸터가 없어 splice 를 못 쓰는 페이지도 줄 단위 정렬로는 이어 붙일 수 있다.
  const aligned = mergeByLineAlignment(accumulated, snapshot);
  if (aligned !== null) return aligned;

  return `${accumulated}\n---\n${snapshot}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Scroll a page (or a scrollable container) and collect its content in one call
 */
class ScrollCollectTool extends BaseBrowserToolExecutor {
  name = 'chrome_scroll_collect';

  async execute(args: ScrollCollectParams): Promise<ToolResult> {
    const params = args || ({} as ScrollCollectParams);

    const collect: CollectMode = params.collect === 'links' ? 'links' : 'text';
    const maxScrolls =
      typeof params.maxScrolls === 'number' && Number.isFinite(params.maxScrolls)
        ? Math.floor(clamp(params.maxScrolls, 1, MAX_MAX_SCROLLS))
        : DEFAULT_MAX_SCROLLS;
    const delayMs =
      typeof params.delayMs === 'number' && Number.isFinite(params.delayMs)
        ? clamp(params.delayMs, MIN_DELAY_MS, MAX_DELAY_MS)
        : DEFAULT_DELAY_MS;
    const maxChars =
      typeof params.maxChars === 'number' && Number.isFinite(params.maxChars)
        ? Math.floor(clamp(params.maxChars, 1000, MAX_MAX_CHARS))
        : DEFAULT_MAX_CHARS;
    const containerSelector =
      typeof params.containerSelector === 'string' && params.containerSelector.trim()
        ? params.containerSelector.trim()
        : null;
    const stopText =
      typeof params.stopText === 'string' && params.stopText !== '' ? params.stopText : null;
    const renderMode: RenderMode =
      params.renderMode === 'force' || params.renderMode === 'off' ? params.renderMode : 'auto';

    let tab: chrome.tabs.Tab;
    try {
      tab = (await this.tryGetTab(params.tabId)) || (await this.getActiveTabOrThrowInWindow());
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error));
    }
    const tabId = tab.id;
    if (typeof tabId !== 'number') {
      return createErrorResponse('Target tab has no id');
    }
    if (isRestrictedUrl(tab.url)) {
      return createErrorResponse(
        'Cannot collect content from special browser pages or web store pages due to security restrictions.',
      );
    }

    let content = '';
    const links: CollectedLink[] = [];
    const seenHrefs = new Set<string>();
    let linkChars = 0;

    let scrolls = 0;
    let finalHeight = 0;
    let truncated = false;
    let noGrowthPasses = 0;
    let previousHeight = -1;
    let stoppedReason = 'maxScrolls';

    const outcome: { assist: RenderAssist; failure: string | null } = {
      assist: 'off',
      failure: null,
    };

    // 핸들은 fn 이 끝난 뒤에 읽는다 — 프레임 펌프가 도중에 죽으면 assist 가 내려간다.
    let keepAlive: RenderKeepAlive | null = null;

    try {
      await withRenderKeepAlive(tabId, renderMode, async (handle) => {
        keepAlive = handle;
        for (let pass = 0; pass < maxScrolls; pass++) {
          const stillOpen = await this.tryGetTab(tabId);
          if (!stillOpen) {
            outcome.failure = `Tab ${tabId} was closed while collecting`;
            return;
          }

          let result: PassResult | undefined;
          try {
            const [injection] = await chrome.scripting.executeScript({
              target: { tabId },
              func: collectAndScroll,
              args: [containerSelector, collect],
            });
            result = injection?.result ?? undefined;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (pass === 0) {
              outcome.failure = `Failed to run collection script in tab ${tabId}: ${message}`;
              return;
            }
            // 내비게이션 등으로 중간 패스가 실패하면 지금까지 모은 내용을 반환한다.
            console.warn(`chrome_scroll_collect: executeScript failed on pass ${pass}: ${message}`);
            stoppedReason = 'scriptError';
            break;
          }

          if (!result) {
            if (pass === 0) {
              outcome.failure = `Collection script returned no result for tab ${tabId}`;
              return;
            }
            stoppedReason = 'scriptError';
            break;
          }
          if (!result.ok) {
            outcome.failure = result.error || 'Collection script failed';
            return;
          }

          scrolls = pass + 1;
          finalHeight = result.scrollHeight;

          let stopTextSeen = false;

          if (collect === 'links') {
            for (const link of result.links || []) {
              if (seenHrefs.has(link.href)) continue;
              if (linkChars >= maxChars) {
                truncated = true;
                break;
              }
              seenHrefs.add(link.href);
              links.push(link);
              linkChars += link.href.length + link.text.length;
              if (stopText && (link.text.includes(stopText) || link.href.includes(stopText))) {
                stopTextSeen = true;
              }
            }
          } else {
            const snapshot = result.text || '';
            if (stopText && snapshot.includes(stopText)) stopTextSeen = true;
            content = appendWithOverlap(content, snapshot);
            if (content.length > maxChars) {
              content = content.slice(0, maxChars) + TRUNCATION_MARKER;
              truncated = true;
            }
          }

          if (truncated) {
            stoppedReason = 'maxChars';
            break;
          }
          if (stopTextSeen) {
            stoppedReason = 'stopText';
            break;
          }

          if (result.scrollHeight <= previousHeight) {
            noGrowthPasses++;
          } else {
            noGrowthPasses = 0;
          }
          previousHeight = result.scrollHeight;

          if (noGrowthPasses >= NO_GROWTH_LIMIT) {
            stoppedReason = 'bottomReached';
            break;
          }

          if (pass < maxScrolls - 1) {
            // 지연은 페이지가 아니라 백그라운드에서 기다린다 (페이지 스크립트를 블로킹하지 않도록).
            await sleep(delayMs);
          }
        }
      });
    } catch (error) {
      return createErrorResponse(
        `chrome_scroll_collect failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (outcome.failure) {
      return createErrorResponse(outcome.failure);
    }

    outcome.assist = (keepAlive as RenderKeepAlive | null)?.assist ?? outcome.assist;

    const payload: Record<string, unknown> = {
      success: true,
      tabId,
      url: tab.url,
      scrolls,
      finalHeight,
      truncated,
      stoppedReason,
      renderAssist: outcome.assist,
    };
    // 비활성 탭에서 렌더링을 살리지 못한 채 높이가 안 자란 것을 "바닥 도달"로 보고하면
    // 호출자가 수집이 끝난 줄 오해한다 — 원인을 그대로 밝힌다.
    if (
      stoppedReason === 'bottomReached' &&
      (outcome.assist === 'unavailable' || outcome.assist === 'off')
    ) {
      payload.stoppedReason = 'noGrowthWhileHidden';
      payload.hint =
        outcome.assist === 'unavailable'
          ? 'Tab is not rendering (background) and CDP could not keep it rendering — close DevTools on that tab, or activate the tab, then retry. Lazy-loaded content may be missing.'
          : "renderMode:'off' with a background tab — lazy loading may never trigger. Use renderMode:'auto' (default) or activate the tab.";
    }
    if (collect === 'links') {
      payload.links = links;
      payload.linkCount = links.length;
    } else {
      payload.content = content;
      payload.chars = content.length;
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      isError: false,
    };
  }
}

export const scrollCollectTool = new ScrollCollectTool();
