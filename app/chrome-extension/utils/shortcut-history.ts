/**
 * auto-chrome-mcp fork: chrome_shortcut 실행 이력.
 *
 * 설계 계약: docs/plans/2026-09-05-daily-automation-design.md 4절 (구현 순서 1단계).
 *
 * 왜 필요한가: 예약 실행은 Claude 가 없을 때 밤새 혼자 돈다. 결과를 어딘가에 남겨 두지
 * 않으면 아침에 무엇이 성공하고 무엇이 실패했는지 알 길이 없다. 수동 `run` 도 같은 곳에
 * 남겨야 "이 shortcut 이 원래 되던 것인지" 를 한 목록에서 비교할 수 있다.
 *
 * 이 모듈의 규칙:
 *   - 저장소 키는 `mcpShortcutHistory` 하나. `{ [name]: RunRecord[] }`, 최신이 앞이다.
 *   - **모든 쓰기는 하나의 직렬 큐**를 지난다. manual `run` 종료와 예약 종료가 같은 키를
 *     동시에 read-modify-write 하면 한쪽이 통째로 사라진다.
 *   - 실행 시작 시 `status: "running"` 레코드를 먼저 쓰고 같은 `runId` 로 덮어쓴다.
 *     종료 처리를 못 한 실행은 워커가 다시 평가될 때 `interrupted` 로 바뀐다.
 *   - 저장 직전에 secret 을 가린다(원문과 JSON escaped 형태 둘 다). 비밀번호가 이력에
 *     남으면 저장소 덤프가 곧 유출이다.
 *   - 상한 셋(shortcut 당 100건, 전체 1,000건, 전체 3MiB) 중 하나라도 넘으면 전체에서
 *     가장 오래된 레코드부터 지운다. 용량 초과 오류일 때만 가장 오래된 1건씩 최대 3회
 *     지우고 다시 시도한다(다른 오류는 그대로 던진다).
 *     `chrome.storage.local` 은 `unlimitedStorage` 없이 10MB 이고 shortcut·userscript
 *     저장소와 그 공간을 나눠 쓴다.
 */

/**
 * 다음 단계(예약 실행)가 쓸 접점 - 여기 말고 다른 곳에 이력 쓰기 경로를 만들지 말 것:
 *
 *   startRunRecord({ runId, name, trigger: 'scheduled', startedAt, revision, secrets })
 *     실행 직전에 `running` 레코드를 남긴다. 예약의 `runId` 는 `<name>:<dueAtISO>` 라
 *     알람과 reconcile 이 같은 due 를 집어도 이력이 1건이다.
 *   classifyRunOutcome(outcome, { loginCheckAs })
 *     `runSteps` 결과를 status·errorCode·failedStep 으로 옮긴다. 수동 실행과 같은 규칙.
 *   buildHistoryResults(outcome.returned)
 *     `results` 를 상한에 맞춰 줄인다. 러너가 이미 뺀 이름(`outcome.resultsTruncated`)과
 *     합쳐 레코드의 `resultsTruncated` 에 넣는다.
 *   finishRunRecord(name, runId, patch, secrets)
 *     같은 `runId` 를 최종 상태로 덮어쓴다. `screenshot`·`report`·`warnings`·`superseded` 도
 *     이 patch 로 넣는다.
 *   markRunningAsInterrupted()
 *     `reconcile()` 이 부른다. `running` 으로 남은 레코드를 `interrupted` 로 바꾼다.
 *
 * 실행 컨텍스트 모드 전달 경로는 batch-runner 의 `RunStepsOptions.forceBackground` 에서
 * 시작한다. 예약 러너는 `runSteps({ mcpSessionId: 'scheduled', lane: name,
 * forceBackground: true, beforeStep, taskTitle: name })` 로 부르면 된다.
 */

export const HISTORY_STORAGE_KEY = 'mcpShortcutHistory';

