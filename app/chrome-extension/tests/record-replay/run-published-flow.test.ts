/**
 * 공용 흐름 실행 함수 `runPublishedFlow` (2026-09-05 사이드패널 2단계 D).
 *
 * 도구(`record_replay_flow_run`)와 예약 러너가 **같은** 함수를 부른다. 그래서 이 함수가
 * 지키기로 한 것들이 깨지면 두 경로가 한꺼번에 깨진다. 다른 스위트는 도구 껍데기나 예약
 * 러너를 통해 이 함수를 간접적으로 보거나(도구), 아예 대역으로 바꿔 두는데(예약 러너 단위
 * 테스트), 그러면 아래 계약은 아무도 확인하지 않는다.
 *
 * 여기서는 **흐름 엔진(`runFlow`)만** 대역으로 바꾸고 나머지는 진짜를 쓴다.
 *
 * 이 파일이 못박는 것:
 *   (a) 작업 탭이 없고 흐름에 시작 URL 이 있으면 `chrome_navigate(background:true)` 로 탭을
 *       열고 `tabSource: 'created_from_start_url'` 로 알린다. 탭을 고르는 것은 이 함수가
 *       아니라 navigate 다.
 *   (b) 호출자가 준 마감(`timeoutMs`)과 **외부 취소 신호**가 둘 다 실행을 끊는다.
 *   (c) 어떤 경로로 끝나든 작업 탭 리스가 풀린다 (다음 실행이 그 탭을 쓸 수 있다).
 *   (d) `persistRun:false` 가 엔진까지 전달된다 (예약 실행의 이력 이중화 방지).
 *   (e) 작업 탭도 시작 URL 도 없으면 `no_work_tab` 이다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 흐름 엔진만 대역으로. 나머지(발행 목록·게이트·리스·마감)는 진짜를 쓴다. */
const engine = vi.hoisted(() => ({
  runFlow: vi.fn(),
}));

vi.mock('@/entrypoints/background/record-replay/flow-runner', () => ({
  runFlow: engine.runFlow,
}));

import { runPublishedFlow } from '@/entrypoints/background/record-replay/run-published-flow';
import { publishFlow, saveFlow } from '@/entrypoints/background/record-replay/flow-store';
import { IndexedDbStorage } from '@/entrypoints/background/record-replay/storage/indexeddb-manager';
import { hasTabLease } from '@/utils/tab-lock';
import type { ToolResult } from '@/common/tool-handler';
import type { Flow } from '@/entrypoints/background/record-replay/types';

const FLOW_ID = 'run-published-1';
const START_URL = 'https://example.com/start';
const CREATED_TAB = 4242;
const EXPLICIT_TAB = 77;

function makeFlow(over: Partial<Flow> = {}): Flow {
  return {
    id: FLOW_ID,
    name: '공용 실행 대상',
    version: 1,
    variables: [],
    startUrl: START_URL,
    nodes: [
      { id: 'n1', type: 'navigate', config: { url: START_URL } },
      { id: 'n2', type: 'click', config: { selector: '.go' } },
    ],
    edges: [{ id: 'e1', from: 'n1', to: 'n2', label: 'default' }],
    meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ...over,
  } as unknown as Flow;
}

const okResult = {
  runId: 'r1',
  success: true,
  summary: { total: 2, success: 2, failed: 0, tookMs: 5 },
  logs: [],
  outputs: null,
};

/** navigate 는 탭을 만들고, 나머지 도구는 조용히 성공한다. */
function makeInvoker(calls: any[]) {
  return vi.fn(async (call: any): Promise<ToolResult> => {
    calls.push(call);
    if (call.name === 'chrome_navigate') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ tabId: CREATED_TAB, windowId: 1 }) }],
        isError: false,
      };
    }
    return { content: [{ type: 'text', text: '{}' }], isError: false };
  });
}

