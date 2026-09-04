/**
 * run-tab-isolation.integration.test.ts
 *
 * Behavioural counterpart to no-active-tab-query.test.ts.
 *
 * The source guard proves the engine contains no active-tab lookups. This test
 * proves the running engine behaves accordingly: with a user tab (id 11) sitting
 * right there in the mocked browser, a flow pinned to tab 99 touches only 99.
 *
 * Every chrome.tabs.*, chrome.scripting.*, chrome.debugger.* and
 * chrome.tabs.sendMessage call made during the run is recorded with the tab id
 * it addressed, and the whole set has to be {99}.
 *
 * Scope note: the tools layer (handleCallTool) is mocked out. Which tab a
 * browser tool drives is decided by the work-tab gate, which is stage 2 of this
 * work; this test covers the flow engine's own chrome calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_TAB_ID = 11; // the tab the human is looking at; must never be touched
const RUN_TAB_ID = 99; // the tab the run is pinned to

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
import { RunTabError } from '@/entrypoints/background/record-replay/engine/tab-context';

// =============================================================================
// Recording chrome stub
// =============================================================================

interface TabTouch {
  api: string;
  tabId: number | undefined;
}

interface FakeTab {
  id: number;
  url: string;
  title: string;
  status: string;
  windowId: number;
  active: boolean;
}

let touches: TabTouch[] = [];
let liveTabs: Map<number, FakeTab>;

function record(api: string, tabId: number | undefined) {
  touches.push({ api, tabId });
}

/** Tab ids the run actually addressed, deduplicated. */
function touchedTabIds(): number[] {
  return [
    ...new Set(touches.map((t) => t.tabId).filter((id): id is number => typeof id === 'number')),
  ].sort((a, b) => a - b);
}

function makeTab(overrides: Partial<FakeTab> & { id: number }): FakeTab {
  return {
    url: 'https://example.com/',
    title: 'Example',
    status: 'complete',
    windowId: 1,
    active: false,
    ...overrides,
  };
}

/**
 * Navigation listener sets. addListener schedules an immediate event for every
 * live tab, so navigation waits resolve without real timers no matter which tab
 * the run is pinned to. Listeners are expected to filter by tab id themselves,
 * which is exactly the behaviour under test.
 */
function makeNavEvent() {
  const listeners = new Set<(d: unknown) => void>();
  return {
    listeners,
    addListener: (fn: (d: unknown) => void) => {
      listeners.add(fn);
      setTimeout(() => {
        if (!listeners.has(fn)) return;
        for (const id of liveTabs.keys()) {
          fn({ tabId: id, frameId: 0, timeStamp: Date.now() });
        }
      }, 0);
    },
    removeListener: (fn: (d: unknown) => void) => listeners.delete(fn),
  };
}

function installChromeStub() {
  const storage = new Map<string, unknown>();

  vi.stubGlobal('chrome', {
    runtime: { id: 'test-extension-id', lastError: undefined },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storage.get(key) })),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) storage.set(k, v);
        }),
        remove: vi.fn(async () => undefined),
      },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
    },
    tabs: {
      query: vi.fn(async (q: Record<string, unknown>) => {
        record('tabs.query', undefined);
        const all = [...liveTabs.values()];
        if (q && (q as { active?: boolean }).active) return all.filter((t) => t.active);
        return all;
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
      reload: vi.fn(async (tabId: number) => {
        record('tabs.reload', tabId);
      }),
      create: vi.fn(async () => ({ id: 500, windowId: 1 })),
      remove: vi.fn(async (tabId: number) => record('tabs.remove', tabId)),
      sendMessage: vi.fn(async (tabId: number) => {
        record('tabs.sendMessage', tabId);
        return { success: false };
      }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: {
      executeScript: vi.fn(async (injection: { target?: { tabId?: number } }) => {
        record('scripting.executeScript', injection?.target?.tabId);
        return [{ result: 'extracted-value' }];
      }),
    },
    debugger: {
      attach: vi.fn(async (target: { tabId?: number }) => record('debugger.attach', target?.tabId)),
      detach: vi.fn(async (target: { tabId?: number }) => record('debugger.detach', target?.tabId)),
      sendCommand: vi.fn(async (target: { tabId?: number }) => {
        record('debugger.sendCommand', target?.tabId);
        return {};
      }),
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
      onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    webNavigation: {
      onCommitted: makeNavEvent(),
      onCompleted: makeNavEvent(),
      onHistoryStateUpdated: makeNavEvent(),
      getAllFrames: vi.fn(async (details: { tabId?: number }) => {
        record('webNavigation.getAllFrames', details?.tabId);
        return [{ frameId: 0, url: 'https://example.com/' }];
      }),
    },
    windows: {
      get: vi.fn(async () => ({ id: 1 })),
      getAll: vi.fn(async () => []),
      getLastFocused: vi.fn(async () => ({ id: 1 })),
      create: vi.fn(async () => ({ id: 1, tabs: [{ id: 500 }] })),
      update: vi.fn(async () => ({ id: 1 })),
      WINDOW_ID_NONE: -1,
    },
    alarms: { getAll: vi.fn(async () => []), clear: vi.fn(async () => true), create: vi.fn() },
  });
}

/** Minimal DAG flow: navigate -> click -> extract. */
function minimalFlow() {
  return {
    id: 'flow_run_tab_isolation',
    name: 'Run tab isolation',
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
        type: 'extract',
        config: { selector: '#result', attr: 'text', saveAs: 'result' },
      },
    ],
    edges: [
      { from: 'n1', to: 'n2' },
      { from: 'n2', to: 'n3' },
    ],
    meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  } as never;
}