/** shortcut 하나가 보관하는 최대 이력 수. */
export const MAX_RECORDS_PER_SHORTCUT = 100;
/** 전체 이력 수 상한. */
export const MAX_RECORDS_TOTAL = 1_000;
/** 전체 payload 의 UTF-8 byte 상한 (3MiB). */
export const MAX_HISTORY_BYTES = 3 * 1024 * 1024;

/** `results` 항목 하나의 상한 (batch 의 return 과 같은 값). */
export const MAX_RESULT_ITEM_CHARS = 8_000;
/** `results` 전체 상한. */
export const MAX_RESULT_TOTAL_CHARS = 24_000;

/** `history` 목록 조회 기본 개수와 상한. */
export const DEFAULT_HISTORY_LIMIT = 20;
export const MAX_HISTORY_LIMIT = 100;

/**
 * 실행이 끝난 상태 8종 (설계 4절 확정 enum).
 *   stopped        `stopIf` 로 정상 조기 종료
 *   timeout        벽시계 상한 초과
 *   interrupted    실행 중 워커나 크롬이 죽었다
 *   skipped_queue  큐 대기 상한을 넘겨 실행하지 않았다
 *   login_required 예약 옵션 `loginCheck` 가 가리키는 `stopIf` 로 멈췄다
 *   user_took_over_tab 사용자가 작업 탭을 활성화해 중단했다
 */
export const FINAL_RUN_STATUSES = [
  'success',
  'failed',
  'stopped',
  'timeout',
  'interrupted',
  'skipped_queue',
  'login_required',
  'user_took_over_tab',
] as const;

export type FinalRunStatus = (typeof FINAL_RUN_STATUSES)[number];
/** 저장된 레코드가 가질 수 있는 상태 (진행 중 포함). */
export type RunStatus = FinalRunStatus | 'running';

export const RUN_STATUSES: readonly RunStatus[] = ['running', ...FINAL_RUN_STATUSES];

export type RunTrigger = 'manual' | 'scheduled';

export interface FailedStep {
  /** 0-based 선언 step 인덱스. 흐름 실행은 실패한 로그 항목의 순번이다. */
  index: number;
  tool: string;
  /**
   * 흐름 실행에서 실패한 노드 id (2026-09-05 사이드패널 2단계 D).
   * 단축 실행에는 없다 - 단축의 단위는 도구 호출이라 `tool` 로 충분하다.
   */
  stepId?: string;
}

export interface RunRecord {
  runId: string;
  /**
   * 이력 저장소의 키.
   *
   * 예약 실행은 `scheduleId`(`shortcut:<enc>` / `flow:<enc>`)이고, `chrome_shortcut` 의
   * 수동 실행은 예전 그대로 단축 이름이다. 두 공간이 겹치지 않도록 예약 쪽에만 접두가
   * 붙는다 (2026-09-05 Codex 설계 검토 1).
   */
  name: string;
  /** 화면에 보여 줄 이름. 예약이 지워진 뒤에도 이력을 읽을 수 있게 남기는 스냅샷이다. */
  label?: string;
  trigger: RunTrigger;
  status: RunStatus;
  startedAt: number;
  endedAt?: number | null;
  durationMs?: number | null;
  failedStep?: FailedStep | null;
  errorCode?: string | null;
  error?: string | null;
  stoppedBy?: unknown;
  results?: Record<string, unknown>;
  resultsTruncated?: string[];
  /** 실패 스크린샷 경로 (다운로드 폴더 기준). */
  screenshot?: string | null;
  /** 보고서 파일 경로 (예약 실행의 `report: true` 전용). */
  report?: string | null;
  warnings?: string[];
  /** 예약 레코드의 revision. 실행 중 예약이 바뀌었는지 판정한다. */
  revision?: number;
  /**
   * 시작할 때 본 예약 레코드의 `generation` (저장소 전역 단조 값). revision 은 예약을
   * 지웠다 다시 걸면 같은 값으로 돌아올 수 있어(ABA) 이 값으로 함께 판정한다.
   */
  generation?: number;
  /** 실행 중 예약이 바뀌어 재무장·상태 갱신을 건너뛴 실행. */
  superseded?: boolean;
}

