import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { activateTab, focusWindow as focusWindowIfAllowed } from '@/utils/activation-guard';
// auto-chrome-mcp fork: url 분기가 사용자 창의 탭을 집지 않도록 세션 소유 탭으로만 조회한다.
import { createTabForUrl, findTabByUrlInSessionScope } from './url-target';
// auto-chrome-mcp fork(T2): 직전 읽기와 동일하면 본문을 다시 보내지 않기 위한 콘텐츠 해시 캐시
import { diffCheck } from '@/utils/content-cache';
// auto-chrome-mcp fork: iframe 안의 interactive elements 까지 수집하기 위한 프레임 열거 유틸
import { FRAME_COLLECT_MAX_FRAMES, listChildFrames } from './frame-resolver';
import { redactedArgsForLog, redactUrlForLog } from '@/utils/log-redact';
// auto-chrome-mcp fork: 새 탭 생성 후 고정 대기 대신 실제 로드 신호를 관측하기 위해 import
// (navigate 가 쓰는 것과 같은 유틸 — wait-for.ts 는 이 작업 범위 밖이라 수정하지 않는다).
import { waitForPageLoad } from './wait-for';

/** auto-chrome-mcp fork: 새 탭 생성 후 로드 관측 상한 (예전 고정 대기보다 넉넉히 잡는다) */
const WEB_FETCHER_LOAD_TIMEOUT_MS = 15000;
/** auto-chrome-mcp fork: 관측 대기가 실패했을 때의 폴백 — 예전 고정 대기와 동일한 값 */
const WEB_FETCHER_LOAD_FALLBACK_MS = 3000;

interface WebFetcherToolParams {
  htmlContent?: boolean; // get the visible HTML content of the current page. default: false
  textContent?: boolean; // get the visible text content of the current page. default: true
  url?: string; // optional URL to fetch content from (if not provided, uses active tab)
  selector?: string; // optional CSS selector to get content from a specific element
  /** auto-chrome-mcp fork: htmlContent 반환 상한(문자). 미지정 시 helper 기본값(100k). */
  maxChars?: number;
  tabId?: number; // target existing tab id
  background?: boolean; // do not activate/focus
  windowId?: number; // target window id to pick active tab or create tab
  // auto-chrome-mcp fork(T5): true 면 보일러플레이트 제거 없이 예전 그대로의 본문을 반환. default: false
  raw?: boolean;
  // auto-chrome-mcp fork(T2): 직전 호출과 내용이 같으면 본문 대신 unchanged 마커만 반환. default: true
  diff?: boolean;
}

class WebFetcherTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.WEB_FETCHER;

  /**
   * Execute web fetcher operation
   */
  async execute(args: WebFetcherToolParams): Promise<ToolResult> {
    // Handle mutually exclusive parameters: if htmlContent is true, textContent is forced to false
    const htmlContent = args.htmlContent === true;
    const textContent = htmlContent ? false : args.textContent !== false; // Default is true, unless htmlContent is true or textContent is explicitly set to false
    const url = args.url;
    const selector = args.selector;
    const explicitTabId = args.tabId;
    const background = args.background === true;
    const windowId = args.windowId;
    // auto-chrome-mcp fork: reader 모드가 기본. raw:true 면 예전 본문 그대로.
    const raw = args.raw === true;
    const mode: 'reader' | 'raw' = raw ? 'raw' : 'reader';
    const useDiff = args.diff !== false;

    console.log(`Starting web fetcher with options:`, {
      htmlContent,
      textContent,
      // 2026-09-05 Codex 재확인 1: 여기서 URL 원문(쿼리 토큰 포함)이 그대로 찍혔다.
      url: redactUrlForLog(url),
      selector,
      mode,
      diff: useDiff,
    });

    try {
      // Get tab to fetch content from
      let tab;

      if (typeof explicitTabId === 'number') {
        tab = await chrome.tabs.get(explicitTabId);
      } else if (url) {
        // auto-chrome-mcp fork: 백그라운드 작업 모드에서는 이 세션이 소유한 탭에서만 찾는다.
        // 예전에는 chrome.tabs.query({}) 로 모든 창을 뒤져 사용자 탭이 걸렸다.
        const existing = await findTabByUrlInSessionScope(url, args);
        if (existing) {
          tab = existing;
          console.log(`Found session tab with URL: ${redactUrlForLog(url)}, tab ID: ${tab.id}`);
        } else {
          // Create new tab with the URL (지정한 창에 만든다 — 예전엔 windowId 를 안 넘겨
          // 사용자가 보고 있는 창에 탭이 붙었다).
          console.log(`No session tab found with URL: ${redactUrlForLog(url)}, creating new tab`);
          tab = await createTabForUrl(url, {
            background,
            windowId,
            reason: 'web-fetcher',
            args,
          });

          // Wait for page to load
          console.log('Waiting for page to load...');
          // auto-chrome-mcp fork(2026-09): 고정 3000ms 대기 대신 실제 로드 신호(observed
          // DOMContentLoaded)를 기다린다 — 로드가 더 빨리 끝나면 그만큼 빨리 돌아온다.
          // navigate 가 쓰는 것과 같은 유틸(common.ts 의 waitForPageLoad 호출 참고).
          // 새로 만든 탭이라 navigationStarted 추적은 필요 없다. 실패 시(예: 예상치 못한 에러)
          // 에는 예전과 동일한 고정 3000ms 상한으로 폴백한다.
          if (typeof tab.id === 'number') {
            try {
              await waitForPageLoad(tab.id, 'domcontentloaded', WEB_FETCHER_LOAD_TIMEOUT_MS, {
                targetUrl: url,
              });
            } catch (waitErr) {
              console.warn(
                '[WebFetcher] waitForPageLoad failed, falling back to fixed wait:',
                waitErr,
              );
              await new Promise((resolve) => setTimeout(resolve, WEB_FETCHER_LOAD_FALLBACK_MS));
            }
          } else {
            await new Promise((resolve) => setTimeout(resolve, WEB_FETCHER_LOAD_FALLBACK_MS));
          }
        }
      } else {
        // Use active tab (prefer specified window)
        const tabs =
          typeof windowId === 'number'
            ? await chrome.tabs.query({ active: true, windowId })
            : await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs[0]) {
          return createErrorResponse('No active tab found');
        }
        tab = tabs[0];
      }

      if (!tab.id) {
        return createErrorResponse('Tab has no ID');
      }

      // Optionally bring tab/window to foreground
      // auto-chrome-mcp fork: windows.update({focused:true}) 는 강제포커스 정책 통과 시에만 호출.
      if (!background) {
        // v1.9.0: 활성화 판정은 activation-guard 한곳에서만 한다.
        await activateTab(tab.id, { reason: 'web-fetcher' });
        await focusWindowIfAllowed(tab.windowId);
      }

      // Prepare result object
      const result: any = {
        success: true,
        url: tab.url,
        title: tab.title,
      };

      await this.injectContentScript(tab.id, ['inject-scripts/web-fetcher-helper.js']);

      // Get HTML content if requested
      if (htmlContent) {
        const htmlResponse = await this.sendMessageToTab(tab.id, {
          action: TOOL_MESSAGE_TYPES.WEB_FETCHER_GET_HTML_CONTENT,
          selector: selector,
          // auto-chrome-mcp fork: 상한을 helper 로 넘겨 전송량 자체를 줄인다.
          maxChars:
            typeof args.maxChars === 'number' && Number.isFinite(args.maxChars) && args.maxChars > 0
              ? args.maxChars
              : undefined,
        });

        if (htmlResponse.success) {
          const html: string =
            typeof htmlResponse.htmlContent === 'string' ? htmlResponse.htmlContent : '';

          // auto-chrome-mcp fork(T2): 텍스트 경로와 같은 diff 규칙을 HTML 에도 적용한다.
          if (useDiff) {
            const diffKey = `get_web_content:${tab.id}:html:${selector ?? ''}`;
            const { unchanged, hash } = diffCheck(diffKey, html);
            if (unchanged) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: true,
                      unchanged: true,
                      hash,
                      chars: html.length,
                      message:
                        'HTML identical to your previous read of this tab — reuse it. Pass diff:false to force full re-send.',
                    }),
                  },
                ],
                isError: false,
              };
            }
            result.contentHash = hash;
          }

          result.htmlContent = html;
          // 잘렸는지를 모델이 알아야 maxChars 를 올리거나 selector 로 좁힐 수 있다.
          if (typeof htmlResponse.fullHtmlChars === 'number') {
            result.fullHtmlChars = htmlResponse.fullHtmlChars;
          }
          result.returnedChars =
            typeof htmlResponse.returnedChars === 'number'
              ? htmlResponse.returnedChars
              : html.length;
          if (htmlResponse.truncated === true) {
            result.truncated = true;
            result.truncatedHint =
              'HTML was truncated. Narrow it with `selector`, or raise `maxChars` — but prefer chrome_extract for targeted fields.';
          }
        } else {
          console.error('Failed to get HTML content:', htmlResponse.error);
          result.htmlContentError = htmlResponse.error;
        }
      }

      // Get text content if requested (and htmlContent is not true)
      if (textContent) {
        const textResponse = await this.sendMessageToTab(tab.id, {
          action: TOOL_MESSAGE_TYPES.WEB_FETCHER_GET_TEXT_CONTENT,
          selector: selector,
          // auto-chrome-mcp fork(T5): helper 는 이 플래그가 있을 때만 reader 추출을 한다
          // (content-indexer 등 다른 호출자는 기존 동작 유지).
          readerMode: !raw,
        });

        if (textResponse.success) {
          const finalText =
            typeof textResponse.textContent === 'string' ? textResponse.textContent : '';

          // auto-chrome-mcp fork(T2): 직전 호출과 본문이 같으면 본문을 통째로 다시 보내지 않는다.
          if (useDiff) {
            const diffKey = `get_web_content:${tab.id}:${mode}:${selector ?? ''}`;
            const { unchanged, hash } = diffCheck(diffKey, finalText);
            if (unchanged) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: true,
                      unchanged: true,
                      hash,
                      chars: finalText.length,
                      message:
                        'Content identical to your previous read of this tab — reuse it. Pass diff:false to force full re-send.',
                    }),
                  },
                ],
                isError: false,
              };
            }
            result.contentHash = hash;
          }

          result.textContent = finalText;

          // auto-chrome-mcp fork(T5): 모델이 "잘려나간 게 있나?" 를 스스로 판단하고 raw:true 로
          // 재요청할 수 있도록 추출 모드와 원문/반환 길이를 함께 알려준다.
          result.mode = typeof textResponse.mode === 'string' ? textResponse.mode : mode;
          if (typeof textResponse.fullTextChars === 'number') {
            result.fullTextChars = textResponse.fullTextChars;
          }
          result.returnedChars =
            typeof textResponse.returnedChars === 'number'
              ? textResponse.returnedChars
              : finalText.length;
          if (textResponse.readerSource) result.readerSource = textResponse.readerSource;
          if (textResponse.readerFallback) result.readerFallback = textResponse.readerFallback;
          if (result.mode === 'reader') {
            result.rawHint = 'Boilerplate was stripped. Pass raw:true to get the unfiltered text.';
          }

          // Include article metadata if available
          if (textResponse.article) {
            result.article = {
              title: textResponse.article.title,
              byline: textResponse.article.byline,
              siteName: textResponse.article.siteName,
              excerpt: textResponse.article.excerpt,
              lang: textResponse.article.lang,
            };
          }

          // Include page metadata if available
          if (textResponse.metadata) {
            result.metadata = textResponse.metadata;
          }
        } else {
          console.error('Failed to get text content:', textResponse.error);
          result.textContentError = textResponse.error;
        }
      }

      // Interactive elements feature has been removed

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in web fetcher:', error);
      return createErrorResponse(
        `Error fetching web content: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const webFetcherTool = new WebFetcherTool();

interface GetInteractiveElementsToolParams {
  textQuery?: string; // Text to search for within interactive elements (fuzzy search)
  selector?: string; // CSS selector to filter interactive elements
  includeCoordinates?: boolean; // Include element coordinates in the response (default: true)
  types?: string[]; // Types of interactive elements to include (default: all types)
  // auto-chrome-mcp fork: true 면 top frame 외에 iframe 안의 요소도 함께 수집한다. default: false
  allFrames?: boolean;
  // auto-chrome-mcp fork(2026-09-04): 게이트가 주입하는 대상 탭. 없으면 활성 탭.
  // 이 필드가 없어서 작업 탭 주입이 통째로 버려지고 사용자의 활성 탭이 읽혔다.
  tabId?: number;
}

/** auto-chrome-mcp fork: allFrames 수집 시 프레임당 / 전체 요소 상한 (read-page.ts 와 동일) */
const FRAME_ELEMENTS_PER_FRAME = 50;
const FRAME_ELEMENTS_TOTAL = 250;

class GetInteractiveElementsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.GET_INTERACTIVE_ELEMENTS;

  /**
   * auto-chrome-mcp fork: 하위 iframe 들에서 interactive elements 를 수집한다(allFrames=true 일 때만).
   * 프레임마다 개별적으로 helper 주입을 보장한 뒤 동일한 메시지를 보낸다.
   * 실패한 프레임은 조용히 건너뛴다 (top frame 결과는 항상 유지).
   */
  private async collectFrameInteractiveElements(
    tabId: number,
    message: {
      textQuery?: string;
      selector?: string;
      includeCoordinates: boolean;
      types?: string[];
    },
  ): Promise<any[]> {
    const frames = await listChildFrames(tabId, Math.max(0, FRAME_COLLECT_MAX_FRAMES - 1));
    if (frames.length === 0) return [];

    const settled = await Promise.allSettled(
      frames.map(async (frame): Promise<any[]> => {
        try {
          await this.injectContentScript(
            tabId,
            ['inject-scripts/interactive-elements-helper.js'],
            false,
            'ISOLATED',
            false,
            [frame.frameId],
          );
        } catch {
          return [];
        }
        const resp = await this.sendMessageToTab(
          tabId,
          {
            action: TOOL_MESSAGE_TYPES.GET_INTERACTIVE_ELEMENTS,
            textQuery: message.textQuery,
            selector: message.selector,
            includeCoordinates: message.includeCoordinates,
            types: message.types,
          },
          frame.frameId,
        );
        if (!resp || resp.success !== true || !Array.isArray(resp.elements)) return [];
        return resp.elements
          .slice(0, FRAME_ELEMENTS_PER_FRAME)
          .map((el: any) => ({ ...el, frameId: frame.frameId, frameUrl: frame.frameUrl }));
      }),
    );

    const out: any[] = [];
    for (const s of settled) {
      if (s.status === 'fulfilled' && Array.isArray(s.value)) out.push(...s.value);
    }
    return out;
  }

  /**
   * Execute get interactive elements operation
   */
  async execute(args: GetInteractiveElementsToolParams): Promise<ToolResult> {
    const { textQuery, selector, includeCoordinates = true, types } = args;
    const allFrames = args.allFrames === true;

    console.log(`Starting get interactive elements with options:`, redactedArgsForLog(args));

    try {
      // auto-chrome-mcp fork(2026-09-04): 주입된 tabId 를 최우선으로 소비한다.
      // 예전에는 이 값을 무시하고 currentWindow 활성 탭을 조회해 사용자 탭이 읽혔다.
      // windowId 는 소비하지 않는다 — 게이트의 WINDOW_ID_AWARE_TOOLS 에서 빠져 있고,
      // 창 지정만으로 통과시키지 않는 fail-closed 판정을 그대로 두기 위함이다.
      const explicit = await this.tryGetTab(args.tabId);
      const tab = explicit || (await this.getActiveTabInWindow());
      if (!tab) {
        return createErrorResponse('No active tab found');
      }
      if (!tab.id) {
        return createErrorResponse('Active tab has no ID');
      }

      // Ensure content script is injected
      await this.injectContentScript(tab.id, ['inject-scripts/interactive-elements-helper.js']);

      // Send message to content script
      const result = await this.sendMessageToTab(tab.id, {
        action: TOOL_MESSAGE_TYPES.GET_INTERACTIVE_ELEMENTS,
        textQuery,
        selector,
        includeCoordinates,
        types,
      });

      if (!result.success) {
        return createErrorResponse(result.error || 'Failed to get interactive elements');
      }

      let elements: any[] = Array.isArray(result.elements) ? result.elements : [];
      let frameElementCount = 0;

      // auto-chrome-mcp fork: iframe 안의 요소도 필요할 때만(allFrames:true) 추가로 모은다.
      if (allFrames) {
        try {
          const frameEls = await this.collectFrameInteractiveElements(tab.id, {
            textQuery,
            selector,
            includeCoordinates,
            types,
          });
          if (frameEls.length > 0) {
            frameElementCount = frameEls.length;
            elements = [...elements, ...frameEls].slice(0, FRAME_ELEMENTS_TOTAL);
          }
        } catch (frameError) {
          console.warn('get_interactive_elements allFrames collection failed:', frameError);
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              elements,
              count: elements.length,
              ...(allFrames ? { allFrames: true, frameElementCount } : {}),
              query: {
                textQuery,
                selector,
                types: types || 'all',
              },
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in get interactive elements operation:', error);
      return createErrorResponse(
        `Error getting interactive elements: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const getInteractiveElementsTool = new GetInteractiveElementsTool();
