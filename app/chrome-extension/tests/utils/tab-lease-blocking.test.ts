/**
 * tab-lease-blocking.test.ts
 *
 * 2026-09-05 Codex 재확인 항목 1 의 회귀 테스트.
 *
 * 1. 리스 차단 모드가 꺼져 있었다. `tools/index.ts` 가 `args._leaseToken` 을
 *    `withTabLock` 에 넘기지 않아, 켜면 run 이 자기 리스에 막혀 교착했기 때문이다.
 *    → 파이프라인이 토큰을 넘기고(도구에는 넘기지 않는다), 차단 모드를 켠다.
 * 2. 겹치는 비차단 리스가 역순으로 끝나면 먼저 끝난 쪽의 토큰이 보유자로 되살아나
 *    영영 남았다(stale owner). → 보유자를 스택으로 관리한다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TOOL_NAMES } from 'auto-chrome-mcp-shared';

import {
  LEASE_BLOCKS_UNTOKENED_CALLS,
  LEASE_TOKEN_ARG,
  getTabLeaseOwner,
  hasTabLease,
  withTabLease,
  withTabLock,
} from '@/utils/tab-lock';

const B = TOOL_NAMES.BROWSER;

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('리스 보유자 스택 (항목 1)', () => {
  it('차단 모드가 기본으로 켜져 있다', () => {
    expect(LEASE_BLOCKS_UNTOKENED_CALLS).toBe(true);
  });

  it('겹치는 비차단 리스가 역순으로 끝나면 보유자가 남지 않는다', async () => {
    const TAB = 4101;
    let releaseA!: () => void;
    let releaseB!: () => void;
    const heldA = new Promise<void>((r) => {
      releaseA = r;
    });
    const heldB = new Promise<void>((r) => {
      releaseB = r;
    });

    const leaseA = withTabLease(TAB, 'tok-a', async () => heldA, {
      blockUntokenedCalls: false,
    });
    await tick();
    const leaseB = withTabLease(TAB, 'tok-b', async () => heldB, {
      blockUntokenedCalls: false,
    });
    await tick();
    expect(getTabLeaseOwner(TAB)).toBe('tok-b');

    // 먼저 시작한 A 가 먼저 끝난다 (역순 종료).
    releaseA();
    await leaseA;
    await tick();
    // B 는 아직 돌고 있으므로 보유자는 B 다.
    expect(getTabLeaseOwner(TAB)).toBe('tok-b');

    releaseB();
    await leaseB;
    await tick();
    // 예전 구현은 여기서 'tok-a' 가 되살아나 영영 남았다.
    expect(getTabLeaseOwner(TAB)).toBeUndefined();
    expect(hasTabLease(TAB)).toBe(false);
  });

  it('옵션을 주지 않아도 바깥의 토큰 없는 호출은 리스가 끝날 때까지 기다린다', async () => {
    const TAB = 4102;
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });

    const lease = withTabLease(TAB, 'tok-default', async () => {
      order.push('run:start');
      await held;
      order.push('run:end');
    });
    await tick();

    const outside = withTabLock(TAB, async () => {
      order.push('outside');
    });
    await tick();
    expect(order).toEqual(['run:start']);

    release();
    await lease;
    await outside;
    expect(order).toEqual(['run:start', 'run:end', 'outside']);
    expect(hasTabLease(TAB)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 파이프라인이 토큰을 넘기는가 (항목 1)
// ---------------------------------------------------------------------------

const WORK_TAB = {
  id: 4201,
  windowId: 2,
  url: 'https://target.test/page',
  title: 'work',
  active: false,
  status: 'complete',
};

function installChrome(): void {
  const store: Record<string, unknown> = {};
  const toKeys = (keys: unknown): string[] =>
    Array.isArray(keys) ? (keys as string[]) : typeof keys === 'string' ? [keys] : [];
  const makeArea = () => ({
    get: vi.fn(async (keys: unknown) => {
      const out: Record<string, unknown> = {};
      for (const key of toKeys(keys)) if (key in store) out[key] = store[key];
      return out;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(store, items);
    }),
    remove: vi.fn(async (keys: unknown) => {
      for (const key of toKeys(keys)) delete store[key];
    }),
  });
  const listener = () => ({ addListener: vi.fn(), removeListener: vi.fn() });

  (globalThis as any).chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: undefined,
      getURL: (p: string) => `chrome-extension://test/${p}`,
      onMessage: listener(),
    },
    storage: { local: makeArea(), session: makeArea() },
    tabs: {
      query: vi.fn(async () => [WORK_TAB]),
      get: vi.fn(async (id: number) => {
        if (id !== WORK_TAB.id) throw new Error(`No tab with id: ${id}`);
        return WORK_TAB;
      }),
      create: vi.fn(async () => ({ ...WORK_TAB, id: 9999 })),
      update: vi.fn(async () => WORK_TAB),
      remove: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => ({ success: true })),
      group: vi.fn(async () => 100),
      ungroup: vi.fn(async () => undefined),
      onRemoved: listener(),
      onCreated: listener(),
      onUpdated: listener(),
    },
    tabGroups: {
      query: vi.fn(async () => []),
      get: vi.fn(async () => ({ id: 100, title: 'MCP', color: 'green', windowId: 1 })),
      update: vi.fn(async () => ({})),
      move: vi.fn(async () => undefined),
      TAB_GROUP_ID_NONE: -1,
      onCreated: listener(),
      onRemoved: listener(),
      onUpdated: listener(),
    },
    windows: {
      get: vi.fn(async (id: number) => ({ id, type: 'normal' })),
      getAll: vi.fn(async () => [{ id: 1, type: 'normal' }]),
      getLastFocused: vi.fn(async () => ({ id: 1, type: 'normal' })),
      create: vi.fn(async () => ({ id: 100, type: 'normal', tabs: [] })),
      update: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      onRemoved: listener(),
      onFocusChanged: listener(),
      WINDOW_ID_NONE: -1,
    },
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
      setTitle: vi.fn(async () => undefined),
    },
    scripting: { executeScript: vi.fn(async () => [{ result: 'ok' }]) },
    debugger: {
      getTargets: vi.fn(async () => []),
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async () => ({})),
      onEvent: listener(),
      onDetach: listener(),
    },
    downloads: { search: vi.fn(async () => []), onCreated: listener(), onChanged: listener() },
    webNavigation: {
      onCommitted: listener(),
      onDOMContentLoaded: listener(),
      onCompleted: listener(),
      onCreatedNavigationTarget: listener(),
      onErrorOccurred: listener(),
    },
    webRequest: {
      onBeforeRequest: listener(),
      onBeforeSendHeaders: listener(),
      onSendHeaders: listener(),
      onHeadersReceived: listener(),
      onCompleted: listener(),
      onErrorOccurred: listener(),
    },
    declarativeNetRequest: {
      updateDynamicRules: vi.fn(async () => undefined),
      getDynamicRules: vi.fn(async () => []),
    },
  };
}

/**
 * `vi.resetModules()` 뒤에는 도구 파이프라인이 **새로 만들어진** tab-lock 모듈을 쓴다.
 * 리스도 그 인스턴스에 걸어야 같은 잠금 테이블을 보므로, 여기서 함께 받아 온다.
 */
