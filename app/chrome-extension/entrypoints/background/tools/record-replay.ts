/**
 * record_replay_* MCP tools.
 *
 * Stage 2 of the run-tab work: these tools are exposed on the MCP surface again
 * (packages/shared TOOL_SCHEMAS), and the tab a flow may drive comes from the
 * work-tab gate rather than from the engine looking around the browser.
 *
 * Contract:
 *   - `record_replay_flow_run` is in TAB_ID_INJECT_TOOLS, so the gate injects
 *     this session/lane's work tab as `tabId` when the caller omits it. The
 *     engine has no active-tab fallback, so nothing here may borrow the tab the
 *     user is on.
 *   - With no work tab the call is not refused outright any more (2026-09-05
 *     side panel stage 1, part B): a recorded flow carries the page it was
 *     recorded on (`flow.startUrl`), and an explicit `startUrl` argument wins
 *     over it. When one of the two is known this tool opens a background work
 *     tab through the very same path `chrome_navigate(background:true)` uses,
 *     so the tab is still made by the gate side of the house and registered as
 *     this session's work tab, and the engine never picks a tab. Only when there
 *     is neither a work tab nor a start URL does the call end in `no_work_tab`.
 *   - The response says where the tab came from in `tabSource`:
 *     `work_tab` | `created_from_start_url` | `explicit`.
 *   - `tabTarget: 'current'` (default) runs in that work tab.
 *   - `tabTarget: 'new'` opens a session-owned background tab in the work tab's
 *     window and runs there, leaving the tab open afterwards.
 *   - Only **published** flows may be run from here (`record_replay_list_published`
 *     is the allowlist). A flow that is merely saved is a draft.
 *   - The run holds a tab lease for its whole length, so no other session can
 *     step into the work tab between two nodes.
 *   - `timeoutMs` (10 minutes max) aborts the run itself, not just the response:
 *     an abandoned run closes the tabs it opened and stops.
 *   - The result is summarised: a full RunResult carries every log line plus a
 *     failure screenshot, which is far too big for a tool response.
 */
import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import type { RunResult } from '../record-replay/types';
import { listPublished } from '../record-replay/flow-store';
// 실행 본체는 예약 엔진과 공유한다 (2026-09-05 사이드패널 2단계 D).
import { runPublishedFlow, type RunTabSourceLabel } from '../record-replay/run-published-flow';
// 작업 탭 생성은 chrome_navigate 를 그대로 탄다. 탭 선택·작업 탭 등록 규칙을 한 곳에만 둔다.
// (record-replay 노드들도 같은 방식으로 handleCallTool 을 다시 부른다. 순환 import 지만
//  참조는 실행 시점에만 일어나므로 안전하다. 다만 이 모듈을 tools/index 보다 먼저 평가하면
//  안 된다는 기존 제약은 그대로다.)
import { handleCallTool } from '.';

/** returnLogs:true 일 때 응답에 실을 로그 문자열 상한. */
export const MAX_RETURNED_LOG_CHARS = 4000;

/**
 * `outputs` 를 직렬화해 실을 수 있는 상한 (2026-09-05 Codex 검토 항목 7).
 *
 * outputs 는 흐름 변수 전체다. 스크린샷처럼 큰 값이 하나만 들어가도 응답이 수 MB 가 된다.
 * 상한을 넘으면 넘긴 항목을 빼고 `outputsTruncated: true` 를 붙인다.
 */
export const MAX_OUTPUTS_JSON_CHARS = 16_000;

/** 실패 스텝 메시지 상한. 스택·HTML 덩어리가 통째로 실리는 것을 막는다. */
export const MAX_FAILED_STEP_MESSAGE_CHARS = 2000;

function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * outputs 를 상한 안으로 줄인다. 큰 항목만 빼고 나머지는 그대로 둔다.
 */
export function limitOutputs(outputs: unknown): { value: unknown; truncated: boolean } {
  if (outputs === null || outputs === undefined)
    return { value: outputs ?? null, truncated: false };
  if (safeJsonLength(outputs) <= MAX_OUTPUTS_JSON_CHARS)
    return { value: outputs, truncated: false };
  if (typeof outputs !== 'object' || Array.isArray(outputs)) {
    return { value: null, truncated: true };
  }
  const kept: Record<string, unknown> = {};
  let used = 2; // '{}'
  let truncated = false;
  for (const [key, value] of Object.entries(outputs as Record<string, unknown>)) {
    const size = safeJsonLength({ [key]: value });
    if (used + size > MAX_OUTPUTS_JSON_CHARS) {
      truncated = true;
      continue;
    }
    kept[key] = value;
    used += size;
  }
  return { value: kept, truncated };
}

