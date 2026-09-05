/**
 * record_replay_* MCP tools.
 *
 * Stage 2 of the run-tab work: these tools are exposed on the MCP surface again
 * (packages/shared TOOL_SCHEMAS), and the tab a flow may drive comes from the
 * work-tab gate rather than from the engine looking around the browser.
 *
 * Contract:
 *   - `record_replay_flow_run` is in TAB_ID_INJECT_TOOLS, so the gate injects
 *     this session/lane's work tab as `tabId` when the caller omits it, and
 *     refuses with `no_work_tab` when there is none. The engine has no
 *     active-tab fallback, so nothing here may borrow the tab the user is on.
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
import { getFlow } from '../record-replay/flow-store';
import { runFlow } from '../record-replay/flow-runner';
import { runTabFromId, type RunTabContext } from '../record-replay/engine/tab-context';
import { createTabLeaseToken, withTabLease } from '@/utils/tab-lock';
import { createTimeoutAbort, MAX_FLOW_RUN_TIMEOUT_MS } from '@/utils/tool-watchdog';
// url-target.ts 는 다른 작업이 진행 중인 파일이라 **import 만** 한다 (수정 금지).
import { createTabForUrl } from './browser/url-target';
import { isExplicitTabId, noWorkTabErrorText } from '@/utils/work-tab-gate';

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
  options: { returnLogs?: boolean; tabId: number; flowId: string },
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

function jsonResult(payload: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: false,
  };
}

class FlowRunTool {
  name = TOOL_NAMES.RECORD_REPLAY.FLOW_RUN;

  async execute(args: any): Promise<ToolResult> {
    const {
      flowId,
      args: vars,
      tabId,
      tabTarget,
      refresh,
      captureNetwork,
      returnLogs,
      timeoutMs,
      startUrl,
      lane,
      _mcpSessionId,
    } = args || {};

    if (!flowId) return createErrorResponse('flowId is required');
    if (tabTarget !== undefined && tabTarget !== 'current' && tabTarget !== 'new') {
      return createErrorResponse(
        "tabTarget must be 'current' (run in this session's work tab) or 'new' " +
          '(open a background tab in the work tab window). Pass a numeric tab id as tabId, not tabTarget.',
      );
    }

    // 발행 허용 목록(검토 항목 9): 도구 표면으로 실행할 수 있는 흐름은 사용자가 발행한
    // 것뿐이다. 예전에는 저장만 된 초안·가져온 흐름도 id 만 알면 돌릴 수 있었다.
    const published = await listPublished();
    const entry = published.find((p) => p.id === flowId || p.slug === flowId);
    const flow = (await getFlow(flowId)) ?? (entry ? await getFlow(entry.id) : undefined);
    if (!flow) return createErrorResponse(`Flow not found: ${flowId}`);
    if (!entry) {
      return createErrorResponse(
        `flow_not_published: "${flowId}" is saved but not published. Publish it in the side panel ` +
          `(or call record_replay_list_published to see what this browser exposes) before running it from MCP.`,
      );
    }

    // 작업 탭은 게이트가 정한다. 여기서 활성 탭을 찾아보는 경로는 없다 — 없으면 거절이다.
    if (!isExplicitTabId(tabId)) {
      return createErrorResponse(noWorkTabErrorText(this.name));
    }

    const session = {
      mcpSessionId: typeof _mcpSessionId === 'string' ? _mcpSessionId : undefined,
      lane: typeof lane === 'string' ? lane : undefined,
    };

    let runTab: RunTabContext;
    try {
      const workTab = await chrome.tabs.get(tabId);
      if (tabTarget === 'new') {
        // 작업 탭이 있는 창에 세션 소유의 백그라운드 탭을 새로 연다. 실행 후에도 남겨 둬
        // 호출자가 결과를 확인하거나 이어서 쓸 수 있게 한다.
        const created = await createTabForUrl(
          typeof startUrl === 'string' && startUrl.trim() ? startUrl : 'about:blank',
          {
            background: true,
            windowId: workTab?.windowId,
            reason: `${this.name}:new-tab`,
            args,
          },
        );
        if (typeof created?.id !== 'number') {
          return createErrorResponse('Could not open a new work tab for this flow run.');
        }
        runTab = runTabFromId(created.id, 'mcp', created.windowId, session);
      } else {
        runTab = runTabFromId(tabId, 'mcp', workTab?.windowId, session);
      }
    } catch (e) {
      return createErrorResponse(e instanceof Error ? e.message : String(e));
    }

    // 항목 3: run 전체가 작업 탭 리스를 쥔다. 노드와 노드 사이에도 다른 세션이 이 탭에
    // 끼어들지 못하게 하기 위해서다. 토큰은 RunTabContext 를 타고 내려가 노드가 부르는
    // 모든 도구 호출에 `_leaseToken` 으로 실린다(재진입 식별용).
    // 리스는 실행을 시작한 탭에 걸린다. 흐름이 중간에 자기가 연 탭으로 옮겨가면 그 탭은
    // run 이 만든 것이라 경쟁자가 없다.
    const leaseToken = createTabLeaseToken('flow_run');
    runTab.leaseToken = leaseToken;

    // 항목 4: 마감을 스스로 들고 abort 로 **실행을 멈춘다**. 워치독의 Promise.race 는
    // 응답만 끊고 실행은 계속 돌려 좀비 run 을 남겼다. 상한은 10분.
    const abort = createTimeoutAbort(timeoutMs, MAX_FLOW_RUN_TIMEOUT_MS);

    let result;
    try {
      result = await withTabLease(runTab.tabId, leaseToken, () =>
        runFlow(flow, runTab, {
          // 엔진 쪽 'new' 는 여기서 이미 처리했다. 엔진이 또 탭을 만들지 않도록 'current' 로 넘긴다.
          tabTarget: 'current',
          refresh,
          captureNetwork,
          // 요약에 실패 스텝을 담으려면 엔진이 로그를 돌려줘야 한다. 응답 크기는
          // summarizeRunResult 가 통제한다.
          returnLogs: true,
          timeoutMs: abort.timeoutMs,
          startUrl,
          args: vars,
          // 정리(소유 탭 닫기)까지 리스 안에서 끝난다 — 리스는 그 뒤에 풀린다.
          signal: abort.signal,
        }),
      );
    } finally {
      abort.dispose();
    }

    return jsonResult(
      summarizeRunResult(result, {
        returnLogs: returnLogs === true,
        tabId: runTab.tabId,
        flowId: String(flowId),
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
