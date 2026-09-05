/**
 * 매일 작업 화면의 백그라운드 접점 (2026-09-05 사이드패널 2단계 D).
 *
 * 사이드패널은 예약 저장소·이력 저장소를 직접 만지지 않는다. 예약은 알람·잠금·큐와 한
 * 덩어리라 규칙이 두 곳에 흩어지면 곧 어긋난다. 그래서 화면은 여기 있는 메시지만 부르고,
 * 판단은 전부 백그라운드가 한다.
 *
 * 지키는 것:
 *   - 예약을 가리키는 값은 표시 이름이 아니라 `scheduleId` 다 (`shortcut:<enc>` /
 *     `flow:<enc>`). 이름이 같은 단축과 흐름이 서로의 알람·이력을 건드리지 않는다.
 *   - 흐름 예약은 **발행된 흐름 + 시작 URL** 이 있어야 만들어진다. 예약은 사람이 보고
 *     있지 않을 때 도니, 작업 탭을 스스로 열 수 없는 흐름은 밤에 실패만 쌓는다.
 *   - 민감 변수를 쓰는 흐름은 예약하지 않는다. 예약 레코드는 평문 저장소에 남는다.
 *   - 예약 엔진은 하나다. record-replay 자체 예약(`RR_SCHEDULE_FLOW`, flow-store 의
 *     FlowSchedule, `rr_schedule_*` 알람)은 2026-09-06 3단계에서 삭제됐다.
 */

import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import { notifyDailyChanged } from '@/utils/daily-notify';
import {
  MAX_HISTORY_LIMIT,
  RUN_STATUSES,
  findRecordById,
  flattenHistory,
  parseSince,
  readHistory,
  resultsCharsOf,
  type HistoryMap,
  type RunRecord,
} from '@/utils/shortcut-history';
import {
  armScheduleAlarm,
  clearScheduleAlarm,
  computeNextAt,
  laneForScheduleId,
  parseScheduleId,
  patchScheduleMeaning,
  readSchedule,
  readSchedules,
  removeSchedule,
  scheduleIdForShortcut,
  summarizeSchedule,
  validateLoginCheck,
  validateScheduleFirstStep,
  type ScheduleRecord,
  type ScheduleTarget,
} from '@/utils/shortcut-schedule';
import { loadShortcuts } from './tools/browser/shortcut';
import { enqueueScheduledRun } from './schedule-runner';
import {
  checkFlowScheduleTarget,
  commitSchedule,
  isPlainObject,
  type ScheduleTargetCheck,
} from './flow-schedule';

/** 알림 id 접두 (예약 러너가 만든다). 뒤에 scheduleId 와 시각이 붙는다. */
const FAIL_NOTIFICATION_PREFIX = 'mcp-shortcut-fail::';

/** 알림을 눌렀을 때 여는 화면. */
const DAILY_PANEL_PATH = 'sidepanel.html?tab=daily';

/** 목록 한 페이지 기본 개수 ("20건씩 더 보기"). */
const DEFAULT_HISTORY_PAGE = 20;

type Respond = (payload: Record<string, unknown>) => void;

function fail(sendResponse: Respond, error: string, code?: string): void {
  sendResponse({ success: false, error, ...(code ? { errorCode: code } : {}) });
}

/* ------------------------------------------------------------------ *
 * 조회
 * ------------------------------------------------------------------ */

async function listSchedulesForPanel(): Promise<unknown[]> {
  const map = await readSchedules();
  return Object.keys(map)
    .map((scheduleId) => summarizeSchedule(map[scheduleId]))
    .sort((a, b) => a.nextAt - b.nextAt);
}

/** 이력 목록에서 `results` 본문은 뺀다. 20건이면 화면 하나에 수 MB 가 실린다. */
function toDailyRun(record: RunRecord): Record<string, unknown> {
  const { results: _results, ...rest } = record;
  return { ...rest, resultsChars: resultsCharsOf(record) };
}

/** 검증을 마친 이력 조회 조건. 원본 메시지는 이 형태로 바뀐 뒤에만 쓰인다. */
interface DailyHistoryQuery {
  scheduleId?: string;
  status?: string[];
  since?: number;
  limit?: number;
  cursor?: number;
}