/** 로그 한 줄을 사람이 읽을 수 있는 짧은 문자열로. */
function formatLogLine(entry: any): string {
  const step = String(entry?.stepId ?? '');
  const status = String(entry?.status ?? '');
  const message = String(entry?.message ?? '');
  return `[${status}] ${step}${message ? `: ${message}` : ''}`;
}

/**
 * RunResult 를 도구 응답 크기로 줄인다.
 *
 * 통째로 실으면 스텝마다의 로그 + 실패 스크린샷 base64 가 그대로 나간다. 기본은 요약과
 * 실패한 스텝만 남기고, 로그는 returnLogs 를 명시했을 때만 상한을 걸어 싣는다.
 */
export function summarizeRunResult(
  result: RunResult,
  options: { returnLogs?: boolean; tabId: number; flowId: string; tabSource?: RunTabSourceLabel },
): Record<string, unknown> {
  const logs: any[] = Array.isArray((result as any)?.logs) ? ((result as any).logs as any[]) : [];
  const firstFailure = logs.find((l) => l?.status === 'failed');

  const outputs = limitOutputs(result?.outputs ?? null);

  const payload: Record<string, unknown> = {
    success: !!result?.success,
    runId: result?.runId,
    flowId: options.flowId,
    tabId: options.tabId,
    summary: result?.summary,
    paused: !!result?.paused,
    outputs: outputs.value,
  };
  // 호출자가 "왜 이 탭에서 돌았는지" 를 되묻지 않아도 되게 한 줄로 알린다.
  if (options.tabSource) payload.tabSource = options.tabSource;
  if (outputs.truncated) payload.outputsTruncated = true;

  if (firstFailure) {
    payload.failedStep = {
      stepId: firstFailure.stepId,
      message: String(firstFailure.message ?? '').slice(0, MAX_FAILED_STEP_MESSAGE_CHARS),
    };
  }

  if (options.returnLogs) {
    let text = logs.map(formatLogLine).join('\n');
    let truncated = false;
    if (text.length > MAX_RETURNED_LOG_CHARS) {
      text = text.slice(0, MAX_RETURNED_LOG_CHARS);
      truncated = true;
    }
    payload.logs = text;
    payload.logsTruncated = truncated;
  } else {
    payload.logsOmitted = 'pass returnLogs:true for the step log';
  }

  return payload;
}

/**
 * 탭 출처 표시. 실제 정의는 실행 본체(`record-replay/run-published-flow.ts`)에 있고
 * 여기서는 응답 타입으로 다시 내보내기만 한다.
 */
export type { RunTabSourceLabel };

function jsonResult(payload: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: false,
  };
}

class FlowRunTool {
  name = TOOL_NAMES.RECORD_REPLAY.FLOW_RUN;

  async execute(args: any): Promise<ToolResult> {
    const { flowId, args: vars, returnLogs, lane, _mcpSessionId } = args || {};

    // 실행 규칙은 전부 공용 함수에 있다 (예약 엔진이 같은 함수를 부른다). 이 도구가
    // 하는 일은 인자를 옮기고 응답 크기를 줄이는 것뿐이다.
    const outcome = await runPublishedFlow(
      {
        flowId,
        args: vars,
        tabId: args?.tabId,
        tabTarget: args?.tabTarget,
        refresh: args?.refresh,
        captureNetwork: args?.captureNetwork,
        timeoutMs: args?.timeoutMs,
        startUrl: args?.startUrl,
        lane: typeof lane === 'string' ? lane : undefined,
        mcpSessionId: typeof _mcpSessionId === 'string' ? _mcpSessionId : undefined,
        toolName: this.name,
        rawArgs: args,
      },
      handleCallTool,
    );

    if (!outcome.ok) return createErrorResponse(outcome.error);

    return jsonResult(
      summarizeRunResult(outcome.result, {
        returnLogs: returnLogs === true,
        tabId: outcome.tabId,
        flowId: outcome.flowId,
        tabSource: outcome.tabSource,
      }),
    );
  }
}

class ListPublishedTool {
  name = TOOL_NAMES.RECORD_REPLAY.LIST_PUBLISHED;
  async execute(): Promise<ToolResult> {
    const list = await listPublished();
    return jsonResult({ success: true, published: list });
  }
}

export const flowRunTool = new FlowRunTool();
export const listPublishedFlowsTool = new ListPublishedTool();
