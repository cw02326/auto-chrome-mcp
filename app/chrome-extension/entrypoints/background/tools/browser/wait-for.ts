import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';

/**
 * scalemaker fork: chrome_wait_for — "너무 일찍 클릭 / 빈 페이지 읽기" 실패를 없애는 대기 도구.
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
const MAX_NETWORK_IDLE_MS = 30000;

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
 * 대상 탭의 in-flight 요청 수와 마지막 네트워크 활동 시각을 추적한다.
 * 반드시 stop() 으로 리스너를 제거해야 한다 (execute 의 finally 에서 호출).
 */
class NetworkIdleWatcher {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Wait until a page condition holds (selector / text / network idle / document ready)
 */
class WaitForTool extends BaseBrowserToolExecutor {
  name = 'chrome_wait_for';

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

    const timeoutMs =
      typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs)
        ? clamp(params.timeoutMs, 0, MAX_TIMEOUT_MS)
        : DEFAULT_TIMEOUT_MS;
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

        await sleep(Math.min(pollMs, Math.max(0, timeoutMs - (Date.now() - startedAt))));
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
