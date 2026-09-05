/**
 * auto-chrome-mcp fork — chrome_shortcut 예약 (설계 구현 순서 3단계).
 *
 * 계약: docs/plans/2026-09-05-daily-automation-design.md 1~3절.
 * 테스트 이름 앞의 번호는 위임 계약의 체크리스트 번호다 (1·2, 3, 4, 15, 19).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EVERY_MINUTES,
  MAX_SCHEDULES,
  SCHEDULE_ALARM_PREFIX,
  SCHEDULE_STORAGE_KEY,
  alarmNameFor,
  computeNextAt,
  firstInstantAtOrAfterWall,
  nextDailyAt,
  nextEveryAt,
  scheduleNameFromAlarm,
  scheduleRunId,
  validateLoginCheck,
  validateScheduleExpression,
  validateScheduleFirstStep,
  type ScheduleRecord,
} from '@/utils/shortcut-schedule';
import { shortcutTool } from '@/entrypoints/background/tools/browser/shortcut';
import { TOOL_SCHEMAS } from 'auto-chrome-mcp-shared';

function body(result: any) {
  return JSON.parse(result.content[0].text);
}

/** chrome.storage.local 을 메모리 맵으로, chrome.alarms 를 관찰 가능한 mock 으로. */
function stubChrome() {
  const store: Record<string, any> = {};
  (chrome.storage.local as any).get = vi.fn(async (keys: any) => {
    const list = Array.isArray(keys) ? keys : [keys];
    const out: Record<string, any> = {};
    for (const key of list) if (key in store) out[key] = store[key];
    return out;
  });
  (chrome.storage.local as any).set = vi.fn(async (obj: Record<string, any>) => {
    Object.assign(store, JSON.parse(JSON.stringify(obj)));
  });

  const alarms = new Map<string, { name: string; scheduledTime: number }>();
  (globalThis as any).chrome.alarms = {
    create: vi.fn(async (name: string, info: any) => {
      alarms.set(name, { name, scheduledTime: info?.when ?? Date.now() });
    }),
    clear: vi.fn(async (name: string) => alarms.delete(name)),
    getAll: vi.fn(async () => Array.from(alarms.values())),
    onAlarm: { addListener: vi.fn(), removeListener: vi.fn() },
  };

  return { store, alarms };
}

async function saveShortcut(extra: Record<string, unknown> = {}) {
  return await shortcutTool.execute({
    action: 'save',
    name: 'board-watch',
    templates: true,
    steps: [
      { tool: 'chrome_navigate', args: { url: 'https://board.example.com/list' } },
      { tool: 'chrome_extract', as: 'latest', args: { fields: { id: '.row .id' } } },
    ],
    ...extra,
  } as any);
}

let ctx: ReturnType<typeof stubChrome>;

beforeEach(() => {
  ctx = stubChrome();
});

describe('1. 스케줄 표현 검증', () => {
  it('every 와 daily 는 정확히 하나만 받는다', () => {
    expect(validateScheduleExpression({ every: '1h', daily: ['08:00'] })).toMatchObject({
      ok: false,
    });
    expect(validateScheduleExpression({})).toMatchObject({ ok: false });
    expect((validateScheduleExpression({}) as any).error).toContain('schedule_invalid');
  });

  it('every 는 15m·1h·6h·24h 만 받는다 (30m 은 거절)', () => {
    for (const value of Object.keys(EVERY_MINUTES)) {
      expect(validateScheduleExpression({ every: value }).ok).toBe(true);
    }
    const rejected = validateScheduleExpression({ every: '30m' });
    expect(rejected.ok).toBe(false);
    expect((rejected as any).error).toContain('schedule_invalid');
  });

  it('daily 는 최대 4개, 같은 날 안에서 5분 이상 간격이어야 한다', () => {
    expect(validateScheduleExpression({ daily: ['08:00', '12:00', '16:00', '20:00'] }).ok).toBe(
      true,
    );
    expect(
      validateScheduleExpression({ daily: ['01:00', '02:00', '03:00', '04:00', '05:00'] }).ok,
    ).toBe(false);
    expect(validateScheduleExpression({ daily: ['08:00', '08:03'] }).ok).toBe(false);
    // 23:58 과 00:01 은 서로 다른 날이라 허용된다.
    expect(validateScheduleExpression({ daily: ['23:58', '00:01'] }).ok).toBe(true);
  });

  it('모르는 days 값과 형식이 어긋난 시각은 거절된다', () => {
    expect(validateScheduleExpression({ daily: ['08:00'], days: ['moon'] }).ok).toBe(false);
    expect(validateScheduleExpression({ daily: ['8:00'] }).ok).toBe(false);
    expect(validateScheduleExpression({ daily: ['24:00'] }).ok).toBe(false);
    expect(validateScheduleExpression({ every: '1h', days: ['mon'] }).ok).toBe(false);
  });
});

