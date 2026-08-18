import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { focusWindowIfAllowed } from '@/utils/focus-policy';
// auto-chrome-mcp fork(T2): 직전 읽기와 동일하면 본문을 다시 보내지 않기 위한 콘텐츠 해시 캐시
import { diffCheck } from '@/utils/content-cache';
// auto-chrome-mcp fork: iframe 안의 interactive elements 까지 수집하기 위한 프레임 열거 유틸
import { FRAME_COLLECT_MAX_FRAMES, listChildFrames } from './frame-resolver';

interface WebFetcherToolParams {
  htmlContent?: boolean; // get the visible HTML content of the current page. default: false
  textContent?: boolean; // get the visible text content of the current page. default: true
  url?: string; // optional URL to fetch content from (if not provided, uses active tab)
  selector?: string; // optional CSS selector to get content from a specific element
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
      url,
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
        // If URL is provided, check if it's already open
        console.log(`Checking if URL is already open: ${url}`);
        const allTabs = await chrome.tabs.query({});

        // Find tab with matching URL
        const matchingTabs = allTabs.filter((t) => {
          // Normalize URLs for comparison (remove trailing slashes)
          const tabUrl = t.url?.endsWith('/') ? t.url.slice(0, -1) : t.url;
          const targetUrl = url.endsWith('/') ? url.slice(0, -1) : url;
          return tabUrl === targetUrl;
        });

        if (matchingTabs.length > 0) {
          // Use existing tab
          tab = matchingTabs[0];
          console.log(`Found existing tab with URL: ${url}, tab ID: ${tab.id}`);
        } else {
          // Create new tab with the URL
          console.log(`No existing tab found with URL: ${url}, creating new tab`);
          tab = await chrome.tabs.create({ url, active: background ? false : true });

          // Wait for page to load
          console.log('Waiting for page to load...');
          await new Promise((resolve) => setTimeout(resolve, 3000));
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
        await chrome.tabs.update(tab.id, { active: true });
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
        });

        if (htmlResponse.success) {
          result.htmlContent = htmlResponse.htmlContent;
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

    console.log(`Starting get interactive elements with options:`, args);

    try {
      // Get current tab
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]) {
        return createErrorResponse('No active tab found');
      }

      const tab = tabs[0];
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