/** `history` 목록 응답에 싣는 요약. `results` 본문은 절대 싣지 않는다. */
export interface RunSummary {
  runId: string;
  name: string;
  label?: string;
  trigger: RunTrigger;
  status: RunStatus;
  startedAt: number;
  durationMs?: number | null;
  failedStep?: FailedStep | null;
  errorCode?: string | null;
  resultsChars: number;
  screenshot?: string | null;
  report?: string | null;
}

export type HistoryMap = Record<string, RunRecord[]>;

/* ------------------------------------------------------------------ *
 * 순수 함수 (크롬 API 의존 없음)
 * ------------------------------------------------------------------ */

const encoder = new TextEncoder();

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).length;
}

/** 이 payload 를 저장하면 몇 byte 인가. */
export function historyByteSize(map: HistoryMap): number {
  try {
    return utf8ByteLength(JSON.stringify(map) ?? '');
  } catch {
    return 0;
  }
}

/**
 * 오류 문구에서 코드를 뽑는다. 확장의 오류는 `unresolved_reference: ...` 처럼 코드형
 * 접두를 쓴다. 접두가 없으면 `tool_error` 다 - 번호 없는 문구를 그대로 코드로 쓰면
 * 아침에 상태별로 묶을 수가 없다.
 */
export function errorCodeFrom(error: unknown): string | null {
  if (typeof error !== 'string') return null;
  const trimmed = error.trim();
  if (!trimmed) return null;
  const head = trimmed.split(':', 1)[0]?.trim() ?? '';
  return /^[a-z][a-z0-9_]*$/.test(head) ? head : 'tool_error';
}

/**
 * 응답 문자열에서 비밀값을 가린다. JSON 으로 escape 된 형태까지 함께 지운다.
 * 길이와 무관하게 항상 가리는 것이 설계 3절 규칙이다.
 */
export function maskSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    const variants = new Set<string>([secret, JSON.stringify(secret).slice(1, -1)]);
    for (const variant of variants) {
      if (variant.length === 0) continue;
      out = out.split(variant).join('***');
    }
  }
  return out;
}

/** 레코드 안의 **모든 문자열**에서 비밀값을 가린다 (키 이름도 포함). */
export function maskRecordSecrets<T>(value: T, secrets: readonly string[]): T {
  if (!Array.isArray(secrets) || secrets.length === 0) return value;
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return maskSecrets(node, secrets);
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(node as Record<string, unknown>)) {
        out[maskSecrets(key, secrets)] = walk((node as Record<string, unknown>)[key]);
      }
      return out;
    }
    return node;
  };
  return walk(value) as T;
}

/**
 * `return` 으로 받은 값을 이력에 담을 형태로 줄인다. 항목당 8,000자, 전체 24,000자.
 * 넘는 항목은 **자르지 않고 통째로 뺀다** - 잘린 JSON 은 파싱이 안 되어 쓸모가 없다.
 */
export function buildHistoryResults(returned: Record<string, unknown> | undefined): {
  results: Record<string, unknown>;
  truncated: string[];
  chars: number;
} {
  const results: Record<string, unknown> = {};
  const truncated: string[] = [];
  let total = 0;
  if (!returned || typeof returned !== 'object') return { results, truncated, chars: 0 };

  for (const name of Object.keys(returned)) {
    let serialized: string;
    try {
      serialized = JSON.stringify(returned[name]) ?? '';
    } catch {
      truncated.push(name);
      continue;
    }
    if (
      serialized.length > MAX_RESULT_ITEM_CHARS ||
      total + serialized.length > MAX_RESULT_TOTAL_CHARS
    ) {
      truncated.push(name);
      continue;
    }
    total += serialized.length;
    results[name] = returned[name];
  }
  return { results, truncated, chars: total };
}

/** 레코드의 `results` 가 차지하는 문자 수 (요약의 `resultsChars`). */
export function resultsCharsOf(record: RunRecord): number {
  if (!record.results) return 0;
  try {
    return (JSON.stringify(record.results) ?? '').length;
  } catch {
    return 0;
  }
}

