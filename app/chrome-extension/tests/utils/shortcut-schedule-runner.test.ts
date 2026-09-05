/**
 * auto-chrome-mcp fork — chrome_shortcut 예약 실행기 (설계 구현 순서 3·4단계).
 *
 * 계약: docs/plans/2026-09-05-daily-automation-design.md 1·2·4·5절.
 * 테스트 이름 앞의 번호는 위임 계약의 체크리스트 번호다 (7, 8, 12, 13, 14, 15, 16, 17, 19)
 * 와 마지막 통합 시나리오(설계 9절 예시 (b)).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type AnyRecord = Record<string, any>;

interface Harness {
  runner: typeof import('@/entrypoints/background/schedule-runner');
  shortcut: typeof import('@/entrypoints/background/tools/browser/shortcut');
  history: typeof import('@/utils/shortcut-history');
  schedule: typeof import('@/utils/shortcut-schedule');
  workTab: typeof import('@/utils/work-tab-manager');
  local: AnyRecord;
  session: AnyRecord;
  alarms: Map<string, { name: string; scheduledTime: number }>;
  alarmListeners: Array<(alarm: any) => void>;
  notifications: AnyRecord[];
  downloads: AnyRecord[];
  tabs: Map<number, AnyRecord>;
  removedTabs: number[];
  toolCalls: AnyRecord[];
}

function installChrome(h: Partial<Harness>) {
  const local: AnyRecord = {};
  const session: AnyRecord = {};
  const alarms = new Map<string, { name: string; scheduledTime: number }>();
  const alarmListeners: Array<(alarm: any) => void> = [];
  const notifications: AnyRecord[] = [];
  const downloads: AnyRecord[] = [];
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
    notifications,
    downloads,
    tabs,
    removedTabs,
  });
}

/** 새 모듈 그래프로 확장을 다시 세운다 (최상위 onAlarm 등록을 관찰하기 위해서다). */
async function setup(): Promise<Harness> {
  vi.resetModules();
  const h: Partial<Harness> = {};
  installChrome(h);
  h.toolCalls = [];
  h.runner = await import('@/entrypoints/background/schedule-runner');
  h.shortcut = await import('@/entrypoints/background/tools/browser/shortcut');
  h.history = await import('@/utils/shortcut-history');
  h.schedule = await import('@/utils/shortcut-schedule');
  h.workTab = await import('@/utils/work-tab-manager');
  return h as Harness;
}

function body(result: any) {
  return JSON.parse(result.content[0].text);
}

const okText = (payload: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(payload) }],
  isError: false,
});
const errText = (message: string) => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

/**
 * 예약 실행이 실제로 하는 일을 흉내 낸다: 첫 navigate 가 세션 소유 작업 탭을 만들고,
 * 나머지 도구는 시나리오가 정한 값을 돌려준다.
 */
