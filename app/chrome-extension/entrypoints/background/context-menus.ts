/**
 * 컨텍스트 메뉴 한 곳 모음 (2026-09-06).
 *
 * 예전에는 element-marker, web-editor, record-replay 세 모듈이 각자 `chrome.contextMenus`
 * 에 메뉴를 만들었다. 문제가 셋 있었다.
 *   1. 문구가 중국어였다.
 *   2. `contexts: ['all']` 은 툴바 아이콘 우클릭('action')까지 포함한다. 그래서 아이콘을
 *      오른쪽 클릭하면 중국어 항목 셋이 떴다.
 *   3. `removeAll()` 을 아무도 부르지 않아, 지워진 옛 엔진이 만들어 둔 메뉴가 사용자
 *      크롬에 그대로 남았다.
 *
 * 이제 이 모듈 하나가 소유한다. 기동할 때마다 `removeAll()` 로 싹 비우고 다시 만들며,
 * `onClicked` 도 여기서만 받아 id 로 분기한다. 다른 모듈은 클릭 처리 함수만 내놓는다.
 *
 * 메뉴의 순서·문구 명세는 `context-menus-spec.ts` 에 있다.
 */

import { NATIVE_HOST, STORAGE_KEYS } from '@/common/constants';
import { forceReconnect } from '@/utils/force-reconnect';
import { connectNativeFromUi, forceReconnectRespawn } from './native-host';
import { injectMarkerHelper } from './element-marker';
import { toggleEditorInTab } from './web-editor';
import { toggleQuickPanelInActiveTab } from './quick-panel/commands';
import {
  buildContextMenuSpec,
  menuText,
  MENU_IDS,
  readContextMenuState,
  type ContextMenuItemSpec,
  type ContextMenuState,
} from './context-menus-spec';

const LOG_PREFIX = '[context-menus]';

export {
  buildContextMenuSpec,
  menuText,
  MENU_IDS,
  readContextMenuState,
  syncRecordingMenuTitles,
  ACTION_CONTEXTS,
  PAGE_CONTEXTS,
  MENU_TEXT_KO,
} from './context-menus-spec';
export type { ContextMenuItemSpec, ContextMenuState, MenuContexts } from './context-menus-spec';

/* ------------------------------------------------------------------ *
 * 크롬 메뉴 만들기
 * ------------------------------------------------------------------ */

function hasContextMenus(): boolean {
  return typeof chrome !== 'undefined' && !!(chrome as any).contextMenus?.create;
}

/** 남아 있는 메뉴를 전부 지운다. 지워진 옛 엔진의 잔재(`rr_v3_*`)도 여기서 사라진다. */
function removeAllMenus(): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    try {
      const api = (chrome as any).contextMenus as { removeAll?: (cb?: () => void) => unknown };
      if (typeof api?.removeAll !== 'function') {
        finish();
        return;
      }
      const maybePromise = api.removeAll(finish);
      if (maybePromise && typeof (maybePromise as Promise<void>).then === 'function') {
        (maybePromise as Promise<void>).then(finish, finish);
      }
    } catch (error) {
      console.warn(`${LOG_PREFIX} removeAll 실패(무시):`, error);
      finish();
    }

    // 콜백도 프로미스도 돌아오지 않는 환경에서 멈춰 있지 않게 한 번 더 풀어 준다.
    // removeAll 호출 자체는 이미 끝났으므로 "생성보다 먼저" 라는 순서는 지켜진다.
    setTimeout(finish, 0);
  });
}

/**
 * 메뉴 하나를 만든다.
 *
 * `chrome.contextMenus.create` 는 프로미스를 돌려주지 않는다. 실패는 콜백 안의
 * `chrome.runtime.lastError` 로만 온다. 같은 id 가 이미 있다는 중복 오류는 무시한다.
 */
