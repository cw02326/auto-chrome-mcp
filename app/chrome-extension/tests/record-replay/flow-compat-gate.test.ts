/**
 * flow-compat-gate.test.ts
 *
 * 구버전 실행 차단 게이트 (PR B0).
 * 계약: docs/plans/2026-09-09-recorder-toolbar-and-multitab-design.md 2.8 절 / 2.9 M0.
 *
 * 왜 이 테스트가 있나
 * -------------------
 * 여러 탭 흐름은 `closeTab { tabRef: n }` 같은 단계를 남긴다. 그 필드를 모르는 실행기는
 * `closeTabNode` 에서 "인자가 없다" 로 보고 **현재 run 탭을 닫는다**. 그래서 새 기능을 쓰는
 * 흐름은 실행 자체가 거부돼야 한다.
 *
 * 이 파일이 못박는 것:
 *   (a) 기능 표시가 없는 기존 흐름은 어느 진입점에서도 그대로 실행된다.
 *   (b) 지원하지 않는 기능을 요구하는 흐름은 **실행이 시작되기 전에** 거부된다.
 *   (c) 거부는 사이드패널 Run · MCP `record_replay_flow_run` · 예약 러너 · 엔진 본체에서
 *       같은 오류 코드와 같은 문구로 일어난다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import type { ToolResult } from '@/common/tool-handler';

const RUN_TAB_ID = 99;
const USER_TAB_ID = 11;
const NEW_TAB_ID = 500;

const mocks = vi.hoisted(() => ({
  handleCallTool: vi.fn(),
  /** flow-runner 재수출 대역. 사이드패널·공용 실행 함수가 이것을 부른다. */
  engineRunFlow: vi.fn(),
}));

vi.mock('@/entrypoints/background/tools', () => ({ handleCallTool: mocks.handleCallTool }));
// `engine/scheduler` 는 대역으로 바꾸지 않는다. 엔진 본체의 마지막 관문을 실제로 봐야 한다.
vi.mock('@/entrypoints/background/record-replay/flow-runner', () => ({
  runFlow: mocks.engineRunFlow,
}));
vi.mock('@/entrypoints/background/record-replay/flow-store', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/entrypoints/background/record-replay/flow-store')>();
  return { ...actual, appendRun: vi.fn(async () => undefined) };
});

import {
  ENGINE_FEATURES,
  FLOW_FEATURES,
  FLOW_REQUIRES_NEWER_ENGINE,
  FlowCompatError,
  assertFlowRunnable,
  FEATURE_MIN_ENGINE,
  checkFlowRunnable,
  collectRequiredFeatures,
  compareEngineVersions,
} from '@/entrypoints/background/record-replay/engine/flow-compat';
import { runFlow } from '@/entrypoints/background/record-replay/engine/scheduler';
import { runPublishedFlow } from '@/entrypoints/background/record-replay/run-published-flow';
import { publishFlow, saveFlow } from '@/entrypoints/background/record-replay/flow-store';
import { IndexedDbStorage } from '@/entrypoints/background/record-replay/storage/indexeddb-manager';
import type { RunTabContext } from '@/entrypoints/background/record-replay/engine/tab-context';
import type { Flow } from '@/entrypoints/background/record-replay/types';
import { installTabStub, makeTab, type TabStub } from './_chrome-tab-stub';

const FLOW_ID = 'flow-compat-gate';

/** 기존 흐름. 기능 표시가 없다. 위험한 `closeTab` 단계를 일부러 쓴다. */
function legacyFlow(over: Record<string, unknown> = {}): Flow {
  return {
    id: FLOW_ID,
    name: '기존 흐름',
    version: 1,
    variables: [],
    nodes: [{ id: 'n1', type: 'closeTab', config: {} }],
    edges: [],
    meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ...over,
  } as unknown as Flow;
}

/** 새 기능을 요구하는 흐름. 표시와 새 필드를 함께 가진다. */
function multitabFlow(over: Record<string, unknown> = {}): Flow {
  return {
    id: FLOW_ID,
    name: '여러 탭 흐름',
    version: 1,
    variables: [],
    nodes: [{ id: 'n1', type: 'closeTab', config: { tabRef: 1 } }],
    edges: [],
    meta: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      features: [FLOW_FEATURES.MULTITAB],
      minEngine: '1.14.0',
    },
    ...over,
  } as unknown as Flow;
}

function runTab(): RunTabContext {
  return { tabId: RUN_TAB_ID, windowId: 1, source: 'mcp' } as RunTabContext;
}

// ===========================================================================
// 1. 판정 함수 자체
// ===========================================================================

