/**
 * 발행된 흐름 실행 본체 (2026-09-05 사이드패널 2단계 D).
 *
 * 왜 도구에서 떼어냈나: 예약 엔진도 흐름을 돌려야 하는데, 예전에는 실행 규칙이 전부
 * `tools/record-replay.ts` 의 `FlowRunTool.execute` 안에 있었다. 그 규칙을 예약 쪽에 다시
 * 쓰면 두 벌이 되고, 한쪽만 고쳐지는 순간 "엔진이 탭을 고르지 않는다" 같은 계약이 조용히
 * 깨진다. 그래서 MCP 도구와 예약 러너가 **같은 함수**를 부른다.
 *
 * 이 함수가 지키는 것 (도구 시절과 한 글자도 다르지 않다):
 *   - 실행 대상은 **발행 스냅샷**뿐이다. 저장만 된 draft 는 돌지 않는다.
 *   - 탭을 고르는 순서: ① 호출자가 준 tabId(게이트가 주입한 작업 탭 포함)
 *     ② 없으면 시작 URL 로 `chrome_navigate(background:true)` 를 불러 작업 탭을 연다
 *     ③ 둘 다 없으면 `no_work_tab`. 사용자의 활성 탭을 찾아보는 경로는 없다.
 *   - 탭을 만드는 주체는 언제나 `chrome_navigate` 다. 이 모듈은 탭을 직접 고르지 않는다.
 *   - run 전체가 작업 탭 리스를 쥐고, 어떤 경로로 끝나든 `releaseRunTabLeases` 로 푼다.
 *   - 마감은 호출자의 `timeoutMs` 와 외부 `signal` 을 **함께** 본다. 예약 러너는 자기
 *     120초 예산으로 끊고, 도구는 자기 워치독으로 끊는다.
 *
 * 크롬 도구 호출은 `invoke` 로 주입받는다. 이 모듈이 `tools/index` 를 직접 import 하면
 * 예약 러너까지 그 순환에 끌려들어가므로, 배선은 호출자가 한다(도구는 `handleCallTool`,
 * 예약 러너는 이미 주입받은 invoker).
 */

import type { ToolResult } from '@/common/tool-handler';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import { createTabLeaseToken, withTabLease } from '@/utils/tab-lock';
import { createTimeoutAbort, MAX_FLOW_RUN_TIMEOUT_MS } from '@/utils/tool-watchdog';
import { isExplicitTabId, noWorkTabErrorText } from '@/utils/work-tab-gate';
import { getWorkTabId, sessionKeyOf } from '@/utils/work-tab-manager';
import { resolvePublishedFlow } from './flow-store';
import { runFlow } from './flow-runner';
import { isSameUrlForPrepare } from './rr-utils';
import {
  markRunOwnedTab,
  releaseRunTabLeases,
  runTabFromId,
  type RunTabContext,
} from './engine/tab-context';
import type { Flow, RunResult } from './types';
// url-target.ts 는 다른 작업이 진행 중인 파일이라 **import 만** 한다 (수정 금지).
import { createTabForUrl } from '../tools/browser/url-target';

/**
 * 이 실행이 쓴 탭을 어떻게 얻었는가.
 *
 *   - `work_tab`               게이트가 이 세션·레인의 작업 탭을 주입했다.
 *   - `created_from_start_url` 작업 탭이 없어 흐름의 시작 URL(또는 인자 startUrl)로
 *                              백그라운드 작업 탭을 새로 열었다.
 *   - `explicit`               호출자가 tabId 로 탭을 직접 지정했다.
 */
export type RunTabSourceLabel = 'work_tab' | 'created_from_start_url' | 'explicit';

/** 크롬 도구 한 번 호출 (배선은 호출자가 한다). */
export type FlowToolInvoker = (param: {
  name: string;
  args: any;
  effectiveBackgroundMode?: true;
}) => Promise<ToolResult>;