function createMenu(item: ContextMenuItemSpec): void {
  const props: chrome.contextMenus.CreateProperties = {
    id: item.id,
    contexts: item.contexts,
  };
  if (item.type) props.type = item.type;
  if (item.title) props.title = item.title;
  if (item.parentId) props.parentId = item.parentId;

  try {
    chrome.contextMenus.create(props, () => {
      const lastError = chrome.runtime?.lastError;
      if (lastError) {
        console.warn(`${LOG_PREFIX} 메뉴 생성 실패(무시): ${item.id}`, lastError.message);
      }
    });
  } catch (error) {
    console.warn(`${LOG_PREFIX} 메뉴 생성 예외(무시): ${item.id}`, error);
  }
}

/** 전부 지우고 명세대로 다시 만든다. */
export async function applyContextMenus(state: ContextMenuState): Promise<void> {
  if (!hasContextMenus()) {
    console.warn(`${LOG_PREFIX} contextMenus 를 쓸 수 없어 메뉴를 만들지 않는다`);
    return;
  }
  await removeAllMenus();
  for (const item of buildContextMenuSpec(state)) {
    createMenu(item);
  }
}

/** 지금 상태로 메뉴를 다시 만든다. */
export async function refreshContextMenus(): Promise<void> {
  await applyContextMenus(readContextMenuState());
}

/* ------------------------------------------------------------------ *
 * 사이드패널 열기
 * ------------------------------------------------------------------ */

/**
 * 마지막으로 포커스된 창.
 *
 * 클릭 정보에 탭이 실려 오지 않을 때의 대비다. daily-messages 와 같은 이유로 창 id 를
 * 미리 받아 둔다. 클릭 순간에 `chrome.windows.getLastFocused()` 를 기다리면 그 await
 * 때문에 사용자 제스처가 사라진다.
 */
let lastFocusedWindowId: number | undefined;

function rememberFocusedWindow(windowId: number): void {
  if (typeof windowId === 'number' && windowId >= 0) lastFocusedWindowId = windowId;
}

/** 사이드패널 문서의 주소. `sidepanel.html?tab=...` 꼴이다. */
function panelPath(tab: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams({ tab, ...(extra || {}) });
  return `sidepanel.html?${params.toString()}`;
}

/** 사이드패널의 영구 path 를 맞춘다. 여는 시도 **뒤** 에 부른다. */
async function pointSidePanelAt(path: string): Promise<void> {
  try {
    const sidePanel = (
      chrome as unknown as { sidePanel?: { setOptions?: (o: unknown) => unknown } }
    ).sidePanel;
    if (sidePanel?.setOptions) {
      await sidePanel.setOptions({ path, enabled: true });
    }
  } catch {
    // 사이드패널이 없는 크롬이거나 이미 닫혔다. 탭 경로가 있으므로 조용히 넘어간다.
  }
}

/** 사이드패널 문서를 일반 탭으로 연다 (패널을 못 열었을 때의 길). */
async function openPanelTab(path: string): Promise<void> {
  try {
    // tab-create-ok: 사용자가 메뉴를 눌러 이 화면을 보겠다고 말한 순간이다.
    await chrome.tabs.create({ url: chrome.runtime.getURL(path), active: true });
  } catch (error) {
    console.warn(`${LOG_PREFIX} 사이드패널 화면을 열지 못했습니다:`, error);
  }
}

/**
 * 사이드패널을 연다.
 *
 * `chrome.sidePanel.open()` 은 **동기 호출** 이어야 한다. 앞에 await 이 하나라도 있으면
 * 사용자 제스처가 이미 사라진 뒤라 크롬이 무조건 거절한다. 그래서 열기를 먼저 부르고,
 * 어느 화면을 볼지(`path`)는 그 다음에 맞춘다.
 */
function openPanel(windowId: number | undefined, path: string): void {
  const targetWindowId = typeof windowId === 'number' ? windowId : lastFocusedWindowId;

  let opening: Promise<unknown> | null = null;
  try {
    const sidePanel = (
      chrome as unknown as { sidePanel?: { open?: (o: unknown) => Promise<void> } }
    ).sidePanel;
    if (sidePanel?.open && typeof targetWindowId === 'number') {
      opening = sidePanel.open({ windowId: targetWindowId });
    }
  } catch {
    opening = null;
  }

  if (opening) {
    void Promise.resolve(opening)
      .then(() => pointSidePanelAt(path))
      .catch(() => openPanelTab(path));
  } else {
    void openPanelTab(path);
  }
}

