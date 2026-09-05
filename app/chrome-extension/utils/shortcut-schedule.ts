/**
 * auto-chrome-mcp fork: chrome_shortcut 예약 실행 레코드.
 *
 * 설계 계약: docs/plans/2026-09-05-daily-automation-design.md 1절 (구현 순서 3단계).
 *
 * 왜 필요한가: 사용자가 매일 하는 웹 업무를 Claude 없이 돌리려면 "언제 도는가" 를 크롬
 * 안에 남겨야 한다. 브리지는 Claude Code 가 띄우는 stdio 프로세스라 Claude 가 없으면
 * 없고, 항상 떠 있는 것은 크롬뿐이다.
 *
 * 이 모듈의 규칙:
 *   - 저장소 키는 `mcpShortcutSchedules` 하나. `{ [name]: ScheduleRecord }`.
 *   - 표현은 `every`(15m/1h/6h/24h) 또는 `daily`(HH:mm 최대 4개) 중 **정확히 하나**.
 *     cron 은 쓰지 않는다. 사용자가 읽지 못하는 표기이고 파서가 곧 오류 표면이다.
 *   - 시각 계산은 전부 로컬 시간이다. 없는 시각(DST spring-forward)은 그 다음 존재하는
 *     분에 1회, 두 번 오는 시각(fall-back)은 앞선 것 1회만. 두 경우 모두 "그 날 안에서
 *     벽시계가 목표 분 이상이 되는 가장 이른 순간" 이라는 한 규칙으로 처리한다.
 *   - `every` 의 다음 due 는 **이전 due 기준 격자**다. 실행이 밀려도 격자는 안 밀린다.
 *   - `revision` 은 예약이 바뀔 때마다 오른다. 실행 중이던 run 은 종료 시 revision 이
 *     다르면 재무장도 상태 갱신도 하지 않는다(`superseded`).
 *
 * 순수 함수(크롬 API 없음)와 저장소 접근을 한 파일에 두되, 저장소 쓰기는 이력과 같은
 * 이유로 직렬 큐 하나를 지난다.
 */

import type { FinalRunStatus } from './shortcut-history';

/** 예약 레코드 저장소 키. */
export const SCHEDULE_STORAGE_KEY = 'mcpShortcutSchedules';

/**
 * 저장소 전역 단조 증가 카운터 키 (2026-09-05 Codex 리뷰 3).
 *
 * `revision` 은 레코드마다 1부터 다시 시작한다. 그래서 실행 도중 사용자가 예약을 지웠다가
 * 같은 이름으로 다시 걸면 revision 이 옛 값과 같아질 수 있고(ABA), 끝난 실행이 "내 예약이
 * 그대로다" 로 오판해 지워졌던 예약을 다시 무장한다. 이 카운터는 예약 저장소 전체에서
 * 한 번 쓴 값을 다시 쓰지 않으므로 그 오판을 없앤다.
 */
export const SCHEDULE_GENERATION_KEY = 'mcpShortcutScheduleGeneration';

/** 예약 최대 개수. shortcut 50개 중 매일 돌 것은 소수이고, 알람 20개는 크롬 상한 안이다. */
export const MAX_SCHEDULES = 20;

/** 알람 이름 접두. `chrome.alarms.getAll` 에서 우리 알람만 골라내는 손잡이다. */
export const SCHEDULE_ALARM_PREFIX = 'mcp-shortcut::';

/** `every` 가 받는 값과 분 단위 주기. 최소 15분 - 한 실행이 100초까지 걸린다. */
export const EVERY_MINUTES: Readonly<Record<string, number>> = {
  '15m': 15,
  '1h': 60,
  '6h': 360,
  '24h': 1440,
};

/** `daily` 시각 최대 개수. */
export const MAX_DAILY_TIMES = 4;
/** 같은 날 안에서 `daily` 시각끼리 지켜야 하는 최소 간격(분). */
export const MIN_DAILY_GAP_MINUTES = 5;

