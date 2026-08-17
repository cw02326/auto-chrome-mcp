import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import {
  setWorkTab,
  clearWorkTab,
  getWorkTabId,
  DEFAULT_SESSION_ID,
} from '@/utils/work-tab-manager';

/**
 * scalemaker fork: chrome_set_work_tab — 세션의 "작업 탭"을 화면 전환 없이 변경한다.
 * 팝업/새 창이 열렸을 때(도구 결과의 new_tabs_opened 알림 참고) 그 탭으로 작업
 * 대상을 옮기거나, 원래 탭으로 복귀할 때 사용. chrome_switch_tab 과 달리 탭을
 * 활성화하지 않으므로 백그라운드 작업 모드의 무간섭 원칙을 지킨다.
 */

interface SetWorkTabParams {
  tabId?: number;
  clear?: boolean;
  _mcpSessionId?: string;
}

class SetWorkTabTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SET_WORK_TAB;

  async execute(args: SetWorkTabParams): Promise<ToolResult> {
    const sessionId =
      typeof args._mcpSessionId === 'string' && args._mcpSessionId
        ? args._mcpSessionId
        : DEFAULT_SESSION_ID;

    if (args.clear === true) {
      await clearWorkTab(sessionId);
      return {
        content: [
          { type: 'text', text: JSON.stringify({ success: true, message: 'Work tab cleared' }) },
        ],
        isError: false,
      };
    }

    if (typeof args.tabId !== 'number') {
      const current = await getWorkTabId(sessionId);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: 'Current work tab (pass tabId to change, clear:true to unset)',
              workTabId: current,
            }),
          },
        ],
        isError: false,
      };
    }

    const tab = await this.tryGetTab(args.tabId);
    if (!tab || typeof tab.id !== 'number') {
      return createErrorResponse(`Tab ${args.tabId} not found`);
    }

    await setWorkTab(tab.id, sessionId);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: 'Work tab updated — tabId-less tool calls now target this tab',
            workTabId: tab.id,
            url: tab.url,
            title: tab.title,
            windowId: tab.windowId,
          }),
        },
      ],
      isError: false,
    };
  }
}

export const setWorkTabTool = new SetWorkTabTool();
