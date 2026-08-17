import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import { getAllWorkTabs } from '@/utils/work-tab-manager';
import { isMcpWindow } from '@/utils/mcp-window-manager';
import { getRecentSpawnedTabs } from '@/utils/spawned-tab-tracker';

class WindowTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.GET_WINDOWS_AND_TABS;
  async execute(): Promise<ToolResult> {
    try {
      const windows = await chrome.windows.getAll({ populate: true });
      let tabCount = 0;

      // scalemaker fork: 세션 작업 탭 / 전용 작업 창 / 최근 스폰(팝업) 표시용 컨텍스트
      const workTabs = await getAllWorkTabs(); // sessionId -> tabId
      const workTabSessions = new Map<number, string[]>();
      for (const [sid, tid] of Object.entries(workTabs)) {
        const list = workTabSessions.get(tid) ?? [];
        list.push(sid);
        workTabSessions.set(tid, list);
      }
      const spawnedByTab = new Map(getRecentSpawnedTabs().map((s) => [s.tabId, s]));

      const structuredWindows = await Promise.all(
        windows.map(async (window) => {
          const tabs =
            window.tabs?.map((tab) => {
              tabCount++;
              const entry: Record<string, unknown> = {
                tabId: tab.id || 0,
                url: tab.url || '',
                title: tab.title || '',
                active: tab.active || false,
              };
              const sessions = typeof tab.id === 'number' ? workTabSessions.get(tab.id) : undefined;
              if (sessions && sessions.length > 0) {
                entry.mcpWorkTabSessions = sessions;
              }
              const spawn = typeof tab.id === 'number' ? spawnedByTab.get(tab.id) : undefined;
              if (spawn) {
                entry.recentlySpawned = {
                  openerTabId: spawn.openerTabId,
                  windowType: spawn.windowType,
                  ageMs: Date.now() - spawn.createdAt,
                };
              }
              return entry;
            }) || [];

          const win: Record<string, unknown> = {
            windowId: window.id || 0,
            type: window.type || 'normal',
            tabs: tabs,
          };
          if (typeof window.id === 'number' && (await isMcpWindow(window.id))) {
            win.isMcpWorkWindow = true;
          }
          return win;
        }),
      );

      const result = {
        windowCount: windows.length,
        tabCount: tabCount,
        windows: structuredWindows,
      };

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
      console.error('Error in WindowTool.execute:', error);
      return createErrorResponse(
        `Error getting windows and tabs information: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const windowTool = new WindowTool();
