/**
 * auto-chrome-mcp fork v1.9.0 — 무간섭 모드 범용 회귀 (설계 K).
 *
 * 경로별 단위 테스트는 **지금 있는 경로**만 지킨다. 앞으로 추가될 도구가 다시 사용자 탭을
 * 앞으로 끌어내는 것을 막으려면 "등록된 도구 전부"를 한 번씩 돌려 보는 그물이 필요하다.
 *
 * 2026-09-02 독립 검토 반영 — 이 테스트가 조용히 통과하지 않도록 세 가지를 강화했다.
 *
 *  1. **오류·타임아웃을 성공으로 삼키지 않는다.** 도구가 던진 예외는 "가드 위반 없음"과
 *     별개로 기록하고, 타임아웃은 실패로 처리한다(끝나지 않은 도구의 뒤이은 호출은 관측
 *     대상 밖이라 그물에 구멍이 난다).
 *  2. **각 도구가 실제로 실행 경로에 들어갔는지 센다.** 그 도구 때문에 chrome API 가 한 번도
 *     불리지 않았으면 그 fixture 를 실패로 본다(인자가 틀려 앞단에서 튕긴 것이다).
 *     storage 는 게이트 자신이 항상 쓰므로 세지 않는다.
 *  3. **"전용 작업 창" 판정을 모의객체가 아니라 모듈의 실제 기록으로 한다.**
 *     `windows.create` 결과를 무조건 관리 대상으로 표시하면 어떤 창이든 활성화가 허용돼
 *     그물이 무의미해진다.
 *
 * 도구 인자도 "위험 분기"에 들어가도록 골랐다 — navigate 를 뺀 모든 도구에 사용자 탭 id 와
 * `background:false` 를 준다. 즉 도구들이 **사용자 탭을 활성화하려고 시도하는** 상황을
 * 만들어 놓고, 가드가 그것을 막는지 본다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TOOL_NAMES } from 'auto-chrome-mcp-shared';

const B = TOOL_NAMES.BROWSER;

/** 정의상 사용자 대면 동작이라 게이트에서 제외되는 도구 (tools/index.ts 와 같은 목록) */
const EXEMPT_TOOLS = new Set<string>([
  B.SWITCH_TAB,
  B.REQUEST_ELEMENT_SELECTION,
  B.REQUEST_USER_CONSENT,
]);

/**
 * 하는 일이 chrome.storage 읽고 쓰기뿐이라 "다른 chrome API 호출 0회" 가 정상인 도구.
 * 목록이 늘어나면 그만큼 그물이 성겨지므로 여기에 추가할 때는 근거를 함께 남길 것.
 */
const STORAGE_ONLY_TOOLS = new Set<string>([B.STORAGE]);

const USER_WINDOW_ID = 1;
const USER_TAB_ID = 11;

interface WindowRecord {
  id: number;
  type: string;
  incognito: boolean;
  focused: boolean;
}

interface TabRecord {
  id: number;
  windowId: number;
  url: string;
  title: string;
  active: boolean;
  status: string;
}

interface Sweep {
  windows: WindowRecord[];
  tabs: TabRecord[];
  localStore: Record<string, unknown>;
  /** 활성화 시도 기록: [tabId, windowId] */
  activated: Array<[number, number]>;
  /** 활성 상태로 만들어진 탭: [tabId, windowId] */
  createdActive: Array<[number, number]>;
  /** focused:true 가 나간 창 */
  focused: number[];
  /** storage 를 뺀 chrome API 호출 수 (도구가 실행 경로에 들어갔는지 판정) */
  apiCalls: number;
}

let sweep: Sweep;

