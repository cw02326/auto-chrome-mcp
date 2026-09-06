/**
 * context-menus.test.ts
 *
 * 2026-09-06: 컨텍스트 메뉴를 한 모듈이 소유하도록 모은 뒤의 회귀 테스트.
 *
 * 지키려는 것 다섯 가지.
 *   (a) 아이콘 우클릭 메뉴의 id·contexts·순서
 *   (b) 페이지 우클릭 메뉴는 부모 하나 아래에만 있다 (사용자 메뉴를 어지럽히지 않는다)
 *   (c) 녹화 중이면 문구가 "녹화 중지" 로 바뀐다
 *   (d) 클릭은 id 별 처리 함수로 갈라진다
 *   (e) 기동 시 removeAll 이 create 보다 먼저다 (옛 엔진이 남긴 메뉴 청소)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  injectMarkerHelper: vi.fn(async () => undefined),
  toggleEditorInTab: vi.fn(async () => ({})),
  toggleQuickPanelInActiveTab: vi.fn(async () => undefined),
  connectNativeFromUi: vi.fn(async () => ({ success: true, connected: true })),
  forceReconnectRespawn: vi.fn(async () => ({ ok: true, connected: true })),
  getStatus: vi.fn(() => 'idle' as string),
}));

// 배경의 무거운 이웃들은 전부 대역으로 바꾼다. 이 테스트가 보는 것은 메뉴 배선뿐이다.
vi.mock('@/entrypoints/background/element-marker', () => ({
  injectMarkerHelper: mocks.injectMarkerHelper,
  initElementMarkerListeners: vi.fn(),
}));
vi.mock('@/entrypoints/background/web-editor', () => ({
  toggleEditorInTab: mocks.toggleEditorInTab,
  initWebEditorListeners: vi.fn(),
}));
vi.mock('@/entrypoints/background/quick-panel/commands', () => ({
  toggleQuickPanelInActiveTab: mocks.toggleQuickPanelInActiveTab,
  initQuickPanelCommands: vi.fn(),
}));
vi.mock('@/entrypoints/background/native-host', () => ({
  connectNativeFromUi: mocks.connectNativeFromUi,
  forceReconnectRespawn: mocks.forceReconnectRespawn,
}));
vi.mock('@/entrypoints/background/record-replay/recording/session-manager', () => ({
  recordingSession: { getStatus: mocks.getStatus },
}));

import {
  ACTION_CONTEXTS,
  buildContextMenuSpec,
  MENU_IDS,
  MENU_TEXT_KO,
  PAGE_CONTEXTS,
  readContextMenuState,
  type ContextMenuItemSpec,
} from '@/entrypoints/background/context-menus-spec';
import {
  applyContextMenus,
  dispatchContextMenuClick,
} from '@/entrypoints/background/context-menus';

/** 메뉴 호출 순서를 그대로 적어 두는 스텁. */
interface MenuCallLog {
  calls: string[];
  created: chrome.contextMenus.CreateProperties[];
}

let log: MenuCallLog;
let originalContextMenus: unknown;
let originalSidePanel: unknown;

function installContextMenuStub(): void {
  log = { calls: [], created: [] };
  const anyChrome = globalThis.chrome as any;
  originalContextMenus = anyChrome.contextMenus;
  anyChrome.contextMenus = {
    removeAll: vi.fn((cb?: () => void) => {
      log.calls.push('removeAll');
      cb?.();
    }),
    create: vi.fn((props: chrome.contextMenus.CreateProperties, cb?: () => void) => {
      log.calls.push(`create:${props.id}`);
      log.created.push(props);
      cb?.();
    }),
    update: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    onClicked: { addListener: vi.fn(), removeListener: vi.fn() },
  };
}

function installSidePanelStub(): { open: ReturnType<typeof vi.fn> } {
  const anyChrome = globalThis.chrome as any;
  originalSidePanel = anyChrome.sidePanel;
  const open = vi.fn(async () => undefined);
  anyChrome.sidePanel = { open, setOptions: vi.fn(async () => undefined) };
  return { open };
}

beforeEach(() => {
  mocks.getStatus.mockReturnValue('idle');
  installContextMenuStub();
});

afterEach(() => {
  const anyChrome = globalThis.chrome as any;
  anyChrome.contextMenus = originalContextMenus;
  if (originalSidePanel === undefined) delete anyChrome.sidePanel;
  else anyChrome.sidePanel = originalSidePanel;
  originalSidePanel = undefined;
});

