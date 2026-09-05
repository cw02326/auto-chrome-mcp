/**
 * auto-chrome-mcp fork — 예약 실행기 하드닝 (2026-09-05 Codex 리뷰 1~10).
 *
 * 계약: docs/plans/2026-09-05-daily-automation-design.md 1·2·4·5절.
 * 각 describe 앞 번호는 그 리뷰 항목 번호다. 여기 있는 검사는 전부 "수정 전에는 실패,
 * 수정 후에는 통과" 를 확인한 재현 테스트다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type AnyRecord = Record<string, any>;

const USER_WINDOW_ID = 1;
const POPUP_WINDOW_ID = 7;
const USER_TAB_ID = 11;
const WORK_TAB_ID = 501;
const SPAWNED_TAB_ID = 777;

interface Harness {
  runner: typeof import('@/entrypoints/background/schedule-runner');
  shortcut: typeof import('@/entrypoints/background/tools/browser/shortcut');
  history: typeof import('@/utils/shortcut-history');
  schedule: typeof import('@/utils/shortcut-schedule');
  workTab: typeof import('@/utils/work-tab-manager');
  tracker: typeof import('@/utils/spawned-tab-tracker');
  local: AnyRecord;
  session: AnyRecord;
  alarms: Map<string, { name: string; scheduledTime: number }>;
  alarmListeners: Array<(alarm: any) => void>;
  tabCreatedListeners: Array<(tab: any) => void>;
  notifications: AnyRecord[];
  downloads: AnyRecord[];
  tabs: Map<number, AnyRecord>;
  windows: Map<number, AnyRecord>;
  removedTabs: number[];
  removedWindows: number[];
  activatedTabs: number[];
  focusedWindows: number[];
  toolCalls: AnyRecord[];
}

/** 두 워커가 같은 저장소를 나눠 쓰는 상황을 만들기 위해 store 를 밖에서 넣을 수 있다. */
function installChrome(h: Partial<Harness>, shared?: { local: AnyRecord; session: AnyRecord }) {
  const local: AnyRecord = shared?.local ?? {};
  const session: AnyRecord = shared?.session ?? {};
  const alarms = new Map<string, { name: string; scheduledTime: number }>();
  const alarmListeners: Array<(alarm: any) => void> = [];
  const tabCreatedListeners: Array<(tab: any) => void> = [];
  const notifications: AnyRecord[] = [];
  const downloads: AnyRecord[] = [];
  const tabs = new Map<number, AnyRecord>();
  const windows = new Map<number, AnyRecord>();
  const removedTabs: number[] = [];
  const removedWindows: number[] = [];
  const activatedTabs: number[] = [];
  const focusedWindows: number[] = [];

  windows.set(USER_WINDOW_ID, { id: USER_WINDOW_ID, type: 'normal', focused: true });
  tabs.set(USER_TAB_ID, {
    id: USER_TAB_ID,
    windowId: USER_WINDOW_ID,
    active: true,
    url: 'https://user.example.com/',
  });

  const area = (store: AnyRecord) => ({
    get: vi.fn(async (keys: any) => {
      // 읽기와 쓰기 사이에 틈을 만든다 - 잠금 경쟁이 실제로 일어나게 하려면 필요하다.
      await Promise.resolve();
      if (keys === undefined || keys === null) return { ...store };
      const list = Array.isArray(keys) ? keys : [keys];
      const out: AnyRecord = {};
      for (const key of list) if (key in store) out[key] = store[key];
      return out;
    }),
    set: vi.fn(async (obj: AnyRecord) => {
      await Promise.resolve();
      Object.assign(store, JSON.parse(JSON.stringify(obj)));
    }),
    remove: vi.fn(async (keys: any) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    }),
  });

  const listener = () => ({ addListener: vi.fn(), removeListener: vi.fn() });

  (globalThis as any).chrome = {
    runtime: {
      id: 'test-extension-id',
      getURL: (path: string) => `chrome-extension://test/${path}`,
      getPlatformInfo: vi.fn(async () => ({ os: 'win' })),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      onMessage: listener(),
      lastError: undefined,
    },
    storage: { local: area(local), session: area(session) },
    alarms: {
      create: vi.fn(async (name: string, info: AnyRecord) => {
        alarms.set(name, { name, scheduledTime: info?.when ?? Date.now() });
      }),
      clear: vi.fn(async (name: string) => alarms.delete(name)),
      clearAll: vi.fn(async () => {
        alarms.clear();
        return true;
      }),
      getAll: vi.fn(async () => Array.from(alarms.values())),
      onAlarm: {
        addListener: vi.fn((fn: any) => alarmListeners.push(fn)),
        removeListener: vi.fn(),
      },
    },
    notifications: {
      create: vi.fn(async (id: string, options: AnyRecord) => {
        notifications.push({ id, ...options });
        return id;
      }),
      onClicked: listener(),
    },
    downloads: {
      download: vi.fn(async (options: AnyRecord) => {
        downloads.push(options);
        return downloads.length;
      }),
      search: vi.fn(async () => []),
    },
    tabs: {
      get: vi.fn(async (tabId: number) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id ${tabId}`);
        return tab;
      }),
      query: vi.fn(async (query: AnyRecord = {}) => {
        return Array.from(tabs.values()).filter((tab) => {
          if (query.active === true && tab.active !== true) return false;
          if (typeof query.windowId === 'number' && tab.windowId !== query.windowId) return false;
          if (query.lastFocusedWindow === true && tab.windowId !== USER_WINDOW_ID) return false;
          return true;
        });
      }),
      create: vi.fn(async () => ({ id: 999, windowId: USER_WINDOW_ID })),
      update: vi.fn(async (tabId: number, info: AnyRecord) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id ${tabId}`);
        if (info?.active === true) {
          activatedTabs.push(tabId);
          for (const other of tabs.values()) {
            if (other.windowId === tab.windowId) other.active = other.id === tabId;
          }
        }
        return tab;
      }),
      remove: vi.fn(async (tabId: number) => {
        removedTabs.push(tabId);
        tabs.delete(tabId);
      }),
      group: vi.fn(async () => 100),
      ungroup: vi.fn(async () => undefined),
      onRemoved: listener(),
      onCreated: {
        addListener: vi.fn((fn: any) => tabCreatedListeners.push(fn)),
        removeListener: vi.fn(),
      },
      onUpdated: listener(),
    },
    tabGroups: {
      query: vi.fn(async () => []),
      get: vi.fn(async () => ({ id: 100, title: 'MCP', color: 'green', windowId: 1 })),
      update: vi.fn(async () => ({ id: 100, title: 'MCP', color: 'green', windowId: 1 })),
      move: vi.fn(async () => undefined),
      TAB_GROUP_ID_NONE: -1,
      onCreated: listener(),
      onRemoved: listener(),
      onUpdated: listener(),
    },
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
      setTitle: vi.fn(async () => undefined),
      setIcon: vi.fn(async () => undefined),
    },
    windows: {
      get: vi.fn(async (id: number) => {
        const win = windows.get(id);
        if (!win) throw new Error(`No window with id ${id}`);
        return win;
      }),
      getAll: vi.fn(async () => Array.from(windows.values())),
      getCurrent: vi.fn(async () => windows.get(USER_WINDOW_ID)),
      getLastFocused: vi.fn(async () => windows.get(USER_WINDOW_ID)),
      create: vi.fn(async () => windows.get(USER_WINDOW_ID)),
      update: vi.fn(async (id: number, info: AnyRecord) => {
        if (info?.focused === true) focusedWindows.push(id);
        return windows.get(id) ?? { id };
      }),
      remove: vi.fn(async (id: number) => {
        removedWindows.push(id);
        windows.delete(id);
      }),
      onRemoved: listener(),
      onFocusChanged: listener(),
      WINDOW_ID_NONE: -1,
    },
    webNavigation: {
      onCreatedNavigationTarget: listener(),
      onCommitted: listener(),
      onCompleted: listener(),
      onBeforeNavigate: listener(),
      onDOMContentLoaded: listener(),
      onHistoryStateUpdated: listener(),
      onErrorOccurred: listener(),
    },
    webRequest: {
      onBeforeRequest: listener(),
      onBeforeSendHeaders: listener(),
      onSendHeaders: listener(),
      onHeadersReceived: listener(),
      onResponseStarted: listener(),
      onCompleted: listener(),
      onErrorOccurred: listener(),
    },
    permissions: {
      contains: vi.fn(async () => true),
      request: vi.fn(async () => true),
      getAll: vi.fn(async () => ({ permissions: [], origins: [] })),
      onAdded: listener(),
      onRemoved: listener(),
    },
    declarativeNetRequest: {
      updateDynamicRules: vi.fn(async () => undefined),
      getDynamicRules: vi.fn(async () => []),
      updateSessionRules: vi.fn(async () => undefined),
      getSessionRules: vi.fn(async () => []),
    },
    offscreen: {
      createDocument: vi.fn(async () => undefined),
      closeDocument: vi.fn(async () => undefined),
      hasDocument: vi.fn(async () => false),
    },
    sidePanel: {
      setOptions: vi.fn(async () => undefined),
      setPanelBehavior: vi.fn(async () => undefined),
      open: vi.fn(async () => undefined),
    },
    bookmarks: {
      search: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: '1' })),
      remove: vi.fn(async () => undefined),
      getTree: vi.fn(async () => []),
    },
    history: {
      search: vi.fn(async () => []),
      deleteUrl: vi.fn(async () => undefined),
    },
    downloads_shelf: undefined,
    debugger: {
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async () => ({})),
      onDetach: listener(),
      onEvent: listener(),
    },
    scripting: { executeScript: vi.fn(async () => []) },
    commands: { onCommand: listener() },
    contextMenus: { create: vi.fn(), remove: vi.fn(), onClicked: listener() },
  };

  Object.assign(h, {
    local,
    session,
    alarms,
    alarmListeners,
    tabCreatedListeners,
    notifications,
    downloads,
    tabs,
    windows,
    removedTabs,
    removedWindows,
    activatedTabs,
    focusedWindows,
  });
}

