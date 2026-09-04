/**
 * auto-chrome-mcp fork — file:// 이동 버그 회귀 테스트.
 *
 * 재현: `chrome_navigate url=file:///C:/PROJECTS/auto-chrome-mcp/README.md` →
 * `Error navigating to URL: Invalid url pattern 'https:///*'`.
 *
 * 원인: entrypoints/background/tools/browser/common.ts 의 buildUrlPatterns 가 모든 URL 을
 * 웹 주소로 가정해 www/http↔https 변형 6개를 만들었다. altProtocol 분기
 * (`u.protocol === 'https:' ? 'http:' : 'https:'`) 는 https 가 아닌 모든 스킴을 https 로
 * 보므로, host 가 없는 `file:` 입력에 적용하면 `https:///*` 같은 무효 match pattern 이
 * 나오고 chrome.tabs.query 가 그 자리에서 throw 해 이동 자체가 실패했다.
 *
 * 이 파일은:
 *   1. buildUrlPatterns 순수 함수 계약 (http/https·file·chrome-extension·data)
 *   2. file:// 이동이 (수정 전이라면 던졌을) 무효 패턴 없이 tabs.query 를 통과하고
 *      새 탭을 만드는 회귀 케이스
 *   3. chrome.extension.isAllowedFileSchemeAccess() 가 false 일 때 이동을 시도하지
 *      않고 구조화 오류를 돌려주는 케이스
 * 를 검증한다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface WindowRecord {
  id: number;
  type: string;
  incognito: boolean;
  focused: boolean;
}

interface TabRecord {
  id: number;
  windowId: number;
  url: string;
  active: boolean;
  status: string;
}

const USER_WINDOW_ID = 1;
const USER_TAB_ID = 11;

interface Harness {
  windows: WindowRecord[];
  tabs: TabRecord[];
  localStore: Record<string, unknown>;
  sessionStore: Record<string, unknown>;
  tabsQuery: ReturnType<typeof vi.fn>;
  tabsCreate: ReturnType<typeof vi.fn>;
}

/**
 * chrome.tabs.query 의 url match pattern 검증을 실제 크롬과 같은 모양으로 흉내낸다:
 * http/https 스킴인데 host 부분이 비어 있으면(`https:///*`) 그 자리에서 throw 한다.
 * 수정 전 buildUrlPatterns 가 file: 입력에서 만들어내던 바로 그 패턴이다.
 */
function validateMatchPattern(pattern: string): void {
  if (/^https?:\/\/\//.test(pattern)) {
    throw new Error(`Invalid url pattern '${pattern}'`);
  }
}