// =============================================================================
// Tests
// =============================================================================

describe('flow runs stay on the tab they were given', () => {
  beforeEach(() => {
    touches = [];
    liveTabs = new Map([
      // The tab the user is actually looking at.
      [
        USER_TAB_ID,
        makeTab({ id: USER_TAB_ID, url: 'https://private.example/inbox', active: true }),
      ],
      // The tab the run was handed.
      [RUN_TAB_ID, makeTab({ id: RUN_TAB_ID, url: 'https://example.com/', windowId: 2 })],
    ]);
    mocks.handleCallTool.mockReset();
    mocks.handleCallTool.mockResolvedValue({ content: [], isError: false });
    mocks.appendRun.mockReset();
    mocks.appendRun.mockResolvedValue(undefined);
    installChromeStub();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('touches only the pinned tab, never the user active tab (MCP source)', async () => {
    const result = await runFlow(
      minimalFlow(),
      { tabId: RUN_TAB_ID, source: 'mcp' },
      {
        returnLogs: true,
      },
    );

    expect(result.summary.failed).toBe(0);
    expect(result.summary.total).toBe(3);

    // The decisive assertion: every tab-addressed chrome call went to tab 99.
    expect(touchedTabIds()).toEqual([RUN_TAB_ID]);

    const strays = touches.filter((t) => t.tabId === USER_TAB_ID);
    expect(
      strays,
      `Engine reached the user tab via: ${strays.map((t) => t.api).join(', ')}`,
    ).toEqual([]);

    // And the work actually happened on 99, rather than being skipped.
    expect(touches.some((t) => t.api === 'scripting.executeScript' && t.tabId === RUN_TAB_ID)).toBe(
      true,
    );
  });

  it('never falls back to an active-tab query even when one is available', async () => {
    await runFlow(minimalFlow(), { tabId: RUN_TAB_ID, source: 'mcp' }, { returnLogs: true });

    // chrome.tabs.query is how the old engine found the user's tab. The run must
    // not call it at all: the tab was already decided by the caller.
    expect(touches.filter((t) => t.api === 'tabs.query')).toEqual([]);
  });

  it('fails with run_tab_missing when the pinned tab was closed', async () => {
    liveTabs.delete(RUN_TAB_ID);

    const result = await runFlow(
      minimalFlow(),
      { tabId: RUN_TAB_ID, source: 'mcp' },
      {
        returnLogs: true,
      },
    );

    expect(result.success).toBe(false);
    expect(result.summary.total).toBe(0);
    const messages = (result.logs || []).map((l) => l.message || '').join(' | ');
    expect(messages).toContain('run_tab_missing');

    // It must not have gone looking for a replacement tab.
    expect(touches.filter((t) => t.api === 'tabs.query')).toEqual([]);
    expect(touchedTabIds()).toEqual([RUN_TAB_ID]);
  });

  it('resolveRunTab refuses a run with no tab instead of borrowing one', async () => {
    const { resolveRunTab } =
      await import('@/entrypoints/background/record-replay/engine/tab-context');

    await expect(
      resolveRunTab({ tabId: undefined as unknown as number, source: 'mcp' }),
    ).rejects.toBeInstanceOf(RunTabError);
    await expect(
      resolveRunTab({ tabId: undefined as unknown as number, source: 'mcp' }),
    ).rejects.toThrow(/run_tab_required/);
    expect(touches.filter((t) => t.api === 'tabs.query')).toEqual([]);
  });

  it('side panel launches resolve the tab once at the entry point, then stay on it', async () => {
    const { queryEntryPointTab } =
      await import('@/entrypoints/background/record-replay/engine/tab-context');

    // The entry point is allowed one active-tab lookup, before the run starts.
    const tab = await queryEntryPointTab('sidepanel');
    expect(tab.tabId).toBe(USER_TAB_ID);
    expect(tab.source).toBe('sidepanel');

    const queriesAtEntry = touches.filter((t) => t.api === 'tabs.query').length;
    expect(queriesAtEntry).toBe(1);

    await runFlow(minimalFlow(), tab, { returnLogs: true });

    // No further active-tab lookups: the run used the pinned tab throughout.
    expect(touches.filter((t) => t.api === 'tabs.query').length).toBe(queriesAtEntry);
    expect(touchedTabIds()).toEqual([USER_TAB_ID]);
  });
});
