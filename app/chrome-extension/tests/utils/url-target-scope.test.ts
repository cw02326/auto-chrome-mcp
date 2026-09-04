/**
 * auto-chrome-mcp fork — `url` 인자로 대상 탭을 고르는 도구는 세션이 소유한 탭만 본다.
 *
 * 배경(2026-09-04 Codex 3차 검토, 항목 1): web-fetcher · console · inject-script 는 `url` 이
 * 오면 `chrome.tabs.query({})` / `chrome.tabs.query({ url })` 로 **모든 창의 모든 탭**을 뒤져
 * 첫 일치 탭을 골랐다. 그래서 백그라운드 작업 모드에서도 사용자가 보고 있는 창의 탭이 읽히고
 * 스크립트가 주입되고 CDP 디버거가 붙었다. `{windowId: 42, url: X}` 처럼 창을 지정해도 같았다.
 *
 * 계약:
 *   - 모드 ON: 후보는 이 세션·레인이 소유한 탭뿐이다. 사용자 탭은 일치해도 고르지 않는다.
 *   - 못 찾으면 새 탭을 만든다. 이때 호출자가 준 windowId 를 반드시 넘긴다
 *     (안 넘기면 크롬이 사용자가 보고 있는 창에 탭을 붙인다).
 *   - 모드 OFF: 예전 동작(전체 탭 검색)을 그대로 둔다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TARGET_URL = 'https://target.test/page';
/** 사용자가 보고 있는 탭 — 공교롭게 같은 URL 이다(하이재킹 재현 조건). */
const USER_TAB = {
  id: 11,
  windowId: 1,
  url: TARGET_URL,
  title: 'user',
  active: true,
  status: 'complete',
};
/** 이 세션이 소유한 작업 탭 — 다른 창에 있다. */
const OWNED_TAB = {
  id: 99,
  windowId: 2,
  url: TARGET_URL,
  title: 'owned',
  active: false,
  status: 'complete',
};

const SESSION = 'stdio-url-scope-1';

interface Harness {
  created: any[];
  queries: any[];
}

let h: Harness;

function installChrome(options: { backgroundMode: boolean; ownedTabs?: number[] }): Harness {
  const created: any[] = [];
  const queries: any[] = [];
  const localStore: Record<string, unknown> = {};
  if (options.backgroundMode === false) localStore.backgroundWorkMode = false;

  const sessionStore: Record<string, unknown> = {};
  if (options.ownedTabs && options.ownedTabs.length > 0) {
    sessionStore.mcpOwnedTabs = {
      [SESSION]: options.ownedTabs.map((tabId) => ({ tabId, touchedAt: Date.now() })),
    };
  }

  const tabsById: Record<number, any> = { 11: USER_TAB, 99: OWNED_TAB };

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
    remove: vi.fn(async () => undefined),
  });

  (globalThis as any).chrome = {
    runtime: { id: 'test-extension-id' },
    storage: { local: makeArea(localStore), session: makeArea(sessionStore) },
    tabs: {
      query: vi.fn(async (q: any) => {
        queries.push(q);
        // 전체 검색이면 사용자 탭이 먼저 걸린다 — 예전 구현이 이 탭을 골랐다.
        return [USER_TAB, OWNED_TAB];
      }),
      get: vi.fn(async (id: number) => {
        const tab = tabsById[id];
        if (!tab) throw new Error(`No tab with id: ${id}`);
        return tab;
      }),
      create: vi.fn(async (info: any) => {
        created.push(info);
        return { id: 500, windowId: info.windowId ?? 1, url: info.url, status: 'complete' };
      }),
      update: vi.fn(async () => USER_TAB),
      sendMessage: vi.fn(async () => ({ success: true })),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    windows: {
      get: vi.fn(async (id: number) => ({ id, type: 'normal' })),
      update: vi.fn(async () => undefined),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onFocusChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: { executeScript: vi.fn(async () => [{ result: 'ok' }]) },
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
    },
    tabGroups: { query: vi.fn(async () => []), update: vi.fn(async () => ({})) },
  };

  return { created, queries };
}

async function loadTarget() {
  vi.resetModules();
  return await import('@/entrypoints/background/tools/browser/url-target');
}

