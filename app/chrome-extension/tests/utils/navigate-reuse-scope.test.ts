/**
 * auto-chrome-mcp fork — chrome_navigate 의 "이미 열린 탭" 재사용 범위 회귀 테스트.
 * (2026-09-05 Codex 4차 검토 항목 1·4·5)
 *
 * 항목 1: 재사용 범위가 호출 인자 `background` 에 묶여 있었다. 전역 백그라운드 작업 모드가
 *   켜져 있어도 호출자가 `background:false` 를 주면 "사용자 탭 제외" 필터가 통째로 꺼져,
 *   사용자가 보고 있던 같은 URL 의 탭을 MCP 가 작업 탭으로 채갔다. 이제 범위는
 *   isBackgroundModeEnabled() 가 정하고, `background` 인자는 활성화·포커스에만 쓴다.
 *
 * 항목 4: `chrome.tabs.query` 의 오류를 전부 삼켜 "후보 없음" 으로 처리했다. match pattern
 *   거부뿐 아니라 권한 오류·extension context 무효화까지 조용히 새 탭 생성으로 넘어갔다.
 *
 * 항목 5: http(s) 가 아닌 스킴은 match pattern 조회 자체가 취약하다(`view-source:`,
 *   경로 없는 `chrome://settings`). 이제 조회를 하지 않고 세션 범위 탭의 URL 을 정규화해
 *   문자열로 비교한다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TARGET_URL = 'https://target.test/page';
const SESSION = 'stdio-navigate-reuse-1';
const USER_WINDOW_ID = 1;
const OWNED_WINDOW_ID = 2;
const USER_TAB_ID = 11;
const OWNED_TAB_ID = 99;

interface TabRecord {
  id: number;
  windowId: number;
  url: string;
  active: boolean;
  status: string;
}

interface Harness {
  tabs: TabRecord[];
  tabsQuery: ReturnType<typeof vi.fn>;
  tabsCreate: ReturnType<typeof vi.fn>;
  tabsUpdate: ReturnType<typeof vi.fn>;
  /** 다음 url 필터 조회에서 던질 오류 (항목 4 재현용). */
  queryError: Error | null;
}

/**
 * chrome.tabs.query 의 match pattern 검증을 실제 크롬 규칙에 가깝게 흉내낸다:
 * `scheme://host/path` 형태여야 하고, 스킴은 크롬이 아는 것이어야 하며, http(s) 는 host 가
 * 있어야 한다. `view-source:https://…` · 경로 없는 `chrome://settings` 가 여기서 걸린다.
 */
const ALLOWED_PATTERN_SCHEMES = ['http', 'https', 'file', 'ftp', 'chrome-extension', 'chrome'];

function validateMatchPattern(pattern: string): void {
  if (pattern === '<all_urls>') return;
  const parsed = /^([a-zA-Z][a-zA-Z0-9+.-]*|\*):\/\/(.*)$/.exec(pattern);
  if (!parsed) throw new Error(`Invalid url pattern '${pattern}'`);
  const scheme = parsed[1].toLowerCase();
  const rest = parsed[2];
  if (scheme !== '*' && !ALLOWED_PATTERN_SCHEMES.includes(scheme)) {
    throw new Error(`Invalid url pattern '${pattern}'`);
  }
  const slash = rest.indexOf('/');
  if (slash < 0) throw new Error(`Invalid url pattern '${pattern}'`);
  const host = rest.slice(0, slash);
  if ((scheme === 'http' || scheme === 'https') && host === '') {
    throw new Error(`Invalid url pattern '${pattern}'`);
  }
}

/** 'scheme://host/prefix*' 패턴이 url 에 맞는지 (이 하네스가 쓰는 범위만). */
function patternMatches(pattern: string, url: string): boolean {
  const parsed = /^([^:]+):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!parsed) return false;
  const [, scheme, host, path] = parsed;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return false;
  }
  if (parsedUrl.protocol !== `${scheme}:`) return false;
  if (host && parsedUrl.host !== host) return false;
  const prefix = path.endsWith('*') ? path.slice(0, -1) : path;
  return `${parsedUrl.pathname}${parsedUrl.search}`.startsWith(prefix);
}