describe('2. 예약 개수·덮어쓰기', () => {
  it(`${MAX_SCHEDULES}개까지 저장되고 21개째는 too_many_schedules`, async () => {
    for (let i = 0; i < MAX_SCHEDULES + 1; i++) {
      const name = `job-${i}`;
      await shortcutTool.execute({
        action: 'save',
        name,
        templates: true,
        steps: [{ tool: 'chrome_navigate', args: { url: 'https://example.com/' } }],
      } as any);
      const result = await shortcutTool.execute({
        action: 'schedule',
        name,
        schedule: { every: '1h' },
      } as any);
      if (i < MAX_SCHEDULES) {
        expect(body(result).success).toBe(true);
      } else {
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('too_many_schedules');
      }
    }
    expect(Object.keys(ctx.store[SCHEDULE_STORAGE_KEY])).toHaveLength(MAX_SCHEDULES);
  });

  it('같은 이름 재예약은 replaced:true 이고 알람이 하나만 남는다', async () => {
    await saveShortcut();
    const first = body(
      await shortcutTool.execute({
        action: 'schedule',
        name: 'board-watch',
        schedule: { every: '1h' },
      } as any),
    );
    expect(first.replaced).toBe(false);

    const second = body(
      await shortcutTool.execute({
        action: 'schedule',
        name: 'board-watch',
        schedule: { daily: ['08:00'] },
      } as any),
    );
    expect(second.replaced).toBe(true);
    expect(second.revision).toBe(first.revision + 1);

    const all = await chrome.alarms.getAll();
    expect(all.filter((a: any) => a.name.startsWith(SCHEDULE_ALARM_PREFIX))).toHaveLength(1);
    expect(alarmNameFor('board-watch')).toBe('mcp-shortcut::board-watch');
    expect(scheduleNameFromAlarm('mcp-shortcut::board-watch')).toBe('board-watch');
    expect(scheduleNameFromAlarm('other::x')).toBeNull();
  });

  it('unschedule 은 레코드와 알람을 지운다', async () => {
    await saveShortcut();
    await shortcutTool.execute({
      action: 'schedule',
      name: 'board-watch',
      schedule: { every: '1h' },
    } as any);
    const result = body(
      await shortcutTool.execute({ action: 'unschedule', name: 'board-watch' } as any),
    );
    expect(result.unscheduled).toBe(true);
    expect(await chrome.alarms.getAll()).toHaveLength(0);

    const list = body(await shortcutTool.execute({ action: 'schedules' } as any));
    expect(list.schedules).toHaveLength(0);
  });

  it('shortcut delete 는 예약도 함께 지운다', async () => {
    await saveShortcut();
    await shortcutTool.execute({
      action: 'schedule',
      name: 'board-watch',
      schedule: { every: '1h' },
    } as any);
    const result = body(
      await shortcutTool.execute({ action: 'delete', name: 'board-watch' } as any),
    );
    expect(result.unscheduled).toBe(true);
    expect(await chrome.alarms.getAll()).toHaveLength(0);
  });
});

describe('3. secret 과 params 거절', () => {
  it('required 인 secret 이 선언된 shortcut 은 예약 자체가 거절된다', async () => {
    await saveShortcut({
      name: 'crm-login',
      params: { user: { required: true }, pw: { required: true, secret: true } },
      steps: [
        { tool: 'chrome_navigate', args: { url: 'https://crm.example.com/' } },
        { tool: 'chrome_fill_or_select', args: { value: '{{params.pw}}' } },
      ],
    });
    const result = await shortcutTool.execute({
      action: 'schedule',
      name: 'crm-login',
      schedule: { daily: ['07:30'] },
      params: { user: 'me' },
    } as any);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('secret_required_unschedulable');
  });

  it('secret 이름을 예약 params 에 넣으면 secret_param_in_schedule', async () => {
    await saveShortcut({
      name: 'crm-login',
      params: { pw: { secret: true } },
      steps: [
        { tool: 'chrome_navigate', args: { url: 'https://crm.example.com/' } },
        { tool: 'chrome_fill_or_select', args: { value: '{{params.pw}}' } },
      ],
    });
    const result = await shortcutTool.execute({
      action: 'schedule',
      name: 'crm-login',
      schedule: { daily: ['07:30'] },
      params: { pw: 'hunter2hunter2' },
    } as any);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('secret_param_in_schedule');
    // 저장소 어디에도 비밀값이 없다.
    expect(JSON.stringify(ctx.store)).not.toContain('hunter2hunter2');
  });

  it('미선언 이름은 unknown_param, required 누락은 missing_param', async () => {
    await saveShortcut({
      name: 'board-watch',
      params: { lastSeen: { required: true } },
      steps: [
        { tool: 'chrome_navigate', args: { url: 'https://board.example.com/list' } },
        { tool: 'chrome_extract', as: 'latest', args: { fields: { id: '{{params.lastSeen}}' } } },
      ],
    });
    const unknown = await shortcutTool.execute({
      action: 'schedule',
      name: 'board-watch',
      schedule: { every: '1h' },
      params: { nope: 1 },
    } as any);
    expect(unknown.content[0].text).toContain('unknown_param');

    const missing = await shortcutTool.execute({
      action: 'schedule',
      name: 'board-watch',
      schedule: { every: '1h' },
    } as any);
    expect(missing.content[0].text).toContain('missing_param');
  });
});

