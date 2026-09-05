/**
 * 예약 폼의 순수 로직 (2026-09-05 사이드패널 2단계 E).
 *
 * 화면(.vue)은 여기 결과를 그리기만 한다. 검증 규칙은 예약 엔진(`utils/shortcut-schedule.ts`)
 * 의 상수를 그대로 가져다 쓴다 - 화면에서만 통과시키고 백그라운드가 거절하면 사용자는
 * 이유를 모른 채 저장이 안 되는 것만 본다.
 */

import { getMessage } from '@/utils/i18n';
import {
  EVERY_MINUTES,
  MAX_DAILY_TIMES,
  MIN_DAILY_GAP_MINUTES,
  parseClockTime,
} from '@/utils/shortcut-schedule';
import type { Translate } from './daily-format';
import type { ScheduleExpressionView, ScheduleView } from './daily-messages';
import type { WizardFlow, WizardVariableDef } from './flow-wizard';

/** 반복 방식. 화면의 라디오 세 개와 1:1 이다. */
export type ScheduleMode = 'daily' | 'weekdays' | 'every';

export interface ScheduleFormState {
  mode: ScheduleMode;
  /** `HH:MM` 문자열. 화면의 `input[type=time]` 값 그대로다. */
  times: string[];
  /** 요일 이름(`mon` 등). `weekdays` 일 때만 쓴다. */
  days: string[];
  /** 간격 키(`15m`·`1h`·`6h`·`24h`). `every` 일 때만 쓴다. */
  every: string;
  notify: boolean;
  report: boolean;
  enabled: boolean;
  /** 흐름 변수 값. 민감 변수는 여기 들어오지 않는다. */
  args: Record<string, string>;
}

export type ScheduleFormErrorReason =
  | 'no_times'
  | 'invalid_time'
  | 'duplicate_time'
  | 'too_many_times'
  | 'gap_too_small'
  | 'no_days'
  | 'invalid_every';

export interface ScheduleFormError {
  reason: ScheduleFormErrorReason;
  /** 문제가 된 값(있으면). 문구에 그대로 넣는다. */
  value?: string;
}

export type ScheduleFormResult =
  | { ok: true; schedule: ScheduleExpressionView }
  | { ok: false; error: ScheduleFormError };

/** 흐름을 예약할 수 없는 이유. 폼을 열 때 미리 본다. */
export type FlowScheduleBlockReason =
  | 'flow_start_url_required'
  | 'flow_not_published'
  | 'flow_has_sensitive_vars';

/** 새 예약 폼의 기본값. 기존 예약을 고치는 경우 그 값으로 채운다. */
export function initialFormState(existing?: ScheduleView | null): ScheduleFormState {
  if (!existing) {
    return {
      mode: 'daily',
      times: ['09:00'],
      days: [],
      every: '1h',
      notify: true,
      report: false,
      enabled: true,
      args: {},
    };
  }
  const schedule = existing.schedule || {};
  const times = Array.isArray(schedule.daily) ? schedule.daily.map(String) : [];
  const days = Array.isArray(schedule.days) ? schedule.days.map(String) : [];
  const every = typeof schedule.every === 'string' ? schedule.every : '';
  const args =
    existing.target.kind === 'flow' && existing.target.args ? { ...existing.target.args } : {};
  return {
    mode: every ? 'every' : days.length > 0 ? 'weekdays' : 'daily',
    times: times.length > 0 ? times : ['09:00'],
    days,
    every: every || '1h',
    notify: existing.notify !== false,
    report: existing.report === true,
    enabled: existing.enabled !== false,
    args,
  };
}

/**
 * 폼 값을 예약 표현으로 바꾼다. 형식이 어긋나면 이유를 돌려준다.
 *
 * 시각은 같은 날 안에서 최소 간격을 지켜야 한다. 두 실행이 겹치면 큐가 하나를 통째로
 * 건너뛰는데, 그 이유가 화면 어디에도 안 보이기 때문이다.
 */
