import { ToolExecutor } from '@/common/tool-handler';
import type { ToolResult } from '@/common/tool-handler';
import { TIMEOUTS, ERROR_MESSAGES } from '@/common/constants';
import { focusWindowIfAllowed } from '@/utils/focus-policy';
import { isBackgroundModeEnabled } from '@/utils/background-mode';

const PING_TIMEOUT_MS = 300;

/**
 * Base class for browser tool executors
 */
export abstract class BaseBrowserToolExecutor implements ToolExecutor {
  abstract name: string;
  abstract execute(args: any): Promise<ToolResult>;

  /**
   * Inject content script into tab
   */
  protected async injectContentScript(
    tabId: number,
    files: string[],
    injectImmediately = false,
    world: 'MAIN' | 'ISOLATED' = 'ISOLATED',
    allFrames: boolean = false,
    frameIds?: number[],
  ): Promise<void> {
    console.log(`Injecting ${files.join(', ')} into tab ${tabId}`);

    // check if script is already injected
    try {
      const pingFrameId = frameIds?.[0];
      const response = await Promise.race([
        typeof pingFrameId === 'number'
          ? chrome.tabs.sendMessage(
              tabId,
              { action: `${this.name}_ping` },
              { frameId: pingFrameId },
            )
          : chrome.tabs.sendMessage(tabId, { action: `${this.name}_ping` }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`${this.name} Ping action to tab ${tabId} timed out`)),
            PING_TIMEOUT_MS,
          ),
        ),
      ]);

      if (response && response.status === 'pong') {
        console.log(
          `pong received for action '${this.name}' in tab ${tabId}. Assuming script is active.`,
        );
        return;
      } else {
        console.warn(`Unexpected ping response in tab ${tabId}:`, response);
      }
    } catch (error) {
      console.error(
        `ping content script failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      const target: { tabId: number; allFrames?: boolean; frameIds?: number[] } = { tabId };
      if (frameIds && frameIds.length > 0) {
        target.frameIds = frameIds;
      } else if (allFrames) {
        target.allFrames = true;
      }
      await chrome.scripting.executeScript({
        target,
        files,
        injectImmediately,
        world,
      } as any);
      console.log(`'${files.join(', ')}' injection successful for tab ${tabId}`);
    } catch (injectionError) {
      const errorMessage =
        injectionError instanceof Error ? injectionError.message : String(injectionError);
      console.error(
        `Content script '${files.join(', ')}' injection failed for tab ${tabId}: ${errorMessage}`,
      );
      throw new Error(
        `${ERROR_MESSAGES.TOOL_EXECUTION_FAILED}: Failed to inject content script in tab ${tabId}: ${errorMessage}`,
      );
    }
  }

  /**
   * Send message to tab
   */
  protected async sendMessageToTab(tabId: number, message: any, frameId?: number): Promise<any> {
    try {
      const response =
        typeof frameId === 'number'
          ? await chrome.tabs.sendMessage(tabId, message, { frameId })
          : await chrome.tabs.sendMessage(tabId, message);

      if (response && response.error) {
        throw new Error(String(response.error));
      }

      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(
        `Error sending message to tab ${tabId} for action ${message?.action || 'unknown'}: ${errorMessage}`,
      );

      if (error instanceof Error) {
        throw error;
      }
      throw new Error(errorMessage);
    }
  }

  /**
   * Try to get an existing tab by id. Returns null when not found.
   */
  protected async tryGetTab(tabId?: number): Promise<chrome.tabs.Tab | null> {
    if (typeof tabId !== 'number') return null;
    try {
      return await chrome.tabs.get(tabId);
    } catch {
      return null;
    }
  }

  /**
   * Get the active tab in the current window. Throws when not found.
   */
  protected async getActiveTabOrThrow(): Promise<chrome.tabs.Tab> {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!active || !active.id) throw new Error('Active tab not found');
    return active;
  }

  /**
   * Optionally focus window and/or activate tab. Defaults preserve current behavior
   * when caller sets activate/focus flags explicitly.
   *
   * auto-chrome-mcp fork: 두 동작이 각각 별도 정책 게이트를 통과해야 한다.
   * - focusWindow: popup 의 "강제 포커스" 토글 정책(focus-policy)을 통과한 경우에만 실제로
   *   windows.update({focused:true}) 호출.
   * - activate: popup 의 "백그라운드 작업" 토글이 ON 이면 tabs.update({active:true}) 를 skip
   *   (사용자가 보고 있는 탭을 MCP 도구가 뺏지 않게). 단 forceActivate:true 를 넘기면 게이트를
   *   우회한다 — 사용자 대면 UI 를 띄우는 도구(element-picker 등)는 탭이 앞에 있어야 하므로.
   *   백그라운드 모드가 OFF 면 이전과 동일하게 항상 활성화.
   */
  protected async ensureFocus(
    tab: chrome.tabs.Tab,
    options: { activate?: boolean; focusWindow?: boolean; forceActivate?: boolean } = {},
  ): Promise<void> {
    const activate = options.activate === true;
    const focusWindow = options.focusWindow === true;
    const forceActivate = options.forceActivate === true;
    if (focusWindow) {
      await focusWindowIfAllowed(tab.windowId);
    }
    if (activate && typeof tab.id === 'number') {
      const allowActivate = forceActivate || !(await isBackgroundModeEnabled());
      if (allowActivate) {
        await chrome.tabs.update(tab.id, { active: true });
      }
    }
  }

  /**
   * Get the active tab. When windowId provided, search within that window; otherwise currentWindow.
   */
  protected async getActiveTabInWindow(windowId?: number): Promise<chrome.tabs.Tab | null> {
    if (typeof windowId === 'number') {
      const tabs = await chrome.tabs.query({ active: true, windowId });
      return tabs && tabs[0] ? tabs[0] : null;
    }
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
  }

  /**
   * Same as getActiveTabInWindow, but throws if not found.
   */
  protected async getActiveTabOrThrowInWindow(windowId?: number): Promise<chrome.tabs.Tab> {
    const tab = await this.getActiveTabInWindow(windowId);
    if (!tab || !tab.id) throw new Error('Active tab not found');
    return tab;
  }
}