function installChrome(options: {
  backgroundMode: boolean;
  ownedTabs?: number[];
  tabs: TabRecord[];
}): Harness {
  const localStore: Record<string, unknown> = {};
  if (options.backgroundMode === false) localStore.backgroundWorkMode = false;
  const sessionStore: Record<string, unknown> = {};
  if (options.ownedTabs && options.ownedTabs.length > 0) {
    sessionStore.mcpOwnedTabs = {
      [SESSION]: options.ownedTabs.map((tabId) => ({ tabId, touchedAt: Date.now() })),
    };
  }

  const tabs = options.tabs;
  let nextTabId = 500;
  const harness: Harness = {
    tabs,
    tabsQuery: vi.fn(),
    tabsCreate: vi.fn(),
    tabsUpdate: vi.fn(),
    queryError: null,
  };

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

  harness.tabsQuery.mockImplementation(async (query: Record<string, unknown>) => {
    if (query && 'url' in query) {
      if (harness.queryError) throw harness.queryError;
      const patterns = (Array.isArray(query.url) ? query.url : [query.url]) as string[];
      for (const pattern of patterns) validateMatchPattern(pattern);
      return tabs.filter((tab) => patterns.some((pattern) => patternMatches(pattern, tab.url)));
    }
    let out = tabs.slice();
    if (query?.active === true) out = out.filter((t) => t.active);
    if (typeof query?.windowId === 'number') out = out.filter((t) => t.windowId === query.windowId);
    return out;
  });

  harness.tabsCreate.mockImplementation(async (props: Record<string, unknown>) => {
    const tab: TabRecord = {
      id: nextTabId++,
      windowId: (props.windowId as number) ?? USER_WINDOW_ID,
      url: (props.url as string) ?? 'about:blank',
      active: props.active === true,
      status: 'complete',
    };
    tabs.push(tab);
    return tab;
  });

  harness.tabsUpdate.mockImplementation(async (tabId: number, props: Record<string, unknown>) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}`);
    if (typeof props.url === 'string') tab.url = props.url;
    if (typeof props.active === 'boolean') tab.active = props.active;
    return tab;
  });

  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { id: 'test-extension-id', lastError: undefined },
    storage: { local: makeArea(localStore), session: makeArea(sessionStore) },
    tabs: {
      query: harness.tabsQuery,
      get: vi.fn(async (tabId: number) => {
        const tab = tabs.find((t) => t.id === tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}`);
        return tab;
      }),
      create: harness.tabsCreate,
      update: harness.tabsUpdate,
      remove: vi.fn(async () => undefined),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    windows: {
      get: vi.fn(async (windowId: number) => ({ id: windowId, type: 'normal', incognito: false })),
      getAll: vi.fn(async () => [
        { id: USER_WINDOW_ID, type: 'normal', incognito: false, focused: true },
        { id: OWNED_WINDOW_ID, type: 'normal', incognito: false, focused: false },
      ]),
      getLastFocused: vi.fn(async () => ({
        id: USER_WINDOW_ID,
        type: 'normal',
        incognito: false,
        focused: true,
      })),
      create: vi.fn(async () => ({ id: 100, type: 'normal', tabs: [] })),
      update: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onFocusChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      WINDOW_ID_NONE: -1,
    },
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
      setTitle: vi.fn(async () => undefined),
    },
    debugger: {
      getTargets: vi.fn(async () => []),
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async () => ({})),
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
      onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    webNavigation: {
      onCommitted: { addListener: vi.fn(), removeListener: vi.fn() },
      onDOMContentLoaded: { addListener: vi.fn(), removeListener: vi.fn() },
      onCompleted: { addListener: vi.fn(), removeListener: vi.fn() },
      onCreatedNavigationTarget: { addListener: vi.fn(), removeListener: vi.fn() },
      onErrorOccurred: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    downloads: { onCreated: { addListener: vi.fn(), removeListener: vi.fn() } },
    scripting: {
      executeScript: vi.fn(async () => {
        throw new Error('no scripting in test');
      }),
    },
    tabGroups: { query: vi.fn(async () => []), update: vi.fn(async () => ({})) },
  };

  return harness;
}

function userTab(url = TARGET_URL): TabRecord {
  return { id: USER_TAB_ID, windowId: USER_WINDOW_ID, url, active: true, status: 'complete' };
}

function ownedTab(url = TARGET_URL): TabRecord {
  return { id: OWNED_TAB_ID, windowId: OWNED_WINDOW_ID, url, active: false, status: 'complete' };
}

async function loadNavigateTool() {
  vi.resetModules();
  return await import('@/entrypoints/background/tools/browser/common');
}

async function navigate(args: Record<string, unknown>): Promise<Record<string, any>> {
  const { navigateTool } = await loadNavigateTool();
  const result = await navigateTool.execute({
    _mcpSessionId: SESSION,
    waitUntil: 'none',
    ...args,
  } as never);
  return {
    isError: result.isError === true,
    text: (result.content[0] as { text: string }).text,
  };
}

function payloadOf(result: Record<string, any>): any {
  return JSON.parse(result.text);
}

let h: Harness;

beforeEach(() => {
  vi.resetModules();
});