/**
 * 이력 한 페이지. `cursor` 는 다음 페이지의 시작 위치(0-based)를 그대로 담은 문자열이다.
 * 이력은 최신순 고정이고 페이지를 넘기는 동안 앞쪽에 새 기록이 끼면 한 건이 밀릴 수
 * 있는데, "더 보기" 화면에서는 그 편이 커서를 위해 시각·id 를 합성하는 것보다 단순하다.
 */
export function historyKeysFor(scheduleId: string): string[] {
  const target = parseScheduleId(scheduleId);
  // 2026-09-05 Codex 코드 리뷰 1: 이 버전 이전에 돌던 단축 예약의 이력은 **단축 이름**을
  // 키로 쌓여 있다. 그 기록을 화면에서 잃지 않으려면 두 키를 함께 읽어야 한다. 저장소를
  // 옮기는 대신 읽을 때 합치는 쪽을 골랐다: 이력은 밤새 쌓이는 큰 값이고, 옮기는 쓰기가
  // 도중에 끊기면 남는 것이 반쪽짜리 이력이기 때문이다. 수동 `chrome_shortcut run` 도
  // 계속 이름 키에 쌓이므로 이 병합은 앞으로도 필요하다.
  if (target?.kind === 'shortcut' && target.name !== scheduleId) {
    return [scheduleId, target.name];
  }
  return [scheduleId];
}

