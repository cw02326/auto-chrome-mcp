/**
 * 사이드패널 여는 단축키 (2026-09-05 사이드패널 2단계 E).
 *
 * `wxt.config.ts` 의 `open_workflow_sidepanel` 명령이 눌리면 사이드패널을 연다. 기본 조합은
 * `Ctrl+Shift+Y` 로, 이미 쓰고 있는 `Ctrl+Shift+O`(웹 편집기)·`Ctrl+Shift+U`(퀵 패널)와
 * 겹치지 않는다.
 *
 * `chrome.sidePanel.open` 은 사용자 제스처를 요구한다. 단축키는 제스처로 인정되지만 창
 * 상태에 따라 거절될 수 있어, 거절되면 사이드패널 문서를 일반 탭으로 연다. 아무것도 열리지
 * 않는 것보다 낫다.
 */

interface SidePanelApi {
  setOptions?: (options: { path: string; enabled: boolean }) => Promise<void>;
  open?: (options: { windowId: number }) => Promise<void>;
}

const COMMAND_KEY = 'open_workflow_sidepanel';

/** 단축키가 여는 화면. 흐름 목록이다. */
const PANEL_PATH = 'sidepanel.html?tab=workflows';

export function initSidepanelShortcut(): void {
  if (!chrome.commands?.onCommand) return;

  chrome.commands.onCommand.addListener(async (command) => {
    if (command !== COMMAND_KEY) return;
    const sidePanel = (chrome as unknown as { sidePanel?: SidePanelApi }).sidePanel;

    try {
      if (sidePanel?.setOptions) {
        await sidePanel.setOptions({ path: PANEL_PATH, enabled: true });
      }
      if (sidePanel?.open) {
        const current = await chrome.windows.getCurrent();
        if (typeof current?.id === 'number') {
          await sidePanel.open({ windowId: current.id });
          return;
        }
      }
      throw new Error('sidePanel.open unavailable');
    } catch {
      try {
        await chrome.tabs.create({ url: chrome.runtime.getURL(PANEL_PATH) });
      } catch (e) {
        console.warn('[sidepanel-shortcut] 사이드패널을 열지 못했습니다', e);
      }
    }
  });
}
