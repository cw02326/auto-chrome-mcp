import { ToolExecutor } from '@/common/tool-handler';
import type { ToolResult } from '@/common/tool-handler';
import { TIMEOUTS, ERROR_MESSAGES } from '@/common/constants';
import { activateTab, focusWindow as focusWindowIfAllowed } from '@/utils/activation-guard';
import { effectiveBackgroundModeOf } from '@/utils/background-mode';

const PING_TIMEOUT_MS = 300;

/**
 * auto-chrome-mcp fork: content script 응답 대기 상한.
 *
 * chrome.tabs.sendMessage 는 상대가 sendResponse 를 영영 안 부르면 **영원히 pending** 이다
 * (헬퍼가 비동기 예외로 죽거나, 페이지가 멎었을 때). 그러면 그 도구 호출이 끝나지 않고,
 * 탭 단위 직렬화(tab-lock) 때문에 같은 탭의 이후 호출이 전부 줄줄이 막혔다.
 * 상한을 두어 "탭이 통째로 먹통" 대신 원인이 적힌 실패로 끝나게 한다.
 */
const TAB_MESSAGE_TIMEOUT_MS = 60_000;

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
  protected async sendMessageToTab(
    tabId: number,
    message: any,
    frameId?: number,
    // auto-chrome-mcp fork: 오래 걸리는 게 정상인 호출(사용자 입력 대기 등)은 상한을 늘린다.
    timeoutMs: number = TAB_MESSAGE_TIMEOUT_MS,
  ): Promise<any> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const send =
        typeof frameId === 'number'
          ? chrome.tabs.sendMessage(tabId, message, { frameId })
          : chrome.tabs.sendMessage(tabId, message);

      const response = await Promise.race([
        send,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `Content script in tab ${tabId} did not respond to '${message?.action || 'unknown'}' within ${Math.round(timeoutMs / 1000)}s. ` +
                    'The page may be frozen or the helper failed before replying — reload the tab (chrome_navigate refresh:true) and retry.',
                ),
              ),
            timeoutMs,
          );
        }),
      ]);

      if (response && response.error) {
        // auto-chrome-mcp fork(A3): content script 가 error 와 함께 보낸 진단 정보
        // (elementInfo / obstruction 등)를 Error 에 실어 호출부가 쓸 수 있게 한다.
        // 기존 동작(throw + message)은 그대로다.
        const err = new Error(String(response.error)) as Error & { response?: any };
        err.response = response;
        throw err;
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
    } finally {
      if (timer !== undefined) clearTimeout(timer);
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
   *
   * 2026-09-05 발행 전 검토 2: `contextArgs` 를 주면 **이 호출의 실행 컨텍스트 모드**가
   * 전역 토글보다 먼저다. 예약 실행·흐름 실행처럼 사용자가 보고 있지 않은 실행은 전역
   * 토글이 꺼져 있어도 화면을 가져가면 안 되고, 그 경우 창 포커스도 요청하지 않는다.
   */
  protected async ensureFocus(
    tab: chrome.tabs.Tab,
    options: {
      activate?: boolean;
      focusWindow?: boolean;
      forceActivate?: boolean;
      contextArgs?: unknown;
    } = {},
  ): Promise<void> {
    const forceActivate = options.forceActivate === true;
    // 강제 무간섭 실행이면 사용자 대면 도구(forceActivate)를 뺀 나머지는 화면을 건드리지 않는다.
    const forcedBackground =
      !forceActivate && effectiveBackgroundModeOf(options.contextArgs) === true;
    const activate = options.activate === true && !forcedBackground;
    const focusWindow = options.focusWindow === true && !forcedBackground;
    if (focusWindow) {
      await focusWindowIfAllowed(tab.windowId);
    }
    if (activate && typeof tab.id === 'number') {
      // v1.9.0: 활성화 판정은 utils/activation-guard.ts 한곳에서만 한다.
      await activateTab(tab.id, {
        force: forceActivate,
        reason: `tool:${this.name}`,
        contextArgs: options.contextArgs,
      });
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