/* ------------------------------------------------------------------ *
 * 클릭 처리
 * ------------------------------------------------------------------ */

async function resolveTabId(tab?: chrome.tabs.Tab): Promise<number | null> {
  if (typeof tab?.id === 'number') return tab.id;
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    return typeof active?.id === 'number' ? active.id : null;
  } catch {
    return null;
  }
}

/** 녹화 시작/중지. 문구가 아니라 **클릭 직전에 다시 읽은** 상태로 판단한다. */
function openRecordPanel(tab?: chrome.tabs.Tab): void {
  const { recording } = readContextMenuState();
  const extra: Record<string, string> = { record: recording ? 'stop' : 'start' };
  if (typeof tab?.id === 'number') extra.tabId = String(tab.id);
  openPanel(tab?.windowId, panelPath('workflows', extra));
}

async function toggleWebEditor(tab?: chrome.tabs.Tab): Promise<void> {
  const tabId = await resolveTabId(tab);
  if (tabId === null) {
    console.warn(`${LOG_PREFIX} 웹 에디터를 켤 탭을 찾지 못했습니다`);
    return;
  }
  await toggleEditorInTab(tabId);
}

async function markElement(tab?: chrome.tabs.Tab): Promise<void> {
  const tabId = await resolveTabId(tab);
  if (tabId === null) {
    console.warn(`${LOG_PREFIX} 요소를 마킹할 탭을 찾지 못했습니다`);
    return;
  }
  await injectMarkerHelper(tabId);
}

function openUserscripts(): void {
  try {
    // 크롬 타입은 void 로 적혀 있지만 MV3 는 프로미스를 돌려준다.
    const opening = chrome.runtime.openOptionsPage() as unknown as Promise<void> | undefined;
    if (opening && typeof opening.catch === 'function') {
      opening.catch((error) => console.warn(`${LOG_PREFIX} 옵션 페이지를 열지 못했습니다:`, error));
    }
  } catch (error) {
    console.warn(`${LOG_PREFIX} 옵션 페이지를 열지 못했습니다:`, error);
  }
}

/** 브리지 포트. 사용자가 바꿔 둔 값이 있으면 그것을 쓴다. */
async function readBridgePort(): Promise<number> {
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEYS.NATIVE_SERVER_PORT]);
    const raw = Number(stored?.[STORAGE_KEYS.NATIVE_SERVER_PORT]);
    if (Number.isInteger(raw) && raw > 0 && raw < 65536) return raw;
  } catch {
    // 저장소를 못 읽으면 기본 포트로 간다.
  }
  return NATIVE_HOST.DEFAULT_PORT;
}