export function validateScheduleForm(state: ScheduleFormState): ScheduleFormResult {
  if (state.mode === 'every') {
    if (!state.every || !(state.every in EVERY_MINUTES)) {
      return { ok: false, error: { reason: 'invalid_every' } };
    }
    return { ok: true, schedule: { every: state.every } };
  }

  const raw = state.times.map((t) => String(t || '').trim()).filter((t) => t.length > 0);
  if (raw.length === 0) return { ok: false, error: { reason: 'no_times' } };
  if (raw.length > MAX_DAILY_TIMES) {
    return { ok: false, error: { reason: 'too_many_times' } };
  }

  const minutes: number[] = [];
  for (const value of raw) {
    const parsed = parseClockTime(value);
    if (parsed === null) return { ok: false, error: { reason: 'invalid_time', value } };
    if (minutes.includes(parsed)) {
      return { ok: false, error: { reason: 'duplicate_time', value } };
    }
    minutes.push(parsed);
  }

  const sorted = minutes.slice().sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] - sorted[i - 1] < MIN_DAILY_GAP_MINUTES) {
      return { ok: false, error: { reason: 'gap_too_small' } };
    }
  }

  const daily = sorted.map(
    (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`,
  );

  if (state.mode === 'weekdays') {
    const days = state.days.map((d) => String(d).toLowerCase()).filter(Boolean);
    if (days.length === 0) return { ok: false, error: { reason: 'no_days' } };
    return { ok: true, schedule: { daily, days } };
  }

  return { ok: true, schedule: { daily } };
}

/** 검증 실패 문구. */
export function scheduleFormErrorMessage(
  error: ScheduleFormError,
  t: Translate = getMessage,
): string {
  switch (error.reason) {
    case 'no_times':
      return t('sidepanel_daily_error_no_times');
    case 'invalid_time':
      return t('sidepanel_daily_error_invalid_time', [error.value || '']);
    case 'duplicate_time':
      return t('sidepanel_daily_error_duplicate_time', [error.value || '']);
    case 'too_many_times':
      return t('sidepanel_daily_error_too_many_times', [String(MAX_DAILY_TIMES)]);
    case 'gap_too_small':
      return t('sidepanel_daily_error_gap_too_small', [String(MIN_DAILY_GAP_MINUTES)]);
    case 'no_days':
      return t('sidepanel_daily_error_no_days');
    case 'invalid_every':
    default:
      return t('sidepanel_daily_error_invalid_every');
  }
}

/** 흐름 변수 중 값을 저장할 수 없는 것(비밀번호·토큰). */
export function sensitiveVariables(flow: WizardFlow | null | undefined): WizardVariableDef[] {
  const variables = Array.isArray(flow?.variables) ? flow!.variables! : [];
  return variables.filter((v) => v && v.sensitive === true && typeof v.key === 'string' && v.key);
}

/** 예약 폼에서 값을 물어볼 변수(민감하지 않은 것). */
export function schedulableVariables(flow: WizardFlow | null | undefined): WizardVariableDef[] {
  const variables = Array.isArray(flow?.variables) ? flow!.variables! : [];
  return variables.filter((v) => v && v.sensitive !== true && typeof v.key === 'string' && v.key);
}

/**
 * 이 흐름을 예약할 수 있는가. 없으면 그 이유 하나를 돌려준다.
 *
 * 백그라운드가 거절하는 조건과 같은 순서로 본다(2026-09-05 Codex 설계 검토 2항). 저장을
 * 눌러 본 뒤 거절당하는 대신, 폼을 열 때 이유를 먼저 보여주고 저장 버튼을 잠근다.
 */
export function flowScheduleBlockReason(
  flow: WizardFlow | null | undefined,
  published: boolean,
): FlowScheduleBlockReason | null {
  if (!flow) return 'flow_not_published';
  if (!published) return 'flow_not_published';
  if (!String(flow.startUrl || '').trim()) return 'flow_start_url_required';
  if (sensitiveVariables(flow).length > 0) return 'flow_has_sensitive_vars';
  return null;
}

/* ------------------------------------------------------------------ *
 * 변수 값 검증 (2026-09-05 Codex 리뷰 3항)
 * ------------------------------------------------------------------ */

export type VariableErrorReason = 'required_empty' | 'pattern' | 'enum';

export interface VariableError {
  key: string;
  reason: VariableErrorReason;
  /** `enum` 일 때 허용값 목록. 문구에 그대로 넣는다. */
  allowed?: string[];
}

/**
 * 예약에 실을 변수 값을 검사한다.
 *
 * 예약은 사람이 없을 때 돈다. 빈 값을 저장하면 그 자리에서 물어볼 방법이 없어 밤중에
 * 빈 칸을 입력한 채 실행되고, 아침에 남는 것은 "왜 실패했는지 모르는 실패" 하나다.
 * 그래서 **모든 변수는 값이 있어야 한다** (`rules.required` 가 없어도 마찬가지다).
 * 규칙이 있으면 형식(`pattern`)과 선택지(`enum`)도 저장 전에 본다.
 */
export function validateScheduleVariables(
  variables: readonly WizardVariableDef[],
  args: Record<string, string>,
): VariableError | null {
  for (const variable of variables) {
    if (!variable || typeof variable.key !== 'string' || !variable.key) continue;
    const value = String(args[variable.key] ?? '').trim();
    if (!value) return { key: variable.key, reason: 'required_empty' };

    const rules = variable.rules;
    if (rules?.enum && rules.enum.length > 0 && !rules.enum.includes(value)) {
      return { key: variable.key, reason: 'enum', allowed: rules.enum.slice() };
    }
    if (rules?.pattern) {
      let re: RegExp | null = null;
      try {
        re = new RegExp(rules.pattern);
      } catch {
        // 흐름에 잘못된 정규식이 들어 있으면 그것으로 값을 막지 않는다. 값 잘못이 아니다.
        re = null;
      }
      if (re && !re.test(value)) return { key: variable.key, reason: 'pattern' };
    }
  }
  return null;
}

/** 변수 오류 문구. 어떤 변수인지 이름을 먼저 말한다. */
export function variableErrorMessage(
  error: VariableError,
  label: string,
  t: Translate = getMessage,
): string {
  const name = label || error.key;
  switch (error.reason) {
    case 'enum':
      return t('sidepanel_daily_error_var_enum', [name, (error.allowed || []).join(', ')]);
    case 'pattern':
      return t('sidepanel_daily_error_var_pattern', [name]);
    case 'required_empty':
    default:
      return t('sidepanel_daily_error_var_required', [name]);
  }
}

/**
 * "지금 실행" 결과 문구 키 (2026-09-05 Codex 리뷰 4항).
 *
 * 백그라운드는 같은 예약이 이미 큐에 있으면 새로 넣지 않고 `queued:false` 로 답한다.
 * 그때도 "실행을 시작했다" 고 말하면 사용자는 두 번 눌러도 아무 일이 없다고 읽는다.
 */
export function runNowMessageKey(queued: boolean | undefined): string {
  return queued === false ? 'sidepanel_daily_run_already_queued' : 'sidepanel_daily_run_started';
}

/** 예약 불가 이유 문구. */
export function flowScheduleBlockMessage(
  reason: FlowScheduleBlockReason,
  t: Translate = getMessage,
): string {
  switch (reason) {
    case 'flow_start_url_required':
      return t('sidepanel_daily_block_start_url');
    case 'flow_not_published':
      return t('sidepanel_daily_block_not_published');
    case 'flow_has_sensitive_vars':
    default:
      return t('sidepanel_daily_block_sensitive');
  }
}