describe('항목 1 — 재사용 범위는 전역 모드가 정한다 (호출 인자 background 가 아니다)', () => {
  it('회귀(핵심): 모드 ON 이면 background:false 여도 사용자 탭을 채가지 않는다', async () => {
    h = installChrome({ backgroundMode: true, tabs: [userTab()] });

    const result = await navigate({ url: TARGET_URL, background: false });
    const payload = payloadOf(result);

    expect(result.isError).toBe(false);
    expect(payload.tabId).not.toBe(USER_TAB_ID);
    expect(h.tabsCreate).toHaveBeenCalledTimes(1);
    // 사용자 탭을 다른 URL 로 끌고 가지도 않았다.
    expect(h.tabs.find((t) => t.id === USER_TAB_ID)?.url).toBe(TARGET_URL);
  });

  it('회귀: file:// 도 마찬가지다 — background:false 로 사용자의 file: 탭을 잡지 않는다', async () => {
    const fileUrl = 'file:///C:/PROJECTS/auto-chrome-mcp/README.md';
    h = installChrome({ backgroundMode: true, tabs: [userTab(fileUrl)] });
    (chrome as unknown as { extension: unknown }).extension = {
      isAllowedFileSchemeAccess: vi.fn(async () => true),
    };

    const payload = payloadOf(await navigate({ url: fileUrl, background: false }));

    expect(payload.tabId).not.toBe(USER_TAB_ID);
    expect(h.tabsCreate).toHaveBeenCalledTimes(1);
  });

  it('모드 ON 이고 이 세션이 소유한 탭이 같은 URL 이면 그 탭을 재사용한다', async () => {
    h = installChrome({
      backgroundMode: true,
      ownedTabs: [OWNED_TAB_ID],
      tabs: [userTab(), ownedTab()],
    });

    const payload = payloadOf(await navigate({ url: TARGET_URL, background: false }));

    expect(payload.tabId).toBe(OWNED_TAB_ID);
    expect(h.tabsCreate).not.toHaveBeenCalled();
  });

  it('모드 OFF 면 예전 동작 그대로 — 이미 열린 사용자 탭을 재사용한다', async () => {
    h = installChrome({ backgroundMode: false, tabs: [userTab()] });

    const payload = payloadOf(await navigate({ url: TARGET_URL, background: false }));

    expect(payload.tabId).toBe(USER_TAB_ID);
    expect(h.tabsCreate).not.toHaveBeenCalled();
  });
});

describe('항목 4 — tabs.query 오류를 구분한다', () => {
  it('회귀(핵심): match pattern 이 아닌 오류는 삼키지 않고 그대로 알린다', async () => {
    h = installChrome({ backgroundMode: false, tabs: [userTab('https://other.test/')] });
    h.queryError = new Error('Extension context invalidated.');

    const result = await navigate({ url: TARGET_URL });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Extension context invalidated');
    // 진짜 고장인데 조용히 새 탭을 만들지 않는다.
    expect(h.tabsCreate).not.toHaveBeenCalled();
  });

  it('match pattern 거부는 예전대로 "후보 없음" 으로 복구한다', async () => {
    h = installChrome({ backgroundMode: false, tabs: [userTab('https://other.test/')] });
    h.queryError = new Error("Invalid url pattern 'https:///*'");

    const result = await navigate({ url: TARGET_URL });

    expect(result.isError).toBe(false);
    expect(h.tabsCreate).toHaveBeenCalledTimes(1);
  });
});

describe('항목 5 — 비 http(s) 스킴은 정규화 URL 문자열로 비교한다', () => {
  it('회귀(핵심): view-source: 는 패턴 조회 없이 소유 탭을 재사용한다', async () => {
    const viewSource = 'view-source:https://target.test/page';
    h = installChrome({
      backgroundMode: true,
      ownedTabs: [OWNED_TAB_ID],
      tabs: [userTab(viewSource), ownedTab(viewSource)],
    });

    const payload = payloadOf(await navigate({ url: viewSource, background: false }));

    expect(payload.tabId).toBe(OWNED_TAB_ID);
    expect(h.tabsCreate).not.toHaveBeenCalled();
    const urlFilteredQueries = h.tabsQuery.mock.calls.filter(
      (call) => !!call[0] && 'url' in (call[0] as Record<string, unknown>),
    );
    expect(urlFilteredQueries).toHaveLength(0);
  });

  it('회귀(핵심): 경로 없는 chrome://settings 도 재사용된다 (끝 슬래시 차이 흡수)', async () => {
    h = installChrome({
      backgroundMode: true,
      ownedTabs: [OWNED_TAB_ID],
      tabs: [ownedTab('chrome://settings/')],
    });

    const payload = payloadOf(await navigate({ url: 'chrome://settings', background: false }));

    expect(payload.tabId).toBe(OWNED_TAB_ID);
    expect(h.tabsCreate).not.toHaveBeenCalled();
  });

  it('모드 OFF 의 비 http(s) 조회도 패턴을 쓰지 않는다 (전체 탭에서 문자열 비교)', async () => {
    h = installChrome({
      backgroundMode: false,
      tabs: [userTab('chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html')],
    });

    const payload = payloadOf(
      await navigate({
        url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html',
        background: false,
      }),
    );

    expect(payload.tabId).toBe(USER_TAB_ID);
    const urlFilteredQueries = h.tabsQuery.mock.calls.filter(
      (call) => !!call[0] && 'url' in (call[0] as Record<string, unknown>),
    );
    expect(urlFilteredQueries).toHaveLength(0);
  });
});