async function setup(shared?: { local: AnyRecord; session: AnyRecord }): Promise<Harness> {
  vi.resetModules();
  const h: Partial<Harness> = {};
  installChrome(h, shared);
  h.toolCalls = [];
  h.runner = await import('@/entrypoints/background/schedule-runner');
  h.shortcut = await import('@/entrypoints/background/tools/browser/shortcut');
  h.history = await import('@/utils/shortcut-history');
  h.schedule = await import('@/utils/shortcut-schedule');
  h.workTab = await import('@/utils/work-tab-manager');
  h.tracker = await import('@/utils/spawned-tab-tracker');
  return h as Harness;
}

function body(result: any) {
  return JSON.parse(result.content[0].text);
}

const okText = (payload: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(payload) }],
  isError: false,
});

const BASIC_STEPS = [
  { tool: 'chrome_navigate', args: { url: 'https://board.example.com/list' } },
  { tool: 'chrome_extract', as: 'latest', args: { fields: { id: '.row .id' } } },
];

function wireInvoker(
  h: Harness,
  name: string,
  handler: (call: AnyRecord) => any = () => okText({ success: true }),
  workTabId = WORK_TAB_ID,
) {
  const sessionKey = h.runner.scheduledSessionKey(name);
  h.runner.setScheduleToolInvoker(async (call: any) => {
    h.toolCalls.push({ name: call.name, args: call.args, mode: call.effectiveBackgroundMode });
    if (call.name === 'chrome_navigate') {
      h.tabs.set(workTabId, {
        id: workTabId,
        windowId: USER_WINDOW_ID,
        active: false,
        url: 'https://x/',
      });
      await h.workTab.addOwnedTab(workTabId, sessionKey);
      await h.workTab.setWorkTab(workTabId, sessionKey, true);
      return okText({ success: true, tabId: workTabId });
    }
    return handler(call);
  });
  return { sessionKey, workTabId };
}

