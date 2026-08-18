import { createErrorResponse, ToolResult } from '@/common/tool-handler';
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

/**
 * 이미 모은 텍스트에 새 스냅샷의 "새로운 부분"만 덧붙인다.
 * 1) 스냅샷이 누적본으로 시작하면 (일반적인 append-only 페이지) 뒤쪽 차이만 추가
 * 2) 아니면 누적본의 가장 긴 접미사가 스냅샷의 접두사가 되는 지점을 찾아 나머지만 추가
 *    (가상 스크롤로 앞부분이 언로드된 경우)
 * 3) 겹침을 못 찾으면 구분자와 함께 통째로 추가
 */
function appendWithOverlap(accumulated: string, snapshot: string): string {
  if (!snapshot) return accumulated;
  if (!accumulated) return snapshot;
  if (snapshot === accumulated) return accumulated;
  if (snapshot.startsWith(accumulated)) return accumulated + snapshot.slice(accumulated.length);
  if (accumulated.endsWith(snapshot)) return accumulated;

  const tail = accumulated.slice(-OVERLAP_WINDOW);
  const maxOverlap = Math.min(tail.length, snapshot.length);
  for (let length = maxOverlap; length >= MIN_OVERLAP; length--) {
    if (snapshot.startsWith(tail.slice(tail.length - length))) {
      return accumulated + snapshot.slice(length);
    }
  }

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

    try {
      for (let pass = 0; pass < maxScrolls; pass++) {
        const stillOpen = await this.tryGetTab(tabId);
        if (!stillOpen) {
          return createErrorResponse(`Tab ${tabId} was closed while collecting`);
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
            return createErrorResponse(
              `Failed to run collection script in tab ${tabId}: ${message}`,
            );
          }
          // 내비게이션 등으로 중간 패스가 실패하면 지금까지 모은 내용을 반환한다.
          console.warn(`chrome_scroll_collect: executeScript failed on pass ${pass}: ${message}`);
          stoppedReason = 'scriptError';
          break;
        }

        if (!result) {
          if (pass === 0) {
            return createErrorResponse(`Collection script returned no result for tab ${tabId}`);
          }
          stoppedReason = 'scriptError';
          break;
        }
        if (!result.ok) {
          return createErrorResponse(result.error || 'Collection script failed');
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
    } catch (error) {
      return createErrorResponse(
        `chrome_scroll_collect failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const payload: Record<string, unknown> = {
      success: true,
      tabId,
      url: tab.url,
      scrolls,
      finalHeight,
      truncated,
      stoppedReason,
    };
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
