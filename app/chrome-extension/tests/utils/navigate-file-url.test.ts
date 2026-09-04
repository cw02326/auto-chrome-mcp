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
 * chrome.tabs.query 의 url match pattern 검증을 실제 크롬 규칙에 가깝게 흉내낸다
 * (2026-09-05 Codex 4차 검토, 항목 5 — 예전 목은 `https:///*` 하나만 걸렀다):
 *   - `<all_urls>` 는 통과.
 *   - `scheme://host/path` 형태가 아니면 거부 (`view-source:https://…`, 경로 없는
 *     `chrome://settings`, 슬래시 없는 확장 origin 이 여기서 걸린다).
 *   - 크롬이 아는 스킴(http·https·file·ftp·chrome-extension·chrome)과 `*` 만 통과.
 *   - http(s) 인데 host 가 비어 있으면(`https:///*`) 거부.
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
  // 크롬 match pattern 은 경로가 필수다.
  if (slash < 0) throw new Error(`Invalid url pattern '${pattern}'`);
  const host = rest.slice(0, slash);
  if ((scheme === 'http' || scheme === 'https') && host === '') {
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

  // 2026-09-05 Codex 4차 검토(항목 5): 비 http(s) 는 이제 패턴을 만들지 않는다.
  // 예전에는 입력 URL 을 그대로 패턴으로 넘겼는데, 크롬 match pattern 문법이 아닌 값이
  // 섞여 조회가 throw 했다. 호출부는 빈 배열을 보고 정규화 문자열 비교로 넘어간다.
  it('file: 은 패턴을 만들지 않는다 (빈 배열 → 문자열 비교 경로)', async () => {
    const { buildUrlPatterns } = await loadNavigateModule();
    const patterns = buildUrlPatterns('file:///C:/PROJECTS/auto-chrome-mcp/README.md');
    expect(patterns).toEqual([]);
  });

  it('chrome-extension: 도 패턴을 만들지 않는다', async () => {
    const { buildUrlPatterns } = await loadNavigateModule();
    const patterns = buildUrlPatterns(
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html',
    );
    expect(patterns).toEqual([]);
  });

  it('view-source: 처럼 패턴 문법에 맞지 않는 스킴도 빈 배열이다', async () => {
    const { buildUrlPatterns } = await loadNavigateModule();
    expect(buildUrlPatterns('view-source:https://example.com/page')).toEqual([]);
  });

  it('data: 처럼 chrome.tabs.query 가 거부하는 스킴은 패턴을 만들지 않는다 (빈 배열)', async () => {
    const { buildUrlPatterns } = await loadNavigateModule();
    const patterns = buildUrlPatterns('data:text/html,<h1>hi</h1>');
    expect(patterns).toEqual([]);
  });

  it('isPatternQueryableUrl 은 http(s)·와일드카드만 참이다', async () => {
    const { isPatternQueryableUrl } = await loadNavigateModule();
    expect(isPatternQueryableUrl('https://example.com/a')).toBe(true);
    expect(isPatternQueryableUrl('http://example.com/a')).toBe(true);
    expect(isPatternQueryableUrl('https://*.example.com/*')).toBe(true);
    expect(isPatternQueryableUrl('file:///C:/x.md')).toBe(false);
    expect(isPatternQueryableUrl('chrome://settings')).toBe(false);
    expect(isPatternQueryableUrl('view-source:https://example.com/')).toBe(false);
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
  it('file:// 이동은 무효 패턴 조회 없이 새 탭을 만든다', async () => {
    (chrome as unknown as { extension: unknown }).extension = {
      isAllowedFileSchemeAccess: vi.fn().mockResolvedValue(true),
    };
    const { navigateTool } = await loadNavigateModule();

    const result = await navigateTool.execute({
      url: 'file:///C:/PROJECTS/auto-chrome-mcp/README.md',
      waitUntil: 'none',
    } as never);

    expect(result.isError).toBe(false);
    // 항목 5: file: 은 url 필터 조회를 아예 하지 않는다.
    const urlFilteredQueries = h.tabsQuery.mock.calls.filter(
      (call) => !!call[0] && 'url' in (call[0] as Record<string, unknown>),
    );
    expect(urlFilteredQueries).toHaveLength(0);
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

/**
 * 2026-09-05 Codex 4차 검토(항목 3): 예전 가드는 `url.startsWith('file:')` 이었다.
 * 대문자 스킴과 앞 공백이 그대로 통과했고, 권한 API 가 throw 하면 허용으로 넘어갔다.
 */
describe('항목 3 — file: 판별과 권한 확인의 우회 경로', () => {
  function denyFileAccess(): void {
    (chrome as unknown as { extension: unknown }).extension = {
      isAllowedFileSchemeAccess: vi.fn().mockResolvedValue(false),
    };
  }

  async function expectBlocked(url: string): Promise<void> {
    const { navigateTool } = await loadNavigateModule();
    const result = await navigateTool.execute({ url, waitUntil: 'none' } as never);
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.error).toBe('file_scheme_access_disabled');
    expect(h.tabsCreate).not.toHaveBeenCalled();
  }

  it('회귀(핵심): 대문자 스킴 FILE:/// 도 막는다', async () => {
    denyFileAccess();
    await expectBlocked('FILE:///C:/PROJECTS/auto-chrome-mcp/README.md');
  });

  it('회귀(핵심): 앞에 공백이 붙은 file: 도 막는다', async () => {
    denyFileAccess();
    await expectBlocked('  file:///C:/PROJECTS/auto-chrome-mcp/README.md');
  });

  it('회귀(핵심): 권한 API 가 throw 하면 허용이 아니라 거부다 (fail-closed)', async () => {
    (chrome as unknown as { extension: unknown }).extension = {
      isAllowedFileSchemeAccess: vi.fn().mockRejectedValue(new Error('api boom')),
    };
    await expectBlocked('file:///C:/PROJECTS/auto-chrome-mcp/README.md');
  });

  it('URL 로 파싱되지 않는 입력은 file: 로 보지 않는다 (이동 경로는 그대로)', async () => {
    denyFileAccess();
    const { navigateTool } = await loadNavigateModule();
    const result = await navigateTool.execute({
      url: 'not a url at all',
      waitUntil: 'none',
    } as never);
    // 파일 가드가 아니라 기존 이동 경로가 처리한다 — 구조화 파일 오류가 아니어야 한다.
    if (result.isError === true) {
      const text = (result.content[0] as { text: string }).text;
      expect(text).not.toContain('file_scheme_access_disabled');
    }
  });
});

/**
 * 2026-09-05 Codex 4차 검토(항목 6): 요청 URL 은 file: 이 아니었는데 리다이렉트로 file:
 * 문서에 도달했고 권한이 없으면, 이동은 이미 끝났으므로 오류가 아니라 경고만 싣는다.
 */
describe('항목 6 — 리다이렉트로 도달한 file: 문서 경고', () => {
  async function navigateEndingAtFileUrl(): Promise<Record<string, unknown>> {
    h.tabsCreate.mockImplementationOnce(async (props: Record<string, unknown>) => {
      const tab: TabRecord = {
        id: 777,
        windowId: USER_WINDOW_ID,
        url: 'file:///C:/redirected.md',
        active: props.active === true,
        status: 'complete',
      };
      h.tabs.push(tab);
      return tab;
    });
    const { navigateTool } = await loadNavigateModule();
    const result = await navigateTool.execute({
      url: 'https://redirect.test/start',
      waitUntil: 'domcontentloaded',
      waitTimeoutMs: 1000,
    } as never);
    return JSON.parse((result.content[0] as { text: string }).text);
  }

  it('회귀(핵심): 권한이 없으면 결과에 경고 필드를 싣는다 (오류는 아니다)', async () => {
    (chrome as unknown as { extension: unknown }).extension = {
      isAllowedFileSchemeAccess: vi.fn().mockResolvedValue(false),
    };
    const payload = await navigateEndingAtFileUrl();
    expect(payload.url).toBe('file:///C:/redirected.md');
    expect(String(payload.fileSchemeAccessWarning)).toContain('파일 URL에 대한 액세스 허용');
  });

  it('권한이 있으면 경고를 싣지 않는다', async () => {
    (chrome as unknown as { extension: unknown }).extension = {
      isAllowedFileSchemeAccess: vi.fn().mockResolvedValue(true),
    };
    const payload = await navigateEndingAtFileUrl();
    expect(payload.fileSchemeAccessWarning).toBeUndefined();
  });
});
