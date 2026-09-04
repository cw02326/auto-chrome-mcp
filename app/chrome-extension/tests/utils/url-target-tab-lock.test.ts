/**
 * auto-chrome-mcp fork — `url` 로 대상을 고르는 호출도 탭 잠금·busy/touch 추적을 받아야 한다.
 *
 * 재현하려는 실패(2026-09-04 Codex 최종 검토, 남은 항목):
 *   tools/index.ts 의 바깥쪽 잠금(withTabLock)과 busy·touch 추적은 `args.tabId` 로 걸린다.
 *   그런데 url 로 대상을 고르는 호출(URL_SELECTS_TARGET_TOOLS)에는 게이트가 일부러 tabId 를
 *   주입하지 않는다(주입하면 도구가 tabId 분기로 빠져 url 이 통째로 무시되기 때문이다).
 *   그 결과 이 호출들만 잠금 없이 실행됐고, 요청한 URL 이 기존 작업 탭과 같으면
 *   tabId 를 명시한 click·navigate 와 fetch·inject·capture 가 **같은 탭에서 동시에** 돌았다.
 *
 * 계약:
 *   - url 대상 호출이 세션 범위에서 기존 탭을 찾아내면, 그 탭 id 로 바깥쪽 잠금을 건다.
 *     즉 같은 탭을 겨냥한 tabId 명시 호출과 직렬화된다.
 *   - 잠금이 걸려도 게이트는 여전히 tabId 를 주입하지 않는다 — 도구는 url 분기를 그대로 탄다.
 *   - 세션 범위에 일치 탭이 없으면(= 도구가 새로 만들 예정) 잠글 대상이 없으므로 잠그지 않는다.
 *   - 백그라운드 작업 모드에서 사용자 탭은 후보가 아니므로 잠금 대상으로도 뽑히지 않는다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TOOL_NAMES } from 'auto-chrome-mcp-shared';

const B = TOOL_NAMES.BROWSER;

const SESSION = 'stdio-url-target-lock';
/** 작업 탭이 이미 열어 둔 URL — url 인자와 겹치는 것이 이 버그의 발생 조건이다. */
const TARGET_URL = 'https://target.test/page';
/** 세션 범위에 없는 URL — 도구가 새 탭을 만들 상황. */
const UNKNOWN_URL = 'https://unknown.test/page';

/** 사용자가 보고 있는 탭. 공교롭게 요청한 URL 과 같다(잠금 대상으로도 뽑히면 안 된다). */
const USER_TAB = {
  id: 11,
  windowId: 1,
  url: TARGET_URL,
  title: 'user',
  active: true,
  status: 'complete',
};
/** 이 세션의 작업 탭 — 다른 창에 있고 URL 이 요청 URL 과 같다. */
const WORK_TAB = {
  id: 99,
  windowId: 2,
  url: TARGET_URL,
  title: 'work',
  active: false,
  status: 'complete',
};

