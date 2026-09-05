/**
 * 매일 작업: 예약 대상 확장(단축 + 흐름)과 사이드패널 메시지
 * (2026-09-05 사이드패널 2단계 D).
 *
 * 계약: docs/plans/2026-09-05-sidepanel-stage2-design.md "설계 결정"·"메시지 계약",
 * 그리고 같은 날 Codex 설계 검토 1~8 (식별자 분리, enabled 재검사, 흐름 예약 사전 검증,
 * 공용 실행 함수, 이력 이중화 방지).
 *
 * 이 파일이 못박는 것:
 *   (1) target·scheduleId 가 없는 옛 레코드를 단축으로 읽되 저장하지 않는다.
 *   (2) 흐름 예약은 공용 실행 함수를 부르고 끝나면 자기 탭을 닫는다.
 *   (3) 흐름 실행이 실패하면 스크린샷 **파일 이름**이 이력에 남는다(base64 아님).
 *   (4) loginCheck 단계가 실패하면 login_required 다.
 *   (5) 꺼진 예약은 알람도 없고 큐에 들어가도 실행되지 않는다.
 *   (6) "지금 실행" 은 예약 큐를 그대로 탄다 (trigger: manual).
 *   (7) 흐름 예약 사전 검증: 발행·시작 URL·민감 변수.
 *   (8) `chrome_shortcut action=schedules` 응답에 흐름 예약과 target 이 함께 나온다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type AnyRecord = Record<string, any>;

interface Harness {
  runner: typeof import('@/entrypoints/background/schedule-runner');
  schedule: typeof import('@/utils/shortcut-schedule');
  history: typeof import('@/utils/shortcut-history');
  shortcut: typeof import('@/entrypoints/background/tools/browser/shortcut');
  daily: typeof import('@/entrypoints/background/daily-messages');
  flowStore: typeof import('@/entrypoints/background/record-replay/flow-store');
  workTab: typeof import('@/utils/work-tab-manager');
  local: AnyRecord;
  session: AnyRecord;
  alarms: Map<string, { name: string; scheduledTime: number }>;
  alarmListeners: Array<(alarm: any) => void>;
  messageListeners: Array<(message: any, sender: any, sendResponse: any) => any>;
  notifications: AnyRecord[];
  tabs: Map<number, AnyRecord>;
  removedTabs: number[];
  toolCalls: AnyRecord[];
  flowRuns: AnyRecord[];
}

function installChrome(h: Partial<Harness>) {
  const local: AnyRecord = {};
  const session: AnyRecord = {};
  const alarms = new Map<string, { name: string; scheduledTime: number }>();
  const alarmListeners: Array<(alarm: any) => void> = [];
  const messageListeners: Array<(m: any, s: any, r: any) => any> = [];
  const notifications: AnyRecord[] = [];
  const tabs = new Map<number, AnyRecord>();
  const removedTabs: number[] = [];

  const area = (store: AnyRecord) => ({
    get: vi.fn(async (keys: any) => {
      if (keys === undefined || keys === null) return { ...store };
      const list = Array.isArray(keys) ? keys : [keys];
      const out: AnyRecord = {};
      for (const key of list) if (key in store) out[key] = store[key];
      return out;
    }),
    set: vi.fn(async (obj: AnyRecord) => {
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
      onMessage: {
        addListener: vi.fn((fn: any) => messageListeners.push(fn)),
        removeListener: vi.fn(),
      },
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
      clear: vi.fn(async () => true),
      onClicked: listener(),
    },
    downloads: {
      download: vi.fn(async () => 1),
      search: vi.fn(async () => []),
      show: vi.fn(),
    },
    tabs: {
      get: vi.fn(async (tabId: number) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id ${tabId}`);
        return tab;
      }),
      query: vi.fn(async () => Array.from(tabs.values()).filter((t) => t.active)),
      create: vi.fn(async () => ({ id: 999, windowId: 1 })),
      update: vi.fn(async () => ({})),
      remove: vi.fn(async (tabId: number) => {
        removedTabs.push(tabId);
        tabs.delete(tabId);
      }),
      group: vi.fn(async () => 100),
      ungroup: vi.fn(async () => undefined),
      onRemoved: listener(),
      onCreated: listener(),
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
      get: vi.fn(async (id: number) => ({ id })),
      getAll: vi.fn(async () => [{ id: 1 }]),
      getCurrent: vi.fn(async () => ({ id: 1 })),
      getLastFocused: vi.fn(async () => ({ id: 1 })),
      create: vi.fn(async () => ({ id: 1 })),
      update: vi.fn(async () => ({ id: 1 })),
      remove: vi.fn(async () => undefined),
      onRemoved: listener(),
      onFocusChanged: listener(),
      WINDOW_ID_NONE: -1,
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
    messageListeners,
    notifications,
    tabs,
    removedTabs,
  });
}

async function setup(): Promise<Harness> {
  vi.resetModules();
  const h: Partial<Harness> = {};
  installChrome(h);
  h.toolCalls = [];
  h.flowRuns = [];
  h.runner = await import('@/entrypoints/background/schedule-runner');
  h.schedule = await import('@/utils/shortcut-schedule');
  h.history = await import('@/utils/shortcut-history');
  h.shortcut = await import('@/entrypoints/background/tools/browser/shortcut');
  h.flowStore = await import('@/entrypoints/background/record-replay/flow-store');
  h.workTab = await import('@/utils/work-tab-manager');
  h.daily = await import('@/entrypoints/background/daily-messages');
  h.daily.initDailyMessages();
  return h as Harness;
}

const okText = (payload: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(payload) }],
  isError: false,
});

function body(result: any) {
  return JSON.parse(result.content[0].text);
}

/** 메시지 하나를 보내고 응답을 기다린다 (백그라운드 리스너를 직접 부른다). */
function send(h: Harness, message: AnyRecord): Promise<AnyRecord> {
  return new Promise((resolve, reject) => {
    let handled = false;
    for (const listener of h.messageListeners) {
      const kept = listener(message, { id: chrome.runtime.id }, (payload: AnyRecord) => {
        handled = true;
        resolve(payload);
      });
      if (kept === true) {
        handled = true;
        return;
      }
    }
    if (!handled) reject(new Error(`no listener handled ${String(message.type)}`));
  });
}