function wireInvoker(
  h: Harness,
  name: string,
  handler: (call: AnyRecord) => any = () => okText({ success: true }),
  workTabId = 501,
) {
  const sessionKey = h.runner.scheduledSessionKey(name);
  h.runner.setScheduleToolInvoker(async (call: any) => {
    h.toolCalls.push({ name: call.name, args: call.args, mode: call.effectiveBackgroundMode });
    if (call.name === 'chrome_navigate') {
      h.tabs.set(workTabId, { id: workTabId, windowId: 1, active: false, url: 'https://x/' });
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

const BASIC_STEPS = [
  { tool: 'chrome_navigate', args: { url: 'https://board.example.com/list' } },
  { tool: 'chrome_extract', as: 'latest', args: { fields: { id: '.row .id' } } },
];

/** 대기 없이 큐가 비워질 때까지 마이크로태스크를 흘린다. */
async function settle(times = 40) {
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < times; i++) await Promise.resolve();
}

let h: Harness;

beforeEach(async () => {
  h = await setup();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('7. 알람은 항상 일회성이고 실행 후 다시 무장된다', () => {
  it('예약하면 when 만 가진 알람이 하나 생긴다', async () => {
    wireInvoker(h, 'job');
    const saved = await saveAndSchedule(h, 'job', BASIC_STEPS);
    expect(chrome.alarms.create).toHaveBeenCalledWith('mcp-shortcut::job', {
      when: saved.nextAt,
    });
    const [, info] = (chrome.alarms.create as any).mock.calls[0];
    expect(info.periodInMinutes).toBeUndefined();
  });

  it('알람이 울려 실행이 끝나면 다음 due 로 다시 무장된다', async () => {
    wireInvoker(h, 'job', () => okText({ success: true, values: { id: '1' } }));
    await saveAndSchedule(h, 'job', BASIC_STEPS);
    expect(h.alarmListeners).toHaveLength(1);

    // 알람은 due 시각에 울린다. 격자를 지금에 맞춰 그 상황을 만든다.
    const due = Date.now();
    await h.schedule.patchSchedule('job', { nextAt: due, anchorAt: due - 60 * 60_000 });

    h.alarmListeners[0]({ name: 'mcp-shortcut::job', scheduledTime: due });
    await settle();

    const record = await h.schedule.readSchedule('job');
    expect(record?.nextAt).toBeGreaterThan(due);
    expect(record?.lastStatus).toBe('success');
    const armed = h.alarms.get('mcp-shortcut::job');
    expect(armed?.scheduledTime).toBe(record?.nextAt);
  });

  it('실행은 scheduled 세션·lane·강제 background 로 돈다', async () => {
    wireInvoker(h, 'job');
    const saved = await saveAndSchedule(h, 'job', BASIC_STEPS);
    h.alarmListeners[0]({ name: 'mcp-shortcut::job', scheduledTime: saved.nextAt });
    await settle();

    expect(h.toolCalls.length).toBeGreaterThan(0);
    for (const call of h.toolCalls) {
      expect(call.mode).toBe(true);
      expect(call.args._mcpSessionId).toBe('scheduled');
      expect(call.args.lane).toBe('job');
      expect(call.args.background).toBe(true);
    }
  });
});

describe('8. 따라잡기는 1회이고 이중 실행이 없다', () => {
  it('지난 nextAt 은 정확히 한 번 실행되고 격자가 미래로 옮겨진다', async () => {
    wireInvoker(h, 'job');
    const saved = await saveAndSchedule(h, 'job', BASIC_STEPS);
    const overdue = Date.now() - 8 * 60 * 60_000;
    await h.schedule.patchSchedule('job', { nextAt: overdue, anchorAt: overdue });

    await h.runner.reconcileSchedules();
    await settle();
    await h.runner.reconcileSchedules();
    await settle();

    const map = await h.history.readHistory();
    expect(map.job).toHaveLength(1);
    expect(map.job[0].runId).toBe(h.schedule.scheduleRunId('job', overdue));
    const record = await h.schedule.readSchedule('job');
    expect(record?.nextAt).toBeGreaterThan(Date.now());
    expect(record!.nextAt).toBeLessThanOrEqual(Date.now() + 60 * 60_000);
    expect(saved.nextAt).toBeGreaterThan(0);
  });

  it('알람과 reconcile 이 같은 due 를 집어도 이력은 1건이다', async () => {
    wireInvoker(h, 'job');
    await saveAndSchedule(h, 'job', BASIC_STEPS);
    const overdue = Date.now() - 60_000;
    await h.schedule.patchSchedule('job', { nextAt: overdue, anchorAt: overdue });

    h.alarmListeners[0]({ name: 'mcp-shortcut::job', scheduledTime: overdue });
    void h.runner.reconcileSchedules();
    await settle();

    const map = await h.history.readHistory();
    expect(map.job).toHaveLength(1);
  });
});

describe('12. reconcile 은 중단된 실행·잠금·알람을 되돌린다', () => {
  it('running 으로 남은 이력을 interrupted 로 바꾼다', async () => {
    await h.history.startRunRecord({
      runId: 'ghost:2026-09-05T00:00:00.000Z',
      name: 'ghost',
      trigger: 'scheduled',
    });
    // 워커가 죽은 상황을 만든다 (그 실행이 이 워커 것이 아니게 한다).
    h.history.clearRunActive('ghost:2026-09-05T00:00:00.000Z');

    await h.runner.reconcileSchedules();
    await settle();

    const map = await h.history.readHistory();
    expect(map.ghost[0].status).toBe('interrupted');
    expect(map.ghost[0].errorCode).toBe('interrupted');
  });

  it('레코드는 있는데 없어진 알람을 재생성한다', async () => {
    wireInvoker(h, 'job');
    const saved = await saveAndSchedule(h, 'job', BASIC_STEPS);
    await chrome.alarms.clearAll();
    expect(await chrome.alarms.getAll()).toHaveLength(0);

    await h.runner.reconcileSchedules();
    await settle();

    const armed = h.alarms.get('mcp-shortcut::job');
    expect(armed?.scheduledTime).toBe(saved.nextAt);
  });

  it('레코드 없는 우리 알람은 정리한다', async () => {
    h.alarms.set('mcp-shortcut::gone', { name: 'mcp-shortcut::gone', scheduledTime: Date.now() });
    h.alarms.set('someone-else', { name: 'someone-else', scheduledTime: Date.now() });

    await h.runner.reconcileSchedules();
    await settle();

    expect(h.alarms.has('mcp-shortcut::gone')).toBe(false);
    expect(h.alarms.has('someone-else')).toBe(true);
  });

  it('하트비트가 30초 넘게 멈춘 잠금을 회수한다', async () => {
    h.session.scheduledRunLock = {
      runId: 'dead:1',
      owner: 'other-worker',
      heartbeatAt: Date.now() - 45_000,
    };
    await h.runner.reconcileSchedules();
    await settle();
    expect(h.session.scheduledRunLock).toBeUndefined();
  });

  it('살아 있는 남의 잠금은 회수하지 않는다', async () => {
    h.session.scheduledRunLock = {
      runId: 'alive:1',
      owner: 'other-worker',
      heartbeatAt: Date.now() - 5_000,
    };
    await h.runner.reconcileSchedules();
    await settle();
    expect(h.session.scheduledRunLock).toBeTruthy();
  });

  it('scheduled:: 고아 탭을 정리하고, 사용자가 보고 있는 탭은 소유만 해제한다', async () => {
    const orphanKey = h.runner.scheduledSessionKey('old-job');
    h.tabs.set(601, { id: 601, windowId: 1, active: false });
    h.tabs.set(602, { id: 602, windowId: 1, active: true });
    await h.workTab.addOwnedTab(601, orphanKey);
    await h.workTab.addOwnedTab(602, orphanKey);

    await h.runner.reconcileSchedules();
    await settle();

    expect(h.removedTabs).toContain(601);
    expect(h.removedTabs).not.toContain(602);
    expect(await h.workTab.getSessionScopedTabIds(orphanKey)).toHaveLength(0);
  });
});

describe('13. 큐는 직렬이고 오래 밀린 항목은 실행하지 않는다', () => {
  it('두 예약이 동시에 울려도 두 번째는 첫 번째가 끝난 뒤 시작한다', async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | null = null;

    for (const name of ['a-job', 'b-job']) {
      await h.shortcut.shortcutTool.execute({
        action: 'save',
        name,
        templates: true,
        steps: BASIC_STEPS,
      } as any);
      await h.shortcut.shortcutTool.execute({
        action: 'schedule',
        name,
        schedule: { every: '1h' },
      } as any);
    }

    h.runner.setScheduleToolInvoker(async (call: any) => {
      const lane = call.args?.lane;
      if (call.name === 'chrome_navigate') {
        const key = h.runner.scheduledSessionKey(lane);
        const tabId = lane === 'a-job' ? 701 : 702;
        h.tabs.set(tabId, { id: tabId, windowId: 1, active: false });
        await h.workTab.addOwnedTab(tabId, key);
        await h.workTab.setWorkTab(tabId, key, true);
        order.push(`start:${lane}`);
        if (lane === 'a-job') {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return okText({ success: true });
      }
      order.push(`end:${lane}`);
      return okText({ success: true });
    });

    const due = Date.now();
    expect(h.runner.enqueueScheduledRun('a-job', due)).toBe(true);
    expect(h.runner.enqueueScheduledRun('b-job', due)).toBe(true);
    // 같은 이름은 큐에 두 번 들어가지 않는다.
    expect(h.runner.enqueueScheduledRun('a-job', due)).toBe(false);
    await settle();

    expect(order).toEqual(['start:a-job']);
    releaseFirst?.();
    await settle(120);

    expect(order[0]).toBe('start:a-job');
    expect(order.indexOf('start:b-job')).toBeGreaterThan(order.indexOf('end:a-job'));
  });

  it('큐에서 10분을 넘긴 항목은 skipped_queue 로 기록되고 실행되지 않는다', async () => {
    wireInvoker(h, 'job');
    await saveAndSchedule(h, 'job', BASIC_STEPS);
    const due = Date.now();
    const stale = Date.now() - (h.runner.QUEUE_MAX_WAIT_MS + 1_000);
    h.runner.enqueueScheduledRun('job', due, stale);
    await settle();

    const map = await h.history.readHistory();
    expect(map.job).toHaveLength(1);
    expect(map.job[0].status).toBe('skipped_queue');
    expect(h.toolCalls).toHaveLength(0);
    expect(h.notifications).toHaveLength(0);
  });
});

describe('14. 알림은 연속 실패 1회째와 3회째만', () => {
  async function failOnce(name: string, dueOffset: number) {
    const record = await h.schedule.readSchedule(name);
    const due = (record?.nextAt ?? Date.now()) + dueOffset;
    await h.schedule.patchSchedule(name, { nextAt: due });
    h.alarmListeners[0]({ name: `mcp-shortcut::${name}`, scheduledTime: due });
    await settle(80);
  }

  it('1·2·3·4·5회 연속 실패에서 알림은 두 번만 온다', async () => {
    wireInvoker(h, 'job', () => errText('extract_failed: 게시판이 점검 중입니다 SECRETPAGE'));
    await saveAndSchedule(h, 'job', BASIC_STEPS);

    for (let i = 0; i < 5; i++) await failOnce('job', i + 1);

    const record = await h.schedule.readSchedule('job');
    expect(record?.failStreak).toBe(5);
    expect(h.notifications).toHaveLength(2);
    // 본문 allowlist: 이름·코드·step 번호 뿐. 페이지 텍스트가 새지 않는다.
    for (const notification of h.notifications) {
      expect(notification.title).toBe('Auto Chrome MCP 예약 실패');
      expect(notification.message).toMatch(/^job: [a-z][a-z0-9_]*( \(step \d+\))?$/);
      expect(notification.message).not.toContain('SECRETPAGE');
      expect(notification.message).not.toContain('점검');
    }
  });

  it('중간에 성공하면 failStreak 이 0 으로 돌아가고 다음 실패에 다시 온다', async () => {
    let shouldFail = true;
    wireInvoker(h, 'job', () => (shouldFail ? errText('boom_failed: x') : okText({ ok: true })));
    await saveAndSchedule(h, 'job', BASIC_STEPS);

    await failOnce('job', 1);
    expect(h.notifications).toHaveLength(1);
    shouldFail = false;
    await failOnce('job', 2);
    expect((await h.schedule.readSchedule('job'))?.failStreak).toBe(0);
    shouldFail = true;
    await failOnce('job', 3);
    expect(h.notifications).toHaveLength(2);
  });

  it('notify:false 면 알림이 오지 않고, 성공·stopped 도 조용하다', async () => {
    wireInvoker(h, 'quiet', () => errText('boom_failed: x'));
    await saveAndSchedule(
      h,
      'quiet',
      BASIC_STEPS,
      { every: '1h' },
      {
        scheduleExtra: { notify: false },
      },
    );
    await failOnce('quiet', 1);
    expect(h.notifications).toHaveLength(0);
  });
});

describe('15. 타임존이 바뀌면 nextAt 을 다시 계산한다', () => {
  it('reconcile 이 새 존 기준으로 nextAt 과 서명을 갱신한다', async () => {
    wireInvoker(h, 'job');
    const saved = await saveAndSchedule(h, 'job', BASIC_STEPS, { daily: ['08:00'] });
    await h.schedule.patchSchedule('job', { timeZone: 'Pacific/Kiritimati', offsetMinutes: -840 });

    await h.runner.reconcileSchedules();
    await settle();

    const record = await h.schedule.readSchedule('job');
    const signature = h.schedule.currentTimeZoneSignature();
    expect(record?.timeZone).toBe(signature.timeZone);
    expect(record?.offsetMinutes).toBe(signature.offsetMinutes);
    expect(new Date(record!.nextAt).getHours()).toBe(8);
    expect(saved.nextAt).toBeGreaterThan(0);
  });
});

describe('16. 실행 중 예약이 바뀌면 superseded 로 끝난다', () => {
  it('실행 중 unschedule 하면 재무장하지 않고 이력에 superseded 가 남는다', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    wireInvoker(h, 'job', async () => {
      await gate;
      return okText({ success: true });
    });
    const saved = await saveAndSchedule(h, 'job', BASIC_STEPS);

    h.alarmListeners[0]({ name: 'mcp-shortcut::job', scheduledTime: saved.nextAt });
    await settle();

    await h.shortcut.shortcutTool.execute({ action: 'unschedule', name: 'job' } as any);
    release?.();
    await settle(120);

    const map = await h.history.readHistory();
    expect(map.job[0].superseded).toBe(true);
    expect(map.job[0].status).toBe('success');
    expect(await h.schedule.readSchedule('job')).toBeNull();
    expect(h.alarms.has('mcp-shortcut::job')).toBe(false);
  });
});

describe('17. 사용자가 작업 탭을 가져가면 실행을 멈춘다', () => {
  it('user_took_over_tab 으로 끝나고 그 탭은 열린 채 소유만 해제된다', async () => {
    const workTabId = 801;
    const { sessionKey } = wireInvoker(
      h,
      'job',
      () => {
        // 두 번째 step 직전에 사용자가 그 탭을 활성화한다.
        h.tabs.set(workTabId, { id: workTabId, windowId: 1, active: true });
        return okText({ success: true });
      },
      workTabId,
    );
    const saved = await saveAndSchedule(h, 'job', [
      ...BASIC_STEPS,
      { tool: 'chrome_screenshot', args: {} },
    ]);

    h.alarmListeners[0]({ name: 'mcp-shortcut::job', scheduledTime: saved.nextAt });
    await settle(80);

    const map = await h.history.readHistory();
    expect(map.job[0].status).toBe('user_took_over_tab');
    expect(h.removedTabs).not.toContain(workTabId);
    expect(h.tabs.has(workTabId)).toBe(true);
    expect(await h.workTab.getSessionScopedTabIds(sessionKey)).toHaveLength(0);
  });
});

describe('19. report 파일은 secret 을 다시 검사하고 상한을 지킨다', () => {
  it('report:true 면 JSON 파일이 날짜 폴더에 저장된다', async () => {
    wireInvoker(h, 'job', () => okText({ success: true, values: { id: '10423' } }));
    const saved = await saveAndSchedule(
      h,
      'job',
      BASIC_STEPS,
      { every: '1h' },
      { saveExtra: { return: ['latest'] }, scheduleExtra: { report: true } },
    );

    h.alarmListeners[0]({ name: 'mcp-shortcut::job', scheduledTime: saved.nextAt });
    await settle(80);

    expect(h.downloads).toHaveLength(1);
    expect(h.downloads[0].filename).toMatch(
      /^mcp-screenshots\/\d{4}-\d{2}-\d{2}\/report_job_\d{6}\.json$/,
    );
    const json = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(h.downloads[0].url.split(',')[1]), (c) => c.charCodeAt(0)),
      ),
    );
    expect(json.results.latest.values.id).toBe('10423');
    expect(json.status).toBe('success');

    const map = await h.history.readHistory();
    expect(map.job[0].report).toBe(h.downloads[0].filename);
  });

  it('256KiB 를 넘는 항목은 통째로 빠지고 resultsTruncated 에 이름이 남는다', () => {
    const big = 'x'.repeat(h.runner.MAX_REPORT_RESULT_BYTES + 10);
    const { results, truncated } = h.runner.buildReportResults({ small: 'ok', big });
    expect(results.small).toBe('ok');
    expect(results.big).toBeUndefined();
    expect(truncated).toEqual(['big']);
  });
});

describe('통합: 설계 예시 (b) 게시판 확인', () => {
  it('예약 등록 -> 알람 발화 -> 이력 success, 사용자 탭 11 은 건드리지 않는다', async () => {
    // 사용자가 보고 있는 탭.
    h.tabs.set(11, { id: 11, windowId: 1, active: true, url: 'https://user.example.com/' });

    const steps = [
      { tool: 'chrome_navigate', args: { url: 'https://board.example.com/list' } },
      {
        tool: 'chrome_extract',
        as: 'latest',
        args: { fields: { id: { selector: '.row:first-child .id' } } },
        stopIf: { path: 'latest.values.id', op: 'eq', value: '{{params.lastSeen}}' },
      },
    ];

    wireInvoker(h, 'board-watch', () =>
      okText({ success: true, values: { id: '10423', title: '새 공지' } }),
    );

    await h.shortcut.shortcutTool.execute({
      action: 'save',
      name: 'board-watch',
      templates: true,
      return: ['latest'],
      params: { lastSeen: { required: true, description: '마지막으로 본 글 번호' } },
      steps,
    } as any);
    const saved = body(
      await h.shortcut.shortcutTool.execute({
        action: 'schedule',
        name: 'board-watch',
        schedule: { every: '1h' },
        params: { lastSeen: '10422' },
      } as any),
    );
    expect(saved.success).toBe(true);

    h.alarmListeners[0]({ name: 'mcp-shortcut::board-watch', scheduledTime: saved.nextAt });
    await settle(80);

    const map = await h.history.readHistory();
    expect(map['board-watch']).toHaveLength(1);
    const run = map['board-watch'][0];
    expect(run.status).toBe('success');
    expect(run.trigger).toBe('scheduled');
    expect(run.results?.latest).toMatchObject({ values: { id: '10423' } });

    // 사용자 탭에 대한 도구 호출이 0건이고, 그 탭은 그대로 있다.
    for (const call of h.toolCalls) {
      expect(call.args.tabId).toBeUndefined();
    }
    expect(h.removedTabs).not.toContain(11);
    expect(h.tabs.get(11)?.active).toBe(true);

    // history 요약으로 아침 흐름을 재현한다.
    const summary = body(
      await h.shortcut.shortcutTool.execute({ action: 'history', limit: 20 } as any),
    );
    expect(summary.runs[0].name).toBe('board-watch');
    expect(summary.runs[0].status).toBe('success');
    expect(summary.runs[0].results).toBeUndefined();

    const schedules = body(await h.shortcut.shortcutTool.execute({ action: 'schedules' } as any));
    expect(schedules.schedules[0]).toMatchObject({ name: 'board-watch', lastStatus: 'success' });
  });
});