describe('4. 첫 step 과 stale target', () => {
  const cases: Array<[string, unknown]> = [
    [
      'repeat 묶음',
      [{ repeat: { max: 2 }, steps: [{ tool: 'chrome_navigate', args: { url: 'https://a/' } }] }],
    ],
    [
      'when 있음',
      [{ tool: 'chrome_navigate', when: { path: 'a', op: 'exists' }, args: { url: 'https://a/' } }],
    ],
    ['navigate 아님', [{ tool: 'chrome_screenshot', args: {} }]],
    ['url 없음', [{ tool: 'chrome_navigate', args: {} }]],
    ['refresh', [{ tool: 'chrome_navigate', args: { url: 'https://a/', refresh: true } }]],
  ];

  for (const [label, steps] of cases) {
    it(`첫 step 이 ${label} 이면 schedule_first_step_invalid`, () => {
      expect(validateScheduleFirstStep(steps)).toContain('schedule_first_step_invalid');
    });
  }

  it('정상적인 첫 step 은 통과한다', () => {
    expect(
      validateScheduleFirstStep([{ tool: 'chrome_navigate', args: { url: '{{params.site}}' } }]),
    ).toBeNull();
  });

  it('예약 API 도 첫 step 규칙을 적용한다', async () => {
    await shortcutTool.execute({
      action: 'save',
      name: 'no-nav',
      templates: true,
      steps: [
        { tool: 'chrome_screenshot', as: 'shot', args: {} },
        { tool: 'chrome_navigate', args: { url: 'https://a/' } },
      ],
    } as any);
    const result = await shortcutTool.execute({
      action: 'schedule',
      name: 'no-nav',
      schedule: { every: '1h' },
    } as any);
    expect(result.content[0].text).toContain('schedule_first_step_invalid');
  });

  it('literal tabId 를 가진 legacy 레코드는 stale_target_forbidden 으로 예약이 거절된다', async () => {
    // legacy(v1) 저장: templates 를 켜지 않아 저장 시점 검사를 통과한다.
    await shortcutTool.execute({
      action: 'save',
      name: 'legacy',
      steps: [
        { tool: 'chrome_navigate', args: { url: 'https://a/' } },
        { tool: 'chrome_click_element', args: { tabId: 42, selector: '.x' } },
      ],
    } as any);
    const scheduled = await shortcutTool.execute({
      action: 'schedule',
      name: 'legacy',
      schedule: { every: '1h' },
    } as any);
    expect(scheduled.content[0].text).toContain('stale_target_forbidden');
  });

  it('loginCheck 는 top-level step 의 as 만 가리킬 수 있다', () => {
    const steps = [
      { tool: 'chrome_navigate', args: { url: 'https://a/' } },
      { tool: 'chrome_find', as: 'loginForm', args: {} },
      { repeat: { max: 2 }, steps: [{ tool: 'chrome_find', as: 'inner', args: {} }] },
    ];
    expect(validateLoginCheck(steps, 'loginForm')).toBeNull();
    expect(validateLoginCheck(steps, 'inner')).toContain('schedule_invalid');
    expect(validateLoginCheck(steps, undefined)).toBeNull();
  });
});

