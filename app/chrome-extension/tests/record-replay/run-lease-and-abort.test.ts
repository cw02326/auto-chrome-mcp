/**
 * run-lease-and-abort.test.ts
 *
 * 2026-09-05 Codex 검토 항목 3·4 의 회귀 테스트.
 *
 * 3. flow_run 이 바깥 잠금 없이 돌아 노드와 노드 사이에 잠금이 없다.
 *    → owner token 기반 재진입 lease (utils/tab-lock.ts).
 * 4. 워치독이 예산을 넘겨 끊어도 실행이 계속되는 좀비 run.
 *    → RunOptions.signal 을 스텝 경계·대기 루프까지 전파하고, abort 면 run_aborted 로
 *      끝내면서 run 이 만든 탭을 닫는다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';

import { withTabLease, withTabLock, hasTabLease } from '@/utils/tab-lock';

const RUN_TAB_ID = 99;
const NEW_TAB_ID = 500;

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
import { installTabStub, makeTab, type TabStub } from './_chrome-tab-stub';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('탭 리스 (항목 3)', () => {
  it('lease 중 외부 withTabLock 은 lease 가 끝날 때까지 기다린다', async () => {
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const lease = withTabLease(
      RUN_TAB_ID,
      'tok-a',
      async () => {
        order.push('run:start');
        await held;
        order.push('run:end');
      },
      { blockUntokenedCalls: true },
    );

    await tick();
    expect(hasTabLease(RUN_TAB_ID)).toBe(true);

    const external = withTabLock(RUN_TAB_ID, async () => {
      order.push('external');
    });

    await tick();
    expect(order).toEqual(['run:start']);

    release();
    await lease;
    await external;
    expect(order).toEqual(['run:start', 'run:end', 'external']);
    expect(hasTabLease(RUN_TAB_ID)).toBe(false);
  });

  it('같은 토큰의 재진입은 기다리지 않고 즉시 통과한다', async () => {
    const order: string[] = [];
    await withTabLease(
      98,
      'tok-b',
      async () => {
        order.push('run:start');
        await withTabLock(
          98,
          async () => {
            order.push('node');
          },
          { token: 'tok-b' },
        );
        order.push('run:end');
      },
      { blockUntokenedCalls: true },
    );
    expect(order).toEqual(['run:start', 'node', 'run:end']);
  });

  it('토큰이 틀리면 재진입이 아니라 대기다', async () => {
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const lease = withTabLease(
      97,
      'tok-c',
      async () => {
        await held;
        order.push('run:end');
      },
      { blockUntokenedCalls: true },
    );
    await tick();
    const other = withTabLock(
      97,
      async () => {
        order.push('other-session');
      },
      { token: 'tok-other' },
    );
    await tick();
    expect(order).toEqual([]);
    release();
    await lease;
    await other;
    expect(order).toEqual(['run:end', 'other-session']);
  });
});

describe('run abort (항목 4)', () => {
  let stub: TabStub;

  beforeEach(() => {
    stub = installTabStub(
      [makeTab({ id: RUN_TAB_ID, url: 'https://example.com/', windowId: 1 })],
      NEW_TAB_ID,
    );
    mocks.handleCallTool.mockReset();
    mocks.appendRun.mockReset();
    mocks.appendRun.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function flow() {
    return {
      id: 'flow_abort',
      name: 'abort',
      version: 1,
      variables: [],
      nodes: [
        { id: 'n1', type: 'openTab', config: { url: 'https://example.com/work' } },
        { id: 'n2', type: 'navigate', config: { url: 'https://example.com/go' } },
        { id: 'n3', type: 'extract', config: { selector: '#r', attr: 'text', saveAs: 'r' } },
      ],
      edges: [
        { from: 'n1', to: 'n2' },
        { from: 'n2', to: 'n3' },
      ],
      meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    } as never;
  }

  it('abort 하면 남은 스텝을 실행하지 않고 run_aborted 로 끝난다', async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    mocks.handleCallTool.mockImplementation(async (param: any) => {
      seen.push(param?.name);
      if (param?.name === TOOL_NAMES.BROWSER.NAVIGATE) controller.abort();
      return { content: [], isError: false };
    });

    const result = await runFlow(
      flow(),
      { tabId: RUN_TAB_ID, windowId: 1, source: 'mcp' },
      { returnLogs: true, signal: controller.signal },
    );

    expect(result.success).toBe(false);
    const messages = (result.logs || []).map((l) => l.message || '').join(' | ');
    expect(messages).toContain('run_aborted');
    // extract 스텝(세 번째)은 실행되지 않았다.
    expect(result.summary.total).toBeLessThan(3);
  });

  it('abort 정리는 run 이 만든 탭을 닫는다', async () => {
    const controller = new AbortController();
    mocks.handleCallTool.mockImplementation(async (param: any) => {
      if (param?.name === TOOL_NAMES.BROWSER.NAVIGATE) controller.abort();
      return { content: [], isError: false };
    });

    await runFlow(
      flow(),
      { tabId: RUN_TAB_ID, windowId: 1, source: 'mcp' },
      { returnLogs: true, signal: controller.signal },
    );

    expect(stub.removedTabs).toContain(NEW_TAB_ID);
    // 게이트가 준 작업 탭은 건드리지 않는다.
    expect(stub.removedTabs).not.toContain(RUN_TAB_ID);
  });

  it('이미 abort 된 signal 이면 한 스텝도 실행하지 않는다', async () => {
    mocks.handleCallTool.mockResolvedValue({ content: [], isError: false });
    const controller = new AbortController();
    controller.abort();

    const result = await runFlow(
      flow(),
      { tabId: RUN_TAB_ID, windowId: 1, source: 'mcp' },
      { returnLogs: true, signal: controller.signal },
    );

    expect(result.success).toBe(false);
    expect(result.summary.total).toBe(0);
    expect(stub.createdTabs).toEqual([]);
  });
});
