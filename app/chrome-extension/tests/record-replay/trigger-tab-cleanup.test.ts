/**
 * trigger-tab-cleanup.test.ts
 *
 * 2026-09-05 Codex 재확인 항목 5 의 회귀 테스트.
 *
 * 트리거 정리가 **가변** `target.tab.tabId` 를 봤다. 흐름이 실행 중 자기가 연 탭으로
 * 옮겨가면 그 값이 바뀌므로, 정리는 엉뚱하게 새 탭을 닫고 부트스트랩 탭과 재귀 가드
 * 항목은 그대로 남았다. 이제 생성 직후 캡처한 불변 id 로 닫고, run 이 연 다른 소유 탭도
 * 함께 치운다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_TAB_ID = 4501;
const BOOTSTRAP_TAB_ID = 750;
/** 흐름이 실행 중 스스로 연 탭 — run 소유다. */
const FLOW_TAB_ID = 751;

const mocks = vi.hoisted(() => ({
  runFlow: vi.fn(),
  listTriggers: vi.fn(),
  listSchedules: vi.fn(),
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
    listSchedules: mocks.listSchedules,
    getFlow: mocks.getFlow,
    appendRun: vi.fn(async () => undefined),
  };
});

import { installTabStub, makeTab, type TabStub } from './_chrome-tab-stub';
import {
  markRunOwnedTab,
  setRunTab,
  type RunTabContext,
} from '@/entrypoints/background/record-replay/engine/tab-context';

let stub: TabStub;

function flow() {
  return {
    id: 'trigger-flow',
    name: 'trigger flow',
    version: 1,
    variables: [],
    nodes: [{ id: 'n1', type: 'extract', config: { selector: '#r', attr: 'text', saveAs: 'r' } }],
    edges: [],
    meta: { createdAt: '', updatedAt: '' },
  };
}

async function loadModule() {
  vi.resetModules();
  const mod = await import('@/entrypoints/background/record-replay/index');
  mod.initRecordReplayListeners();
  await new Promise((r) => setTimeout(r, 0));
  return mod;
}

function navListeners(): Array<(d: any) => void> {
  return [...((chrome.webNavigation.onCommitted as any).listeners as Set<(d: any) => void>)];
}

describe('트리거 정리는 자기가 만든 탭을 닫는다 (항목 5)', () => {
  beforeEach(() => {
    stub = installTabStub(
      [makeTab({ id: USER_TAB_ID, url: 'https://shop.test/cart', active: true, windowId: 4 })],
      BOOTSTRAP_TAB_ID,
    );
    mocks.listTriggers.mockReset();
    mocks.listTriggers.mockResolvedValue([
      {
        id: 't1',
        type: 'url',
        flowId: 'trigger-flow',
        enabled: true,
        match: [{ kind: 'domain', value: 'shop.test' }],
      },
    ]);
    mocks.listSchedules.mockReset();
    mocks.listSchedules.mockResolvedValue([]);
    mocks.getFlow.mockReset();
    mocks.getFlow.mockResolvedValue(flow());

    // 흐름이 자기 탭을 열고 그리로 옮겨간다 — 정리가 봐야 할 id 는 그대로 부트스트랩 탭이다.
    mocks.runFlow.mockReset();
    mocks.runFlow.mockImplementation(async (_f: unknown, tab: RunTabContext) => {
      const created = await chrome.tabs.create({ url: 'https://shop.test/step2', active: false });
      markRunOwnedTab(tab, created.id as number);
      setRunTab(tab, created.id as number, created.windowId);
      return { runId: 'r', success: true, summary: {}, logs: [] };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('흐름이 탭을 옮겨도 부트스트랩 탭과 run 이 연 탭을 모두 닫는다', async () => {
    await loadModule();

    for (const fn of navListeners()) {
      await fn({ tabId: USER_TAB_ID, frameId: 0, url: 'https://shop.test/cart' });
    }
    await new Promise((r) => setTimeout(r, 10));

    expect(mocks.runFlow).toHaveBeenCalledTimes(1);
    // 예전 구현은 옮겨간 탭(FLOW_TAB_ID)만 닫고 부트스트랩 탭을 남겼다.
    expect(stub.removedTabs).toContain(BOOTSTRAP_TAB_ID);
    expect(stub.removedTabs).toContain(FLOW_TAB_ID);
    // 사용자 탭은 건드리지 않는다.
    expect(stub.removedTabs).not.toContain(USER_TAB_ID);
    expect(stub.liveTabs.has(BOOTSTRAP_TAB_ID)).toBe(false);
    expect(stub.liveTabs.has(FLOW_TAB_ID)).toBe(false);
  });

  it('부트스트랩 탭 id 는 재귀 가드에서도 풀린다', async () => {
    await loadModule();

    for (const fn of navListeners()) {
      await fn({ tabId: USER_TAB_ID, frameId: 0, url: 'https://shop.test/cart' });
    }
    await new Promise((r) => setTimeout(r, 10));

    // 정리가 끝난 뒤 같은 id 가 재사용되면 다시 트리거가 걸려야 한다 (가드 항목이 남아 있으면
    // 이 실행이 조용히 무시된다).
    stub.liveTabs.set(
      BOOTSTRAP_TAB_ID,
      makeTab({ id: BOOTSTRAP_TAB_ID, url: 'https://shop.test/cart', windowId: 4 }),
    );
    for (const fn of navListeners()) {
      await fn({ tabId: BOOTSTRAP_TAB_ID, frameId: 0, url: 'https://shop.test/cart' });
    }
    await new Promise((r) => setTimeout(r, 10));

    expect(mocks.runFlow).toHaveBeenCalledTimes(2);
  });
});