async function settle(times = 40) {
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const FLOW_ID = 'flow-daily-1';
const FLOW_START_URL = 'https://example.com/board';
const WORK_TAB_ID = 555;

/** 발행된 흐름 하나를 만든다. */
async function seedFlow(h: Harness, over: AnyRecord = {}): Promise<{ id: string; name: string }> {
  const flow = {
    id: FLOW_ID,
    name: '게시판 확인',
    version: 1,
    variables: [],
    startUrl: FLOW_START_URL,
    nodes: [{ id: 'n1', type: 'navigate', config: { url: FLOW_START_URL } }],
    edges: [],
    meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ...over,
  } as any;
  await h.flowStore.saveFlow(flow, { notify: false });
  if (over.publish !== false) await h.flowStore.publishFlow(flow);
  return { id: flow.id, name: flow.name };
}

/**
 * 공용 실행 함수 대역. 진짜 `runPublishedFlow` 대신 꽂아, 예약 러너가 무엇을 넘기는지와
 * 결과를 어떻게 이력에 옮기는지만 본다 (흐름 엔진 자체는 다른 스위트가 덮는다).
 */
function wireFlowRunner(h: Harness, result: AnyRecord) {
  h.runner.setScheduledFlowRunner((async (input: any, invoke: any) => {
    h.flowRuns.push(input);
    // 실제 함수와 같은 자리에서 작업 탭을 만든다: chrome_navigate 가 만들고 세션이 소유한다.
    await invoke({
      name: 'chrome_navigate',
      args: {
        url: FLOW_START_URL,
        background: true,
        _mcpSessionId: 'scheduled',
        lane: input.lane,
      },
      effectiveBackgroundMode: true,
    });
    return result;
  }) as never);
}

/** 도구 호출 대역. navigate 는 작업 탭을 만들고, screenshot 은 파일 이름을 돌려준다. */
function wireInvoker(h: Harness, scheduleId: string) {
  const sessionKey = h.runner.scheduledSessionKey(scheduleId);
  h.runner.setScheduleToolInvoker(async (call: any) => {
    h.toolCalls.push({ name: call.name, args: call.args, mode: call.effectiveBackgroundMode });
    if (call.name === 'chrome_navigate') {
      h.tabs.set(WORK_TAB_ID, { id: WORK_TAB_ID, windowId: 1, active: false, url: FLOW_START_URL });
      await h.workTab.addOwnedTab(WORK_TAB_ID, sessionKey);
      await h.workTab.setWorkTab(WORK_TAB_ID, sessionKey, true);
      return okText({ success: true, tabId: WORK_TAB_ID });
    }
    if (call.name === 'chrome_screenshot') {
      return okText({
        success: true,
        filename: `mcp-screenshots/2026-09-05/failure_${call.args?.name}_120000.png`,
      });
    }
    return okText({ success: true });
  });
  return { sessionKey };
}

let h: Harness;

beforeEach(async () => {
  h = await setup();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('1. target·scheduleId 가 없는 옛 레코드는 읽을 때만 보정한다', () => {
  it('키가 곧 단축 이름이던 레코드를 shortcut 예약으로 읽는다', async () => {
    const now = Date.now();
    h.local.mcpShortcutSchedules = {
      job: {
        name: 'job',
        schedule: { every: '1h' },
        notify: true,
        report: false,
        nextAt: now + 60_000,
        anchorAt: now,
        revision: 3,
        createdAt: now,
        updatedAt: now,
        timeZone: 'Asia/Seoul',
        offsetMinutes: -540,
        failStreak: 0,
      },
    };

    const map = await h.schedule.readSchedules();

    expect(Object.keys(map)).toEqual(['shortcut:job']);
    const record = map['shortcut:job'];
    expect(record.scheduleId).toBe('shortcut:job');
    expect(record.target).toEqual({ kind: 'shortcut', name: 'job' });
    expect(record.enabled).toBe(true);
    // 보정은 메모리에서만 한다: revision·generation 이 흔들리면 정상 실행이 superseded 된다.
    expect(record.revision).toBe(3);
    expect(record.generation).toBe(0);
  });

  it('읽기만 해서는 저장소에 쓰지 않는다', async () => {
    h.local.mcpShortcutSchedules = {
      job: { name: 'job', schedule: { every: '1h' }, notify: true, report: false, nextAt: 1 },
    };
    (chrome.storage.local.set as any).mockClear();

    await h.schedule.readSchedules();
    await h.schedule.readSchedule('shortcut:job');

    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });
});

describe('7. 흐름 예약은 스스로 돌 수 있는 흐름만 받는다', () => {
  it('발행되지 않은 흐름은 flow_not_published 로 거절한다', async () => {
    await seedFlow(h, { publish: false });
    const res = await send(h, {
      type: 'daily_put_schedule',
      target: { kind: 'flow', flowId: FLOW_ID },
      schedule: { every: '1h' },
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('flow_not_published');
  });

  it('시작 URL 이 없는 흐름은 flow_start_url_required 로 거절한다', async () => {
    await seedFlow(h, { startUrl: undefined });
    const res = await send(h, {
      type: 'daily_put_schedule',
      target: { kind: 'flow', flowId: FLOW_ID },
      schedule: { every: '1h' },
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('flow_start_url_required');
  });

  it('민감 변수가 있는 흐름은 flow_has_sensitive_vars 로 거절한다', async () => {
    await seedFlow(h, {
      variables: [{ key: 'pw', label: '비밀번호', sensitive: true }],
    });
    const res = await send(h, {
      type: 'daily_put_schedule',
      target: { kind: 'flow', flowId: FLOW_ID },
      schedule: { every: '1h' },
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('flow_has_sensitive_vars');
  });

  it('조건을 갖춘 흐름은 예약되고 알람이 하나 걸린다', async () => {
    const flow = await seedFlow(h);
    const res = await send(h, {
      type: 'daily_put_schedule',
      target: { kind: 'flow', flowId: FLOW_ID },
      schedule: { daily: ['08:00'] },
    });

    expect(res.success).toBe(true);
    const view = res.schedule as AnyRecord;
    expect(view.scheduleId).toBe(`flow:${FLOW_ID}`);
    expect(view.kind).toBe('flow');
    expect(view.label).toBe(flow.name);
    expect(view.enabled).toBe(true);
    expect(h.alarms.get(`mcp-shortcut::flow:${FLOW_ID}`)?.scheduledTime).toBe(view.nextAt);
  });
});

describe('2·3·4. 흐름 예약 실행', () => {
  async function scheduleFlow(over: AnyRecord = {}) {
    await seedFlow(h);
    const res = await send(h, {
      type: 'daily_put_schedule',
      target: { kind: 'flow', flowId: FLOW_ID },
      schedule: { every: '1h' },
      ...over,
    });
    expect(res.success).toBe(true);
    return res.schedule as AnyRecord;
  }

  function fireAlarm(view: AnyRecord) {
    h.alarmListeners[0]({
      name: `mcp-shortcut::flow:${FLOW_ID}`,
      scheduledTime: view.nextAt,
    });
  }

  it('(2) 공용 실행 함수를 부르고 끝나면 자기 탭을 닫는다', async () => {
    const scheduleId = `flow:${FLOW_ID}`;
    wireInvoker(h, scheduleId);
    wireFlowRunner(h, {
      ok: true,
      flowId: FLOW_ID,
      flowName: '게시판 확인',
      tabId: WORK_TAB_ID,
      tabSource: 'created_from_start_url',
      result: { runId: 'r1', success: true, summary: {}, logs: [], outputs: { latest: '10423' } },
    });
    const view = await scheduleFlow();

    fireAlarm(view);
    await settle(80);

    expect(h.flowRuns).toHaveLength(1);
    expect(h.flowRuns[0]).toMatchObject({
      flowId: FLOW_ID,
      mcpSessionId: 'scheduled',
      lane: scheduleId,
      // 이력 이중화 방지: 흐름 엔진의 자기 이력은 끈다.
      persistRun: false,
    });
    // 예약이 연 작업 탭은 실행이 끝나면 닫힌다.
    expect(h.removedTabs).toContain(WORK_TAB_ID);

    const map = await h.history.readHistory();
    const run = map[scheduleId][0];
    expect(run.status).toBe('success');
    expect(run.label).toBe('게시판 확인');
    expect(run.trigger).toBe('scheduled');
    expect(run.results?.latest).toBe('10423');
  });

  it('(3) 실패하면 스크린샷 파일 이름이 이력에 남는다 (base64 아님)', async () => {
    const scheduleId = `flow:${FLOW_ID}`;
    wireInvoker(h, scheduleId);
    wireFlowRunner(h, {
      ok: true,
      flowId: FLOW_ID,
      flowName: '게시판 확인',
      tabId: WORK_TAB_ID,
      tabSource: 'created_from_start_url',
      result: {
        runId: 'r2',
        success: false,
        summary: {},
        logs: [
          { stepId: 'n1', status: 'success' },
          { stepId: 'n2', status: 'failed', message: 'selector_not_found: .row' },
        ],
      },
    });
    const view = await scheduleFlow();

    fireAlarm(view);
    await settle(80);

    const map = await h.history.readHistory();
    const run = map[scheduleId][0];
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('selector_not_found');
    expect(run.failedStep).toMatchObject({ stepId: 'n2' });
    expect(run.screenshot).toMatch(/^mcp-screenshots\/\d{4}-\d{2}-\d{2}\/failure_.+\.png$/);
    // 이력에 이미지 본문이 들어가지 않는다.
    expect(JSON.stringify(run)).not.toContain('base64');
  });

  it('(4) loginCheck 단계가 실패하면 login_required 다', async () => {
    const scheduleId = `flow:${FLOW_ID}`;
    wireInvoker(h, scheduleId);
    wireFlowRunner(h, {
      ok: true,
      flowId: FLOW_ID,
      flowName: '게시판 확인',
      tabId: WORK_TAB_ID,
      tabSource: 'created_from_start_url',
      result: {
        runId: 'r3',
        success: false,
        summary: {},
        logs: [{ stepId: 'login-check', status: 'failed', message: 'not_found: 로그아웃 버튼' }],
      },
    });
    const view = await scheduleFlow({ loginCheck: 'login-check' });

    fireAlarm(view);
    await settle(80);

    const map = await h.history.readHistory();
    expect(map[scheduleId][0].status).toBe('login_required');
    expect(map[scheduleId][0].errorCode).toBe('login_required');
  });

  it('(4-대조) 다른 단계가 실패하면 그냥 failed 다', () => {
    const classification = h.runner.classifyFlowRunOutcome(
      {
        ok: true,
        flowId: FLOW_ID,
        flowName: 'x',
        tabId: 1,
        tabSource: 'work_tab',
        result: {
          runId: 'r',
          success: false,
          summary: { total: 1, success: 0, failed: 1, tookMs: 1 },
          logs: [{ stepId: 'other', status: 'failed', message: 'boom' }],
        } as any,
      },
      { loginCheck: 'login-check' },
    );
    expect(classification.status).toBe('failed');
  });
});

describe('5. 꺼진 예약은 알람도 실행도 없다', () => {
  it('끄면 알람이 사라지고 큐에 들어가도 실행되지 않는다', async () => {
    const scheduleId = `flow:${FLOW_ID}`;
    wireInvoker(h, scheduleId);
    wireFlowRunner(h, {
      ok: true,
      flowId: FLOW_ID,
      flowName: '게시판 확인',
      tabId: WORK_TAB_ID,
      tabSource: 'created_from_start_url',
      result: { runId: 'r', success: true, summary: {}, logs: [] },
    });
    await seedFlow(h);
    const created = await send(h, {
      type: 'daily_put_schedule',
      target: { kind: 'flow', flowId: FLOW_ID },
      schedule: { every: '1h' },
    });
    const view = created.schedule as AnyRecord;

    const off = await send(h, { type: 'daily_set_enabled', scheduleId, enabled: false });
    expect(off.success).toBe(true);
    expect((off.schedule as AnyRecord).enabled).toBe(false);
    expect(h.alarms.has(`mcp-shortcut::${scheduleId}`)).toBe(false);

    // 알람이 이미 울린 뒤에 껐더라도 실행 직전 재검사에서 걸러진다.
    h.runner.enqueueScheduledRun(scheduleId, view.nextAt);
    await settle(60);

    expect(h.flowRuns).toHaveLength(0);
    const map = await h.history.readHistory();
    expect(map[scheduleId]).toBeUndefined();

    // 다시 켜면 알람이 되돌아온다.
    const on = await send(h, { type: 'daily_set_enabled', scheduleId, enabled: true });
    expect((on.schedule as AnyRecord).enabled).toBe(true);
    expect(h.alarms.has(`mcp-shortcut::${scheduleId}`)).toBe(true);
  });
});

describe('6. 지금 실행은 예약 큐를 그대로 탄다', () => {
  it('runId 를 돌려주고 trigger:manual 로 이력에 남는다', async () => {
    const scheduleId = `flow:${FLOW_ID}`;
    wireInvoker(h, scheduleId);
    wireFlowRunner(h, {
      ok: true,
      flowId: FLOW_ID,
      flowName: '게시판 확인',
      tabId: WORK_TAB_ID,
      tabSource: 'created_from_start_url',
      result: { runId: 'r', success: true, summary: {}, logs: [] },
    });
    await seedFlow(h);
    await send(h, {
      type: 'daily_put_schedule',
      target: { kind: 'flow', flowId: FLOW_ID },
      schedule: { every: '1h' },
    });

    const res = await send(h, { type: 'daily_run_now', scheduleId });
    expect(res.success).toBe(true);
    expect(String(res.runId)).toContain(scheduleId);
    await settle(80);

    const map = await h.history.readHistory();
    expect(map[scheduleId]).toHaveLength(1);
    expect(map[scheduleId][0].trigger).toBe('manual');
    expect(map[scheduleId][0].status).toBe('success');
    expect(h.flowRuns).toHaveLength(1);
  });

  it('이력 조회는 scheduleId 로 좁히고 results 본문을 싣지 않는다', async () => {
    const scheduleId = `flow:${FLOW_ID}`;
    wireInvoker(h, scheduleId);
    wireFlowRunner(h, {
      ok: true,
      flowId: FLOW_ID,
      flowName: '게시판 확인',
      tabId: WORK_TAB_ID,
      tabSource: 'created_from_start_url',
      result: { runId: 'r', success: true, summary: {}, logs: [], outputs: { latest: '1' } },
    });
    await seedFlow(h);
    await send(h, {
      type: 'daily_put_schedule',
      target: { kind: 'flow', flowId: FLOW_ID },
      schedule: { every: '1h' },
    });
    const started = await send(h, { type: 'daily_run_now', scheduleId });
    await settle(80);

    const page = await send(h, { type: 'daily_history', scheduleId, limit: 20 });
    expect(page.success).toBe(true);
    expect(page.runs as AnyRecord[]).toHaveLength(1);
    expect((page.runs as AnyRecord[])[0].results).toBeUndefined();
    expect((page.runs as AnyRecord[])[0].resultsChars).toBeGreaterThan(0);
    expect(page.nextCursor).toBeUndefined();

    const one = await send(h, { type: 'daily_get_run', runId: started.runId });
    expect((one.run as AnyRecord).results).toEqual({ latest: '1' });
  });
});

describe('8. chrome_shortcut 응답에 흐름 예약과 target 이 함께 나온다', () => {
  it('schedules 목록에 단축과 흐름이 같이 보인다', async () => {
    // 단축 하나
    await h.shortcut.shortcutTool.execute({
      action: 'save',
      name: 'board-watch',
      templates: true,
      steps: [{ tool: 'chrome_navigate', args: { url: 'https://board.example.com/list' } }],
    } as any);
    await h.shortcut.shortcutTool.execute({
      action: 'schedule',
      name: 'board-watch',
      schedule: { every: '6h' },
    } as any);

    // 흐름 하나
    await seedFlow(h);
    await send(h, {
      type: 'daily_put_schedule',
      target: { kind: 'flow', flowId: FLOW_ID },
      schedule: { every: '1h' },
    });

    const listed = body(await h.shortcut.shortcutTool.execute({ action: 'schedules' } as any));
    const byKind = Object.fromEntries(
      (listed.schedules as AnyRecord[]).map((s) => [s.kind, s]),
    ) as AnyRecord;

    expect(byKind.shortcut).toMatchObject({
      scheduleId: 'shortcut:board-watch',
      label: 'board-watch',
      target: { kind: 'shortcut', name: 'board-watch' },
      enabled: true,
    });
    expect(byKind.flow).toMatchObject({
      scheduleId: `flow:${FLOW_ID}`,
      label: '게시판 확인',
      target: { kind: 'flow', flowId: FLOW_ID },
      enabled: true,
    });
  });
});

describe('9. 이 버전 이전의 예약도 계속 돈다 (알람 이름·이력 키 전환)', () => {
  /** target·scheduleId 가 없던 시절의 레코드와 그때의 알람. */
  function seedLegacySchedule(nextAt: number) {
    const now = Date.now();
    h.local.mcpShortcutSchedules = {
      job: {
        name: 'job',
        schedule: { every: '1h' },
        notify: true,
        report: false,
        nextAt,
        anchorAt: now,
        revision: 2,
        generation: 5,
        createdAt: now,
        updatedAt: now,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? '',
        offsetMinutes: new Date(now).getTimezoneOffset(),
        failStreak: 0,
      },
    };
    h.alarms.set('mcp-shortcut::job', { name: 'mcp-shortcut::job', scheduledTime: nextAt });
  }

  it('옛 이름 알람을 걷고 scheduleId 알람으로 다시 무장한다', async () => {
    const nextAt = Date.now() + 60 * 60_000;
    seedLegacySchedule(nextAt);

    await h.runner.reconcileSchedules();
    await settle(40);

    expect(h.alarms.has('mcp-shortcut::job')).toBe(false);
    expect(h.alarms.get('mcp-shortcut::shortcut:job')?.scheduledTime).toBe(nextAt);
    // 보정이 예약을 새 것으로 만들지 않는다 (실행 중이던 run 이 superseded 되면 안 된다).
    const record = await h.schedule.readSchedule('shortcut:job');
    expect(record?.revision).toBe(2);
    expect(record?.generation).toBe(5);
  });

  it('이름 키에 쌓인 옛 이력이 매일 작업 목록에서 사라지지 않는다', async () => {
    const now = Date.now();
    seedLegacySchedule(now + 60 * 60_000);
    // 옛 버전이 남긴 이력(이름 키)과 이번 버전이 남긴 이력(scheduleId 키).
    h.local.mcpShortcutHistory = {
      job: [
        {
          runId: 'job:2026-09-04T00:00:00.000Z',
          name: 'job',
          trigger: 'scheduled',
          status: 'success',
          startedAt: now - 86_400_000,
        },
      ],
      'shortcut:job': [
        {
          runId: 'shortcut:job:2026-09-05T00:00:00.000Z',
          name: 'shortcut:job',
          label: 'job',
          trigger: 'scheduled',
          status: 'failed',
          startedAt: now - 3_600_000,
        },
      ],
    };

    const page = await send(h, { type: 'daily_history', scheduleId: 'shortcut:job' });

    expect(page.success).toBe(true);
    const runs = page.runs as AnyRecord[];
    expect(runs).toHaveLength(2);
    // 최신이 앞이고, 옛 기록도 함께 보인다.
    expect(runs[0].runId).toBe('shortcut:job:2026-09-05T00:00:00.000Z');
    expect(runs[1].runId).toBe('job:2026-09-04T00:00:00.000Z');
    expect(page.matched).toBe(2);
  });

  it('같은 runId 가 두 키에 있으면 한 번만 싣는다', async () => {
    const now = Date.now();
    const shared = {
      runId: 'job:2026-09-04T00:00:00.000Z',
      trigger: 'scheduled',
      status: 'success',
      startedAt: now - 1000,
    };
    h.local.mcpShortcutHistory = {
      job: [{ ...shared, name: 'job' }],
      'shortcut:job': [{ ...shared, name: 'shortcut:job' }],
    };

    const page = await send(h, { type: 'daily_history', scheduleId: 'shortcut:job' });

    expect(page.runs as AnyRecord[]).toHaveLength(1);
    expect(page.matched).toBe(1);
  });
});

describe('10. 매일 작업 메시지는 값을 그대로 믿지 않는다', () => {
  it('다른 확장이 보낸 메시지는 다루지 않는다', async () => {
    const res = await new Promise<AnyRecord>((resolve) => {
      for (const listener of h.messageListeners) {
        const kept = listener(
          { type: 'daily_list_schedules' },
          { id: 'some-other-extension' },
          (payload: AnyRecord) => resolve(payload),
        );
        if (kept === true) return;
      }
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('forbidden_sender');
  });

  it('우리 형식이 아닌 scheduleId 는 거절한다', async () => {
    const res = await send(h, { type: 'daily_run_now', scheduleId: '../../etc/passwd' });
    expect(res.errorCode).toBe('schedule_id_invalid');
  });

  it('enabled 는 불리언이어야 한다 (문자열 "false" 로 켜지지 않는다)', async () => {
    const res = await send(h, {
      type: 'daily_set_enabled',
      scheduleId: `flow:${FLOW_ID}`,
      enabled: 'false',
    });
    expect(res.errorCode).toBe('enabled_invalid');
  });

  it('모르는 상태 이름으로는 이력을 거를 수 없다', async () => {
    const res = await send(h, { type: 'daily_history', status: ['success', 'nope'] });
    expect(res.errorCode).toBe('status_invalid');
  });

  it('커서·개수는 형식을 지켜야 한다', async () => {
    expect((await send(h, { type: 'daily_history', cursor: 'abc' })).errorCode).toBe(
      'cursor_invalid',
    );
    expect((await send(h, { type: 'daily_history', limit: 9999 })).errorCode).toBe('limit_invalid');
  });

  it('스크린샷은 예약 러너가 만드는 경로 모양만 연다', async () => {
    const bad = await send(h, {
      type: 'daily_open_screenshot',
      filename: '../../Users/user/Documents/secret.pdf',
    });
    expect(bad.success).toBe(false);
    expect(bad.errorCode).toBe('sidepanel_screenshot_missing');
    expect(chrome.downloads.show).not.toHaveBeenCalled();

    (chrome.downloads.search as any).mockResolvedValueOnce([{ id: 7 }]);
    const good = await send(h, {
      type: 'daily_open_screenshot',
      filename: 'mcp-screenshots/2026-09-05/failure_job_120000.png',
    });
    expect(good.success).toBe(true);
    expect(chrome.downloads.show).toHaveBeenCalledWith(7);
  });
});

describe('11. 결과 가공이 실패해도 예약이 연 탭은 남지 않는다', () => {
  it('정리가 보호된 finally 에서 돈다 (Codex 코드 리뷰 2)', async () => {
    const scheduleId = `flow:${FLOW_ID}`;
    wireInvoker(h, scheduleId);
    // 결과를 읽는 순간 던지는 값. 예전에는 이 경우 finally 가 타이머만 끄고 탭·스폰
    // 스코프를 그대로 남겼다 (다음 reconcile 이 고아 탭으로 걷어 갈 때까지).
    h.runner.setScheduledFlowRunner((async (input: any, invoke: any) => {
      h.flowRuns.push(input);
      await invoke({
        name: 'chrome_navigate',
        args: {
          url: 'https://example.com/board',
          background: true,
          _mcpSessionId: 'scheduled',
          lane: input.lane,
        },
        effectiveBackgroundMode: true,
      });
      return {
        ok: true,
        flowId: FLOW_ID,
        flowName: '게시판 확인',
        tabId: WORK_TAB_ID,
        tabSource: 'created_from_start_url',
        result: {
          runId: 'r',
          success: true,
          get logs(): never {
            throw new Error('결과를 읽는 중 실패');
          },
        },
      };
    }) as never);

    await seedFlow(h);
    const created = await send(h, {
      type: 'daily_put_schedule',
      target: { kind: 'flow', flowId: FLOW_ID },
      schedule: { every: '1h' },
    });
    const view = created.schedule as AnyRecord;

    h.alarmListeners[0]({ name: `mcp-shortcut::${scheduleId}`, scheduledTime: view.nextAt });
    await settle(80);

    // 실행은 실패했지만 그 실행이 연 백그라운드 탭은 닫혔다.
    expect(h.flowRuns).toHaveLength(1);
    expect(h.removedTabs).toContain(WORK_TAB_ID);
    expect(
      await h.workTab.getSessionScopedTabIds(h.runner.scheduledSessionKey(scheduleId)),
    ).toEqual([]);
  });
});
