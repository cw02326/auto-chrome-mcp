/**
 * 매일 작업 화면의 문구 만들기 (2026-09-05 사이드패널 2단계 E).
 *
 * 크롬 API 를 부르지 않는 순수 함수만 둔다. 번역 함수를 인자로 받으므로 테스트에서
 * 가짜 번역기를 넣어 "어떤 키에 어떤 값을 넘겼는가" 를 그대로 확인할 수 있다.
 *
 * 사용자에게 보이는 문구에 대시류 문자를 쓰지 않는다. 날짜 구분은 점이다.
 */

import { getMessage } from '@/utils/i18n';
import type { ScheduleExpressionView } from './daily-messages';

export type Translate = (key: string, substitutions?: string[]) => string;

/**
 * 이력 상태 9종. 백그라운드는 문자열로 주므로(`RunStatus`) 화면에서 다시 좁힌다.
 * 모르는 값이 와도 감추지 않고 그대로 보여 준다.
 */
export type DailyRunStatus =
  | 'running'
  | 'success'
  | 'failed'
  | 'stopped'
  | 'timeout'
  | 'interrupted'
  | 'skipped_queue'
  | 'login_required'
  | 'user_took_over_tab';

/** 요일 이름. 인덱스는 `Date.getDay()` 와 같다(예약 엔진의 `DAY_NAMES` 와 같은 순서). */
export const DAY_KEYS: readonly string[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** 화면에 늘어놓는 순서. 월요일부터 시작한다. */
export const DAY_DISPLAY_ORDER: readonly string[] = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
];

/** 간격 선택지. 예약 엔진의 `EVERY_MINUTES` 키와 같다. */
export const EVERY_KEYS: readonly string[] = ['15m', '1h', '6h', '24h'];

/** 상태 9종의 문구 키. */
export const RUN_STATUS_MESSAGE_KEYS: Readonly<Record<DailyRunStatus, string>> = {
  running: 'sidepanel_daily_status_running',
  success: 'sidepanel_daily_status_success',
  failed: 'sidepanel_daily_status_failed',
  stopped: 'sidepanel_daily_status_stopped',
  timeout: 'sidepanel_daily_status_timeout',
  interrupted: 'sidepanel_daily_status_interrupted',
  skipped_queue: 'sidepanel_daily_status_skipped_queue',
  login_required: 'sidepanel_daily_status_login_required',
  user_took_over_tab: 'sidepanel_daily_status_user_took_over_tab',
};

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 요일 한 개의 표시 이름. */
export function dayLabel(day: string, t: Translate = getMessage): string {
  const key = String(day || '').toLowerCase();
  if (!DAY_KEYS.includes(key)) return day;
  return t(`sidepanel_daily_day_${key}`);
}

/** 고른 요일들을 저장 순서와 무관하게 일요일 기준 주 순서로 정리해 붙인다. */
export function formatDays(days: readonly string[], t: Translate = getMessage): string {
  const picked = DAY_DISPLAY_ORDER.filter((d) => days.some((x) => String(x).toLowerCase() === d));
  return picked.map((d) => dayLabel(d, t)).join(' ');
}

/** 시각 목록을 오름차순으로 붙인다. */
export function formatTimes(times: readonly string[]): string {
  return times
    .map((x) => String(x))
    .slice()
    .sort()
    .join(', ');
}

/**
 * 예약 요약 한 줄. "매일 08:00", "월 수 금 09:30", "6시간마다".
 *
 * 표현이 비었거나 알 수 없으면 안내 문구를 돌려준다. 화면이 빈 칸을 그리지 않게 하려는 것이다.
 */