async function saveAndSchedule(
  h: Harness,
  name: string,
  steps: unknown[],
  scheduleArgs: AnyRecord = { every: '1h' },
  extra: AnyRecord = {},
) {
  await h.shortcut.shortcutTool.execute({
    action: 'save',
    name,
    templates: true,
    steps,
    ...(extra.saveExtra ?? {}),
  } as any);
  const result = await h.shortcut.shortcutTool.execute({
    action: 'schedule',
    name,
    schedule: scheduleArgs,
    ...(extra.scheduleExtra ?? {}),
  } as any);
  return body(result);
}

async function settle(times = 60) {
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < times; i++) await Promise.resolve();
}

let h: Harness;

beforeEach(async () => {
  h = await setup();
});

afterEach(() => {
  h?.runner?.resetScheduleRunnerState?.();
  vi.useRealTimers();
});

/* ================================================================== *
 * 1. 페이지가 띄운 탭·창
 * ================================================================== */

describe('1. 페이지가 띄운 탭·팝업 창도 예약 실행의 소유다', () => {
  /** 실행 중 작업 탭이 팝업 창을 하나 연다 (target=_blank / window.open). */
  function openPopupFromWorkTab(harness: Harness): void {
    harness.windows.set(POPUP_WINDOW_ID, {
      id: POPUP_WINDOW_ID,
      type: 'popup',
      focused: true,
    });
    harness.tabs.set(SPAWNED_TAB_ID, {
      id: SPAWNED_TAB_ID,
      windowId: POPUP_WINDOW_ID,
      active: true,
      url: 'https://popup.example.com/',
      openerTabId: WORK_TAB_ID,
    });
    // 사용자 창의 활성 탭도 빼앗겼다고 본다 (target=_blank 는 활성 탭으로 열린다).
    for (const tab of harness.tabs.values()) {
      if (tab.windowId === USER_WINDOW_ID) tab.active = false;
    }
    for (const fn of harness.tabCreatedListeners) {
      fn({
        id: SPAWNED_TAB_ID,
        windowId: POPUP_WINDOW_ID,
        openerTabId: WORK_TAB_ID,
        url: 'https://popup.example.com/',
        active: true,
      });
    }
  }

  it('전역 토글 OFF 여도 소유·복구·정리가 모두 일어난다', async () => {
    // 전역 무간섭 토글을 끈 상태. 예전 완화 로직은 이 값만 보고 아무것도 하지 않았다.
    h.local.backgroundWorkMode = false;

    const { sessionKey } = wireInvoker(h, 'job', (call) => {
      if (call.name === 'chrome_extract') openPopupFromWorkTab(h);
      return okText({ success: true });
    });
    const saved = await saveAndSchedule(h, 'job', [
      ...BASIC_STEPS,
      { tool: 'chrome_extract', as: 'after', args: { fields: { x: '.x' } } },
    ]);

    h.alarmListeners[0]({ name: 'mcp-shortcut::job', scheduledTime: saved.nextAt });
    await settle(120);

    const map = await h.history.readHistory();
    // 팝업이 떴다고 실행이 인계로 끊기지 않는다.
    expect(map.job[0].status).toBe('success');
    // 사용자가 보던 탭·창으로 즉시 되돌렸다.
    expect(h.activatedTabs).toContain(USER_TAB_ID);
    expect(h.focusedWindows).toContain(USER_WINDOW_ID);
    // 스폰 탭은 실행이 끝나며 닫히고, 팝업 창도 창째로 닫힌다.
    expect(h.removedTabs).toContain(SPAWNED_TAB_ID);
    expect(h.removedWindows).toContain(POPUP_WINDOW_ID);
    // 버킷도 비었다.
    expect(await h.workTab.getSessionScopedTabIds(sessionKey)).toHaveLength(0);
  });
});