export interface RunPublishedFlowInput {
  flowId: string;
  /** 흐름 변수 값. */
  args?: Record<string, unknown>;
  /** 시작 URL 인자. 흐름의 `startUrl` 보다 우선한다. */
  startUrl?: unknown;
  /** 게이트가 주입했거나 호출자가 지정한 탭. */
  tabId?: unknown;
  tabTarget?: 'current' | 'new';
  refresh?: boolean;
  captureNetwork?: boolean;
  timeoutMs?: unknown;
  lane?: string;
  mcpSessionId?: string;
  /**
   * 외부 취소 신호. 예약 러너의 120초 예산이 여기로 들어온다. 이 함수가 만드는 마감과
   * **둘 다** 실행을 끊는다.
   */
  signal?: AbortSignal;
  /**
   * 흐름 엔진이 자기 IndexedDB 이력(`rr_storage.runs`)을 남길지. 예약 실행은 통합 이력
   * (`mcpShortcutHistory`) 한 곳만 쓰므로 false 다 (2026-09-05 Codex 설계 검토 5).
   */
  persistRun?: boolean;
  /** 거절 문구에 실을 도구 이름. */
  toolName?: string;
  /** `tabTarget:'new'` 진단에 쓰는 원본 인자. */
  rawArgs?: unknown;
}

export type RunPublishedFlowOutcome =
  | { ok: false; error: string; errorCode?: string }
  | {
      ok: true;
      flowId: string;
      flowName: string;
      result: RunResult;
      tabId: number;
      tabSource: RunTabSourceLabel;
    };

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
 * 녹화는 시작 페이지를 흐름의 첫 navigate 단계로도 남긴다. 그런데 이 실행이 시작 URL 로
 * 작업 탭을 방금 열었다면 그 단계는 같은 페이지를 한 번 더 읽는 일밖에 하지 않는다.
 *
 * 조건을 좁게 잡는다. 첫 노드가 navigate 이고, 그 URL 이 방금 연 주소와 같고, 그 노드로
 * 들어오는 간선이 없어야(= 되돌아오는 경로가 없어야) 뺀다. 나머지는 그대로 둔다 - 발행
 * 스냅샷은 사용자가 승인한 내용이므로 확실한 무의미 단계만 건드린다.
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

/** chrome_navigate 응답에서 탭 id 를 꺼낸다 (새 창 경로는 tabs[0]). */
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

/** 두 신호를 하나로 묶는다. 어느 쪽이 끊어도 실행이 멈춘다. */
function linkSignals(target: AbortController, external: AbortSignal | undefined): () => void {
  if (!external) return () => undefined;
  if (external.aborted) {
    target.abort(external.reason);
    return () => undefined;
  }
  const onAbort = () => target.abort(external.reason);
  external.addEventListener('abort', onAbort, { once: true });
  return () => external.removeEventListener('abort', onAbort);
}

/**
 * 발행된 흐름 하나를 돌린다. 도구 응답 형태로 감싸는 일은 호출자가 한다.
 */
