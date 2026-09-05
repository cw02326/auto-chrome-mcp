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

export interface ScheduleRecord {
  name: string;
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

/**
 * `dayStart` 가 속한 로컬 날짜에서 벽시계가 `minutes` 이상이 되는 **가장 이른 순간**.
 * 그 날 안에 그런 순간이 없으면 null (하루가 통째로 건너뛰어진 극단적 존 변경).
 *
 * 이 한 규칙이 DST 두 경우를 모두 덮는다:
 *   - spring-forward 로 02:30 이 없는 날 -> 03:00 (건너뛴 직후 첫 존재하는 순간) 1회
 *   - fall-back 으로 01:30 이 두 번 오는 날 -> 앞선 01:30 1회
 */
export function firstInstantAtOrAfterWall(dayStart: number, minutes: number): number | null {
  const key = dayKeyOf(dayStart);
  const satisfied = (t: number): boolean => {
    const k = dayKeyOf(t);
    if (k > key) return true;
    if (k < key) return false;
    return wallMinutesOf(t) >= minutes;
  };

  // 로컬 벽시계는 시간이 흐를수록 줄지 않으므로(앞으로 뛰거나 제자리걸음) 이분 탐색이 된다.
  let lo = dayStart;
  let hi = dayStart + 26 * 60 * MINUTE_MS;
  if (satisfied(lo)) return dayKeyOf(lo) === key ? lo : null;
  if (!satisfied(hi)) return null;

  while (hi - lo > MINUTE_MS) {
    const mid = lo + Math.floor((hi - lo) / (2 * MINUTE_MS)) * MINUTE_MS;
    if (mid === lo) break;
    if (satisfied(mid)) hi = mid;
    else lo = mid;
  }
  return dayKeyOf(hi) === key ? hi : null;
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

/** 예약 실행의 알람 이름. */
export function alarmNameFor(name: string): string {
  return `${SCHEDULE_ALARM_PREFIX}${name}`;
}

/** 알람 이름에서 shortcut 이름을 되찾는다. 우리 알람이 아니면 null. */
export function scheduleNameFromAlarm(alarmName: unknown): string | null {
  if (typeof alarmName !== 'string' || !alarmName.startsWith(SCHEDULE_ALARM_PREFIX)) return null;
  const name = alarmName.slice(SCHEDULE_ALARM_PREFIX.length);
  return name.length > 0 ? name : null;
}

/**
 * 알람을 건다. **항상 일회성**이다 - `periodInMinutes` 를 쓰지 않는 이유는 코드 경로가
 * 하나가 되고, 크롬이 꺼져 있던 동안 쌓인 주기 알람이 몰아서 울리지 않기 때문이다.
 * 같은 이름으로 다시 걸면 크롬이 이전 알람을 대체하므로 알람은 항상 하나만 남는다.
 */
export async function armScheduleAlarm(name: string, when: number): Promise<void> {
  try {
    await chrome.alarms.create(alarmNameFor(name), { when });
  } catch (error) {
    console.warn('[shortcut-schedule] 알람 등록 실패:', error);
  }
}

/** 알람을 지운다. */
export async function clearScheduleAlarm(name: string): Promise<boolean> {
  try {
    return await chrome.alarms.clear(alarmNameFor(name));
  } catch {
    return false;
  }
}

/**
 * 예약 실행의 `runId`. 알람과 `reconcile()` 따라잡기가 같은 due 를 동시에 집어도 키가
 * 같아 이력이 1건이다 (한쪽이 storage claim 에서 진다).
 */
export function scheduleRunId(name: string, dueAt: number): string {
  return `${name}:${new Date(dueAt).toISOString()}`;
}

/** 이 실행이 쓰는 합성 세션 키의 lane (= shortcut 이름). 세션 id 는 항상 `scheduled`. */
export const SCHEDULED_SESSION_ID = 'scheduled';

/** 예약 실행 중 MCP 탭 그룹에 붙는 제목. */
export function scheduleTaskTitle(name: string): string {
  return `예약: ${name}`;
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

async function loadMap(): Promise<ScheduleMap> {
  try {
    const result = await chrome.storage.local.get([SCHEDULE_STORAGE_KEY]);
    const raw = (result as any)?.[SCHEDULE_STORAGE_KEY];
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as ScheduleMap) : {};
  } catch {
    return {};
  }
}

async function persistMap(map: ScheduleMap): Promise<void> {
  await chrome.storage.local.set({ [SCHEDULE_STORAGE_KEY]: map });
}

/** 예약 전체. */
export async function readSchedules(): Promise<ScheduleMap> {
  return await enqueue(loadMap);
}

/** 예약 하나. 없으면 null. */
export async function readSchedule(name: string): Promise<ScheduleRecord | null> {
  const map = await readSchedules();
  return Object.hasOwn(map, name) ? map[name] : null;
}

/**
 * 예약을 저장한다. 같은 이름이 있으면 `revision` 을 이어서 1 올리고 덮어쓴다
 * (`replaced: true`). 새 이름이면 상한을 검사한다.
 */
export async function putSchedule(
  record: Omit<ScheduleRecord, 'revision' | 'createdAt' | 'updatedAt' | 'failStreak'> &
    Partial<Pick<ScheduleRecord, 'failStreak'>>,
  now: number = Date.now(),
): Promise<{ ok: true; record: ScheduleRecord; replaced: boolean } | { ok: false; error: string }> {
  return await enqueue(async () => {
    const map = await loadMap();
    const existing = Object.hasOwn(map, record.name) ? map[record.name] : undefined;
    if (!existing && Object.keys(map).length >= MAX_SCHEDULES) {
      return {
        ok: false as const,
        error: `too_many_schedules: at most ${MAX_SCHEDULES} schedules can exist. Unschedule one first.`,
      };
    }
    const stored: ScheduleRecord = {
      ...record,
      failStreak: record.failStreak ?? 0,
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    map[record.name] = stored;
    await persistMap(map);
    return { ok: true as const, record: stored, replaced: existing !== undefined };
  });
}

/** 예약을 지운다. 있었으면 true. */
export async function removeSchedule(name: string): Promise<boolean> {
  return await enqueue(async () => {
    const map = await loadMap();
    if (!Object.hasOwn(map, name)) return false;
    delete map[name];
    await persistMap(map);
    return true;
  });
}

/**
 * `revision` 만 올린다. shortcut `save`·`delete` 처럼 예약 자체는 그대로인데 정의가 바뀐
 * 경우다. 실행 중이던 run 은 이 값이 달라진 것을 보고 재무장을 포기한다.
 */
export async function bumpScheduleRevision(name: string): Promise<ScheduleRecord | null> {
  return await enqueue(async () => {
    const map = await loadMap();
    if (!Object.hasOwn(map, name)) return null;
    const updated: ScheduleRecord = {
      ...map[name],
      revision: map[name].revision + 1,
      updatedAt: Date.now(),
    };
    map[name] = updated;
    await persistMap(map);
    return updated;
  });
}

/**
 * 레코드 일부를 갱신한다. `expectRevision` 을 주면 revision 이 다를 때 아무것도 하지 않고
 * null 을 돌려준다 (실행 도중 예약이 바뀐 경우 - `superseded`).
 */
export async function patchSchedule(
  name: string,
  patch: Partial<Omit<ScheduleRecord, 'name' | 'revision'>>,
  expectRevision?: number,
): Promise<ScheduleRecord | null> {
  return await enqueue(async () => {
    const map = await loadMap();
    if (!Object.hasOwn(map, name)) return null;
    const current = map[name];
    if (expectRevision !== undefined && current.revision !== expectRevision) return null;
    const updated: ScheduleRecord = { ...current, ...patch, updatedAt: Date.now() };
    map[name] = updated;
    await persistMap(map);
    return updated;
  });
}

/** `schedules` 응답에 싣는 요약 (설계 1절: 표현·nextAt·마지막 상태·failStreak 만). */
export interface ScheduleSummary {
  name: string;
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
  const summary: ScheduleSummary = {
    name: record.name,
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
