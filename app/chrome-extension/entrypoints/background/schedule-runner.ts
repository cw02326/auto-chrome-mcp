/**
 * auto-chrome-mcp fork: chrome_shortcut 예약 실행기.
 *
 * 설계 계약: docs/plans/2026-09-05-daily-automation-design.md 1·2·4·5절
 * (구현 순서 3·4단계).
 *
 * 무엇을 하나: `mcpShortcutSchedules` 에 저장된 예약을 알람으로 깨워 확장 안에서 실행하고,
 * 결과를 `mcpShortcutHistory` 에 남긴다. MCP 세션이 없어도 돌고, 사용자 탭 보호 규칙은
 * 한 줄도 우회하지 않는다.
 *
 * 지켜야 하는 것들:
 *   - `chrome.alarms.onAlarm` 리스너는 **모듈 최상위에서 동기로** 등록한다. 늦게 등록한
 *     리스너는 워커를 깨우지 못한다.
 *   - 워커가 평가될 때마다 `reconcile()` 을 한 번 돈다. `onStartup` 만으로는 확장 업데이트·
 *     크래시·유휴 종료 뒤의 재평가를 잡지 못한다.
 *   - 이중 실행 방지는 두 겹이다. 메모리 claim(`claimedRunIds`)은 같은 워커 안에서 알람과
 *     따라잡기가 같은 due 를 집는 것을, 이력의 `runId` 존재 검사는 워커가 갈렸을 때를 막는다.
 *   - 예약은 **직렬**이다. 두 실행이 동시에 돌면 사용자 창에 탭이 겹쳐 열리고 탭 그룹·
 *     다운로드 폴더가 경합한다.
 *   - 실행 컨텍스트는 러너가 정한다: `_mcpSessionId: "scheduled"`, `lane: <이름>`,
 *     `forceBackground: true`. 저장된 step 이 다른 세션 키를 흉내 낼 수 없다.
 */

import { saveArtifactToDownloads } from '@/utils/artifact-path';
import { isMcpWindow } from '@/utils/mcp-window-manager';
import {
  buildHistoryResults,
  classifyRunOutcome,
  finishRunRecord,
  findRecordById,
  markRunningAsInterrupted,
  readHistory,
  startRunRecord,
  type FinalRunStatus,
  type RunRecord,
  type RunRecordPatch,
} from '@/utils/shortcut-history';
import {
  SCHEDULED_SESSION_ID,
  alarmNameFor,
  armScheduleAlarm,
  clearScheduleAlarm,
  computeNextAt,
  currentTimeZoneSignature,
  patchSchedule,
  readSchedule,
  readSchedules,
  scheduleNameFromAlarm,
  scheduleRunId,
  scheduleTaskTitle,
  timeZoneChanged,
  type ScheduleRecord,
} from '@/utils/shortcut-schedule';
import {
  clearWorkTab,
  forgetOwnedTab,
  getSessionScopedTabIds,
  listSessionKeysWithPrefix,
  sessionKeyOf,
} from '@/utils/work-tab-manager';
import {
  FlowAbortedError,
  runSteps,
  validateFlow,
  type RunStepsOutcome,
  type ToolInvoker,
} from './tools/browser/batch-runner';
import {
  SHORTCUT_DISALLOWED_STEP_TOOLS,
  loadShortcuts,
  resolveShortcutParams,
} from './tools/browser/shortcut';

/* ------------------------------------------------------------------ *
 * 상한과 상수 (설계 7절)
 * ------------------------------------------------------------------ */