/** `days` 가 받는 값. 인덱스는 `Date.getDay()` 와 같다. */
export const DAY_NAMES: readonly string[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** 다음 due 를 찾을 때 며칠까지 앞을 보는가 (`days` 가 하루만 있어도 넉넉하다). */
const MAX_LOOKAHEAD_DAYS = 14;

export interface ScheduleExpression {
  every?: string;
  daily?: string[];
  days?: string[];
}

/**
 * 예약이 무엇을 돌리는가 (2026-09-05 사이드패널 2단계 D).
 *
 * 예약 엔진은 하나지만 대상은 둘이다: 저장된 단축(`chrome_shortcut`)과 발행된 흐름
 * (record-replay). 대상을 레코드에 명시해야 실행기가 분기할 수 있고, 흐름이 지워져도
 * 이력이 무엇을 가리켰는지 남는다.
 */
export type ScheduleTarget =
  | { kind: 'shortcut'; name: string }
  | { kind: 'flow'; flowId: string; args?: Record<string, string> };

export type ScheduleKind = ScheduleTarget['kind'];

/**
 * 예약 식별자 접두 (2026-09-05 Codex 설계 검토 1).
 *
 * 표시 이름과 내부 식별자를 나눈다. 예전 설계는 흐름 예약의 `name` 을 `flow:<flowId>` 로
 * 두려 했는데, 그러면 그 문자열을 이름으로 가진 단축과 저장소 키·알람·이력이 겹친다.
 * 겹침을 막으려고 단축 이름 공간에 접두사를 예약하는 것은 사용자에게 이유를 설명할 수
 * 없는 제약이라(단축 이름은 사용자 자유다) 대신 **양쪽 모두** 접두를 붙이고 뒤를
 * `encodeURIComponent` 로 감쌌다. 인코딩된 뒤에는 ':' 이 남지 않으므로 두 공간이 절대
 * 만나지 않는다.
 */
export const SHORTCUT_SCHEDULE_PREFIX = 'shortcut:';
export const FLOW_SCHEDULE_PREFIX = 'flow:';

/** 단축 예약의 식별자. */
export function scheduleIdForShortcut(name: string): string {
  return `${SHORTCUT_SCHEDULE_PREFIX}${encodeURIComponent(name)}`;
}

/** 흐름 예약의 식별자. */
export function scheduleIdForFlow(flowId: string): string {
  return `${FLOW_SCHEDULE_PREFIX}${encodeURIComponent(flowId)}`;
}

/** 식별자에서 대상을 되찾는다. 우리 형식이 아니면 null. */
export function parseScheduleId(scheduleId: unknown): ScheduleTarget | null {
  if (typeof scheduleId !== 'string' || scheduleId.length === 0) return null;
  const decode = (raw: string): string | null => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  };
  if (scheduleId.startsWith(SHORTCUT_SCHEDULE_PREFIX)) {
    const name = decode(scheduleId.slice(SHORTCUT_SCHEDULE_PREFIX.length));
    return name ? { kind: 'shortcut', name } : null;
  }
  if (scheduleId.startsWith(FLOW_SCHEDULE_PREFIX)) {
    const flowId = decode(scheduleId.slice(FLOW_SCHEDULE_PREFIX.length));
    return flowId ? { kind: 'flow', flowId } : null;
  }
  return null;
}

/** 작업 탭 버킷의 레인 이름 상한 (`utils/work-tab-manager.ts` 와 같은 값). */
const MAX_LANE_LENGTH = 64;

/**
 * 32bit FNV-1a. 짧고 안정적인 값이면 충분하다 (암호용이 아니다).
 */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * 이 예약이 쓰는 작업 탭 레인 이름.
 *
 * 레인은 `sessionKeyOf` 가 64자에서 자른다. 흐름 id 가 길면 잘린 두 예약이 같은 레인을
 * 쓰게 되어 서로의 작업 탭을 건드린다. 그래서 상한을 넘으면 해시로 접는다.
 */
export function laneForScheduleId(scheduleId: unknown): string {
  const value = typeof scheduleId === 'string' ? scheduleId : '';
  if (value.length <= MAX_LANE_LENGTH) return value;
  return `sched-${shortHash(value)}`;
}

export interface ScheduleRecord {
  /**
   * 저장소 키이자 알람·잠금·이력·레인의 식별자 (`shortcut:<enc>` 또는 `flow:<enc>`).
   * 이 필드가 없는 옛 레코드는 읽을 때 단축으로 보정한다 (저장하지 않는다).
   */
  scheduleId: string;
  /** 화면에 보여 줄 이름. 단축은 단축 이름, 흐름은 예약 당시의 흐름 이름 스냅샷이다. */
  name: string;
  /** 무엇을 돌리는가. 없으면 `{ kind: 'shortcut', name }` 으로 읽는다. */
  target?: ScheduleTarget;
  /**
   * 꺼진 예약은 알람이 없고 실행되지 않는다. 레코드는 남는다(다시 켤 수 있어야 한다).
   * 이 필드가 없는 옛 레코드는 켜진 것으로 읽는다.
   */
  enabled?: boolean;
  schedule: ScheduleExpression;
  /** 실행마다 주입할 파라미터 값. `secret` 이름은 절대 들어오지 못한다. */
  params?: Record<string, unknown>;
  notify: boolean;
  report: boolean;
  /** 이 이름의 top-level step 이 `stopIf` 로 멈추면 `login_required` 다. */
  loginCheck?: string;
  /** 다음 실행 예정 시각 (epoch ms). */
  nextAt: number;
  /** `every` 격자의 기준점. 실행이 밀려도 격자는 이 값에서 센다. */
  anchorAt: number;
  revision: number;
  /**
   * 저장소 전역 단조 값. 레코드가 바뀔 때마다 새 값을 받고 같은 값을 다시 쓰지 않는다.
   * 실행 중이던 run 은 이 값으로 "내가 시작할 때의 그 예약이 맞는가" 를 판정한다.
   */
  generation: number;
  createdAt: number;
  updatedAt: number;
  /** 레코드를 만들 때의 타임존. 달라지면 `nextAt` 을 전부 다시 계산한다. */
  timeZone: string;
  /** 그때의 UTC 오프셋(분). `Intl` 이 같은 이름을 줘도 오프셋이 바뀌면 재계산한다. */
  offsetMinutes: number;
  lastRunId?: string;
  lastStatus?: FinalRunStatus;
  lastRunAt?: number;
  /** 연속 실패 수. 알림은 1회째와 3회째만 보낸다. */
  failStreak: number;
}

