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
import type { Flow, RunResult } from '../record-replay/types';
import { isSameUrlForPrepare } from '../record-replay/rr-utils';
import { listPublished, resolvePublishedFlow } from '../record-replay/flow-store';
import { runFlow } from '../record-replay/flow-runner';
import {
  markRunOwnedTab,
  releaseRunTabLeases,
  runTabFromId,
  type RunTabContext,
} from '../record-replay/engine/tab-context';
import { createTabLeaseToken, withTabLease } from '@/utils/tab-lock';
import { createTimeoutAbort, MAX_FLOW_RUN_TIMEOUT_MS } from '@/utils/tool-watchdog';
// url-target.ts 는 다른 작업이 진행 중인 파일이라 **import 만** 한다 (수정 금지).
import { createTabForUrl } from './browser/url-target';
import { isExplicitTabId, noWorkTabErrorText } from '@/utils/work-tab-gate';
import { getWorkTabId, sessionKeyOf } from '@/utils/work-tab-manager';
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
 * 이 실행이 쓴 탭을 어떻게 얻었는가 (2026-09-05 사이드패널 1단계 B).
 *
 *   - `work_tab`               게이트가 이 세션·레인의 작업 탭을 주입했다.
 *   - `created_from_start_url` 작업 탭이 없어 흐름의 시작 URL(또는 인자 startUrl)로
 *                              백그라운드 작업 탭을 새로 열었다.
 *   - `explicit`               호출자가 tabId 로 탭을 직접 지정했다.
 */
export type RunTabSourceLabel = 'work_tab' | 'created_from_start_url' | 'explicit';

/** 흐름·인자에서 실제로 쓸 시작 URL 을 고른다. 인자가 흐름 값을 이긴다. */
export function resolveStartUrl(argStartUrl: unknown, flowStartUrl: unknown): string | undefined {
  const fromArg = typeof argStartUrl === 'string' ? argStartUrl.trim() : '';
  if (fromArg) return fromArg;
  const fromFlow = typeof flowStartUrl === 'string' ? flowStartUrl.trim() : '';
  return fromFlow || undefined;
}

/**
 * 방금 연 시작 페이지로 가는 **첫 navigate 단계**를 뺀 흐름을 돌려준다
 * (2026-09-05 Codex 교차 리뷰 6).
 *
 * 녹화는 시작 페이지를 흐름의 첫 navigate 단계로도 남긴다. 그런데 이 도구가 시작 URL 로
 * 작업 탭을 방금 열었다면 그 단계는 같은 페이지를 한 번 더 읽는 일밖에 하지 않는다.
 *
 * 조건을 좁게 잡는다. 첫 노드가 navigate 이고, 그 URL 이 방금 연 주소와 같고, 그 노드로
 * 들어오는 간선이 없어야(= 되돌아오는 경로가 없어야) 뺀다. 나머지는 그대로 둔다 - 발행
 * 스냅샷은 사용자가 승인한 내용이므로 확실한 무의미 단계만 건드린다.
 *
 * 저장소가 준 객체를 고치지 않고 얕은 복사본을 만든다.
 */
export function stripLeadingStartUrlNavigate(flow: Flow, startUrl: string): Flow {
  const nodes = Array.isArray(flow?.nodes) ? flow.nodes : [];
  if (nodes.length < 2) return flow;
  const first = nodes[0];
  if (!first || first.type !== 'navigate') return flow;
  const url = (first.config as { url?: unknown } | undefined)?.url;
  if (typeof url !== 'string' || !isSameUrlForPrepare(url, startUrl)) return flow;
  const edges = Array.isArray(flow.edges) ? flow.edges : [];
  if (edges.some((e) => e.to === first.id)) return flow;
  return {
    ...flow,
    nodes: nodes.slice(1),
    edges: edges.filter((e) => e.from !== first.id),
  };
}

