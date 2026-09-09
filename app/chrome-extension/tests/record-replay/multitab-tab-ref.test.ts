/**
 * multitab-tab-ref.test.ts
 *
 * 여러 탭 재생의 안전 규칙 (2026-09-09 설계 2부, 같은 날 축소 개정).
 *
 * 축소 결정: **재생은 탭을 직접 연다. 남의 탭을 주워 오지 않는다.** 브라우저는 "이 클릭이
 * 이 탭을 만들었다" 는 인과를 알려 주지 않으므로, 클릭 뒤에 뜬 탭을 흡수하던 기계를 통째로
 * 없앴다. 논리 번호가 실제 탭에 묶이는 경로는 `openTab` 실행 하나뿐이다.
 *
 * 이 파일이 못박는 것:
 *   (a) `openTab{tabRef}` 이 묶은 번호로 `switchTab` 이 옮겨 간다.
 *   (b) 묶이지 않은 번호는 조용히 넘어가지 않고 `tab_ref_unbound` 로 멈춘다.
 *   (c) **재생 중 사용자가 연 탭·페이지가 연 탭은 어떤 경우에도 흐름 대상이 되지 않는다.**
 *   (d) 번호가 묶이는 코드 경로는 `openTab` 하나뿐이다.
 *   (e) 같은 입력에 nodes 경로와 actions 어댑터 경로가 같은 판정을 낸다.
 *   (f) `tabRef` 가 없는 기존 흐름은 그대로 동작한다.
 *
 * 불변식(설계 2.0): I1 run 은 자기 탭과 자기가 만든 것으로 확인된 탭 밖으로 나가지 않는다.
 * I2 url·title 로 탭을 고르지 않는다. I3a 재생은 탭 활성화·창 포커스를 요청하지 않는다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';

const USER_TAB_ID = 11; // 사용자가 보고 있는 탭
const RUN_TAB_ID = 99; // run 이 고정된 탭
const NEW_TAB_ID = 500; // openTab 이 만드는 첫 탭

const mocks = vi.hoisted(() => ({
  handleCallTool: vi.fn(),
  appendRun: vi.fn(),
  getFlow: vi.fn(),
}));

vi.mock('@/entrypoints/background/tools', () => ({
  handleCallTool: mocks.handleCallTool,
}));
vi.mock('@/entrypoints/background/record-replay/flow-store', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/entrypoints/background/record-replay/flow-store')>();
  return { ...actual, appendRun: mocks.appendRun, getFlow: mocks.getFlow };
});

import { runFlow } from '@/entrypoints/background/record-replay/engine/scheduler';
import type { RunTabContext } from '@/entrypoints/background/record-replay/engine/tab-context';
import { installTabStub, makeTab, type TabStub } from './_chrome-tab-stub';

interface ToolCall {
  name: string;
  args: Record<string, any>;
}

let stub: TabStub;
let toolCalls: ToolCall[];

function flowOf(nodes: Array<Record<string, unknown>>) {
  const edges = nodes.slice(1).map((n, i) => ({ from: String(nodes[i].id), to: String(n.id) }));
  return {
    id: 'flow_multitab',
    name: 'multitab',
    version: 1,
    variables: [],
    nodes,
    edges,
    meta: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // 이 흐름은 여러 탭 기능을 쓴다. 게이트가 지원 목록·최소 버전과 대조한다.
      features: ['multitab'],
    },
  } as never;
}

function runTab(over: Partial<RunTabContext> = {}): RunTabContext {
  return { tabId: RUN_TAB_ID, windowId: 1, source: 'mcp', ...over } as RunTabContext;
}

function messagesOf(result: { logs?: Array<{ message?: string }> }): string {
  return (result.logs || []).map((l) => l.message || '').join(' | ');
}

/**
 * 실제로 닫으라고 지시된 탭 id 들.
 *
 * nodes 경로는 `chrome_close_tabs` 도구를 거치고 actions 경로는 `chrome.tabs.remove` 를
 * 직접 부른다. 두 경로를 같은 눈으로 보기 위해 둘을 합친다.
 */