describe('15. 시각 계산과 DST', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it('every 의 다음 due 는 이전 due 격자 위에 있다 (실행이 밀려도)', () => {
    const due = new Date(2026, 8, 5, 8, 0, 0, 0).getTime();
    const finished = due + 100_000; // 08:01:40 에 끝났다
    expect(nextEveryAt(due, 60, finished)).toBe(new Date(2026, 8, 5, 9, 0, 0, 0).getTime());
  });

  it('8시간 꺼져 있어도 다음 due 는 미래 격자 한 칸이다 (몰아치기 없음)', () => {
    const due = new Date(2026, 8, 5, 0, 0, 0, 0).getTime();
    const now = due + 8 * 60 * 60_000 + 30_000;
    const next = nextEveryAt(due, 60, now);
    expect(next).toBeGreaterThan(now);
    expect((next - due) % (60 * 60_000)).toBe(0);
    expect(next - now).toBeLessThanOrEqual(60 * 60_000);
  });

  it('DST spring-forward 로 없는 시각은 그 다음 존재하는 분에 1회', () => {
    process.env.TZ = 'America/New_York';
    // 2026-03-08 02:00 -> 03:00 (02:00~02:59 가 존재하지 않는다)
    const dayStart = new Date(2026, 2, 8, 0, 0, 0, 0);
    // 조용히 건너뛰지 않는다. TZ 가 안 먹으면 이 검사가 먼저 깨져야 한다.
    expect(dayStart.getTimezoneOffset()).toBe(300);
    const due = firstInstantAtOrAfterWall(dayStart.getTime(), 2 * 60 + 30);
    expect(due).not.toBeNull();
    const d = new Date(due as number);
    expect(d.getHours()).toBe(3);
    expect(d.getMinutes()).toBe(0);
  });

  it('DST fall-back 으로 두 번 오는 시각은 앞선 1회만', () => {
    process.env.TZ = 'America/New_York';
    // 2026-11-01 02:00 -> 01:00 (01:00~01:59 가 두 번 온다)
    const dayStart = new Date(2026, 10, 1, 0, 0, 0, 0);
    expect(dayStart.getTimezoneOffset()).toBe(240);
    const due = firstInstantAtOrAfterWall(dayStart.getTime(), 60 + 30);
    expect(due).not.toBeNull();
    const d = new Date(due as number);
    expect(d.getHours()).toBe(1);
    expect(d.getMinutes()).toBe(30);
    // 앞선(EDT, -4) 쪽이다. 뒤엣것이면 오프셋이 300 이 된다.
    expect(d.getTimezoneOffset()).toBe(240);
  });

  it('daily 는 days 로 요일을 거른다', () => {
    // 2026-09-05 는 토요일이다. 평일만 도는 예약의 다음 due 는 월요일 08:00.
    const from = new Date(2026, 8, 5, 12, 0, 0, 0).getTime();
    const next = nextDailyAt([8 * 60], [1, 2, 3, 4, 5], from);
    expect(next).not.toBeNull();
    const d = new Date(next as number);
    expect(d.getDay()).toBe(1);
    expect(d.getHours()).toBe(8);
  });

  it('computeNextAt 은 표현에 맞는 다음 시각을 준다', () => {
    const now = new Date(2026, 8, 5, 10, 30, 0, 0).getTime();
    const record = {
      name: 'x',
      schedule: { daily: ['08:00', '12:30'] },
      notify: true,
      report: false,
      nextAt: now,
      anchorAt: now,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      timeZone: 'x',
      offsetMinutes: 0,
      failStreak: 0,
    } as ScheduleRecord;
    const next = computeNextAt(record, now);
    expect(new Date(next as number).getHours()).toBe(12);
    expect(new Date(next as number).getMinutes()).toBe(30);
  });

  it('runId 는 이름과 due 시각으로 결정된다 (두 경로가 같은 키를 만든다)', () => {
    const due = Date.UTC(2026, 8, 5, 8, 0, 0);
    expect(scheduleRunId('a', due)).toBe('a:2026-09-05T08:00:00.000Z');
  });
});

describe('19. 사용자에게 보이는 문구에 대시류가 없다', () => {
  const DASHES = /[—–ㅡ―‒－−]/;

  it('chrome_shortcut 스키마 description 에 대시류가 없다', () => {
    const schema = TOOL_SCHEMAS.find((tool) => tool.name === 'chrome_shortcut');
    expect(schema).toBeTruthy();
    const texts = JSON.stringify(schema);
    expect(DASHES.test(texts)).toBe(false);
  });

  it('예약 오류 문구에 대시류가 없다', () => {
    const samples = [
      (validateScheduleExpression({}) as any).error,
      (validateScheduleExpression({ every: '30m' }) as any).error,
      (validateScheduleExpression({ daily: ['08:00', '08:01'] }) as any).error,
      validateScheduleFirstStep([{ tool: 'chrome_screenshot' }]),
      validateLoginCheck([{ tool: 'chrome_navigate' }], 'nope'),
    ];
    for (const sample of samples) {
      expect(typeof sample).toBe('string');
      expect(DASHES.test(String(sample))).toBe(false);
    }
  });
});