/* ================================================================== *
 * 2. gif_recorder 의 실행 컨텍스트 모드
 * ================================================================== */

describe('2. gif_recorder 는 실행 컨텍스트 모드를 전역 토글보다 먼저 본다', () => {
  it('전역 토글 OFF 라도 강제 모드 호출은 사용자 탭을 활성화하지 않는다', async () => {
    h.local.backgroundWorkMode = false;
    // 대상 탭은 포커스된 사용자 창이 아닌 다른 창에 있다 (활성화 분기 조건).
    h.windows.set(3, { id: 3, type: 'normal', focused: false });
    h.tabs.set(31, { id: 31, windowId: 3, active: false, url: 'https://a/' });
    h.tabs.set(32, { id: 32, windowId: 3, active: true, url: 'https://b/' });

    const { gifRecorderTool } = await import('@/entrypoints/background/tools/browser/gif-recorder');
    await gifRecorderTool.execute({
      action: 'start',
      tabId: 31,
      _effectiveBackgroundMode: true,
    } as any);

    expect(h.activatedTabs).not.toContain(31);
  });
});

/* ================================================================== *
 * 3. revision ABA
 * ================================================================== */

describe('3. 지웠다 다시 건 예약을 옛 실행이 자기 것으로 착각하지 않는다', () => {
  it('실행 중 unschedule -> schedule 을 하면 옛 실행은 superseded 다', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    wireInvoker(h, 'job', async () => {
      await gate;
      return okText({ success: true });
    });
    const saved = await saveAndSchedule(h, 'job', BASIC_STEPS);
    expect((await h.schedule.readSchedule('job'))?.revision).toBe(1);

    h.alarmListeners[0]({ name: 'mcp-shortcut::job', scheduledTime: saved.nextAt });
    await settle();

    // 사용자가 예약을 지웠다가 같은 이름으로 다시 건다 -> revision 이 1 로 돌아온다(ABA).
    await h.shortcut.shortcutTool.execute({ action: 'unschedule', name: 'job' } as any);
    await h.shortcut.shortcutTool.execute({
      action: 'schedule',
      name: 'job',
      schedule: { every: '6h' },
    } as any);
    const reborn = await h.schedule.readSchedule('job');
    expect(reborn?.revision).toBe(1);

    release?.();
    await settle(120);

    const map = await h.history.readHistory();
    expect(map.job[0].superseded).toBe(true);
    // 새 예약의 상태는 옛 실행이 건드리지 않는다.
    const after = await h.schedule.readSchedule('job');
    expect(after?.lastStatus).toBeUndefined();
    expect(after?.lastRunId).toBeUndefined();
    expect(after?.nextAt).toBe(reborn?.nextAt);
    expect(h.alarms.get('mcp-shortcut::job')?.scheduledTime).toBe(reborn?.nextAt);
  });
});