function closedTabIds(): number[] {
  const viaTool = toolCalls
    .filter((c) => c.name === TOOL_NAMES.BROWSER.CLOSE_TABS)
    .flatMap((c) => (Array.isArray(c.args.tabIds) ? (c.args.tabIds as number[]) : []));
  return [...viaTool, ...stub.removedTabs];
}

/** 두 실행기를 같은 입력으로 돌린다 (설계 2.7 의 판정 일치 확인). */
const EXECUTORS: Array<{ label: string; mode?: 'legacy' | 'actions' }> = [
  { label: 'nodes 경로', mode: 'legacy' },
  { label: 'actions 어댑터 경로', mode: 'actions' },
];

describe('여러 탭: 번호는 openTab 으로만 묶인다', () => {
  beforeEach(() => {
    toolCalls = [];
    stub = installTabStub(
      [
        makeTab({ id: USER_TAB_ID, url: 'https://private.test/inbox', active: true, windowId: 1 }),
        makeTab({ id: RUN_TAB_ID, url: 'https://example.com/', windowId: 1 }),
      ],
      NEW_TAB_ID,
    );
    mocks.handleCallTool.mockReset();
    mocks.handleCallTool.mockImplementation(async (param: any) => {
      toolCalls.push({ name: param?.name, args: param?.args ?? {} });
      return { content: [], isError: false };
    });
    mocks.appendRun.mockReset();
    mocks.appendRun.mockResolvedValue(undefined);
    mocks.getFlow.mockReset();
    // 게이트는 설치된 확장 버전을 매니페스트에서 읽는다. 여러 탭 기능이 들어온 버전이다.
    (
      globalThis as unknown as { chrome: { runtime: Record<string, unknown> } }
    ).chrome.runtime.getManifest = () => ({ version: '1.14.0' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const { label, mode } of EXECUTORS) {
    it(`(a)(e) ${label}: openTab{tabRef} 이 묶은 번호로 switchTab 이 옮겨 간다`, async () => {
      const tab = runTab();
      const result = await runFlow(
        flowOf([
          { id: 'n1', type: 'openTab', config: { url: 'https://example.com/next', tabRef: 1 } },
          { id: 'n2', type: 'switchTab', config: { tabRef: 0 } },
          { id: 'n3', type: 'switchTab', config: { tabRef: 1 } },
        ]),
        tab,
        { returnLogs: true, executionMode: mode },
      );

      expect(messagesOf(result)).not.toContain('tab_ref');
      expect(result.summary.failed).toBe(0);
      // 0번은 흐름을 시작한 탭, 1번은 이 run 이 연 탭이다.
      expect(tab.tabId).toBe(NEW_TAB_ID);
      // I3a: 활성화 도구는 한 번도 부르지 않는다.
      expect(toolCalls.filter((c) => c.name === TOOL_NAMES.BROWSER.SWITCH_TAB)).toEqual([]);
      expect(stub.liveTabs.get(NEW_TAB_ID)?.active).toBe(false);
    });

    it(`(b)(e) ${label}: 묶이지 않은 tabRef 는 tab_ref_unbound 로 멈춘다`, async () => {
      const result = await runFlow(
        flowOf([{ id: 'n1', type: 'switchTab', config: { tabRef: 3 } }]),
        runTab(),
        { returnLogs: true, executionMode: mode },
      );

      expect(result.summary.failed).toBe(1);
      expect(messagesOf(result)).toContain('tab_ref_unbound');
      // 사용자 탭은 건드리지 않았다 (I1).
      expect(stub.touches.filter((t) => t.tabId === USER_TAB_ID)).toEqual([]);
      expect(stub.callsTo('tabs.query')).toEqual([]);
    });

    it(`(c)(e) ${label}: 실행 **도중** run 탭이 연 남의 탭도 흐름 대상이 되지 않는다`, async () => {
      const tab = runTab();
      // openTab 이 도는 사이에, run 탭을 opener 로 하는 탭이 하나 더 생긴다. 사용자가
      // 직접 연 링크이거나 페이지가 띄운 광고 탭이다. 재생은 이런 탭을 주워 오지 않는다.
      let intruder = -1;
      stub.onTabCreated = (created) => {
        if (intruder !== -1) return;
        intruder = 900;
        stub.liveTabs.set(
          intruder,
          makeTab({
            id: intruder,
            url: 'https://ads.test/popup',
            windowId: 1,
            openerTabId: created.id,
          }),
        );
      };

      const result = await runFlow(
        flowOf([
          { id: 'n1', type: 'openTab', config: { url: 'https://example.com/next', tabRef: 1 } },
          { id: 'n2', type: 'switchTab', config: { tabRef: 1 } },
          // 2번은 어떤 openTab 도 만들지 않았다. 방금 생긴 남의 탭을 주워 오지 않는다.
          { id: 'n3', type: 'switchTab', config: { tabRef: 2 } },
        ]),
        tab,
        { returnLogs: true, executionMode: mode },
      );

      expect(intruder).toBe(900);
      expect(result.summary.failed).toBe(1);
      expect(messagesOf(result)).toContain('tab_ref_unbound');
      // 소유·번호·도구 호출 어디에도 들어가지 않았다.
      expect(tab.ownedTabIds?.has(intruder)).toBe(false);
      expect([...(tab.tabState?.tabRefs.values() ?? [])]).not.toContain(intruder);
      expect(stub.touches.filter((t) => t.tabId === intruder)).toEqual([]);
      expect(toolCalls.filter((c) => c.args?.tabId === intruder)).toEqual([]);
      expect(stub.removedTabs).not.toContain(intruder);
    });

    it(`(e) ${label}: closeTab{tabRef} 은 그 탭만 닫고, 묶이지 않았으면 현재 탭 폴백을 타지 않는다`, async () => {
      const closed = await runFlow(
        flowOf([
          { id: 'n1', type: 'openTab', config: { url: 'https://example.com/next', tabRef: 1 } },
          { id: 'n2', type: 'closeTab', config: { tabRef: 1 } },
        ]),
        runTab(),
        { returnLogs: true, executionMode: mode },
      );
      expect(closed.summary.failed).toBe(0);
      expect(closedTabIds()).toEqual([NEW_TAB_ID]);

      const unbound = await runFlow(
        flowOf([{ id: 'n1', type: 'closeTab', config: { tabRef: 7 } }]),
        runTab(),
        { returnLogs: true, executionMode: mode },
      );
      expect(unbound.summary.failed).toBe(1);
      expect(messagesOf(unbound)).toContain('tab_ref_unbound');
      // 여기가 이 기능의 대표 사고 지점이다: run 탭이 닫히면 안 된다.
      expect(closedTabIds()).toEqual([NEW_TAB_ID]);
      expect(stub.liveTabs.has(RUN_TAB_ID)).toBe(true);
    });

    it(`(f)(e) ${label}: tabRef 가 없는 기존 흐름은 그대로 동작한다`, async () => {
      const tab = runTab();
      const ok = await runFlow(
        flowOf([
          { id: 'n1', type: 'openTab', config: { url: 'https://example.com/next' } },
          { id: 'n2', type: 'switchTab', config: { tabId: RUN_TAB_ID } },
        ]),
        tab,
        { returnLogs: true, executionMode: mode },
      );
      expect(ok.summary.failed).toBe(0);
      expect(tab.tabId).toBe(RUN_TAB_ID);

      // url 전역 검색은 여전히 거절된다 (I2).
      const refused = await runFlow(
        flowOf([{ id: 'n1', type: 'switchTab', config: { urlContains: 'private.test' } }]),
        runTab(),
        { returnLogs: true, executionMode: mode },
      );
      expect(refused.summary.failed).toBe(1);
      expect(messagesOf(refused)).toContain('tab_scope_violation');
      expect(stub.callsTo('tabs.query')).toEqual([]);
    });
  }

  it('같은 번호를 두 번 묶으려 하면 tab_ref_conflict', async () => {
    const result = await runFlow(
      flowOf([
        { id: 'n1', type: 'openTab', config: { url: 'https://example.com/a', tabRef: 1 } },
        { id: 'n2', type: 'openTab', config: { url: 'https://example.com/b', tabRef: 1 } },
      ]),
      runTab(),
      { returnLogs: true },
    );

    expect(result.summary.failed).toBe(1);
    expect(messagesOf(result)).toContain('tab_ref_conflict');
  });

  it('0번은 유효한 번호다 (truthy 검사로 걸러지지 않는다)', async () => {
    const tab = runTab();
    const result = await runFlow(
      flowOf([
        { id: 'n1', type: 'openTab', config: { url: 'https://example.com/next', tabRef: 1 } },
        { id: 'n2', type: 'switchTab', config: { tabRef: 0 } },
      ]),
      tab,
      { returnLogs: true },
    );

    expect(result.summary.failed).toBe(0);
    expect(tab.tabId).toBe(RUN_TAB_ID);
  });

  it('(C7) 여러 탭 흐름을 다른 흐름 안에 끼워 넣어 실행하면 거절한다', async () => {
    // inline 은 자식 단계를 부모 컨텍스트로 돌린다. 번호 이름 공간이 겹쳐 조작이 엉뚱한
    // 탭에서 일어날 수 있으므로, 추측하지 않고 멈춘다.
    mocks.getFlow.mockResolvedValue({
      id: 'child',
      name: '자식',
      version: 1,
      nodes: [{ id: 'c1', type: 'switchTab', config: { tabRef: 1 } }],
      edges: [],
      meta: { createdAt: '', updatedAt: '', features: ['multitab'] },
    });

    const result = await runFlow(
      flowOf([{ id: 'n1', type: 'executeFlow', config: { flowId: 'child', inline: true } }]),
      runTab(),
      { returnLogs: true },
    );

    expect(result.summary.failed).toBe(1);
    expect(messagesOf(result)).toContain('multitab_inline_unsupported');
  });
});

/**
 * (d) 번호가 묶이는 코드 경로가 하나뿐임을 소스로 고정한다.
 *
 * 이것이 이 기능의 안전 규칙 전부다. `bindTabRef` 뿐 아니라 **`tabRefs.set` 직접 호출**도
 * 함께 본다. 별칭이나 직접 대입으로 새 묶기 경로가 생기면 여기서 걸린다.
 */
describe('번호를 묶는 코드 경로는 openTab 하나뿐이다', () => {
  it('bindTabRef 와 tabRefs.set 은 허용된 자리에만 있다', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const root = path.resolve(__dirname, '../../entrypoints/background/record-replay');

    const files: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith('.ts')) files.push(full);
      }
    }
    await walk(root);

    /**
     * 번호를 묶어도 되는 자리.
     *
     *   - `nodes/tabs.ts` · `actions/handlers/tabs.ts`: `openTab` 실행기 (bindTabRef)
     *   - `engine/tab-context.ts`: `bindTabRef` 정의부 자신
     *   - `engine/scheduler.ts`: 흐름을 시작한 탭을 0번으로 등록
     *   - `recording/session-manager.ts`: **녹화** 쪽 번호표(재생과 별개 객체)
     */
    const ALLOWED = new Set([
      'nodes/tabs.ts',
      'actions/handlers/tabs.ts',
      'engine/tab-context.ts',
      'engine/scheduler.ts',
      'recording/session-manager.ts',
    ]);

    const binders: string[] = [];
    for (const file of files) {
      const rel = path.relative(root, file).split(path.sep).join('/');
      const source = await fs.readFile(file, 'utf-8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      if (/\bbindTabRef\s*\(/.test(code) || /tabRefs\.set\s*\(/.test(code)) binders.push(rel);
      // 없앤 기계가 되살아나지 않았는지도 함께 본다.
      expect(code).not.toMatch(
        /armNewTabExpectation|settleNewTabExpectation|opensTab|pendingOpenTabRef|matchesPendingOpenTab/,
      );
    }

    expect(binders.filter((rel) => !ALLOWED.has(rel))).toEqual([]);
    // 재생 쪽 묶기는 openTab 실행기 두 곳에만 있다.
    const replayBinders = binders.filter((rel) => rel.endsWith('tabs.ts'));
    expect(replayBinders.sort()).toEqual(['actions/handlers/tabs.ts', 'nodes/tabs.ts']);
  });
});
