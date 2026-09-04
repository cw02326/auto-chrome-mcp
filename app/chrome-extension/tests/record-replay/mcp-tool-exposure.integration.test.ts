/**
 * auto-chrome-mcp fork(B, stage 2): record_replay_flow_run / record_replay_list_published
 * 의 MCP 노출 계약.
 *
 * 배경 — 2026-09-04 에는 두 도구를 **감췄다**. replay 엔진이 대상 탭을 스스로 골랐기
 * 때문이다(ensureTab 이 사용자의 활성 탭을 잡고, 노드들이 ctx.tabId 를 무시하고 같은
 * 조회를 다시 했다). 그래서 게이트가 작업 탭 id 를 주입해도 소비하는 지점이 없었다.
 *
 * v1.11.3 의 run-tab 리팩터로 엔진은 호출자가 지정한 탭에만 고정되고, 노드가 부르는 모든
 * handleCallTool 이 `tabId: ctx.tabId` 를 싣는다. 그래서 노출을 되살렸다.
 *
 * 이 파일이 못박는 것:
 *   (1) 두 스키마가 tools/list 에 실린다 (flowId 필수, tabTarget enum, lane 주입)
 *   (2) 게이트가 이 세션의 작업 탭(99)을 주입하고, 실행은 99 에서만 일어난다
 *       — 사용자 탭 11 접근 0
 *   (3) 노드가 부르는 모든 도구 호출이 tabId:99 를 싣는다
 *   (4) 작업 탭이 없으면 no_work_tab 으로 거절한다 (사용자 탭 폴백 없음)
 *   (5) tabTarget:'new' 는 작업 탭 창에 세션 소유 백그라운드 탭을 만들어 거기서 돈다
 *   (6) chrome_batch 안 중첩은 여전히 거절된다
 *   (7) 결과는 요약이고, returnLogs 를 줘야 로그가 실리며 4000자 상한이 걸린다
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOL_NAMES, TOOL_SCHEMAS } from 'auto-chrome-mcp-shared';

const FLOW_RUN = TOOL_NAMES.RECORD_REPLAY.FLOW_RUN;
const LIST_PUBLISHED = TOOL_NAMES.RECORD_REPLAY.LIST_PUBLISHED;
const BATCH = TOOL_NAMES.BROWSER.BATCH;

const USER_TAB_ID = 11; // 사용자가 보고 있는 탭 — 한 번도 건드리면 안 된다
const WORK_TAB_ID = 99; // 이 세션의 MCP 작업 탭
const NEW_TAB_ID = 500; // tabTarget:'new' 로 만들어지는 탭

import { handleCallTool, REGISTERED_TOOL_NAMES } from '@/entrypoints/background/tools';
import * as browserTools from '@/entrypoints/background/tools/browser';
import {
  flowRunTool,
  summarizeRunResult,
  MAX_RETURNED_LOG_CHARS,
} from '@/entrypoints/background/tools/record-replay';
import { saveFlow, publishFlow } from '@/entrypoints/background/record-replay/flow-store';
import { IndexedDbStorage } from '@/entrypoints/background/record-replay/storage/indexeddb-manager';
import type { Flow } from '@/entrypoints/background/record-replay/types';

// =============================================================================
// chrome 스텁 — 탭을 건드린 모든 경로를 기록한다
// =============================================================================

interface FakeTab {
  id: number;
  url: string;
  title: string;
  status: string;
  windowId: number;
  active: boolean;
}

let tabTouches: Array<{ api: string; tabId: number | undefined }> = [];
let liveTabs: Map<number, FakeTab>;
let createdTabs: chrome.tabs.CreateProperties[] = [];
let removedTabs: number[] = [];

function makeTab(over: Partial<FakeTab> & { id: number }): FakeTab {
  return {
    url: 'https://example.com/',
    title: 'Example',
    status: 'complete',
    windowId: 2,
    active: false,
    ...over,
  };
}

function makeNavEvent() {
  const listeners = new Set<(d: unknown) => void>();
  return {
    listeners,
    addListener: (fn: (d: unknown) => void) => {
      listeners.add(fn);
      setTimeout(() => {
        if (!listeners.has(fn)) return;
        for (const id of liveTabs.keys()) fn({ tabId: id, frameId: 0, timeStamp: Date.now() });
      }, 0);
    },
    removeListener: (fn: (d: unknown) => void) => listeners.delete(fn),
  };
}

/**
 * @param workTabId  이 세션의 작업 탭. null 이면 작업 탭이 없는 상태(거절 경로).
 */