function selectDailyHistory(
  map: HistoryMap,
  query: DailyHistoryQuery,
): { runs: Record<string, unknown>[]; matched: number; nextCursor?: string } {
  let scoped: HistoryMap = map;
  if (query.scheduleId) {
    scoped = {};
    for (const key of historyKeysFor(query.scheduleId)) {
      if (Array.isArray(map[key])) scoped[key] = map[key];
    }
  }

  const since = parseSince(query.since);
  const statuses = query.status ?? [];

  const seen = new Set<string>();
  const flat = flattenHistory(scoped).filter(({ record }) => {
    if (since !== null && (record.startedAt ?? 0) < since) return false;
    if (statuses.length > 0 && !statuses.includes(record.status)) return false;
    // 두 키를 합쳐 읽으므로 같은 runId 가 양쪽에 있으면 한 번만 싣는다.
    if (seen.has(record.runId)) return false;
    seen.add(record.runId);
    return true;
  });

  const limit = query.limit ?? DEFAULT_HISTORY_PAGE;
  const offset = query.cursor ?? 0;
  const page = flat.slice(offset, offset + limit);
  const nextOffset = offset + page.length;

  return {
    runs: page.map(({ record }) => toDailyRun(record)),
    matched: flat.length,
    ...(nextOffset < flat.length ? { nextCursor: String(nextOffset) } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * 예약 저장
 * ------------------------------------------------------------------ */

interface PutScheduleInput {
  target?: unknown;
  schedule?: unknown;
  params?: unknown;
  notify?: unknown;
  report?: unknown;
  loginCheck?: unknown;
  enabled?: unknown;
}

/** 단축 대상 검증. `chrome_shortcut action=schedule` 과 같은 규칙을 본다. */
async function checkShortcutTarget(
  raw: Record<string, unknown>,
  input: PutScheduleInput,
): Promise<ScheduleTargetCheck> {
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) {
    return {
      ok: false,
      code: 'shortcut_name_required',
      error: 'shortcut_name_required: "name" is missing',
    };
  }
  const shortcuts = await loadShortcuts();
  const stored = shortcuts[name];
  if (!stored) {
    return {
      ok: false,
      code: 'shortcut_not_found',
      error: `shortcut_not_found: "${name}" 단축이 없습니다.`,
    };
  }
  const steps = Array.isArray(stored.steps) ? stored.steps : [];
  const firstStepError = validateScheduleFirstStep(steps);
  if (firstStepError) {
    return { ok: false, code: 'schedule_first_step_invalid', error: firstStepError };
  }
  const loginCheckError = validateLoginCheck(steps, input.loginCheck);
  if (loginCheckError) {
    return { ok: false, code: 'schedule_invalid', error: loginCheckError };
  }
  const declarations = isPlainObject(stored.params) ? stored.params : undefined;
  if (declarations) {
    for (const paramName of Object.keys(declarations)) {
      const declaration = declarations[paramName] as { secret?: boolean; required?: boolean };
      if (declaration?.secret === true && declaration?.required === true) {
        return {
          ok: false,
          code: 'secret_required_unschedulable',
          error: `secret_required_unschedulable: "${name}" 은 비밀값 "${paramName}" 이 필요해 예약할 수 없습니다.`,
        };
      }
    }
    if (isPlainObject(input.params)) {
      for (const paramName of Object.keys(input.params)) {
        const declaration = declarations[paramName] as { secret?: boolean } | undefined;
        if (declaration?.secret === true) {
          return {
            ok: false,
            code: 'secret_param_in_schedule',
            error: `secret_param_in_schedule: "${paramName}" 은 비밀값이라 예약에 저장하지 않습니다.`,
          };
        }
      }
    }
  }
  return {
    ok: true,
    scheduleId: scheduleIdForShortcut(name),
    label: name,
    target: { kind: 'shortcut', name },
  };
}

async function putScheduleFromPanel(
  input: PutScheduleInput,
): Promise<{ ok: true; schedule: unknown } | { ok: false; error: string; code: string }> {
  if (!isPlainObject(input.target)) {
    return { ok: false, code: 'target_required', error: 'target_required: "target" is missing' };
  }
  const kind = input.target.kind;
  const check =
    kind === 'flow'
      ? await checkFlowScheduleTarget({
          flowId: input.target.flowId,
          args: input.target.args,
          loginCheck: input.loginCheck,
        })
      : kind === 'shortcut'
        ? await checkShortcutTarget(input.target, input)
        : {
            ok: false as const,
            code: 'target_invalid',
            error: 'target_invalid: "kind" must be "shortcut" or "flow"',
          };
  if (!check.ok) return { ok: false, error: check.error, code: check.code };

  // 2026-09-05 Codex 코드 리뷰 3: 켜짐·알림·보고서는 불리언이어야 한다. `x !== false` 로
  // 읽으면 문자열 "false" 나 null 도 켜진 것이 된다.
  const enabled = readBoolean(input.enabled, true);
  const notify = readBoolean(input.notify, true);
  const report = readBoolean(input.report, false);
  if (enabled === undefined || notify === undefined || report === undefined) {
    return {
      ok: false,
      code: 'flag_invalid',
      error: 'flag_invalid: "enabled", "notify", "report" must be booleans',
    };
  }
  if (input.loginCheck !== undefined && readString(input.loginCheck, 200) === null) {
    return {
      ok: false,
      code: 'login_check_invalid',
      error: 'login_check_invalid: bad "loginCheck"',
    };
  }

  // 저장·알람·방송은 도구 경로(`chrome_shortcut action=schedule flowId=...`)와 같은
  // 함수를 지난다. 두 접점이 다른 레코드를 만들면 화면과 도구가 다른 예약을 보게 된다.
  const committed = await commitSchedule(check, {
    schedule: input.schedule,
    ...(isPlainObject(input.params) ? { params: input.params } : {}),
    notify,
    report,
    ...(typeof input.loginCheck === 'string' && input.loginCheck.trim()
      ? { loginCheck: input.loginCheck.trim() }
      : {}),
    enabled,
  });
  if (!committed.ok) return { ok: false, code: committed.code, error: committed.error };

  return { ok: true, schedule: summarizeSchedule(committed.record) };
}

/* ------------------------------------------------------------------ *
 * 알림 클릭
 * ------------------------------------------------------------------ */

/**
 * 마지막으로 포커스된 창. 알림 클릭 핸들러가 **await 없이** 창 id 를 알아야 하기 때문에
 * 미리 받아 둔다 (2026-09-05 Codex 설계 검토 7).
 *
 * `chrome.sidePanel.open()` 은 사용자 제스처 안에서만 열린다. 창 id 를 얻으려고
 * `chrome.windows.getLastFocused()` 를 먼저 기다리면 그 사이에 제스처가 사라져 무조건
 * 거절당한다. 그래서 창 id 는 이벤트로 미리 받고, 클릭 순간에는 곧바로 연다.
 */
let lastFocusedWindowId: number | undefined;

function rememberFocusedWindow(windowId: number): void {
  if (typeof windowId === 'number' && windowId >= 0) lastFocusedWindowId = windowId;
}

/** 매일 작업 탭을 일반 탭으로 연다 (사이드패널을 못 열었을 때의 길). */
async function openDailyTab(): Promise<void> {
  try {
    // tab-create-ok: 사용자가 알림을 눌러 결과를 보고 싶다고 말한 순간이다.
    await chrome.tabs.create({ url: chrome.runtime.getURL(DAILY_PANEL_PATH), active: true });
  } catch (error) {
    console.warn('[daily] 매일 작업 화면을 열지 못했습니다:', error);
  }
}

/** 사이드패널의 영구 path 를 매일 작업 탭으로 맞춘다 (열기 시도 뒤에 한다). */
async function pointSidePanelAtDaily(): Promise<void> {
  try {
    const sidePanel = (
      chrome as unknown as { sidePanel?: { setOptions?: (o: unknown) => unknown } }
    ).sidePanel;
    if (sidePanel?.setOptions) {
      await sidePanel.setOptions({ path: DAILY_PANEL_PATH, enabled: true });
    }
  } catch {
    // 사이드패널이 없는 크롬 버전이거나 이미 닫혔다. 탭 경로가 있으므로 조용히 넘어간다.
  }
}

export function handleFailureNotificationClick(notificationId: string): void {
  if (typeof notificationId !== 'string' || !notificationId.startsWith(FAIL_NOTIFICATION_PREFIX)) {
    return;
  }
  let opening: Promise<unknown> | null = null;
  try {
    const sidePanel = (
      chrome as unknown as { sidePanel?: { open?: (o: unknown) => Promise<void> } }
    ).sidePanel;
    if (sidePanel?.open && typeof lastFocusedWindowId === 'number') {
      // **동기 호출**: 앞에 await 를 두면 제스처가 사라져 크롬이 무조건 거절한다.
      opening = sidePanel.open({ windowId: lastFocusedWindowId });
    }
  } catch {
    opening = null;
  }

  if (opening) {
    void Promise.resolve(opening)
      .then(() => pointSidePanelAtDaily())
      .catch(() => openDailyTab());
  } else {
    void openDailyTab();
  }

  try {
    void Promise.resolve(chrome.notifications.clear(notificationId)).catch(() => undefined);
  } catch {
    // 알림이 이미 사라졌다.
  }
}

/* ------------------------------------------------------------------ *
 * 스크린샷 열기
 * ------------------------------------------------------------------ */

async function openScreenshot(filename: string): Promise<{ ok: boolean; error?: string }> {
  const wanted = String(filename || '').trim();
  if (!wanted) return { ok: false, error: 'sidepanel_screenshot_missing' };
  try {
    const items = await chrome.downloads.search({ filename: wanted, limit: 1 });
    const item = Array.isArray(items) ? items[0] : undefined;
    if (!item || typeof item.id !== 'number') {
      return { ok: false, error: 'sidepanel_screenshot_missing' };
    }
    chrome.downloads.show(item.id);
    return { ok: true };
  } catch (error) {
    console.warn('[daily] 스크린샷 열기 실패:', error);
    return { ok: false, error: 'sidepanel_screenshot_missing' };
  }
}

/* ------------------------------------------------------------------ *
 * 입력 검증 (2026-09-05 Codex 코드 리뷰 3)
 *
 * 이 메시지들은 예약을 만들고 지우고 실행하며 파일 탐색기를 연다. 화면이 보내는 값이라고
 * 해서 그대로 믿으면, 확장 안에서 도는 다른 코드(콘텐츠 스크립트가 여는 페이지, 옛 버전의
 * 화면)가 보낸 이상한 값이 그대로 저장소에 들어간다. 그래서 두 겹으로 막는다.
 *   1. 보낸 쪽이 이 확장인지 (`sender.id`).
 *   2. 필드마다 형식을 확인하고, 아니면 코드가 붙은 오류로 돌려준다. 강제 변환하지 않는다
 *      (`String(x)` 은 null 을 "null" 로, `x !== false` 는 문자열을 true 로 만든다).
 * ------------------------------------------------------------------ */

/** 이 확장이 보낸 메시지인가. 외부 확장·웹페이지의 메시지는 sender.id 가 다르다. */
function isOwnSender(sender: chrome.runtime.MessageSender | undefined): boolean {
  const own = chrome.runtime?.id;
  if (typeof own !== 'string' || own.length === 0) return true;
  return sender?.id === own;
}

/** 문자열 필드. 길이 상한을 넘거나 형식이 아니면 null. */
function readString(value: unknown, maxLength = 512): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
}

/** 우리 형식의 예약 식별자만 통과시킨다. */
function readScheduleId(value: unknown): string | null {
  const text = readString(value, 300);
  if (text === null) return null;
  return parseScheduleId(text) === null ? null : text;
}

/** 불리언 필드. 값이 없으면 `fallback`, 불리언이 아니면 undefined (거절 신호). */
function readBoolean(value: unknown, fallback: boolean): boolean | undefined {
  if (value === undefined) return fallback;
  return typeof value === 'boolean' ? value : undefined;
}

/** 상태 필터. 저장된 상태 이름만 받는다. */
function readStatuses(value: unknown): string[] | null {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  if (list.length > RUN_STATUSES.length) return null;
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== 'string' || !(RUN_STATUSES as readonly string[]).includes(entry)) {
      return null;
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/** 목록 개수. 1~100 밖이거나 숫자가 아니면 null. */
function readLimit(value: unknown): number | null {
  if (value === undefined) return DEFAULT_HISTORY_PAGE;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.floor(value);
  if (rounded < 1 || rounded > MAX_HISTORY_LIMIT) return null;
  return rounded;
}

/** 커서. 이 구현에서는 0 이상의 정수 문자열이다. */
function readCursor(value: unknown): number | null {
  if (value === undefined) return 0;
  if (typeof value !== 'string' || !/^\d{1,9}$/.test(value)) return null;
  return Number(value);
}

/** `since`. ISO 문자열 또는 epoch ms. 해석되지 않으면 null. */
function readSince(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  const parsed = parseSince(value as string | number);
  return parsed === null ? null : parsed;
}

/**
 * 실패 스크린샷 파일 이름.
 *
 * `chrome.downloads.show` 는 다운로드 폴더의 파일을 탐색기로 연다. 화면이 준 값을 그대로
 * 넘기면 이력에 없는 파일도 열 수 있으므로, 예약 러너가 실제로 만드는 경로 모양만 받는다.
 */
export function readScreenshotName(value: unknown): string | null {
  const text = readString(value, 256);
  if (text === null) return null;
  if (!text.startsWith('mcp-screenshots/')) return null;
  if (text.includes('..') || text.includes('\\')) return null;
  if (!/\.(png|jpg|jpeg)$/i.test(text)) return null;
  return text;
}

/** 이력 조회 조건을 검증한다. 문제가 있으면 코드 문자열을 돌려준다. */
export function parseHistoryQuery(message: AnyMessage): DailyHistoryQuery | string {
  const query: DailyHistoryQuery = {};
  if (message.scheduleId !== undefined) {
    const scheduleId = readScheduleId(message.scheduleId);
    if (scheduleId === null) return 'schedule_id_invalid';
    query.scheduleId = scheduleId;
  }
  const statuses = readStatuses(message.status);
  if (statuses === null) return 'status_invalid';
  if (statuses.length > 0) query.status = statuses;

  const since = readSince(message.since);
  if (since === null) return 'since_invalid';
  if (since !== undefined) query.since = since;

  const limit = readLimit(message.limit);
  if (limit === null) return 'limit_invalid';
  query.limit = limit;

  const cursor = readCursor(message.cursor);
  if (cursor === null) return 'cursor_invalid';
  query.cursor = cursor;

  return query;
}

type AnyMessage = Record<string, unknown>;

/* ------------------------------------------------------------------ *
 * 메시지 리스너
 * ------------------------------------------------------------------ */

export function initDailyMessages(): void {
  try {
    chrome.windows?.onFocusChanged?.addListener?.((windowId: number) =>
      rememberFocusedWindow(windowId),
    );
    // 지금 포커스된 창도 한 번 받아 둔다 (워커가 막 떴을 때를 위해).
    void chrome.windows
      ?.getLastFocused?.()
      .then((w) => {
        if (typeof w?.id === 'number') rememberFocusedWindow(w.id);
      })
      .catch(() => undefined);
  } catch {
    // windows API 가 없는 환경 (테스트)
  }

  try {
    chrome.notifications?.onClicked?.addListener?.(handleFailureNotificationClick);
  } catch {
    // notifications API 가 없는 환경
  }

  chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    const message = (raw ?? {}) as AnyMessage;
    const type = typeof message.type === 'string' ? message.type : '';
    if (!type.startsWith('daily_')) return false;
    // 우리 확장 밖에서 온 메시지는 다루지 않는다 (예약을 만들고 지우는 접점이다).
    if (!isOwnSender(sender)) {
      fail(
        sendResponse,
        'forbidden_sender: this message must come from the extension',
        'forbidden_sender',
      );
      return true;
    }

    switch (type) {
      case BACKGROUND_MESSAGE_TYPES.DAILY_LIST_SCHEDULES: {
        listSchedulesForPanel()
          .then((schedules) => sendResponse({ success: true, schedules }))
          .catch((e) => fail(sendResponse, e?.message || String(e)));
        return true;
      }
      case BACKGROUND_MESSAGE_TYPES.DAILY_PUT_SCHEDULE: {
        putScheduleFromPanel(message as PutScheduleInput)
          .then((result) =>
            result.ok
              ? sendResponse({ success: true, schedule: result.schedule })
              : fail(sendResponse, result.error, result.code),
          )
          .catch((e) => fail(sendResponse, e?.message || String(e)));
        return true;
      }
      case BACKGROUND_MESSAGE_TYPES.DAILY_REMOVE_SCHEDULE: {
        const scheduleId = readScheduleId(message.scheduleId);
        if (scheduleId === null) {
          fail(sendResponse, 'schedule_id_invalid: "scheduleId" is missing', 'schedule_id_invalid');
          return true;
        }
        // revision 을 먼저 올려, 돌고 있던 실행이 끝나며 알람을 다시 걸지 않게 한다.
        patchScheduleMeaning(scheduleId, {})
          .then(() => removeSchedule(scheduleId))
          .then(async (removed) => {
            await clearScheduleAlarm(scheduleId);
            notifyDailyChanged();
            sendResponse({ success: true, removed });
          })
          .catch((e) => fail(sendResponse, e?.message || String(e)));
        return true;
      }
      case BACKGROUND_MESSAGE_TYPES.DAILY_SET_ENABLED: {
        const scheduleId = readScheduleId(message.scheduleId);
        if (scheduleId === null) {
          fail(sendResponse, 'schedule_id_invalid: "scheduleId" is missing', 'schedule_id_invalid');
          return true;
        }
        const enabled = readBoolean(message.enabled, true);
        if (enabled === undefined) {
          fail(sendResponse, 'enabled_invalid: "enabled" must be a boolean', 'enabled_invalid');
          return true;
        }
        // generation 을 함께 올린다: 이미 큐에 든 실행이 꺼진 예약을 되살리지 못하게.
        patchScheduleMeaning(scheduleId, { enabled })
          .then(async (record) => {
            if (!record) {
              fail(sendResponse, `schedule_not_found: ${scheduleId}`, 'schedule_not_found');
              return;
            }
            if (enabled) {
              const nextAt = computeNextAt(record, Date.now());
              const armed = nextAt === null ? record : await applyReArmedNextAt(scheduleId, nextAt);
              await armScheduleAlarm(scheduleId, armed.nextAt);
              notifyDailyChanged();
              sendResponse({ success: true, schedule: summarizeSchedule(armed) });
              return;
            }
            await clearScheduleAlarm(scheduleId);
            notifyDailyChanged();
            sendResponse({ success: true, schedule: summarizeSchedule(record) });
          })
          .catch((e) => fail(sendResponse, e?.message || String(e)));
        return true;
      }
      case BACKGROUND_MESSAGE_TYPES.DAILY_RUN_NOW: {
        const scheduleId = readScheduleId(message.scheduleId);
        if (scheduleId === null) {
          fail(sendResponse, 'schedule_id_invalid: "scheduleId" is missing', 'schedule_id_invalid');
          return true;
        }
        readSchedule(scheduleId)
          .then((record) => {
            if (!record) {
              fail(sendResponse, `schedule_not_found: ${scheduleId}`, 'schedule_not_found');
              return;
            }
            // 예약 큐를 그대로 탄다 - 직렬 실행·잠금·이력 규칙을 우회하지 않는다.
            const queued = enqueueScheduledRun(scheduleId, Date.now(), Date.now(), {
              trigger: 'manual',
            });
            sendResponse({ success: true, runId: queued.runId, queued: queued.queued });
          })
          .catch((e) => fail(sendResponse, e?.message || String(e)));
        return true;
      }
      case BACKGROUND_MESSAGE_TYPES.DAILY_HISTORY: {
        const query = parseHistoryQuery(message);
        if (typeof query === 'string') {
          fail(sendResponse, `${query}: check the history filter`, query);
          return true;
        }
        readHistory()
          .then((map) => {
            const page = selectDailyHistory(map, query);
            sendResponse({ success: true, ...page });
          })
          .catch((e) => fail(sendResponse, e?.message || String(e)));
        return true;
      }
      case BACKGROUND_MESSAGE_TYPES.DAILY_GET_RUN: {
        const runId = readString(message.runId, 300);
        if (runId === null) {
          fail(sendResponse, 'run_id_invalid: "runId" is missing', 'run_id_invalid');
          return true;
        }
        readHistory()
          .then((map) => {
            const run = findRecordById(map, runId);
            if (!run) {
              fail(sendResponse, `run_not_found: ${runId}`, 'run_not_found');
              return;
            }
            sendResponse({ success: true, run });
          })
          .catch((e) => fail(sendResponse, e?.message || String(e)));
        return true;
      }
      case BACKGROUND_MESSAGE_TYPES.DAILY_OPEN_SCREENSHOT: {
        const filename = readScreenshotName(message.filename);
        if (filename === null) {
          fail(sendResponse, 'sidepanel_screenshot_missing', 'sidepanel_screenshot_missing');
          return true;
        }
        openScreenshot(filename)
          .then((result) =>
            result.ok
              ? sendResponse({ success: true })
              : fail(sendResponse, result.error || 'sidepanel_screenshot_missing', result.error),
          )
          .catch((e) => fail(sendResponse, e?.message || String(e)));
        return true;
      }
      default:
        return false;
    }
  });
}

/** `enabled:true` 로 되돌릴 때 다음 실행 시각을 다시 계산해 저장한다. */
async function applyReArmedNextAt(scheduleId: string, nextAt: number): Promise<ScheduleRecord> {
  const updated = await patchScheduleMeaning(scheduleId, { nextAt });
  if (updated) return updated;
  const fallback = await readSchedule(scheduleId);
  if (fallback) return fallback;
  throw new Error(`schedule_not_found: ${scheduleId}`);
}

/** 예약 식별자에서 대상을 되찾는 헬퍼 (화면 코드가 종류 배지를 그릴 때 쓴다). */
export function targetFromScheduleId(scheduleId: string): ScheduleTarget | null {
  return parseScheduleId(scheduleId);
}

/** 레인 계산을 화면·진단에서 다시 쓰기 위한 재수출. */
export { laneForScheduleId };
