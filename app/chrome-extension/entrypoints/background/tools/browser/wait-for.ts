import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { waitBudgetMs } from '@/utils/tool-watchdog';
import { BaseBrowserToolExecutor } from '../base-browser';
import { sleep } from '@/utils/adaptive-wait';

/**
 * auto-chrome-mcp fork: chrome_wait_for — "너무 일찍 클릭 / 빈 페이지 읽기" 실패를 없애는 대기 도구.
 *
 * selector / text / networkIdleMs / documentReady 조건을 폴링으로 확인하고, 지정한 조건이
 * 모두(AND) 성립하면 즉시 반환한다. 타임아웃은 도구 실패가 아니라 "정보"로 취급해
 * isError:false + {success:false, timedOut:true, lastState} 로 돌려준다 —
 * 모델이 마지막 상태를 보고 다음 행동(재시도/다른 selector/스크롤)을 스스로 결정하게 하기 위함.
 *
 * TOOL_NAMES 상수에는 orchestrator 가 별도로 추가하므로 여기서는 이름을 문자열로 고정한다.
 */

type WaitState = 'visible' | 'attached' | 'hidden';

interface WaitForParams {
  tabId?: number;
  selector?: string;
  text?: string;
  state?: WaitState;
  networkIdleMs?: number;
  documentReady?: boolean;
  timeoutMs?: number;
  pollMs?: number;
}

/** 페이지 안에서 수집하는 상태 스냅샷 (executeScript 반환값) */
interface PageProbe {
  readyState: string;
  selectorFound?: boolean;
  selectorVisible?: boolean;
  textFound?: boolean;
  invalidSelector?: boolean;
}

interface LastState {
  selectorFound?: boolean;
  selectorVisible?: boolean;
  textFound?: boolean;
  readyState?: string;
  networkInFlight?: number;
}

