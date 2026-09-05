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
  beginSpawnScope,
  endSpawnScope,
  isSpawnedPopupWindow,
  resetSpawnScopes,
  settleSpawnAdoptions,
} from '@/utils/spawned-tab-tracker';
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
/** 상한을 넘겨 실행을 끊은 뒤, 러너가 실제로 멈추기를 기다리는 시간. */
export const ABORT_GRACE_MS = 15_000;

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

/** 지금 쥐고 있는 잠금의 nonce. 하트비트가 남의 잠금을 덮어쓰지 않게 한다. */
let currentLockNonce: string | null = null;

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
        const slot = await acquireRunSlot(item);
        if (slot.kind === 'busy') {
          // 다른 워커가 돌고 있다. 순서를 지키되 바쁜 대기는 하지 않는다.
          queue.push(item);
          await sleep(LOCK_RETRY_MS);
          continue;
        }
        // 예약이 사라졌거나 다른 워커가 이미 이 due 를 실행했다.
        if (slot.kind === 'done') continue;
        try {
          await executeScheduledRun(item, slot);
        } finally {
          await releaseRunLock(slot.nonce);
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
  /** 이 획득 시도만의 값. 같은 워커가 두 번 시도해도 서로 구별된다. */
  nonce: string;
  /** 예약 이름. reconcile 이 살아 있는 lease 의 버킷을 건드리지 않게 한다. */
  name: string;
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

/** 이 lease 가 아직 살아 있는가 (하트비트가 30초 안에 갱신됐는가). */
function lockIsAlive(lock: RunLock | null, now: number): boolean {
  return lock !== null && now - lock.heartbeatAt < STALE_LOCK_MS;
}

let lockNonceSeq = 0;
function nextLockNonce(): string {
  lockNonceSeq += 1;
  return `${OWNER_TOKEN}-${lockNonceSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 잠금을 잡는다. 잡았으면 nonce, 못 잡았으면 null.
 *
 * 2026-09-05 Codex 리뷰 4: 예전에는 "읽어서 비어 있으면 쓴다" 였다. 두 워커가 같은 순간에
 * 읽으면 둘 다 비어 있는 것을 보고 둘 다 썼고, 나중에 쓴 쪽이 먼저 쓴 쪽의 잠금을 덮어
 * 두 실행이 나란히 돌았다. 이제 **쓰고 나서 다시 읽어**(fenced) 내 nonce 가 남아 있을
 * 때만 잡은 것으로 본다. 늦게 쓴 쪽이 이기고 먼저 쓴 쪽은 스스로 물러난다.
 */
async function acquireRunLock(
  runId: string,
  name: string,
  now: number = Date.now(),
): Promise<string | null> {
  const current = await readRunLock();
  if (current && current.owner !== OWNER_TOKEN && lockIsAlive(current, now)) {
    return null;
  }
  const nonce = nextLockNonce();
  try {
    await chrome.storage.session.set({
      [RUN_LOCK_KEY]: {
        runId,
        name,
        owner: OWNER_TOKEN,
        nonce,
        heartbeatAt: now,
      } satisfies RunLock,
    });
  } catch {
    return null;
  }
  const confirmed = await readRunLock();
  if (!confirmed || confirmed.nonce !== nonce) return null;
  return nonce;
}

async function releaseRunLock(nonce: string): Promise<void> {
  try {
    const current = await readRunLock();
    if (current && current.nonce === nonce) {
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
  if (lockIsAlive(current, now)) return false;
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
  // 실행 중 페이지가 연 팝업 창의 탭은 언제나 그 창의 활성 탭이다. 사용자가 고른 탭이
  // 아니므로 인계로 보면 팝업이 뜰 때마다 실행이 끊긴다 (2026-09-05 Codex 리뷰 1).
  if (isSpawnedPopupWindow(tab.windowId)) return false;
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
  // 스코프를 먼저 닫아, 이 실행이 연 팝업 창 목록을 확정한다.
  await settleSpawnAdoptions();
  const popupWindowIds = new Set(endSpawnScope(sessionKey));

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
    // 페이지가 연 팝업 창의 탭은 활성이어도 닫는다 (사용자가 고른 탭이 아니다).
    const spawnedPopup = tab !== null && popupWindowIds.has(tab.windowId);
    if (tab && (spawnedPopup || !(await isUserFacingActiveTab(tab)))) {
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
  // 팝업 창은 실행이 끝나면 창째로 닫는다. 탭만 닫으면 빈 창이 화면에 남는다.
  for (const windowId of popupWindowIds) {
    try {
      await chrome.windows.remove(windowId);
    } catch {
      // 이미 닫혔다 - best-effort
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
  // 페이지가 방금 연 탭의 소유 등록·화면 복구가 끝난 뒤에 판정한다. 그 전에 보면
  // 아직 활성 상태인 스폰 탭을 "사용자가 가져갔다" 로 오판한다.
  await settleSpawnAdoptions();
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

/** 잠금·claim 결과. `ok` 일 때만 실행으로 이어진다. */
type RunSlot =
  | { kind: 'busy' }
  | { kind: 'done' }
  | { kind: 'ok'; nonce: string; record: ScheduleRecord; startedAt: number };

/**
 * 실행 자리를 잡는다: 잠금(fenced) -> 예약 레코드 확인 -> 이력 claim -> `running` 기록.
 *
 * 2026-09-05 Codex 리뷰 4: 예전에는 잠금과 이력 claim 사이가 벌어져 있었다. 잠금을 잡은
 * 워커가 shortcut 을 읽고 params 를 검증하는 동안 다른 워커가 같은 due 를 집으면, 그
 * 워커도 "이력에 아직 없다" 를 보고 함께 실행했다. 이제 네 단계를 한 임계 구역에서 한다.
 */
async function acquireRunSlot(item: QueueItem): Promise<RunSlot> {
  const nonce = await acquireRunLock(item.runId, item.name);
  if (nonce === null) return { kind: 'busy' };
  try {
    const record = await readSchedule(item.name);
    if (!record) {
      await clearScheduleAlarm(item.name);
      await releaseRunLock(nonce);
      return { kind: 'done' };
    }
    // storage claim: 다른 워커가 이미 이 due 를 실행했으면 포기한다.
    const history = await readHistory();
    if (findRecordById(history, item.runId, item.name) !== null) {
      await releaseRunLock(nonce);
      return { kind: 'done' };
    }
    const startedAt = Date.now();
    currentLockNonce = nonce;
    await safeWrite(() =>
      startRunRecord({
        runId: item.runId,
        name: item.name,
        trigger: 'scheduled',
        startedAt,
        revision: record.revision,
        generation: record.generation,
      }),
    );
    return { kind: 'ok', nonce, record, startedAt };
  } catch (error) {
    await releaseRunLock(nonce);
    throw error;
  }
}

/** 지금 사용자가 보고 있는 탭·창 (실행 중 팝업이 화면을 가져가면 여기로 되돌린다). */
async function currentUserView(): Promise<{ tabId: number | null; windowId: number | null }> {
  let windowId: number | null = null;
  let tabId: number | null = null;
  try {
    const focused = await chrome.windows.getLastFocused();
    if (typeof focused?.id === 'number' && !(await isMcpWindow(focused.id))) {
      windowId = focused.id;
    }
  } catch {
    windowId = null;
  }
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (typeof active?.id === 'number') tabId = active.id;
  } catch {
    tabId = null;
  }
  return { tabId, windowId };
}

/** 예약 실행 하나. 잠금·이력 claim 은 `acquireRunSlot` 이 이미 끝냈다. */
async function executeScheduledRun(
  item: QueueItem,
  slot: { record: ScheduleRecord; startedAt: number },
): Promise<void> {
  const invoke = invoker;
  const { name, runId } = item;
  const record = slot.record;
  const startedAt = slot.startedAt;

  /** 실행에 들어가지도 못한 실패. 이력과 예약 레코드에 같은 사유를 남긴다. */
  const failBeforeRun = async (errorCode: string | null, error: string): Promise<void> => {
    await safeWrite(() =>
      finishRunRecord(name, runId, {
        status: 'failed',
        trigger: 'scheduled',
        startedAt,
        endedAt: Date.now(),
        errorCode,
        error,
        revision: record.revision,
        generation: record.generation,
      }),
    );
    await applyRunOutcome(record, runId, 'failed', errorCode, null);
  };

  const shortcuts = await loadShortcuts();
  const stored = shortcuts[name];

  if (!invoke || !stored) {
    await failBeforeRun(
      invoke ? 'shortcut_not_found' : 'invoker_not_wired',
      invoke
        ? `shortcut_not_found: "${name}" was deleted, so the schedule cannot run`
        : 'invoker_not_wired: the extension is still starting up',
    );
    return;
  }

  const steps = Array.isArray(stored.steps) ? stored.steps : [];
  const templatesEnabled = stored.templates === true;
  const returnNames = Array.isArray(stored.returnNames) ? stored.returnNames : undefined;
  const params = resolveShortcutParams(stored.params, record.params);

  if (!params.ok) {
    await failBeforeRun(params.error.split(':', 1)[0] ?? 'failed', params.error);
    return;
  }
  const flowError = templatesEnabled ? validateFlow(steps, returnNames) : null;
  if (flowError) {
    await failBeforeRun(flowError.split(':', 1)[0] ?? 'failed', flowError);
    return;
  }

  const sessionKey = scheduledSessionKey(name);
  activeSessionKeys.add(sessionKey);

  const deadlineAt = startedAt + RUN_TIMEOUT_MS;
  const heartbeat = setInterval(() => {
    void chrome.storage.session
      .set({
        [RUN_LOCK_KEY]: {
          runId,
          name,
          owner: OWNER_TOKEN,
          nonce: currentLockNonce ?? '',
          heartbeatAt: Date.now(),
        },
      })
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

  // 2026-09-05 Codex 리뷰 5: heartbeat·keepalive 는 **정리까지** 살아 있어야 한다.
  // 예전에는 runSteps 를 감싼 finally 에서 껐고, 그 뒤의 스크린샷·report·탭 정리는
  // 잠금이 만료된 채로 돌았다.
  try {
    const controller = new AbortController();
    const view = await currentUserView();
    // 실행 중 페이지가 여는 탭·팝업 창을 이 버킷이 흡수한다 (리뷰 1).
    beginSpawnScope({
      sessionKey,
      forced: true,
      restoreTabId: view.tabId,
      restoreWindowId: view.windowId,
    });

    let outcome: RunStepsOutcome;
    const running = runSteps({
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
      deadlineAt,
      signal: controller.signal,
      ...(record.report === true ? { reportLimitBytes: MAX_REPORT_RESULT_BYTES } : {}),
      beforeStep: async () => {
        if (Date.now() >= deadlineAt) {
          throw new FlowAbortedError('timeout', 'timeout: the run passed its 120 second budget');
        }
        await assertTabNotTakenOver(sessionKey);
      },
    });
    const settled = running.then(
      (value) => ({ kind: 'settled' as const, value }),
      (error) => ({ kind: 'failed' as const, error }),
    );

    const raced = await Promise.race([settled, guardTimeout(deadlineAt - Date.now())]);
    if (raced.kind === 'timeout') {
      // 응답만 돌려주고 실행을 살려 두면 취소된 실행이 탭을 더 연다. 실제로 끊고 기다린다.
      controller.abort('timeout');
      await Promise.race([settled, sleep(ABORT_GRACE_MS)]);
      outcome = timeoutOutcome();
    } else if (raced.kind === 'failed') {
      outcome = {
        success: false,
        results: [],
        images: [],
        aborted: {
          reason: 'failed',
          message: raced.error instanceof Error ? raced.error.message : String(raced.error),
        },
      };
    } else {
      outcome = raced.value;
    }

    let classification = classifyRunOutcome(outcome, { loginCheckAs: record.loginCheck });
    const warnings: string[] = [...(params.warnings ?? [])];
    const usesSecret = params.secrets.length > 0;

    // 2026-09-05 Codex 리뷰 6: 마지막 step 뒤에도 인계를 다시 본다. 산출물과 정리보다
    // 앞이어야 한다 - 사용자가 방금 가져간 탭을 스크린샷 찍고 닫으면 그것이 침해다.
    let takenOver = classification.status === 'user_took_over_tab';
    if (!takenOver) {
      try {
        await assertTabNotTakenOver(sessionKey);
      } catch (error) {
        if (error instanceof FlowAbortedError) {
          takenOver = true;
          classification = {
            status: 'user_took_over_tab',
            errorCode: 'user_took_over_tab',
            error: error.message,
            failedStep: classification.failedStep,
          };
        }
      }
    }

    // 실패 스크린샷 1장. secret 을 쓴 실행은 비밀번호가 화면에 남을 수 있어 만들지 않는다.
    let screenshot: string | null = null;
    if (
      !takenOver &&
      (classification.status === 'failed' || classification.status === 'timeout') &&
      !usesSecret
    ) {
      screenshot = await captureFailureScreenshot(name, invoke);
      if (screenshot === null) warnings.push('screenshot_failed');
    }

    const historyResults = buildHistoryResults(outcome.returned);
    const truncated = Array.from(
      new Set([...(outcome.resultsTruncated ?? []), ...historyResults.truncated]),
    );

    // 실행이 끝났으니 소유 탭을 닫고 버킷을 비운다 (스크린샷을 찍은 뒤여야 한다).
    // 사용자가 가져간 탭은 여기서도 닫히지 않는다 - 소유가 이미 풀렸고, 활성 사용자
    // 탭은 정리 대상에서 빠진다.
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
      generation: record.generation,
      ...(truncated.length > 0 ? { resultsTruncated: truncated } : {}),
    };

    // report 파일 (예약 실행 전용, 기본 꺼짐). 저장 직전에 secret 흔적을 한 번 더 본다.
    let reportPath: string | null = null;
    if (record.report === true && !takenOver) {
      if (usesSecret) {
        warnings.push('report_skipped_secret');
      } else {
        // 이력용 24,000자 페이로드가 아니라 256KiB 예산으로 따로 모은 것을 쓴다 (리뷰 10).
        const report = buildReportResults(outcome.reportReturned ?? outcome.returned);
        const reportTruncated = Array.from(
          new Set([...(outcome.reportTruncated ?? []), ...report.truncated]),
        );
        const payload: RunRecord = {
          ...(patch as unknown as RunRecord),
          runId,
          name,
          results: report.results,
        };
        // 이력 쪽에서 빠진 이름을 그대로 물려받지 않는다. report 는 상한이 다르다.
        if (reportTruncated.length > 0) payload.resultsTruncated = reportTruncated;
        else delete payload.resultsTruncated;
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
  } finally {
    clearInterval(heartbeat);
    clearInterval(keepalive);
    activeSessionKeys.delete(sessionKey);
    currentLockNonce = null;
  }
}

/** 상한을 넘긴 실행의 결과. */
function timeoutOutcome(): RunStepsOutcome {
  return {
    success: false,
    results: [],
    images: [],
    aborted: { reason: 'timeout', message: 'timeout: the run passed its 120 second budget' },
  };
}

/** 120초 벽시계 상한. 도구 하나가 매달려도 여기서 응답이 나온다. */
async function guardTimeout(ms: number): Promise<{ kind: 'timeout' }> {
  await sleep(Math.max(0, ms));
  return { kind: 'timeout' };
}

/**
 * 실행 결과를 이력·예약 레코드·알람에 반영한다.
 *
 * 예약이 달라졌으면(실행 도중 사용자가 `save`·`unschedule`·`delete`·재예약을 했다)
 * 재무장도 `lastStatus`·`failStreak` 갱신도 하지 않고 이력에 `superseded: true` 만 남긴다.
 * 지운 예약이 다시 도는 것을 막기 위해서다.
 *
 * 2026-09-05 Codex 리뷰 3: 판정 기준은 `revision` 이 아니라 저장소 전역 `generation` 이다.
 * revision 은 예약을 지웠다 같은 이름으로 다시 걸면 1 부터 다시 세므로, 실행 도중
 * unschedule -> schedule 을 하면 옛 값과 같아질 수 있었다(ABA). 그리고 재무장은
 * **CAS patch 가 성공해 돌려준 레코드**에서만 한다 - patch 가 튕겼는데 알람만 걸면
 * 저장된 `nextAt` 과 실제 알람이 어긋난다.
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
  const superseded = current === null || current.generation !== record.generation;

  if (patch) {
    await safeWrite(() => finishRunRecord(record.name, runId, { ...patch, superseded }, secrets));
  } else if (superseded) {
    await safeWrite(() => finishRunRecord(record.name, runId, { status, superseded: true }));
  }

  if (superseded) return;

  const failStreak = NOTIFY_STATUSES.has(status) ? (current.failStreak ?? 0) + 1 : 0;
  const nextAt = computeNextAt(current, now);
  const updated = await patchSchedule(
    record.name,
    {
      lastRunId: runId,
      lastStatus: status,
      lastRunAt: now,
      failStreak,
      ...(nextAt !== null ? { nextAt } : {}),
    },
    { generation: current.generation },
  );
  // 읽고 쓰는 사이에 또 바뀌었다. 그 예약은 자기 알람을 이미 걸었다.
  if (updated === null) return;

  if (nextAt !== null) await armScheduleAlarm(record.name, updated.nextAt);

  await notifyFailure(updated, status, errorCode, failedStepIndex, failStreak);
}

/**
 * 워커·크롬이 죽어 `interrupted` 로 바뀐 실행의 뒤처리 (2026-09-05 Codex 리뷰 7).
 *
 * 예전에는 이력만 `interrupted` 로 바꾸고 끝이었다. 예약 레코드의 `lastStatus` 는 옛 값
 * 그대로였고 `failStreak` 도 오르지 않아, 밤새 워커가 죽어 한 번도 못 돈 예약이 아침
 * `schedules` 응답에서는 "마지막 실행 성공" 으로 보였다. 알림도 없었다.
 *
 * 바뀐 레코드마다 한 번씩만 부른다. 예약이 그 사이 바뀌었으면(generation 불일치)
 * 상태를 건드리지 않고 이력에 `superseded` 만 남긴다.
 */
async function applyInterruptedOutcome(record: RunRecord, now: number): Promise<void> {
  if (record.trigger !== 'scheduled') return;
  const current = await readSchedule(record.name);
  if (current === null || record.generation !== current.generation) {
    await safeWrite(() =>
      finishRunRecord(record.name, record.runId, { status: 'interrupted', superseded: true }),
    );
    return;
  }
  const failStreak = (current.failStreak ?? 0) + 1;
  const updated = await patchSchedule(
    record.name,
    {
      lastRunId: record.runId,
      lastStatus: 'interrupted',
      lastRunAt: now,
      failStreak,
    },
    { generation: current.generation },
  );
  if (updated === null) return;
  await notifyFailure(
    updated,
    'interrupted',
    'interrupted',
    record.failedStep ? record.failedStep.index : null,
    failStreak,
  );
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
    // 살아 있는 남의 lease 는 죽은 실행이 아니다. 그 runId 와 버킷은 건드리지 않는다.
    const lock = await readRunLock();
    const foreignAlive =
      lock !== null && lock.owner !== OWNER_TOKEN && lockIsAlive(lock, now) ? lock : null;

    const interrupted = await markRunningAsInterrupted(
      now,
      foreignAlive ? [foreignAlive.runId] : [],
    );
    await releaseStaleRunLock(now);
    await cleanupOrphanScheduledTabs(foreignAlive ? scheduledSessionKey(foreignAlive.name) : null);
    for (const record of interrupted) {
      await applyInterruptedOutcome(record, now);
    }

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
        // CAS: 그 사이 사용자가 예약을 새로 걸었으면 이 갱신은 버린다.
        const updated = await patchSchedule(
          name,
          {
            ...(recomputed !== null ? { nextAt: recomputed } : {}),
            timeZone: signature.timeZone,
            offsetMinutes: signature.offsetMinutes,
          },
          { generation: record.generation },
        );
        if (updated === null) continue;
        record = updated;
        await armScheduleAlarm(name, record.nextAt);
      }

      if (record.nextAt <= now) {
        // 따라잡기는 1회다. 놓친 8회를 몰아서 돌리면 아침 크롬을 13분 점유한다.
        enqueueScheduledRun(name, record.nextAt, now);
        const nextAt = computeNextAt(record, now);
        if (nextAt !== null) {
          // 알람은 저장에 성공한 레코드에서만 건다 (저장 값과 알람이 어긋나지 않게).
          const updated = await patchSchedule(name, { nextAt }, { generation: record.generation });
          if (updated !== null) await armScheduleAlarm(name, updated.nextAt);
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
async function cleanupOrphanScheduledTabs(leasedSessionKey: string | null = null): Promise<void> {
  let keys: string[] = [];
  try {
    keys = await listSessionKeysWithPrefix(`${SCHEDULED_SESSION_ID}::`);
  } catch {
    return;
  }
  for (const key of keys) {
    if (activeSessionKeys.has(key)) continue;
    // 다른 워커가 지금 쓰고 있는 버킷이다. 그 실행의 탭을 뺏으면 곧바로 실패한다.
    if (leasedSessionKey !== null && key === leasedSessionKey) continue;
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
  currentLockNonce = null;
  resetSpawnScopes();
  draining = false;
  reconciling = false;
}