/* ================================================================== *
 * 4. 교차 워커 잠금
 * ================================================================== */

describe('4. 워커 둘이 같은 due 를 집어도 실행은 한 번뿐이다', () => {
  it('두 러너 인스턴스가 동시에 잠금을 노려도 이력이 1건이다', async () => {
    const shared = { local: h.local, session: h.session };

    wireInvoker(h, 'job');
    const saved = await saveAndSchedule(h, 'job', BASIC_STEPS);

    // 두 번째 워커 (같은 저장소, 다른 모듈 그래프·다른 owner 토큰).
    const second = await setup(shared);
    const calls: string[] = [];
    second.runner.setScheduleToolInvoker(async (call: any) => {
      calls.push(`b:${call.name}`);
      if (call.name === 'chrome_navigate') {
        const key = second.runner.scheduledSessionKey('job');
        second.tabs.set(WORK_TAB_ID, { id: WORK_TAB_ID, windowId: USER_WINDOW_ID, active: false });
        await second.workTab.addOwnedTab(WORK_TAB_ID, key);
        await second.workTab.setWorkTab(WORK_TAB_ID, key, true);
        return okText({ success: true, tabId: WORK_TAB_ID });
      }
      return okText({ success: true });
    });
    // 첫 번째 워커의 invoker 는 두 번째 setup 이 chrome 을 갈아 끼운 뒤에도 그대로 쓴다.
    h.runner.setScheduleToolInvoker(async (call: any) => {
      calls.push(`a:${call.name}`);
      if (call.name === 'chrome_navigate') {
        const key = h.runner.scheduledSessionKey('job');
        second.tabs.set(WORK_TAB_ID, { id: WORK_TAB_ID, windowId: USER_WINDOW_ID, active: false });
        await h.workTab.addOwnedTab(WORK_TAB_ID, key);
        await h.workTab.setWorkTab(WORK_TAB_ID, key, true);
        return okText({ success: true, tabId: WORK_TAB_ID });
      }
      return okText({ success: true });
    });

    h.runner.enqueueScheduledRun('job', saved.nextAt);
    second.runner.enqueueScheduledRun('job', saved.nextAt);
    await settle(150);

    const map = await second.history.readHistory();
    expect(map.job).toHaveLength(1);
    // 한쪽 워커만 도구를 불렀다.
    const workers = new Set(calls.map((entry) => entry.split(':', 1)[0]));
    expect(workers.size).toBe(1);

    second.runner.resetScheduleRunnerState();
  });
});