export async function runPublishedFlow(
  input: RunPublishedFlowInput,
  invoke: FlowToolInvoker,
): Promise<RunPublishedFlowOutcome> {
  const toolName = input.toolName || TOOL_NAMES.RECORD_REPLAY.FLOW_RUN;
  const flowId = String(input.flowId ?? '');
  if (!flowId) return { ok: false, error: 'flowId is required', errorCode: 'flow_id_required' };

  const tabTarget = input.tabTarget;
  if (tabTarget !== undefined && tabTarget !== 'current' && tabTarget !== 'new') {
    return {
      ok: false,
      errorCode: 'tab_target_invalid',
      error:
        "tabTarget must be 'current' (run in this session's work tab) or 'new' " +
        '(open a background tab in the work tab window). Pass a numeric tab id as tabId, not tabTarget.',
    };
  }

  // 발행 허용 목록: 실행할 수 있는 흐름은 사용자가 발행한 것뿐이고, 실행되는 내용도
  // **발행 시점의 스냅샷**이다.
  const resolution = await resolvePublishedFlow(flowId);
  if (!resolution.ok) {
    if (resolution.reason === 'not_published') {
      return {
        ok: false,
        errorCode: 'flow_not_published',
        error:
          `flow_not_published: "${flowId}" is saved but not published. Publish it in the side panel ` +
          `(or call record_replay_list_published to see what this browser exposes) before running it from MCP.`,
      };
    }
    if (resolution.reason === 'version_mismatch') {
      return {
        ok: false,
        errorCode: 'flow_version_mismatch',
        error:
          `flow_version_mismatch: "${flowId}" was published at version ${resolution.entry?.version} ` +
          `but the saved flow has changed since. Publish it again so the tool surface runs what you approved.`,
      };
    }
    return { ok: false, errorCode: 'flow_missing', error: `Flow not found: ${flowId}` };
  }
  const flow = resolution.flow;

  const effectiveStartUrl = resolveStartUrl(
    input.startUrl,
    (flow as { startUrl?: unknown }).startUrl,
  );

  // 도구·예약으로 시작한 흐름은 **항상** 무간섭이다. 호출자는 화면을 보고 있지 않으므로
  // 탭 활성화·창 포커스가 곧 침해다. 전역 토글이 꺼져 있어도 이 실행만은 background
  // 규칙으로 돈다. (사이드패널에서 사용자가 Run 을 누른 실행은 이 경로를 쓰지 않는다.)
  const session = {
    mcpSessionId: typeof input.mcpSessionId === 'string' ? input.mcpSessionId : undefined,
    lane: typeof input.lane === 'string' ? input.lane : undefined,
    effectiveBackgroundMode: true as const,
  };

  let resolvedTabId: number;
  let tabSource: RunTabSourceLabel;
  /** 이 호출이 방금 만든 탭인가. tabTarget:'new' 를 한 번 더 적용하지 않기 위해 본다. */
  let tabJustCreated = false;

  if (isExplicitTabId(input.tabId)) {
    resolvedTabId = input.tabId as number;
    let workTabId: number | null = null;
    try {
      workTabId = await getWorkTabId(
        sessionKeyOf({ _mcpSessionId: session.mcpSessionId, lane: session.lane }),
      );
    } catch {
      workTabId = null;
    }
    tabSource = workTabId === resolvedTabId ? 'work_tab' : 'explicit';
  } else if (effectiveStartUrl) {
    // chrome_navigate(background:true) 를 그대로 부른다. 탭을 어느 창에 만들지, 만든 탭을
    // 이 세션의 작업 탭으로 등록할지는 전부 그쪽 규칙이다("엔진이 탭을 고르지 않는다").
    let opened: ToolResult;
    try {
      opened = await invoke({
        name: TOOL_NAMES.BROWSER.NAVIGATE,
        args: {
          url: effectiveStartUrl,
          background: true,
          ...(session.mcpSessionId ? { _mcpSessionId: session.mcpSessionId } : {}),
          ...(session.lane ? { lane: session.lane } : {}),
        },
        effectiveBackgroundMode: true,
      });
    } catch (e) {
      return {
        ok: false,
        errorCode: 'start_url_open_failed',
        error: e instanceof Error ? e.message : String(e),
      };
    }
    if ((opened as { isError?: boolean })?.isError) {
      const text = (opened as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
      return {
        ok: false,
        errorCode: 'start_url_open_failed',
        error: text || `Could not open the flow start page (${effectiveStartUrl}).`,
      };
    }
    const openedTab = tabFromNavigateResult(opened);
    if (!isExplicitTabId(openedTab.tabId)) {
      return {
        ok: false,
        errorCode: 'start_url_open_failed',
        error: `Could not open the flow start page (${effectiveStartUrl}) as a background work tab.`,
      };
    }
    resolvedTabId = openedTab.tabId as number;
    tabSource = 'created_from_start_url';
    tabJustCreated = true;
  } else {
    // 작업 탭도 없고 흐름에 시작 URL 도 없다. 예전과 같은 문구로 거절한다.
    return { ok: false, errorCode: 'no_work_tab', error: noWorkTabErrorText(toolName) };
  }

  let runTab: RunTabContext;
  try {
    const workTab = await chrome.tabs.get(resolvedTabId);
    if (tabTarget === 'new' && !tabJustCreated) {
      const created = await createTabForUrl(effectiveStartUrl ? effectiveStartUrl : 'about:blank', {
        background: true,
        windowId: workTab?.windowId,
        reason: `${toolName}:new-tab`,
        args: input.rawArgs ?? {},
      });
      if (typeof created?.id !== 'number') {
        return {
          ok: false,
          errorCode: 'new_tab_failed',
          error: 'Could not open a new work tab for this flow run.',
        };
      }
      runTab = runTabFromId(created.id, 'mcp', created.windowId, session);
      // 이 탭은 이 실행이 만든 것이다. run 소유로 등록해야 abort 정리가 닫는다.
      markRunOwnedTab(runTab, created.id);
    } else {
      runTab = runTabFromId(resolvedTabId, 'mcp', workTab?.windowId, session);
    }
  } catch (e) {
    return {
      ok: false,
      errorCode: 'run_tab_failed',
      error: e instanceof Error ? e.message : String(e),
    };
  }

  // run 전체가 작업 탭 리스를 쥔다. 노드와 노드 사이에도 다른 세션이 이 탭에 끼어들지
  // 못하게 하기 위해서다.
  const leaseToken = createTabLeaseToken('flow_run');
  runTab.leaseToken = leaseToken;

  // 마감을 스스로 들고 abort 로 **실행을 멈춘다**. 외부 신호(예약 러너의 예산)도 같은
  // 컨트롤러에 묶어, 어느 쪽이 끊어도 실행이 실제로 멈춘다.
  const abort = createTimeoutAbort(
    typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined,
    MAX_FLOW_RUN_TIMEOUT_MS,
  );
  const bridge = new AbortController();
  const unlinkTimeout = linkSignals(bridge, abort.signal);
  const unlinkExternal = linkSignals(bridge, input.signal);
  runTab.deadlineAt = Date.now() + abort.timeoutMs;

  const flowToRun =
    tabJustCreated && effectiveStartUrl
      ? stripLeadingStartUrlNavigate(flow, effectiveStartUrl)
      : flow;

  let result: RunResult;
  try {
    result = await withTabLease(runTab.tabId, leaseToken, () =>
      runFlow(flowToRun, runTab, {
        // 엔진 쪽 'new' 는 여기서 이미 처리했다. 엔진이 또 탭을 만들지 않도록 'current' 로 넘긴다.
        tabTarget: 'current',
        refresh: input.refresh,
        captureNetwork: input.captureNetwork,
        // 요약에 실패 스텝을 담으려면 엔진이 로그를 돌려줘야 한다. 응답 크기는 호출자가 줄인다.
        returnLogs: true,
        timeoutMs: abort.timeoutMs,
        startUrl: effectiveStartUrl,
        args: input.args,
        ...(input.persistRun === false ? { persistRun: false } : {}),
        signal: bridge.signal,
      }),
    );
  } finally {
    // 흐름이 옮겨가거나 새로 연 탭의 리스를 전부 푼다. 시작 탭의 리스는 withTabLease 가
    // 자기 finally 에서 푼다.
    releaseRunTabLeases(runTab);
    abort.dispose();
    unlinkTimeout();
    unlinkExternal();
  }

  return {
    ok: true,
    flowId,
    flowName: String(flow?.name ?? flowId),
    result,
    tabId: runTab.tabId,
    tabSource,
  };
}