/** 실행 잠금 (워커가 갈려도 보이도록 storage.session 에 둔다). */
const RUN_LOCK_KEY = 'scheduledRunLock';
/** 잠금 소유자가 살아 있음을 알리는 주기. */
const HEARTBEAT_MS = 10_000;
/** 이만큼 갱신되지 않은 잠금은 죽은 것으로 보고 회수한다. */
const STALE_LOCK_MS = 30_000;
/** 실행 end-to-end 상한 (batch 100초 + 스크린샷·report·정리 20초). */
export const RUN_TIMEOUT_MS = 120_000;
/** 큐에서 이만큼을 넘긴 항목은 실행하지 않고 `skipped_queue` 로 기록한다. */
export const QUEUE_MAX_WAIT_MS = 10 * 60_000;
/** 유휴 타이머를 되돌리기 위한 확장 API 호출 주기. */
const KEEPALIVE_MS = 20_000;
/** 잠금을 못 잡았을 때 다시 시도하기까지 기다리는 시간. */
const LOCK_RETRY_MS = 5_000;
/** report 파일의 `results` 상한 (UTF-8 byte). */
export const MAX_REPORT_RESULT_BYTES = 256 * 1024;

/** 알림을 보내는 상태 (설계 5절). 성공·stopped·skipped_queue 는 조용하다. */
const NOTIFY_STATUSES: ReadonlySet<string> = new Set([
  'failed',
  'timeout',
  'interrupted',
  'login_required',
  'user_took_over_tab',
]);

/** 연속 실패가 이 횟수일 때만 알림을 보낸다. 4회 이상은 `schedules` 로만 드러난다. */
const NOTIFY_FAIL_STREAKS: readonly number[] = [1, 3];

/* ------------------------------------------------------------------ *
 * 배선
 * ------------------------------------------------------------------ */

let invoker: ToolInvoker | null = null;

/** tools/index.ts 가 handleCallTool 을 꽂는다 (순환 import 회피, batch 와 같은 패턴). */
export function setScheduleToolInvoker(fn: ToolInvoker): void {
  invoker = fn;
}