export function summarizeSchedule(
  schedule: ScheduleExpressionView | undefined | null,
  t: Translate = getMessage,
): string {
  if (!schedule) return t('sidepanel_daily_summary_unknown');

  const every = typeof schedule.every === 'string' ? schedule.every : '';
  if (every) {
    if (!EVERY_KEYS.includes(every)) return t('sidepanel_daily_summary_unknown');
    return t(`sidepanel_daily_every_${every}`);
  }

  const times = Array.isArray(schedule.daily) ? schedule.daily.filter(Boolean) : [];
  if (times.length === 0) return t('sidepanel_daily_summary_unknown');

  const days = Array.isArray(schedule.days) ? schedule.days.filter(Boolean) : [];
  if (days.length > 0 && days.length < 7) {
    return t('sidepanel_daily_summary_days', [formatDays(days, t), formatTimes(times)]);
  }
  return t('sidepanel_daily_summary_daily', [formatTimes(times)]);
}

/** 벽시계 시각 (HH:MM). */
export function formatClock(at: number): string {
  const d = new Date(at);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 날짜와 시각 (MM.DD HH:MM). 날짜 구분은 점이다. */
export function formatDateTime(at: number): string {
  const d = new Date(at);
  return `${pad2(d.getMonth() + 1)}.${pad2(d.getDate())} ${formatClock(at)}`;
}

function startOfDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 다음 실행 시각을 사람이 읽는 말로.
 *
 * 한 시간 안이면 남은 분, 오늘·내일이면 그 말과 시각, 그보다 멀면 날짜와 시각이다.
 * 이미 지난 시각은 "곧" 이다 - 알람이 아직 안 울렸을 뿐이라 과거로 보여주면 고장으로 읽힌다.
 */
export function formatNextRun(
  nextAt: number | null | undefined,
  now: number = Date.now(),
  t: Translate = getMessage,
): string {
  if (typeof nextAt !== 'number' || !Number.isFinite(nextAt) || nextAt <= 0) {
    return t('sidepanel_daily_next_none');
  }
  const diff = nextAt - now;
  if (diff <= 0) return t('sidepanel_daily_next_soon');
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return t('sidepanel_daily_next_soon');
  if (minutes < 60) return t('sidepanel_daily_next_in_minutes', [String(minutes)]);

  const today = startOfDay(now);
  const day = startOfDay(nextAt);
  const dayDiff = Math.round((day - today) / 86400000);
  if (dayDiff <= 0) return t('sidepanel_daily_next_today', [formatClock(nextAt)]);
  if (dayDiff === 1) return t('sidepanel_daily_next_tomorrow', [formatClock(nextAt)]);
  return formatDateTime(nextAt);
}

/** 마지막 결과 시각. 오늘이면 시각만, 아니면 날짜까지. */
export function formatRunTime(at: number | null | undefined, now: number = Date.now()): string {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return '';
  return startOfDay(at) === startOfDay(now) ? formatClock(at) : formatDateTime(at);
}

/** 상태 문구. 모르는 값은 그대로 보여준다(감추면 원인을 못 찾는다). */
export function formatRunStatus(status: string | undefined, t: Translate = getMessage): string {
  if (!status) return '';
  const key = RUN_STATUS_MESSAGE_KEYS[status as DailyRunStatus];
  return key ? t(key) : status;
}

/** 상태별 색. 성공은 초록, 진행 중은 파랑, 로그인 필요·건너뜀은 주의색, 나머지는 빨강. */
export function runStatusColor(status: string | undefined): string {
  switch (status) {
    case 'success':
      return 'var(--ac-success, #16a34a)';
    case 'running':
      return 'var(--ac-primary, #3b82f6)';
    case 'login_required':
    case 'skipped_queue':
    case 'user_took_over_tab':
    case 'stopped':
      return 'var(--ac-warning, #b45309)';
    default:
      return 'var(--ac-danger, #ef4444)';
  }
}

/** 걸린 시간. 초 단위로 한 자리까지. */
export function formatDuration(
  durationMs: number | null | undefined,
  t: Translate = getMessage,
): string {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return '';
  return t('sidepanel_daily_history_duration', [(durationMs / 1000).toFixed(1)]);
}
