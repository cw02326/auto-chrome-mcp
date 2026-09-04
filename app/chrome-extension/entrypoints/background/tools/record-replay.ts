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
// url-target.ts 는 다른 작업이 진행 중인 파일이라 **import 만** 한다 (수정 금지).
import { createTabForUrl } from './browser/url-target';
import { isExplicitTabId, noWorkTabErrorText } from '@/utils/work-tab-gate';

/** returnLogs:true 일 때 응답에 실을 로그 문자열 상한. */
export const MAX_RETURNED_LOG_CHARS = 4000;

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

  const payload: Record<string, unknown> = {
    success: !!result?.success,
    runId: result?.runId,
    flowId: options.flowId,
    tabId: options.tabId,
    summary: result?.summary,
    paused: !!result?.paused,
    outputs: result?.outputs ?? null,
  };

  if (firstFailure) {
    payload.failedStep = {
      stepId: firstFailure.stepId,
      message: firstFailure.message ?? '',
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

    const flow = await getFlow(flowId);
    if (!flow) return createErrorResponse(`Flow not found: ${flowId}`);

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

    const result = await runFlow(flow, runTab, {
      // 엔진 쪽 'new' 는 여기서 이미 처리했다. 엔진이 또 탭을 만들지 않도록 'current' 로 넘긴다.
      tabTarget: 'current',
      refresh,
      captureNetwork,
      // 요약에 실패 스텝을 담으려면 엔진이 로그를 돌려줘야 한다. 응답 크기는
      // summarizeRunResult 가 통제한다.
      returnLogs: true,
      timeoutMs,
      startUrl,
      args: vars,
    });

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