function installChrome(): Sweep {
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
      title: 'User page',
      active: true,
      status: 'complete',
    },
  ];
  const state: Sweep = {
    windows,
    tabs,
    localStore,
    activated: [],
    createdActive: [],
    focused: [],
    apiCalls: 0,
  };
  let nextWindowId = 100;
  let nextTabId = 500;

  /** storage 를 뺀 chrome API 호출을 세는 래퍼 */
  const counted = <T extends (...args: never[]) => unknown>(fn: T) =>
    vi.fn(((...args: never[]) => {
      state.apiCalls++;
      return fn(...args);
    }) as T);

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

  const reject = (message: string) =>
    counted(async () => {
      throw new Error(message);
    });

  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: undefined,
      getURL: (p: string) => `chrome-extension://test/${p}`,
    },
    storage: { local: makeArea(localStore), session: makeArea(sessionStore) },
    tabs: {
      query: counted(async (query: Record<string, unknown>) => {
        if (query && 'url' in query) return [];
        let out = tabs.slice();
        if (query?.active === true) out = out.filter((t) => t.active);
        if (typeof query?.windowId === 'number') {
          out = out.filter((t) => t.windowId === query.windowId);
        }
        return out;
      }),
      get: counted(async (tabId: number) => {
        const tab = tabs.find((t) => t.id === tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}`);
        return tab;
      }),
      create: counted(async (props: Record<string, unknown>) => {
        const windowId = (props.windowId as number) ?? USER_WINDOW_ID;
        const tab: TabRecord = {
          id: nextTabId++,
          windowId,
          url: (props.url as string) ?? 'about:blank',
          title: 'created',
          active: props.active === true,
          status: 'complete',
        };
        tabs.push(tab);
        if (tab.active) state.createdActive.push([tab.id, windowId]);
        return tab;
      }),
      update: counted(async (tabId: number, props: Record<string, unknown>) => {
        const tab = tabs.find((t) => t.id === tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}`);
        if (typeof props.url === 'string') tab.url = props.url;
        if (props.active === true) {
          tab.active = true;
          state.activated.push([tabId, tab.windowId]);
        }
        return tab;
      }),
      remove: counted(async () => undefined),
      sendMessage: reject('no content script in test'),
      captureVisibleTab: reject('cannot capture in test'),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    windows: {
      get: counted(async (windowId: number, info?: { populate?: boolean }) => {
        const win = windows.find((w) => w.id === windowId);
        if (!win) throw new Error(`no window ${windowId}`);
        if (info?.populate) return { ...win, tabs: tabs.filter((t) => t.windowId === windowId) };
        return win;
      }),
      getAll: counted(async () => windows.slice()),
      getLastFocused: counted(async () => windows.find((w) => w.focused) ?? windows[0]),
      create: counted(async (createData: Record<string, unknown>) => {
        const id = nextWindowId++;
        windows.push({
          id,
          type: (createData.type as string) ?? 'normal',
          incognito: false,
          focused: createData.focused === true,
        });
        if (createData.focused === true) state.focused.push(id);
        const tab: TabRecord = {
          id: nextTabId++,
          windowId: id,
          url: (createData.url as string) ?? 'about:blank',
          title: 'window tab',
          // 창이 열리면 그 창의 첫 탭은 원래 활성이다 — 우리가 활성화한 것이 아니므로 세지 않는다.
          active: true,
          status: 'complete',
        };
        tabs.push(tab);
        return { id, type: (createData.type as string) ?? 'normal', tabs: [{ id: tab.id }] };
      }),
      update: counted(async (windowId: number, info: Record<string, unknown>) => {
        const win = windows.find((w) => w.id === windowId);
        if (!win) throw new Error(`no window ${windowId}`);
        if (typeof info.focused === 'boolean') {
          win.focused = info.focused;
          if (info.focused === true) state.focused.push(windowId);
        }
        return win;
      }),
      remove: counted(async () => undefined),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onFocusChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      WINDOW_ID_NONE: -1,
    },
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
      setTitle: vi.fn(async () => undefined),
    },
    debugger: {
      getTargets: counted(async () => []),
      attach: counted(async () => undefined),
      detach: counted(async () => undefined),
      sendCommand: counted(async () => ({})),
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
      onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: { executeScript: reject('no scripting in test') },
    history: { search: counted(async () => []), deleteUrl: counted(async () => undefined) },
    bookmarks: {
      search: counted(async () => []),
      create: counted(async () => ({ id: 'b1' })),
      remove: counted(async () => undefined),
      removeTree: counted(async () => undefined),
      getTree: counted(async () => []),
      get: reject('no bookmark'),
      getSubTree: counted(async () => []),
    },
    downloads: {
      search: counted(async () => []),
      download: reject('no downloads in test'),
      onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    webNavigation: {
      onCommitted: { addListener: vi.fn(), removeListener: vi.fn() },
      onDOMContentLoaded: { addListener: vi.fn(), removeListener: vi.fn() },
      onCompleted: { addListener: vi.fn(), removeListener: vi.fn() },
      onCreatedNavigationTarget: { addListener: vi.fn(), removeListener: vi.fn() },
      onErrorOccurred: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    webRequest: {
      onBeforeRequest: { addListener: vi.fn(), removeListener: vi.fn() },
      onCompleted: { addListener: vi.fn(), removeListener: vi.fn() },
      onErrorOccurred: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    declarativeNetRequest: {
      updateDynamicRules: counted(async () => undefined),
      getDynamicRules: counted(async () => []),
    },
  };

  return state;
}

/**
 * 도구별 대표 인자.
 *
 * navigate 만 기본 동작(전용 작업 창 생성)을 그대로 두고, 나머지는 **사용자 탭 id +
 * background:false** 를 준다. 도구가 "탭을 앞으로 가져오는" 분기로 실제로 들어가게 만든 뒤
 * 가드가 막는지 보기 위해서다.
 */
function fixtures(): Record<string, Record<string, unknown>> {
  const onUserTab = { tabId: USER_TAB_ID, background: false };
  return {
    [B.NAVIGATE]: { url: 'https://sweep.example/page', waitUntil: 'none', background: true },
    [B.SCREENSHOT]: { ...onUserTab },
    [B.CLOSE_TABS]: { ...onUserTab, tabIds: [] },
    [B.WEB_FETCHER]: { ...onUserTab, htmlContent: true },
    [B.NETWORK_REQUEST]: { ...onUserTab, url: 'https://sweep.example/api' },
    // start 로 들어가야 "탭을 만들고 활성화하는" 분기를 지난다 (stop 은 앞단에서 끝난다).
    [B.NETWORK_CAPTURE]: {
      action: 'start',
      url: 'https://sweep.example/capture',
      background: false,
    },
    [B.HANDLE_DOWNLOAD]: { ...onUserTab, timeoutMs: 1000, waitForComplete: false },
    [B.HISTORY]: { ...onUserTab, text: 'sweep' },
    [B.BOOKMARK_SEARCH]: { ...onUserTab, query: 'sweep' },
    [B.BOOKMARK_ADD]: { ...onUserTab, url: 'https://sweep.example/', title: 'sweep' },
    [B.BOOKMARK_DELETE]: { ...onUserTab, bookmarkId: 'missing' },
    [B.SEARCH_TABS_CONTENT]: { ...onUserTab, query: 'sweep' },
    [B.INJECT_SCRIPT]: { ...onUserTab, type: 'MAIN', jsScript: 'void 0;' },
    [B.SEND_COMMAND_TO_INJECT_SCRIPT]: { ...onUserTab, eventName: 'sweep', payload: {} },
    [B.JAVASCRIPT]: { ...onUserTab, code: '1 + 1' },
    [B.CLICK]: { ...onUserTab, selector: '#sweep' },
    [B.FILL]: { ...onUserTab, selector: '#sweep', value: 'x' },
    [B.KEYBOARD]: { ...onUserTab, keys: 'Enter' },
    [B.CONSOLE]: { ...onUserTab },
    [B.FILE_UPLOAD]: { ...onUserTab, selector: '#sweep', filePath: 'C:/nope.txt' },
    [B.HANDLE_DIALOG]: { ...onUserTab, action: 'dismiss' },
    // start 로 들어가야 "배경 탭을 활성화해 녹화" 분기를 지난다.
    [B.GIF_RECORDER]: {
      ...onUserTab,
      action: 'start',
      durationMs: 200,
      fps: 1,
      maxFrames: 1,
    },
    [B.STORAGE]: { action: 'get', area: 'local' },
    [B.SAVE_PDF]: { ...onUserTab },
    [B.EMULATE]: { ...onUserTab, action: 'reset' },
    [B.NETWORK_RULES]: { ...onUserTab, action: 'list' },
    [B.BATCH]: { ...onUserTab, steps: [] },
    [B.FIND]: { ...onUserTab, query: 'sweep' },
    [B.SHORTCUT]: { ...onUserTab, name: 'sweep_unknown' },
    [B.EXTRACT]: { ...onUserTab, what: 'links' },
    [B.WAIT_FOR]: { ...onUserTab, text: 'never-appears', timeoutMs: 1 },
    [B.SCROLL_COLLECT]: { ...onUserTab, maxScrolls: 1 },
    [B.SET_WORK_TAB]: { tabId: USER_TAB_ID },
    [B.GET_WINDOWS_AND_TABS]: {},
    [B.PERFORMANCE_START_TRACE]: { ...onUserTab },
    [B.PERFORMANCE_STOP_TRACE]: { ...onUserTab },
    [B.PERFORMANCE_ANALYZE_INSIGHT]: { ...onUserTab, insightName: 'sweep' },
    [B.READ_PAGE]: { ...onUserTab },
    [B.COMPUTER]: { ...onUserTab, action: 'screenshot' },
    [B.USERSCRIPT]: { ...onUserTab, action: 'list' },
    // TOOL_SCHEMAS 에는 없지만 확장 안에는 등록돼 있는 도구들 (레거시·내부용)
    [B.GET_INTERACTIVE_ELEMENTS]: { ...onUserTab },
    [B.NETWORK_CAPTURE_START]: { ...onUserTab },
    [B.NETWORK_CAPTURE_STOP]: { ...onUserTab },
    [B.NETWORK_DEBUGGER_START]: { ...onUserTab },
    [B.NETWORK_DEBUGGER_STOP]: { ...onUserTab },
    record_replay_flow_run: { flowId: 'sweep-missing-flow' },
    record_replay_list_published: {},
  };
}

async function loadModules() {
  vi.resetModules();
  const tools = await import('@/entrypoints/background/tools');
  // 같은 모듈 그래프의 인스턴스여야 도구가 쓰는 기록을 그대로 읽는다.
  const windowManager = await import('@/utils/mcp-window-manager');
  return { tools, windowManager };
}

const PER_TOOL_TIMEOUT_MS = 5000;

type Outcome = { name: string; status: 'done' | 'timeout'; apiCalls: number };

async function callTool(
  handleCallTool: (p: { name: string; args: unknown }) => Promise<unknown>,
  name: string,
  args: Record<string, unknown>,
): Promise<Outcome> {
  const before = sweep.apiCalls;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let status: 'done' | 'timeout' = 'done';
  try {
    const result = await Promise.race([
      // 도구가 던지는 예외는 가드 위반과 별개다 — 여기서는 "끝났다"로만 본다.
      handleCallTool({ name, args }).then(
        () => 'done' as const,
        () => 'done' as const,
      ),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), PER_TOOL_TIMEOUT_MS);
      }),
    ]);
    status = result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return { name, status, apiCalls: sweep.apiCalls - before };
}