describe('checkFlowRunnable 판정', () => {
  it('기능 표시가 없는 기존 흐름은 언제나 실행 가능하다', () => {
    expect(checkFlowRunnable(legacyFlow())).toEqual({ ok: true });
    expect(checkFlowRunnable({ id: 'x', nodes: [], edges: [] })).toEqual({ ok: true });
    // meta 자체가 없는 아주 옛 흐름도 통과한다.
    expect(checkFlowRunnable({ id: 'x' })).toEqual({ ok: true });
  });

  // 2026-09-09 PR B: 여러 탭 본체가 들어오면서 실행기가 multitab 을 지원하게 됐다.
  // 게이트 판정 로직 자체는 그대로이므로, 아래 두 테스트는 "지원 목록이 비어 있는 실행기"
  // 를 대역으로 넣어 같은 규칙을 계속 확인한다.
  it('실행기는 이제 multitab 을 지원한다 (PR B 에서 켰다)', () => {
    expect([...ENGINE_FEATURES]).toContain(FLOW_FEATURES.MULTITAB);
  });

  it('meta.features 가 모르는 기능을 요구하면 거부한다', () => {
    const verdict = checkFlowRunnable({
      id: 'x',
      meta: { features: ['some_future_feature'] },
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.errorCode).toBe(FLOW_REQUIRES_NEWER_ENGINE);
    expect(verdict.missingFeatures).toEqual(['some_future_feature']);

    // 여러 탭 흐름도 지원 목록이 없는 실행기(= PR B 이전 빌드)에서는 같은 이유로 거부된다.
    const onOldEngine = checkFlowRunnable(
      { id: 'x', meta: { features: [FLOW_FEATURES.MULTITAB] } },
      { engineFeatures: [] },
    );
    expect(onOldEngine.ok).toBe(false);
    if (onOldEngine.ok) return;
    expect(onOldEngine.missingFeatures).toEqual([FLOW_FEATURES.MULTITAB]);
  });

  it('실행기가 그 기능을 가지면 같은 흐름이 통과한다 (설계 2.9 M0 합격 조건)', () => {
    const flow = { id: 'x', meta: { features: [FLOW_FEATURES.MULTITAB] } };
    expect(checkFlowRunnable(flow, { engineFeatures: [] }).ok).toBe(false);
    expect(
      checkFlowRunnable(flow, {
        engineFeatures: [FLOW_FEATURES.MULTITAB],
        engineVersion: '1.14.0',
      }),
    ).toEqual({ ok: true });
  });

  it('minEngine 을 밝히지 않은 여러 탭 흐름도 최소 버전을 요구한다', () => {
    // 표시만 지우고 최소 버전을 비워 두면 옛 실행기에서 그냥 돌던 구멍을 막는다.
    const flow = { id: 'x', meta: { features: [FLOW_FEATURES.MULTITAB] } };
    const old = checkFlowRunnable(flow, {
      engineFeatures: [FLOW_FEATURES.MULTITAB],
      engineVersion: '1.13.0',
    });
    expect(old.ok).toBe(false);
    if (!old.ok) expect(old.minEngine).toBe(FEATURE_MIN_ENGINE[FLOW_FEATURES.MULTITAB]);
  });

  it('meta.minEngine 이 설치된 확장보다 높으면 거부한다', () => {
    const flow = { id: 'x', meta: { minEngine: '1.14.0' } };
    const old = checkFlowRunnable(flow, { engineVersion: '1.13.0' });
    expect(old.ok).toBe(false);
    if (!old.ok) expect(old.minEngine).toBe('1.14.0');
    expect(checkFlowRunnable(flow, { engineVersion: '1.14.0' })).toEqual({ ok: true });
    expect(checkFlowRunnable(flow, { engineVersion: '1.20.0' })).toEqual({ ok: true });
  });

  it('표시를 지워도 단계의 tabRef 를 보고 거부한다', () => {
    // 지원 목록이 없는 실행기(= PR B 이전 빌드) 기준으로 본다. 표시를 지운 채 내보낸
    // 흐름이나 손으로 고친 JSON 이 게이트를 우회하지 못하는지가 이 테스트의 요지다.
    const oldEngine = { engineFeatures: [] as string[] };
    expect(
      checkFlowRunnable({ id: 'x', nodes: [{ id: 'n1', config: { tabRef: 2 } }] }, oldEngine).ok,
    ).toBe(false);
    // 옛 steps 배열로 들어온 흐름도 같은 눈으로 본다.
    expect(
      checkFlowRunnable({ id: 'x', steps: [{ id: 's1', type: 'closeTab', tabRef: 1 }] }, oldEngine)
        .ok,
    ).toBe(false);
  });

  it('표시 없는 하위 흐름(subflow) 안의 tabRef 도 잡는다', () => {
    // foreach·while 이 도는 subflow 도 같은 실행기가 돌린다. 최상위만 보면 그냥 지나간다.
    const flow = {
      id: 'x',
      nodes: [{ id: 'n1', type: 'foreach', config: { subflowId: 'sf1' } }],
      subflows: { sf1: { nodes: [{ id: 's1', config: { tabRef: 2 } }], edges: [] } },
    };
    expect(checkFlowRunnable(flow, { engineFeatures: [] }).ok).toBe(false);
    expect(collectRequiredFeatures(flow)).toContain(FLOW_FEATURES.MULTITAB);
  });

  it('버전 비교는 마디 단위 숫자로 한다', () => {
    expect(compareEngineVersions('1.13.0', '1.14.0')).toBeLessThan(0);
    expect(compareEngineVersions('1.14.0', '1.14.0')).toBe(0);
    expect(compareEngineVersions('1.9.0', '1.14.0')).toBeLessThan(0);
    expect(compareEngineVersions('2.0.0', '1.14.0')).toBeGreaterThan(0);
  });

  it('assertFlowRunnable 은 FlowCompatError 를 던지고 기존 흐름에는 조용하다', () => {
    expect(() => assertFlowRunnable(legacyFlow())).not.toThrow();
    expect(() => assertFlowRunnable(multitabFlow())).toThrow(FlowCompatError);
  });

  it('거절 문구는 한국어이고 대시류를 쓰지 않는다', () => {
    const verdict = checkFlowRunnable(multitabFlow());
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.error).toContain('업데이트');
    // 금지된 대시류 7종. 소스에 글자를 그대로 두면 대시 검사기가 이 파일을 잡으므로
    // 코드포인트로 적는다.
    const forbidden = ['\u2014', '\u2013', '\u3161', '\u2015', '\u2012', '\uff0d', '\u2212'];
    for (const dash of forbidden) {
      expect(verdict.error).not.toContain(dash);
    }
  });
});