/** 목록 응답용 요약. `results` 본문은 싣지 않는다 (밤새 30건이면 컨텍스트를 밀어낸다). */
export function summarizeRecord(record: RunRecord): RunSummary {
  const summary: RunSummary = {
    runId: record.runId,
    name: record.name,
    trigger: record.trigger,
    status: record.status,
    startedAt: record.startedAt,
    resultsChars: resultsCharsOf(record),
  };
  if (record.label !== undefined) summary.label = record.label;
  if (record.durationMs !== undefined) summary.durationMs = record.durationMs;
  if (record.failedStep !== undefined) summary.failedStep = record.failedStep;
  if (record.errorCode !== undefined) summary.errorCode = record.errorCode;
  if (record.screenshot !== undefined) summary.screenshot = record.screenshot;
  if (record.report !== undefined) summary.report = record.report;
  return summary;
}

interface FlatRecord {
  name: string;
  index: number;
  record: RunRecord;
}

/** 모든 shortcut 의 레코드를 최신순으로 편다. */
export function flattenHistory(map: HistoryMap): FlatRecord[] {
  const flat: FlatRecord[] = [];
  for (const name of Object.keys(map)) {
    const list = Array.isArray(map[name]) ? map[name] : [];
    list.forEach((record, index) => {
      if (record && typeof record === 'object') flat.push({ name, index, record });
    });
  }
  flat.sort((a, b) => (b.record.startedAt ?? 0) - (a.record.startedAt ?? 0));
  return flat;
}

/**
 * 상한 셋을 지키도록 오래된 레코드부터 지운다.
 * shortcut 당 개수를 먼저 맞추고, 그 다음 전체 개수, 마지막으로 byte 를 맞춘다.
 */
export function pruneHistory(
  map: HistoryMap,
  limits: { perShortcut?: number; total?: number; bytes?: number } = {},
): HistoryMap {
  const perShortcut = limits.perShortcut ?? MAX_RECORDS_PER_SHORTCUT;
  const total = limits.total ?? MAX_RECORDS_TOTAL;
  const bytes = limits.bytes ?? MAX_HISTORY_BYTES;

  const out: HistoryMap = {};
  for (const name of Object.keys(map)) {
    const list = (Array.isArray(map[name]) ? map[name] : []).filter(
      (record) => record && typeof record === 'object',
    );
    // 최신이 앞이라는 불변식을 여기서 한 번 강제한다 (저장 경로가 하나라도 어긋나면 바로 드러난다).
    list.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    if (list.length > 0) out[name] = list.slice(0, perShortcut);
  }

  const dropOldest = (): boolean => {
    let oldest: { name: string; startedAt: number } | null = null;
    for (const name of Object.keys(out)) {
      const list = out[name];
      const last = list[list.length - 1];
      if (!last) continue;
      const startedAt = last.startedAt ?? 0;
      if (oldest === null || startedAt < oldest.startedAt) oldest = { name, startedAt };
    }
    if (oldest === null) return false;
    out[oldest.name].pop();
    if (out[oldest.name].length === 0) delete out[oldest.name];
    return true;
  };

  let count = Object.values(out).reduce((sum, list) => sum + list.length, 0);
  while (count > total && dropOldest()) count -= 1;
  while (count > 0 && historyByteSize(out) > bytes && dropOldest()) count -= 1;

  return out;
}

export interface HistoryQuery {
  name?: string;
  runId?: string;
  limit?: number;
  /** ISO 문자열 또는 epoch ms. 이 시각보다 앞선 기록은 뺀다. */
  since?: string | number;
  status?: string | string[];
}

/** `since` 를 epoch ms 로 바꾼다. 해석할 수 없으면 null (필터를 걸지 않는다). */
export function parseSince(since: unknown): number | null {
  if (typeof since === 'number' && Number.isFinite(since)) return since;
  if (typeof since !== 'string' || !since.trim()) return null;
  const parsed = Date.parse(since.trim());
  return Number.isNaN(parsed) ? null : parsed;
}

