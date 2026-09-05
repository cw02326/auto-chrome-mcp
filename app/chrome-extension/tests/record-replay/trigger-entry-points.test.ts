/**
 * trigger-entry-points.test.ts
 *
 * 2026-09-05 Codex 검토 항목 2 의 회귀 테스트.
 *
 * 사용자가 시작하지 않은 진입점(URL 트리거, DOM 트리거)이 사용자가 보고 있는 탭을 빌려
 * 자동 실행하면 안 된다. 이 둘은 세션 소유의 백그라운드 탭을 새로 열어 거기서 돌고,
 * 끝나면 닫는다. 사용자 탭에서 직접 돌리려면 흐름이 runInTriggeringTab 을 켜야 한다.
 *
 * 알람 스케줄(`rr_schedule_*`)은 2026-09-06(3단계)에 삭제됐다. 예약 엔진은
 * `chrome_shortcut` 쪽 하나로 통일됐고, 그쪽 회귀 테스트는 tests/utils/ 에 있다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_TAB_ID = 11;
const NEW_TAB_ID = 700;

const mocks = vi.hoisted(() => ({
  runFlow: vi.fn(),
  listTriggers: vi.fn(),
  getFlow: vi.fn(),
}));

vi.mock('@/entrypoints/background/record-replay/flow-runner', () => ({
  runFlow: mocks.runFlow,
}));
vi.mock('@/entrypoints/background/record-replay/trigger-store', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/entrypoints/background/record-replay/trigger-store')>();
  return { ...actual, listTriggers: mocks.listTriggers };
});
vi.mock('@/entrypoints/background/record-replay/flow-store', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/entrypoints/background/record-replay/flow-store')>();
  return {
    ...actual,
    getFlow: mocks.getFlow,
    appendRun: vi.fn(async () => undefined),
  };
});

import { installTabStub, makeTab, type TabStub } from './_chrome-tab-stub';

let stub: TabStub;

function flow(meta: Record<string, unknown> = {}) {
  return {
    id: 'trigger-flow',
    name: 'trigger flow',
    version: 1,
    variables: [],
    nodes: [{ id: 'n1', type: 'extract', config: { selector: '#r', attr: 'text', saveAs: 'r' } }],
    edges: [],
    meta: { createdAt: '', updatedAt: '', ...meta },
  };
}

/** 스텁을 설치한 뒤에 모듈을 불러야 모듈 최상단 알람 리스너가 스텁에 붙는다. */
async function loadModule() {
  vi.resetModules();
  const mod = await import('@/entrypoints/background/record-replay/index');
  mod.initRecordReplayListeners();
  // initTriggerEngine 등 최초 비동기 작업이 한 바퀴 돌게 둔다.
  await new Promise((r) => setTimeout(r, 0));
  return mod;
}

function navListeners(): Array<(d: any) => void> {
  return [...((chrome.webNavigation.onCommitted as any).listeners as Set<(d: any) => void>)];
}

function messageListeners(): Array<(m: any, s: any, r: any) => any> {
  return (chrome.runtime.onMessage.addListener as any).mock.calls.map((c: any[]) => c[0]);
}

/** runFlow 에 넘어간 RunTabContext. */
function runTabArg(index = 0) {
  return mocks.runFlow.mock.calls[index]?.[1];
}

