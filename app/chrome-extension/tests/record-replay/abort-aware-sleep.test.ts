/**
 * abort-aware-sleep.test.ts
 *
 * 2026-09-05 Codex 재확인 항목 3 의 회귀 테스트.
 *
 * hard abort 가 없었다. 스텝 경계에서만 취소를 확인했기 때문에, 고정 sleep 안에 들어간
 * run 은 abort 를 받고도 그 sleep 이 끝날 때까지 계속 돌았다(60초 delay 노드 하나면 60초).
 * 이제 sleep·delay·wait 루프가 전부 signal 을 본다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const RUN_TAB_ID = 4301;

const mocks = vi.hoisted(() => ({
  handleCallTool: vi.fn(),
  appendRun: vi.fn(),
}));

vi.mock('@/entrypoints/background/tools', () => ({
  handleCallTool: mocks.handleCallTool,
}));
vi.mock('@/entrypoints/background/record-replay/flow-store', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/entrypoints/background/record-replay/flow-store')>();
  return { ...actual, appendRun: mocks.appendRun };
});

import { runFlow } from '@/entrypoints/background/record-replay/engine/scheduler';
import { delayHandler } from '@/entrypoints/background/record-replay/actions/handlers/delay';
import { RunAbortedError, sleepWithSignal } from '@/utils/tool-watchdog';
import { installTabStub, makeTab, type TabStub } from './_chrome-tab-stub';

/** 60초 sleep 하나만 있는 흐름. abort 가 안 통하면 테스트가 60초 매달린다. */
function sleepFlow() {
  return {
    id: 'flow_sleep',
    name: 'sleep',
    version: 1,
    variables: [],
    nodes: [
      { id: 'n1', type: 'wait', config: { condition: { sleep: 60_000 } } },
      { id: 'n2', type: 'extract', config: { selector: '#r', attr: 'text', saveAs: 'r' } },
    ],
    edges: [{ from: 'n1', to: 'n2' }],
    meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  } as never;
}

describe('sleepWithSignal (항목 3)', () => {
  it('signal 이 없으면 그냥 시간을 기다린다', async () => {
    const t0 = Date.now();
    await sleepWithSignal(20);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
  });

  it('abort 되면 남은 시간을 기다리지 않고 즉시 reject 한다', async () => {
    const controller = new AbortController();
    const t0 = Date.now();
    const p = sleepWithSignal(60_000, controller.signal);
    setTimeout(() => controller.abort(new RunAbortedError('cancelled by test')), 10);
    await expect(p).rejects.toThrow(/run_aborted/);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('이미 abort 된 signal 이면 타이머를 걸지도 않는다', async () => {
    const controller = new AbortController();
    controller.abort(new RunAbortedError('already gone'));
    await expect(sleepWithSignal(60_000, controller.signal)).rejects.toThrow(/run_aborted/);
  });
});

describe('delay action handler (항목 3)', () => {
  it('실행 중 abort 되면 sleep 을 끝까지 기다리지 않는다', async () => {
    const controller = new AbortController();
    const ctx: any = {
      vars: {},
      tabId: RUN_TAB_ID,
      log: () => undefined,
      signal: controller.signal,
    };
    const t0 = Date.now();
    const p = delayHandler.run(ctx, { id: 'a1', type: 'delay', params: { sleep: 60_000 } } as any);
    setTimeout(() => controller.abort(new RunAbortedError('cancelled by test')), 10);
    const result = await p;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(result.status).toBe('failed');
  });
});

describe('run 중 hard abort (항목 3)', () => {
  let stub: TabStub;

  beforeEach(() => {
    stub = installTabStub([makeTab({ id: RUN_TAB_ID, url: 'https://example.com/', windowId: 1 })]);
    mocks.handleCallTool.mockReset();
    mocks.handleCallTool.mockResolvedValue({ content: [], isError: false });
    mocks.appendRun.mockReset();
    mocks.appendRun.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('60초 sleep 노드 중 abort 하면 곧바로 run_aborted 로 끝난다', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new RunAbortedError('cancelled by test')), 30);

    const t0 = Date.now();
    const result = await runFlow(
      sleepFlow(),
      { tabId: RUN_TAB_ID, windowId: 1, source: 'mcp' },
      { returnLogs: true, signal: controller.signal },
    );
    const took = Date.now() - t0;

    expect(took).toBeLessThan(3000);
    expect(result.success).toBe(false);
    const messages = (result.logs || []).map((l) => l.message || '').join(' | ');
    expect(messages).toContain('run_aborted');
    // 뒤따르는 extract 스텝은 실행되지 않았다.
    expect(stub.callsTo('scripting.executeScript')).toHaveLength(0);
  }, 15_000);
});
