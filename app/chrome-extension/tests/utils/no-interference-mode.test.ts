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
  windowRemovedListeners: Array<(windowId: number) => void>;
  windowsCreate: ReturnType<typeof vi.fn>;
  windowsUpdate: ReturnType<typeof vi.fn>;
  windowsGet: ReturnType<typeof vi.fn>;
  tabsCreate: ReturnType<typeof vi.fn>;
  tabsUpdate: ReturnType<typeof vi.fn>;
  tabsReload: ReturnType<typeof vi.fn>;
  tabsGoBack: ReturnType<typeof vi.fn>;
  tabsGoForward: ReturnType<typeof vi.fn>;
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
  const windowRemovedListeners: Array<(windowId: number) => void> = [];
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

  // auto-chrome-mcp fork(F3): refresh / back / forward 경로가 쓰는 API.
  const requireTab = (tabId: number): TabRecord => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) throw new Error(`no tab ${tabId}`);
    return tab;
  };
  const tabsReload = vi.fn(async (tabId: number) => {
    requireTab(tabId);
  });
  const tabsGoBack = vi.fn(async (tabId: number) => {
    requireTab(tabId);
  });
  const tabsGoForward = vi.fn(async (tabId: number) => {
    requireTab(tabId);
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
      reload: tabsReload,
      goBack: tabsGoBack,
      goForward: tabsGoForward,
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
      onRemoved: {
        addListener: vi.fn((fn: (windowId: number) => void) => windowRemovedListeners.push(fn)),
        removeListener: vi.fn(),
      },
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
    windowRemovedListeners,
    windowsCreate,
    windowsUpdate,
    windowsGet,
    tabsCreate,
    tabsUpdate,
    tabsReload,
    tabsGoBack,
    tabsGoForward,
    debuggerSend,
  };
}

/**
 * 가상 시간을 조금씩 흘리며 promise 가 끝나기를 기다린다.
 *
 * 실제 타이머로 고정 시간을 기다리면 느린 CI 에서 흔들린다. 그렇다고 한 번에 크게
 * 흘리면 아직 관측해야 할 예약(지연 비포커스 300ms·1200ms)까지 지나가 버린다.
 * 작은 걸음으로 흘려 promise 가 끝나는 최소 시점에 멈춘다.
 */
async function settleWithFakeTimers<T>(promise: Promise<T>, stepMs = 20, steps = 200): Promise<T> {
  let done = false;
  const watched = promise.then(
    (value) => {
      done = true;
      return value;
    },
    (error) => {
      done = true;
      throw error;
    },
  );
  for (let i = 0; i < steps && !done; i++) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  return await watched;
}

