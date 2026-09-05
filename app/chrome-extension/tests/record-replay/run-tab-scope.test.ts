/**
 * run-tab-scope.test.ts
 *
 * 2026-09-05 Codex 검토 항목 1·5·6·8 의 회귀 테스트.
 *
 * 1. closeTab 노드가 사용자 탭을 닫는다 (legacy closeTab 이 singular tabId 를 보내
 *    CloseTabsTool 이 무시 → 모드 OFF 면 활성 탭 삭제).
 * 5. openTab / switchTab 이 격리를 벗어난다 (전역 url·title 검색, 활성화, 재고정 누락).
 * 6. setRunTab 이 orchestrator 컨텍스트를 갱신하지 않는다 (logger·cleanup·응답 tabId 가
 *    옛 탭에 남는다).
 * 8. actions 경로의 도구 호출이 _mcpSessionId / lane / _leaseToken 을 안 싣는다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';

const USER_TAB_ID = 11; // 사용자가 보고 있는 탭
const RUN_TAB_ID = 99; // run 이 고정된 탭
const NEW_TAB_ID = 500; // openTab 이 만드는 첫 탭

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
    id: 'flow_run_tab_scope',
    name: 'run tab scope',
    version: 1,
    variables: [],
    nodes,
    edges,
    meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  } as never;
}

function callsNamed(name: string): ToolCall[] {
  return toolCalls.filter((c) => c.name === name);
}

function runTab(over: Partial<RunTabContext> = {}): RunTabContext {
  return { tabId: RUN_TAB_ID, windowId: 1, source: 'mcp', ...over } as RunTabContext;
}

describe('run 은 자기 탭과 자기가 만든 탭 밖으로 나가지 않는다', () => {
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ---------------------------------------------------------------- 항목 1
  it('항목1: 인자 없는 closeTab 은 run 탭 id 를 tabIds 배열로 보낸다', async () => {
    const result = await runFlow(flowOf([{ id: 'n1', type: 'closeTab', config: {} }]), runTab(), {
      returnLogs: true,
    });

    expect(result.summary.failed).toBe(0);
    const closes = callsNamed(TOOL_NAMES.BROWSER.CLOSE_TABS);
    expect(closes).toHaveLength(1);
    // CloseTabsTool 은 tabIds 배열만 읽는다. singular tabId 는 무시돼 활성 탭이 닫혔다.
    expect(closes[0].args.tabIds).toEqual([RUN_TAB_ID]);
  });

  it('항목1: run 이 만들지 않은 탭 id 를 닫으려 하면 close_scope_violation', async () => {
    const result = await runFlow(
      flowOf([{ id: 'n1', type: 'closeTab', config: { tabIds: [USER_TAB_ID] } }]),
      runTab(),
      { returnLogs: true },
    );

    expect(result.summary.failed).toBe(1);
    const messages = (result.logs || []).map((l) => l.message || '').join(' | ');
    expect(messages).toContain('close_scope_violation');
    const closed = callsNamed(TOOL_NAMES.BROWSER.CLOSE_TABS);
    expect(closed).toEqual([]);
  });

  it('항목1: url 로 닫기도 run 소유 탭 밖이면 거절하고 전체 탭을 훑지 않는다', async () => {
    const result = await runFlow(
      flowOf([{ id: 'n1', type: 'closeTab', config: { url: 'private.test' } }]),
      runTab(),
      { returnLogs: true },
    );

    expect(result.summary.failed).toBe(1);
    expect((result.logs || []).map((l) => l.message || '').join(' | ')).toContain(
      'close_scope_violation',
    );
    expect(stub.callsTo('tabs.query')).toEqual([]);
    expect(callsNamed(TOOL_NAMES.BROWSER.CLOSE_TABS)).toEqual([]);
  });

  // ---------------------------------------------------------------- 항목 5·6
  it('항목5: openTab 은 run 창에 백그라운드 탭을 만들고 활성화하지 않는다', async () => {
    await runFlow(
      flowOf([{ id: 'n1', type: 'openTab', config: { url: 'https://example.com/next' } }]),
      runTab(),
      { returnLogs: true },
    );

    expect(stub.createdTabs).toHaveLength(1);
    expect(stub.createdTabs[0].active).toBe(false);
    expect(stub.createdTabs[0].windowId).toBe(1);
    expect(callsNamed(TOOL_NAMES.BROWSER.SWITCH_TAB)).toEqual([]);
  });

  it('항목5·6: openTab 뒤 이어지는 스텝과 로거·응답이 모두 새 탭을 가리킨다', async () => {
    const tab = runTab();
    const result = await runFlow(
      flowOf([
        { id: 'n1', type: 'openTab', config: { url: 'https://example.com/next' } },
        { id: 'n2', type: 'extract', config: { selector: '#r', attr: 'text', saveAs: 'r' } },
      ]),
      tab,
      { returnLogs: true },
    );

    expect(result.summary.failed).toBe(0);
    // 이어지는 스텝의 도구 호출이 새 탭으로 간다.
    const afterOpen = toolCalls.filter((c) => c.args?.tabId !== undefined);
    expect(afterOpen.at(-1)?.args.tabId).toBe(NEW_TAB_ID);
    // 항목 6: 호출자가 넘긴 컨텍스트(= logger·cleanup·응답이 보는 것)도 새 탭이다.
    expect(tab.tabId).toBe(NEW_TAB_ID);
    // 오버레이(logger)도 새 탭으로 간다.
    const overlayTabs = new Set(stub.callsTo('tabs.sendMessage').map((t) => t.tabId));
    expect(overlayTabs.has(NEW_TAB_ID)).toBe(true);
    expect(overlayTabs.has(USER_TAB_ID)).toBe(false);
  });

  it('항목5: switchTab 의 url·title 전역 검색은 사라졌다', async () => {
    const result = await runFlow(
      flowOf([{ id: 'n1', type: 'switchTab', config: { urlContains: 'private.test' } }]),
      runTab(),
      { returnLogs: true },
    );

    expect(result.summary.failed).toBe(1);
    expect((result.logs || []).map((l) => l.message || '').join(' | ')).toContain(
      'tab_scope_violation',
    );
    expect(stub.callsTo('tabs.query')).toEqual([]);
    expect(stub.touches.filter((t) => t.tabId === USER_TAB_ID)).toEqual([]);
  });

  it('항목5: switchTab 은 run 이 만든 탭으로만 옮겨가고 활성화하지 않는다', async () => {
    const tab = runTab();
    const result = await runFlow(
      flowOf([
        { id: 'n1', type: 'openTab', config: { url: 'https://example.com/next' } },
        { id: 'n2', type: 'switchTab', config: { tabId: RUN_TAB_ID } },
        { id: 'n3', type: 'switchTab', config: { tabId: NEW_TAB_ID } },
      ]),
      tab,
      { returnLogs: true },
    );

    expect(result.summary.failed).toBe(0);
    expect(tab.tabId).toBe(NEW_TAB_ID);
    expect(callsNamed(TOOL_NAMES.BROWSER.SWITCH_TAB)).toEqual([]);
  });

  // ---------------------------------------------------------------- 항목 8
  it('항목8: actions 경로의 도구 호출도 세션·레인·리스 토큰을 싣는다', async () => {
    await runFlow(
      flowOf([{ id: 'n1', type: 'navigate', config: { url: 'https://example.com/go' } }]),
      runTab({ mcpSessionId: 'sess-a', lane: 'lane-a', leaseToken: 'lease-1' } as any),
      { returnLogs: true, executionMode: 'actions' },
    );

    const navs = callsNamed(TOOL_NAMES.BROWSER.NAVIGATE);
    expect(navs.length).toBeGreaterThan(0);
    for (const call of navs) {
      expect(call.args.tabId).toBe(RUN_TAB_ID);
      expect(call.args._mcpSessionId).toBe('sess-a');
      expect(call.args.lane).toBe('lane-a');
      expect(call.args._leaseToken).toBe('lease-1');
    }
  });

  it('항목5(actions): openTab 핸들러도 백그라운드·run 창·재고정을 지킨다', async () => {
    const tab = runTab();
    await runFlow(
      flowOf([{ id: 'n1', type: 'openTab', config: { url: 'https://example.com/next' } }]),
      tab,
      { returnLogs: true, executionMode: 'actions' },
    );

    expect(stub.createdTabs).toHaveLength(1);
    expect(stub.createdTabs[0].active).toBe(false);
    expect(stub.createdTabs[0].windowId).toBe(1);
    expect(tab.tabId).toBe(NEW_TAB_ID);
  });

  it('항목1·5(actions): closeTab·switchTab 핸들러도 run 소유 밖을 거절한다', async () => {
    const closed = await runFlow(
      flowOf([{ id: 'n1', type: 'closeTab', config: { tabIds: [USER_TAB_ID] } }]),
      runTab(),
      { returnLogs: true, executionMode: 'actions' },
    );
    expect(closed.summary.failed).toBe(1);
    expect(stub.removedTabs).toEqual([]);

    const switched = await runFlow(
      flowOf([{ id: 'n1', type: 'switchTab', config: { urlContains: 'private.test' } }]),
      runTab(),
      { returnLogs: true, executionMode: 'actions' },
    );
    expect(switched.summary.failed).toBe(1);
    expect(stub.callsTo('tabs.query')).toEqual([]);
  });
});
