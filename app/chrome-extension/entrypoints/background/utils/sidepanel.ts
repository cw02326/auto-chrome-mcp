/**
 * Sidepanel Utilities
 *
 * Shared helpers for opening and managing the Chrome sidepanel from background modules.
 * Used by web-editor, quick-panel, and other modules that need to trigger sidepanel navigation.
 */

/**
 * Best-effort open the sidepanel (default workflows tab).
 *
 * v1.0.36+: agent chat 제거. 함수 이름은 caller (quick-panel, web-editor) 호환을
 * 위해 유지하되, destination 은 default sidepanel (workflows tab) 로 변경.
 * sessionId 등 deep-link param 은 무시.
 *
 * @param tabId - Tab ID to associate with sidepanel
 * @param windowId - Optional window ID for fallback when tab-level open fails
 * @param _sessionId - (legacy, ignored)
 *
 * @remarks
 * This function is intentionally resilient - it will not throw on failures.
 * Sidepanel availability varies across Chrome versions and contexts.
 */
export async function openAgentChatSidepanel(
  tabId: number,
  windowId?: number,
  _sessionId?: string,
): Promise<void> {
  try {
    // v1.0.36: default sidepanel — workflows 가 default tab
    const path = 'sidepanel.html';

    // Configure sidepanel options for this tab

    const sidePanel = chrome.sidePanel as any;

    if (sidePanel?.setOptions) {
      await sidePanel.setOptions({
        tabId,
        path,
        enabled: true,
      });
    }

    // Attempt to open the sidepanel
    if (sidePanel?.open) {
      try {
        await sidePanel.open({ tabId });
      } catch {
        // Fallback to window-level open if tab-level fails
        // This handles cases where the tab is in a special state
        if (typeof windowId === 'number') {
          await sidePanel.open({ windowId });
        }
      }
    }
  } catch {
    // Best-effort: side panel may be unavailable in some Chrome versions/environments
    // Intentionally suppress errors to avoid breaking calling code
  }
}