describe('비사용자 진입점은 사용자 탭을 빌리지 않는다', () => {
  beforeEach(() => {
    stub = installTabStub(
      [makeTab({ id: USER_TAB_ID, url: 'https://shop.test/cart', active: true, windowId: 4 })],
      NEW_TAB_ID,
    );
    mocks.runFlow.mockReset();
    mocks.runFlow.mockResolvedValue({ runId: 'r', success: true, summary: {}, logs: [] });
    mocks.listTriggers.mockReset();
    mocks.listTriggers.mockResolvedValue([]);
    mocks.getFlow.mockReset();
    mocks.getFlow.mockResolvedValue(flow());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('URL 트리거는 세션 소유 백그라운드 탭을 열어 거기서 돌고 닫는다', async () => {
    mocks.listTriggers.mockResolvedValue([
      {
        id: 't1',
        type: 'url',
        flowId: 'trigger-flow',
        enabled: true,
        match: [{ kind: 'domain', value: 'shop.test' }],
      },
    ]);
    await loadModule();

    const before = stub.createdTabs.length;
    for (const fn of navListeners()) {
      await fn({ tabId: USER_TAB_ID, frameId: 0, url: 'https://shop.test/cart' });
    }
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.runFlow).toHaveBeenCalledTimes(1);
    const created = stub.createdTabs.slice(before);
    expect(created).toHaveLength(1);
    expect(created[0].active).toBe(false);
    expect(created[0].windowId).toBe(4);
    expect(created[0].url).toBe('https://shop.test/cart');

    expect(runTabArg().tabId).toBe(NEW_TAB_ID);
    expect(runTabArg().tabId).not.toBe(USER_TAB_ID);
    expect(stub.removedTabs).toContain(NEW_TAB_ID);
  });

  it('트리거가 만든 탭은 다시 트리거를 켜지 않는다 (재귀 차단)', async () => {
    // 새 탭도 같은 주소로 이동하므로 webNavigation 이 한 번 더 뜬다. 거르지 않으면
    // 트리거가 자기 자신을 켜서 탭이 무한히 늘어난다.
    mocks.listTriggers.mockResolvedValue([
      {
        id: 't1',
        type: 'url',
        flowId: 'trigger-flow',
        enabled: true,
        match: [{ kind: 'domain', value: 'shop.test' }],
      },
    ]);
    // 실행이 끝나기 전에 두 번째 이벤트가 오도록, runFlow 를 잠시 붙잡아 둔다.
    let releaseRun!: () => void;
    const running = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    mocks.runFlow.mockImplementation(async () => {
      await running;
      return { runId: 'r', success: true, summary: {}, logs: [] };
    });
    await loadModule();

    const fire = (tabId: number) =>
      Promise.all(
        navListeners().map((fn) => fn({ tabId, frameId: 0, url: 'https://shop.test/cart' })),
      );

    void fire(USER_TAB_ID);
    await new Promise((r) => setTimeout(r, 5));
    expect(stub.createdTabs).toHaveLength(1);

    // 방금 만들어진 탭에서 같은 이벤트가 뜬다.
    await fire(NEW_TAB_ID);
    await new Promise((r) => setTimeout(r, 5));

    // 탭도 실행도 늘지 않는다.
    expect(stub.createdTabs).toHaveLength(1);
    expect(mocks.runFlow).toHaveBeenCalledTimes(1);

    releaseRun();
    await new Promise((r) => setTimeout(r, 5));
  });

  it('흐름이 runInTriggeringTab 을 켠 경우에만 사용자 탭에서 직접 돈다', async () => {
    mocks.getFlow.mockResolvedValue(flow({ runInTriggeringTab: true }));
    mocks.listTriggers.mockResolvedValue([
      {
        id: 't1',
        type: 'url',
        flowId: 'trigger-flow',
        enabled: true,
        match: [{ kind: 'domain', value: 'shop.test' }],
      },
    ]);
    await loadModule();

    const before = stub.createdTabs.length;
    for (const fn of navListeners()) {
      await fn({ tabId: USER_TAB_ID, frameId: 0, url: 'https://shop.test/cart' });
    }
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.runFlow).toHaveBeenCalledTimes(1);
    expect(runTabArg().tabId).toBe(USER_TAB_ID);
    expect(stub.createdTabs.slice(before)).toEqual([]);
  });

  it('DOM 트리거도 새 백그라운드 탭에서 돈다', async () => {
    mocks.listTriggers.mockResolvedValue([
      { id: 'd1', type: 'dom', flowId: 'trigger-flow', enabled: true, selector: '#x' },
    ]);
    await loadModule();

    const listeners = messageListeners();
    const handler = listeners[listeners.length - 1];
    handler(
      { action: 'dom_trigger_fired', triggerId: 'd1' },
      { tab: { id: USER_TAB_ID, windowId: 4 } },
      () => {},
    );
    await new Promise((r) => setTimeout(r, 5));

    expect(mocks.runFlow).toHaveBeenCalledTimes(1);
    expect(runTabArg().tabId).toBe(NEW_TAB_ID);
    expect(stub.removedTabs).toContain(NEW_TAB_ID);
  });
});
