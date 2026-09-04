import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import { captureFrameOnAction, isAutoCaptureActive } from './gif-recorder';
import {
  activateTab,
  createTab as createTabGuarded,
  focusWindow as focusWindowIfAllowed,
  isForceFocusEnabled,
} from '@/utils/activation-guard';
import { applyViewportOverride } from '@/utils/viewport-override';
import {
  addOwnedTab,
  pruneOwnedTabs,
  sessionKeyOf,
  getOwnedWorkTabId,
  getWorkTabId,
  setWorkTab,
} from '@/utils/work-tab-manager';
import { isTabBusy, markTabBusy, unmarkTabBusy } from '@/utils/tab-lock';
import { isBackgroundModeEnabled } from '@/utils/background-mode';
import { noWorkTabErrorText } from '@/utils/work-tab-gate';
import {
  applyWorkWindowPlacement,
  createManagedWindow,
  getCurrentUserWindowId,
  getOrCreateMcpWindow,
  getWorkWindowMode,
  isMcpWindow,
  prepareWorkWindowForNewTab,
  protectWorkWindowFocus,
  reapplyWorkWindowPlacementSoon,
  registerWorkWindowTab,
  type WorkWindowMode,
} from '@/utils/mcp-window-manager';
// auto-chrome-mcp fork(A2): navigate 후 로딩 완료 대기
import { waitForPageLoad, watchNavigationStart, type NavigateWaitUntil } from './wait-for';

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
  // auto-chrome-mcp fork: true 면 이 세션의 기존 작업 탭을 재사용하지 않고 새 탭을 만든다.
  newTab?: boolean;
  // auto-chrome-mcp fork(A2): 이동 후 어느 단계까지 기다릴지.
  // 기본 'domcontentloaded' — 이동 직후 read_page/click 이 빈 페이지를 보는 문제를 없앤다.
  waitUntil?: NavigateWaitUntil;
  waitTimeoutMs?: number;
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
   * auto-chrome-mcp fork: navigate 가 확정한 탭을 "MCP 작업 탭"으로 기록.
   * 이후 tabId 미지정 도구 호출이 사용자의 활성 탭 대신 이 탭을 대상으로 한다.
   */
  private async rememberWorkTab(tabId?: number, sessionKey?: string, owned = false): Promise<void> {
    if (typeof tabId !== 'number') return;
    try {
      await setWorkTab(tabId, sessionKey, owned);
    } catch (error) {
      console.warn('[NavigateTool] Failed to record MCP work tab:', error);
    }
    if (!owned) return;
    // auto-chrome-mcp fork: MCP 가 새 탭을 만들었으면 소유 목록에 넣고, 같은 세션이 앞서
    // 만들었던 유휴 탭을 정리한다 — 탭이 쌓이지 않게 하되 실행 중인 탭은 건드리지 않는다.
    try {
      await addOwnedTab(tabId, sessionKey);
      await pruneOwnedTabs(sessionKey, tabId);
    } catch (error) {
      console.warn('[NavigateTool] Idle work-tab cleanup failed:', error);
    }
  }

  /**
   * auto-chrome-mcp fork: MCP 작업 탭을 만들 창을 판정한다.
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
   * auto-chrome-mcp fork(F3): 이미 있는 탭을 대상으로 하는 분기(refresh · back · forward)의
   * 대상 탭을 정한다. 해석 순서는 하나뿐이다:
   *
   *   1. 호출자가 명시한 tabId
   *   2. 이 세션·레인의 MCP 작업 탭
   *   3. (백그라운드 작업 모드가 꺼져 있을 때만) 지정 창의 활성 탭
   *
   * 예전에는 2번이 없어서 `{refresh:true, lane:'a'}` 가 사용자가 보고 있는 탭을
   * 새로고침하고, 그 탭을 그 레인의 작업 탭으로 기록했다. 그 뒤로는 사용자 탭이 계속
   * 조작 대상이 됐다. 모드가 켜져 있고 작업 탭도 없으면 null 을 돌려 호출부가 거절한다.
   */
  private async resolveExistingTargetTab(
    tabId: number | undefined,
    windowId: number | undefined,
    sessionKey: string,
  ): Promise<chrome.tabs.Tab | null> {
    const explicit = await this.tryGetTab(tabId);
    if (explicit) return explicit;

    const workTabId = await getWorkTabId(sessionKey);
    if (workTabId !== null) {
      const workTab = await this.tryGetTab(workTabId);
      if (workTab) return workTab;
    }

    // 모드가 켜져 있으면 사용자 탭으로 흘려보내지 않는다 (fail-closed).
    if (await isBackgroundModeEnabled()) return null;
    return await this.getActiveTabOrThrowInWindow(windowId);
  }

  /**
   * auto-chrome-mcp fork v1.9.0(설계 H.4): 이 작업 탭을 재사용해도 되는가.
   *
   * 'dedicated' 모드에서는 전용 작업 창 안의 탭만 재사용한다. 모드를 바꾸기 전에 사용자 창에
   * 만들어 둔 옛 작업 탭이 남아 있으면, 재사용할 때마다 사용자가 보는 창의 탭이 MCP 에
   * 끌려다니게 된다. 그런 탭은 버리고 전용 창에 새로 만든다.
   */
  private async isWorkTabReusable(tabId: number): Promise<boolean> {
    try {
      const mode = await getWorkWindowMode();
      if (mode !== 'dedicated') return true;
      const tab = await chrome.tabs.get(tabId);
      return await isMcpWindow(tab.windowId);
    } catch {
      return false;
    }
  }

  /**
   * auto-chrome-mcp fork: 전용 작업 창을 만들 때 같이 생긴 about:blank 탭 정리 (best-effort).
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

  /**
   * auto-chrome-mcp fork(A2): 실제 내비게이션(executeNavigate) 뒤에 로딩 완료를 기다린다.
   * 모든 반환 경로(새 탭/기존 탭/새 창/새로고침/뒤로가기)를 한곳에서 처리하기 위해 래핑한다.
   */
  async execute(args: NavigateToolParams): Promise<ToolResult> {
    // 내비게이션 시작 신호는 이동을 걸기 **전에** 잡아 둬야 한다 — 커밋 전에는 이전 문서가
    // 'complete' 로 남아 있어 대기가 즉시 성공으로 끝나 버린다(이전 URL·제목을 그대로 보고).
    const navigation = watchNavigationStart();
    let result: ToolResult;
    try {
      result = await this.executeNavigate(args);
    } catch (error) {
      navigation.stop();
      throw error;
    }
    if (!result || result.isError === true || !Array.isArray(result.content)) {
      navigation.stop();
      return result;
    }

    const waitUntil: NavigateWaitUntil =
      args?.waitUntil === 'none' ||
      args?.waitUntil === 'load' ||
      args?.waitUntil === 'networkidle' ||
      args?.waitUntil === 'domcontentloaded'
        ? args.waitUntil
        : 'domcontentloaded';

    const timeoutMs =
      typeof args?.waitTimeoutMs === 'number' && Number.isFinite(args.waitTimeoutMs)
        ? Math.min(60000, Math.max(0, args.waitTimeoutMs))
        : 15000;

    // 결과 payload 에서 대상 탭을 찾는다 (새 창 경로는 tabs[0]).
    const first = result.content.find(
      (c): c is { type: 'text'; text: string } =>
        !!c &&
        (c as { type?: string }).type === 'text' &&
        typeof (c as { text?: unknown }).text === 'string',
    );
    let payload: any = null;
    try {
      payload = first ? JSON.parse(first.text) : null;
    } catch {
      payload = null;
    }
    const tabId: number | undefined =
      typeof payload?.tabId === 'number'
        ? payload.tabId
        : typeof payload?.tabs?.[0]?.tabId === 'number'
          ? payload.tabs[0].tabId
          : undefined;
    if (typeof tabId !== 'number') {
      navigation.stop();
      return result;
    }

    // v1.9.0(설계 B.1): width/height 는 새 창 크기가 아니라 **작업 탭의 뷰포트**로 적용한다.
    // (API 의미 변경 — docs/TOOLS.md 와 CHANGELOG 에 명시)
    if (typeof args?.width === 'number' || typeof args?.height === 'number') {
      await applyViewportOverride(tabId, args.width, args.height);
    }

    // waitUntil:'none' 이라도 **점유 해제는 해야 한다**. 재사용 경로가 markTabBusy 해 둔 탭이
    // 영원히 busy 로 남아, 이후 호출이 그 탭을 못 쓰고 새 탭만 계속 만들게 된다.
    if (waitUntil === 'none') {
      navigation.stop();
      unmarkTabBusy(tabId);
      return result;
    }

    try {
      // 요청한 URL 이 탭에 반영됐는지도 커밋 신호로 쓴다 (refresh/back/forward 는 판별 불가).
      const targetUrl =
        typeof args?.url === 'string' &&
        args.refresh !== true &&
        args.url !== 'back' &&
        args.url !== 'forward'
          ? args.url
          : undefined;
      const load = await waitForPageLoad(tabId, waitUntil, timeoutMs, {
        navigationStarted: () => navigation.started(tabId),
        targetUrl,
      });
      if (payload && first) {
        payload.load = load;
        // 대기 후의 최종 URL 로 갱신 (리다이렉트 반영)
        try {
          const finalTab = await chrome.tabs.get(tabId);
          if (finalTab.url) payload.url = finalTab.url;
          if (finalTab.title) payload.title = finalTab.title;
        } catch {
          // 탭이 닫혔으면 기존 값 유지
        }
        first.text = JSON.stringify(payload);
      }
    } catch (error) {
      console.warn('[NavigateTool] waitForPageLoad failed:', error);
    } finally {
      navigation.stop();
      // 재사용 경로가 선언한 점유는 "이동 + 로딩 완료" 까지다. 여기서 풀어야
      // 다음 navigate 가 같은 탭을 다시 쓸 수 있다 (마크가 없으면 no-op).
      unmarkTabBusy(tabId);
    }
    return result;
  }

  private async executeNavigate(args: NavigateToolParams): Promise<ToolResult> {
    const {
      newWindow = false,
      width,
      height,
      url,
      refresh = false,
      tabId,
      background,
      windowId,
      newTab: forceNewTab,
    } = args;
    // auto-chrome-mcp fork: 세션 id + lane 으로 만든 작업 탭 버킷 키.
    // lane 을 준 호출은 같은 stdio 세션 안에서도 자기만의 작업 탭을 갖는다 (병렬 에이전트 격리).
    const mcpSessionId = sessionKeyOf(args);

    console.log(
      `Attempting to ${refresh ? 'refresh current tab' : `open URL: ${url}`} with options:`,
      args,
    );

    try {
      // Handle refresh option first
      if (refresh) {
        // auto-chrome-mcp fork(F3): 명시 tabId → 이 레인의 작업 탭 → (모드 OFF 일 때만) 활성 탭
        const targetTab = await this.resolveExistingTargetTab(tabId, windowId, mcpSessionId);
        if (targetTab === null) return createErrorResponse(noWorkTabErrorText(this.name));
        if (!targetTab.id) return createErrorResponse('No target tab found to refresh');
        console.log(`Refreshing tab ${targetTab.id}`);
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
        // auto-chrome-mcp fork(F3): refresh 와 같은 해석 순서를 쓴다.
        const targetTab = await this.resolveExistingTargetTab(tabId, windowId, mcpSessionId);
        if (targetTab === null) return createErrorResponse(noWorkTabErrorText(this.name));
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

      // auto-chrome-mcp fork: 백그라운드 작업 모드에서는 사용자가 열어둔 탭을 재사용하지 않는다
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
        let navigatedExplicitTab = false;
        if (explicitTab && typeof explicitTab.id === 'number') {
          await chrome.tabs.update(explicitTab.id, { url });
          navigatedExplicitTab = explicitTab.url !== url;
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
                message: navigatedExplicitTab ? 'Navigated existing tab' : 'Activated existing tab',
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
      // v1.9.0(설계 B): width/height 만으로는 더 이상 새 창을 만들지 않는다.
      // 뷰포트 크기 요구는 execute() 에서 CDP Emulation.setDeviceMetricsOverride 로 처리한다.
      const openInNewWindow = newWindow === true;

      if (openInNewWindow) {
        console.log('Opening URL in a new window.');

        // Create new window
        // auto-chrome-mcp fork: 강제포커스 정책 OFF 면 항상 background. background 인자가 명시적으로
        // true 인 경우도 동일.
        // v1.9.0(설계 B.2): 창 생성은 전부 mcp-window-manager 를 거친다 — 배치(최소화/화면 밖),
        // 지연 이중 비포커스, 사용자 창 복귀가 한곳에서 적용된다.
        const allowFocus = background === true ? false : await isForceFocusEnabled();
        const createdWindow = await createManagedWindow({
          url,
          width: typeof width === 'number' ? width : DEFAULT_WINDOW_WIDTH,
          height: typeof height === 'number' ? height : DEFAULT_WINDOW_HEIGHT,
          focused: allowFocus,
        });

        if (createdWindow && createdWindow.id !== undefined) {
          console.log(`URL opened in new Window ID: ${createdWindow.id}`);

          // Trigger auto-capture if the new window has a tab
          const firstTab = createdWindow.tabs?.[0];
          if (firstTab?.id) {
            await this.triggerAutoCapture(firstTab.id, firstTab.url);
          }
          await this.rememberWorkTab(firstTab?.id, mcpSessionId, true);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'Opened URL in new window',
                  windowId: createdWindow.id,
                  tabs: createdWindow.tabs
                    ? createdWindow.tabs.map((tab) => ({
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
        // auto-chrome-mcp fork: 탭 재사용 — 이 세션이 이미 가진 MCP 작업 탭이 있으면
        // 새 탭을 만들지 않고 그 탭을 이동시킨다. (Claude in Chrome 처럼 한 탭에서 계속 작업)
        // MCP 가 직접 만든 탭(owned)만 대상이라, 사용자가 chrome_set_work_tab 으로 지정한
        // 자기 탭은 절대 다른 URL 로 끌려가지 않는다. newTab:true 로 끌 수 있다.
        if (forceNewTab !== true && typeof tabId !== 'number' && url) {
          const ownedTabId = await getOwnedWorkTabId(mcpSessionId);
          // v1.9.0(설계 H.4): 'dedicated' 모드인데 옛 작업 탭이 전용 창 밖(사용자 창)에 남아
          // 있으면 재사용하지 않는다 — 재사용하면 모드를 바꾼 뒤에도 MCP 가 사용자 창의 탭을
          // 계속 끌고 다니게 된다. 창 확인은 busy 검사 **전에** 끝내야 한다(아래 주석 참조).
          const windowOk = ownedTabId === null ? false : await this.isWorkTabReusable(ownedTabId);
          // 재사용은 그 탭이 놀고 있을 때만 한다. 이미 다른 호출이 쓰는 중이면 새 탭을 만들어
          // 병렬 작업이 한 탭에서 직렬화되거나 서로의 페이지를 덮어쓰는 것을 막는다.
          // 확인과 점유 선언 사이에 await 를 두면 안 된다 (동시 navigate 2건이 같은 탭을 잡는다).
          const reusable = ownedTabId !== null && windowOk && !isTabBusy(ownedTabId);
          if (reusable && ownedTabId !== null) {
            markTabBusy(ownedTabId);
            let reusedTab: chrome.tabs.Tab;
            try {
              // 활성화 여부는 넘기지 않는다 — activation-guard 가 판정한다.
              await chrome.tabs.update(ownedTabId, { url });
              reusedTab = await chrome.tabs.get(ownedTabId);
            } catch (error) {
              unmarkTabBusy(ownedTabId);
              throw error;
            }
            // 전용 작업 창 안의 탭은 background 인자와 무관하게 활성이어야 렌더링이 멈추지 않는다.
            const inDedicatedWindow = await isMcpWindow(reusedTab.windowId);
            if (background !== true || inDedicatedWindow) {
              await activateTab(ownedTabId, { reason: 'navigate:reuse' });
            }
            if (background !== true) {
              await focusWindowIfAllowed(reusedTab.windowId);
            }
            await this.triggerAutoCapture(ownedTabId, url);
            await this.rememberWorkTab(ownedTabId, mcpSessionId, true);

            console.log(`Reused MCP work tab ${ownedTabId} for ${url}`);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    message: 'Reused MCP work tab',
                    tabId: ownedTabId,
                    windowId: reusedTab.windowId,
                    url,
                    reusedWorkTab: true,
                  }),
                },
              ],
              isError: false,
            };
          }
        }

        // auto-chrome-mcp fork: 백그라운드 작업 모드면 창 모드에 따라 작업 탭을 만든다.
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
          let mcpTab: chrome.tabs.Tab;
          if (dedicated) {
            // 창을 건드리기 전에 포커스 보호부터 예약한다 — 아래에서 창을 잠깐 되돌린다.
            await protectWorkWindowFocus(workWindow.id);
            // 최소화된 창에 만든 새 탭은 한 번도 그려지지 않아 CDP 캡처가 멎는다(실측).
            // 탭을 만들기 전에 창을 되돌려 두고, 만든 뒤 워밍업하고 다시 최소화한다.
            await prepareWorkWindowForNewTab(workWindow.id);
            try {
              mcpTab = await createTabGuarded(
                {
                  url: url,
                  windowId: workWindow.id,
                  active: true,
                },
                { reason: 'navigate:work-window' },
              );
              // 표지 갱신이 먼저다 — 곧 닫는 about:blank 탭만 표지에 남으면 다음 isMcpWindow 가
              // "우리 창이 아니다" 로 판정해 버린다.
              await registerWorkWindowTab(workWindow.id, mcpTab.id);
              // 창 생성 시 함께 만들어진 about:blank 잔재 정리
              await this.closeLeftoverBlankTab(workWindow.id, mcpTab.id);
            } finally {
              // ⚠️ 되돌린 창은 **어떤 경로로든** 다시 치운다. 탭 생성이나 정리에서 예외가 나면
              // 창이 화면에 남아 사용자를 방해한다.
              try {
                await applyWorkWindowPlacement(workWindow.id);
              } catch (error) {
                console.warn('[NavigateTool] 작업 창 배치 재적용 실패:', error);
              }
              reapplyWorkWindowPlacementSoon(workWindow.id);
            }
          } else {
            // current 모드: 사용자가 보던 탭을 절대 뺏지 않도록 반드시 비활성으로 만든다.
            mcpTab = await createTabGuarded(
              {
                url: url,
                windowId: workWindow.id,
                active: false,
              },
              { reason: 'navigate:work-window' },
            );
          }

          if (mcpTab.id) {
            await this.triggerAutoCapture(mcpTab.id, mcpTab.url);
          }
          await this.rememberWorkTab(mcpTab.id, mcpSessionId, true);

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

          // v1.9.0(설계 C): 폴백에서도 새 탭은 항상 비활성이다. 이 경로의 대상 창은 사용자
          // 창이므로 background 인자가 무엇이든 보던 탭을 뺏지 않는다.
          const newTab = await createTabGuarded(
            {
              url: url,
              windowId: targetWindow.id,
              active: false,
            },
            { reason: 'navigate:last-focused-fallback' },
          );
          if (background !== true) {
            // auto-chrome-mcp fork: 강제포커스 정책 통과 시에만 OS 윈도우 포커스.
            await focusWindowIfAllowed(targetWindow.id);
          }

          console.log(
            `URL opened in new Tab ID: ${newTab.id} in existing Window ID: ${targetWindow.id}`,
          );

          // Trigger auto-capture on new tab
          if (newTab.id) {
            await this.triggerAutoCapture(newTab.id, newTab.url);
          }
          await this.rememberWorkTab(newTab.id, mcpSessionId, true);

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

          // auto-chrome-mcp fork: 강제포커스 정책 OFF 면 background 윈도우로 생성.
          // v1.9.0(설계 C): 이 최후 폴백이 background 인자를 아예 안 보던 것을 고쳤다.
          const allowFocus = background === true ? false : await isForceFocusEnabled();
          const fallbackWindow = await createManagedWindow({
            url,
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
            await this.rememberWorkTab(firstTab?.id, mcpSessionId, true);

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

      // auto-chrome-mcp fork: 인자 없이 호출되면 원래는 사용자의 활성 탭을 닫았다.
      // 백그라운드 작업 모드 ON 이면 사용자 탭 대신 MCP 작업 탭만 닫는다 (없으면 에러).
      // 닫힌 탭이 작업 탭이면 work-tab-manager 의 onRemoved 리스너가 알아서 정리한다.
      if (await isBackgroundModeEnabled()) {
        const workTabId = await getWorkTabId(sessionKeyOf(args));
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
      // auto-chrome-mcp fork: switch_tab 호출이어도 OS 포커스는 정책 게이트 통과 시에만.
      if (windowId !== undefined) {
        await focusWindowIfAllowed(windowId);
      }
      // 예외 도구 — 사용자가 탭을 앞으로 가져오라고 명시적으로 요청한 경우다.
      await activateTab(tabId, { force: true, reason: 'chrome_switch_tab' });

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