/** chrome_navigate 응답에서 탭 id·창 id 를 꺼낸다 (새 창 경로는 tabs[0]). */
function tabFromNavigateResult(result: ToolResult): { tabId?: number; windowId?: number } {
  const first = result?.content?.find(
    (c: any) => c && c.type === 'text' && typeof c.text === 'string',
  ) as { text: string } | undefined;
  if (!first) return {};
  let payload: any;
  try {
    payload = JSON.parse(first.text);
  } catch {
    return {};
  }
  const tabId =
    typeof payload?.tabId === 'number'
      ? payload.tabId
      : typeof payload?.tabs?.[0]?.tabId === 'number'
        ? payload.tabs[0].tabId
        : undefined;
  const windowId = typeof payload?.windowId === 'number' ? payload.windowId : undefined;
  return { tabId, windowId };
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

    // 발행 허용 목록(검토 항목 9 · 재확인 항목 4): 도구 표면으로 실행할 수 있는 흐름은
    // 사용자가 발행한 것뿐이고, 실행되는 내용도 **발행 시점의 스냅샷**이다. 예전에는
    // 대상 흐름을 `getFlow(flowId)` 로 먼저 찾아서, slug 가 다른 흐름의 draft id 와 겹치면
    // 그 draft 가 남의 허가로 실행됐고, 발행 뒤 고친 draft 도 그대로 돌았다.
    const resolution = await resolvePublishedFlow(String(flowId));
    if (!resolution.ok) {
      if (resolution.reason === 'not_published') {
        return createErrorResponse(
          `flow_not_published: "${flowId}" is saved but not published. Publish it in the side panel ` +
            `(or call record_replay_list_published to see what this browser exposes) before running it from MCP.`,
        );
      }
      if (resolution.reason === 'version_mismatch') {
        return createErrorResponse(
          `flow_version_mismatch: "${flowId}" was published at version ${resolution.entry?.version} ` +
            `but the saved flow has changed since. Publish it again so the tool surface runs what you approved.`,
        );
      }
      return createErrorResponse(`Flow not found: ${flowId}`);
    }
    const flow = resolution.flow;

    // 시작 URL: 인자가 먼저고, 없으면 흐름이 녹화된 페이지를 쓴다 (설계 B 1항).
    const effectiveStartUrl = resolveStartUrl(startUrl, (flow as { startUrl?: unknown }).startUrl);

    // 2026-09-05 발행 전 검토 2: 도구로 시작한 흐름은 **항상** 무간섭이다. 호출자는
    // 화면을 보고 있지 않으므로(모델이 부른 것이다) 탭 활성화·창 포커스가 곧 침해다.
    // 전역 토글이 꺼져 있어도 이 실행만은 background 규칙으로 돈다 - 모드를 실행 체인에
    // 실어 보내면 게이트·URL 대상 해석·navigate 재사용·활성화 가드가 같은 답을 낸다.
    // (사이드패널에서 사용자가 Run 을 누른 실행은 이 값을 켜지 않고 기존 규칙을 따른다.)
    const session = {
      mcpSessionId: typeof _mcpSessionId === 'string' ? _mcpSessionId : undefined,
      lane: typeof lane === 'string' ? lane : undefined,
      effectiveBackgroundMode: true as const,
    };

    // 대상 탭 결정. 순서도 계약이다:
    //   ① 게이트가 넣어 준(또는 호출자가 지정한) tabId
    //   ② 없으면 시작 URL 로 백그라운드 작업 탭을 연다 - 만드는 주체는 chrome_navigate 다
    //   ③ 둘 다 없을 때만 no_work_tab
    // 어느 경우에도 사용자가 보고 있는 탭을 찾아보는 경로는 없다.
    let resolvedTabId: number;
    let tabSource: RunTabSourceLabel;
    /** 이 호출이 방금 만든 탭인가. tabTarget:'new' 를 한 번 더 적용하지 않기 위해 본다. */
    let tabJustCreated = false;

    if (isExplicitTabId(tabId)) {
      resolvedTabId = tabId;
      // 게이트가 주입한 작업 탭과 호출자가 직접 지정한 탭을 구분한다(진단용 표시일 뿐,
      // 동작은 같다). 값이 같으면 어느 쪽이든 "이 세션의 작업 탭" 이라고 부르는 것이 맞다.
      let workTabId: number | null = null;
      try {
        workTabId = await getWorkTabId(sessionKeyOf({ _mcpSessionId, lane }));
      } catch {
        workTabId = null;
      }
      tabSource = workTabId === resolvedTabId ? 'work_tab' : 'explicit';
    } else if (effectiveStartUrl) {
      // chrome_navigate(background:true) 를 그대로 부른다. 탭을 어느 창에 만들지, 만든 탭을
      // 이 세션의 작업 탭으로 등록할지는 전부 그쪽 규칙이다("엔진이 탭을 고르지 않는다").
      // 만든 탭은 run 소유로 등록하지 않는다 - 이제 이 세션의 작업 탭이므로, 실행이
      // 중단돼도 chrome_navigate 로 만든 작업 탭과 똑같이 남는다.
      let opened: ToolResult;
      try {
        opened = await handleCallTool({
          name: TOOL_NAMES.BROWSER.NAVIGATE,
          args: {
            url: effectiveStartUrl,
            background: true,
            ...(typeof _mcpSessionId === 'string' ? { _mcpSessionId } : {}),
            ...(typeof lane === 'string' ? { lane } : {}),
          },
          effectiveBackgroundMode: true,
        });
      } catch (e) {
        return createErrorResponse(e instanceof Error ? e.message : String(e));
      }
      if ((opened as { isError?: boolean })?.isError) {
        const text = (opened as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
        return createErrorResponse(
          text || `Could not open the flow start page (${effectiveStartUrl}).`,
        );
      }
      const openedTab = tabFromNavigateResult(opened);
      if (!isExplicitTabId(openedTab.tabId)) {
        return createErrorResponse(
          `Could not open the flow start page (${effectiveStartUrl}) as a background work tab.`,
        );
      }
      resolvedTabId = openedTab.tabId;
      tabSource = 'created_from_start_url';
      tabJustCreated = true;
    } else {
      // 작업 탭도 없고 흐름에 시작 URL 도 없다. 예전과 같은 문구로 거절한다.
      return createErrorResponse(noWorkTabErrorText(this.name));
    }

    let runTab: RunTabContext;
    try {
      const workTab = await chrome.tabs.get(resolvedTabId);
      if (tabTarget === 'new' && !tabJustCreated) {
        // 작업 탭이 있는 창에 세션 소유의 백그라운드 탭을 새로 연다. 실행 후에도 남겨 둬
        // 호출자가 결과를 확인하거나 이어서 쓸 수 있게 한다.
        const created = await createTabForUrl(
          effectiveStartUrl ? effectiveStartUrl : 'about:blank',
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
        // 재확인 항목 6: 이 탭은 **이 도구가** 만든 것이다. run 소유로 등록하지 않으면
        // abort 정리 대상에서 빠져, 취소된 실행이 빈 탭을 남긴 채 끝났다.
        markRunOwnedTab(runTab, created.id);
      } else {
        runTab = runTabFromId(resolvedTabId, 'mcp', workTab?.windowId, session);
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
    // 검토 항목 3: 같은 마감을 **내부 도구 호출까지** 내려보낸다. abort 는 스텝 경계와
    // 엔진의 대기 루프만 끊는다 - 도구 하나가 마감을 넘겨 매달리면 그 안에서는 아무도
    // 신호를 보지 않으므로, 마감을 args 로 실어 파이프라인이 워치독 상한으로 쓰게 한다.
    runTab.deadlineAt = Date.now() + abort.timeoutMs;

    // 방금 연 시작 페이지로 다시 가는 첫 단계는 뺀다 (Codex 교차 리뷰 6).
    const flowToRun =
      tabJustCreated && effectiveStartUrl
        ? stripLeadingStartUrlNavigate(flow, effectiveStartUrl)
        : flow;

    let result;
    try {
      result = await withTabLease(runTab.tabId, leaseToken, () =>
        runFlow(flowToRun, runTab, {
          // 엔진 쪽 'new' 는 여기서 이미 처리했다. 엔진이 또 탭을 만들지 않도록 'current' 로 넘긴다.
          tabTarget: 'current',
          refresh,
          captureNetwork,
          // 요약에 실패 스텝을 담으려면 엔진이 로그를 돌려줘야 한다. 응답 크기는
          // summarizeRunResult 가 통제한다.
          returnLogs: true,
          timeoutMs: abort.timeoutMs,
          // 흐름의 시작 URL 도 여기까지 따라온다 - 기존 작업 탭이 다른 페이지에 있어도
          // 첫 단계 전에 시작 페이지로 맞춘다(prepareRunTab).
          startUrl: effectiveStartUrl,
          args: vars,
          // 정리(소유 탭 닫기)까지 리스 안에서 끝난다 — 리스는 그 뒤에 풀린다.
          signal: abort.signal,
        }),
      );
    } finally {
      // 재확인 항목 2: 흐름이 옮겨가거나 새로 연 탭의 리스를 전부 푼다. 시작 탭의 리스는
      // 위의 withTabLease 가 자기 finally 에서 푼다.
      releaseRunTabLeases(runTab);
      abort.dispose();
    }

    return jsonResult(
      summarizeRunResult(result, {
        returnLogs: returnLogs === true,
        tabId: runTab.tabId,
        flowId: String(flowId),
        tabSource,
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