/** 사용자 창에 비활성 탭을 하나 더 만든다 (도구가 이 탭을 활성화하려 들면 위반이다). */
function newUserTab(): number {
  const id = 20000 + sweep.tabs.length;
  sweep.tabs.push({
    id,
    windowId: USER_WINDOW_ID,
    url: 'https://user-page.example/other',
    title: 'user tab',
    active: false,
    status: 'complete',
  });
  return id;
}

describe('무간섭 모드 범용 회귀 (설계 K)', () => {
  beforeEach(() => {
    sweep = installChrome();
  });

  it('fixture 의 도구 집합이 실제 도구 레지스트리와 정확히 일치한다', async () => {
    const { tools } = await loadModules();
    const registered = [...tools.REGISTERED_TOOL_NAMES]
      .filter((name) => !EXEMPT_TOOLS.has(name))
      .sort();
    const covered = Object.keys(fixtures()).sort();

    // 광고 여부와 무관하게, 등록된 도구는 하나도 빠지면 안 된다.
    expect(covered).toEqual(registered);
  });

  it('비예외 도구를 전부 돌려도 사용자 창의 탭을 활성화하거나 포커스를 뺏지 않는다', async () => {
    const { tools, windowManager } = await loadModules();
    const fx = fixtures();

    const outcomes: Outcome[] = [];
    /** 도구를 도는 동안 "전용 작업 창" 으로 기록됐던 창들 (모듈의 실제 기록) */
    const dedicatedWindowIds = new Set<number>();

    for (const [name, args] of Object.entries(fx)) {
      // 도구마다 사용자 창에 자기 탭을 준다. 탭 단위 직렬화(tab-lock) 때문에 한 도구가
      // 늦게 끝나면 같은 탭을 쓰는 뒤 도구들이 줄줄이 막혀 관측이 무너진다.
      const args2 = args.tabId === USER_TAB_ID ? { ...args, tabId: newUserTab() } : { ...args };
      outcomes.push(await callTool(tools.handleCallTool as never, name, args2));
      const dedicated = await windowManager.getMcpWindowId();
      if (dedicated !== null) dedicatedWindowIds.add(dedicated);
    }

    // (1) 끝나지 않은 도구가 있으면 그 뒤의 동작을 관측하지 못한다 — 실패로 본다.
    const timedOut = outcomes.filter((o) => o.status === 'timeout').map((o) => o.name);
    expect(timedOut, `제한 시간 안에 끝나지 않은 도구: ${timedOut.join(', ')}`).toEqual([]);

    // (2) 인자가 틀려 앞단에서 튕긴 fixture 는 그물 역할을 못 한다.
    const inert = outcomes
      .filter((o) => o.apiCalls === 0 && !STORAGE_ONLY_TOOLS.has(o.name))
      .map((o) => o.name);
    expect(
      inert,
      `chrome API 를 한 번도 부르지 않은 fixture(실행 경로에 못 들어감): ${inert.join(', ')}`,
    ).toEqual([]);

    // (3) 활성화는 전용 작업 창 안에서만 허용된다.
    const badActivations = sweep.activated.filter(
      ([, windowId]) => !dedicatedWindowIds.has(windowId),
    );
    expect(
      badActivations,
      `전용 작업 창 밖의 탭이 활성화됐다: ${JSON.stringify(badActivations)}`,
    ).toEqual([]);

    const badCreations = sweep.createdActive.filter(
      ([, windowId]) => !dedicatedWindowIds.has(windowId),
    );
    expect(
      badCreations,
      `전용 작업 창 밖에 활성 탭이 만들어졌다: ${JSON.stringify(badCreations)}`,
    ).toEqual([]);

    // (4) 강제 포커스는 꺼져 있으므로 focused:true 는 한 번도 나가면 안 된다.
    expect(
      sweep.focused,
      `강제 포커스가 꺼져 있는데 focused:true 가 나갔다: ${JSON.stringify(sweep.focused)}`,
    ).toEqual([]);
  }, 180_000);
});