/* ------------------------------------------------------------------ *
 * (a) 아이콘 메뉴
 * ------------------------------------------------------------------ */

describe('아이콘 우클릭 메뉴', () => {
  const actionItems = (spec: ContextMenuItemSpec[]) =>
    spec.filter((item) => item.contexts.includes('action'));

  it('id 와 순서가 정해진 대로다', () => {
    const spec = buildContextMenuSpec({ recording: false });
    expect(actionItems(spec).map((item) => item.id)).toEqual([
      MENU_IDS.openSidePanel,
      MENU_IDS.daily,
      MENU_IDS.record,
      MENU_IDS.markers,
      MENU_IDS.separator1,
      MENU_IDS.webEditor,
      MENU_IDS.quickPanel,
      MENU_IDS.separator2,
      MENU_IDS.userscripts,
      MENU_IDS.forceReconnect,
    ]);
  });

  it("contexts 는 'action' 하나뿐이다 (페이지 메뉴로 새지 않는다)", () => {
    const spec = buildContextMenuSpec({ recording: false });
    for (const item of actionItems(spec)) {
      expect(item.contexts).toEqual(ACTION_CONTEXTS);
      expect(item.contexts).not.toContain('all');
      expect(item.contexts).not.toContain('page');
    }
  });

  it('구분선 둘은 type 이 separator 다', () => {
    const spec = buildContextMenuSpec({ recording: false });
    const separators = spec.filter((item) => item.type === 'separator');
    expect(separators.map((item) => item.id)).toEqual([MENU_IDS.separator1, MENU_IDS.separator2]);
  });

  it('문구에 한자가 없다', () => {
    const spec = buildContextMenuSpec({ recording: false });
    for (const item of spec) {
      expect(item.title ?? '').not.toMatch(/[一-鿿]/);
    }
  });
});

/* ------------------------------------------------------------------ *
 * (b) 페이지 메뉴
 * ------------------------------------------------------------------ */

describe('페이지 우클릭 메뉴', () => {
  it('최상위에는 부모 하나만 있고 나머지는 그 아래다', () => {
    const spec = buildContextMenuSpec({ recording: false });
    const pageItems = spec.filter((item) => item.contexts.includes('page'));

    const roots = pageItems.filter((item) => !item.parentId);
    expect(roots.map((item) => item.id)).toEqual([MENU_IDS.pageRoot]);

    const children = pageItems.filter((item) => item.parentId);
    expect(children.map((item) => item.id)).toEqual([
      MENU_IDS.pageMarkElement,
      MENU_IDS.pageWebEditor,
      MENU_IDS.pageRecord,
    ]);
    for (const child of children) {
      expect(child.parentId).toBe(MENU_IDS.pageRoot);
      expect(child.contexts).toEqual(PAGE_CONTEXTS);
    }
  });

  it("페이지 메뉴 자리에 'action' 은 들어 있지 않다", () => {
    expect(PAGE_CONTEXTS).not.toContain('action');
  });

  it('부모는 자식보다 앞에 만들어진다', () => {
    const spec = buildContextMenuSpec({ recording: false });
    const ids = spec.map((item) => item.id);
    expect(ids.indexOf(MENU_IDS.pageRoot)).toBeLessThan(ids.indexOf(MENU_IDS.pageMarkElement));
  });
});

/* ------------------------------------------------------------------ *
 * (c) 녹화 상태
 * ------------------------------------------------------------------ */

describe('녹화 문구', () => {
  const recordTitles = (recording: boolean) => {
    const spec = buildContextMenuSpec({ recording });
    return [MENU_IDS.record, MENU_IDS.pageRecord].map(
      (id) => spec.find((item) => item.id === id)?.title,
    );
  };

  it('녹화가 아니면 시작 문구다', () => {
    expect(recordTitles(false)).toEqual([
      MENU_TEXT_KO.menu_record_start,
      MENU_TEXT_KO.menu_record_start,
    ]);
  });

  it('녹화 중이면 중지 문구다', () => {
    expect(recordTitles(true)).toEqual([
      MENU_TEXT_KO.menu_record_stop,
      MENU_TEXT_KO.menu_record_stop,
    ]);
  });

  it('상태는 녹화 세션에서 읽는다', () => {
    mocks.getStatus.mockReturnValue('recording');
    expect(readContextMenuState()).toEqual({ recording: true });
    mocks.getStatus.mockReturnValue('stopping');
    expect(readContextMenuState()).toEqual({ recording: true });
    mocks.getStatus.mockReturnValue('idle');
    expect(readContextMenuState()).toEqual({ recording: false });
  });
});

