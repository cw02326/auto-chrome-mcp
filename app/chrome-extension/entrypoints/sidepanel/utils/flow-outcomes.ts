/**
 * 흐름별 마지막 결과 합치기 (2026-09-05 사이드패널 2단계 E, Codex 리뷰 1항).
 *
 * 카드의 "마지막 성공" 배지와 "최근 실패" 필터는 두 곳의 이력을 함께 봐야 한다.
 *   - 수동 실행: 흐름 저장소(`RR_LIST_RUNS`). 사용자가 카드에서 누른 실행.
 *   - 예약 실행: 예약 이력(`DAILY_HISTORY`). 밤새 혼자 돈 실행.
 * 수동 이력만 보면 "예약이 어제 성공했다" 를 카드가 모른다. 반대로 예약 이력만 보면 방금
 * 손으로 돌린 결과가 안 보인다. 그래서 둘을 시각순으로 합친다.
 *
 * 예약을 지워도 이력은 남으므로, 이 합치기는 예약 목록이 아니라 **이력**을 재료로 쓴다.
 *
 * 크롬 API 를 부르지 않는 순수 함수만 둔다.
 */

/** 한 번의 실행이 흐름에 남긴 결과. */
export interface FlowRunOutcome {
  flowId: string;
  /** 끝난 시각(epoch ms). 끝난 시각이 없으면 시작 시각을 쓴다. */
  at: number;
  outcome: 'success' | 'failure' | 'neutral';
}

/** 수동 실행 이력 한 건 (`useWorkflowsV3` 의 `RunLite` 중 여기서 쓰는 부분). */
export interface ManualRunLike {
  flowId: string;
  startedAt?: string;
  finishedAt?: string;
  isInProgress?: boolean;
  status?: string;
}

/** 예약 실행 이력 한 건 (`DAILY_HISTORY` 응답 중 여기서 쓰는 부분). */
export interface ScheduledRunLike {
  /** 이력 저장소 키. 예약 실행은 `scheduleId` 와 같다. */
  name?: string;
  status?: string;
  startedAt?: number;
  endedAt?: number | null;
}

/**
 * 성패로 세지 않는 상태.
 *
 * `running` 은 아직 안 끝났고, `skipped_queue` 는 앞 실행이 밀려 아예 돌지 않았으며,
 * `stopped` 는 `stopIf` 로 제 발로 일찍 끝난 정상 종료다. 셋 다 "이 흐름이 실패했다" 도
 * "성공했다" 도 아니라서 배지·필터를 흔들지 않는다.
 */
const NEUTRAL_STATUSES: ReadonlySet<string> = new Set(['running', 'skipped_queue', 'stopped']);

/** 성공으로 세는 상태. 예약 이력은 `success`, 흐름 저장소는 `succeeded` 를 쓴다. */
const SUCCESS_STATUSES: ReadonlySet<string> = new Set(['success', 'succeeded']);

function classify(status: string | undefined): FlowRunOutcome['outcome'] {
  const value = String(status || '');
  if (SUCCESS_STATUSES.has(value)) return 'success';
  if (NEUTRAL_STATUSES.has(value)) return 'neutral';
  return 'failure';
}

function timeOf(...candidates: Array<string | number | null | undefined>): number {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
    if (typeof candidate === 'string' && candidate) {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

/** 수동 실행 이력을 결과 목록으로. */
export function manualRunOutcomes(runs: readonly ManualRunLike[]): FlowRunOutcome[] {
  const out: FlowRunOutcome[] = [];
  for (const run of runs) {
    if (!run?.flowId) continue;
    const at = timeOf(run.finishedAt, run.startedAt);
    if (at <= 0) continue;
    const outcome = run.isInProgress ? 'neutral' : classify(run.status);
    out.push({ flowId: run.flowId, at, outcome });
  }
  return out;
}

/**
 * 예약 실행 이력을 결과 목록으로.
 *
 * 이력 키는 `scheduleId` 라서 흐름 id 로 되돌려야 한다. 그 변환은 저장 형식을 아는 쪽
 * (`utils/shortcut-schedule.ts` 의 `parseScheduleId`)이 하고, 여기서는 함수로 받는다.
 * 단축 예약은 흐름이 없으므로 null 을 돌려주면 그대로 버린다.
 */
export function scheduledRunOutcomes(
  records: readonly ScheduledRunLike[],
  flowIdOf: (scheduleId: string) => string | null,
): FlowRunOutcome[] {
  const out: FlowRunOutcome[] = [];
  for (const record of records) {
    const key = String(record?.name || '');
    if (!key) continue;
    const flowId = flowIdOf(key);
    if (!flowId) continue;
    const at = timeOf(record.endedAt, record.startedAt);
    if (at <= 0) continue;
    out.push({ flowId, at, outcome: classify(record.status) });
  }
  return out;
}

export interface FlowOutcomeSummary {
  /** 흐름 id → 마지막으로 성공한 시각. */
  lastSuccessAt: Record<string, number>;
  /** 마지막으로 끝난 실행이 실패인 흐름. */
  failedFlowIds: Set<string>;
  /**
   * 흐름별 마지막으로 끝난 실행의 시각 (성공·실패 통틀어 가장 최근 것).
   * 카드의 "마지막 실행" 줄이 이걸로 성공이든 실패든 하나만 보여준다.
   */
  lastRunAt: Record<string, number>;
  /** 흐름별 마지막으로 끝난 실행의 결과. */
  lastRunOutcome: Record<string, 'success' | 'failure'>;
}

/**
 * 결과 목록을 흐름별로 접는다.
 *
 * 마지막 성공은 성공 중 가장 최근이고, "최근 실패" 는 **가장 최근에 끝난 실행**이 실패인
 * 경우다. 어제 실패하고 오늘 성공한 흐름이 계속 빨갛게 남지 않게 하려는 규칙이다.
 */
export function summarizeFlowOutcomes(outcomes: readonly FlowRunOutcome[]): FlowOutcomeSummary {
  const lastSuccessAt: Record<string, number> = {};
  const latest = new Map<string, { at: number; outcome: FlowRunOutcome['outcome'] }>();

  for (const item of outcomes) {
    if (item.outcome === 'neutral') continue;
    if (item.outcome === 'success') {
      if (!lastSuccessAt[item.flowId] || item.at > lastSuccessAt[item.flowId]) {
        lastSuccessAt[item.flowId] = item.at;
      }
    }
    const seen = latest.get(item.flowId);
    if (!seen || item.at > seen.at) latest.set(item.flowId, { at: item.at, outcome: item.outcome });
  }

  const failedFlowIds = new Set<string>();
  const lastRunAt: Record<string, number> = {};
  const lastRunOutcome: Record<string, 'success' | 'failure'> = {};
  for (const [flowId, info] of latest) {
    lastRunAt[flowId] = info.at;
    lastRunOutcome[flowId] = info.outcome;
    if (info.outcome === 'failure') failedFlowIds.add(flowId);
  }
  return { lastSuccessAt, failedFlowIds, lastRunAt, lastRunOutcome };
}

/** 두 이력을 한 번에 합치는 손잡이. 화면은 이것만 부른다. */
export function mergeFlowOutcomes(
  manual: readonly ManualRunLike[],
  scheduled: readonly ScheduledRunLike[],
  flowIdOf: (scheduleId: string) => string | null,
): FlowOutcomeSummary {
  return summarizeFlowOutcomes([
    ...manualRunOutcomes(manual),
    ...scheduledRunOutcomes(scheduled, flowIdOf),
  ]);
}