/* ================================================================== *
 * 5. 상한 초과와 keepalive
 * ================================================================== */

describe('5. 상한을 넘긴 실행은 실제로 끊기고, 정리까지 하트비트가 산다', () => {
  it('신호가 서면 runSteps 가 남은 도구를 부르지 않는다', async () => {
    const { runSteps } = await import('@/entrypoints/background/tools/browser/batch-runner');
    const controller = new AbortController();
    const called: string[] = [];

    const outcome = await runSteps({
      steps: [
        { tool: 'chrome_navigate', args: { url: 'https://a/' }, as: 'nav' },
        { tool: 'chrome_extract', args: { fields: { t: 'h1' } }, as: 'one' },
        { tool: 'chrome_extract', args: { fields: { t: 'h2' } }, as: 'two' },
      ],
      invoke: async (param: any) => {
        called.push(param.name);
        // 첫 도구가 도는 동안 바깥이 상한을 넘겨 실행을 끊는다.
        controller.abort('timeout');
        return { content: [{ type: 'text', text: '{}' }], isError: false };
      },
      disallowedTools: new Set<string>(),
      containerLabel: 'test',
      skippedNote: 'skipped',
      collectImages: false,
      templatesEnabled: true,
      forceBackground: true,
      signal: controller.signal,
    });

    expect(called).toEqual(['chrome_navigate']);
    expect(outcome.aborted?.reason).toBe('timeout');
    expect(outcome.stoppedBy?.reason).toBe('aborted');
  });

  it('report 를 저장하는 동안에도 잠금 하트비트가 갱신된다', async () => {
    vi.useFakeTimers();
    let releaseDownload: (() => void) | null = null;
    const downloadGate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    (chrome.downloads.download as any).mockImplementation(async (options: AnyRecord) => {
      h.downloads.push(options);
      await downloadGate;
      return h.downloads.length;
    });

    wireInvoker(h, 'job', () => okText({ success: true, values: { id: '1' } }));
    const saved = await saveAndSchedule(
      h,
      'job',
      BASIC_STEPS,
      { every: '1h' },
      { saveExtra: { return: ['latest'] }, scheduleExtra: { report: true } },
    );

    h.alarmListeners[0]({ name: 'mcp-shortcut::job', scheduledTime: saved.nextAt });
    await vi.advanceTimersByTimeAsync(5);

    // 실행은 report 저장에서 멈춰 있다.
    expect(h.downloads).toHaveLength(1);
    const before = h.session.scheduledRunLock?.heartbeatAt;
    expect(typeof before).toBe('number');

    await vi.advanceTimersByTimeAsync(11_000);
    const after = h.session.scheduledRunLock?.heartbeatAt;
    expect(after).toBeGreaterThan(before);

    releaseDownload?.();
    await vi.advanceTimersByTimeAsync(50);
    vi.useRealTimers();
  });
});

/* ================================================================== *
 * 6. 마지막 step 뒤 인계
 * ================================================================== */

