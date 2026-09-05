/**
 * 예약 대상 검증과 예약 저장 (2026-09-06 사이드패널 3단계).
 *
 * 사이드패널(`daily-messages.ts` 의 `DAILY_PUT_SCHEDULE`)과 MCP 도구
 * (`chrome_shortcut action=schedule`)가 흐름을 예약하는 길이 둘로 갈렸다. 두 곳에서 각자
 * 검증하면 어느 한쪽만 고쳐지는 날이 오고, 그날 밤부터 "화면에서는 막히는데 도구로는
 * 걸리는" 예약이 생긴다. 그래서 판단은 이 파일 하나에 둔다.
 *
 * 여기 있는 것:
 *   - `checkFlowScheduleTarget` 흐름이 사람 없이 돌 수 있는지 본다. 거절 코드는
 *     `flow_not_published` / `flow_start_url_required` / `flow_has_sensitive_vars` /
 *     `flow_login_check_invalid` 이고 두 접점이 같은 코드를 돌려준다.
 *   - `commitSchedule` 시각 표현을 검증하고 레코드를 만들어 저장한 뒤 알람을 건다.
 *     대상이 단축이든 흐름이든 같은 자리를 지난다.
 *
 * 여기 없는 것: 단축 대상 검증. 그쪽은 저장된 단축(`loadShortcuts`)을 읽어야 하는데,
 * 이 파일이 그 모듈을 부르면 도구 레지스트리와 서로 물린다. 단축 검증은 부르는 쪽에
 * 남기고 이 파일은 검증을 마친 대상만 받는다.
 */

import { notifyDailyChanged } from '@/utils/daily-notify';
import {
  armScheduleAlarm,
  clearScheduleAlarm,
  computeNextAt,
  currentTimeZoneSignature,
  putSchedule,
  readSchedule,
  scheduleIdForFlow,
  validateScheduleExpression,
  type ScheduleRecord,
  type ScheduleTarget,
} from '@/utils/shortcut-schedule';
import { resolvePublishedFlow } from './record-replay/flow-store';

/** 검증을 마친 대상: 식별자·표시 이름·저장할 target. */
export interface ScheduleTargetOk {
  ok: true;
  scheduleId: string;
  label: string;
  target: ScheduleTarget;
}

export interface ScheduleTargetFail {
  ok: false;
  code: string;
  error: string;
}

export type ScheduleTargetCheck = ScheduleTargetOk | ScheduleTargetFail;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 흐름 단계 id 목록. DAG 노드가 정본이고, 노드가 없는 옛 흐름만 steps 를 본다. */
function flowStepIds(flow: {
  nodes?: Array<{ id?: unknown }>;
  steps?: Array<{ id?: unknown }>;
}): string[] {
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  const source = nodes.length > 0 ? nodes : Array.isArray(flow.steps) ? flow.steps : [];
  return source.map((node) => String(node?.id ?? '')).filter((id) => id.length > 0);
}

/**
 * 흐름 대상 검증. 예약은 사람이 보고 있지 않을 때 도니, 스스로 작업 탭을 열 수 없거나
 * 값을 물어봐야 하는 흐름은 밤에 실패만 쌓는다. 그래서 예약을 만드는 시점에 막는다.
 */
