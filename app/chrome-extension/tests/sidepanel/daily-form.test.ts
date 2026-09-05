/**
 * 예약 폼 검증 (2026-09-05 사이드패널 2단계 E).
 *
 * 확인하려는 것.
 *   1. 시각 형식·개수·중복·간격을 화면에서 먼저 잡는다 (백그라운드가 조용히 거절하지 않게).
 *   2. 요일 선택은 요일이 비면 저장되지 않는다.
 *   3. 민감 변수·미발행·시작 주소 없음이 예약 불가 사유로 나온다.
 *   4. 기존 예약을 고칠 때 폼이 그 값으로 채워진다.
 */

import { describe, expect, it } from 'vitest';
import {
  flowScheduleBlockReason,
  initialFormState,
  runNowMessageKey,
  schedulableVariables,
  scheduleFormErrorMessage,
  sensitiveVariables,
  validateScheduleForm,
  validateScheduleVariables,
  variableErrorMessage,
  type ScheduleFormState,
} from '@/entrypoints/sidepanel/utils/daily-form';
import type { ScheduleView } from '@/entrypoints/sidepanel/utils/daily-messages';
import type { WizardFlow } from '@/entrypoints/sidepanel/utils/flow-wizard';

function t(key: string, subs?: string[]): string {
  return subs && subs.length > 0 ? `${key}(${subs.join('|')})` : key;
}

function state(patch: Partial<ScheduleFormState> = {}): ScheduleFormState {
  return {
    mode: 'daily',
    times: ['08:00'],
    days: [],
    every: '1h',
    notify: true,
    report: false,
    enabled: true,
    args: {},
    ...patch,
  };
}

function flow(patch: Partial<WizardFlow> = {}): WizardFlow {
  return {
    id: 'flow_1',
    name: '주문 확인',
    version: 1,
    startUrl: 'https://example.com/orders',
    variables: [],
    ...patch,
  } as WizardFlow;
}