describe('6. 마지막 step 뒤에 사용자가 탭을 가져가도 알아챈다', () => {
  it('user_took_over_tab 으로 끝나고 산출물을 만들지 않으며 탭도 닫지 않는다', async () => {
    const workTabId = 811;
    let stepCount = 0;
    const { sessionKey } = wireInvoker(
      h,
      'job',
      () => {
        stepCount += 1;
        // 마지막 step 이 끝난 **뒤에** 사용자가 그 탭을 활성화한다.
        if (stepCount === 1) {
          const tab = h.tabs.get(workTabId);
          if (tab) tab.active = true;
        }
        return okText({ success: true, values: { id: '1' } });
      },
      workTabId,
    );
    const saved = await saveAndSchedule(
      h,
      'job',
      BASIC_STEPS,
      { every: '1h' },
      { saveExtra: { return: ['latest'] }, scheduleExtra: { report: true } },
    );

    h.alarmListeners[0]({ name: 'mcp-shortcut::job', scheduledTime: saved.nextAt });
    await settle(120);

    const map = await h.history.readHistory();
    expect(map.job[0].status).toBe('user_took_over_tab');
    // 산출물 없음: 실패 스크린샷도 report 파일도 만들지 않는다.
    expect(h.toolCalls.some((call) => call.name === 'chrome_screenshot')).toBe(false);
    expect(h.downloads).toHaveLength(0);
    expect(map.job[0].report).toBeNull();
    // 사용자가 가져간 탭은 열린 채로 남고 소유만 풀린다.
    expect(h.removedTabs).not.toContain(workTabId);
    expect(h.tabs.has(workTabId)).toBe(true);
    expect(await h.workTab.getSessionScopedTabIds(sessionKey)).toHaveLength(0);
  });
});

/* ================================================================== *
 * 7. interrupted 복구
 * ================================================================== */

describe('7. interrupted 로 되돌린 실행도 상태·알림을 남긴다', () => {
  it('reconcile 이 lastStatus·failStreak 를 갱신하고 첫 실패 알림을 보낸다', async () => {
    wireInvoker(h, 'job');
    await saveAndSchedule(h, 'job', BASIC_STEPS);
    const record = await h.schedule.readSchedule('job');
    expect(record).not.toBeNull();

    // 워커가 죽어 종료 처리를 못 한 실행.
    const runId = h.schedule.scheduleRunId('job', record!.nextAt);
    await h.history.startRunRecord({
      runId,
      name: 'job',
      trigger: 'scheduled',
      startedAt: Date.now() - 60_000,
      revision: record!.revision,
      generation: record!.generation,
    });
    h.history.clearRunActive(runId);

    await h.runner.reconcileSchedules();
    await settle(80);

    const map = await h.history.readHistory();
    expect(map.job[0].status).toBe('interrupted');

    const after = await h.schedule.readSchedule('job');
    expect(after?.lastStatus).toBe('interrupted');
    expect(after?.lastRunId).toBe(runId);
    expect(after?.failStreak).toBe(1);
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0].message).toBe('job: interrupted');
  });

  it('그 사이 예약을 새로 걸었으면 상태를 건드리지 않는다', async () => {
    wireInvoker(h, 'job');
    await saveAndSchedule(h, 'job', BASIC_STEPS);
    const first = await h.schedule.readSchedule('job');
    const runId = h.schedule.scheduleRunId('job', first!.nextAt);
    await h.history.startRunRecord({
      runId,
      name: 'job',
      trigger: 'scheduled',
      startedAt: Date.now() - 60_000,
      revision: first!.revision,
      generation: first!.generation,
    });
    h.history.clearRunActive(runId);

    // 사용자가 예약을 다시 걸었다.
    await h.shortcut.shortcutTool.execute({
      action: 'schedule',
      name: 'job',
      schedule: { every: '6h' },
    } as any);

    await h.runner.reconcileSchedules();
    await settle(80);

    const map = await h.history.readHistory();
    expect(map.job[0].status).toBe('interrupted');
    expect(map.job[0].superseded).toBe(true);
    const after = await h.schedule.readSchedule('job');
    expect(after?.lastStatus).toBeUndefined();
    expect(after?.failStreak).toBe(0);
    expect(h.notifications).toHaveLength(0);
  });
});