function installChrome(): Harness {
  const localStore: Record<string, unknown> = {};
  const sessionStore: Record<string, unknown> = {};
  const windows: WindowRecord[] = [
    { id: USER_WINDOW_ID, type: 'normal', incognito: false, focused: true },
  ];
  const tabs: TabRecord[] = [
    {
      id: USER_TAB_ID,
      windowId: USER_WINDOW_ID,
      url: 'https://user-page.example/',
      active: true,
      status: 'complete',
    },
  ];
  let nextTabId = 500;

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

  const tabsQuery = vi.fn(async (query: Record<string, unknown>) => {
    if (query && 'url' in query) {
      const patterns = Array.isArray(query.url) ? query.url : [query.url];
      for (const pattern of patterns as string[]) {
        validateMatchPattern(pattern);
      }
      // 이 하네스에서는 url 필터 조회가 항상 빈 결과 — "이미 열린 탭 없음" 경로로 보낸다.
      return [];
    }
    let out = tabs.slice();
    if (query?.active === true) out = out.filter((t) => t.active);
    if (typeof query?.windowId === 'number') out = out.filter((t) => t.windowId === query.windowId);
    return out;
  });

  const tabsCreate = vi.fn(async (props: Record<string, unknown>) => {
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

  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { id: 'test-extension-id', lastError: undefined },
    storage: { local: makeArea(localStore), session: makeArea(sessionStore) },
    tabs: {
      query: tabsQuery,
      get: vi.fn(async (tabId: number) => {
        const tab = tabs.find((t) => t.id === tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}`);
        return tab;
      }),
      create: tabsCreate,
      update: vi.fn(async (tabId: number, props: Record<string, unknown>) => {
        const tab = tabs.find((t) => t.id === tabId);
        if (!tab) throw new Error(`no tab ${tabId}`);
        if (typeof props.url === 'string') tab.url = props.url;
        if (typeof props.active === 'boolean') tab.active = props.active;
        return tab;
      }),
      remove: vi.fn(async () => undefined),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    windows: {
      get: vi.fn(async (windowId: number) => windows.find((w) => w.id === windowId)),
      getAll: vi.fn(async () => windows.slice()),
      getLastFocused: vi.fn(async () => windows.find((w) => w.id === USER_WINDOW_ID)),
      create: vi.fn(async (createData: Record<string, unknown>) => {
        const id = 100;
        const win: WindowRecord = { id, type: 'normal', incognito: false, focused: false };
        windows.push(win);
        const tab: TabRecord = {
          id: nextTabId++,
          windowId: id,
          url: (createData.url as string) ?? 'about:blank',
          active: true,
          status: 'complete',
        };
        tabs.push(tab);
        return { ...win, tabs: [{ id: tab.id, url: tab.url }] };
      }),
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
  };

  return { windows, tabs, localStore, sessionStore, tabsQuery, tabsCreate };
}

async function loadNavigateModule() {
  vi.resetModules();
  return await import('@/entrypoints/background/tools/browser/common');
}

let h: Harness;

beforeEach(() => {
  h = installChrome();
});

describe('buildUrlPatterns — 스킴별 match pattern 생성', () => {
  it('http(s) 는 www·프로토콜 변형(6개 후보, 중복 제거 후 4개)을 만든다', async () => {
    const { buildUrlPatterns } = await loadNavigateModule();
    const patterns = buildUrlPatterns('http://example.com/page');
    expect(patterns.sort()).toEqual(
      [
        'http://example.com/*',
        'http://www.example.com/*',
        'https://example.com/*',
        'https://www.example.com/*',
      ].sort(),
    );
  });

  it('file: 은 변형 없이 정확한 URL 하나만 돌려준다 (경로 끝 와일드카드 없음)', async () => {
    const { buildUrlPatterns } = await loadNavigateModule();
    const input = 'file:///C:/PROJECTS/auto-chrome-mcp/README.md';
    const patterns = buildUrlPatterns(input);
    expect(patterns).toEqual([input]);
  });

  it('chrome-extension: 도 변형 없이 정확한 URL 하나만 돌려준다', async () => {
    const { buildUrlPatterns } = await loadNavigateModule();
    const input = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html';
    const patterns = buildUrlPatterns(input);
    expect(patterns).toEqual([input]);
  });

  it('data: 처럼 chrome.tabs.query 가 거부하는 스킴은 패턴을 만들지 않는다 (빈 배열)', async () => {
    const { buildUrlPatterns } = await loadNavigateModule();
    const patterns = buildUrlPatterns('data:text/html,<h1>hi</h1>');
    expect(patterns).toEqual([]);
  });

  it('버그 재현 방지: file: 입력에서 예전처럼 https:///* 패턴이 나오지 않는다', async () => {
    const { buildUrlPatterns } = await loadNavigateModule();
    const patterns = buildUrlPatterns('file:///C:/PROJECTS/auto-chrome-mcp/README.md');
    for (const p of patterns) {
      expect(() => validateMatchPattern(p)).not.toThrow();
    }
  });
});

describe('chrome_navigate file:// 회귀', () => {
  it('file:// 이동은 tabs.query 에서 throw 하지 않고 새 탭을 만든다', async () => {
    (chrome as unknown as { extension: unknown }).extension = {
      isAllowedFileSchemeAccess: vi.fn().mockResolvedValue(true),
    };
    const { navigateTool } = await loadNavigateModule();

    const result = await navigateTool.execute({
      url: 'file:///C:/PROJECTS/auto-chrome-mcp/README.md',
      waitUntil: 'none',
    } as never);

    expect(result.isError).toBe(false);
    expect(h.tabsQuery).toHaveBeenCalled();
    expect(h.tabsCreate).toHaveBeenCalledTimes(1);
    const created = h.tabsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(created.url).toBe('file:///C:/PROJECTS/auto-chrome-mcp/README.md');
  });

  it('isAllowedFileSchemeAccess 가 없는 환경(구형 크롬/테스트 목)은 검사를 건너뛴다', async () => {
    // chrome.extension 자체가 없는, 이 하네스의 기본 상태.
    const { navigateTool } = await loadNavigateModule();

    const result = await navigateTool.execute({
      url: 'file:///C:/PROJECTS/auto-chrome-mcp/README.md',
      waitUntil: 'none',
    } as never);

    expect(result.isError).toBe(false);
    expect(h.tabsCreate).toHaveBeenCalledTimes(1);
  });

  it('파일 URL 접근 권한이 꺼져 있으면 이동을 시도하지 않고 구조화 오류를 돌려준다', async () => {
    (chrome as unknown as { extension: unknown }).extension = {
      isAllowedFileSchemeAccess: vi.fn().mockResolvedValue(false),
    };
    const { navigateTool } = await loadNavigateModule();

    const result = await navigateTool.execute({
      url: 'file:///C:/PROJECTS/auto-chrome-mcp/README.md',
      waitUntil: 'none',
    } as never);

    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.error).toBe('file_scheme_access_disabled');
    expect(String(body.message)).toContain('파일 URL에 대한 액세스 허용');

    // 권한이 꺼져 있으면 tabs.query/tabs.create 자체를 시도하지 않는다.
    expect(h.tabsQuery).not.toHaveBeenCalled();
    expect(h.tabsCreate).not.toHaveBeenCalled();
  });
});