function installChrome(): void {
  const localStore: Record<string, unknown> = {};
  const sessionStore: Record<string, unknown> = {
    mcpWorkTabs: {
      [SESSION]: { tabId: WORK_TAB.id, lastUsedAt: Date.now(), owned: true },
    },
  };
  const tabsById: Record<number, any> = { 11: USER_TAB, 99: WORK_TAB };
  let nextId = 500;

  const toKeys = (keys: unknown): string[] =>
    Array.isArray(keys) ? (keys as string[]) : typeof keys === 'string' ? [keys] : [];
  const makeArea = (store: Record<string, unknown>) => ({
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
    storage: { local: makeArea(localStore), session: makeArea(sessionStore) },
    tabs: {
      query: vi.fn(async (q: any) => {
        let out = Object.values(tabsById);
        if (q && typeof q.url === 'string') out = out.filter((t: any) => t.url === q.url);
        if (q?.active === true) out = out.filter((t: any) => t.active);
        if (typeof q?.windowId === 'number')
          out = out.filter((t: any) => t.windowId === q.windowId);
        return out;
      }),
      get: vi.fn(async (id: number) => {
        const tab = tabsById[id];
        if (!tab) throw new Error(`No tab with id: ${id}`);
        return tab;
      }),
      create: vi.fn(async (info: any) => {
        const tab = {
          id: nextId++,
          windowId: info.windowId ?? 1,
          url: info.url,
          title: 'created',
          active: info.active === true,
          status: 'complete',
        };
        tabsById[tab.id] = tab;
        return tab;
      }),
      update: vi.fn(async (id: number) => tabsById[id]),
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
    downloads: {
      search: vi.fn(async () => []),
      onCreated: listener(),
      onChanged: listener(),
    },
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

/** 실제 타이머로 이벤트 루프를 여러 번 비운다 (가짜 타이머를 쓰지 않는다). */
async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

async function waitUntil(predicate: () => boolean, tries = 300): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error('waitUntil: 조건이 만족되지 않았다');
}

interface Harness {
  handleCallTool: (p: { name: string; args: any }) => Promise<any>;
  events: string[];
  release: () => void;
}

/**
 * web-fetcher 의 execute 를 붙잡아 두는 대역으로 바꾼다. url 분기 호출은 release() 전까지
 * 끝나지 않으므로, 뒤이은 tabId 호출이 시작됐는지로 직렬화 여부를 관측할 수 있다.
 */
async function harness(): Promise<Harness> {
  const toolsModule = await import('@/entrypoints/background/tools/index');
  const { webFetcherTool } = await import('@/entrypoints/background/tools/browser/web-fetcher');

  const events: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });

  vi.spyOn(webFetcherTool as any, 'execute').mockImplementation(async (args: any) => {
    const label = typeof args?.url === 'string' && args.url.trim() ? 'url' : 'tabId';
    events.push(`${label}:start`);
    if (label === 'url') await held;
    events.push(`${label}:end`);
    return { content: [{ type: 'text', text: '{}' }], isError: false };
  });

  return { handleCallTool: toolsModule.handleCallTool as any, events, release };
}

describe('url 대상 호출도 탭 잠금을 받는다', () => {
  beforeEach(() => {
    vi.resetModules();
    installChrome();
  });

  it('회귀(핵심): url 호출이 작업 탭을 물면 같은 탭 tabId 호출과 직렬화된다', async () => {
    const { handleCallTool, events, release } = await harness();

    const byUrl = handleCallTool({
      name: B.WEB_FETCHER,
      args: { _mcpSessionId: SESSION, url: TARGET_URL },
    });
    await waitUntil(() => events.includes('url:start'));

    const byTabId = handleCallTool({
      name: B.WEB_FETCHER,
      args: { _mcpSessionId: SESSION, tabId: WORK_TAB.id },
    });
    await flush();

    // 수정 전에는 url 호출이 잠금을 걸지 않아 여기서 이미 'tabId:start' 가 들어와 있었다.
    expect(events).toEqual(['url:start']);

    release();
    await Promise.all([byUrl, byTabId]);

    expect(events).toEqual(['url:start', 'url:end', 'tabId:start', 'tabId:end']);
  }, 20000);

  it('잠금을 걸어도 게이트는 tabId 를 주입하지 않는다 (url 분기 유지)', async () => {
    const { handleCallTool, events, release } = await harness();
    const { webFetcherTool } = await import('@/entrypoints/background/tools/browser/web-fetcher');

    const byUrl = handleCallTool({
      name: B.WEB_FETCHER,
      args: { _mcpSessionId: SESSION, url: TARGET_URL },
    });
    await waitUntil(() => events.includes('url:start'));
    release();
    await byUrl;

    const passed = (webFetcherTool as any).execute.mock.calls[0][0];
    expect(passed.tabId).toBeUndefined();
    expect(passed.url).toBe(TARGET_URL);
  }, 20000);

  it('세션 범위에 일치 탭이 없으면 잠그지 않는다 (새 탭을 만들 호출)', async () => {
    const { handleCallTool, events, release } = await harness();

    const byUrl = handleCallTool({
      name: B.WEB_FETCHER,
      args: { _mcpSessionId: SESSION, url: UNKNOWN_URL },
    });
    await waitUntil(() => events.includes('url:start'));

    // 다른 탭(작업 탭)을 겨냥한 호출은 막히지 않아야 한다.
    const byTabId = handleCallTool({
      name: B.WEB_FETCHER,
      args: { _mcpSessionId: SESSION, tabId: WORK_TAB.id },
    });
    await waitUntil(() => events.includes('tabId:start'));

    release();
    await Promise.all([byUrl, byTabId]);
    expect(events).toContain('tabId:end');
  }, 20000);

  it('사용자 탭은 URL 이 같아도 잠금 대상으로 뽑히지 않는다', async () => {
    const { resolveUrlTargetTabId } =
      await import('@/entrypoints/background/tools/browser/url-target');

    const resolved = await resolveUrlTargetTabId(B.WEB_FETCHER, {
      _mcpSessionId: SESSION,
      url: TARGET_URL,
    });

    expect(resolved).toBe(WORK_TAB.id);
    expect(resolved).not.toBe(USER_TAB.id);
  }, 20000);
});