export async function checkFlowScheduleTarget(raw: {
  flowId?: unknown;
  args?: unknown;
  loginCheck?: unknown;
}): Promise<ScheduleTargetCheck> {
  const flowId = typeof raw.flowId === 'string' ? raw.flowId.trim() : '';
  if (!flowId) {
    return { ok: false, code: 'flow_id_required', error: 'flow_id_required: "flowId" is missing' };
  }

  const resolution = await resolvePublishedFlow(flowId);
  if (!resolution.ok) {
    return {
      ok: false,
      code: 'flow_not_published',
      error: `flow_not_published: 이 흐름을 먼저 발행해야 예약할 수 있습니다 (${flowId})`,
    };
  }
  const flow = resolution.flow;

  const startUrl = typeof flow.startUrl === 'string' ? flow.startUrl.trim() : '';
  if (!startUrl) {
    return {
      ok: false,
      code: 'flow_start_url_required',
      error:
        'flow_start_url_required: 시작 URL 이 없는 흐름은 예약할 수 없습니다. 예약 실행은 스스로 작업 탭을 열어야 합니다.',
    };
  }

  const sensitive = (flow.variables ?? []).filter((v) => v?.sensitive === true);
  if (sensitive.length > 0) {
    return {
      ok: false,
      code: 'flow_has_sensitive_vars',
      error: `flow_has_sensitive_vars: 민감 변수(${sensitive
        .map((v) => v.key)
        .join(', ')})는 예약에 저장하지 않습니다.`,
    };
  }

  // 흐름의 `loginCheck` 은 단축과 달리 **단계 id** 다 (실행 결과의 failedStep.stepId 와
  // 맞춰 본다). 없는 id 를 저장하면 로그인 만료를 영영 못 알아채므로 지금 확인한다.
  if (raw.loginCheck !== undefined) {
    const wanted = typeof raw.loginCheck === 'string' ? raw.loginCheck.trim() : '';
    if (!wanted) {
      return {
        ok: false,
        code: 'flow_login_check_invalid',
        error: 'flow_login_check_invalid: "loginCheck" must be a step id of this flow',
      };
    }
    const ids = flowStepIds(flow);
    if (!ids.includes(wanted)) {
      return {
        ok: false,
        code: 'flow_login_check_invalid',
        error: `flow_login_check_invalid: "${wanted}" is not a step id of this flow`,
      };
    }
  }

  // 민감 변수는 위에서 걸렀으므로 남은 값만 문자열로 굳혀 저장한다.
  const rawArgs = isPlainObject(raw.args) ? raw.args : undefined;
  const args: Record<string, string> | undefined = rawArgs
    ? Object.fromEntries(Object.entries(rawArgs).map(([k, v]) => [k, String(v ?? '')]))
    : undefined;

  return {
    ok: true,
    scheduleId: scheduleIdForFlow(flowId),
    label: String(flow.name || flowId),
    target: { kind: 'flow', flowId, ...(args ? { args } : {}) },
  };
}

export interface ScheduleCommitInput {
  /** `{ every }` 또는 `{ daily, days? }`. */
  schedule: unknown;
  /** 단축 예약의 파라미터 값. 흐름은 `target.args` 를 쓴다. */
  params?: Record<string, unknown>;
  notify: boolean;
  report: boolean;
  loginCheck?: string;
  enabled: boolean;
}

export type ScheduleCommitResult =
  | { ok: true; record: ScheduleRecord; replaced: boolean }
  | { ok: false; code: string; error: string };

/**
 * 예약 레코드를 만들어 저장하고 알람을 맞춘다.
 *
 * 검증을 마친 대상만 받는다. `every` 격자는 예약을 고쳐도 흔들리지 않게 기존
 * `anchorAt` 을 이어 쓰고, 꺼진 채로 저장하면 알람을 걸지 않는다.
 */
export async function commitSchedule(
  target: ScheduleTargetOk,
  input: ScheduleCommitInput,
): Promise<ScheduleCommitResult> {
  const expression = validateScheduleExpression(input.schedule);
  if (!expression.ok) {
    return { ok: false, code: 'schedule_invalid', error: expression.error };
  }

  const now = Date.now();
  const signature = currentTimeZoneSignature(now);
  const existing = await readSchedule(target.scheduleId);
  const draft: ScheduleRecord = {
    scheduleId: target.scheduleId,
    name: target.label,
    target: target.target,
    enabled: input.enabled,
    schedule: expression.parsed.schedule,
    ...(input.params && Object.keys(input.params).length > 0 ? { params: input.params } : {}),
    notify: input.notify,
    report: input.report,
    ...(input.loginCheck ? { loginCheck: input.loginCheck } : {}),
    nextAt: now,
    anchorAt: existing?.anchorAt ?? now,
    revision: 0,
    // 실제 값은 putSchedule 이 저장소 전역 카운터에서 받아 채운다.
    generation: 0,
    // putSchedule 이 기존 레코드의 createdAt 을 그대로 이어 준다.
    createdAt: now,
    updatedAt: now,
    timeZone: signature.timeZone,
    offsetMinutes: signature.offsetMinutes,
    failStreak: 0,
  };

  const nextAt = computeNextAt(draft, now);
  if (nextAt === null) {
    return {
      ok: false,
      code: 'schedule_invalid',
      error: 'schedule_invalid: 이 예약은 돌아오는 시각이 없습니다. 시각과 요일을 확인하세요.',
    };
  }
  draft.nextAt = nextAt;

  const saved = await putSchedule(draft, now);
  if (!saved.ok) return { ok: false, code: 'too_many_schedules', error: saved.error };

  if (saved.record.enabled === false) await clearScheduleAlarm(target.scheduleId);
  else await armScheduleAlarm(target.scheduleId, saved.record.nextAt);

  notifyDailyChanged();
  return { ok: true, record: saved.record, replaced: saved.replaced };
}
