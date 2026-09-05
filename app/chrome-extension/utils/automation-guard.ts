/**
 * Automation guard (auto-chrome-mcp fork) — 차단(밴) 예방 안전장치.
 *
 * E1. 도메인별 속도 제한(soft throttle): 같은 도메인에 액션성 도구 호출이 몰리면
 *     초과분에 지연을 넣어 버스트를 완만하게 만든다. 차단하지 않고 속도만 늦춘다.
 * E2. 반복 작업 가드: 동일한 (도구, 인자) 호출이 짧은 시간에 과도하게 반복되면
 *     루프 폭주로 판단하고 에러를 반환해 멈춘다 (다른 호출이 끼면 리셋).
 *
 * 상태는 service worker in-memory — SW 재시작 시 리셋되는 것은 의도된 완화 동작.
 * 게이트(tools/index.ts handleCallTool)에서 액션성 도구에만 적용된다.
 */

const RATE_WINDOW_MS = 10_000;
const RATE_MAX_ACTIONS = 30; // 도메인당 10초에 30회 초과분부터 지연
const RATE_MAX_DELAY_MS = 5_000;

const REPEAT_WINDOW_MS = 120_000;
const REPEAT_LIMIT = 12; // 동일 호출 12회 연속이면 루프 폭주로 판단

const STORAGE_KEY = 'automationGuardEnabled';

/**
 * auto-chrome-mcp fork: 인메모리 캐시. 이 가드는 액션성 도구 호출마다 평가되므로
 * `chrome.storage.local.get` 을 매번 부르면 낭비가 크다(work-tab-manager 의 캐시 패턴 참고).
 * null 이면 "아직 캐시 없음"이고, 그 외에는 캐시된 값을 그대로 쓴다.
 * popup 에서 직접 storage 를 바꿔도 `chrome.storage.onChanged` 로 즉시 반영된다.
 */
let cachedEnabled: boolean | null = null;
let changeListenerRegistered = false;

function ensureChangeListener(): void {
  if (changeListenerRegistered) return;
  try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      const change = changes[STORAGE_KEY];
      if (!change) return;
      cachedEnabled = change.newValue !== false;
    });
    changeListenerRegistered = true;
  } catch {
    // onChanged 를 쓸 수 없는 환경(구형 테스트 하네스 등) — 캐시는 set() 경유 갱신만으로 동작한다.
  }
}

export async function isAutomationGuardEnabled(): Promise<boolean> {
  ensureChangeListener();
  if (cachedEnabled !== null) return cachedEnabled;
  try {
    const result = await chrome.storage.local.get([STORAGE_KEY]);
    cachedEnabled = result[STORAGE_KEY] !== false;
    return cachedEnabled;
  } catch {
    // 실패는 캐시하지 않는다 — 다음 호출에서 다시 시도한다.
    return true;
  }
}

export async function setAutomationGuardEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: enabled });
  cachedEnabled = enabled;
}

export const AUTOMATION_GUARD_STORAGE_KEY = STORAGE_KEY;

/** 도메인별 액션 타임스탬프 (sliding window) */
const domainActions = new Map<string, number[]>();

/** 세션별 직전 호출 반복 추적 */
interface RepeatState {
  key: string;
  count: number;
  firstAt: number;
}
const repeatBySession = new Map<string, RepeatState>();

function extractDomain(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname;
  } catch {
    return null;
  }
}

async function resolveDomain(args: any): Promise<string> {
  const fromArgs = extractDomain(typeof args?.url === 'string' ? args.url : null);
  if (fromArgs) return fromArgs;
  if (typeof args?.tabId === 'number') {
    try {
      const tab = await chrome.tabs.get(args.tabId);
      const fromTab = extractDomain(tab.url);
      if (fromTab) return fromTab;
    } catch {
      // 탭 조회 실패 — 전역 버킷 사용
    }
  }
  return '__global__';
}

/**
 * auto-chrome-mcp fork(P1): 세션 + 레인 버킷. work-tab-manager 의 sessionKeyOf 와 같은 규칙이지만,
 * 가드는 chrome API 부작용 없는 순수 모듈로 두려고 여기에 따로 둔다.
 */
function sessionBucketOf(args: any): string {
  const sid =
    typeof args?._mcpSessionId === 'string' && args._mcpSessionId ? args._mcpSessionId : 'default';
  const lane = typeof args?.lane === 'string' ? args.lane.trim() : '';
  return lane ? `${sid}::${lane.slice(0, 64)}` : sid;
}

function stableKey(name: string, args: any): string {
  try {
    const clone = { ...(args ?? {}) };
    delete clone._mcpSessionId;
    // auto-chrome-mcp fork(P1): lane 은 '누가' 를 가리킬 뿐 호출 내용이 아니다.
    // 반복 키에서 빼고, 대신 세션 버킷을 레인 단위로 쪼갠다.
    delete clone.lane;
    return `${name}:${JSON.stringify(clone)}`;
  } catch {
    return `${name}:<unserializable>`;
  }
}

export type GuardVerdict = { delayMs: number } | { blocked: string } | null;

/**
 * 액션성 도구 호출 1건을 평가한다.
 * - null: 통과
 * - { delayMs }: 통과하되 호출 전 지연 필요 (게이트가 sleep)
 * - { blocked }: 실행 거부 (에러 메시지)
 */
export async function applyAutomationGuard(name: string, args: any): Promise<GuardVerdict> {
  if (!(await isAutomationGuardEnabled())) return null;

  const now = Date.now();
  // auto-chrome-mcp fork(P1): 레인별 버킷. 병렬 에이전트가 같은 일을 하더라도
  // 서로의 반복 카운터를 밀어 runaway 로 오판되지 않게 한다.
  const sessionId = sessionBucketOf(args);

  // E2 — 동일 호출 반복 감지 (속도 제한보다 먼저: 폭주는 지연이 아니라 중단이 맞다)
  const key = stableKey(name, args);
  const prev = repeatBySession.get(sessionId);
  if (prev && prev.key === key && now - prev.firstAt <= REPEAT_WINDOW_MS) {
    prev.count += 1;
    if (prev.count >= REPEAT_LIMIT) {
      return {
        blocked:
          `Automation guard: identical ${name} call repeated ${prev.count} times in ` +
          `${Math.round((now - prev.firstAt) / 1000)}s — looks like a runaway loop. ` +
          `Change the arguments/approach, or disable the guard in the extension popup ` +
          `(automationGuardEnabled) if this repetition is intentional.`,
      };
    }
  } else {
    repeatBySession.set(sessionId, { key, count: 1, firstAt: now });
  }

  // E1 — 도메인별 soft throttle
  const domain = await resolveDomain(args);
  const stamps = (domainActions.get(domain) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  let delayMs = 0;
  if (stamps.length >= RATE_MAX_ACTIONS) {
    const oldest = stamps[stamps.length - RATE_MAX_ACTIONS];
    delayMs = Math.min(Math.max(oldest + RATE_WINDOW_MS - now, 0), RATE_MAX_DELAY_MS);
  }
  stamps.push(now + delayMs);
  domainActions.set(domain, stamps);

  // 메모리 청소: 오래된 도메인 버킷 제거
  if (domainActions.size > 200) {
    for (const [d, ts] of domainActions) {
      if (ts.every((t) => now - t >= RATE_WINDOW_MS)) domainActions.delete(d);
    }
  }

  return delayMs > 0 ? { delayMs } : null;
}