async function harness() {
  const toolsModule = await import('@/entrypoints/background/tools/index');
  const lockModule = await import('@/utils/tab-lock');
  const { webFetcherTool } = await import('@/entrypoints/background/tools/browser/web-fetcher');
  const seenArgs: any[] = [];
  vi.spyOn(webFetcherTool as any, 'execute').mockImplementation(async (args: any) => {
    seenArgs.push(args);
    return { content: [{ type: 'text', text: '{}' }], isError: false };
  });
  return {
    handleCallTool: toolsModule.handleCallTool as any,
    withTabLease: lockModule.withTabLease,
    seenArgs,
  };
}

describe('도구 파이프라인이 리스 토큰을 넘긴다 (항목 1)', () => {
  beforeEach(() => {
    vi.resetModules();
    installChrome();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('토큰을 실은 호출은 리스 보유 중에도 즉시 실행된다', async () => {
    const { handleCallTool, withTabLease, seenArgs } = await harness();
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });

    let done = false;
    const lease = withTabLease(WORK_TAB.id, 'flow_run_tok', async () => {
      // run 안에서 노드가 부르는 도구 호출 — 자기 리스에 막히면 안 된다.
      await handleCallTool({
        name: B.WEB_FETCHER,
        args: { tabId: WORK_TAB.id, [LEASE_TOKEN_ARG]: 'flow_run_tok' },
      });
      done = true;
      await held;
    });

    await tick();
    expect(done).toBe(true);
    // 리스 토큰은 내부 전용이다 — 도구 구현에는 넘어가지 않는다.
    expect(seenArgs).toHaveLength(1);
    expect(LEASE_TOKEN_ARG in seenArgs[0]).toBe(false);

    release();
    await lease;
  });

  it('토큰 없는 바깥 호출은 리스가 끝날 때까지 기다린다', async () => {
    const { handleCallTool, withTabLease, seenArgs } = await harness();
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });

    const lease = withTabLease(WORK_TAB.id, 'flow_run_tok2', async () => {
      await held;
    });
    await tick();

    const outside = handleCallTool({ name: B.WEB_FETCHER, args: { tabId: WORK_TAB.id } });
    await tick();
    expect(seenArgs).toHaveLength(0);

    release();
    await lease;
    await outside;
    expect(seenArgs).toHaveLength(1);
  });
});