describe('findTabByUrlInSessionScope — 사용자 탭은 후보가 아니다 (항목 1)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('회귀(핵심): 모드 ON 이면 URL 이 같아도 사용자 탭을 고르지 않는다', async () => {
    h = installChrome({ backgroundMode: true });
    const { findTabByUrlInSessionScope } = await loadTarget();

    const tab = await findTabByUrlInSessionScope(TARGET_URL, { _mcpSessionId: SESSION });

    // 소유 탭이 하나도 없으면 후보가 없다 — 사용자 탭으로 떨어지면 안 된다.
    expect(tab).toBeNull();
    // 전체 탭 검색(chrome.tabs.query) 자체를 하지 않는다.
    expect(h.queries).toHaveLength(0);
  });

  it('모드 ON 이고 소유 탭이 URL 과 맞으면 그 탭을 고른다', async () => {
    h = installChrome({ backgroundMode: true, ownedTabs: [99] });
    const { findTabByUrlInSessionScope } = await loadTarget();

    const tab = await findTabByUrlInSessionScope(TARGET_URL, { _mcpSessionId: SESSION });

    expect(tab?.id).toBe(99);
  });

  it('끝 슬래시 차이는 같은 URL 로 본다 (예전 비교 규칙 유지)', async () => {
    h = installChrome({ backgroundMode: true, ownedTabs: [99] });
    const { findTabByUrlInSessionScope } = await loadTarget();

    const tab = await findTabByUrlInSessionScope(`${TARGET_URL}/`, { _mcpSessionId: SESSION });

    expect(tab?.id).toBe(99);
  });

  it('다른 레인의 소유 탭은 빌려 쓰지 않는다', async () => {
    h = installChrome({ backgroundMode: true, ownedTabs: [99] });
    const { findTabByUrlInSessionScope } = await loadTarget();

    const tab = await findTabByUrlInSessionScope(TARGET_URL, {
      _mcpSessionId: SESSION,
      lane: 'other',
    });

    expect(tab).toBeNull();
  });

  it('모드 OFF 면 예전대로 전체 탭에서 찾는다', async () => {
    h = installChrome({ backgroundMode: false });
    const { findTabByUrlInSessionScope } = await loadTarget();

    const tab = await findTabByUrlInSessionScope(TARGET_URL, { _mcpSessionId: SESSION });

    expect(tab?.id).toBe(11);
    expect(h.queries.length).toBeGreaterThan(0);
  });
});

describe('createTabForUrl — 새 탭은 지정한 창에 만든다 (항목 1)', () => {
  it('회귀: windowId 를 주면 그 창에 만든다 (안 넘기면 사용자 창에 붙는다)', async () => {
    h = installChrome({ backgroundMode: true });
    const { createTabForUrl } = await loadTarget();

    await createTabForUrl(TARGET_URL, {
      background: true,
      windowId: 42,
      reason: 'test',
      args: { _mcpSessionId: SESSION },
    });

    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ url: TARGET_URL, windowId: 42, active: false });
  });

  it('만든 탭은 이 세션 소유로 등록돼 다음 URL 조회의 후보가 된다', async () => {
    h = installChrome({ backgroundMode: true });
    const { createTabForUrl, findTabByUrlInSessionScope } = await loadTarget();

    await createTabForUrl(TARGET_URL, {
      background: true,
      reason: 'test',
      args: { _mcpSessionId: SESSION },
    });

    // 방금 만든 탭(id 500)이 소유 목록에 들어갔는지 — chrome.tabs.get 이 500 을 알도록 채운다.
    const chrome = (globalThis as any).chrome;
    const prevGet = chrome.tabs.get;
    chrome.tabs.get = vi.fn(async (id: number) => {
      if (id === 500) return { id: 500, windowId: 1, url: TARGET_URL };
      return await prevGet(id);
    });

    const tab = await findTabByUrlInSessionScope(TARGET_URL, { _mcpSessionId: SESSION });
    expect(tab?.id).toBe(500);
  });
});

describe('web-fetcher · inject-script 의 url 분기가 사용자 탭을 잡지 않는다 (항목 1)', () => {
  it('회귀(핵심): chrome_get_web_content({url}) 는 사용자 탭 대신 새 탭을 만든다', async () => {
    h = installChrome({ backgroundMode: true });
    vi.resetModules();
    const { webFetcherTool } = await import('@/entrypoints/background/tools/browser/web-fetcher');
    const tool = webFetcherTool as any;
    vi.spyOn(tool, 'injectContentScript').mockResolvedValue(undefined as never);
    vi.spyOn(tool, 'sendMessageToTab').mockResolvedValue({
      success: true,
      textContent: 'x',
      title: 't',
    } as never);

    await tool.execute({
      _mcpSessionId: SESSION,
      url: TARGET_URL,
      windowId: 42,
      background: true,
    });

    // 사용자 탭(11)을 쓰지 않고 새 탭을 지정한 창에 만들었어야 한다.
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ url: TARGET_URL, windowId: 42 });
  });

  it('회귀(핵심): chrome_inject_script({url}) 도 사용자 탭 대신 새 탭을 만든다', async () => {
    h = installChrome({ backgroundMode: true });
    vi.resetModules();
    const injectModule = await import('@/entrypoints/background/tools/browser/inject-script');
    const tool = (injectModule as any).injectScriptTool ?? (injectModule as any).default;
    expect(tool, 'inject-script tool export').toBeTruthy();

    await tool.execute({
      _mcpSessionId: SESSION,
      url: TARGET_URL,
      windowId: 42,
      background: true,
      type: 'ISOLATED',
      jsScript: 'void 0;',
    });

    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ url: TARGET_URL, windowId: 42 });
  });
});
