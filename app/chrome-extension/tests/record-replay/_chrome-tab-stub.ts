/**
 * Shared chrome stub for the record-replay run-scope tests.
 *
 * Records every tab-addressed chrome call so a test can assert which tabs a run
 * touched, and models tab creation/removal so run-owned tab bookkeeping can be
 * observed.
 */

import { vi } from 'vitest';

export interface FakeTab {
  id: number;
  url: string;
  title: string;
  status: string;
  windowId: number;
  active: boolean;
}

export interface TabTouch {
  api: string;
  tabId: number | undefined;
}

export interface TabStub {
  touches: TabTouch[];
  liveTabs: Map<number, FakeTab>;
  createdTabs: Array<Record<string, unknown>>;
  removedTabs: number[];
  /** Tab ids addressed by any recorded chrome call, deduplicated and sorted. */
  touchedTabIds(): number[];
  /** Calls recorded for one api name. */
  callsTo(api: string): TabTouch[];
}

export function makeTab(over: Partial<FakeTab> & { id: number }): FakeTab {
  return {
    url: 'https://example.com/',
    title: 'Example',
    status: 'complete',
    windowId: 1,
    active: false,
    ...over,
  };
}

function makeNavEvent(liveTabs: Map<number, FakeTab>) {
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
 * Install the stub as globalThis.chrome.
 *
 * @param tabs        Tabs that already exist when the test starts.
 * @param firstNewId  Id handed to the first chrome.tabs.create of the test.
 */
export function installTabStub(tabs: FakeTab[], firstNewId = 500): TabStub {
  const liveTabs = new Map<number, FakeTab>(tabs.map((t) => [t.id, t] as const));
  const touches: TabTouch[] = [];
  const createdTabs: Array<Record<string, unknown>> = [];
  const removedTabs: number[] = [];
  let nextId = firstNewId;

  const record = (api: string, tabId: number | undefined) => touches.push({ api, tabId });
  const local: Record<string, unknown> = { rr_idb_migrated: true };
  const session: Record<string, unknown> = {};
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

  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test-extension-id',
      lastError: undefined,
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    storage: { local: area(local), session: area(session) },
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
      reload: vi.fn(async (tabId: number) => record('tabs.reload', tabId)),
      create: vi.fn(async (info: Record<string, unknown>) => {
        createdTabs.push(info);
        const id = nextId++;
        const tab = makeTab({
          id,
          url: typeof info.url === 'string' ? (info.url as string) : 'about:blank',
          windowId: typeof info.windowId === 'number' ? (info.windowId as number) : 1,
          active: info.active === true,
        });
        liveTabs.set(id, tab);
        record('tabs.create', id);
        return tab;
      }),
      remove: vi.fn(async (tabId: number | number[]) => {
        for (const id of Array.isArray(tabId) ? tabId : [tabId]) {
          removedTabs.push(id);
          record('tabs.remove', id);
          liveTabs.delete(id);
        }
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
        return [{ result: 'extracted-value' }];
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
      onCommitted: makeNavEvent(liveTabs),
      onCompleted: makeNavEvent(liveTabs),
      onHistoryStateUpdated: makeNavEvent(liveTabs),
      getAllFrames: vi.fn(async (d: { tabId?: number }) => {
        record('webNavigation.getAllFrames', d?.tabId);
        return [{ frameId: 0, url: 'https://example.com/' }];
      }),
    },
    windows: {
      get: vi.fn(async () => ({ id: 1 })),
      getAll: vi.fn(async () => []),
      getLastFocused: vi.fn(async () => ({ id: 1 })),
      create: vi.fn(async () => ({ id: 3, tabs: [{ id: nextId++ }] })),
      update: vi.fn(async () => ({ id: 1 })),
      WINDOW_ID_NONE: -1,
    },
    permissions: { contains: vi.fn(async () => true) },
    alarms: {
      getAll: vi.fn(async () => []),
      clear: vi.fn(async () => true),
      create: vi.fn(),
      onAlarm: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    commands: { onCommand: { addListener: vi.fn(), removeListener: vi.fn() } },
    contextMenus: {
      create: vi.fn(),
      remove: vi.fn(async () => undefined),
      onClicked: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });

  return {
    touches,
    liveTabs,
    createdTabs,
    removedTabs,
    touchedTabIds: () =>
      [
        ...new Set(
          touches.map((t) => t.tabId).filter((id): id is number => typeof id === 'number'),
        ),
      ].sort((a, b) => a - b),
    callsTo: (api: string) => touches.filter((t) => t.api === api),
  };
}