export type ScheduleMap = Record<string, ScheduleRecord>;

/* ------------------------------------------------------------------ *
 * 표현 검증 (순수 함수)
 * ------------------------------------------------------------------ */

export interface ParsedSchedule {
  schedule: ScheduleExpression;
  /** `every` 일 때의 분 단위 주기. */
  everyMinutes?: number;
  /** `daily` 일 때 자정 기준 분으로 바꾼 시각들 (오름차순). */
  dailyMinutes?: number[];
  /** `days` 를 `Date.getDay()` 인덱스로 바꾼 집합. 비어 있으면 매일이다. */
  dayIndexes?: number[];
}

export type ScheduleValidation =
  | { ok: true; parsed: ParsedSchedule }
  | { ok: false; error: string };

function invalid(detail: string): { ok: false; error: string } {
  return { ok: false, error: `schedule_invalid: ${detail}` };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `HH:mm` 을 자정 기준 분으로. 형식이 어긋나면 null. */
export function parseClockTime(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(raw.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * `schedule` 표현을 검증한다. `every` 와 `daily` 중 정확히 하나여야 한다.
 * 둘 다 있거나 둘 다 없으면 거절 - 어느 쪽으로 해석해도 사용자 의도와 다를 수 있다.
 */
export function validateScheduleExpression(raw: unknown): ScheduleValidation {
  if (!isPlainObject(raw)) {
    return invalid('"schedule" must be an object with "every" or "daily"');
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'every' && key !== 'daily' && key !== 'days') {
      return invalid(`"schedule" does not take "${key}"`);
    }
  }

  const hasEvery = raw.every !== undefined;
  const hasDaily = raw.daily !== undefined;
  if (hasEvery && hasDaily) {
    return invalid('use either "every" or "daily", not both');
  }
  if (!hasEvery && !hasDaily) {
    return invalid('one of "every" or "daily" is required');
  }

  if (hasEvery) {
    if (raw.days !== undefined) {
      return invalid('"days" only applies to "daily"');
    }
    if (typeof raw.every !== 'string' || !Object.hasOwn(EVERY_MINUTES, raw.every)) {
      return invalid(`"every" must be one of ${Object.keys(EVERY_MINUTES).join(', ')}`);
    }
    return {
      ok: true,
      parsed: { schedule: { every: raw.every }, everyMinutes: EVERY_MINUTES[raw.every] },
    };
  }

  if (!Array.isArray(raw.daily) || raw.daily.length === 0) {
    return invalid('"daily" must be a non-empty array of "HH:mm" strings');
  }
  if (raw.daily.length > MAX_DAILY_TIMES) {
    return invalid(`"daily" takes at most ${MAX_DAILY_TIMES} times`);
  }

  const minutes: number[] = [];
  for (const entry of raw.daily) {
    const parsed = parseClockTime(entry);
    if (parsed === null) {
      return invalid(`"${String(entry)}" is not a "HH:mm" time`);
    }
    if (minutes.includes(parsed)) {
      return invalid(`"daily" repeats the same time "${String(entry)}"`);
    }
    minutes.push(parsed);
  }
  minutes.sort((a, b) => a - b);
  // 간격 검사는 **같은 날 안에서만** 한다. 23:58 과 00:01 은 서로 다른 날이라 허용된다.
  for (let i = 1; i < minutes.length; i++) {
    if (minutes[i] - minutes[i - 1] < MIN_DAILY_GAP_MINUTES) {
      return invalid(`"daily" times must be at least ${MIN_DAILY_GAP_MINUTES} minutes apart`);
    }
  }

  const dayIndexes: number[] = [];
  if (raw.days !== undefined) {
    if (!Array.isArray(raw.days) || raw.days.length === 0) {
      return invalid(`"days" must be a non-empty array of ${DAY_NAMES.join(', ')}`);
    }
    for (const day of raw.days) {
      const index = typeof day === 'string' ? DAY_NAMES.indexOf(day.trim().toLowerCase()) : -1;
      if (index === -1) {
        return invalid(`"${String(day)}" is not one of ${DAY_NAMES.join(', ')}`);
      }
      if (!dayIndexes.includes(index)) dayIndexes.push(index);
    }
    dayIndexes.sort((a, b) => a - b);
  }

  const schedule: ScheduleExpression = {
    daily: minutes.map(formatClockTime),
  };
  if (dayIndexes.length > 0) schedule.days = dayIndexes.map((i) => DAY_NAMES[i]);

  return { ok: true, parsed: { schedule, dailyMinutes: minutes, dayIndexes } };
}

/** 자정 기준 분을 `HH:mm` 으로. */
export function formatClockTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ *
 * 첫 step 검증 (순수 함수)
 * ------------------------------------------------------------------ */

/** navigate 인자에 있으면 "탭을 만들지 않는" 동작이 되는 키들. */
const NON_CREATING_NAVIGATE_KEYS: readonly string[] = ['refresh', 'back', 'forward'];

/**
 * 예약 실행의 `steps[0]` 규칙 (설계 2절).
 *
 * 작업 탭이 없는 세션은 게이트가 `no_work_tab` 으로 거절하므로, navigate 로 작업 탭을
 * 만드는 것 외에 시작할 길이 없다. 조건부·새로고침 navigate 는 탭을 만들지 않는다.
 * 문제가 있으면 문구를, 없으면 null 을 돌려준다.
 */
export function validateScheduleFirstStep(steps: unknown): string | null {
  const prefix = 'schedule_first_step_invalid';
  if (!Array.isArray(steps) || steps.length === 0) {
    return `${prefix}: this shortcut has no steps`;
  }
  const first = steps[0];
  if (!isPlainObject(first)) {
    return `${prefix}: the first step must be a chrome_navigate step`;
  }
  if (first.repeat !== undefined || Array.isArray(first.steps)) {
    return `${prefix}: the first step cannot be a repeat group`;
  }
  if (first.when !== undefined) {
    return `${prefix}: the first step cannot have a "when" condition`;
  }
  if (first.tool !== 'chrome_navigate') {
    return `${prefix}: the first step must be chrome_navigate so the run gets its own work tab`;
  }
  const args = isPlainObject(first.args) ? first.args : {};
  if (typeof args.url !== 'string' || args.url.trim().length === 0) {
    return `${prefix}: chrome_navigate needs a "url" string`;
  }
  for (const key of NON_CREATING_NAVIGATE_KEYS) {
    if (args[key]) {
      return `${prefix}: "${key}" reuses an existing tab instead of opening the work tab`;
    }
  }
  return null;
}

/**
 * `loginCheck` 는 top-level step 의 `as` 만 가리킬 수 있다. 반복 묶음 안쪽 이름은 회차마다
 * 비워져 판정이 흔들린다. 이름이 유효하면 null, 아니면 문구를 돌려준다.
 */
export function validateLoginCheck(steps: unknown, loginCheck: unknown): string | null {
  if (loginCheck === undefined) return null;
  if (typeof loginCheck !== 'string' || loginCheck.trim().length === 0) {
    return 'schedule_invalid: "loginCheck" must be the "as" name of a top level step';
  }
  const wanted = loginCheck.trim();
  const list = Array.isArray(steps) ? steps : [];
  const found = list.some(
    (step) => isPlainObject(step) && step.repeat === undefined && step.as === wanted,
  );
  if (!found) {
    return `schedule_invalid: "loginCheck" name "${wanted}" is not the "as" of a top level step`;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 시각 계산 (순수 함수, 전부 로컬 시간)
 * ------------------------------------------------------------------ */

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** 그 순간의 로컬 벽시계를 자정 기준 분으로. */
function wallMinutesOf(t: number): number {
  const d = new Date(t);
  return d.getHours() * 60 + d.getMinutes();
}

/** 로컬 날짜 키 (연*10000 + 월*100 + 일). 날짜 비교를 정수 하나로 한다. */
function dayKeyOf(t: number): number {
  const d = new Date(t);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/** 그 로컬 날짜의 자정(존재하는 가장 이른 순간). */
function startOfLocalDay(year: number, month: number, day: number): number {
  return new Date(year, month, day, 0, 0, 0, 0).getTime();
}

/** 되돌아가는 벽시계(fall-back)를 덮기 위해 목표 시각 앞뒤로 훑는 폭. */
const WALL_SCAN_MARGIN_MS = 3 * 60 * MINUTE_MS;

/**
 * `dayStart` 가 속한 로컬 날짜에서 벽시계가 `minutes` 이상이 되는 **가장 이른 순간**.
 * 그 날 안에 그런 순간이 없으면 null (하루가 통째로 건너뛰어진 극단적 존 변경).
 *
 * 이 한 규칙이 DST 두 경우를 모두 덮는다:
 *   - spring-forward 로 02:30 이 없는 날 -> 03:00 (건너뛴 직후 첫 존재하는 순간) 1회
 *   - fall-back 으로 01:45 가 두 번 오는 날 -> 앞선(아직 여름시간인) 01:45 1회
 *
 * 2026-09-05 Codex 리뷰 8: 예전에는 이분 탐색이었다. 이분 탐색은 벽시계가 시간이 흐를수록
 * 줄지 않는다고 전제하는데, fall-back 날의 벽시계는 01:59 다음에 01:00 으로 되돌아간다.
 * 그래서 "01:45 이상" 이라는 조건이 참 -> 거짓 -> 참으로 두 번 갈리고, 탐색이 **뒤엣것**
 * (표준시로 넘어간 01:45)을 골랐다. 실제 instant 를 분 단위로 훑어 첫 발생을 찾는다.
 * 훑는 구간은 목표 시각 앞뒤 3시간이라 어떤 존의 전환 폭(최대 2시간)보다 넓다.
 */
export function firstInstantAtOrAfterWall(dayStart: number, minutes: number): number | null {
  const key = dayKeyOf(dayStart);
  const base = new Date(dayStart);
  // 순진한 후보(존재하지 않는 시각이면 크롬이 뒤로 밀어 준다)를 훑기의 중심으로 삼는다.
  const guess = new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    Math.floor(minutes / 60),
    minutes % 60,
    0,
    0,
  ).getTime();

  const from = Math.max(dayStart, guess - WALL_SCAN_MARGIN_MS);
  const until = Math.min(dayStart + 27 * 60 * MINUTE_MS, guess + WALL_SCAN_MARGIN_MS);

  for (let t = from; t <= until; t += MINUTE_MS) {
    const k = dayKeyOf(t);
    if (k > key) return null;
    if (k < key) continue;
    if (wallMinutesOf(t) >= minutes) return t;
  }
  return null;
}

/**
 * `every` 의 다음 due. **이전 due 기준 격자**이고 `from` 보다 반드시 뒤다.
 * 실행이 1분 40초 밀려 끝나도 다음 due 는 원래 격자 위(예: 09:00)에 있다.
 */
export function nextEveryAt(anchorAt: number, everyMinutes: number, from: number): number {
  const period = Math.max(1, everyMinutes) * MINUTE_MS;
  if (from < anchorAt) return anchorAt;
  const steps = Math.floor((from - anchorAt) / period) + 1;
  return anchorAt + steps * period;
}

/**
 * `daily` 의 다음 due. `from` 보다 뒤인 가장 이른 시각.
 * `dayIndexes` 가 비어 있으면 매일이다.
 */
export function nextDailyAt(
  dailyMinutes: readonly number[],
  dayIndexes: readonly number[],
  from: number,
): number | null {
  const sorted = [...dailyMinutes].sort((a, b) => a - b);
  const base = new Date(from);
  for (let offset = 0; offset <= MAX_LOOKAHEAD_DAYS; offset++) {
    const probe = new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate() + offset,
      12,
      0,
      0,
      0,
    );
    if (dayIndexes.length > 0 && !dayIndexes.includes(probe.getDay())) continue;
    const dayStart = startOfLocalDay(probe.getFullYear(), probe.getMonth(), probe.getDate());
    for (const minutes of sorted) {
      const due = firstInstantAtOrAfterWall(dayStart, minutes);
      if (due !== null && due > from) return due;
    }
  }
  return null;
}

/** 레코드의 다음 due. 계산할 수 없으면 null (호출부가 예약을 거절하거나 비운다). */
export function computeNextAt(record: ScheduleRecord, from: number = Date.now()): number | null {
  const validation = validateScheduleExpression(record.schedule);
  if (!validation.ok) return null;
  const parsed = validation.parsed;
  if (parsed.everyMinutes !== undefined) {
    const anchor = Number.isFinite(record.anchorAt) ? record.anchorAt : record.createdAt;
    return nextEveryAt(anchor, parsed.everyMinutes, from);
  }
  return nextDailyAt(parsed.dailyMinutes ?? [], parsed.dayIndexes ?? [], from);
}

/* ------------------------------------------------------------------ *
 * 이름·식별자
 * ------------------------------------------------------------------ */

/** 예약 실행의 알람 이름 (`mcp-shortcut::<scheduleId>`). */
export function alarmNameFor(scheduleId: string): string {
  return `${SCHEDULE_ALARM_PREFIX}${scheduleId}`;
}

/** 알람 이름에서 scheduleId 를 되찾는다. 우리 알람이 아니면 null. */
export function scheduleNameFromAlarm(alarmName: unknown): string | null {
  if (typeof alarmName !== 'string' || !alarmName.startsWith(SCHEDULE_ALARM_PREFIX)) return null;
  const scheduleId = alarmName.slice(SCHEDULE_ALARM_PREFIX.length);
  return scheduleId.length > 0 ? scheduleId : null;
}

/**
 * 알람을 건다. **항상 일회성**이다 - `periodInMinutes` 를 쓰지 않는 이유는 코드 경로가
 * 하나가 되고, 크롬이 꺼져 있던 동안 쌓인 주기 알람이 몰아서 울리지 않기 때문이다.
 * 같은 이름으로 다시 걸면 크롬이 이전 알람을 대체하므로 알람은 항상 하나만 남는다.
 */
export async function armScheduleAlarm(scheduleId: string, when: number): Promise<void> {
  try {
    await chrome.alarms.create(alarmNameFor(scheduleId), { when });
  } catch (error) {
    console.warn('[shortcut-schedule] 알람 등록 실패:', error);
  }
}

/** 알람을 지운다. */
export async function clearScheduleAlarm(scheduleId: string): Promise<boolean> {
  try {
    return await chrome.alarms.clear(alarmNameFor(scheduleId));
  } catch {
    return false;
  }
}

/**
 * 예약 실행의 `runId`. 알람과 `reconcile()` 따라잡기가 같은 due 를 동시에 집어도 키가
 * 같아 이력이 1건이다 (한쪽이 storage claim 에서 진다).
 */
export function scheduleRunId(scheduleId: string, dueAt: number): string {
  return `${scheduleId}:${new Date(dueAt).toISOString()}`;
}

/** 이 실행이 쓰는 합성 세션 키의 세션 id. lane 은 `laneForScheduleId` 가 만든다. */
export const SCHEDULED_SESSION_ID = 'scheduled';

/** 예약 실행 중 MCP 탭 그룹에 붙는 제목. */
export function scheduleTaskTitle(label: string): string {
  return `예약: ${label}`;
}

/* ------------------------------------------------------------------ *
 * 타임존 서명
 * ------------------------------------------------------------------ */

export interface TimeZoneSignature {
  timeZone: string;
  offsetMinutes: number;
}

export function currentTimeZoneSignature(now: number = Date.now()): TimeZoneSignature {
  let timeZone = '';
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    timeZone = '';
  }
  return { timeZone, offsetMinutes: new Date(now).getTimezoneOffset() };
}

/** 존이 달라졌는가. 이름이 같아도 오프셋이 바뀌면 다시 계산해야 한다. */
export function timeZoneChanged(record: ScheduleRecord, signature: TimeZoneSignature): boolean {
  return record.timeZone !== signature.timeZone || record.offsetMinutes !== signature.offsetMinutes;
}

/* ------------------------------------------------------------------ *
 * 저장소 (직렬 큐 하나를 지난다)
 * ------------------------------------------------------------------ */

let scheduleQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = scheduleQueue.then(fn, fn);
  scheduleQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 읽기 보정 (2026-09-05 Codex 설계 검토 1).
 *
 * `scheduleId`·`target`·`enabled` 가 생기기 전에 저장된 레코드는 저장소 키가 곧 단축
 * 이름이었다. 그 사실을 **메모리에서만** 채운다. 읽을 때마다 저장하면 `generation` 이
 * 흔들려 정상 실행이 `superseded` 로 끝나므로, revision·generation 은 손대지 않는다.
 * (실제 저장은 이 레코드를 고치는 다른 쓰기가 일어날 때 따라온다.)
 */
export function normalizeScheduleRecord(raw: unknown, storageKey: string): ScheduleRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as ScheduleRecord;
  if (typeof record.generation !== 'number') record.generation = 0;
  const name = typeof record.name === 'string' && record.name ? record.name : storageKey;
  record.name = name;
  if (!record.target || typeof record.target !== 'object') {
    record.target = { kind: 'shortcut', name };
  }
  if (typeof record.scheduleId !== 'string' || record.scheduleId.length === 0) {
    record.scheduleId =
      record.target.kind === 'flow'
        ? scheduleIdForFlow(record.target.flowId)
        : scheduleIdForShortcut(record.target.name);
  }
  if (typeof record.enabled !== 'boolean') record.enabled = true;
  return record;
}

async function loadMap(): Promise<ScheduleMap> {
  try {
    const result = await chrome.storage.local.get([SCHEDULE_STORAGE_KEY]);
    const raw = (result as any)?.[SCHEDULE_STORAGE_KEY];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: ScheduleMap = {};
    for (const key of Object.keys(raw as Record<string, unknown>)) {
      const record = normalizeScheduleRecord((raw as Record<string, unknown>)[key], key);
      if (record) out[record.scheduleId] = record;
    }
    return out;
  } catch {
    return {};
  }
}

async function persistMap(map: ScheduleMap): Promise<void> {
  await chrome.storage.local.set({ [SCHEDULE_STORAGE_KEY]: map });
}

/**
 * 다음 generation 값. **직렬 큐 안에서만** 부른다 - 큐가 read-modify-write 를 하나로
 * 세우므로 값이 겹치지 않는다. 저장에 실패해도 메모리 값은 올려, 같은 워커가 같은 값을
 * 두 번 쓰는 일은 없게 한다.
 */
let cachedGeneration = 0;
async function nextGeneration(): Promise<number> {
  let stored = 0;
  try {
    const result = await chrome.storage.local.get([SCHEDULE_GENERATION_KEY]);
    const raw = (result as any)?.[SCHEDULE_GENERATION_KEY];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) stored = Math.floor(raw);
  } catch {
    stored = 0;
  }
  const next = Math.max(stored, cachedGeneration) + 1;
  cachedGeneration = next;
  try {
    await chrome.storage.local.set({ [SCHEDULE_GENERATION_KEY]: next });
  } catch {
    // 저장 실패는 다음 호출이 메모리 값에서 이어 간다.
  }
  return next;
}