function installChrome(options: { workTabId: number | null }) {
  const local: Record<string, unknown> = { rr_idb_migrated: true };
  const session: Record<string, unknown> = {};
  if (options.workTabId !== null) {
    session.mcpWorkTabs = {
      default: { tabId: options.workTabId, lastUsedAt: Date.now(), owned: true },
    };
  }

  const toKeys = (keys: unknown): string[] =>
    Array.isArray(keys) ? (keys as string[]) : typeof keys === 'string' ? [keys] : [];
  const area = (store: Record<string, unknown>) => ({
    get: vi.fn(async (keys: unknown) => {
      if (keys === null || keys === undefined) return { ...store };
      const out: Record<string, unknown> = {};
      for (const key of toKeys(keys)) if (key in store) out[key] = store[key];
      return out;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(store, items);
    }),
    remove: vi.fn(async () => undefined),
  });

  const record = (api: string, tabId: number | undefined) => tabTouches.push({ api, tabId });

  vi.stubGlobal('chrome', {
    runtime: { id: 'test-extension-id', lastError: undefined },
    storage: { local: area(local), session: area(session) },
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
      setTitle: vi.fn(async () => undefined),
    },
    tabGroups: {
      query: vi.fn(async () => []),
      get: vi.fn(async () => ({ id: 100, title: 'MCP', color: 'green', windowId: 2 })),
      update: vi.fn(async () => ({ id: 100 })),
      TAB_GROUP_ID_NONE: -1,
    },
    tabs: {
      query: vi.fn(async (q: any) => {
        record('tabs.query', undefined);
        const all = [...liveTabs.values()];
        return q && q.active ? all.filter((t) => t.active) : all;
      }),
      get: vi.fn(async (tabId: number) => {
        record('tabs.get', tabId);
        const tab = liveTabs.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        return tab;
      }),
      update: vi.fn(async (tabId: number, props: { url?: string }) => {
        record('tabs.update', tabId);
        const tab = liveTabs.get(tabId);
        if (tab && props?.url) tab.url = props.url;
        return tab;
      }),
      reload: vi.fn(async (tabId: number) => record('tabs.reload', tabId)),
      create: vi.fn(async (info: chrome.tabs.CreateProperties) => {
        createdTabs.push(info);
        const tab = makeTab({
          id: NEW_TAB_ID,
          url: typeof info.url === 'string' ? info.url : 'about:blank',
          windowId: info.windowId ?? 2,
        });
        liveTabs.set(NEW_TAB_ID, tab);
        return tab;
      }),
      remove: vi.fn(async (tabId: number) => {
        removedTabs.push(tabId);
        record('tabs.remove', tabId);
      }),
      group: vi.fn(async () => 100),
      sendMessage: vi.fn(async (tabId: number) => {
        record('tabs.sendMessage', tabId);
        return { success: false };
      }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: {
      executeScript: vi.fn(async (injection: { target?: { tabId?: number } }) => {
        record('scripting.executeScript', injection?.target?.tabId);
        return [{ result: null }];
      }),
    },
    debugger: {
      attach: vi.fn(async (t: { tabId?: number }) => record('debugger.attach', t?.tabId)),
      detach: vi.fn(async (t: { tabId?: number }) => record('debugger.detach', t?.tabId)),
      sendCommand: vi.fn(async (t: { tabId?: number }) => {
        record('debugger.sendCommand', t?.tabId);
        return {};
      }),
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
      onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    webNavigation: {
      onCommitted: makeNavEvent(),
      onCompleted: makeNavEvent(),
      onHistoryStateUpdated: makeNavEvent(),
      getAllFrames: vi.fn(async (d: { tabId?: number }) => {
        record('webNavigation.getAllFrames', d?.tabId);
        return [{ frameId: 0, url: 'https://example.com/' }];
      }),
    },
    windows: {
      get: vi.fn(async () => ({ id: 2 })),
      getAll: vi.fn(async () => []),
      getLastFocused: vi.fn(async () => ({ id: 2 })),
      create: vi.fn(async () => ({ id: 2, tabs: [{ id: NEW_TAB_ID }] })),
      update: vi.fn(async () => ({ id: 2 })),
      WINDOW_ID_NONE: -1,
    },
    permissions: { contains: vi.fn(async () => true) },
    extension: { isAllowedFileSchemeAccess: vi.fn(async () => true) },
    alarms: { getAll: vi.fn(async () => []), clear: vi.fn(async () => true), create: vi.fn() },
  });
}

/**
 * 브라우저 도구를 전부 스텁으로 바꾸고, 실행된 호출의 **게이트 통과 후** 인자를 모은다.
 *
 * 도구 구현만 바꾸므로 handleCallTool(게이트·잠금·진단)은 안팎 모두 진짜로 돈다. 그래서
 * "엔진 노드의 재진입 호출이 게이트에서 다른 탭으로 바뀌지 않는다" 를 실제 코드로 본다.
 * chrome_batch 는 중첩 거절을 봐야 하므로 스텁하지 않는다.
 */
function stubBrowserTools(): Array<{ name: string; args: any }> {
  const calls: Array<{ name: string; args: any }> = [];
  for (const value of Object.values(browserTools) as any[]) {
    if (!value || typeof value !== 'object') continue;
    if (typeof value.name !== 'string' || typeof value.execute !== 'function') continue;
    if (value.name === BATCH) continue;
    vi.spyOn(value, 'execute').mockImplementation(async (args: any) => {
      calls.push({ name: value.name, args });
      return { content: [{ type: 'text', text: '{}' }], isError: false };
    });
  }
  return calls;
}

/** 이번 테스트에서 엔진이 부른 브라우저 도구 호출들. */
let innerCallLog: Array<{ name: string; args: any }> = [];
function innerCalls() {
  return innerCallLog;
}

const FLOW_ID = 'mcp-exposure-flow';

/** navigate → click → fill → screenshot → http: 패치한 노드 파일을 두루 지난다. */
function coverageFlow(): Flow {
  return {
    id: FLOW_ID,
    name: 'mcp exposure',
    version: 1,
    variables: [],
    nodes: [
      { id: 'n1', type: 'navigate', config: { url: 'https://example.com/start' } },
      {
        id: 'n2',
        type: 'click',
        config: { target: { candidates: [{ type: 'css', value: '#go' }] } },
      },
      {
        id: 'n3',
        type: 'fill',
        config: { target: { candidates: [{ type: 'css', value: '#q' }] }, value: 'hello' },
      },
      { id: 'n4', type: 'screenshot', config: { saveAs: 'shot' } },
      { id: 'n5', type: 'http', config: { url: 'https://example.com/api', method: 'GET' } },
    ],
    edges: [
      { from: 'n1', to: 'n2' },
      { from: 'n2', to: 'n3' },
      { from: 'n3', to: 'n4' },
      { from: 'n4', to: 'n5' },
    ],
  } as unknown as Flow;
}

async function seedFlow(flow: Flow) {
  await saveFlow(flow, { notify: false });
  await publishFlow(flow, flow.name);
}

async function clearStore() {
  const flows = await IndexedDbStorage.flows.list();
  for (const f of flows) await IndexedDbStorage.flows.delete(f.id);
  const pub = await IndexedDbStorage.published.list();
  for (const p of pub) await IndexedDbStorage.published.delete(p.id);
}

function parseResult(res: any): any {
  const text = res?.content?.[0]?.text;
  return typeof text === 'string' ? JSON.parse(text) : undefined;
}

// =============================================================================
// (1) 스키마 노출
// =============================================================================

describe('record_replay 두 도구는 MCP 표면에 실린다', () => {
  const schemaOf = (name: string) => TOOL_SCHEMAS.find((t) => t.name === name);

  it('tools/list 에 두 스키마가 있다', () => {
    expect(schemaOf(FLOW_RUN)).toBeDefined();
    expect(schemaOf(LIST_PUBLISHED)).toBeDefined();
  });

  it('디스패치 등록도 그대로다', () => {
    expect(REGISTERED_TOOL_NAMES).toContain(FLOW_RUN);
    expect(REGISTERED_TOOL_NAMES).toContain(LIST_PUBLISHED);
  });

  it('flow_run 스키마는 flowId 필수 + tabTarget enum + 구현이 소비하는 인자만 갖는다', () => {
    const schema: any = schemaOf(FLOW_RUN)!.inputSchema;
    expect(schema.required).toEqual(['flowId']);
    expect(schema.properties.tabTarget.enum).toEqual(['current', 'new']);
    // 구현(tools/record-replay.ts)이 실제로 읽는 키 + 게이트가 쓰는 tabId/lane 뿐이다.
    expect(Object.keys(schema.properties).sort()).toEqual(
      [
        'args',
        'captureNetwork',
        'flowId',
        'lane',
        'refresh',
        'returnLogs',
        'startUrl',
        'tabId',
        'tabTarget',
        'timeoutMs',
      ].sort(),
    );
  });

  it('설명이 작업 탭 요구와 batch 중첩 금지를 알린다', () => {
    const description = String(schemaOf(FLOW_RUN)!.description);
    expect(description).toMatch(/chrome_navigate/);
    expect(description).toMatch(/no_work_tab/);
    expect(description).toMatch(/chrome_batch/);
  });

  it('레인 예외가 아니다 — 작업 탭·레인 규칙을 그대로 받는다', () => {
    for (const name of [FLOW_RUN, LIST_PUBLISHED]) {
      const schema: any = schemaOf(name)!.inputSchema;
      expect(schema.properties.lane).toBeDefined();
    }
  });
});

// =============================================================================
// (2)~(7) 실행 계약
// =============================================================================

describe('flow_run 은 게이트가 준 작업 탭에서만 돈다', () => {
  beforeEach(async () => {
    tabTouches = [];
    createdTabs = [];
    removedTabs = [];
    innerCallLog = stubBrowserTools();
    liveTabs = new Map([
      [
        USER_TAB_ID,
        makeTab({ id: USER_TAB_ID, url: 'https://private.test/inbox', active: true, windowId: 1 }),
      ],
      [WORK_TAB_ID, makeTab({ id: WORK_TAB_ID, url: 'https://example.com/', windowId: 2 })],
    ]);
    installChrome({ workTabId: WORK_TAB_ID });
    await clearStore();
    await seedFlow(coverageFlow());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('회귀(핵심): tabId 를 주지 않아도 게이트가 작업 탭 99 를 주입해 거기서 실행한다', async () => {
    const res = await handleCallTool({ name: FLOW_RUN, args: { flowId: FLOW_ID } });

    expect((res as any).isError).toBeFalsy();
    const payload = parseResult(res);
    expect(payload.tabId).toBe(WORK_TAB_ID);
    expect(payload.summary.total).toBeGreaterThan(0);

    // 사용자 탭 접근 0.
    const strays = tabTouches.filter((t) => t.tabId === USER_TAB_ID);
    expect(strays, `사용자 탭에 닿은 경로: ${strays.map((t) => t.api).join(', ')}`).toEqual([]);
    // 활성 탭 조회 자체가 없어야 한다 (예전 ensureTab 의 경로).
    expect(tabTouches.filter((t) => t.api === 'tabs.query')).toEqual([]);
  });

  it('회귀(핵심): 노드가 부른 도구 호출이 전부 tabId:99 를 싣는다', async () => {
    await handleCallTool({ name: FLOW_RUN, args: { flowId: FLOW_ID } });

    const calls = innerCalls();
    expect(calls.length).toBeGreaterThan(4);
    const missing = calls.filter((c) => c.args?.tabId !== WORK_TAB_ID);
    expect(
      missing,
      `tabId:${WORK_TAB_ID} 없이 나간 호출: ${missing.map((c) => c.name).join(', ')}`,
    ).toEqual([]);
    // 노드별 대표 호출이 실제로 지나갔는지 (표본이 비어 통과하는 것을 막는다).
    const names = new Set(calls.map((c) => c.name));
    expect(names.has(TOOL_NAMES.BROWSER.NAVIGATE)).toBe(true);
    expect(names.has(TOOL_NAMES.BROWSER.CLICK)).toBe(true);
    expect(names.has(TOOL_NAMES.BROWSER.FILL)).toBe(true);
    expect(names.has(TOOL_NAMES.BROWSER.SCREENSHOT)).toBe(true);
    expect(names.has(TOOL_NAMES.BROWSER.NETWORK_REQUEST)).toBe(true);
    expect(names.has(TOOL_NAMES.BROWSER.READ_PAGE)).toBe(true);
  });

  it('호출자가 준 _mcpSessionId·lane 이 노드의 도구 호출까지 따라간다', async () => {
    // 레인마다 작업 탭 버킷이 갈리므로, 여기서는 탭을 명시해 세션 정보 전파만 본다.
    await handleCallTool({
      name: FLOW_RUN,
      args: { flowId: FLOW_ID, tabId: WORK_TAB_ID, _mcpSessionId: 'sess-a', lane: 'lane-a' },
    });

    const calls = innerCalls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.args?._mcpSessionId === 'sess-a')).toBe(true);
    expect(calls.every((c) => c.args?.lane === 'lane-a')).toBe(true);
  });

  it("tabTarget:'new' 는 작업 탭 창에 세션 소유 백그라운드 탭을 만들고 거기서 돈다", async () => {
    const res = await handleCallTool({
      name: FLOW_RUN,
      args: { flowId: FLOW_ID, tabTarget: 'new' },
    });

    expect((res as any).isError).toBeFalsy();
    expect(parseResult(res).tabId).toBe(NEW_TAB_ID);

    expect(createdTabs).toHaveLength(1);
    expect(createdTabs[0].active).toBe(false); // 백그라운드
    expect(createdTabs[0].windowId).toBe(2); // 작업 탭이 있는 창

    // 실행은 새 탭에서만.
    const calls = innerCalls();
    expect(calls.every((c) => c.args?.tabId === NEW_TAB_ID)).toBe(true);
    // 실행이 끝나도 남겨 둔다.
    expect(removedTabs).not.toContain(NEW_TAB_ID);
    expect(tabTouches.filter((t) => t.tabId === USER_TAB_ID)).toEqual([]);
  });

  it('숫자 tabId 는 tabTarget 이 아니라 tabId 인자로만 받는다', async () => {
    const res = await flowRunTool.execute({ flowId: FLOW_ID, tabTarget: WORK_TAB_ID });
    expect((res as any).isError).toBe(true);
    expect(String((res as any).content?.[0]?.text)).toContain('tabTarget');
  });

  it('결과는 요약이다 — 기본은 로그가 실리지 않는다', async () => {
    const res = await handleCallTool({ name: FLOW_RUN, args: { flowId: FLOW_ID } });
    const payload = parseResult(res);

    expect(payload).toHaveProperty('summary');
    expect(payload).toHaveProperty('outputs');
    expect(payload.logs).toBeUndefined();
    expect(payload.logsOmitted).toBeDefined();
    // 실패 스크린샷 base64 는 절대 응답에 실리지 않는다.
    expect(payload.screenshots).toBeUndefined();
  });

  it('returnLogs:true 면 로그가 실리고 4000자 상한이 걸린다', async () => {
    const res = await handleCallTool({
      name: FLOW_RUN,
      args: { flowId: FLOW_ID, returnLogs: true },
    });
    const payload = parseResult(res);
    expect(typeof payload.logs).toBe('string');
    expect(payload.logs.length).toBeLessThanOrEqual(MAX_RETURNED_LOG_CHARS);
  });

  it('list_published 는 탭을 쓰지 않고 그대로 동작한다', async () => {
    const res = await handleCallTool({ name: LIST_PUBLISHED, args: {} });
    const payload = parseResult(res);
    expect(payload.success).toBe(true);
    expect(payload.published.map((p: any) => p.id)).toContain(FLOW_ID);
    expect(tabTouches.filter((t) => t.tabId === USER_TAB_ID)).toEqual([]);
  });

  it('없는 flowId 는 여전히 구조화된 "Flow not found" 다', async () => {
    const res = await handleCallTool({ name: FLOW_RUN, args: { flowId: 'no-such-flow' } });
    expect((res as any).isError).toBe(true);
    expect(String((res as any).content?.[0]?.text)).toContain('Flow not found');
  });

  it('chrome_batch 안에 중첩하면 거절한다', async () => {
    const res = await handleCallTool({
      name: BATCH,
      args: { steps: [{ tool: FLOW_RUN, args: { flowId: FLOW_ID } }] },
    });
    const text = JSON.stringify((res as any).content);
    expect(text).toContain(FLOW_RUN);
    expect(text.toLowerCase()).toMatch(/not allowed|disallow/);
    // 거절이므로 엔진은 한 번도 돌지 않는다.
    expect(innerCalls()).toEqual([]);
  });
});

describe('작업 탭이 없으면 flow_run 은 거절한다', () => {
  beforeEach(async () => {
    tabTouches = [];
    createdTabs = [];
    innerCallLog = stubBrowserTools();
    liveTabs = new Map([
      [
        USER_TAB_ID,
        makeTab({ id: USER_TAB_ID, url: 'https://private.test/inbox', active: true, windowId: 1 }),
      ],
    ]);
    installChrome({ workTabId: null });
    await clearStore();
    await seedFlow(coverageFlow());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('회귀(핵심): no_work_tab 으로 거절하고 사용자 탭을 한 번도 조회하지 않는다', async () => {
    const res = await handleCallTool({ name: FLOW_RUN, args: { flowId: FLOW_ID } });

    expect((res as any).isError).toBe(true);
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.error).toBe('no_work_tab');
    expect(payload.tool).toBe(FLOW_RUN);
    expect(payload.message).toContain('chrome_navigate');

    expect(innerCalls()).toEqual([]);
    expect(tabTouches.filter((t) => t.api === 'tabs.query')).toEqual([]);
    expect(tabTouches.filter((t) => t.tabId === USER_TAB_ID)).toEqual([]);
  });

  it("tabTarget:'new' 여도 기준이 될 작업 탭이 없으면 거절한다", async () => {
    const res = await handleCallTool({
      name: FLOW_RUN,
      args: { flowId: FLOW_ID, tabTarget: 'new' },
    });
    expect((res as any).isError).toBe(true);
    expect(JSON.parse((res as any).content[0].text).error).toBe('no_work_tab');
    expect(createdTabs).toEqual([]);
  });
});

// =============================================================================
// 결과 요약기 단위 계약
// =============================================================================

describe('summarizeRunResult', () => {
  const base: any = {
    runId: 'run_1',
    success: false,
    summary: { total: 3, success: 2, failed: 1, tookMs: 12 },
    url: null,
    outputs: { a: 1 },
    screenshots: { onFailure: 'x'.repeat(50_000) },
    paused: false,
    logs: [
      { stepId: 'n1', status: 'success', message: 'ok' },
      { stepId: 'n2', status: 'failed', message: 'boom' },
    ],
  };

  it('실패한 첫 스텝을 뽑아 싣는다', () => {
    const out: any = summarizeRunResult(base, { tabId: 99, flowId: 'f' });
    expect(out.failedStep).toEqual({ stepId: 'n2', message: 'boom' });
    expect(out.tabId).toBe(99);
    expect(JSON.stringify(out)).not.toContain('x'.repeat(100));
  });

  it('returnLogs 상한을 넘으면 잘라내고 표시한다', () => {
    const long = {
      ...base,
      logs: Array.from({ length: 2000 }, (_, i) => ({
        stepId: `n${i}`,
        status: 'success',
        message: 'a'.repeat(40),
      })),
    };
    const out: any = summarizeRunResult(long, { returnLogs: true, tabId: 99, flowId: 'f' });
    expect(out.logs.length).toBe(MAX_RETURNED_LOG_CHARS);
    expect(out.logsTruncated).toBe(true);
  });
});