interface MatchedConditions {
  selector?: { selector: string; state: WaitState };
  text?: string;
  documentReady?: boolean;
  networkIdleMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 60000;
const DEFAULT_POLL_MS = 250;
const MIN_POLL_MS = 100;
/** auto-chrome-mcp fork: DOM 변화로 깨어난 뒤 다시 확인하기까지의 최소 간격(과열 방지) */
const CHANGE_WAKE_MIN_MS = 50;
const MAX_NETWORK_IDLE_MS = 30000;

/**
 * 스크립트 주입이 불가능한 페이지 (screenshot.ts 의 가드와 동일한 목록 + devtools/신 웹스토어).
 */
export function isRestrictedUrl(url?: string): boolean {
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
 * 페이지 컨텍스트에서 실행되는 조건 검사 함수.
 * 주의: 외부 스코프를 참조하면 안 된다 (executeScript 가 직렬화해 주입하므로).
 */
function probePageState(selector: string | null, text: string | null): PageProbe {
  const probe: PageProbe = { readyState: document.readyState };

  if (selector) {
    let element: Element | null = null;
    try {
      element = document.querySelector(selector);
    } catch {
      probe.invalidSelector = true;
      return probe;
    }
    probe.selectorFound = element !== null;
    if (element) {
      // offsetParent 는 position:fixed 요소에서 null 이므로 getClientRects 로 보완한다.
      const rects = element.getClientRects();
      const hasBox = rects.length > 0;
      const notDetachedFromLayout =
        element instanceof HTMLElement ? element.offsetParent !== null : false;
      probe.selectorVisible = hasBox || notDetachedFromLayout;
    } else {
      probe.selectorVisible = false;
    }
  }

  if (text) {
    const body = document.body;
    probe.textFound = body ? (body.innerText || '').includes(text) : false;
  }

  return probe;
}

/**
 * auto-chrome-mcp fork: 폴링 간격을 그대로 기다리지 않고 **DOM 변화로 깨어나기** 위한 in-page 대기.
 *
 * 페이지 컨텍스트에서 MutationObserver / readystatechange / load 를 걸어 두고, 변화가 생기면
 * 즉시(최소 간격 minMs 뒤) 반환한다. 변화가 없으면 sliceMs 까지만 기다린다 — 그래서 최악의
 * 경우에도 예전 폴링과 같은 간격으로 다시 확인한다(폴링이 폴백).
 *
 * 관찰자는 **문서당 하나**다. 백그라운드 탭에서는 페이지 타이머가 스로틀돼 sliceTimer 가 제때
 * 돌지 않는데, 그동안 확장은 자기 상한으로 먼저 돌아와 다음 루프에서 또 설치한다. 그래서 새로
 * 걸기 전에 window 에 남아 있는 이전 것을 반드시 끊는다(안 끊으면 루프마다 쌓인다).
 * 주의: 외부 스코프를 참조하면 안 된다 (executeScript 가 직렬화해 주입하므로).
 */
export function waitForDomChange(sliceMs: number, minMs: number, key: string): Promise<string> {
  const slot = window as unknown as { __acmWaitForWake?: { key: string; cancel: () => void } };
  try {
    const previous = slot.__acmWaitForWake;
    if (previous && typeof previous.cancel === 'function') previous.cancel();
  } catch {
    /* 이전 것이 이미 죽었을 수 있다 */
  }

  return new Promise((resolve) => {
    let settled = false;
    let observer: MutationObserver | null = null;
    let floorTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (reason: string) => {
      if (settled) return;
      settled = true;
      try {
        if (observer) observer.disconnect();
      } catch {
        /* 이미 끊겼을 수 있다 */
      }
      try {
        document.removeEventListener('readystatechange', onSignal);
        window.removeEventListener('load', onSignal);
      } catch {
        /* 무시 */
      }
      clearTimeout(sliceTimer);
      if (floorTimer !== undefined) clearTimeout(floorTimer);
      try {
        if (slot.__acmWaitForWake === handle) delete slot.__acmWaitForWake;
      } catch {
        /* 무시 */
      }
      resolve(reason);
    };

    const handle = { key, cancel: () => finish('cancelled') };

    function onSignal(): void {
      if (settled || floorTimer !== undefined) return;
      // 변화가 폭주하는 페이지에서 즉시 반환을 반복하지 않도록 최소 간격을 둔다.
      floorTimer = setTimeout(() => finish('change'), Math.max(0, minMs));
    }

    try {
      observer = new MutationObserver(onSignal);
      observer.observe(document.documentElement || document, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    } catch {
      observer = null;
    }
    try {
      document.addEventListener('readystatechange', onSignal);
      window.addEventListener('load', onSignal);
    } catch {
      /* 무시 */
    }

    slot.__acmWaitForWake = handle;
    // finish 는 이 아래에서만(타이머·관찰자 콜백으로) 불리므로 const 로 잡아도 안전하다.
    const sliceTimer = setTimeout(() => finish('timeout'), Math.max(0, sliceMs));
  });
}

/**
 * 대상 탭의 in-flight 요청 수와 마지막 네트워크 활동 시각을 추적한다.
 * 반드시 stop() 으로 리스너를 제거해야 한다 (execute 의 finally 에서 호출).
 */
export class NetworkIdleWatcher {
  private readonly filter: chrome.webRequest.RequestFilter;
  private readonly inFlight = new Set<string>();
  private lastActivityAt = Date.now();
  private started = false;

  private readonly handleStart = (details: { requestId: string }): void => {
    this.inFlight.add(details.requestId);
    this.lastActivityAt = Date.now();
  };

  private readonly handleFinish = (details: { requestId: string }): void => {
    this.inFlight.delete(details.requestId);
    this.lastActivityAt = Date.now();
  };

  constructor(tabId: number) {
    this.filter = { urls: ['<all_urls>'], tabId };
  }

  start(): void {
    if (this.started) return;
    chrome.webRequest.onBeforeRequest.addListener(this.handleStart, this.filter);
    chrome.webRequest.onCompleted.addListener(this.handleFinish, this.filter);
    chrome.webRequest.onErrorOccurred.addListener(this.handleFinish, this.filter);
    this.started = true;
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    try {
      chrome.webRequest.onBeforeRequest.removeListener(this.handleStart);
      chrome.webRequest.onCompleted.removeListener(this.handleFinish);
      chrome.webRequest.onErrorOccurred.removeListener(this.handleFinish);
    } catch (error) {
      console.warn('chrome_wait_for: failed to remove webRequest listeners', error);
    }
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  isIdle(idleMs: number): boolean {
    return this.inFlight.size === 0 && Date.now() - this.lastActivityAt >= idleMs;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Wait until a page condition holds (selector / text / network idle / document ready)
 */
class WaitForTool extends BaseBrowserToolExecutor {
  name = 'chrome_wait_for';

  /**
   * auto-chrome-mcp fork: 다음 확인까지 기다린다.
   * 페이지에 주입할 수 있으면 DOM 변화(또는 readystatechange/load)로 깨어나 즉시 돌아오고,
   * 주입이 불가능하거나 변화가 없으면 예전과 같은 폴링 간격(sliceMs)까지 기다린다.
   *
   * 기준 시계는 **확장 쪽 타이머 하나뿐이다**. 페이지 타이머가 스로틀돼 in-page 대기가 늦게
   * 돌아와도 sliceMs 를 넘기지 않으므로 전체 소요가 timeoutMs 를 넘지 않는다.
   */
  private async waitForNextCheck(
    tabId: number,
    canInject: boolean,
    sliceMs: number,
    conditionKey: string,
  ): Promise<void> {
    if (sliceMs <= 0) return;
    if (!canInject) {
      await sleep(sliceMs);
      return;
    }

    let capTimer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<'cap'>((resolve) => {
      capTimer = setTimeout(() => resolve('cap'), sliceMs);
    });
    try {
      const outcome = await Promise.race<'wake' | 'unavailable' | 'cap'>([
        chrome.scripting
          .executeScript({
            target: { tabId },
            func: waitForDomChange,
            args: [sliceMs, Math.min(CHANGE_WAKE_MIN_MS, sliceMs), conditionKey],
          })
          .then(
            () => 'wake' as const,
            () => 'unavailable' as const,
          ),
        cap,
      ]);
      // 내비게이션 중에는 주입이 실패한다 — 예전처럼 폴링 간격만 채운다(상한을 넘기지 않는다).
      if (outcome === 'unavailable') await cap;
    } finally {
      if (capTimer !== undefined) clearTimeout(capTimer);
    }
  }

  async execute(args: WaitForParams): Promise<ToolResult> {
    const params = args || ({} as WaitForParams);

    const selector =
      typeof params.selector === 'string' && params.selector.trim() ? params.selector.trim() : null;
    const text = typeof params.text === 'string' && params.text !== '' ? params.text : null;
    const documentReady = params.documentReady === true;

    const state: WaitState =
      params.state === 'attached' || params.state === 'hidden' ? params.state : 'visible';

    const wantsNetworkIdle =
      typeof params.networkIdleMs === 'number' &&
      Number.isFinite(params.networkIdleMs) &&
      params.networkIdleMs >= 0;
    const networkIdleMs = wantsNetworkIdle
      ? clamp(params.networkIdleMs as number, 0, MAX_NETWORK_IDLE_MS)
      : 0;

    if (!selector && !text && !documentReady && !wantsNetworkIdle) {
      return createErrorResponse(
        'At least one condition is required: selector, text, networkIdleMs, or documentReady',
      );
    }

    // 흐름 실행이 마감을 실어 보냈으면 그보다 오래 기다리지 않는다 (발행 전 검토 3).
    // 마감이 지난 뒤의 대기는 아무도 결과를 기다리지 않는 시간이다.
    const timeoutMs = waitBudgetMs(
      params,
      typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs)
        ? clamp(params.timeoutMs, 0, MAX_TIMEOUT_MS)
        : DEFAULT_TIMEOUT_MS,
    );
    const pollMs =
      typeof params.pollMs === 'number' && Number.isFinite(params.pollMs)
        ? clamp(params.pollMs, MIN_POLL_MS, Math.max(MIN_POLL_MS, timeoutMs))
        : DEFAULT_POLL_MS;

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

    const needsPageProbe = Boolean(selector || text || documentReady);
    if (needsPageProbe && isRestrictedUrl(tab.url)) {
      return createErrorResponse(
        'Cannot evaluate page conditions on special browser pages or web store pages due to security restrictions.',
      );
    }

    if (wantsNetworkIdle && typeof chrome.webRequest === 'undefined') {
      return createErrorResponse('chrome.webRequest is unavailable; networkIdleMs cannot be used');
    }

    const watcher = wantsNetworkIdle ? new NetworkIdleWatcher(tabId) : null;
    const startedAt = Date.now();
    // in-page 관찰자를 같은 조건끼리 하나로 묶기 위한 키(문서당 하나만 살아 있게 한다).
    const conditionKey = `${selector ?? ''}|${text ?? ''}|${state}|${documentReady ? 1 : 0}`;
    const lastState: LastState = {};

    try {
      watcher?.start();

      for (;;) {
        // 대기 중 탭이 닫히면 즉시 실패로 보고한다 (무의미한 폴링 방지).
        const stillOpen = await this.tryGetTab(tabId);
        if (!stillOpen) {
          return createErrorResponse(`Tab ${tabId} was closed while waiting`);
        }

        let probe: PageProbe | undefined;
        if (needsPageProbe) {
          try {
            const [injection] = await chrome.scripting.executeScript({
              target: { tabId },
              func: probePageState,
              args: [selector, text],
            });
            probe = injection?.result ?? undefined;
          } catch (error) {
            // 내비게이션 중에는 일시적으로 주입이 실패할 수 있으므로 다음 폴링에서 재시도한다.
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`chrome_wait_for: executeScript failed (will retry): ${message}`);
          }

          if (probe?.invalidSelector) {
            return createErrorResponse(`Invalid CSS selector: ${selector}`);
          }

          if (probe) {
            lastState.readyState = probe.readyState;
            if (selector) {
              lastState.selectorFound = probe.selectorFound === true;
              lastState.selectorVisible = probe.selectorVisible === true;
            }
            if (text) lastState.textFound = probe.textFound === true;
          }
        }

        if (watcher) lastState.networkInFlight = watcher.inFlightCount;

        let matched = true;

        if (selector) {
          const found = probe?.selectorFound === true;
          const visible = probe?.selectorVisible === true;
          if (state === 'attached') matched = matched && found;
          else if (state === 'visible') matched = matched && found && visible;
          // hidden: 존재하지 않거나, 존재하더라도 보이지 않는 상태
          else matched = matched && Boolean(probe) && (!found || !visible);
        }

        if (text) matched = matched && probe?.textFound === true;
        if (documentReady) matched = matched && probe?.readyState === 'complete';
        if (watcher) matched = matched && watcher.isIdle(networkIdleMs);

        if (matched) {
          const conditions: MatchedConditions = {};
          if (selector) conditions.selector = { selector, state };
          if (text) conditions.text = text;
          if (documentReady) conditions.documentReady = true;
          if (watcher) conditions.networkIdleMs = networkIdleMs;

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  tabId,
                  url: stillOpen.url,
                  waitedMs: Date.now() - startedAt,
                  conditions,
                }),
              },
            ],
            isError: false,
          };
        }

        if (Date.now() - startedAt >= timeoutMs) {
          // 타임아웃은 도구 실패가 아니라 관측 결과다 — 모델이 lastState 를 보고 판단하게 한다.
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  timedOut: true,
                  tabId,
                  url: stillOpen.url,
                  waitedMs: Date.now() - startedAt,
                  timeoutMs,
                  lastState,
                }),
              },
            ],
            isError: false,
          };
        }

        // 남은 시간이 0 이면 즉시 다시 확인하고(위 타임아웃 분기가 잡는다), 마지막 조각은
        // 남은 시간만큼만 자른다 — 어떤 경로로도 timeoutMs 를 넘기지 않는다.
        const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt));
        await this.waitForNextCheck(
          tabId,
          needsPageProbe,
          Math.min(pollMs, remainingMs),
          conditionKey,
        );
      }
    } catch (error) {
      return createErrorResponse(
        `chrome_wait_for failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      watcher?.stop();
    }
  }
}

export const waitForTool = new WaitForTool();

// ===== auto-chrome-mcp fork (A2): navigate 후 로딩 완료 대기 =====
// chrome_navigate 가 이동 직후 곧바로 반환하면 read_page/click 이 빈 페이지를 보게 된다.
// 아래 헬퍼로 navigate 안에서 로드 상태를 기다린 뒤 결과에 실제 상태를 실어 보낸다.

export type NavigateWaitUntil = 'none' | 'domcontentloaded' | 'load' | 'networkidle';

export interface PageLoadWaitResult {
  waitUntil: NavigateWaitUntil;
  reached: boolean;
  timedOut: boolean;
  waitedMs: number;
  readyState?: string;
  networkInFlight?: number;
  skipped?: string;
}

const NAVIGATE_WAIT_POLL_MS = 150;
const NAVIGATE_NETWORK_IDLE_MS = 500;

/** 내비게이션이 커밋되기 전(=아직 이전 문서)인지 가리기 위한 grace. */
const NAVIGATE_COMMIT_GRACE_MS = 700;
/** readyState 를 못 읽는 상태가 이만큼 연속되면 "주입 불가 문서"로 보고 탭 상태로 판정한다. */
const NOT_INJECTABLE_SAMPLES = 3;

interface DocumentSample {
  readyState: string | null;
  /** 문서 식별자 — 새 문서로 바뀌었는지 판정용 (문서마다 timeOrigin 이 다르다). */
  docId: number | null;
}

async function readDocumentState(tabId: number): Promise<DocumentSample> {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ readyState: document.readyState, docId: performance.timeOrigin }),
    });
    const value = injection?.result as { readyState?: string; docId?: number } | undefined;
    return {
      readyState: typeof value?.readyState === 'string' ? value.readyState : null,
      docId: typeof value?.docId === 'number' ? value.docId : null,
    };
  } catch {
    // 내비게이션 중에는 일시적으로 주입이 실패한다 — 다음 폴링에서 재시도
    return { readyState: null, docId: null };
  }
}

interface TabState {
  exists: boolean;
  status: string | null;
  url: string | null;
}

async function readTabState(tabId: number): Promise<TabState> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return { exists: true, status: tab.status ?? null, url: tab.url ?? null };
  } catch {
    // 탭이 닫혔다. "상태를 모른다"로 뭉뚱그리면 로딩 완료로 오인하거나 타임아웃까지 헛돈다.
    return { exists: false, status: null, url: null };
  }
}

/** 탭이 요청한 URL 로 실제로 넘어갔는가 (크롬이 붙이는 끝 슬래시 차이는 무시). */
function urlCommitted(tabUrl: string | null, targetUrl: string | undefined): boolean {
  if (!tabUrl || !targetUrl) return false;
  const normalize = (value: string) => value.replace(/\/$/, '');
  return normalize(tabUrl) === normalize(targetUrl);
}

/**
 * auto-chrome-mcp fork: navigate 가 커밋되기 전까지는 **이전 문서**가 그대로 살아 있고
 * readyState 도 'complete' 라, 그것만 보면 "이미 로드 끝"으로 오판한다(실측: waitedMs 1~7ms,
 * 결과 url/title 도 이전 페이지 것). 그래서 내비게이션이 시작됐다는 신호를 navigate 호출
 * **전에** 걸어 두고, 그 신호를 로딩 판정에 함께 쓴다.
 */
export interface NavigationStartWatcher {
  started(tabId: number): boolean;
  stop(): void;
}

export function watchNavigationStart(): NavigationStartWatcher {
  const loading = new Set<number>();
  const listener = (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
    if (changeInfo.status === 'loading') loading.add(tabId);
  };
  try {
    chrome.tabs.onUpdated.addListener(listener);
  } catch {
    // 테스트 목 등에서 리스너를 못 걸면 grace 로만 동작한다.
  }
  return {
    started: (tabId: number) => loading.has(tabId),
    stop: () => {
      try {
        chrome.tabs.onUpdated.removeListener(listener);
      } catch {
        /* 이미 제거됐을 수 있다 */
      }
    },
  };
}

/**
 * 탭이 원하는 로드 단계에 도달할 때까지 기다린다.
 * 타임아웃은 오류가 아니라 관측 결과로 돌려준다 (모델이 상태를 보고 판단하도록).
 */
export async function waitForPageLoad(
  tabId: number,
  waitUntil: NavigateWaitUntil,
  timeoutMs: number,
  options?: { navigationStarted?: () => boolean; commitGraceMs?: number; targetUrl?: string },
): Promise<PageLoadWaitResult> {
  const startedAt = Date.now();
  const base: PageLoadWaitResult = {
    waitUntil,
    reached: false,
    timedOut: false,
    waitedMs: 0,
  };
  if (waitUntil === 'none') return { ...base, reached: true };

  let tab: chrome.tabs.Tab | null = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ...base, reached: false, skipped: 'tab_not_found' };
  }
  if (isRestrictedUrl(tab.url)) {
    return { ...base, reached: true, skipped: 'restricted_url' };
  }

  const wantsNetworkIdle = waitUntil === 'networkidle';
  if (wantsNetworkIdle && typeof chrome.webRequest === 'undefined') {
    return { ...base, reached: false, skipped: 'webrequest_unavailable' };
  }

  // grace 가 타임아웃보다 길면, 이동이 끝난 해시 이동 같은 케이스가 timedOut 으로 잘못 나간다.
  const graceMs = Math.min(
    Math.max(0, options?.commitGraceMs ?? NAVIGATE_COMMIT_GRACE_MS),
    timeoutMs,
  );
  const navigationStarted = options?.navigationStarted;
  // 첫 샘플은 (아직 커밋 전이라면) 이전 문서다 — 이후 문서가 바뀌는지 보는 기준점.
  let baselineDocId: number | null = null;
  let baselineReadyState: string | null = null;
  let notInjectableSamples = 0;

  const watcher = wantsNetworkIdle ? new NetworkIdleWatcher(tabId) : null;
  try {
    watcher?.start();
    for (;;) {
      const sample = await readDocumentState(tabId);
      const tabState = await readTabState(tabId);
      const readyState = sample.readyState;
      const elapsed = Date.now() - startedAt;
      if (!tabState.exists) {
        return { ...base, reached: false, waitedMs: elapsed, skipped: 'tab_not_found' };
      }
      if (baselineReadyState === null && readyState !== null) {
        baselineReadyState = readyState;
        baselineDocId = sample.docId;
      }

      let reached = false;
      if (readyState) {
        if (waitUntil === 'domcontentloaded') {
          reached = readyState === 'interactive' || readyState === 'complete';
        } else {
          reached = readyState === 'complete';
        }
      }
      // 아직 이전 문서를 보고 있는 것일 수 있다. 문서가 바뀐 것이 확인되면 그대로 믿고,
      // 아니면 탭이 로딩을 끝냈는지(status)와 내비게이션 시작 신호로 판정한다.
      if (reached) {
        // 문서가 바뀐 것을 확인했거나, **끝나 있던**(complete) 문서가 interactive 로 바뀌었다면
        // 새 문서다. 후자가 없으면 기본값 domcontentloaded 가 사실상 load 까지 기다린다.
        // ⚠️ 기준 문서가 애초에 로딩 중이었다면 interactive 는 증거가 못 된다 — 아직 로딩 중인
        // 페이지 위에 또 navigate 한 경우, 이전 문서의 interactive 를 새 문서로 착각한다.
        const documentChanged =
          baselineDocId !== null && sample.docId !== null && sample.docId !== baselineDocId;
        // 탭 URL 이 이미 목표 URL 이면 커밋이 끝난 것이므로 지금 보이는 문서가 새 문서다.
        const arrived = urlCommitted(tabState.url, options?.targetUrl);
        const isNewDocument =
          documentChanged ||
          (readyState === 'interactive' && (arrived || baselineReadyState === 'complete'));
        if (!isNewDocument) {
          const navigationObserved = !navigationStarted || navigationStarted();
          reached = tabState.status === 'complete' && (navigationObserved || elapsed >= graceMs);
        }
      }
      // 스크립트를 주입할 수 없는 문서(about:blank·PDF·view-source 등)는 readyState 를
      // 영원히 못 읽는다. 탭이 로딩을 끝냈다면 그것으로 판정한다 — 아니면 타임아웃까지 헛돈다.
      if (!readyState) {
        // 이동이 시작된 것을 아직 못 봤다면 "주입 실패"는 커밋 직전의 일시적 상태일 수 있다 —
        // grace 전에는 결론내지 않는다.
        const navigationObserved = !navigationStarted || navigationStarted();
        const settledLongEnough =
          tabState.status === 'complete' && (navigationObserved || elapsed >= graceMs);
        notInjectableSamples = settledLongEnough ? notInjectableSamples + 1 : 0;
        // networkidle 을 요구했다면 여기서도 네트워크가 잠잠한지 확인한다 (PDF range 요청 등).
        if (
          notInjectableSamples >= NOT_INJECTABLE_SAMPLES &&
          (!watcher || watcher.isIdle(NAVIGATE_NETWORK_IDLE_MS))
        ) {
          return {
            ...base,
            reached: true,
            waitedMs: elapsed,
            skipped: 'not_injectable',
            networkInFlight: watcher ? watcher.inFlightCount : undefined,
          };
        }
      } else {
        notInjectableSamples = 0;
      }
      if (reached && watcher) {
        reached = watcher.isIdle(NAVIGATE_NETWORK_IDLE_MS);
      }

      if (reached) {
        return {
          waitUntil,
          reached: true,
          timedOut: false,
          waitedMs: Date.now() - startedAt,
          readyState: readyState ?? undefined,
          networkInFlight: watcher ? watcher.inFlightCount : undefined,
        };
      }

      if (elapsed >= timeoutMs) {
        return {
          waitUntil,
          reached: false,
          timedOut: true,
          waitedMs: elapsed,
          readyState: readyState ?? undefined,
          networkInFlight: watcher ? watcher.inFlightCount : undefined,
        };
      }

      await sleep(Math.min(NAVIGATE_WAIT_POLL_MS, Math.max(0, timeoutMs - elapsed)));
    }
  } finally {
    watcher?.stop();
  }
}