/** 이 워커 인스턴스의 잠금 소유자 토큰. 워커가 죽으면 하트비트가 멈춘다. */
const OWNER_TOKEN = `sw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/* ------------------------------------------------------------------ *
 * 큐
 * ------------------------------------------------------------------ */

interface QueueItem {
  name: string;
  dueAt: number;
  runId: string;
  enqueuedAt: number;
}

const queue: QueueItem[] = [];
/** 이 워커가 이미 집은 runId (await 이전에 등록한다). */
const claimedRunIds = new Set<string>();
/** 지금 실행 중인 버킷 키. 고아 탭 정리가 살아 있는 실행의 탭을 건드리지 않게 한다. */
const activeSessionKeys = new Set<string>();
let draining = false;
let reconciling = false;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 예약 실행의 버킷 키 (`scheduled::<이름>`). */
export function scheduledSessionKey(name: string): string {
  return sessionKeyOf({ _mcpSessionId: SCHEDULED_SESSION_ID, lane: name });
}

/**
 * 큐에 넣는다. **어떤 await 도 하기 전에** 메모리 claim 을 등록한다 - 알람과 따라잡기가
 * 같은 due 를 동시에 집어도 하나만 남는다. 같은 이름이 이미 큐에 있으면 넣지 않는다.
 */
export function enqueueScheduledRun(
  name: string,
  dueAt: number,
  now: number = Date.now(),
): boolean {
  const runId = scheduleRunId(name, dueAt);
  if (claimedRunIds.has(runId)) return false;
  if (queue.some((item) => item.name === name)) return false;
  claimedRunIds.add(runId);
  queue.push({ name, dueAt, runId, enqueuedAt: now });
  void drainQueue();
  return true;
}

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      try {
        if (Date.now() - item.enqueuedAt > QUEUE_MAX_WAIT_MS) {
          await recordSkippedQueue(item);
          continue;
        }
        const locked = await acquireRunLock(item.runId);
        if (!locked) {
          // 다른 워커가 돌고 있다. 순서를 지키되 바쁜 대기는 하지 않는다.
          queue.push(item);
          await sleep(LOCK_RETRY_MS);
          continue;
        }
        try {
          await executeScheduledRun(item);
        } finally {
          await releaseRunLock(item.runId);
        }
      } catch (error) {
        console.warn('[schedule-runner] 예약 실행 처리 실패:', error);
      } finally {
        claimedRunIds.delete(item.runId);
      }
    }
  } finally {
    draining = false;
  }
}

/** 큐에서 상한을 넘긴 항목은 실행하지 않고 기록만 남긴다 (알림 없음). */
async function recordSkippedQueue(item: QueueItem): Promise<void> {
  const now = Date.now();
  await safeWrite(() =>
    finishRunRecord(item.name, item.runId, {
      status: 'skipped_queue',
      trigger: 'scheduled',
      startedAt: item.enqueuedAt,
      endedAt: now,
      durationMs: now - item.enqueuedAt,
      errorCode: 'skipped_queue',
      error: null,
    }),
  );
}

/* ------------------------------------------------------------------ *
 * 잠금
 * ------------------------------------------------------------------ */

interface RunLock {
  runId: string;
  owner: string;
  heartbeatAt: number;
}

async function readRunLock(): Promise<RunLock | null> {
  try {
    const result = await chrome.storage.session.get([RUN_LOCK_KEY]);
    const raw = (result as any)?.[RUN_LOCK_KEY];
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.owner !== 'string' || typeof raw.heartbeatAt !== 'number') return null;
    return raw as RunLock;
  } catch {
    return null;
  }
}

async function acquireRunLock(runId: string, now: number = Date.now()): Promise<boolean> {
  const current = await readRunLock();
  if (current && current.owner !== OWNER_TOKEN && now - current.heartbeatAt < STALE_LOCK_MS) {
    return false;
  }
  try {
    await chrome.storage.session.set({
      [RUN_LOCK_KEY]: { runId, owner: OWNER_TOKEN, heartbeatAt: now } satisfies RunLock,
    });
    return true;
  } catch {
    return false;
  }
}

async function releaseRunLock(runId: string): Promise<void> {
  try {
    const current = await readRunLock();
    if (current && current.owner === OWNER_TOKEN && current.runId === runId) {
      await chrome.storage.session.remove(RUN_LOCK_KEY);
    }
  } catch {
    // 잠금 해제 실패는 다음 하트비트 만료로 회수된다.
  }
}

/** 하트비트가 30초 넘게 멈춘 잠금을 회수한다 (워커가 죽은 경우). */
async function releaseStaleRunLock(now: number = Date.now()): Promise<boolean> {
  const current = await readRunLock();
  if (!current) return false;
  if (current.owner === OWNER_TOKEN) return false;
  if (now - current.heartbeatAt < STALE_LOCK_MS) return false;
  try {
    await chrome.storage.session.remove(RUN_LOCK_KEY);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 탭 정리와 인계
 * ------------------------------------------------------------------ */

/** 이 탭이 사용자가 지금 보고 있는 탭인가 (MCP 전용 창의 활성 탭은 사용자 탭이 아니다). */
async function isUserFacingActiveTab(tab: chrome.tabs.Tab | null): Promise<boolean> {
  if (!tab || tab.active !== true) return false;
  try {
    return !(await isMcpWindow(tab.windowId));
  } catch {
    return true;
  }
}

/**
 * 실행이 끝난(또는 고아가 된) 버킷의 탭을 정리한다.
 * 사용자가 보고 있는 탭은 **닫지 않고 소유만** 해제한다.
 */
export async function cleanupScheduledSessionTabs(sessionKey: string): Promise<void> {
  let tabIds: number[] = [];
  try {
    tabIds = await getSessionScopedTabIds(sessionKey);
  } catch {
    tabIds = [];
  }
  for (const tabId of tabIds) {
    let tab: chrome.tabs.Tab | null = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      tab = null;
    }
    if (tab && !(await isUserFacingActiveTab(tab))) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // 이미 닫혔거나 닫을 수 없다. 소유 해제는 그대로 진행한다.
      }
    }
    try {
      await forgetOwnedTab(tabId);
    } catch {
      // ignore
    }
  }
  try {
    await clearWorkTab(sessionKey);
  } catch {
    // ignore
  }
}

/**
 * 예약 소유 탭을 사용자가 활성화했으면 실행을 끊는다. 탭은 닫지 않고 소유·작업 탭 기록만
 * 해제한다 - 사용자가 눌러 본 탭을 도구가 계속 조작하는 것이 곧 사용자 탭 침해다.
 */
async function assertTabNotTakenOver(sessionKey: string): Promise<void> {
  let tabIds: number[] = [];
  try {
    tabIds = await getSessionScopedTabIds(sessionKey);
  } catch {
    return;
  }
  for (const tabId of tabIds) {
    let tab: chrome.tabs.Tab | null = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      continue;
    }
    if (await isUserFacingActiveTab(tab)) {
      try {
        await forgetOwnedTab(tabId);
        await clearWorkTab(sessionKey);
      } catch {
        // ignore
      }
      throw new FlowAbortedError(
        'user_took_over_tab',
        'user_took_over_tab: the run gave up its tab because you opened it',
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * 실행
 * ------------------------------------------------------------------ */

async function safeWrite(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.warn('[schedule-runner] 이력 기록 실패(실행에는 영향 없음):', error);
  }
}

/** 알림 본문에 실을 수 있는 코드인가 (페이지 텍스트가 섞이지 않게 한다). */
function safeNotificationCode(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[a-z][a-z0-9_]*$/.test(value) ? value : fallback;
}

async function notifyFailure(
  record: ScheduleRecord,
  status: FinalRunStatus,
  errorCode: string | null,
  failedStepIndex: number | null,
  failStreak: number,
): Promise<void> {
  if (record.notify !== true) return;
  if (!NOTIFY_STATUSES.has(status)) return;
  if (!NOTIFY_FAIL_STREAKS.includes(failStreak)) return;
  // 본문 allowlist: 이름·코드·step 번호 뿐이다. 오류 문구에는 페이지 텍스트가 섞인다.
  const code = safeNotificationCode(errorCode, status);
  const step = typeof failedStepIndex === 'number' ? ` (step ${failedStepIndex})` : '';
  try {
    await chrome.notifications.create(`mcp-shortcut-fail::${record.name}::${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon/128.png'),
      title: 'Auto Chrome MCP 예약 실패',
      message: `${record.name}: ${code}${step}`,
      priority: 1,
      requireInteraction: false,
    });
  } catch (error) {
    console.warn('[schedule-runner] 알림 실패(무시):', error);
  }
}

