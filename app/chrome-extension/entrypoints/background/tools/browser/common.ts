import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import { captureFrameOnAction, isAutoCaptureActive } from './gif-recorder';
import { focusWindowIfAllowed, isForceFocusEnabled } from '@/utils/focus-policy';
import { getWorkTabId, setWorkTab } from '@/utils/work-tab-manager';
import { isBackgroundModeEnabled } from '@/utils/background-mode';
import {
  getCurrentUserWindowId,
  getOrCreateMcpWindow,
  getWorkWindowMode,
  isMcpWindow,
  type WorkWindowMode,
} from '@/utils/mcp-window-manager';

// Default window dimensions
const DEFAULT_WINDOW_WIDTH = 1280;
const DEFAULT_WINDOW_HEIGHT = 720;

interface NavigateToolParams {
  url?: string;
  newWindow?: boolean;
  width?: number;
  height?: number;
  refresh?: boolean;
  tabId?: number;
  windowId?: number;
  background?: boolean; // when true, do not activate tab or focus window
}

/**
 * Tool for navigating to URLs in browser tabs or windows
 */
class NavigateTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.NAVIGATE;

  /**
   * Trigger GIF auto-capture after successful navigation
   */
  private async triggerAutoCapture(tabId: number, url?: string): Promise<void> {
    if (!isAutoCaptureActive(tabId)) {
      return;
    }
    try {
      await captureFrameOnAction(tabId, { type: 'navigate', url });
    } catch (error) {
      console.warn('[NavigateTool] Auto-capture failed:', error);
    }
  }

  /**
   * scalemaker fork: navigate 가 확정한 탭을 "MCP 작업 탭"으로 기록.
   * 이후 tabId 미지정 도구 호출이 사용자의 활성 탭 대신 이 탭을 대상으로 한다.
   */
  private async rememberWorkTab(tabId?: number, sessionId?: string): Promise<void> {
    if (typeof tabId !== 'number') return;
    try {
      await setWorkTab(tabId, sessionId);
    } catch (error) {
      console.warn('[NavigateTool] Failed to record MCP work tab:', error);
    }
  }

  /**
   * scalemaker fork: MCP 작업 탭을 만들 창을 판정한다.
   *
   * 백그라운드 작업 모드(게이트가 background:true 주입)이고 호출자가 windowId 를 명시하지
   * 않은 경우에만 동작하며, 창 모드에 따라 대상이 갈린다:
   *   - 'current'   → 사용자가 이미 열어 둔 일반 창 (없으면 null)
   *   - 'dedicated' → 별도 "MCP 작업 창" (생성 실패 시 null)
   * null 이면 호출부는 기존 동작(last-focused / 새 창 생성)으로 fallback 한다.
   */
  private async resolveWorkWindow(
    background: boolean | undefined,
    windowId: number | undefined,
  ): Promise<{ id: number; mode: WorkWindowMode } | null> {
    if (background !== true) return null;
    if (typeof windowId === 'number') return null;
    try {
      const mode = await getWorkWindowMode();
      const id =
        mode === 'dedicated' ? await getOrCreateMcpWindow() : await getCurrentUserWindowId();
      return id === null ? null : { id, mode };
    } catch (error) {
      console.warn('[NavigateTool] Failed to resolve MCP work window:', error);
      return null;
    }
  }

  /**
   * scalemaker fork: 전용 작업 창을 만들 때 같이 생긴 about:blank 탭 정리 (best-effort).
   * 방금 만든 탭은 건드리지 않고, url 이 정확히 'about:blank' 인 탭만 닫는다.
   * 창에 탭이 하나뿐이면 닫지 않는다 (창 자체가 사라지므로).
   */
  private async closeLeftoverBlankTab(mcpWindowId: number, keepTabId?: number): Promise<void> {
    try {
      const tabs = await chrome.tabs.query({ windowId: mcpWindowId });
      if (tabs.length <= 1) return;
      for (const tab of tabs) {
        if (typeof tab.id !== 'number' || tab.id === keepTabId) continue;
        const url = tab.url || tab.pendingUrl || '';
        if (url === 'about:blank') {
          await chrome.tabs.remove(tab.id);
        }
      }
    } catch (error) {
      console.warn('[NavigateTool] Failed to close leftover about:blank tab:', error);
    }
  }

  async execute(args: NavigateToolParams): Promise<ToolResult> {
    const {
      newWindow = false,
      width,
      height,
      url,
      refresh = false,
      tabId,
      background,
      windowId,
    } = args;
    // scalemaker fork: 게이트가 실어 보낸 세션 id — 세션별 작업 탭 기록에 사용
    const mcpSessionId = (args as any)._mcpSessionId as string | undefined;

    console.log(
      `Attempting to ${refresh ? 'refresh current tab' : `open URL: ${url}`} with options:`,
      args,
    );

    try {
      // Handle refresh option first
      if (refresh) {
        console.log('Refreshing current active tab');
        const explicit = await this.tryGetTab(tabId);
        // Get target tab (explicit or active in provided window)
        const targetTab = explicit || (await this.getActiveTabOrThrowInWindow(windowId));
        if (!targetTab.id) return createErrorResponse('No target tab found to refresh');
        await chrome.tabs.reload(targetTab.id);

        console.log(`Refreshed tab ID: ${targetTab.id}`);

        // Get updated tab information
        const updatedTab = await chrome.tabs.get(targetTab.id);

        // Trigger auto-capture on refresh
        await this.triggerAutoCapture(updatedTab.id!, updatedTab.url);
        await this.rememberWorkTab(updatedTab.id, mcpSessionId);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Successfully refreshed current tab',
                tabId: updatedTab.id,
                windowId: updatedTab.windowId,
                url: updatedTab.url,
              }),
            },
          ],
          isError: false,
        };
      }

      // Validate that url is provided when not refreshing
      if (!url) {
        return createErrorResponse('URL parameter is required when refresh is not true');
      }

      // Handle history navigation: url="back" or url="forward"
      if (url === 'back' || url === 'forward') {
        const explicitTab = await this.tryGetTab(tabId);
        const targetTab = explicitTab || (await this.getActiveTabOrThrowInWindow(windowId));
        if (!targetTab.id) {
          return createErrorResponse('No target tab found for history navigation');
        }

        // Respect background flag for focus behavior
        await this.ensureFocus(targetTab, {
          activate: background !== true,
          focusWindow: background !== true,
        });

        if (url === 'forward') {
          await chrome.tabs.goForward(targetTab.id);
          console.log(`Navigated forward in tab ID: ${targetTab.id}`);
        } else {
          await chrome.tabs.goBack(targetTab.id);
          console.log(`Navigated back in tab ID: ${targetTab.id}`);
        }

        const updatedTab = await chrome.tabs.get(targetTab.id);

        // Trigger auto-capture on history navigation
        await this.triggerAutoCapture(updatedTab.id!, updatedTab.url);
        await this.rememberWorkTab(updatedTab.id, mcpSessionId);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Successfully navigated ${url} in browser history`,
                tabId: updatedTab.id,
                windowId: updatedTab.windowId,
                url: updatedTab.url,
              }),
            },
          ],
          isError: false,
        };
      }

      // 1. Check if URL is already open
      // Prefer Chrome's URL match patterns for robust matching (host/path variations)
      console.log(`Checking if URL is already open: ${url}`);

      // Build robust match patterns from the provided URL.
      // This mirrors the approach in CloseTabsTool: ensure wildcard path and
      // add common variants (www/no-www, http/https) to handle real-world redirects.
      const buildUrlPatterns = (input: string): string[] => {
        const patterns = new Set<string>();
        try {
          if (!input.includes('*')) {
            const u = new URL(input);
            // Use host-level wildcard to include all paths; we'll do precise selection later
            const pathWildcard = '/*';

            const hostNoWww = u.host.replace(/^www\./, '');
            const hostWithWww = hostNoWww.startsWith('www.') ? hostNoWww : `www.${hostNoWww}`;

            // Keep original host
            patterns.add(`${u.protocol}//${u.host}${pathWildcard}`);
            // Add no-www variant
            patterns.add(`${u.protocol}//${hostNoWww}${pathWildcard}`);
            // Add www variant
            patterns.add(`${u.protocol}//${hostWithWww}${pathWildcard}`);

            // Add protocol variant to catch http↔https redirects
            const altProtocol = u.protocol === 'https:' ? 'http:' : 'https:';
            patterns.add(`${altProtocol}//${u.host}${pathWildcard}`);
            patterns.add(`${altProtocol}//${hostNoWww}${pathWildcard}`);
            patterns.add(`${altProtocol}//${hostWithWww}${pathWildcard}`);
          } else {
            patterns.add(input);
          }
        } catch {
          // Fallback: best-effort wildcard suffix
          patterns.add(input.endsWith('/') ? `${input}*` : `${input}/*`);
        }
        return Array.from(patterns);
      };

      const urlPatterns = buildUrlPatterns(url);
      let candidateTabs = await chrome.tabs.query({ url: urlPatterns });
      console.log(`Found ${candidateTabs.length} matching tabs with patterns:`, urlPatterns);

      // scalemaker fork: 백그라운드 작업 모드에서는 사용자가 열어둔 탭을 재사용하지 않는다
      // — 사용자가 보던 동일 URL 탭을 MCP 가 잡아 조작하는 간섭 방지. 이 세션의 기존 작업 탭과
      // (dedicated 모드일 때) MCP 작업 창 안의 탭만 재사용 후보로 인정하고, 없으면 아래에서
      // 새 탭을 만든다. 창 모드와 무관하게 적용 — 'current' 모드에서도 하이재킹은 막아야 한다.
      if (candidateTabs.length > 0 && background === true) {
        const sessionWorkTabId = await getWorkTabId(mcpSessionId);
        const filtered: chrome.tabs.Tab[] = [];
        for (const t of candidateTabs) {
          if (t.id === sessionWorkTabId || (await isMcpWindow(t.windowId))) {
            filtered.push(t);
          }
        }
        if (filtered.length !== candidateTabs.length) {
          console.log(
            `Background mode: ${candidateTabs.length - filtered.length} user tab(s) excluded from reuse`,
          );
        }
        candidateTabs = filtered;
      }

      // Prefer strict match when user specifies a concrete path/query.
      // Only fall back to host-level activation when the target is site root.
      const pickBestMatch = (target: string, tabsToPick: chrome.tabs.Tab[]) => {
        let targetUrl: URL | undefined;
        try {
          targetUrl = new URL(target);
        } catch {
          // Not a fully-qualified URL; cannot do structured comparison
          return tabsToPick[0];
        }

        const normalizePath = (p: string) => {
          if (!p) return '/';
          // Ensure leading slash
          const withLeading = p.startsWith('/') ? p : `/${p}`;
          // Remove trailing slash except when root
          return withLeading !== '/' && withLeading.endsWith('/')
            ? withLeading.slice(0, -1)
            : withLeading;
        };

        const hostBase = (h: string) => h.replace(/^www\./, '').toLowerCase();
        const isRootTarget = normalizePath(targetUrl.pathname) === '/' && !targetUrl.search;
        const targetPath = normalizePath(targetUrl.pathname);
        const targetSearch = targetUrl.search || '';
        const targetHostBase = hostBase(targetUrl.host);

        let best: { tab?: chrome.tabs.Tab; score: number } = { score: -1 };

        for (const tab of tabsToPick) {
          const tabUrlStr = tab.url || '';
          let tabUrl: URL | undefined;
          try {
            tabUrl = new URL(tabUrlStr);
          } catch {
            continue;
          }

          const tabHostBase = hostBase(tabUrl.host);
          if (tabHostBase !== targetHostBase) continue;

          const tabPath = normalizePath(tabUrl.pathname);
          const tabSearch = tabUrl.search || '';

          // Scoring:
          // 3 - exact path match and (if target has query) exact query match
          // 2 - exact path match ignoring query (target without query)
          // 1 - same host, any path (only if target is root)
          let score = -1;
          const pathEqual = tabPath === targetPath;
          const searchEqual = tabSearch === targetSearch;

          if (pathEqual && (targetSearch ? searchEqual : true)) {
            score = 3;
          } else if (pathEqual && !targetSearch) {
            score = 2;
          }

          if (score > best.score) {
            best = { tab, score };
            if (score === 3) break; // Cannot do better
          }
        }

        return best.tab;
      };

      const explicitTab = await this.tryGetTab(tabId);
      const existingTab = explicitTab || pickBestMatch(url, candidateTabs);
      if (existingTab?.id !== undefined) {
        console.log(
          `URL already open in Tab ID: ${existingTab.id}, Window ID: ${existingTab.windowId}`,
        );
        // Update URL only when explicit tab specified and url differs
        if (explicitTab && typeof explicitTab.id === 'number') {
          await chrome.tabs.update(explicitTab.id, { url });
        }
        // Optionally bring to foreground based on background flag
        await this.ensureFocus(existingTab, {
          activate: background !== true,
          focusWindow: background !== true,
        });

        console.log(`Activated existing Tab ID: ${existingTab.id}`);
        // Get updated tab information and return it
        const updatedTab = await chrome.tabs.get(existingTab.id);

        // Trigger auto-capture on existing tab activation
        await this.triggerAutoCapture(updatedTab.id!, updatedTab.url);
        await this.rememberWorkTab(updatedTab.id, mcpSessionId);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Activated existing tab',
                tabId: updatedTab.id,
                windowId: updatedTab.windowId,
                url: updatedTab.url,
              }),
            },
          ],
          isError: false,
        };
      }

      // 2. If URL is not already open, decide how to open it based on options
      const openInNewWindow = newWindow || typeof width === 'number' || typeof height === 'number';

      if (openInNewWindow) {
        console.log('Opening URL in a new window.');

        // Create new window
        // scalemaker fork: 강제포커스 정책 OFF 면 항상 background. background 인자가 명시적으로
        // true 인 경우도 동일.
        const allowFocus = background === true ? false : await isForceFocusEnabled();
        const newWindow = await chrome.windows.create({
          url: url,
          width: typeof width === 'number' ? width : DEFAULT_WINDOW_WIDTH,
          height: typeof height === 'number' ? height : DEFAULT_WINDOW_HEIGHT,
          focused: allowFocus,
        });

        if (newWindow && newWindow.id !== undefined) {
          console.log(`URL opened in new Window ID: ${newWindow.id}`);

          // Trigger auto-capture if the new window has a tab
          const firstTab = newWindow.tabs?.[0];
          if (firstTab?.id) {
            await this.triggerAutoCapture(firstTab.id, firstTab.url);
          }
          await this.rememberWorkTab(firstTab?.id, mcpSessionId);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'Opened URL in new window',
                  windowId: newWindow.id,
                  tabs: newWindow.tabs
                    ? newWindow.tabs.map((tab) => ({
                        tabId: tab.id,
                        url: tab.url,
                      }))
                    : [],
                }),
              },
            ],
            isError: false,
          };
        }
      } else {
        // scalemaker fork: 백그라운드 작업 모드면 창 모드에 따라 작업 탭을 만든다.
        // 아래 last-focused-window / fallback-window 경로를 모두 대체한다.
        // null 이면(백그라운드 OFF·열린 창 없음·창 생성 실패) 기존 동작 그대로 진행.
        const workWindow = await this.resolveWorkWindow(background, windowId);
        if (workWindow !== null) {
          const dedicated = workWindow.mode === 'dedicated';
          console.log(
            `Opening URL in ${dedicated ? 'dedicated MCP work window' : 'current user window'}: ${workWindow.id}`,
          );

          // dedicated: 사용자의 창이 아니므로 활성화해도 방해가 없고, 탭이 보이는 상태여야
          //            throttling 없이(rAF 포함) 페이지가 정상 동작한다.
          // current:   사용자가 보던 탭을 절대 뺏지 않도록 반드시 비활성으로 만든다.
          //            (스크린샷·read_page 는 CDP 경로라 보이지 않는 탭에서도 동작한다)
          const mcpTab = await chrome.tabs.create({
            url: url,
            windowId: workWindow.id,
            active: dedicated,
          });
          if (dedicated) {
            // 창 생성 시 함께 만들어진 about:blank 잔재 정리
            await this.closeLeftoverBlankTab(workWindow.id, mcpTab.id);
          }

          if (mcpTab.id) {
            await this.triggerAutoCapture(mcpTab.id, mcpTab.url);
          }
          await this.rememberWorkTab(mcpTab.id, mcpSessionId);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: dedicated
                    ? 'Opened URL in new tab in MCP work window'
                    : 'Opened URL in new background tab in current window',
                  tabId: mcpTab.id,
                  windowId: workWindow.id,
                  url: mcpTab.url,
                }),
              },
            ],
            isError: false,
          };
        }

        console.log('Opening URL in the last active window.');
        // Try to open a new tab in the specified window, otherwise the most recently active window
        let targetWindow: chrome.windows.Window | null = null;
        if (typeof windowId === 'number') {
          targetWindow = await chrome.windows.get(windowId, { populate: false });
        }
        if (!targetWindow) {
          targetWindow = await chrome.windows.getLastFocused({ populate: false });
        }

        if (targetWindow && targetWindow.id !== undefined) {
          console.log(`Found target Window ID: ${targetWindow.id}`);

          const newTab = await chrome.tabs.create({
            url: url,
            windowId: targetWindow.id,
            active: background === true ? false : true,
          });
          if (background !== true) {
            // scalemaker fork: 강제포커스 정책 통과 시에만 OS 윈도우 포커스.
            await focusWindowIfAllowed(targetWindow.id);
          }

          console.log(
            `URL opened in new Tab ID: ${newTab.id} in existing Window ID: ${targetWindow.id}`,
          );

          // Trigger auto-capture on new tab
          if (newTab.id) {
            await this.triggerAutoCapture(newTab.id, newTab.url);
          }
          await this.rememberWorkTab(newTab.id, mcpSessionId);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'Opened URL in new tab in existing window',
                  tabId: newTab.id,
                  windowId: targetWindow.id,
                  url: newTab.url,
                }),
              },
            ],
            isError: false,
          };
        } else {
          // In rare cases, if there's no recently active window (e.g., browser just started with no windows)
          // Fall back to opening in a new window
          console.warn('No last focused window found, falling back to creating a new window.');

          // scalemaker fork: 강제포커스 정책 OFF 면 background 윈도우로 생성.
          const allowFocus = await isForceFocusEnabled();
          const fallbackWindow = await chrome.windows.create({
            url: url,
            width: DEFAULT_WINDOW_WIDTH,
            height: DEFAULT_WINDOW_HEIGHT,
            focused: allowFocus,
          });

          if (fallbackWindow && fallbackWindow.id !== undefined) {
            console.log(`URL opened in fallback new Window ID: ${fallbackWindow.id}`);

            // Trigger auto-capture if fallback window has a tab
            const firstTab = fallbackWindow.tabs?.[0];
            if (firstTab?.id) {
              await this.triggerAutoCapture(firstTab.id, firstTab.url);
            }
            await this.rememberWorkTab(firstTab?.id, mcpSessionId);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    message: 'Opened URL in new window',
                    windowId: fallbackWindow.id,
                    tabs: fallbackWindow.tabs
                      ? fallbackWindow.tabs.map((tab) => ({
                          tabId: tab.id,
                          url: tab.url,
                        }))
                      : [],
                  }),
                },
              ],
              isError: false,
            };
          }
        }
      }

      // If all attempts fail, return a generic error
      return createErrorResponse('Failed to open URL: Unknown error occurred');
    } catch (error) {
      if (chrome.runtime.lastError) {
        console.error(`Chrome API Error: ${chrome.runtime.lastError.message}`, error);
        return createErrorResponse(`Chrome API Error: ${chrome.runtime.lastError.message}`);
      } else {
        console.error('Error in navigate:', error);
        return createErrorResponse(
          `Error navigating to URL: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
export const navigateTool = new NavigateTool();

interface CloseTabsToolParams {
  tabIds?: number[];
  url?: string;
}

/**
 * Tool for closing browser tabs
 */
class CloseTabsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CLOSE_TABS;

  async execute(args: CloseTabsToolParams): Promise<ToolResult> {
    const { tabIds, url } = args;
    let urlPattern = url;
    console.log(`Attempting to close tabs with options:`, args);

    try {
      // If URL is provided, close all tabs matching that URL
      if (urlPattern) {
        console.log(`Searching for tabs with URL: ${url}`);
        try {
          // Build a proper Chrome match pattern from a concrete URL.
          // If caller already provided a match pattern with '*', use as-is.
          if (!urlPattern.includes('*')) {
            // Ignore search/hash; match by origin + pathname prefix.
            // Use URL to normalize; fallback to simple suffixing when parsing fails.
            try {
              const u = new URL(urlPattern);
              const basePath = u.pathname || '/';
              const pathWithWildcard = basePath.endsWith('/') ? `${basePath}*` : `${basePath}/*`;
              urlPattern = `${u.protocol}//${u.host}${pathWithWildcard}`;
            } catch {
              // Not a fully-qualified URL; ensure it ends with wildcard
              urlPattern = urlPattern.endsWith('/') ? `${urlPattern}*` : `${urlPattern}/*`;
            }
          }
        } catch {
          // Best-effort: ensure we have some wildcard
          urlPattern = urlPattern.endsWith('*')
            ? urlPattern
            : urlPattern.endsWith('/')
              ? `${urlPattern}*`
              : `${urlPattern}/*`;
        }

        const tabs = await chrome.tabs.query({ url: urlPattern });

        if (!tabs || tabs.length === 0) {
          console.log(`No tabs found with URL pattern: ${urlPattern}`);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  message: `No tabs found with URL pattern: ${urlPattern}`,
                  closedCount: 0,
                }),
              },
            ],
            isError: false,
          };
        }

        console.log(`Found ${tabs.length} tabs with URL pattern: ${urlPattern}`);
        const tabIdsToClose = tabs
          .map((tab) => tab.id)
          .filter((id): id is number => id !== undefined);

        if (tabIdsToClose.length === 0) {
          return createErrorResponse('Found tabs but could not get their IDs');
        }

        await chrome.tabs.remove(tabIdsToClose);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Closed ${tabIdsToClose.length} tabs with URL: ${url}`,
                closedCount: tabIdsToClose.length,
                closedTabIds: tabIdsToClose,
              }),
            },
          ],
          isError: false,
        };
      }

      // If tabIds are provided, close those tabs
      if (tabIds && tabIds.length > 0) {
        console.log(`Closing tabs with IDs: ${tabIds.join(', ')}`);

        // Verify that all tabIds exist
        const existingTabs = await Promise.all(
          tabIds.map(async (tabId) => {
            try {
              return await chrome.tabs.get(tabId);
            } catch (error) {
              console.warn(`Tab with ID ${tabId} not found`);
              return null;
            }
          }),
        );

        const validTabIds = existingTabs
          .filter((tab): tab is chrome.tabs.Tab => tab !== null)
          .map((tab) => tab.id)
          .filter((id): id is number => id !== undefined);

        if (validTabIds.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  message: 'None of the provided tab IDs exist',
                  closedCount: 0,
                }),
              },
            ],
            isError: false,
          };
        }

        await chrome.tabs.remove(validTabIds);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Closed ${validTabIds.length} tabs`,
                closedCount: validTabIds.length,
                closedTabIds: validTabIds,
                invalidTabIds: tabIds.filter((id) => !validTabIds.includes(id)),
              }),
            },
          ],
          isError: false,
        };
      }

      // scalemaker fork: 인자 없이 호출되면 원래는 사용자의 활성 탭을 닫았다.
      // 백그라운드 작업 모드 ON 이면 사용자 탭 대신 MCP 작업 탭만 닫는다 (없으면 에러).
      // 닫힌 탭이 작업 탭이면 work-tab-manager 의 onRemoved 리스너가 알아서 정리한다.
      if (await isBackgroundModeEnabled()) {
        const workTabId = await getWorkTabId((args as any)._mcpSessionId);
        if (workTabId === null) {
          return createErrorResponse(
            'Background work mode: no MCP work tab to close; pass tabIds explicitly',
          );
        }

        console.log(`No tabIds or URL provided, closing MCP work tab ${workTabId}`);
        await chrome.tabs.remove(workTabId);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Closed MCP work tab',
                closedCount: 1,
                closedTabIds: [workTabId],
              }),
            },
          ],
          isError: false,
        };
      }

      // If no tabIds or URL provided, close the current active tab
      console.log('No tabIds or URL provided, closing active tab');
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!activeTab || !activeTab.id) {
        return createErrorResponse('No active tab found');
      }

      await chrome.tabs.remove(activeTab.id);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: 'Closed active tab',
              closedCount: 1,
              closedTabIds: [activeTab.id],
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in CloseTabsTool.execute:', error);
      return createErrorResponse(
        `Error closing tabs: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const closeTabsTool = new CloseTabsTool();

interface SwitchTabToolParams {
  tabId: number;
  windowId?: number;
}

/**
 * Tool for switching the active tab
 */
class SwitchTabTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SWITCH_TAB;

  async execute(args: SwitchTabToolParams): Promise<ToolResult> {
    const { tabId, windowId } = args;

    console.log(`Attempting to switch to tab ID: ${tabId} in window ID: ${windowId}`);

    try {
      // scalemaker fork: switch_tab 호출이어도 OS 포커스는 정책 게이트 통과 시에만.
      if (windowId !== undefined) {
        await focusWindowIfAllowed(windowId);
      }
      await chrome.tabs.update(tabId, { active: true });

      const updatedTab = await chrome.tabs.get(tabId);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: `Successfully switched to tab ID: ${tabId}`,
              tabId: updatedTab.id,
              windowId: updatedTab.windowId,
              url: updatedTab.url,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      if (chrome.runtime.lastError) {
        console.error(`Chrome API Error: ${chrome.runtime.lastError.message}`, error);
        return createErrorResponse(`Chrome API Error: ${chrome.runtime.lastError.message}`);
      } else {
        console.error('Error in SwitchTabTool.execute:', error);
        return createErrorResponse(
          `Error switching tab: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

export const switchTabTool = new SwitchTabTool();
