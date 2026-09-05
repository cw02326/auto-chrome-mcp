/**
 * dead-alarm-cleanup.test.ts
 *
 * 3단계(2026-09-06)에서 지운 두 예약 코드가 남긴 chrome.alarms 를 기동 시 한 번 치우는
 * 코드의 회귀 테스트.
 *
 * 계약:
 *  1) 지정한 네 접두로 시작하는 알람만 지운다. 살아 있는 예약 엔진 알람은 건드리지 않는다.
 *  2) 전부 지웠을 때만 완료 표시를 남긴다.
 *  3) 하나라도 지우지 못하면 완료 표시를 남기지 않고, 다음 기동에서 다시 시도한다.
 *     (Codex 리뷰 1항: 일시 실패한 주기 알람이 영구히 남아 워커를 깨우던 문제)
 *  4) 완료 표시가 있으면 alarms.getAll 조차 부르지 않는다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CLEANUP_DONE_KEY,
  DEAD_ALARM_PREFIXES,
  cleanupDeadAlarmsOnce,
} from '@/entrypoints/background/dead-alarm-cleanup';

/** 살아 있는 예약 엔진의 알람. 절대 지워지면 안 된다. */
const LIVE_ALARM = 'mcp-shortcut::abc123';

interface Harness {
  getAll: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  storageGet: ReturnType<typeof vi.fn>;
  storageSet: ReturnType<typeof vi.fn>;
  store: Record<string, unknown>;
}

function install(options: {
  alarmNames: string[];
  alreadyDone?: boolean;
  failOn?: string[];
}): Harness {
  const store: Record<string, unknown> = options.alreadyDone ? { [CLEANUP_DONE_KEY]: true } : {};

  const getAll = vi.fn(async () => options.alarmNames.map((name) => ({ name })));
  const clear = vi.fn(async (name: string) => {
    if (options.failOn?.includes(name)) throw new Error(`clear failed: ${name}`);
    return true;
  });
  const storageGet = vi.fn(async (keys: string[]) => {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (k in store) out[k] = store[k];
    return out;
  });
  const storageSet = vi.fn(async (values: Record<string, unknown>) => {
    Object.assign(store, values);
  });

  (globalThis as any).chrome.alarms = { getAll, clear };
  (globalThis as any).chrome.storage.local.get = storageGet;
  (globalThis as any).chrome.storage.local.set = storageSet;

  return { getAll, clear, storageGet, storageSet, store };
}

describe('cleanupDeadAlarmsOnce', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('접두 목록은 지운 두 예약 코드가 쓰던 이름 넷이다', () => {
    expect([...DEAD_ALARM_PREFIXES]).toEqual([
      'rr_schedule_',
      'rr_v3_cron_',
      'rr_v3_interval_',
      'rr_v3_once_',
    ]);
  });

  it('죽은 알람만 지우고 살아 있는 예약 알람은 남긴다', async () => {
    const h = install({
      alarmNames: [
        'rr_schedule_s1',
        'rr_v3_cron_t1',
        'rr_v3_interval_t2',
        'rr_v3_once_t3',
        LIVE_ALARM,
      ],
    });

    const result = await cleanupDeadAlarmsOnce();

    expect(result.cleared).toEqual([
      'rr_schedule_s1',
      'rr_v3_cron_t1',
      'rr_v3_interval_t2',
      'rr_v3_once_t3',
    ]);
    expect(result.failed).toEqual([]);
    expect(result.markedDone).toBe(true);
    expect(h.clear).not.toHaveBeenCalledWith(LIVE_ALARM);
    expect(h.store[CLEANUP_DONE_KEY]).toBe(true);
  });

  it('지울 것이 없어도 완료로 표시한다', async () => {
    const h = install({ alarmNames: [LIVE_ALARM] });

    const result = await cleanupDeadAlarmsOnce();

    expect(result.cleared).toEqual([]);
    expect(result.markedDone).toBe(true);
    expect(h.clear).not.toHaveBeenCalled();
  });

  it('하나라도 지우지 못하면 완료 표시를 남기지 않는다', async () => {
    const h = install({
      alarmNames: ['rr_schedule_s1', 'rr_v3_interval_t2'],
      failOn: ['rr_v3_interval_t2'],
    });

    const result = await cleanupDeadAlarmsOnce();

    expect(result.cleared).toEqual(['rr_schedule_s1']);
    expect(result.failed).toEqual(['rr_v3_interval_t2']);
    expect(result.markedDone).toBe(false);
    expect(h.storageSet).not.toHaveBeenCalled();
    expect(h.store[CLEANUP_DONE_KEY]).toBeUndefined();
    // 실패한 것 말고 나머지는 계속 지운다.
    expect(h.clear).toHaveBeenCalledTimes(2);
  });

  it('실패 후 다음 기동에서 다시 시도하고, 이번에 성공하면 그때 표시한다', async () => {
    const first = install({
      alarmNames: ['rr_v3_interval_t2'],
      failOn: ['rr_v3_interval_t2'],
    });
    const firstResult = await cleanupDeadAlarmsOnce();
    expect(firstResult.markedDone).toBe(false);

    // 다음 기동: 표시가 없으므로 다시 훑는다.
    const second = install({ alarmNames: ['rr_v3_interval_t2'] });
    const secondResult = await cleanupDeadAlarmsOnce();

    expect(second.getAll).toHaveBeenCalledTimes(1);
    expect(secondResult.skipped).toBe(false);
    expect(secondResult.cleared).toEqual(['rr_v3_interval_t2']);
    expect(secondResult.markedDone).toBe(true);
    expect(second.store[CLEANUP_DONE_KEY]).toBe(true);
    expect(first.store[CLEANUP_DONE_KEY]).toBeUndefined();
  });

  it('완료 표시가 있으면 알람을 훑지도 않는다', async () => {
    const h = install({ alarmNames: ['rr_schedule_s1'], alreadyDone: true });

    const result = await cleanupDeadAlarmsOnce();

    expect(result.skipped).toBe(true);
    expect(h.getAll).not.toHaveBeenCalled();
    expect(h.clear).not.toHaveBeenCalled();
  });

  it('alarms.getAll 자체가 실패하면 표시를 남기지 않는다', async () => {
    install({ alarmNames: [] });
    (globalThis as any).chrome.alarms.getAll = vi.fn(async () => {
      throw new Error('alarms unavailable');
    });

    const result = await cleanupDeadAlarmsOnce();

    expect(result.markedDone).toBe(false);
    expect(result.cleared).toEqual([]);
  });
});