/** 갱신 전에 확인할 값. 하나라도 어긋나면 아무것도 쓰지 않는다. */
export interface ScheduleExpectation {
  revision?: number;
  generation?: number;
}

function matchesExpectation(record: ScheduleRecord, expect?: ScheduleExpectation): boolean {
  if (!expect) return true;
  if (expect.revision !== undefined && record.revision !== expect.revision) return false;
  if (expect.generation !== undefined && record.generation !== expect.generation) return false;
  return true;
}

/** 예약 전체. */
export async function readSchedules(): Promise<ScheduleMap> {
  return await enqueue(loadMap);
}

/** 예약 하나. 없으면 null. */
export async function readSchedule(scheduleId: string): Promise<ScheduleRecord | null> {
  const map = await readSchedules();
  return Object.hasOwn(map, scheduleId) ? map[scheduleId] : null;
}

/**
 * 예약을 저장한다. 같은 이름이 있으면 `revision` 을 이어서 1 올리고 덮어쓴다
 * (`replaced: true`). 새 이름이면 상한을 검사한다.
 */
export async function putSchedule(
  record: Omit<
    ScheduleRecord,
    'revision' | 'generation' | 'createdAt' | 'updatedAt' | 'failStreak'
  > &
    Partial<Pick<ScheduleRecord, 'failStreak'>>,
  now: number = Date.now(),
): Promise<{ ok: true; record: ScheduleRecord; replaced: boolean } | { ok: false; error: string }> {
  return await enqueue(async () => {
    const map = await loadMap();
    const existing = Object.hasOwn(map, record.scheduleId) ? map[record.scheduleId] : undefined;
    if (!existing && Object.keys(map).length >= MAX_SCHEDULES) {
      return {
        ok: false as const,
        error: `too_many_schedules: at most ${MAX_SCHEDULES} schedules can exist. Unschedule one first.`,
      };
    }
    const stored: ScheduleRecord = {
      ...record,
      enabled: record.enabled !== false,
      failStreak: record.failStreak ?? 0,
      revision: (existing?.revision ?? 0) + 1,
      generation: await nextGeneration(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    map[record.scheduleId] = stored;
    await persistMap(map);
    return { ok: true as const, record: stored, replaced: existing !== undefined };
  });
}

/** 예약을 지운다. 있었으면 true. */
export async function removeSchedule(scheduleId: string): Promise<boolean> {
  return await enqueue(async () => {
    const map = await loadMap();
    if (!Object.hasOwn(map, scheduleId)) return false;
    delete map[scheduleId];
    await persistMap(map);
    return true;
  });
}

/**
 * `revision` 만 올린다. shortcut `save`·`delete` 처럼 예약 자체는 그대로인데 정의가 바뀐
 * 경우다. 실행 중이던 run 은 이 값이 달라진 것을 보고 재무장을 포기한다.
 */
export async function bumpScheduleRevision(scheduleId: string): Promise<ScheduleRecord | null> {
  return await enqueue(async () => {
    const map = await loadMap();
    if (!Object.hasOwn(map, scheduleId)) return null;
    const updated: ScheduleRecord = {
      ...map[scheduleId],
      revision: map[scheduleId].revision + 1,
      generation: await nextGeneration(),
      updatedAt: Date.now(),
    };
    map[scheduleId] = updated;
    await persistMap(map);
    return updated;
  });
}

/**
 * 레코드의 **의미**를 바꾸면서 revision·generation 을 함께 올린다
 * (2026-09-05 Codex 설계 검토 2).
 *
 * `enabled` 를 끄거나 `target`·`params` 를 바꾸는 것은 "예약이 달라졌다" 이다. 알람만
 * 지우면 이미 큐에 들어간 실행이 그대로 돌고, 끝나면서 옛 레코드 기준으로 알람을 다시
 * 건다. generation 을 올려 두면 그 실행이 종료 시 `superseded` 로 물러난다.
 */
export async function patchScheduleMeaning(
  scheduleId: string,
  patch: Partial<Omit<ScheduleRecord, 'scheduleId' | 'revision' | 'generation'>>,
): Promise<ScheduleRecord | null> {
  return await enqueue(async () => {
    const map = await loadMap();
    if (!Object.hasOwn(map, scheduleId)) return null;
    const current = map[scheduleId];
    const updated: ScheduleRecord = {
      ...current,
      ...patch,
      revision: current.revision + 1,
      generation: await nextGeneration(),
      updatedAt: Date.now(),
    };
    map[scheduleId] = updated;
    await persistMap(map);
    return updated;
  });
}

/**
 * 레코드 일부를 갱신한다. `expect` 를 주면 그 값이 다를 때 아무것도 하지 않고 null 을
 * 돌려준다 (실행 도중 예약이 바뀐 경우 - `superseded`).
 *
 * `generation` 은 여기서 올리지 않는다. 이 함수가 쓰는 것은 `nextAt`·`lastStatus` 같은
 * 살림살이이고, generation 은 "사용자가 예약을 새로 만들었다" 를 뜻하는 값이기 때문이다.
 * 살림살이 갱신마다 올리면 러너의 결과 기록이 reconcile 의 nextAt 갱신에 밀려 사라진다.
 */
export async function patchSchedule(
  scheduleId: string,
  patch: Partial<Omit<ScheduleRecord, 'scheduleId' | 'name' | 'revision' | 'generation'>>,
  expect?: ScheduleExpectation,
): Promise<ScheduleRecord | null> {
  return await enqueue(async () => {
    const map = await loadMap();
    if (!Object.hasOwn(map, scheduleId)) return null;
    const current = map[scheduleId];
    if (!matchesExpectation(current, expect)) return null;
    const updated: ScheduleRecord = { ...current, ...patch, updatedAt: Date.now() };
    map[scheduleId] = updated;
    await persistMap(map);
    return updated;
  });
}

/** `schedules` 응답에 싣는 요약 (설계 1절: 표현·nextAt·마지막 상태·failStreak 만). */
export interface ScheduleSummary {
  /** 내부 식별자. 이력·알람·다른 메시지가 예약을 가리킬 때 쓰는 값이다. */
  scheduleId: string;
  name: string;
  /** 화면에 그대로 쓰는 이름 (= `name`). 응답을 읽는 쪽이 헷갈리지 않게 함께 싣는다. */
  label: string;
  kind: ScheduleKind;
  target: ScheduleTarget;
  enabled: boolean;
  schedule: ScheduleExpression;
  nextAt: number;
  notify: boolean;
  report: boolean;
  loginCheck?: string;
  revision: number;
  failStreak: number;
  lastStatus?: FinalRunStatus;
  lastRunId?: string;
  lastRunAt?: number;
}

export function summarizeSchedule(record: ScheduleRecord): ScheduleSummary {
  const target: ScheduleTarget = record.target ?? { kind: 'shortcut', name: record.name };
  const summary: ScheduleSummary = {
    scheduleId: record.scheduleId,
    name: record.name,
    label: record.name,
    kind: target.kind,
    target,
    enabled: record.enabled !== false,
    schedule: record.schedule,
    nextAt: record.nextAt,
    notify: record.notify,
    report: record.report,
    revision: record.revision,
    failStreak: record.failStreak ?? 0,
  };
  if (record.loginCheck !== undefined) summary.loginCheck = record.loginCheck;
  if (record.lastStatus !== undefined) summary.lastStatus = record.lastStatus;
  if (record.lastRunId !== undefined) summary.lastRunId = record.lastRunId;
  if (record.lastRunAt !== undefined) summary.lastRunAt = record.lastRunAt;
  return summary;
}