/* ================================================================== *
 * 통합: 러너가 실제 handleCallTool 게이트를 탄다
 * ================================================================== */

describe('통합: 예약 실행은 stub 이 아니라 진짜 게이트를 지난다', () => {
  // 도구 레지스트리 전체를 불러오므로 캐시가 식었을 때 기본 상한을 넘는다.
  vi.setConfig({ testTimeout: 20000 });

  it('전역 토글 OFF 여도 작업 탭 없는 호출은 no_work_tab 으로 거절된다', async () => {
    // 전역 토글이 꺼져 있으면 게이트는 원래 작업 탭을 요구하지 않는다. 예약 실행은
    // 실행 컨텍스트 모드 때문에 그래도 거절돼야 한다 - 그 판정을 진짜 게이트가 한다.
    h.local.backgroundWorkMode = false;

    // tools/index.ts 를 부르는 것만으로 setScheduleToolInvoker(handleCallTool) 이 배선된다.
    await import('@/entrypoints/background/tools/index');

    // 첫 step 규칙(navigate)을 우회해 게이트 판정만 보기 위해 레코드를 직접 넣는다.
    await h.shortcut.shortcutTool.execute({
      action: 'save',
      name: 'gated',
      templates: true,
      steps: [{ tool: 'chrome_screenshot', args: {} }],
    } as any);
    const now = Date.now();
    const saved = await h.schedule.putSchedule({
      name: 'gated',
      schedule: { every: '1h' },
      notify: false,
      report: false,
      nextAt: now,
      anchorAt: now,
      timeZone: 'Asia/Seoul',
      offsetMinutes: -540,
    } as any);
    expect(saved.ok).toBe(true);

    h.runner.enqueueScheduledRun('gated', now);
    await settle(200);

    const map = await h.history.readHistory();
    expect(map.gated).toHaveLength(1);
    expect(map.gated[0].status).toBe('failed');
    // 게이트가 돌려주는 본문은 JSON 이라 errorCode 는 tool_error 로 접힌다. 거절 사유는
    // 본문에 그대로 있다 - 여기서 보는 것은 "진짜 게이트가 판정했는가" 다.
    expect(map.gated[0].error).toContain('no_work_tab');
    // 사용자 탭은 건드리지 않았다.
    expect(h.removedTabs).not.toContain(USER_TAB_ID);
    expect(h.tabs.get(USER_TAB_ID)?.active).toBe(true);
  });
});

/* ================================================================== *
 * 10. report 는 24KiB 를 넘겨 담는다
 * ================================================================== */

describe('10. report 파일은 이력 상한이 아니라 256KiB 예산을 쓴다', () => {
  it('24,000자를 넘는 return 값이 report 파일에는 통째로 들어간다', async () => {
    // 이력 상한(24,000자)은 넘고 report 상한(256KiB)에는 들어가는 크기.
    const blob = 'z'.repeat(30_000);
    wireInvoker(h, 'job', () => okText({ success: true, blob }));
    const saved = await saveAndSchedule(
      h,
      'job',
      BASIC_STEPS,
      { every: '1h' },
      { saveExtra: { return: ['latest'] }, scheduleExtra: { report: true } },
    );

    h.alarmListeners[0]({ name: 'mcp-shortcut::job', scheduledTime: saved.nextAt });
    await settle(120);

    const map = await h.history.readHistory();
    // 이력에서는 빠진다 (상한 그대로).
    expect(map.job[0].results?.latest).toBeUndefined();
    expect(map.job[0].resultsTruncated).toContain('latest');

    // report 파일에는 값이 통째로 들어 있다.
    expect(h.downloads).toHaveLength(1);
    const json = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(h.downloads[0].url.split(',')[1]), (c) => c.charCodeAt(0)),
      ),
    );
    expect(json.results.latest.blob).toHaveLength(30_000);
    expect(json.resultsTruncated ?? []).not.toContain('latest');
  });
});