/* ------------------------------------------------------------------ *
 * (d) 클릭 디스패치
 * ------------------------------------------------------------------ */

describe('클릭 디스패치', () => {
  const click = (menuItemId: string, tab?: Partial<chrome.tabs.Tab>) =>
    dispatchContextMenuClick(
      { menuItemId } as chrome.contextMenus.OnClickData,
      tab as chrome.tabs.Tab | undefined,
    );

  it('요소 마킹은 injectMarkerHelper 를 부른다', async () => {
    click(MENU_IDS.pageMarkElement, { id: 7, windowId: 1 });
    await Promise.resolve();
    expect(mocks.injectMarkerHelper).toHaveBeenCalledWith(7);
  });

  it('웹 에디터는 toggleEditorInTab 을 부른다', async () => {
    click(MENU_IDS.webEditor, { id: 9, windowId: 1 });
    await Promise.resolve();
    expect(mocks.toggleEditorInTab).toHaveBeenCalledWith(9);
  });

  it('빠른 패널은 퀵 패널 토글을 부른다', () => {
    click(MENU_IDS.quickPanel);
    expect(mocks.toggleQuickPanelInActiveTab).toHaveBeenCalledTimes(1);
  });

  it('유저스크립트는 옵션 페이지를 연다', () => {
    const openOptionsPage = vi.fn();
    (globalThis.chrome as any).runtime.openOptionsPage = openOptionsPage;
    click(MENU_IDS.userscripts);
    expect(openOptionsPage).toHaveBeenCalledTimes(1);
  });

  it('사이드패널 열기는 클릭한 창에서 sidePanel.open 을 부른다', () => {
    const { open } = installSidePanelStub();
    click(MENU_IDS.openSidePanel, { id: 3, windowId: 42 });
    expect(open).toHaveBeenCalledWith({ windowId: 42 });
  });

  it('녹화 항목은 클릭 직전에 상태를 다시 읽어 start/stop 을 정한다', async () => {
    installSidePanelStub();
    const setOptions = (globalThis.chrome as any).sidePanel.setOptions as ReturnType<typeof vi.fn>;

    mocks.getStatus.mockReturnValue('idle');
    click(MENU_IDS.record, { id: 5, windowId: 42 });
    await Promise.resolve();
    await Promise.resolve();
    expect(setOptions.mock.calls[0][0].path).toBe(
      'sidepanel.html?tab=workflows&record=start&tabId=5',
    );

    setOptions.mockClear();
    mocks.getStatus.mockReturnValue('recording');
    click(MENU_IDS.record, { id: 5, windowId: 42 });
    await Promise.resolve();
    await Promise.resolve();
    expect(setOptions.mock.calls[0][0].path).toBe(
      'sidepanel.html?tab=workflows&record=stop&tabId=5',
    );
  });

  it('모르는 id 는 조용히 무시한다', () => {
    expect(() => click('rr_v3_leftover')).not.toThrow();
    expect(mocks.injectMarkerHelper).not.toHaveBeenCalled();
    expect(mocks.toggleEditorInTab).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * (e) 기동 순서
 * ------------------------------------------------------------------ */

describe('메뉴 만들기', () => {
  it('removeAll 이 create 보다 먼저다', async () => {
    await applyContextMenus({ recording: false });

    expect(log.calls[0]).toBe('removeAll');
    expect(log.calls.filter((c) => c === 'removeAll')).toHaveLength(1);
    expect(log.calls.slice(1).every((c) => c.startsWith('create:'))).toBe(true);
  });

  it('명세에 있는 항목을 그대로 만든다', async () => {
    await applyContextMenus({ recording: false });

    const spec = buildContextMenuSpec({ recording: false });
    expect(log.created.map((props) => props.id)).toEqual(spec.map((item) => item.id));
    const parentEntry = log.created.find((props) => props.id === MENU_IDS.pageMarkElement);
    expect(parentEntry?.parentId).toBe(MENU_IDS.pageRoot);
  });
});