describe('daily-form 검증', () => {
  it('매일 예약은 시각을 정렬해 표현으로 만든다', () => {
    const result = validateScheduleForm(state({ times: ['18:30', '08:00'] }));
    expect(result).toEqual({ ok: true, schedule: { daily: ['08:00', '18:30'] } });
  });

  it('시각이 하나도 없으면 거절한다', () => {
    const result = validateScheduleForm(state({ times: ['', '  '] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('no_times');
  });

  it('형식이 어긋난 시각을 잡는다', () => {
    const result = validateScheduleForm(state({ times: ['25:00'] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('invalid_time');
      expect(result.error.value).toBe('25:00');
      expect(scheduleFormErrorMessage(result.error, t)).toBe(
        'sidepanel_daily_error_invalid_time(25:00)',
      );
    }
  });

  it('같은 시각이 두 번이면 거절한다', () => {
    const result = validateScheduleForm(state({ times: ['08:00', '08:00'] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('duplicate_time');
  });

  it('시각이 너무 가까우면 거절한다 (한 실행이 다음 실행을 밀어낸다)', () => {
    const result = validateScheduleForm(state({ times: ['08:00', '08:03'] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('gap_too_small');
  });

  it('시각은 네 개까지다', () => {
    const result = validateScheduleForm(
      state({ times: ['01:00', '05:00', '09:00', '13:00', '17:00'] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('too_many_times');
  });

  it('요일 선택인데 요일이 비면 거절한다', () => {
    const result = validateScheduleForm(state({ mode: 'weekdays', days: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('no_days');
  });

  it('요일 선택은 요일과 시각을 함께 담는다', () => {
    const result = validateScheduleForm(
      state({ mode: 'weekdays', days: ['mon', 'FRI'], times: ['09:30'] }),
    );
    expect(result).toEqual({ ok: true, schedule: { daily: ['09:30'], days: ['mon', 'fri'] } });
  });

  it('간격은 정해진 값만 받는다', () => {
    expect(validateScheduleForm(state({ mode: 'every', every: '6h' }))).toEqual({
      ok: true,
      schedule: { every: '6h' },
    });
    const bad = validateScheduleForm(state({ mode: 'every', every: '3m' }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.reason).toBe('invalid_every');
  });
});

describe('daily-form 흐름 예약 가능 여부', () => {
  it('발행되지 않은 흐름은 예약할 수 없다', () => {
    expect(flowScheduleBlockReason(flow(), false)).toBe('flow_not_published');
  });

  it('시작 주소가 없으면 예약할 수 없다', () => {
    expect(flowScheduleBlockReason(flow({ startUrl: '' }), true)).toBe('flow_start_url_required');
  });

  it('민감 변수가 있으면 예약할 수 없다', () => {
    const withSecret = flow({ variables: [{ key: 'pw', sensitive: true }] });
    expect(flowScheduleBlockReason(withSecret, true)).toBe('flow_has_sensitive_vars');
    expect(sensitiveVariables(withSecret)).toHaveLength(1);
    expect(schedulableVariables(withSecret)).toHaveLength(0);
  });

  it('셋 다 통과하면 예약할 수 있다', () => {
    const ok = flow({ variables: [{ key: 'keyword', default: '주문' }] });
    expect(flowScheduleBlockReason(ok, true)).toBeNull();
    expect(schedulableVariables(ok).map((v) => v.key)).toEqual(['keyword']);
  });
});

describe('daily-form 폼 기본값', () => {
  it('새 예약은 매일 09:00, 알림 켜짐, 결과 저장 꺼짐이다', () => {
    const initial = initialFormState(null);
    expect(initial.mode).toBe('daily');
    expect(initial.times).toEqual(['09:00']);
    expect(initial.notify).toBe(true);
    expect(initial.report).toBe(false);
    expect(initial.enabled).toBe(true);
  });

  it('기존 예약을 고칠 때 그 값으로 채운다', () => {
    const existing: ScheduleView = {
      scheduleId: 'flow:flow_1',
      name: '주문 확인',
      label: '주문 확인',
      kind: 'flow',
      target: { kind: 'flow', flowId: 'flow_1', args: { keyword: '주문' } },
      schedule: { daily: ['08:00', '20:00'], days: ['mon', 'thu'] },
      enabled: false,
      notify: false,
      report: true,
      nextAt: 0,
      revision: 3,
      failStreak: 0,
    };
    const initial = initialFormState(existing);
    expect(initial.mode).toBe('weekdays');
    expect(initial.times).toEqual(['08:00', '20:00']);
    expect(initial.days).toEqual(['mon', 'thu']);
    expect(initial.notify).toBe(false);
    expect(initial.report).toBe(true);
    expect(initial.enabled).toBe(false);
    expect(initial.args).toEqual({ keyword: '주문' });
  });

  it('간격 예약을 고칠 때는 간격 방식으로 연다', () => {
    const existing: ScheduleView = {
      scheduleId: 'shortcut:daily_report',
      name: 'daily_report',
      label: 'daily_report',
      kind: 'shortcut',
      target: { kind: 'shortcut', name: 'daily_report' },
      schedule: { every: '6h' },
      enabled: true,
      notify: true,
      report: false,
      nextAt: 0,
      revision: 1,
      failStreak: 0,
    };
    const initial = initialFormState(existing);
    expect(initial.mode).toBe('every');
    expect(initial.every).toBe('6h');
  });
});

describe('daily-form 변수 값 검증 (예약은 값을 물어볼 수 없다)', () => {
  it('빈 값이면 저장할 수 없다 (기본값 없는 변수 포함)', () => {
    const error = validateScheduleVariables([{ key: 'keyword' }], { keyword: '' });
    expect(error).toEqual({ key: 'keyword', reason: 'required_empty' });
    expect(variableErrorMessage(error!, '검색어', t)).toBe(
      'sidepanel_daily_error_var_required(검색어)',
    );
  });

  it('공백만 있는 값도 빈 값이다', () => {
    expect(validateScheduleVariables([{ key: 'keyword' }], { keyword: '   ' })).toEqual({
      key: 'keyword',
      reason: 'required_empty',
    });
  });

  it('아예 없는 값도 빈 값이다', () => {
    expect(validateScheduleVariables([{ key: 'keyword' }], {})).toEqual({
      key: 'keyword',
      reason: 'required_empty',
    });
  });

  it('형식 규칙을 어기면 그 이유로 막는다', () => {
    const error = validateScheduleVariables([{ key: 'code', rules: { pattern: '^[0-9]{4}$' } }], {
      code: 'abcd',
    });
    expect(error).toEqual({ key: 'code', reason: 'pattern' });
    expect(variableErrorMessage(error!, 'code', t)).toBe('sidepanel_daily_error_var_pattern(code)');
  });

  it('선택지에 없는 값을 막고 허용값을 문구에 넣는다', () => {
    const error = validateScheduleVariables([{ key: 'mode', rules: { enum: ['주문', '배송'] } }], {
      mode: '재고',
    });
    expect(error).toEqual({ key: 'mode', reason: 'enum', allowed: ['주문', '배송'] });
    expect(variableErrorMessage(error!, 'mode', t)).toBe(
      'sidepanel_daily_error_var_enum(mode|주문, 배송)',
    );
  });

  it('흐름에 든 정규식이 깨져 있으면 값을 막지 않는다 (값 잘못이 아니다)', () => {
    expect(
      validateScheduleVariables([{ key: 'code', rules: { pattern: '([' } }], { code: 'x' }),
    ).toBeNull();
  });

  it('모두 채워져 있고 규칙에 맞으면 통과한다', () => {
    expect(
      validateScheduleVariables([{ key: 'keyword' }, { key: 'mode', rules: { enum: ['주문'] } }], {
        keyword: '주문 확인',
        mode: '주문',
      }),
    ).toBeNull();
  });
});

describe('daily-form 지금 실행 문구', () => {
  it('큐에 새로 들어갔으면 시작했다고 말한다', () => {
    expect(runNowMessageKey(true)).toBe('sidepanel_daily_run_started');
    expect(runNowMessageKey(undefined)).toBe('sidepanel_daily_run_started');
  });

  it('이미 줄을 서 있으면 대기 중이라고 말한다', () => {
    expect(runNowMessageKey(false)).toBe('sidepanel_daily_run_already_queued');
  });
});