function notify(message: string): void {
  try {
    // 크롬 타입은 콜백형만 적어 두어 void 로 보이지만, MV3 는 프로미스를 돌려준다.
    const creating = chrome.notifications?.create?.(`acm-menu-${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon/128.png'),
      title: menuText('menu_notification_title'),
      message,
      priority: 1,
      requireInteraction: false,
    }) as unknown as Promise<string> | undefined;
    if (creating && typeof creating.catch === 'function') {
      creating.catch(() => undefined);
    }
  } catch (error) {
    console.warn(`${LOG_PREFIX} 알림 실패(무시):`, error);
  }
}

/**
 * 강제 재연결.
 *
 * 팝업의 강제 재연결 버튼과 같은 흐름(`forceReconnect`)을 그대로 돌린다. 다만 배경이
 * 자기 자신에게 보낸 `chrome.runtime.sendMessage` 는 자기 리스너에 도달하지 않으므로,
 * 3단계(spawn)와 5단계(connect)는 배경 함수를 직접 부르도록 꽂아 준다.
 */
async function runForceReconnect(): Promise<void> {
  let ok = false;
  let detail = '?';
  try {
    const port = await readBridgePort();
    const result = await forceReconnect({
      port,
      transport: { respawn: forceReconnectRespawn, connect: connectNativeFromUi },
    });
    ok = result.ok;
    detail = ok ? String(result.finalBridgePid ?? '?') : String(result.failedAt ?? '?');
  } catch (error) {
    ok = false;
    detail = error instanceof Error ? error.message : String(error);
  }

  notify(
    ok
      ? menuText('menu_force_reconnect_ok', [detail])
      : menuText('menu_force_reconnect_fail', [detail]),
  );
}

export type ContextMenuHandler = (
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab,
) => void;

/**
 * id 별 처리.
 *
 * 사이드패널을 여는 항목은 **동기** 로 열어야 해서 전부 값을 돌려주지 않는 함수다.
 * 비동기 작업은 함수 안에서 시작한다.
 */
export const CONTEXT_MENU_HANDLERS: Readonly<Record<string, ContextMenuHandler>> = {
  [MENU_IDS.openSidePanel]: (_info, tab) => openPanel(tab?.windowId, panelPath('workflows')),
  [MENU_IDS.daily]: (_info, tab) => openPanel(tab?.windowId, panelPath('daily')),
  [MENU_IDS.markers]: (_info, tab) => openPanel(tab?.windowId, panelPath('element-markers')),
  [MENU_IDS.record]: (_info, tab) => openRecordPanel(tab),
  [MENU_IDS.pageRecord]: (_info, tab) => openRecordPanel(tab),
  [MENU_IDS.webEditor]: (_info, tab) => void toggleWebEditor(tab),
  [MENU_IDS.pageWebEditor]: (_info, tab) => void toggleWebEditor(tab),
  [MENU_IDS.pageMarkElement]: (_info, tab) => void markElement(tab),
  [MENU_IDS.quickPanel]: () => void toggleQuickPanelInActiveTab(),
  [MENU_IDS.userscripts]: () => openUserscripts(),
  [MENU_IDS.forceReconnect]: () => void runForceReconnect(),
};

/** 클릭 하나를 id 로 갈라 보낸다. */
export function dispatchContextMenuClick(
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab,
): void {
  const id = String(info?.menuItemId ?? '');
  const handler = CONTEXT_MENU_HANDLERS[id];
  if (!handler) return;
  try {
    handler(info, tab);
  } catch (error) {
    console.warn(`${LOG_PREFIX} 메뉴 처리 실패: ${id}`, error);
  }
}

/* ------------------------------------------------------------------ *
 * 등록
 * ------------------------------------------------------------------ */

let listenersRegistered = false;

/**
 * 배경 진입점에서 한 번 부른다.
 *
 * 서비스 워커는 잠들었다 깨어날 때마다 이 파일을 다시 평가한다. 그래서 메뉴 만들기는
 * 매 기동마다 하고(먼저 `removeAll`), 리스너는 중복 등록되지 않게 한 번만 붙인다.
 */
export function initContextMenus(): void {
  void refreshContextMenus();

  if (listenersRegistered) return;
  listenersRegistered = true;

  // 설치·업데이트 직후에도 같은 함수로 다시 맞춘다. 중복 생성 오류는 createMenu 가 삼킨다.
  try {
    chrome.runtime.onInstalled?.addListener?.(() => {
      void refreshContextMenus();
    });
  } catch {
    // onInstalled 가 없는 환경.
  }

  try {
    (chrome as any).contextMenus?.onClicked?.addListener?.(
      (info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => {
        dispatchContextMenuClick(info, tab);
      },
    );
  } catch (error) {
    console.warn(`${LOG_PREFIX} onClicked 등록 실패:`, error);
  }

  try {
    chrome.windows?.onFocusChanged?.addListener?.((windowId: number) => {
      rememberFocusedWindow(windowId);
    });
  } catch {
    // windows API 가 없는 환경.
  }
}