// ===========================================================================
// 2. 진입점별 거부 (같은 코드·같은 문구)
// ===========================================================================

describe('실행 진입점은 모두 같은 게이트를 지난다', () => {
  let stub: TabStub;
  let toolCalls: Array<{ name: string; args: Record<string, unknown> }>;

  async function clearStore(): Promise<void> {
    for (const f of await IndexedDbStorage.flows.list()) await IndexedDbStorage.flows.delete(f.id);
    for (const p of await IndexedDbStorage.published.list())
      await IndexedDbStorage.published.delete(p.id);
  }

  async function seed(flow: Flow): Promise<void> {
    await saveFlow(flow, { notify: false });
    await publishFlow(flow);
  }

  /** 도구 호출 대역. 어떤 도구가 불렸는지 기록만 한다. */
  function invoker() {
    return vi.fn(
      async (call: { name: string; args?: Record<string, unknown> }): Promise<ToolResult> => {
        toolCalls.push({ name: call.name, args: call.args ?? {} });
        if (call.name === TOOL_NAMES.BROWSER.NAVIGATE) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ tabId: NEW_TAB_ID, windowId: 1 }) }],
            isError: false,
          };
        }
        return { content: [{ type: 'text', text: '{}' }], isError: false };
      },
    );
  }

  /** 사이드패널 Run 이 보내는 메시지를 배경 리스너에 직접 넣는다. */
  async function sidepanelRun(flowId: string): Promise<{ success: boolean; error?: string }> {
    vi.resetModules();
    const mod = await import('@/entrypoints/background/record-replay/index');
    mod.initRecordReplayListeners();
    await new Promise((r) => setTimeout(r, 0));
    const listeners = (
      chrome.runtime.onMessage.addListener as unknown as {
        mock: { calls: Array<[(m: unknown, s: unknown, r: unknown) => unknown]> };
      }
    ).mock.calls.map((c) => c[0]);

    return await new Promise((resolve) => {
      let answered = false;
      const sendResponse = (payload: { success: boolean; error?: string }) => {
        if (answered) return;
        answered = true;
        resolve(payload);
      };
      for (const fn of listeners) {
        fn(
          { type: BACKGROUND_MESSAGE_TYPES.RR_RUN_FLOW, flowId, tabId: RUN_TAB_ID },
          {},
          sendResponse,
        );
      }
    });
  }

  beforeEach(async () => {
    toolCalls = [];
    stub = installTabStub(
      [
        makeTab({ id: USER_TAB_ID, url: 'https://private.test/inbox', active: true, windowId: 1 }),
        makeTab({ id: RUN_TAB_ID, url: 'https://example.com/', windowId: 1 }),
      ],
      NEW_TAB_ID,
    );
    mocks.handleCallTool.mockReset();
    mocks.handleCallTool.mockImplementation(async (param: { name: string; args?: unknown }) => {
      toolCalls.push({ name: param?.name, args: (param?.args ?? {}) as Record<string, unknown> });
      return { content: [], isError: false };
    });
    mocks.engineRunFlow.mockReset();
    mocks.engineRunFlow.mockResolvedValue({
      runId: 'r1',
      success: true,
      summary: { total: 1, success: 1, failed: 0, tookMs: 1 },
      logs: [],
    });
    await clearStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ------------------------------------------------------- 엔진 본체(마지막 관문)
  it('엔진: 기존 흐름은 그대로 실행된다 (closeTab 이 run 탭을 닫는 1.13 동작 유지)', async () => {
    const result = await runFlow(legacyFlow(), runTab(), { returnLogs: true });

    expect(result.summary.failed).toBe(0);
    const closes = toolCalls.filter((c) => c.name === TOOL_NAMES.BROWSER.CLOSE_TABS);
    expect(closes).toHaveLength(1);
    expect(closes[0].args.tabIds).toEqual([RUN_TAB_ID]);
  });

  it('엔진: 새 기능을 요구하는 흐름은 한 단계도 실행하지 않고 던진다', async () => {
    await expect(runFlow(multitabFlow(), runTab(), { returnLogs: true })).rejects.toBeInstanceOf(
      FlowCompatError,
    );
    // 게이트가 먼저 서므로 탭을 건드리는 도구가 한 번도 불리지 않는다.
    expect(toolCalls).toEqual([]);
    expect(stub.removedTabs).toEqual([]);
  });

  // ------------------------------------------------------- MCP record_replay_flow_run
  it('MCP: 기존 흐름은 실행 함수까지 내려간다', async () => {
    await seed(legacyFlow());

    const outcome = await runPublishedFlow(
      { flowId: FLOW_ID, tabId: RUN_TAB_ID, toolName: 'record_replay_flow_run' },
      invoker(),
    );

    expect(outcome.ok).toBe(true);
    expect(mocks.engineRunFlow).toHaveBeenCalledTimes(1);
  });

  it('MCP: 새 기능을 요구하는 흐름은 탭을 잡기 전에 거부된다', async () => {
    await seed(multitabFlow());

    const outcome = await runPublishedFlow(
      { flowId: FLOW_ID, tabId: RUN_TAB_ID, toolName: 'record_replay_flow_run' },
      invoker(),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errorCode).toBe(FLOW_REQUIRES_NEWER_ENGINE);
    expect(outcome.error).toContain('업데이트');
    expect(mocks.engineRunFlow).not.toHaveBeenCalled();
    expect(toolCalls).toEqual([]);
  });

  // ------------------------------------------------------- 예약 실행(schedule-runner)
  //
  // 예약 러너는 `setScheduledFlowRunner(runPublishedFlow)` 로 **같은 함수**를 부른다
  // (entrypoints/background/tools/index.ts). 예약이 넘기는 인자 모양 그대로 확인한다.
  it('예약: 기존 흐름은 실행되고, 새 기능을 요구하는 흐름은 같은 코드로 거부된다', async () => {
    await seed(legacyFlow());
    const okOutcome = await runPublishedFlow(
      {
        flowId: FLOW_ID,
        tabId: RUN_TAB_ID,
        lane: 'flow:sched',
        mcpSessionId: 'scheduled',
        persistRun: false,
        timeoutMs: 120_000,
        toolName: 'record_replay_flow_run',
      },
      invoker(),
    );
    expect(okOutcome.ok).toBe(true);

    await clearStore();
    await seed(multitabFlow());
    const blocked = await runPublishedFlow(
      {
        flowId: FLOW_ID,
        tabId: RUN_TAB_ID,
        lane: 'flow:sched',
        mcpSessionId: 'scheduled',
        persistRun: false,
        timeoutMs: 120_000,
        toolName: 'record_replay_flow_run',
      },
      invoker(),
    );
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.errorCode).toBe(FLOW_REQUIRES_NEWER_ENGINE);
  });

  // ------------------------------------------------------- 사이드패널 Run
  it('사이드패널: 기존 흐름은 실행되고 새 기능 흐름은 같은 문구로 거부된다', async () => {
    await seed(legacyFlow());
    const okResponse = await sidepanelRun(FLOW_ID);
    expect(okResponse.success).toBe(true);
    expect(mocks.engineRunFlow).toHaveBeenCalledTimes(1);

    mocks.engineRunFlow.mockClear();
    await clearStore();
    await seed(multitabFlow());
    const blocked = await sidepanelRun(FLOW_ID);
    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain(FLOW_REQUIRES_NEWER_ENGINE);
    expect(blocked.error).toContain('업데이트');
    expect(mocks.engineRunFlow).not.toHaveBeenCalled();
  });
});