function stubChrome(): void {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const area = (store: Record<string, unknown>) => ({
    get: vi.fn(async () => ({ ...store })),
    set: vi.fn(async (obj: Record<string, unknown>) => Object.assign(store, obj)),
    remove: vi.fn(async () => undefined),
  });
  vi.stubGlobal('chrome', {
    runtime: { id: 'test', sendMessage: vi.fn().mockResolvedValue(undefined) },
    storage: { local: area(local), session: area(session) },
    tabs: {
      get: vi.fn(async (tabId: number) => ({ id: tabId, windowId: 1, url: START_URL })),
      create: vi.fn(async () => ({ id: CREATED_TAB, windowId: 1 })),
      remove: vi.fn(async () => undefined),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
}

async function seed(flow: Flow): Promise<void> {
  await saveFlow(flow, { notify: false });
  await publishFlow(flow);
}

async function clearStore(): Promise<void> {
  for (const f of await IndexedDbStorage.flows.list()) await IndexedDbStorage.flows.delete(f.id);
  for (const p of await IndexedDbStorage.published.list())
    await IndexedDbStorage.published.delete(p.id);
}

beforeEach(async () => {
  stubChrome();
  engine.runFlow.mockReset();
  engine.runFlow.mockResolvedValue(okResult);
  await clearStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runPublishedFlow', () => {
  it('(a) 작업 탭이 없으면 시작 URL 로 백그라운드 작업 탭을 연다', async () => {
    await seed(makeFlow());
    const calls: any[] = [];

    const outcome = await runPublishedFlow(
      { flowId: FLOW_ID, mcpSessionId: 'scheduled', lane: 'flow:x' },
      makeInvoker(calls),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.tabSource).toBe('created_from_start_url');
    expect(outcome.tabId).toBe(CREATED_TAB);
    expect(outcome.flowName).toBe('공용 실행 대상');

    // 탭을 만드는 주체는 chrome_navigate 다. 이 함수가 탭을 고르지 않는다.
    const navigate = calls.find((c) => c.name === 'chrome_navigate');
    expect(navigate).toBeTruthy();
    expect(navigate.args).toMatchObject({
      url: START_URL,
      background: true,
      _mcpSessionId: 'scheduled',
      lane: 'flow:x',
    });
    expect(navigate.effectiveBackgroundMode).toBe(true);

    // 방금 연 시작 페이지로 다시 가는 첫 단계는 빠진다.
    const flowRan = engine.runFlow.mock.calls[0][0];
    expect(flowRan.nodes.map((n: any) => n.id)).toEqual(['n2']);
  });

  it('(c·d) 리스를 풀고 persistRun·마감을 엔진에 전달한다', async () => {
    await seed(makeFlow());

    const outcome = await runPublishedFlow(
      { flowId: FLOW_ID, persistRun: false, timeoutMs: 5_000 },
      makeInvoker([]),
    );

    expect(outcome.ok).toBe(true);
    const options = engine.runFlow.mock.calls[0][2];
    expect(options.persistRun).toBe(false);
    expect(options.timeoutMs).toBe(5_000);
    expect(options.startUrl).toBe(START_URL);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    // 실행이 끝나면 다음 실행이 이 탭을 쓸 수 있어야 한다.
    expect(hasTabLease(CREATED_TAB)).toBe(false);
  });

  it('(c) 엔진이 던져도 리스가 남지 않는다', async () => {
    await seed(makeFlow());
    engine.runFlow.mockRejectedValue(new Error('engine exploded'));

    await expect(runPublishedFlow({ flowId: FLOW_ID }, makeInvoker([]))).rejects.toThrow(
      /engine exploded/,
    );

    expect(hasTabLease(CREATED_TAB)).toBe(false);
  });

  it('(b) 외부 취소 신호가 실행을 끊는다', async () => {
    await seed(makeFlow());
    const outer = new AbortController();
    let seenSignal: AbortSignal | undefined;
    engine.runFlow.mockImplementation(async (_flow: any, _tab: any, options: any) => {
      seenSignal = options.signal;
      outer.abort('user stopped');
      return okResult;
    });

    await runPublishedFlow({ flowId: FLOW_ID, signal: outer.signal }, makeInvoker([]));

    // 예약 러너의 120초 예산이 이 자리로 들어온다. 엔진이 보는 신호가 함께 끊겨야 한다.
    expect(seenSignal?.aborted).toBe(true);
  });

  it('(b) 호출자가 준 마감이 지나면 엔진 신호가 끊긴다', async () => {
    await seed(makeFlow());
    let seenSignal: AbortSignal | undefined;
    engine.runFlow.mockImplementation(async (_flow: any, _tab: any, options: any) => {
      seenSignal = options.signal;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return okResult;
    });

    await runPublishedFlow({ flowId: FLOW_ID, timeoutMs: 20 }, makeInvoker([]));

    expect(seenSignal?.aborted).toBe(true);
  });

  it('(a) 호출자가 tabId 를 주면 그 탭에서 돌고 navigate 를 부르지 않는다', async () => {
    await seed(makeFlow());
    const calls: any[] = [];

    const outcome = await runPublishedFlow(
      { flowId: FLOW_ID, tabId: EXPLICIT_TAB },
      makeInvoker(calls),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.tabId).toBe(EXPLICIT_TAB);
    expect(outcome.tabSource).toBe('explicit');
    expect(calls.find((c) => c.name === 'chrome_navigate')).toBeUndefined();
    // 방금 연 탭이 아니므로 첫 navigate 단계는 그대로 남는다.
    expect(engine.runFlow.mock.calls[0][0].nodes).toHaveLength(2);
  });

  it('(e) 작업 탭도 시작 URL 도 없으면 no_work_tab 이다', async () => {
    await seed(makeFlow({ startUrl: undefined }));

    const outcome = await runPublishedFlow({ flowId: FLOW_ID }, makeInvoker([]));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errorCode).toBe('no_work_tab');
    expect(engine.runFlow).not.toHaveBeenCalled();
  });

  it('발행되지 않은 흐름은 실행하지 않는다', async () => {
    await saveFlow(makeFlow(), { notify: false });

    const outcome = await runPublishedFlow({ flowId: FLOW_ID }, makeInvoker([]));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errorCode).toBe('flow_not_published');
    expect(engine.runFlow).not.toHaveBeenCalled();
  });
});