/** fire-and-forget(void withMarkerLock(...)) 이 끝나도록 마이크로태스크를 비운다. */
async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
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
    // 실제 타이머로 400ms 를 기다리면 느린 CI 에서 예약이 아직 안 끝나 흔들린다.
    // 가상 시간으로 흘려 보내 결과를 결정적으로 만든다.
    vi.useFakeTimers();
    const { navigateTool } = await loadNavigateTool();
    h.localStore.mcpWorkWindowMode = 'dedicated'; // 전용 작업 창 경로를 명시적으로 켠다 (기본값은 current)

    await settleWithFakeTimers(
      navigateTool.execute({
        url: 'https://example.com/first',
        background: true,
        waitUntil: 'none',
      } as never),
    );
    expect(h.windowsCreate).toHaveBeenCalledTimes(1);
    const workWindowId = (await h.windowsCreate.mock.results[0].value).id as number;

    // 첫 예약의 타이머(지연 비포커스 300ms·1200ms)가 다 지나간 뒤 관측을 초기화한다.
    await vi.advanceTimersByTimeAsync(2000);
    const listenersBefore = h.focusListeners.length;
    h.windowsUpdate.mockClear();

    // 같은 창을 재사용하는 두 번째 호출(newTab:true — lane 이 늘어난 상황과 같다)
    await settleWithFakeTimers(
      navigateTool.execute({
        url: 'https://example.com/second',
        background: true,
        newTab: true,
        waitUntil: 'none',
      } as never),
    );

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
    await vi.advanceTimersByTimeAsync(2000);
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
    h.localStore.mcpWorkWindowMode = 'dedicated'; // 전용 작업 창 경로를 명시적으로 켠다 (기본값은 current)

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

  it('회귀: 동시 registerWorkWindowTab 이 서로의 탭 기록을 덮어쓰지 않는다 (F4)', async () => {
    // 표지는 read-modify-write 였다 — 두 레인이 동시에 작업 탭을 등록하면 각자 옛 표지를
    // 복제해 마지막 write 만 남고, 살아남지 못한 탭은 표지에서 사라졌다. 표지에 남은 탭이
    // 먼저 닫히면 "우리 창" 증명이 깨져 전용 작업 창을 새로 만들게 된다.
    const mod = await loadWindowManager();
    const id = await mod.getOrCreateMcpWindow();
    const first = (await chrome.tabs.create({
      url: 'https://example.com/lane-a',
      windowId: id!,
      active: false,
    })) as { id: number };
    const second = (await chrome.tabs.create({
      url: 'https://example.com/lane-b',
      windowId: id!,
      active: false,
    })) as { id: number };

    await Promise.all([
      mod.registerWorkWindowTab(id!, first.id),
      mod.registerWorkWindowTab(id!, second.id),
    ]);

    const marker = h.sessionStore.mcpWorkWindowId as { tabIds: number[] };
    expect(marker.tabIds).toContain(first.id);
    expect(marker.tabIds).toContain(second.id);
  });

  it('회귀: 표지 판정 중에 등록된 새 작업 탭을 지우지 않는다 (compare-and-clear)', async () => {
    // 예전에는 판정과 무효화가 따로 놀았다. verifyWorkWindowMarker 가 chrome.windows.get 을
    // 기다리는 사이 다른 레인이 살아 있는 새 작업 탭을 표지에 등록해도, 판정이 끝나면 그
    // 새 표지까지 통째로 지웠다 — 멀쩡한 전용 작업 창을 버리고, 그 사이 isMcpWindow 가
    // false 를 답해 activation-guard 가 작업 창을 사용자 창으로 오인했다.
    const mod = await loadWindowManager();
    const id = (await mod.getOrCreateMcpWindow()) as number;

    // 창 생성 시의 about:blank(표지에 기록된 유일한 탭)가 사라졌다 →
    // 이 시점의 표지만 보면 "우리 탭이 하나도 없는 창" 으로 판정된다.
    for (let i = h.tabs.length - 1; i >= 0; i--) {
      if (h.tabs[i].windowId === id) h.tabs.splice(i, 1);
    }
    // 그 사이 다른 레인이 이 창에 새 작업 탭을 만들었다.
    const fresh = (await chrome.tabs.create({
      url: 'https://example.com/lane-a',
      windowId: id,
      active: false,
    })) as { id: number };

    // 판정이 크롬 API 를 기다리는 동안 registerWorkWindowTab 이 끼어든다.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realGet = h.windowsGet.getMockImplementation() as (
      windowId: number,
      info?: { populate?: boolean },
    ) => Promise<unknown>;
    h.windowsGet.mockImplementationOnce(async (windowId: number, info?: { populate?: boolean }) => {
      await held;
      return await realGet(windowId, info);
    });

    const verifying = mod.isMcpWindow(id);
    await mod.registerWorkWindowTab(id, fresh.id);
    release();
    await verifying;

    const marker = h.sessionStore.mcpWorkWindowId as { tabIds: number[] } | undefined;
    expect(marker, '판정 도중 갱신된 표지를 지우면 안 된다').toBeTruthy();
    expect(marker!.tabIds).toContain(fresh.id);
    // 다음 판정은 새 표지로 통과한다 — 멀쩡한 작업 창을 버리지 않는다.
    expect(await mod.isMcpWindow(id)).toBe(true);
  });

  it('windows.onRemoved 는 그 사이 새로 만들어진 작업 창의 표지를 지우지 않는다', async () => {
    const mod = await loadWindowManager();
    const closed = (await mod.getOrCreateMcpWindow()) as number;
    expect(h.windowRemovedListeners).toHaveLength(1); // import 시점 등록

    // 사용자가 그 창을 닫는 것과 동시에 다른 레인이 새 작업 창을 만든 상황.
    const listener = h.windowRemovedListeners[0];
    h.windows.splice(
      h.windows.findIndex((w) => w.id === closed),
      1,
    );
    listener(closed);
    const recreated = (await mod.getOrCreateMcpWindow()) as number;
    expect(recreated).not.toBe(closed);

    // onRemoved 의 비동기 처리가 늦게 끝나도 새 표지를 지우면 안 된다.
    await flushMicrotasks();
    const marker = h.sessionStore.mcpWorkWindowId as { id: number } | undefined;
    expect(marker, '닫힌 창의 onRemoved 가 새 표지를 지웠다').toBeTruthy();
    expect(marker!.id).toBe(recreated);
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

  it('저장 키 우선순위가 확정대로다: 새 키 > 구버전 키 > 기본값(current)', async () => {
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

    // 4) 둘 다 없으면 기본값 'current' (2026-09-04)
    delete h.localStore.mcpWorkWindowMode;
    delete h.localStore.dedicatedWorkWindow;
    expect(await mod.getWorkWindowMode()).toBe('current');
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

// ===========================================================================
// 8. refresh / back / forward 의 대상 탭 해석 (F3)
// ===========================================================================
describe('8. refresh · history 탐색이 세션 작업 탭을 대상으로 한다 (F3)', () => {
  /**
   * 재현하려는 실패: chrome_navigate 의 refresh / back / forward 분기는 작업 탭을 조회하지
   * 않고 `explicit || 활성 탭` 으로 대상을 골랐다. 그래서 lane 의 작업 탭이 멀쩡히 있어도
   * `{refresh:true, lane:'a'}` 가 사용자가 보고 있는 탭을 새로고침하고, 그 탭을 그 lane 의
   * 작업 탭으로 기록해 버렸다 (그 다음 호출부터 사용자 탭이 계속 조작 대상이 된다).
   *
   * 계약: tabId 명시 → 그 레인의 작업 탭 → (background mode 꺼짐일 때만) 지정 창의 활성 탭.
   */
  const SESSION_ID = 'stdio-f3';

  /** lane 을 준 navigate 로 그 레인의 작업 탭을 만들고 tabId 를 돌려준다. */
  async function openWorkTab(
    navigateTool: { execute: (args: unknown) => Promise<{ content: unknown[] }> },
    lane: string,
  ): Promise<number> {
    const result = await navigateTool.execute({
      url: `https://example.com/${lane}`,
      lane,
      _mcpSessionId: SESSION_ID,
      background: true,
      waitUntil: 'none',
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    return payload.tabId as number;
  }

  const textOf = (result: { content: unknown[] }): string =>
    (result.content[0] as { text: string }).text;

  it('회귀: 작업 탭이 없으면 사용자 탭을 새로고침하지 않고 no_work_tab 을 돌려준다', async () => {
    const { navigateTool } = await loadNavigateTool();

    const result = await navigateTool.execute({
      refresh: true,
      lane: 'a',
      _mcpSessionId: SESSION_ID,
      waitUntil: 'none',
    } as never);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('no_work_tab');
    expect(h.tabsReload).not.toHaveBeenCalled();
  });

  it('회귀: 작업 탭이 있으면 사용자 탭이 아니라 그 작업 탭을 새로고침한다', async () => {
    const { navigateTool } = await loadNavigateTool();
    const workTabId = await openWorkTab(navigateTool as never, 'a');
    expect(workTabId).not.toBe(USER_TAB_ID);

    const result = await navigateTool.execute({
      refresh: true,
      lane: 'a',
      _mcpSessionId: SESSION_ID,
      waitUntil: 'none',
    } as never);

    expect(result.isError).toBe(false);
    expect(h.tabsReload).toHaveBeenCalledTimes(1);
    expect(h.tabsReload).toHaveBeenCalledWith(workTabId);
    expect(h.tabsReload).not.toHaveBeenCalledWith(USER_TAB_ID);
  });

  it('회귀: back / forward 도 사용자 탭이 아니라 레인의 작업 탭에서 움직인다', async () => {
    const { navigateTool } = await loadNavigateTool();
    const workTabId = await openWorkTab(navigateTool as never, 'a');

    await navigateTool.execute({
      url: 'back',
      lane: 'a',
      _mcpSessionId: SESSION_ID,
      background: true,
      waitUntil: 'none',
    } as never);
    await navigateTool.execute({
      url: 'forward',
      lane: 'a',
      _mcpSessionId: SESSION_ID,
      background: true,
      waitUntil: 'none',
    } as never);

    expect(h.tabsGoBack).toHaveBeenCalledWith(workTabId);
    expect(h.tabsGoForward).toHaveBeenCalledWith(workTabId);
    expect(h.tabsGoBack).not.toHaveBeenCalledWith(USER_TAB_ID);
    expect(h.tabsGoForward).not.toHaveBeenCalledWith(USER_TAB_ID);
  });

  it('작업 탭이 없으면 back / forward 도 no_work_tab 으로 거절한다', async () => {
    const { navigateTool } = await loadNavigateTool();

    for (const url of ['back', 'forward']) {
      const result = await navigateTool.execute({
        url,
        lane: 'a',
        _mcpSessionId: SESSION_ID,
        background: true,
        waitUntil: 'none',
      } as never);
      expect(result.isError, url).toBe(true);
      expect(textOf(result), url).toContain('no_work_tab');
    }
    expect(h.tabsGoBack).not.toHaveBeenCalled();
    expect(h.tabsGoForward).not.toHaveBeenCalled();
  });

  it('다른 레인의 작업 탭을 빌려 쓰지 않는다', async () => {
    const { navigateTool } = await loadNavigateTool();
    await openWorkTab(navigateTool as never, 'a');

    const result = await navigateTool.execute({
      refresh: true,
      lane: 'b',
      _mcpSessionId: SESSION_ID,
      waitUntil: 'none',
    } as never);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('no_work_tab');
    expect(h.tabsReload).not.toHaveBeenCalled();
  });

  it('tabId 를 명시하면 작업 탭보다 그 탭이 우선한다', async () => {
    const { navigateTool } = await loadNavigateTool();
    const workTabId = await openWorkTab(navigateTool as never, 'a');

    const result = await navigateTool.execute({
      refresh: true,
      tabId: USER_TAB_ID,
      lane: 'a',
      _mcpSessionId: SESSION_ID,
      waitUntil: 'none',
    } as never);

    expect(result.isError).toBe(false);
    expect(h.tabsReload).toHaveBeenCalledWith(USER_TAB_ID);
    expect(h.tabsReload).not.toHaveBeenCalledWith(workTabId);
  });

  it('모드를 꺼도 그 레인의 작업 탭이 있으면 그 탭이 우선한다 (해석 순서 고정)', async () => {
    // 확정된 해석 순서는 tabId 명시 > 그 레인의 작업 탭 > (모드 OFF 일 때만) 활성 탭이다.
    // 즉 활성 탭 fallback 만 모드에 걸려 있고, 작업 탭 우선은 모드와 무관하다.
    const { navigateTool } = await loadNavigateTool();
    const workTabId = await openWorkTab(navigateTool as never, 'a');
    h.localStore.backgroundWorkMode = false;

    const result = await navigateTool.execute({
      refresh: true,
      lane: 'a',
      _mcpSessionId: SESSION_ID,
      waitUntil: 'none',
    } as never);

    expect(result.isError).toBe(false);
    expect(h.tabsReload).toHaveBeenCalledWith(workTabId);
    expect(h.tabsReload).not.toHaveBeenCalledWith(USER_TAB_ID);
  });

  it('background mode 를 끄면 작업 탭이 없을 때 예전처럼 활성 탭으로 떨어진다', async () => {
    h.localStore.backgroundWorkMode = false;
    const { navigateTool } = await loadNavigateTool();

    const result = await navigateTool.execute({
      refresh: true,
      lane: 'a',
      _mcpSessionId: SESSION_ID,
      waitUntil: 'none',
    } as never);

    expect(result.isError).toBe(false);
    expect(h.tabsReload).toHaveBeenCalledWith(USER_TAB_ID);
  });
});