/** `limit` 을 1~100 으로 맞춘다. */
export function normalizeLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_HISTORY_LIMIT;
  const rounded = Math.floor(limit);
  if (rounded < 1) return 1;
  return Math.min(rounded, MAX_HISTORY_LIMIT);
}

/** 조회 필터를 적용해 요약 목록을 만든다 (순수 함수 - 저장소를 읽지 않는다). */
export function selectHistory(
  map: HistoryMap,
  query: HistoryQuery,
): { summaries: RunSummary[]; matched: number } {
  const since = parseSince(query.since);
  const statuses = Array.isArray(query.status)
    ? query.status.filter((s): s is string => typeof s === 'string')
    : typeof query.status === 'string'
      ? [query.status]
      : [];

  const scoped: HistoryMap =
    typeof query.name === 'string' && query.name
      ? { [query.name]: Array.isArray(map[query.name]) ? map[query.name] : [] }
      : map;

  const flat = flattenHistory(scoped).filter(({ record }) => {
    if (since !== null && (record.startedAt ?? 0) < since) return false;
    if (statuses.length > 0 && !statuses.includes(record.status)) return false;
    return true;
  });

  const summaries = flat
    .slice(0, normalizeLimit(query.limit))
    .map(({ record }) => summarizeRecord(record));
  return { summaries, matched: flat.length };
}

