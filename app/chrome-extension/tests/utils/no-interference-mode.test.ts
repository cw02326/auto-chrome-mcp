/**
 * auto-chrome-mcp fork v1.9.0 — 무간섭 모드 계약 테스트.
 *
 * 사용자 불만은 하나였다: "MCP 가 새 탭·새 창을 띄우면 실제로 앞에 떠서 내 작업을 방해한다."
 * 설계 문서 docs/plans/2026-09-02-no-interference-mode-design.md 의 단위 테스트 7건을
 * 여기에 박아 둔다. 모듈들이 chrome API 를 import 시점에 만지므로
 * (windows.onRemoved / tabs.onCreated 리스너 등) mock 설치 → vi.resetModules() →
 * 동적 import 순서를 지킨다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface WindowRecord {
  id: number;
  type: string;
  incognito: boolean;
  focused: boolean;
  state?: string;
  left?: number;
  top?: number;
}

interface TabRecord {
  id: number;
  windowId: number;
  url: string;
  active: boolean;
  status: string;
}

interface Harness {
  localStore: Record<string, unknown>;
  sessionStore: Record<string, unknown>;
  windows: WindowRecord[];
  tabs: TabRecord[];
  lastFocusedId: { value: number | null | undefined };
  focusListeners: Array<(windowId: number) => void>;
  windowsCreate: ReturnType<typeof vi.fn>;
  windowsUpdate: ReturnType<typeof vi.fn>;
  windowsGet: ReturnType<typeof vi.fn>;
  tabsCreate: ReturnType<typeof vi.fn>;
  tabsUpdate: ReturnType<typeof vi.fn>;
  debuggerSend: ReturnType<typeof vi.fn>;
}

const USER_WINDOW_ID = 1;
const USER_TAB_ID = 11;

function installChrome(): Harness {
  const localStore: Record<string, unknown> = {};
  const sessionStore: Record<string, unknown> = {};
  const windows: WindowRecord[] = [
    { id: USER_WINDOW_ID, type: 'normal', incognito: false, focused: true },
  ];
  const tabs: TabRecord[] = [
    {
      id: USER_TAB_ID,
      windowId: USER_WINDOW_ID,
      url: 'https://user-page.example/',
      active: true,
      status: 'complete',
    },
  ];
  const lastFocusedId: { value: number | null | undefined } = { value: USER_WINDOW_ID };
  const focusListeners: Array<(windowId: number) => void> = [];
  let nextWindowId = 100;
  let nextTabId = 500;

  const toKeys = (keys: unknown): string[] =>
    Array.isArray(keys) ? (keys as string[]) : typeof keys === 'string' ? [keys] : [];

  const makeArea = (store: Record<string, unknown>) => ({
    get: vi.fn(async (keys: unknown) => {
      const out: Record<string, unknown> = {};
      for (const key of toKeys(keys)) if (key in store) out[key] = store[key];
      return out;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(store, items);
    }),
    remove: vi.fn(async (keys: unknown) => {
      for (const key of toKeys(keys)) delete store[key];
    }),
  });

  const windowsCreate = vi.fn(async (createData: Record<string, unknown>) => {
    const id = nextWindowId++;
    const win: WindowRecord = {
      id,
      type: 'normal',
      incognito: false,
      focused: createData.focused === true,
      state: createData.state as string | undefined,
      left: createData.left as number | undefined,
      top: createData.top as number | undefined,
    };
    windows.push(win);
    const tab: TabRecord = {
      id: nextTabId++,
      windowId: id,
      url: (createData.url as string) ?? 'about:blank',
      active: true,
      status: 'complete',
    };
    tabs.push(tab);
    return { ...win, tabs: [{ id: tab.id, url: tab.url }] };
  });

  const windowsUpdate = vi.fn(async (windowId: number, info: Record<string, unknown>) => {
    const win = windows.find((w) => w.id === windowId);
    if (!win) throw new Error(`no window ${windowId}`);
    if (typeof info.focused === 'boolean') win.focused = info.focused;
    if (typeof info.state === 'string') win.state = info.state as string;
    if (typeof info.left === 'number') win.left = info.left;
    if (typeof info.top === 'number') win.top = info.top;
    return win;
  });

  const windowsGet = vi.fn(async (windowId: number, info?: { populate?: boolean }) => {
    const win = windows.find((w) => w.id === windowId);
    if (!win) throw new Error(`no window ${windowId}`);
    // isMcpWindow 의 표지 대조가 populate 로 탭 목록을 본다.
    if (info?.populate) return { ...win, tabs: tabs.filter((t) => t.windowId === windowId) };
    return win;
  });

  const tabsCreate = vi.fn(async (props: Record<string, unknown>) => {
    const tab: TabRecord = {
      id: nextTabId++,
      windowId: (props.windowId as number) ?? USER_WINDOW_ID,
      url: (props.url as string) ?? 'about:blank',
      active: props.active === true,
      status: 'complete',
    };
    tabs.push(tab);
    return tab;
  });

  const tabsUpdate = vi.fn(async (tabId: number, props: Record<string, unknown>) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) throw new Error(`no tab ${tabId}`);
    if (typeof props.url === 'string') tab.url = props.url;
    if (typeof props.active === 'boolean') tab.active = props.active;
    return tab;
  });

  const debuggerSend = vi.fn(async () => ({}));

  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { id: 'test-extension-id', lastError: undefined },
    storage: { local: makeArea(localStore), session: makeArea(sessionStore) },
    tabs: {
      query: vi.fn(async (query: Record<string, unknown>) => {
        // url 필터가 붙은 조회(navigate 의 "이미 열린 탭" 탐색)는 항상 빈 결과 —
        // 새 탭 생성 경로를 타게 한다.
        if (query && 'url' in query) return [];
        let out = tabs.slice();
        if (query?.active === true) out = out.filter((t) => t.active);
        if (typeof query?.windowId === 'number') {
          out = out.filter((t) => t.windowId === query.windowId);
        }
        return out;
      }),
      get: vi.fn(async (tabId: number) => {
        const tab = tabs.find((t) => t.id === tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}`);
        return tab;
      }),
      create: tabsCreate,
      update: tabsUpdate,
      remove: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => {
        throw new Error('no content script in test');
      }),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    windows: {
      get: windowsGet,
      getAll: vi.fn(async () => windows.slice()),
      getLastFocused: vi.fn(async () => {
        if (lastFocusedId.value === null || lastFocusedId.value === undefined) {
          return undefined as unknown as WindowRecord;
        }
        return windows.find((w) => w.id === lastFocusedId.value);
      }),
      create: windowsCreate,
      update: windowsUpdate,
      remove: vi.fn(async () => undefined),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onFocusChanged: {
        addListener: vi.fn((fn: (windowId: number) => void) => focusListeners.push(fn)),
        removeListener: vi.fn((fn: (windowId: number) => void) => {
          const i = focusListeners.indexOf(fn);
          if (i >= 0) focusListeners.splice(i, 1);
        }),
      },
      WINDOW_ID_NONE: -1,
    },
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
      setTitle: vi.fn(async () => undefined),
    },
    debugger: {
      getTargets: vi.fn(async () => []),
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      sendCommand: debuggerSend,
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
      onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    webNavigation: {
      onCommitted: { addListener: vi.fn(), removeListener: vi.fn() },
      onDOMContentLoaded: { addListener: vi.fn(), removeListener: vi.fn() },
      onCompleted: { addListener: vi.fn(), removeListener: vi.fn() },
      onCreatedNavigationTarget: { addListener: vi.fn(), removeListener: vi.fn() },
      onErrorOccurred: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    downloads: { onCreated: { addListener: vi.fn(), removeListener: vi.fn() } },
    scripting: {
      executeScript: vi.fn(async () => {
        throw new Error('no scripting in test');
      }),
    },
  };

  return {
    localStore,
    sessionStore,
    windows,
    tabs,
    lastFocusedId,
    focusListeners,
    windowsCreate,
    windowsUpdate,
    windowsGet,
    tabsCreate,
    tabsUpdate,
    debuggerSend,
  };
}

async function loadWindowManager() {
  vi.resetModules();
  return await import('@/utils/mcp-window-manager');
}

async function loadFocusGuard() {
  vi.resetModules();
  return await import('@/utils/window-focus-guard');
}

async function loadNavigateTool() {
  vi.resetModules();
  return await import('@/entrypoints/background/tools/browser/common');
}

let h: Harness;

beforeEach(() => {
  h = installChrome();
});

afterEach(() => {
  vi.useRealTimers();
});

// ===========================================================================
// 1. 전용 창 생성 — focused:false + 배치 설정
// ===========================================================================
describe('1. 전용 작업 창 생성 (설계 A.1)', () => {
  it('전용 작업 창은 절대 포커스를 주지 않고, 최소화는 작업 탭이 생긴 뒤로 미룬다', async () => {
    const mod = await loadWindowManager();
    const id = await mod.getOrCreateMcpWindow();

    expect(id).not.toBeNull();
    expect(h.windowsCreate).toHaveBeenCalledTimes(1);
    const arg = h.windowsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.focused).toBe(false);
    // create 인자의 state 는 크롬이 무시한다(실측) — 배치는 나중에 update 로 건다.
    expect(arg.state).toBeUndefined();
    // ⚠️ 여기서 바로 최소화하면 안 된다. 한 번도 그려지지 않은 창을 최소화하면 그 창의
    // CDP 캡처가 영영 돌아오지 않는다(2026-09-02 실측). 작업 탭이 생긴 뒤 호출부가 건다.
    expect(h.windowsUpdate).not.toHaveBeenCalledWith(id, { state: 'minimized' });
  });

  it('작업 탭이 생긴 뒤 applyWorkWindowPlacement 가 프레임을 뽑고 최소화한다', async () => {
    const mod = await loadWindowManager();
    const id = await mod.getOrCreateMcpWindow();
    await mod.applyWorkWindowPlacement(id!);

    // 워밍업(프레임 강제)이 먼저, 그 다음 최소화.
    const captureCalls = h.debuggerSend.mock.calls.filter((c) => c[1] === 'Page.captureScreenshot');
    expect(captureCalls.length).toBeGreaterThanOrEqual(1);
    expect(h.windowsUpdate).toHaveBeenCalledWith(id, { state: 'minimized' });
  });

  it('워밍업이 실패하면 창을 앞으로 꺼내 한 번 더 시도한다', async () => {
    const mod = await loadWindowManager();
    const id = await mod.getOrCreateMcpWindow();
    let calls = 0;
    h.debuggerSend.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('no frames'); // 가려진 창 — 프레임이 안 나온다
      return {};
    });
    await mod.applyWorkWindowPlacement(id!);
    // 딱 한 번 앞으로 꺼냈고,
    expect(h.windowsUpdate).toHaveBeenCalledWith(id, { focused: true });
    // 그 뒤 워밍업이 되어 최소화까지 갔다.
    expect(h.windowsUpdate).toHaveBeenCalledWith(id, { state: 'minimized' });
  });

  it('두 번째 워밍업도 실패하면 최소화하지 않는다 (캡처가 멎는 것보다 낫다)', async () => {
    const mod = await loadWindowManager();
    const id = await mod.getOrCreateMcpWindow();
    h.debuggerSend.mockImplementation(async () => {
      throw new Error('no frames');
    });
    await mod.applyWorkWindowPlacement(id!);
    expect(h.windowsUpdate).not.toHaveBeenCalledWith(id, { state: 'minimized' });
  });

  it("'offscreen' 배치는 화면 밖 좌표로 민다", async () => {
    h.localStore.mcpWorkWindowPlacement = 'offscreen';
    const mod = await loadWindowManager();
    const id = await mod.getOrCreateMcpWindow();
    await mod.applyWorkWindowPlacement(id!);

    expect(h.windowsUpdate).toHaveBeenCalledWith(
      id,
      expect.objectContaining({ left: expect.any(Number), top: expect.any(Number) }),
    );
  });

  it('크롬이 화면 밖 좌표를 거부하면 최소화로 대체한다 (실측 2026-09-02)', async () => {
    h.localStore.mcpWorkWindowPlacement = 'offscreen';
    const mod = await loadWindowManager();
    const id = await mod.getOrCreateMcpWindow();
    h.windowsUpdate.mockImplementationOnce(async () => {
      throw new Error(
        'Invalid value for bounds. Bounds must be at least 50% within visible screen space.',
      );
    });
    await mod.applyWorkWindowPlacement(id!);
    expect(h.windowsUpdate).toHaveBeenCalledWith(id, { state: 'minimized' });
  });

  it("'visible' 배치는 최소화도 좌표 이동도 하지 않는다 (디버깅용)", async () => {
    h.localStore.mcpWorkWindowPlacement = 'visible';
    const mod = await loadWindowManager();
    const id = await mod.getOrCreateMcpWindow();
    await mod.applyWorkWindowPlacement(id!);

    const arg = h.windowsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.focused).toBe(false);
    expect(arg.left).toBeUndefined();
    expect(h.windowsUpdate).not.toHaveBeenCalledWith(id, { state: 'minimized' });
  });
});

// ===========================================================================
// 2. 지연 이중 비포커스 + 사용자 창 복귀 (설계 A.2/A.3, I)
// ===========================================================================
describe('2. 지연 비포커스와 사용자 창 복귀 (설계 A.2/A.3, I)', () => {
  it('300ms · 1200ms 에 비포커스를 걸고, 그래도 남아 있으면 사용자 창으로 되돌린다', async () => {
    vi.useFakeTimers();
    const guard = await loadFocusGuard();
    const created = await chrome.windows.create({ focused: true, url: 'about:blank' });
    const createdId = (created as { id: number }).id;
    h.windowsUpdate.mockClear();

    guard.scheduleDeferredUnfocus(createdId, USER_WINDOW_ID);

    await vi.advanceTimersByTimeAsync(350);
    expect(h.windowsUpdate).toHaveBeenCalledWith(createdId, { focused: false });
    expect(h.windowsUpdate).toHaveBeenCalledTimes(1);

    // 창이 스스로 포커스를 다시 잡은 상황을 만든다 — 이래야 복귀 분기가 의미가 있다.
    // 복귀 직전 재검증(getLastFocused)도 같은 상태를 답해야 한다.
    const win = h.windows.find((w) => w.id === createdId)!;
    win.focused = true;
    h.lastFocusedId.value = createdId;

    await vi.advanceTimersByTimeAsync(900);
    expect(h.windowsUpdate).toHaveBeenCalledTimes(2);

    win.focused = true;
    await vi.advanceTimersByTimeAsync(400);

    const restoreCalls = h.windowsUpdate.mock.calls.filter(
      (c) => c[0] === USER_WINDOW_ID && (c[1] as Record<string, unknown>)?.focused === true,
    );
    expect(restoreCalls).toHaveLength(1);
  });

  it('우리 창이 이미 포커스를 놓았으면 복귀하지 않는다', async () => {
    vi.useFakeTimers();
    const guard = await loadFocusGuard();
    const created = await chrome.windows.create({ focused: false, url: 'about:blank' });
    const createdId = (created as { id: number }).id;
    h.windowsUpdate.mockClear();

    guard.scheduleDeferredUnfocus(createdId, USER_WINDOW_ID);
    await vi.advanceTimersByTimeAsync(2000);

    const restoreCalls = h.windowsUpdate.mock.calls.filter(
      (c) => c[0] === USER_WINDOW_ID && (c[1] as Record<string, unknown>)?.focused === true,
    );
    expect(restoreCalls).toHaveLength(0);
  });

  it('그 사이 사용자가 다른 창·다른 앱으로 옮겨갔으면 복귀를 취소한다 (설계 I)', async () => {
    vi.useFakeTimers();
    const guard = await loadFocusGuard();
    const created = await chrome.windows.create({ focused: true, url: 'about:blank' });
    const createdId = (created as { id: number }).id;
    h.windowsUpdate.mockClear();

    guard.scheduleDeferredUnfocus(createdId, USER_WINDOW_ID);

    // WINDOW_ID_NONE = 크롬 밖의 다른 앱으로 포커스가 갔다.
    for (const fn of h.focusListeners) fn(-1);

    const win = h.windows.find((w) => w.id === createdId)!;
    win.focused = true;
    await vi.advanceTimersByTimeAsync(2000);

    const restoreCalls = h.windowsUpdate.mock.calls.filter(
      (c) => c[0] === USER_WINDOW_ID && (c[1] as Record<string, unknown>)?.focused === true,
    );
    expect(restoreCalls).toHaveLength(0);
  });
});

// ===========================================================================
// 2-b. 포커스 감시 시작 시점과 복귀 직전 재검증 (2026-09-02 독립 검토 반영)
// ===========================================================================
describe('2-b. 포커스 감시의 TOCTOU 방어', () => {
  it('창을 만들기 전에 온 WINDOW_ID_NONE 이벤트도 복귀를 취소한다', async () => {
    vi.useFakeTimers();
    const guard = await loadFocusGuard();

    // 감시부터 시작하고 (창은 아직 없다)
    const watch = guard.beginFocusWatch(USER_WINDOW_ID);
    // 창을 만들기 직전에 사용자가 크롬 밖의 다른 앱으로 옮겨갔다.
    for (const fn of h.focusListeners) fn(guard.CHROME_WINDOW_ID_NONE);

    const created = await chrome.windows.create({ focused: true, url: 'about:blank' });
    const createdId = (created as { id: number }).id;
    watch.arm(createdId);
    h.windowsUpdate.mockClear();

    const win = h.windows.find((w) => w.id === createdId)!;
    win.focused = true;
    await vi.advanceTimersByTimeAsync(2000);

    const restoreCalls = h.windowsUpdate.mock.calls.filter(
      (c) => c[0] === USER_WINDOW_ID && (c[1] as Record<string, unknown>)?.focused === true,
    );
    expect(restoreCalls).toHaveLength(0);
  });

  it('복귀 직전 재검증에서 포커스가 우리 창이 아니면 되돌리지 않는다', async () => {
    vi.useFakeTimers();
    const guard = await loadFocusGuard();

    const watch = guard.beginFocusWatch(USER_WINDOW_ID);
    const created = await chrome.windows.create({ focused: true, url: 'about:blank' });
    const createdId = (created as { id: number }).id;
    watch.arm(createdId);
    h.windowsUpdate.mockClear();

    // windows.get 은 아직 우리 창이 포커스라고 답하지만,
    const win = h.windows.find((w) => w.id === createdId)!;
    win.focused = true;
    // 재검증(getLastFocused)은 이미 사용자 창으로 넘어갔다고 답한다.
    h.lastFocusedId.value = USER_WINDOW_ID;

    await vi.advanceTimersByTimeAsync(2000);

    const focusTrueCalls = h.windowsUpdate.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.focused === true,
    );
    expect(focusTrueCalls).toHaveLength(0);
  });

  it('포커스를 쥔 사용자 창이 없으면 복귀 대상을 기록하지 않는다', async () => {
    const mod = await loadWindowManager();
    expect(await mod.getFocusRestoreTargetWindowId()).toBe(USER_WINDOW_ID);

    // 사용자가 크롬 밖(메모장 등)에 있는 상태 — 어떤 크롬 창도 포커스가 없다.
    for (const w of h.windows) w.focused = false;
    expect(await mod.getFocusRestoreTargetWindowId()).toBeNull();
  });
});

// ===========================================================================
// 2-c. 기존 작업 창 재사용 경로의 포커스 보호 (2026-09-02 독립 검토 반영)
// ===========================================================================
describe('2-c. 기존 작업 창 재사용 (설계 A 확장)', () => {
  it('기존 MCP 작업 창에 active 탭을 만들 때도 포커스 보호를 예약한다', async () => {
    const { navigateTool } = await loadNavigateTool();

    await navigateTool.execute({
      url: 'https://example.com/first',
      background: true,
      waitUntil: 'none',
    } as never);
    expect(h.windowsCreate).toHaveBeenCalledTimes(1);
    const workWindowId = (await h.windowsCreate.mock.results[0].value).id as number;

    // 첫 예약의 타이머가 다 지나가길 기다린 뒤 관측을 초기화한다.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const listenersBefore = h.focusListeners.length;
    h.windowsUpdate.mockClear();

    // 같은 창을 재사용하는 두 번째 호출(newTab:true — lane 이 늘어난 상황과 같다)
    await navigateTool.execute({
      url: 'https://example.com/second',
      background: true,
      newTab: true,
      waitUntil: 'none',
    } as never);

    // 창을 새로 만들지 않았는데도
    expect(h.windowsCreate).toHaveBeenCalledTimes(1);
    // 포커스 감시가 새로 걸렸고
    expect(h.focusListeners.length).toBeGreaterThan(listenersBefore);

    // 최소화된 창에 새 탭을 만들기 전에 창을 되돌렸다 —
    // 그러지 않으면 그 탭은 한 번도 그려지지 않아 CDP 캡처가 멎는다(실측).
    expect(h.windowsUpdate).toHaveBeenCalledWith(
      workWindowId,
      expect.objectContaining({ state: 'normal', focused: false, drawAttention: false }),
    );
    // 그리고 다시 최소화했다.
    expect(h.windowsUpdate).toHaveBeenCalledWith(workWindowId, { state: 'minimized' });

    // 지연 비포커스도 예약됐다.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const unfocusCalls = h.windowsUpdate.mock.calls.filter(
      (c) => c[0] === workWindowId && (c[1] as Record<string, unknown>)?.focused === false,
    );
    expect(unfocusCalls.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 2-e. 되돌린 작업 창은 예외가 나도 다시 치운다 (2026-09-02 독립 검토 반영)
// ===========================================================================
describe('2-e. 복원 구간의 예외 안전성', () => {
  it('탭 생성이 실패해도 되돌린 작업 창을 다시 최소화한다', async () => {
    const { navigateTool } = await loadNavigateTool();

    // 1차 navigate 로 전용 작업 창을 만들고 최소화까지 끝낸다.
    await navigateTool.execute({
      url: 'https://example.com/first',
      background: true,
      waitUntil: 'none',
    } as never);
    const workWindowId = (await h.windowsCreate.mock.results[0].value).id as number;
    expect(h.windows.find((w) => w.id === workWindowId)?.state).toBe('minimized');

    h.windowsUpdate.mockClear();
    // 2차 navigate: 창을 normal 로 되돌린 뒤 탭 생성이 터진다.
    h.tabsCreate.mockImplementationOnce(async () => {
      throw new Error('tab creation failed');
    });

    await navigateTool
      .execute({
        url: 'https://example.com/second',
        background: true,
        newTab: true,
        waitUntil: 'none',
      } as never)
      .catch(() => undefined);

    // 되돌렸고,
    expect(h.windowsUpdate).toHaveBeenCalledWith(
      workWindowId,
      expect.objectContaining({ state: 'normal' }),
    );
    // 예외가 났는데도 다시 치웠다 — 창이 화면에 남으면 안 된다.
    expect(h.windowsUpdate).toHaveBeenCalledWith(workWindowId, { state: 'minimized' });
    expect(h.windows.find((w) => w.id === workWindowId)?.state).toBe('minimized');
  });
});

// ===========================================================================
// 2-d. 전용 작업 창 표지 (창 id 재사용 오인 방지, 2026-09-02 독립 검토 반영)
// ===========================================================================
describe('2-d. 작업 창 표지 검증', () => {
  it('표지가 맞으면 true, 창 type 이 달라지면(id 재사용) 기록을 지우고 false', async () => {
    const mod = await loadWindowManager();
    const id = await mod.getOrCreateMcpWindow();
    expect(await mod.isMcpWindow(id)).toBe(true);
    expect(h.sessionStore.mcpWorkWindowId).toBeTruthy();

    // 크롬이 그 창 id 를 다른 창(팝업)에 재사용한 상황.
    h.windows.find((w) => w.id === id)!.type = 'popup';

    // 검증 캐시를 피해 새 모듈 인스턴스로 다시 본다(세션 저장소는 그대로 유지된다).
    const mod2 = await loadWindowManager();
    expect(await mod2.isMcpWindow(id)).toBe(false);
    expect(h.sessionStore.mcpWorkWindowId).toBeUndefined();
  });

  it('우리가 만든 탭이 그 창에 하나도 없으면 기록을 지우고 false', async () => {
    const mod = await loadWindowManager();
    const id = await mod.getOrCreateMcpWindow();

    // 표지에 남은 탭(창 생성 시의 about:blank)이 사라진 상황.
    for (let i = h.tabs.length - 1; i >= 0; i--) {
      if (h.tabs[i].windowId === id) h.tabs.splice(i, 1);
    }
    h.tabs.push({
      id: 9999,
      windowId: id,
      url: 'https://someone-elses.example/',
      active: true,
      status: 'complete',
    });

    const mod2 = await loadWindowManager();
    expect(await mod2.isMcpWindow(id)).toBe(false);
    expect(h.sessionStore.mcpWorkWindowId).toBeUndefined();
  });

  it('표지에 우리 탭 기록이 없으면(빈 tabIds) 신뢰하지 않고 기록을 지운다', async () => {
    const mod = await loadWindowManager();
    const id = await mod.getOrCreateMcpWindow();

    // 표지는 남아 있지만 탭 기록만 비어 있는 상태로 만든다.
    const marker = h.sessionStore.mcpWorkWindowId as Record<string, unknown>;
    h.sessionStore.mcpWorkWindowId = { ...marker, tabIds: [] };

    const mod2 = await loadWindowManager();
    expect(await mod2.isMcpWindow(id)).toBe(false);
    expect(h.sessionStore.mcpWorkWindowId).toBeUndefined();
  });

  it('구버전(숫자만 저장) 표지는 신뢰하지 않고 기록을 지운다', async () => {
    const mod = await loadWindowManager();
    const id = await mod.getOrCreateMcpWindow();

    // v1.8.x 까지의 저장 형식 — 창 id 만 있고 표지가 없다.
    h.sessionStore.mcpWorkWindowId = id as number;

    const mod2 = await loadWindowManager();
    expect(await mod2.isMcpWindow(id)).toBe(false);
    expect(h.sessionStore.mcpWorkWindowId).toBeUndefined();
  });

  it('getOrCreateMcpWindow 의 재사용 경로도 표지를 완전히 검증한다', async () => {
    const mod = await loadWindowManager();
    const first = await mod.getOrCreateMcpWindow();
    expect(h.windowsCreate).toHaveBeenCalledTimes(1);

    // 표지가 어긋난 상태(구버전 형식)로 바꿔 두면 재사용하지 않고 새로 만들어야 한다.
    h.sessionStore.mcpWorkWindowId = first as number;

    const mod2 = await loadWindowManager();
    const second = await mod2.getOrCreateMcpWindow();
    expect(h.windowsCreate).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
  });

  it('registerWorkWindowTab 으로 등록한 탭이 살아 있으면 계속 우리 창이다', async () => {
    const mod = await loadWindowManager();
    const id = await mod.getOrCreateMcpWindow();
    const workTab = await chrome.tabs.create({
      url: 'https://example.com/',
      windowId: id!,
      active: true,
    });
    await mod.registerWorkWindowTab(id!, (workTab as { id: number }).id);

    // 창 생성 시의 about:blank 는 정리됐다고 가정한다.
    const blank = h.tabs.find((t) => t.windowId === id && t.url === 'about:blank');
    if (blank) h.tabs.splice(h.tabs.indexOf(blank), 1);

    const mod2 = await loadWindowManager();
    expect(await mod2.isMcpWindow(id)).toBe(true);
  });
});

// ===========================================================================
// 3. width/height 는 새 창이 아니라 뷰포트 에뮬레이션 (설계 B.1)
// ===========================================================================
describe('3. width/height 는 창을 만들지 않는다 (설계 B.1)', () => {
  it('Emulation.setDeviceMetricsOverride 를 부르고 windows.create 는 부르지 않는다', async () => {
    h.localStore.mcpWorkWindowMode = 'current';
    const { navigateTool } = await loadNavigateTool();

    const result = await navigateTool.execute({
      url: 'https://example.com/page',
      width: 800,
      height: 600,
      background: true,
      waitUntil: 'none',
    } as never);

    expect(result.isError).not.toBe(true);
    expect(h.windowsCreate).not.toHaveBeenCalled();
    // chrome.debugger.sendCommand({tabId}, method, params)
    const metricCalls = h.debuggerSend.mock.calls.filter(
      (c) => c[1] === 'Emulation.setDeviceMetricsOverride',
    );
    expect(metricCalls).toHaveLength(1);
    expect(metricCalls[0][2]).toMatchObject({ width: 800, height: 600 });
  });
});

// ===========================================================================
// 4. newWindow:true 는 관리자 경로로만 (설계 B.2)
// ===========================================================================
describe('4. newWindow:true 는 관리자 경로로만 창을 만든다 (설계 B.2)', () => {
  it('배치·비포커스 규칙이 적용된 창 하나만 만든다', async () => {
    h.localStore.mcpWorkWindowMode = 'current';
    const { navigateTool } = await loadNavigateTool();

    await navigateTool.execute({
      url: 'https://example.com/page',
      newWindow: true,
      background: true,
      waitUntil: 'none',
    } as never);

    expect(h.windowsCreate).toHaveBeenCalledTimes(1);
    const arg = h.windowsCreate.mock.calls[0][0] as Record<string, unknown>;
    // 관리자를 거치지 않은 직접 호출이면 이 조합이 나올 수 없다.
    expect(arg.focused).toBe(false);
    expect(arg.type).toBe('normal');
    const createdId = h.windowsCreate.mock.results[0].value as any;
    const windowId = (await createdId).id as number;
    expect(h.windowsUpdate).toHaveBeenCalledWith(windowId, { state: 'minimized' });
  });
});

// ===========================================================================
// 5. 폴백 두 곳이 활성 탭을 만들지 않는다 (설계 C)
// ===========================================================================
describe('5. navigate 폴백 경로 (설계 C)', () => {
  it('마지막 포커스 창 폴백은 항상 비활성 탭을 만든다', async () => {
    h.localStore.mcpWorkWindowMode = 'current';
    const { navigateTool } = await loadNavigateTool();

    // background:false → resolveWorkWindow 가 null 을 돌려 폴백 경로로 간다.
    await navigateTool.execute({
      url: 'https://example.com/fallback',
      background: false,
      waitUntil: 'none',
    } as never);

    expect(h.tabsCreate).toHaveBeenCalledTimes(1);
    const arg = h.tabsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.active).toBe(false);
    expect(arg.windowId).toBe(USER_WINDOW_ID);
  });

  it('열린 창이 하나도 없을 때의 최후 폴백도 비포커스 창을 만든다', async () => {
    h.localStore.mcpWorkWindowMode = 'current';
    h.windows.length = 0;
    h.lastFocusedId.value = null;
    const { navigateTool } = await loadNavigateTool();

    await navigateTool.execute({
      url: 'https://example.com/last-resort',
      background: false,
      waitUntil: 'none',
    } as never);

    expect(h.windowsCreate).toHaveBeenCalledTimes(1);
    const arg = h.windowsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.focused).toBe(false);
  });
});

// ===========================================================================
// 7. 설정 기본값과 저장값 존중 (설계 J)
// ===========================================================================
describe('7. 배치 설정의 기본값과 저장값 (설계 J)', () => {
  it('저장값이 없으면 기본 배치, 있으면 저장값 그대로', async () => {
    const mod = await loadWindowManager();
    expect(await mod.getWorkWindowPlacement()).toBe(mod.DEFAULT_WORK_WINDOW_PLACEMENT);

    h.localStore.mcpWorkWindowPlacement = 'offscreen';
    expect(await mod.getWorkWindowPlacement()).toBe('offscreen');

    h.localStore.mcpWorkWindowPlacement = 'nonsense';
    expect(await mod.getWorkWindowPlacement()).toBe(mod.DEFAULT_WORK_WINDOW_PLACEMENT);
  });

  it('저장 키 우선순위가 확정대로다: 새 키 > 구버전 키 > 기본값(dedicated)', async () => {
    // 1) 새 키만 있음
    h.localStore.mcpWorkWindowMode = 'current';
    let mod = await loadWindowManager();
    expect(await mod.getWorkWindowMode()).toBe('current');

    // 2) 구버전 키만 있음 (false → current, true → dedicated)
    delete h.localStore.mcpWorkWindowMode;
    h.localStore.dedicatedWorkWindow = false;
    mod = await loadWindowManager();
    expect(await mod.getWorkWindowMode()).toBe('current');
    h.localStore.dedicatedWorkWindow = true;
    expect(await mod.getWorkWindowMode()).toBe('dedicated');

    // 3) 새 키가 구버전 키를 이긴다
    h.localStore.mcpWorkWindowMode = 'current';
    expect(await mod.getWorkWindowMode()).toBe('current');

    // 4) 둘 다 없으면 v1.9.0 기본값
    delete h.localStore.mcpWorkWindowMode;
    delete h.localStore.dedicatedWorkWindow;
    expect(await mod.getWorkWindowMode()).toBe('dedicated');
  });

  it('setter 는 지정된 키에만 쓴다', async () => {
    const mod = await loadWindowManager();
    await mod.setWorkWindowPlacement('visible');
    expect(h.localStore).toEqual({ mcpWorkWindowPlacement: 'visible' });
    expect(mod.WORK_WINDOW_PLACEMENT_STORAGE_KEY).toBe('mcpWorkWindowPlacement');
  });
});

// ===========================================================================
// 활성화 가드 자체의 규칙 (설계 H.1)
// ===========================================================================
describe('활성화 가드 (설계 H.1)', () => {
  async function loadGuard() {
    vi.resetModules();
    return await import('@/utils/activation-guard');
  }

  it('사용자 창의 탭은 활성화하지 않는다', async () => {
    const guard = await loadGuard();
    const activated = await guard.activateTab(USER_TAB_ID, { reason: 'test' });
    expect(activated).toBe(false);
    expect(h.tabsUpdate).not.toHaveBeenCalled();
  });

  it('전용 작업 창 안의 탭은 활성화한다', async () => {
    vi.resetModules();
    const wm = await import('@/utils/mcp-window-manager');
    const guard = await import('@/utils/activation-guard');
    const windowId = await wm.getOrCreateMcpWindow();
    const tab = await chrome.tabs.create({
      url: 'about:blank',
      windowId: windowId!,
      active: false,
    });

    const activated = await guard.activateTab((tab as { id: number }).id, { reason: 'test' });
    expect(activated).toBe(true);
    expect(h.tabsUpdate).toHaveBeenCalledWith((tab as { id: number }).id, { active: true });
  });

  it('예외 도구(force)는 사용자 창에서도 활성화한다', async () => {
    const guard = await loadGuard();
    const activated = await guard.activateTab(USER_TAB_ID, { force: true, reason: 'switch_tab' });
    expect(activated).toBe(true);
    expect(h.tabsUpdate).toHaveBeenCalledWith(USER_TAB_ID, { active: true });
  });

  it('백그라운드 작업 모드를 사용자가 끄면 예전처럼 활성화한다', async () => {
    h.localStore.backgroundWorkMode = false;
    const guard = await loadGuard();
    const activated = await guard.activateTab(USER_TAB_ID, { reason: 'test' });
    expect(activated).toBe(true);
  });

  it('createTab 은 사용자 창 대상 active:true 를 비활성으로 강등한다', async () => {
    const guard = await loadGuard();
    await guard.createTab({ url: 'https://example.com/', active: true }, { reason: 'test' });
    expect(h.tabsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com/', active: false }),
    );
  });

  it('강제 포커스 토글이 꺼져 있으면 windows.update({focused:true}) 를 부르지 않는다', async () => {
    const guard = await loadGuard();
    // 앞선 테스트가 남긴 지연 비포커스 타이머가 끼어들 수 있으므로 focused:true 호출만 센다.
    const focusTrueCalls = () =>
      h.windowsUpdate.mock.calls.filter((c) => (c[1] as Record<string, unknown>)?.focused === true);

    await guard.focusWindow(USER_WINDOW_ID);
    expect(focusTrueCalls()).toHaveLength(0);

    h.localStore.forceFocusOnToolCall = true;
    await guard.focusWindow(USER_WINDOW_ID);
    expect(focusTrueCalls()).toEqual([[USER_WINDOW_ID, { focused: true }]]);
  });
});
