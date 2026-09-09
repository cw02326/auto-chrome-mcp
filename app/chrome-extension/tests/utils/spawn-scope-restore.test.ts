/**
 * spawn-scope-restore.test.ts
 *
 * 스폰 스코프의 화면 복원은 **생성 직후의 활성화 경합에만** 적용된다 (2026-09-09 검토 C5·D2).
 *
 * 왜 중요한가
 * -----------
 * 페이지가 띄운 탭이 화면을 가져가면 사용자가 하던 일이 끊긴다. 그래서 스코프가 도는 동안은
 * 직전에 보던 탭으로 되돌린다. 그러나 실행이 끝난 뒤에는 이야기가 다르다. 그때 그 탭을
 * 고르는 것은 **사용자의 명시적 선택**이고, 그것까지 되돌리면 무간섭 장치가 오히려 간섭이
 * 된다.
 *
 * 이 파일이 못박는 것:
 *   (a) 스코프가 도는 동안 스폰 탭이 활성화되면 직전 사용자 탭으로 되돌린다.
 *   (b) `endSpawnScope` 뒤에 사용자가 그 탭을 직접 고르면 되돌리지 않는다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SESSION_KEY = 'scheduled::restore-test';
const WINDOW_ID = 1;
const USER_TAB = 10;
const OPENER_TAB = 20;
const SPAWNED_TAB = 30;

const mocks = vi.hoisted(() => ({
  getSessionScopedTabIds: vi.fn(),
  addOwnedTab: vi.fn(),
  getAllWorkTabs: vi.fn(),
}));

vi.mock('@/utils/work-tab-manager', () => ({
  getSessionScopedTabIds: mocks.getSessionScopedTabIds,
  addOwnedTab: mocks.addOwnedTab,
  getAllWorkTabs: mocks.getAllWorkTabs,
}));
vi.mock('@/utils/background-mode', () => ({
  isBackgroundModeEnabled: vi.fn(async () => true),
  EFFECTIVE_BACKGROUND_MODE_ARG: '_effectiveBackgroundMode',
}));
vi.mock('@/utils/window-focus-guard', () => ({
  CHROME_WINDOW_ID_NONE: -1,
  scheduleDeferredUnfocus: vi.fn(),
}));
vi.mock('@/utils/mcp-window-manager', () => ({
  getCurrentUserWindowId: vi.fn(async () => WINDOW_ID),
  isMcpWindow: vi.fn(async () => false),
}));

/** `chrome.tabs.onCreated` 리스너를 잡아 두는 자리. */
let onCreatedListeners: Array<(tab: Record<string, unknown>) => void>;
let tabsUpdate: ReturnType<typeof vi.fn>;

function installChrome(): void {
  onCreatedListeners = [];
  tabsUpdate = vi.fn(async () => ({}));
  const tabs = new Map<number, Record<string, unknown>>([
    [USER_TAB, { id: USER_TAB, windowId: WINDOW_ID, active: false }],
    [OPENER_TAB, { id: OPENER_TAB, windowId: WINDOW_ID, active: false }],
    [SPAWNED_TAB, { id: SPAWNED_TAB, windowId: WINDOW_ID, active: true }],
  ]);
  vi.stubGlobal('chrome', {
    runtime: { id: 'test', lastError: undefined },
    tabs: {
      get: vi.fn(async (id: number) => {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        return tab;
      }),
      update: tabsUpdate,
      onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
      onCreated: {
        addListener: (fn: (tab: Record<string, unknown>) => void) => onCreatedListeners.push(fn),
        removeListener: vi.fn(),
      },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    windows: {
      get: vi.fn(async () => ({ id: WINDOW_ID, type: 'normal' })),
      update: vi.fn(async () => ({})),
      onFocusChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      WINDOW_ID_NONE: -1,
    },
    webNavigation: {
      onCreatedNavigationTarget: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
}

async function loadTracker() {
  vi.resetModules();
  return await import('@/utils/spawned-tab-tracker');
}

describe('스폰 스코프 화면 복원의 유효 기간', () => {
  beforeEach(() => {
    installChrome();
    mocks.getSessionScopedTabIds.mockReset();
    mocks.getSessionScopedTabIds.mockResolvedValue([OPENER_TAB]);
    mocks.addOwnedTab.mockReset();
    mocks.addOwnedTab.mockResolvedValue(undefined);
    mocks.getAllWorkTabs.mockReset();
    mocks.getAllWorkTabs.mockResolvedValue({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('(a) 스코프가 도는 동안 스폰 탭이 화면을 가져가면 직전 탭으로 되돌린다', async () => {
    const tracker = await loadTracker();
    tracker.resetSpawnScopes();
    tracker.beginSpawnScope({ sessionKey: SESSION_KEY, forced: true });

    // 사용자가 보고 있던 탭을 기억시킨다.
    tracker.noteTabActivated(USER_TAB, WINDOW_ID);
    await tracker.settleSpawnAdoptions();

    // 스코프 소유 탭이 새 탭을 띄운다.
    for (const fn of onCreatedListeners) {
      fn({
        id: SPAWNED_TAB,
        openerTabId: OPENER_TAB,
        url: 'https://ads.test/',
        windowId: WINDOW_ID,
      });
    }
    await tracker.settleSpawnAdoptions();

    expect(tabsUpdate).toHaveBeenCalledWith(USER_TAB, { active: true });
  });

  it('(b) 스코프가 끝난 뒤 사용자가 그 탭을 직접 고르면 되돌리지 않는다', async () => {
    const tracker = await loadTracker();
    tracker.resetSpawnScopes();
    tracker.beginSpawnScope({ sessionKey: SESSION_KEY, forced: true });
    tracker.noteTabActivated(USER_TAB, WINDOW_ID);
    await tracker.settleSpawnAdoptions();

    for (const fn of onCreatedListeners) {
      fn({
        id: SPAWNED_TAB,
        openerTabId: OPENER_TAB,
        url: 'https://ads.test/',
        windowId: WINDOW_ID,
      });
    }
    await tracker.settleSpawnAdoptions();
    tabsUpdate.mockClear();

    // 실행이 끝난다.
    tracker.endSpawnScope(SESSION_KEY);

    // 이제 사용자가 그 탭을 **직접** 고른다. 이것은 되돌릴 대상이 아니다.
    tracker.noteTabActivated(SPAWNED_TAB, WINDOW_ID);
    await tracker.settleSpawnAdoptions();

    expect(tabsUpdate).not.toHaveBeenCalled();
  });

  it('(c) 소유 등록을 기다리는 사이에 실행이 끝나면 화면을 건드리지 않는다', async () => {
    const tracker = await loadTracker();
    tracker.resetSpawnScopes();
    tracker.beginSpawnScope({ sessionKey: SESSION_KEY, forced: true });
    tracker.noteTabActivated(USER_TAB, WINDOW_ID);
    await tracker.settleSpawnAdoptions();
    tabsUpdate.mockClear();

    // `addOwnedTab` 이 도는 동안 실행이 끝난다. 예전에는 이 경합에서 뒤늦은 복원이
    // 사용자 화면을 옮겼다 (검토 E3).
    mocks.addOwnedTab.mockImplementation(async () => {
      tracker.endSpawnScope(SESSION_KEY);
    });

    for (const fn of onCreatedListeners) {
      fn({
        id: SPAWNED_TAB,
        openerTabId: OPENER_TAB,
        url: 'https://ads.test/',
        windowId: WINDOW_ID,
      });
    }
    await tracker.settleSpawnAdoptions();

    expect(tabsUpdate).not.toHaveBeenCalled();
  });
});