/** `runId` 하나로 레코드 전체를 찾는다. */
export function findRecordById(map: HistoryMap, runId: string, name?: string): RunRecord | null {
  const scoped: HistoryMap =
    typeof name === 'string' && name ? { [name]: Array.isArray(map[name]) ? map[name] : [] } : map;
  for (const { record } of flattenHistory(scoped)) {
    if (record.runId === runId) return record;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 실행 결과 -> 이력 레코드 (수동 실행과 예약 실행이 같은 규칙을 쓴다)
 * ------------------------------------------------------------------ */

/** 이력에서 결과를 판정할 때 필요한 만큼만 추린 `runSteps` 결과. */
export interface RunOutcomeLike {
  success: boolean;
  results?: Array<{
    index: number;
    tool: string;
    ok: boolean;
    status?: string;
    error?: string;
    as?: string;
  }>;
  stoppedAtStep?: number;
  stoppedBy?: { step: number; reason: string };
  aborted?: { reason: string; message: string };
}

export interface ClassifyOptions {
  /**
   * 예약 옵션 `loginCheck` 가 가리키는 top-level step 의 `as` 이름. 그 이름의 step 이
   * `stopIf` 로 멈췄으면 `stopped` 가 아니라 `login_required` 다 (설계 3절).
   */
  loginCheckAs?: string;
}

export interface RunClassification {
  status: FinalRunStatus;
  errorCode: string | null;
  error: string | null;
  failedStep: FailedStep | null;
}

/**
 * `runSteps` 결과를 이력 status 로 옮긴다. 수동 `run` 과 예약 실행이 같은 함수를 쓴다 -
 * 두 경로가 서로 다른 규칙으로 판정하면 아침에 목록을 한 줄로 읽을 수 없다.
 *
 * 규칙(설계 4절):
 *   - `aborted` 훅으로 끊긴 실행은 그 사유가 곧 status 다(예: user_took_over_tab).
 *   - `total_runs_exceeded` 는 `timeout` 이 아니라 `failed` + errorCode 다.
 *   - `stopIf` 는 정상 조기 종료라 `stopped` 이며, `loginCheck` 이름일 때만 login_required.
 *   - 실패 step 은 첫 번째 `ok:false` 항목이다(`stoppedAtStep` 은 그 인덱스를 가리킨다).
 */
export function classifyRunOutcome(
  outcome: RunOutcomeLike,
  options: ClassifyOptions = {},
): RunClassification {
  const steps = Array.isArray(outcome.results) ? outcome.results : [];
  const failing = steps.find((step) => step && step.ok === false && step.status !== 'skipped');
  const failedStep: FailedStep | null = failing
    ? { index: failing.index, tool: failing.tool }
    : null;
  const error = typeof failing?.error === 'string' ? failing.error : null;

  if (outcome.aborted) {
    const reason = outcome.aborted.reason;
    const status = (FINAL_RUN_STATUSES as readonly string[]).includes(reason)
      ? (reason as FinalRunStatus)
      : 'stopped';
    return { status, errorCode: reason, error: outcome.aborted.message ?? null, failedStep };
  }

  const stopReason = outcome.stoppedBy?.reason;

  if (stopReason === 'total_runs_exceeded') {
    return { status: 'failed', errorCode: 'total_runs_exceeded', error, failedStep };
  }
  if (stopReason === 'timeout') {
    return { status: 'timeout', errorCode: 'timeout', error, failedStep };
  }
  if (stopReason === 'stopIf') {
    const stoppedAs = steps.find((step) => step?.index === outcome.stoppedBy?.step)?.as;
    if (
      typeof options.loginCheckAs === 'string' &&
      options.loginCheckAs.length > 0 &&
      stoppedAs === options.loginCheckAs
    ) {
      return { status: 'login_required', errorCode: 'login_required', error: null, failedStep };
    }
    return { status: 'stopped', errorCode: null, error: null, failedStep };
  }

  if (outcome.success === false || failedStep !== null) {
    return { status: 'failed', errorCode: errorCodeFrom(error), error, failedStep };
  }
  return { status: 'success', errorCode: null, error: null, failedStep: null };
}

/**
 * 수동 실행의 `runId`. 예약 실행은 `<name>:<dueAtISO>` 라 같은 due 를 두 경로가 집어도
 * 이력이 1건이지만, 수동 실행에는 그런 격자가 없으므로 시각에 임의 접미를 붙여 겹치지
 * 않게 한다.
 */
export function manualRunId(name: string, now: number = Date.now()): string {
  const stamp = new Date(now).toISOString();
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${name}:manual:${stamp}-${suffix}`;
}

/* ------------------------------------------------------------------ *
 * writer queue (모든 읽기·쓰기가 이 한 줄을 지난다)
 * ------------------------------------------------------------------ */

let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * 이력 변경을 한 줄로 세운다. 예전 work-tab-manager 에서 같은 실수를 했다 - 두 경로가
 * 각자 read-modify-write 하면 마지막 write 만 남아 한쪽 기록이 조용히 사라진다.
 */
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(fn, fn);
  // 큐는 실패로 멈추지 않는다 - 한 번의 예외가 이후 모든 기록을 영영 막으면 안 된다.
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 이 워커에서 **지금 돌고 있는** run 들. `markRunningAsInterrupted()` 가 이들을 건드리지
 * 않게 하려고 둔다 - reconcile 은 알람·메시지 등 어떤 이벤트로도 돌 수 있어서, 같은 워커에
 * 살아 있는 실행을 "죽었다" 고 판정하면 이력이 뒤집힌다. 워커가 죽으면 이 집합도 함께
 * 사라지므로, 다음 평가에서는 그 run 이 정상적으로 `interrupted` 가 된다.
 */
const activeRunIds = new Set<string>();

/** 이 워커에서 실행 중이라고 표시한다 (`startRunRecord` 가 자동으로 부른다). */
export function markRunActive(runId: string): void {
  if (typeof runId === 'string' && runId.length > 0) activeRunIds.add(runId);
}

/** 표시를 지운다 (`finishRunRecord` 가 자동으로 부른다). */
export function clearRunActive(runId: string): void {
  activeRunIds.delete(runId);
}

/** 테스트·진단용 - 지금 이 워커가 돌고 있다고 보는 run 수. */
export function activeRunCount(): number {
  return activeRunIds.size;
}

async function loadHistoryMap(): Promise<HistoryMap> {
  try {
    const result = await chrome.storage.local.get([HISTORY_STORAGE_KEY]);
    const raw = (result as any)?.[HISTORY_STORAGE_KEY];
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as HistoryMap) : {};
  } catch {
    return {};
  }
}

/** 저장 실패가 용량 초과인가. 이 판정이 맞을 때만 기록을 지운다. */
export function isQuotaExceededError(error: unknown): boolean {
  const text =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? `${error.name} ${error.message}`
        : typeof (error as any)?.message === 'string'
          ? (error as any).message
          : '';
  return /quota|QUOTA_BYTES|exceed|storage is full|too (?:large|big)/i.test(text);
}

/**
 * 전체에서 가장 오래된 레코드 하나만 지운 사본. 지울 것이 없으면 null.
 * `protectRunId` 는 지금 쓰고 있는 레코드다 - 그것을 지우면 저장하는 의미가 없다.
 */
export function dropOldestRecord(map: HistoryMap, protectRunId?: string): HistoryMap | null {
  let oldest: { name: string; index: number; startedAt: number } | null = null;
  for (const name of Object.keys(map)) {
    const list = Array.isArray(map[name]) ? map[name] : [];
    for (let index = 0; index < list.length; index++) {
      if (protectRunId !== undefined && list[index]?.runId === protectRunId) continue;
      const startedAt = list[index]?.startedAt ?? 0;
      if (oldest === null || startedAt < oldest.startedAt) oldest = { name, index, startedAt };
    }
  }
  if (oldest === null) return null;
  const out: HistoryMap = {};
  for (const name of Object.keys(map)) out[name] = [...(map[name] ?? [])];
  out[oldest.name].splice(oldest.index, 1);
  if (out[oldest.name].length === 0) delete out[oldest.name];
  return out;
}

/** quota 오류로 재시도하는 최대 횟수 (매번 가장 오래된 1건만 지운다). */
export const QUOTA_RETRY_LIMIT = 3;

/**
 * 상한을 맞춰 저장한다.
 *
 * 2026-09-05 Codex 리뷰 9: 예전에는 `set` 이 **어떤 이유로 실패하든** 보관량을 절반으로
 * 잘라 다시 썼다. 확장 컨텍스트 무효화·직렬화 실패처럼 용량과 무관한 오류에도 밤새 쌓인
 * 이력의 절반이 사라졌다. 이제 용량 초과로 보일 때만, 가장 오래된 1건씩 최대 3회 지운다.
 * 용량 문제가 아니면 그대로 던진다 - 조용히 삼키면 아침에 "왜 기록이 없지" 가 된다.
 */
async function persistHistoryMap(map: HistoryMap, protectRunId?: string): Promise<void> {
  let payload = pruneHistory(map);
  for (let attempt = 0; ; attempt++) {
    try {
      await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: payload });
      return;
    } catch (error) {
      if (!isQuotaExceededError(error) || attempt >= QUOTA_RETRY_LIMIT) throw error;
      const smaller = dropOldestRecord(payload, protectRunId);
      if (smaller === null) throw error;
      console.warn(
        `[shortcut-history] 저장소 용량 초과, 가장 오래된 기록 1건을 지우고 다시 시도합니다 (${
          attempt + 1
        }/${QUOTA_RETRY_LIMIT}):`,
        error,
      );
      payload = smaller;
    }
  }
}

/** 저장된 이력 전체 (읽기도 큐를 지나 쓰기와 순서가 어긋나지 않게 한다). */
export async function readHistory(): Promise<HistoryMap> {
  return await enqueue(loadHistoryMap);
}

export interface StartRunInput {
  runId: string;
  name: string;
  /** 표시용 이름 (예약 실행만 싣는다). */
  label?: string;
  trigger: RunTrigger;
  startedAt?: number;
  revision?: number;
  /** 예약 레코드의 저장소 전역 단조 값 (예약 실행만 싣는다). */
  generation?: number;
  secrets?: readonly string[];
}

/**
 * 실행 시작을 기록한다 (`status: "running"`). 종료 시 같은 `runId` 로 덮어쓴다.
 * 시작 기록이 없으면 워커가 죽었을 때 "돌다 만 실행" 을 알아볼 방법이 없다.
 */
export async function startRunRecord(input: StartRunInput): Promise<RunRecord> {
  const record: RunRecord = {
    runId: input.runId,
    name: input.name,
    trigger: input.trigger,
    status: 'running',
    startedAt: input.startedAt ?? Date.now(),
  };
  if (input.label !== undefined) record.label = input.label;
  if (input.revision !== undefined) record.revision = input.revision;
  if (input.generation !== undefined) record.generation = input.generation;

  const masked = maskRecordSecrets(record, input.secrets ?? []);
  markRunActive(masked.runId);
  await enqueue(async () => {
    const map = await loadHistoryMap();
    const list = Array.isArray(map[masked.name]) ? [...map[masked.name]] : [];
    map[masked.name] = [masked, ...list.filter((r) => r?.runId !== masked.runId)];
    await persistHistoryMap(map, masked.runId);
  });
  return masked;
}

export type RunRecordPatch = Omit<Partial<RunRecord>, 'runId' | 'name'> & { status: RunStatus };

/**
 * 같은 `runId` 의 레코드를 최종 상태로 덮어쓴다. 시작 기록이 없으면(워커 교체 등) 새로
 * 만든다 - 결과를 잃는 것보다 시작 시각이 부정확한 편이 낫다.
 */
export async function finishRunRecord(
  name: string,
  runId: string,
  patch: RunRecordPatch,
  secrets: readonly string[] = [],
): Promise<RunRecord> {
  const maskedPatch = maskRecordSecrets(patch, secrets);
  clearRunActive(runId);
  return await enqueue(async () => {
    const map = await loadHistoryMap();
    const list = Array.isArray(map[name]) ? [...map[name]] : [];
    const index = list.findIndex((record) => record?.runId === runId);
    const base: RunRecord =
      index >= 0
        ? list[index]
        : {
            runId,
            name,
            trigger: 'manual',
            status: 'running',
            startedAt: maskedPatch.startedAt ?? Date.now(),
          };

    const merged: RunRecord = { ...base, ...maskedPatch, runId, name };
    if (merged.endedAt && merged.startedAt && merged.durationMs === undefined) {
      merged.durationMs = merged.endedAt - merged.startedAt;
    }

    if (index >= 0) list[index] = merged;
    else list.unshift(merged);
    map[name] = list;
    await persistHistoryMap(map, runId);
    return merged;
  });
}

/**
 * 워커가 다시 평가될 때 부른다: `running` 으로 남은 레코드를 `interrupted` 로 바꾼다.
 * 다음 단계의 `reconcile()` 이 이 함수를 호출한다. 바뀐 레코드 수를 돌려준다.
 *
 * 종료 처리를 못 한 실행이 영원히 "실행 중" 으로 남으면 아침에 판단할 수 없고, 예약
 * 재실행의 이중 실행 방지(`runId` claim)도 흔들린다.
 */
export async function markRunningAsInterrupted(
  now: number = Date.now(),
  protectedRunIds: readonly string[] = [],
): Promise<RunRecord[]> {
  const protectedSet = new Set(protectedRunIds);
  return await enqueue(async () => {
    const map = await loadHistoryMap();
    const changed: RunRecord[] = [];
    for (const name of Object.keys(map)) {
      const list = Array.isArray(map[name]) ? map[name] : [];
      map[name] = list.map((record) => {
        if (!record || record.status !== 'running') return record;
        // 이 워커가 지금 돌리고 있는 실행은 죽은 것이 아니다.
        if (activeRunIds.has(record.runId)) return record;
        // 다른 워커가 잠금을 쥐고 하트비트를 갱신 중인 실행도 살아 있다 (리뷰 4).
        if (protectedSet.has(record.runId)) return record;
        const updated: RunRecord = {
          ...record,
          status: 'interrupted',
          endedAt: now,
          durationMs: now - (record.startedAt ?? now),
          errorCode: 'interrupted',
        };
        changed.push(updated);
        return updated;
      });
    }
    if (changed.length > 0) await persistHistoryMap(map);
    return changed;
  });
}

/** 테스트·정리용 - 이력을 통째로 비운다. */
export async function clearHistory(): Promise<void> {
  await enqueue(async () => {
    await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: {} });
  });
}