/** UTF-8 byte 길이. */
const encoder = new TextEncoder();
function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** report 파일용 `results` (항목 단위로 256KiB 안에 담고, 넘는 것은 통째로 뺀다). */
export function buildReportResults(returned: Record<string, unknown> | undefined): {
  results: Record<string, unknown>;
  truncated: string[];
} {
  const results: Record<string, unknown> = {};
  const truncated: string[] = [];
  if (!returned || typeof returned !== 'object') return { results, truncated };
  let total = 0;
  for (const name of Object.keys(returned)) {
    let serialized = '';
    try {
      serialized = JSON.stringify(returned[name]) ?? '';
    } catch {
      truncated.push(name);
      continue;
    }
    const size = byteLength(serialized);
    if (size > MAX_REPORT_RESULT_BYTES || total + size > MAX_REPORT_RESULT_BYTES) {
      truncated.push(name);
      continue;
    }
    total += size;
    results[name] = returned[name];
  }
  return { results, truncated };
}

/** UTF-8 문자열을 data: URL 로. 다운로드 API 는 blob: 을 워커에서 못 쓰므로 base64 로 싣는다. */
function jsonDataUrl(text: string): string {
  const bytes = encoder.encode(text);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:application/json;base64,${btoa(binary)}`;
}

/**
 * 실패 스크린샷 1장. 작업 탭에 `chrome_screenshot` 을 한 번 부른다.
 * 저장 경로는 `mcp-screenshots/YYYY-MM-DD/screenshot_failure_<이름>_<HHmmss>.png` 다.
 * 실패해도 실행 기록은 남긴다 (`screenshot: null` 과 `warnings`).
 */
async function captureFailureScreenshot(name: string, invoke: ToolInvoker): Promise<string | null> {
  try {
    const raw = await invoke({
      name: 'chrome_screenshot',
      args: {
        name: `failure_${name}`,
        savePng: true,
        storeBase64: false,
        background: true,
        _mcpSessionId: SCHEDULED_SESSION_ID,
        lane: name,
      },
      effectiveBackgroundMode: true,
    });
    if (raw?.isError === true) return null;
    const text = Array.isArray(raw?.content)
      ? raw.content.find((item: any) => item?.type === 'text')?.text
      : undefined;
    if (typeof text !== 'string') return null;
    const parsed = JSON.parse(text);
    return typeof parsed?.filename === 'string' ? parsed.filename : null;
  } catch (error) {
    console.warn('[schedule-runner] 실패 스크린샷 저장 실패:', error);
    return null;
  }
}

/** 예약 실행 하나. 잠금은 호출부가 이미 잡았다. */
async function executeScheduledRun(item: QueueItem): Promise<void> {
  const invoke = invoker;
  const { name, runId } = item;

  const record = await readSchedule(name);
  if (!record) {
    await clearScheduleAlarm(name);
    return;
  }

  // storage claim: 다른 워커가 이미 이 due 를 실행했으면 포기한다.
  const history = await readHistory();
  if (findRecordById(history, runId, name) !== null) return;

  const shortcuts = await loadShortcuts();
  const stored = shortcuts[name];
  const startedAt = Date.now();

  if (!invoke || !stored) {
    await safeWrite(() =>
      finishRunRecord(name, runId, {
        status: 'failed',
        trigger: 'scheduled',
        startedAt,
        endedAt: Date.now(),
        errorCode: invoke ? 'shortcut_not_found' : 'invoker_not_wired',
        error: invoke
          ? `shortcut_not_found: "${name}" was deleted, so the schedule cannot run`
          : 'invoker_not_wired: the extension is still starting up',
        revision: record.revision,
      }),
    );
    await applyRunOutcome(record, runId, 'failed', invoke ? 'shortcut_not_found' : null, null);
    return;
  }

  const steps = Array.isArray(stored.steps) ? stored.steps : [];
  const templatesEnabled = stored.templates === true;
  const returnNames = Array.isArray(stored.returnNames) ? stored.returnNames : undefined;
  const params = resolveShortcutParams(stored.params, record.params);

  if (!params.ok) {
    await safeWrite(() =>
      finishRunRecord(name, runId, {
        status: 'failed',
        trigger: 'scheduled',
        startedAt,
        endedAt: Date.now(),
        errorCode: params.error.split(':', 1)[0] ?? 'failed',
        error: params.error,
        revision: record.revision,
      }),
    );
    await applyRunOutcome(record, runId, 'failed', params.error.split(':', 1)[0] ?? null, null);
    return;
  }
  const flowError = templatesEnabled ? validateFlow(steps, returnNames) : null;
  if (flowError) {
    await safeWrite(() =>
      finishRunRecord(name, runId, {
        status: 'failed',
        trigger: 'scheduled',
        startedAt,
        endedAt: Date.now(),
        errorCode: flowError.split(':', 1)[0] ?? 'failed',
        error: flowError,
        revision: record.revision,
      }),
    );
    await applyRunOutcome(record, runId, 'failed', flowError.split(':', 1)[0] ?? null, null);
    return;
  }

  const sessionKey = scheduledSessionKey(name);
  activeSessionKeys.add(sessionKey);
  await safeWrite(() =>
    startRunRecord({
      runId,
      name,
      trigger: 'scheduled',
      startedAt,
      revision: record.revision,
      secrets: params.secrets,
    }),
  );

  const deadlineAt = startedAt + RUN_TIMEOUT_MS;
  const heartbeat = setInterval(() => {
    void chrome.storage.session
      .set({ [RUN_LOCK_KEY]: { runId, owner: OWNER_TOKEN, heartbeatAt: Date.now() } })
      .catch(() => undefined);
  }, HEARTBEAT_MS);
  const keepalive = setInterval(() => {
    // Chrome 110+ 는 확장 API 호출이 유휴 타이머를 되돌린다. chrome_wait_for 처럼
    // 오래 기다리는 step 이 있어 도구 호출만으로는 부족하다.
    try {
      void chrome.runtime.getPlatformInfo?.();
    } catch {
      // ignore
    }
  }, KEEPALIVE_MS);

  let outcome: RunStepsOutcome;
  try {
    outcome = await Promise.race([
      runSteps({
        steps,
        invoke,
        mcpSessionId: SCHEDULED_SESSION_ID,
        lane: name,
        disallowedTools: SHORTCUT_DISALLOWED_STEP_TOOLS,
        containerLabel: 'chrome_shortcut',
        skippedNote: 'skipped (scheduled run stopped at earlier failing step)',
        collectImages: false,
        templatesEnabled,
        returnNames: templatesEnabled ? returnNames : undefined,
        params: templatesEnabled ? params.values : undefined,
        forceBackground: true,
        taskTitle: scheduleTaskTitle(name),
        beforeStep: async () => {
          if (Date.now() >= deadlineAt) {
            throw new FlowAbortedError('timeout', 'timeout: the run passed its 120 second budget');
          }
          await assertTabNotTakenOver(sessionKey);
        },
      }),
      guardTimeout(deadlineAt - Date.now()),
    ]);
  } catch (error) {
    outcome = {
      success: false,
      results: [],
      images: [],
      aborted: {
        reason: 'failed',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    clearInterval(heartbeat);
    clearInterval(keepalive);
  }

  const classification = classifyRunOutcome(outcome, { loginCheckAs: record.loginCheck });
  const warnings: string[] = [...(params.warnings ?? [])];
  const usesSecret = params.secrets.length > 0;

  // 실패 스크린샷 1장. secret 을 쓴 실행은 비밀번호가 화면에 남을 수 있어 만들지 않는다.
  let screenshot: string | null = null;
  if ((classification.status === 'failed' || classification.status === 'timeout') && !usesSecret) {
    screenshot = await captureFailureScreenshot(name, invoke);
    if (screenshot === null) warnings.push('screenshot_failed');
  }

  const historyResults = buildHistoryResults(outcome.returned);
  const truncated = Array.from(
    new Set([...(outcome.resultsTruncated ?? []), ...historyResults.truncated]),
  );

  // 실행이 끝났으니 소유 탭을 닫고 버킷을 비운다 (스크린샷을 찍은 뒤여야 한다).
  await cleanupScheduledSessionTabs(sessionKey);
  activeSessionKeys.delete(sessionKey);

  const endedAt = Date.now();
  const patch: RunRecordPatch = {
    status: classification.status,
    trigger: 'scheduled',
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    failedStep: classification.failedStep,
    errorCode: classification.errorCode,
    error: classification.error,
    stoppedBy: outcome.stoppedBy ?? null,
    results: historyResults.results,
    screenshot,
    revision: record.revision,
    ...(truncated.length > 0 ? { resultsTruncated: truncated } : {}),
  };

  // report 파일 (예약 실행 전용, 기본 꺼짐). 저장 직전에 secret 흔적을 한 번 더 본다.
  let reportPath: string | null = null;
  if (record.report === true) {
    if (usesSecret) {
      warnings.push('report_skipped_secret');
    } else {
      const report = buildReportResults(outcome.returned);
      const payload: RunRecord = {
        ...(patch as unknown as RunRecord),
        runId,
        name,
        results: report.results,
        ...(report.truncated.length > 0 ? { resultsTruncated: report.truncated } : {}),
      };
      try {
        const saved = await saveArtifactToDownloads({
          url: jsonDataUrl(JSON.stringify(payload, null, 2)),
          kind: 'report',
          name,
          ext: 'json',
          // 절대 경로는 필요 없다. 이력에 남기는 것은 다운로드 폴더 기준 상대 경로이고,
          // 100ms 를 더 기다리는 만큼 end-to-end 예산만 축난다.
          resolvePathDelayMs: 0,
        });
        reportPath = saved.filename;
      } catch (error) {
        console.warn('[schedule-runner] report 저장 실패:', error);
        warnings.push('report_failed');
      }
    }
  }
  patch.report = reportPath;
  if (warnings.length > 0) patch.warnings = warnings;

  await applyRunOutcome(
    record,
    runId,
    classification.status,
    classification.errorCode,
    classification.failedStep ? classification.failedStep.index : null,
    patch,
    params.secrets,
  );
}

/** 120초 벽시계 상한. 도구 하나가 매달려도 여기서 응답이 나온다. */
async function guardTimeout(ms: number): Promise<RunStepsOutcome> {
  await sleep(Math.max(0, ms));
  return {
    success: false,
    results: [],
    images: [],
    aborted: { reason: 'timeout', message: 'timeout: the run passed its 120 second budget' },
  };
}

/**
 * 실행 결과를 이력·예약 레코드·알람에 반영한다.
 *
 * `revision` 이 달라졌으면(실행 도중 사용자가 `save`·`unschedule`·`delete`·재예약을 했다)
 * 재무장도 `lastStatus`·`failStreak` 갱신도 하지 않고 이력에 `superseded: true` 만 남긴다.
 * 지운 예약이 다시 도는 것을 막기 위해서다.
 */
async function applyRunOutcome(
  record: ScheduleRecord,
  runId: string,
  status: FinalRunStatus,
  errorCode: string | null,
  failedStepIndex: number | null,
  patch?: RunRecordPatch,
  secrets: readonly string[] = [],
): Promise<void> {
  const now = Date.now();
  const current = await readSchedule(record.name);
  const superseded = current === null || current.revision !== record.revision;

  if (patch) {
    await safeWrite(() => finishRunRecord(record.name, runId, { ...patch, superseded }, secrets));
  } else if (superseded) {
    await safeWrite(() => finishRunRecord(record.name, runId, { status, superseded: true }));
  }

  if (superseded) return;

  const failStreak = NOTIFY_STATUSES.has(status) ? (current.failStreak ?? 0) + 1 : 0;
  const nextAt = computeNextAt(current, now);
  await patchSchedule(
    record.name,
    {
      lastRunId: runId,
      lastStatus: status,
      lastRunAt: now,
      failStreak,
      ...(nextAt !== null ? { nextAt } : {}),
    },
    record.revision,
  );
  if (nextAt !== null) await armScheduleAlarm(record.name, nextAt);

  await notifyFailure(current, status, errorCode, failedStepIndex, failStreak);
}

/* ------------------------------------------------------------------ *
 * reconcile
 * ------------------------------------------------------------------ */

/**
 * 워커가 평가될 때마다 한 번 돈다.
 *   1. `running` 으로 남은 이력을 `interrupted` 로 (이 워커가 돌리는 실행은 제외)
 *   2. 하트비트가 멈춘 잠금 회수
 *   3. `scheduled::` 고아 탭 정리 (활성 탭이면 소유만 해제)
 *   4. 타임존이 바뀌었으면 `nextAt` 재계산
 *   5. 지난 `nextAt` 은 **한 번만** 따라잡고 격자를 미래로 옮긴다
 *   6. 레코드는 있는데 없는 알람 재생성, 레코드 없는 알람 정리
 */
export async function reconcileSchedules(now: number = Date.now()): Promise<void> {
  if (reconciling) return;
  reconciling = true;
  try {
    await markRunningAsInterrupted(now);
    await releaseStaleRunLock(now);
    await cleanupOrphanScheduledTabs();

    const map = await readSchedules();
    const signature = currentTimeZoneSignature(now);
    let alarms: chrome.alarms.Alarm[] = [];
    try {
      alarms = await chrome.alarms.getAll();
    } catch {
      alarms = [];
    }
    const alarmNames = new Set(alarms.map((alarm) => alarm.name));

    for (const name of Object.keys(map)) {
      let record = map[name];
      if (timeZoneChanged(record, signature)) {
        const recomputed = computeNextAt(record, now);
        const updated = await patchSchedule(name, {
          ...(recomputed !== null ? { nextAt: recomputed } : {}),
          timeZone: signature.timeZone,
          offsetMinutes: signature.offsetMinutes,
        });
        if (updated) record = updated;
        await armScheduleAlarm(name, record.nextAt);
      }

      if (record.nextAt <= now) {
        // 따라잡기는 1회다. 놓친 8회를 몰아서 돌리면 아침 크롬을 13분 점유한다.
        enqueueScheduledRun(name, record.nextAt, now);
        const nextAt = computeNextAt(record, now);
        if (nextAt !== null) {
          await patchSchedule(name, { nextAt });
          await armScheduleAlarm(name, nextAt);
        }
        continue;
      }
      if (!alarmNames.has(alarmNameFor(name))) {
        await armScheduleAlarm(name, record.nextAt);
      }
    }

    for (const alarm of alarms) {
      const owned = scheduleNameFromAlarm(alarm.name);
      if (owned !== null && !Object.hasOwn(map, owned)) {
        await clearScheduleAlarm(owned);
      }
    }
  } catch (error) {
    console.warn('[schedule-runner] reconcile 실패:', error);
  } finally {
    reconciling = false;
  }
}

/** 지금 돌고 있지 않은 `scheduled::` 버킷의 탭을 정리한다. */
async function cleanupOrphanScheduledTabs(): Promise<void> {
  let keys: string[] = [];
  try {
    keys = await listSessionKeysWithPrefix(`${SCHEDULED_SESSION_ID}::`);
  } catch {
    return;
  }
  for (const key of keys) {
    if (activeSessionKeys.has(key)) continue;
    await cleanupScheduledSessionTabs(key);
  }
}

/* ------------------------------------------------------------------ *
 * 알람 리스너 (모듈 최상위 - 늦게 등록하면 워커를 깨우지 못한다)
 * ------------------------------------------------------------------ */

function handleAlarm(alarm: chrome.alarms.Alarm): void {
  const name = scheduleNameFromAlarm(alarm?.name);
  if (name === null) return;
  const dueAt = typeof alarm?.scheduledTime === 'number' ? alarm.scheduledTime : Date.now();
  // await 이전에 claim 한다 - reconcile 의 따라잡기가 같은 due 를 집어도 하나만 남는다.
  enqueueScheduledRun(name, dueAt);
  void reconcileSchedules();
}

try {
  chrome.alarms?.onAlarm?.addListener?.(handleAlarm);
} catch (error) {
  console.warn('[schedule-runner] onAlarm 등록 실패:', error);
}

/**
 * background/index.ts 가 부른다. `defineBackground` 본문은 워커가 평가될 때마다 돌므로
 * 이 호출이 곧 "워커 평가마다 reconcile" 이다.
 */
export function initShortcutScheduleRunner(): void {
  void reconcileSchedules();
}

/** 테스트용 - 큐와 claim 을 비운다. */
export function resetScheduleRunnerState(): void {
  queue.length = 0;
  claimedRunIds.clear();
  activeSessionKeys.clear();
  draining = false;
  reconciling = false;
}
