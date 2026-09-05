/**
 * auto-chrome-mcp fork(F2) — 백그라운드 작업 모드 게이트의 fail-closed 계약.
 *
 * 재현하려는 실패: 새 세션에서 chrome_navigate 없이 chrome_click_element /
 * chrome_fill_or_select / chrome_read_page / chrome_screenshot 를 먼저 부르면,
 * 게이트가 tabId 를 주입하지 못하고 그대로 통과시켰다. 각 도구 구현은 tabId 가 없으면
 * 활성 탭으로 fallback 하므로(interaction.ts / read-page.ts / screenshot.ts), 사용자가
 * 보고 있는 탭이 읽히고 조작됐다.
 *
 * 계약:
 *   - background mode ON + 대상 도구 + tabId 미지정 + 작업 탭 없음 → noWorkTab (거절)
 *   - tabId 를 명시했으면 그대로 통과
 *   - 작업 탭이 있으면 주입해서 통과
 *   - 예외 도구(switch_tab 등)와 주입 대상이 아닌 도구(navigate, set_work_tab,
 *     get_windows_and_tabs)는 영향 없음
 *   - background mode OFF 면 예전 동작 유지 (거절하지 않음)
 *
 * work-tab-manager 는 import 시점에 리스너를 달고 map 을 모듈 스코프에 캐시하므로,
 * mock 설치 → vi.resetModules() → 동적 import 순서로 격리한다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TOOL_NAMES } from 'auto-chrome-mcp-shared';

const B = TOOL_NAMES.BROWSER;

type Gate = typeof import('@/utils/work-tab-gate');

interface Harness {
  localStore: Record<string, unknown>;
  sessionStore: Record<string, unknown>;
  tabs: Set<number>;
}

function installChrome(): Harness {
  const localStore: Record<string, unknown> = {};
  const sessionStore: Record<string, unknown> = {};
  const tabs = new Set<number>();

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

  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { id: 'test-extension-id' },
    storage: { local: makeArea(localStore), session: makeArea(sessionStore) },
    tabs: {
      get: vi.fn(async (tabId: number) => {
        if (!tabs.has(tabId)) throw new Error(`No tab with id: ${tabId}`);
        return { id: tabId, url: `https://example.com/${tabId}`, windowId: 1, active: false };
      }),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    windows: {
      get: vi.fn(async () => {
        throw new Error('no such window');
      }),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
    },
    scripting: { executeScript: vi.fn(async () => [{ result: undefined }]) },
  };

  return { localStore, sessionStore, tabs };
}

async function loadGate(): Promise<Gate> {
  vi.resetModules();
  return await import('@/utils/work-tab-gate');
}

const SESSION = 'stdio-gate-1';

/** navigate 를 거치지 않고 작업 탭 기록만 심는다 (게이트 판정만 보려는 테스트용). */
function seedWorkTab(h: Harness, sessionKey: string, tabId: number): void {
  h.tabs.add(tabId);
  const existing = (h.sessionStore['mcpWorkTabs'] as Record<string, unknown>) ?? {};
  h.sessionStore['mcpWorkTabs'] = {
    ...existing,
    [sessionKey]: { tabId, lastUsedAt: Date.now(), owned: true },
  };
}

/** 사용자 탭으로 흘러가면 안 되는 대표 도구들 (Codex 지적에 나온 네 개 포함). */
const HIJACK_PRONE_TOOLS = [
  B.CLICK,
  B.FILL,
  B.READ_PAGE,
  B.SCREENSHOT,
  B.KEYBOARD,
  B.JAVASCRIPT,
  B.EXTRACT,
  B.SCROLL_COLLECT,
];

describe('requiresWorkTab — 도구·인자만 보는 순수 판정 (F2)', () => {
  beforeEach(() => {
    installChrome();
  });

  it('tabId 없이 부른 하이재킹 위험 도구는 작업 탭을 요구한다', async () => {
    const gate = await loadGate();
    for (const name of HIJACK_PRONE_TOOLS) {
      expect(gate.requiresWorkTab(name, { _mcpSessionId: SESSION }), name).toBe(true);
    }
  });

  it('호출자가 tabId 를 명시했으면 요구하지 않는다', async () => {
    const gate = await loadGate();
    for (const name of HIJACK_PRONE_TOOLS) {
      expect(gate.requiresWorkTab(name, { tabId: 11 }), name).toBe(false);
    }
  });

  it('사용자 대면 예외 도구와 주입 대상이 아닌 도구는 요구하지 않는다', async () => {
    const gate = await loadGate();
    for (const name of [
      B.SWITCH_TAB,
      B.REQUEST_ELEMENT_SELECTION,
      B.REQUEST_USER_CONSENT,
      B.NAVIGATE,
      B.SET_WORK_TAB,
      B.GET_WINDOWS_AND_TABS,
      B.CLOSE_TABS,
    ]) {
      expect(gate.requiresWorkTab(name, {}), name).toBe(false);
    }
  });

  it('탭을 아예 찾지 않는 호출은 막지 않는다 (network_rules · url 을 준 쿠키 조작)', async () => {
    const gate = await loadGate();
    // tabId 를 안 주면 규칙 범위가 '모든 탭' — 활성 탭 조회 경로가 없다.
    expect(gate.requiresWorkTab(B.NETWORK_RULES, { action: 'list' })).toBe(false);
    // url 을 직접 준 쿠키 조회는 대상 탭을 찾지 않는다.
    expect(gate.requiresWorkTab(B.STORAGE, { action: 'get', url: 'https://example.com/' })).toBe(
      false,
    );
    // 웹 스토리지 경로는 반드시 탭이 필요하다.
    expect(
      gate.requiresWorkTab(B.STORAGE, {
        action: 'get',
        kind: 'local',
        url: 'https://example.com/',
      }),
    ).toBe(true);
    expect(gate.requiresWorkTab(B.STORAGE, { action: 'get' })).toBe(true);
  });
});

// ===========================================================================
// 잘못된 tabId 로 게이트를 우회하지 못한다 (2026-09-04 독립 검증 지적)
// ===========================================================================
describe('잘못된 tabId 는 통과가 아니라 거절이다', () => {
  let h: Harness;

  beforeEach(() => {
    h = installChrome();
  });

  const BAD_TAB_IDS: Array<[string, unknown]> = [
    ['null', null],
    ['문자열', 'x'],
    ['0', 0],
    ['음수', -3],
    ['NaN', Number.NaN],
    ['소수', 1.5],
    ['객체', {}],
  ];

  it('양의 정수가 아닌 tabId 는 "명시됨" 으로 인정하지 않는다', async () => {
    const gate = await loadGate();
    for (const [label, tabId] of BAD_TAB_IDS) {
      // 예전에는 `args.tabId !== undefined` 만 봤으므로 tabId:null 이 "명시됨" 이 되어
      // 게이트를 그대로 통과했고, 도구 구현이 활성 탭으로 fallback 했다.
      expect(gate.requiresWorkTab(B.CLICK, { tabId }), label).toBe(true);
    }
  });

  it('작업 탭이 있어도 잘못된 tabId 는 조용히 바꿔치기하지 않고 거절한다', async () => {
    const gate = await loadGate();
    seedWorkTab(h, SESSION, 777);

    for (const [label, tabId] of BAD_TAB_IDS) {
      const result = await gate.applyBackgroundModeGate(B.CLICK, {
        _mcpSessionId: SESSION,
        tabId,
      });
      expect(result.invalidTabId, label).toBe(true);
      expect(result.noWorkTab, label).toBe(false);
      // 작업 탭으로 슬쩍 갈아 끼우지 않는다 — 호출자가 준 값이 틀렸다고 알려야 한다.
      expect(result.args.tabId, label).toBe(tabId);
    }
  });

  it('background mode 가 꺼져 있어도 잘못된 tabId 는 거절한다 (활성 탭 fallback 금지)', async () => {
    const gate = await loadGate();
    h.localStore['backgroundWorkMode'] = false;

    const result = await gate.applyBackgroundModeGate(B.READ_PAGE, {
      _mcpSessionId: SESSION,
      tabId: null,
    });
    expect(result.invalidTabId).toBe(true);
  });

  it('예외 도구도 잘못된 tabId 는 거절한다 (switch_tab 이 활성 탭을 건드리지 않게)', async () => {
    const gate = await loadGate();
    const result = await gate.applyBackgroundModeGate(B.SWITCH_TAB, { tabId: 'x' });
    expect(result.invalidTabId).toBe(true);
  });

  it('거절 본문은 구조화 오류 invalid_tab_id 이고 무엇이 틀렸는지 말해 준다', async () => {
    const gate = await loadGate();
    const payload = JSON.parse(gate.invalidTabIdErrorText(B.CLICK, null));
    expect(payload.error).toBe('invalid_tab_id');
    expect(payload.tool).toBe(B.CLICK);
    expect(payload.message).toContain('tabId');
    expect(gate.INVALID_TAB_ID_ERROR).toBe('invalid_tab_id');
  });

  it('tabId 를 아예 안 준 것과 undefined 로 준 것은 같게 본다', async () => {
    const gate = await loadGate();
    seedWorkTab(h, SESSION, 808);

    const result = await gate.applyBackgroundModeGate(B.CLICK, {
      _mcpSessionId: SESSION,
      tabId: undefined,
    });
    expect(result.invalidTabId).toBe(false);
    expect(result.args.tabId).toBe(808);
  });

  it('예외 도구와 명시 tabId 는 작업 탭을 조회하지 않는다 (호출마다 붙던 대기 제거)', async () => {
    // getWorkTabId 는 chrome.tabs.get 을 부른다. 게이트는 도구 호출마다 돌아가므로,
    // 결과를 쓰지 않는 경로에서 조회하면 그 대기가 모든 호출에 고정으로 붙는다.
    const gate = await loadGate();
    seedWorkTab(h, SESSION, 555);
    h.tabs.add(12);
    const tabsGet = chrome.tabs.get as unknown as {
      mock: { calls: unknown[][] };
      mockClear: () => void;
    };

    tabsGet.mockClear();
    await gate.applyBackgroundModeGate(B.SWITCH_TAB, { _mcpSessionId: SESSION, tabId: 12 });
    expect(tabsGet.mock.calls, '예외 도구').toHaveLength(0);

    tabsGet.mockClear();
    const explicit = await gate.applyBackgroundModeGate(B.CLICK, {
      _mcpSessionId: SESSION,
      tabId: 12,
    });
    expect(explicit.args.tabId).toBe(12);
    expect(tabsGet.mock.calls, '명시 tabId').toHaveLength(0);

    // tabId 를 안 준 호출은 여전히 작업 탭을 조회해 주입한다.
    tabsGet.mockClear();
    const injected = await gate.applyBackgroundModeGate(B.CLICK, { _mcpSessionId: SESSION });
    expect(injected.args.tabId).toBe(555);
    expect(tabsGet.mock.calls.length).toBeGreaterThan(0);
  });

  it('정상 tabId 는 그대로 통과한다', async () => {
    const gate = await loadGate();
    h.tabs.add(12);
    const result = await gate.applyBackgroundModeGate(B.CLICK, {
      _mcpSessionId: SESSION,
      tabId: 12,
    });
    expect(result.invalidTabId).toBe(false);
    expect(result.noWorkTab).toBe(false);
    expect(result.args.tabId).toBe(12);
  });
});

// ===========================================================================
// 정당한 호출이 새로 막히지 않는다 (2026-09-04 독립 검증 지적)
// ===========================================================================
describe('탭이 필요 없는 정당한 호출은 계속 통과한다', () => {
  let h: Harness;

  beforeEach(() => {
    h = installChrome();
  });

  it('domain 으로 범위를 준 쿠키 get/clear 도 탭이 필요 없다', async () => {
    const gate = await loadGate();
    // storage.ts 의 handleCookies 는 get·clear 에서 url 또는 domain 중 하나만 있으면 된다.
    expect(gate.requiresWorkTab(B.STORAGE, { action: 'get', domain: 'example.com' })).toBe(false);
    expect(gate.requiresWorkTab(B.STORAGE, { action: 'clear', domain: 'example.com' })).toBe(false);
    // set·remove 는 url 이 반드시 필요하다 → domain 만으로는 대상 탭을 찾으러 간다.
    expect(
      gate.requiresWorkTab(B.STORAGE, {
        action: 'set',
        domain: 'example.com',
        name: 'a',
        value: 'b',
      }),
    ).toBe(true);
    expect(
      gate.requiresWorkTab(B.STORAGE, { action: 'remove', domain: 'example.com', name: 'a' }),
    ).toBe(true);
    // 웹 스토리지는 domain 과 무관하게 탭에서 실행해야 한다.
    expect(
      gate.requiresWorkTab(B.STORAGE, { action: 'get', kind: 'local', domain: 'example.com' }),
    ).toBe(true);
    // 빈 domain 은 범위가 아니다.
    expect(gate.requiresWorkTab(B.STORAGE, { action: 'get', domain: '   ' })).toBe(true);
  });

  it('실제 게이트도 domain 만 준 쿠키 조회를 거절하지 않는다', async () => {
    const gate = await loadGate();
    const result = await gate.applyBackgroundModeGate(B.STORAGE, {
      _mcpSessionId: SESSION,
      action: 'get',
      domain: 'example.com',
    });
    expect(result.noWorkTab).toBe(false);
    expect(result.args.tabId).toBeUndefined();
  });

  it('창을 명시한 호출은 사용자가 대상을 지정한 것이므로 통과시킨다', async () => {
    const gate = await loadGate();
    // chrome_screenshot 등은 windowId 가 있으면 그 창의 활성 탭을 쓴다
    // (base-browser getActiveTabOrThrowInWindow) — 사용자가 창을 고른 것이다.
    expect(gate.requiresWorkTab(B.SCREENSHOT, { windowId: 3 })).toBe(false);

    const result = await gate.applyBackgroundModeGate(B.SCREENSHOT, {
      _mcpSessionId: SESSION,
      windowId: 3,
    });
    expect(result.noWorkTab).toBe(false);
    expect(result.args.windowId).toBe(3);
  });

  it('창을 명시했으면 작업 탭을 끼워 넣지 않는다 (지정한 창이 무시되면 안 된다)', async () => {
    const gate = await loadGate();
    seedWorkTab(h, SESSION, 901);

    const result = await gate.applyBackgroundModeGate(B.SCREENSHOT, {
      _mcpSessionId: SESSION,
      windowId: 3,
    });
    expect(result.args.tabId).toBeUndefined();
    expect(result.noWorkTab).toBe(false);
  });

  it('잘못된 windowId 는 "창 지정" 으로 인정하지 않는다 (fail-closed)', async () => {
    const gate = await loadGate();
    expect(gate.requiresWorkTab(B.SCREENSHOT, { windowId: 0 })).toBe(true);
    expect(gate.requiresWorkTab(B.SCREENSHOT, { windowId: -2 })).toBe(true);
    expect(gate.requiresWorkTab(B.SCREENSHOT, { windowId: 'x' })).toBe(true);
  });
});

// ===========================================================================
// windowId 예외는 windowId 를 실제로 쓰는 도구에만 적용한다 (2026-09-04 Codex 2차 검토)
//
// 재현하려는 실패: chrome_javascript · chrome_extract · chrome_wait_for 등은 windowId 를
// 소비하지 않고 전역 활성 탭(currentWindow)으로 fallback 한다. 그런데 게이트는 양의 정수
// windowId 만 보고 통과시켜, 새 세션의 {code, windowId} 호출이 사용자가 보던 탭에서 실행됐다.
// ===========================================================================
describe('windowId 는 그 도구가 실제로 쓸 때만 게이트를 통과시킨다', () => {
  let h: Harness;

  beforeEach(() => {
    h = installChrome();
  });

  // 코드로 확인: windowId 를 소비하지 않고 전역 활성 탭으로 fallback 하는 도구들.
  const WINDOW_ID_IGNORING_TOOLS = [
    B.JAVASCRIPT,
    B.EXTRACT,
    B.WAIT_FOR,
    B.SCROLL_COLLECT,
    B.HANDLE_DIALOG,
    B.NETWORK_REQUEST,
    B.GET_INTERACTIVE_ELEMENTS,
  ];

  // 코드로 확인: getActiveTabOrThrowInWindow(windowId) 등으로 windowId 를 실제로 쓰는 도구들.
  // production 목록과의 집합 동등은 아래 'WINDOW_ID_AWARE_TOOLS 매트릭스 동기화' 가 못박는다.
  const WINDOW_ID_AWARE_TOOLS = [
    B.SCREENSHOT,
    B.WEB_FETCHER,
    B.STORAGE,
    B.CLICK,
    B.FILL,
    B.READ_PAGE,
    B.KEYBOARD,
    B.FIND,
    B.SAVE_PDF,
    B.EMULATE,
    B.COMPUTER,
    B.FILE_UPLOAD,
    B.INJECT_SCRIPT,
    B.CONSOLE,
  ];

  it('windowId 를 무시하는 도구는 windowId 가 있어도 작업 탭을 요구한다', async () => {
    const gate = await loadGate();
    for (const name of WINDOW_ID_IGNORING_TOOLS) {
      expect(gate.requiresWorkTab(name, { windowId: 123 }), name).toBe(true);
    }
  });

  it('회귀(핵심): chrome_javascript 를 windowId 만으로 부르면 거절한다 (사용자 탭 탈취 방지)', async () => {
    const gate = await loadGate();
    const result = await gate.applyBackgroundModeGate(B.JAVASCRIPT, {
      _mcpSessionId: SESSION,
      code: 'document.title',
      windowId: 123,
    });
    // 작업 탭이 없으므로 거절해야 한다 — windowId 로 통과시키면 사용자 탭에서 실행된다.
    expect(result.noWorkTab).toBe(true);
    expect(result.args.tabId).toBeUndefined();
  });

  it('windowId 를 무시하는 도구도 작업 탭이 있으면 그 탭을 주입한다 (windowId 로 새지 않음)', async () => {
    const gate = await loadGate();
    seedWorkTab(h, SESSION, 4242);
    for (const name of WINDOW_ID_IGNORING_TOOLS) {
      const result = await gate.applyBackgroundModeGate(name, {
        _mcpSessionId: SESSION,
        windowId: 123,
      });
      expect(result.noWorkTab, name).toBe(false);
      // windowId 로 통과시키지 않고 작업 탭을 주입해야 한다.
      expect(result.args.tabId, name).toBe(4242);
    }
  });

  it('windowId 를 실제로 쓰는 도구는 그대로 통과시킨다 (지정한 창을 존중)', async () => {
    const gate = await loadGate();
    for (const name of WINDOW_ID_AWARE_TOOLS) {
      expect(gate.requiresWorkTab(name, { windowId: 3 }), name).toBe(false);

      const result = await gate.applyBackgroundModeGate(name, {
        _mcpSessionId: SESSION,
        windowId: 3,
      });
      expect(result.noWorkTab, name).toBe(false);
      // 작업 탭을 끼워 넣으면 지정한 창이 무시되므로 tabId 는 주입하지 않는다.
      expect(result.args.tabId, name).toBeUndefined();
      expect(result.args.windowId, name).toBe(3);
    }
  });
});

describe('applyBackgroundModeGate — 작업 탭이 없으면 사용자 탭으로 흘리지 않는다 (F2)', () => {
  let h: Harness;

  beforeEach(() => {
    h = installChrome();
  });

  it('회귀: 새 세션의 첫 click/fill/read_page/screenshot 을 거절한다', async () => {
    const gate = await loadGate();
    for (const name of HIJACK_PRONE_TOOLS) {
      const result = await gate.applyBackgroundModeGate(name, { _mcpSessionId: SESSION });
      expect(result.noWorkTab, name).toBe(true);
      // 사용자 탭 id 가 주입되지도 않았다.
      expect(result.args.tabId, name).toBeUndefined();
    }
  });

  it('거절 본문은 구조화 오류 no_work_tab 이고 다음 행동을 알려 준다', async () => {
    const gate = await loadGate();
    const payload = JSON.parse(gate.noWorkTabErrorText(B.CLICK));
    expect(payload.error).toBe('no_work_tab');
    expect(payload.tool).toBe(B.CLICK);
    expect(payload.message).toContain('chrome_navigate');
    expect(payload.message).toContain('tabId');
    expect(gate.NO_WORK_TAB_ERROR).toBe('no_work_tab');
  });

  it('작업 탭이 있으면 주입하고 통과시킨다', async () => {
    const gate = await loadGate();
    seedWorkTab(h, SESSION, 501);

    const result = await gate.applyBackgroundModeGate(B.CLICK, { _mcpSessionId: SESSION });
    expect(result.noWorkTab).toBe(false);
    expect(result.args.tabId).toBe(501);
    expect(result.args.background).toBe(true);
    expect(result.workTabId).toBe(501);
  });

  it('레인별로 따로 판정한다 — 다른 레인의 작업 탭을 빌려 쓰지 않는다', async () => {
    const gate = await loadGate();
    const keyA = `${SESSION}::a`;
    seedWorkTab(h, keyA, 601);

    const a = await gate.applyBackgroundModeGate(B.READ_PAGE, {
      _mcpSessionId: SESSION,
      lane: 'a',
    });
    expect(a.args.tabId).toBe(601);
    expect(a.noWorkTab).toBe(false);

    const b = await gate.applyBackgroundModeGate(B.READ_PAGE, {
      _mcpSessionId: SESSION,
      lane: 'b',
    });
    expect(b.noWorkTab).toBe(true);
    expect(b.args.tabId).toBeUndefined();
  });

  it('호출자가 tabId 를 명시했으면 작업 탭이 없어도 통과시킨다', async () => {
    const gate = await loadGate();
    h.tabs.add(11);

    const result = await gate.applyBackgroundModeGate(B.CLICK, {
      _mcpSessionId: SESSION,
      tabId: 11,
    });
    expect(result.noWorkTab).toBe(false);
    expect(result.args.tabId).toBe(11);
  });

  it('예외 도구는 작업 탭이 없어도 손대지 않는다', async () => {
    const gate = await loadGate();
    const args = { _mcpSessionId: SESSION };
    const result = await gate.applyBackgroundModeGate(B.SWITCH_TAB, args);
    expect(result.noWorkTab).toBe(false);
    // 예외 도구는 args 를 복제조차 하지 않는다 (background 주입도 없음).
    expect(result.args).toBe(args);
  });

  it('background mode 를 끄면 예전 동작 그대로 — 거절하지 않는다', async () => {
    const gate = await loadGate();
    h.localStore['backgroundWorkMode'] = false;

    const result = await gate.applyBackgroundModeGate(B.CLICK, { _mcpSessionId: SESSION });
    expect(result.noWorkTab).toBe(false);
    expect(result.args.tabId).toBeUndefined();
    expect(result.args.background).toBeUndefined();
  });

  it('기록된 작업 탭이 이미 닫혔으면 거절한다 (죽은 기록으로 통과시키지 않는다)', async () => {
    const gate = await loadGate();
    h.sessionStore['mcpWorkTabs'] = {
      [SESSION]: { tabId: 999, lastUsedAt: Date.now(), owned: true },
    };
    // 999 는 h.tabs 에 없다 → chrome.tabs.get 실패 → 기록 정리 후 null

    const result = await gate.applyBackgroundModeGate(B.CLICK, { _mcpSessionId: SESSION });
    expect(result.workTabId).toBeNull();
    expect(result.noWorkTab).toBe(true);
  });
});

// ===========================================================================
// url 이 있으면 windowId 예외를 주지 않는다 (2026-09-04 Codex 3차 검토, 항목 1)
//
// 재현하려는 실패: chrome_get_web_content · chrome_console · chrome_inject_script 는
// `url` 인자가 있으면 **창과 무관하게** 전체 탭에서 첫 URL 일치 탭을 고른다
// (web-fetcher.ts 의 chrome.tabs.query({}), console.ts 의 chrome.tabs.query({url}),
//  inject-script.ts 의 chrome.tabs.query({})). 그런데 게이트는 이 세 도구를
// WINDOW_ID_AWARE_TOOLS 로 보고 `{windowId, url}` 호출을 통과시켰다. 결과적으로
// windowId 가 42 여도 다른 사용자 창의 탭이 읽히고 디버거가 붙었다.
//
// 그 뒤 최종 검토(2026-09-04)에서, 이때 작업 탭을 주입하면 도구가 tabId 분기로 빠져
// url 이 통째로 무시된다는 것이 드러났다. 지금은 URL_SELECTS_TARGET_TOOLS 규칙이 먼저
// 적용돼 주입도 거절도 하지 않는다 — 사용자 탭으로 새지 않는 것은 url-target.ts 의
// 세션 범위 조회가 보장한다(tests/utils/url-target-scope.test.ts).
// windowId 는 이때 "새 탭을 붙일 창" 으로만 쓰인다.
// ===========================================================================
describe('url 분기가 있는 도구는 windowId 로 게이트를 통과하지 못한다', () => {
  let h: Harness;

  const URL_BRANCH_TOOLS = [B.WEB_FETCHER, B.CONSOLE, B.INJECT_SCRIPT];

  beforeEach(() => {
    h = installChrome();
  });

  it('회귀(핵심): {windowId, url} 호출은 작업 탭이 없어도 거절하지 않는다 (URL 이 대상 지정)', async () => {
    const gate = await loadGate();
    for (const name of URL_BRANCH_TOOLS) {
      expect(gate.requiresWorkTab(name, { windowId: 42, url: 'https://x.test/' }), name).toBe(
        false,
      );

      const result = await gate.applyBackgroundModeGate(name, {
        _mcpSessionId: SESSION,
        windowId: 42,
        url: 'https://x.test/',
      });
      expect(result.noWorkTab, name).toBe(false);
      expect(result.args.tabId, name).toBeUndefined();
    }
  });

  it('회귀(핵심): {windowId, url} 호출에 작업 탭이 있어도 tabId 를 주입하지 않는다', async () => {
    const gate = await loadGate();
    seedWorkTab(h, SESSION, 7777);
    for (const name of URL_BRANCH_TOOLS) {
      const result = await gate.applyBackgroundModeGate(name, {
        _mcpSessionId: SESSION,
        windowId: 42,
        url: 'https://x.test/',
      });
      expect(result.noWorkTab, name).toBe(false);
      // 주입하면 도구가 tabId 분기로 빠져 url 이 무시된다(작업 탭 내용이 돌아온다).
      expect(result.args.tabId, name).toBeUndefined();
    }
  });

  it('url 이 없으면 windowId 예외는 그대로 유지된다', async () => {
    const gate = await loadGate();
    for (const name of URL_BRANCH_TOOLS) {
      expect(gate.requiresWorkTab(name, { windowId: 42 }), name).toBe(false);
    }
  });

  it('빈 문자열 url 은 url 분기를 타지 않으므로 예외를 유지한다', async () => {
    const gate = await loadGate();
    for (const name of URL_BRANCH_TOOLS) {
      expect(gate.requiresWorkTab(name, { windowId: 42, url: '   ' }), name).toBe(false);
    }
  });
});

// ===========================================================================
// 테스트 매트릭스와 production 목록의 집합 동등 (항목 5)
//
// 재현하려는 실패: 위 describe 의 기대 목록은 손으로 관리돼 production 의
// WINDOW_ID_AWARE_TOOLS 와 어긋나 있었다(WEB_FETCHER · STORAGE 누락). 목록이
// 어긋나면 "windowId 예외를 새로 받은 도구" 가 아무 테스트도 없이 들어온다.
// ===========================================================================
describe('WINDOW_ID_AWARE_TOOLS 매트릭스 동기화', () => {
  beforeEach(() => {
    installChrome();
  });

  /** 이 목록을 고칠 때는 반드시 해당 도구 구현이 windowId 를 쓰는지 코드로 확인할 것. */
  const EXPECTED_WINDOW_ID_AWARE = [
    B.SCREENSHOT,
    B.WEB_FETCHER,
    B.CLICK,
    B.FILL,
    B.KEYBOARD,
    B.CONSOLE,
    B.FILE_UPLOAD,
    B.READ_PAGE,
    B.COMPUTER,
    B.INJECT_SCRIPT,
    B.FIND,
    B.STORAGE,
    B.SAVE_PDF,
    B.EMULATE,
  ];

  it('production 목록과 기대 목록이 정확히 같은 집합이다', async () => {
    const gate = await loadGate();
    const actual = [...gate.WINDOW_ID_AWARE_TOOLS].sort();
    expect(actual).toEqual([...EXPECTED_WINDOW_ID_AWARE].sort());
  });

  it('aware 도구는 전부 tabId 주입 대상이기도 하다', async () => {
    const gate = await loadGate();
    for (const name of gate.WINDOW_ID_AWARE_TOOLS) {
      expect(gate.TAB_ID_INJECT_TOOLS.has(name), name).toBe(true);
    }
  });

  it('aware 도구는 windowId 만으로 작업 탭 요구를 면제받는다 (url 없는 호출)', async () => {
    const gate = await loadGate();
    for (const name of gate.WINDOW_ID_AWARE_TOOLS) {
      expect(gate.requiresWorkTab(name, { windowId: 5 }), name).toBe(false);
    }
  });
});

/* ================================================================== *
 * 강제 background 도구 (2026-09-05 Codex 최종 확인 2)
 * ================================================================== */

describe('flow_run 은 전역 토글과 무관하게 게이트에서 강제 background 로 판정된다', () => {
  const RR = TOOL_NAMES.RECORD_REPLAY;
  let h: Harness;

  beforeEach(() => {
    h = installChrome();
    // 재현 조건: 전역 무간섭 토글이 꺼져 있다.
    h.localStore['backgroundWorkMode'] = false;
  });

  it('전역 OFF + tabId 생략이면 이 세션의 작업 탭을 주입한다', async () => {
    const gate = await loadGate();
    seedWorkTab(h, SESSION, 701);

    const result = await gate.applyBackgroundModeGate(RR.FLOW_RUN, {
      flowId: 'daily',
      _mcpSessionId: SESSION,
    });

    // 예전에는 전역 토글이 꺼져 있다는 이유로 인자를 손대지 않았고, 그 결과 도구는
    // tabId 없이 실행돼 작업 탭이 **있는데도** no_work_tab 으로 끝났다.
    expect(result.args.tabId).toBe(701);
    expect(result.args.background).toBe(true);
    expect(result.args._effectiveBackgroundMode).toBe(true);
    expect(result.noWorkTab).toBe(false);
  });

  it('전역 OFF + 작업 탭 없음이면 탭을 주입하지 않고 판정을 도구에 넘긴다', async () => {
    const gate = await loadGate();

    const result = await gate.applyBackgroundModeGate(RR.FLOW_RUN, {
      flowId: 'daily',
      _mcpSessionId: SESSION,
    });

    // 2026-09-05 설계 B 3항: 거절 판정이 게이트에서 도구로 옮겨졌다. 흐름에 시작 URL
    // (`flow.startUrl`)이 있으면 그 주소로 백그라운드 작업 탭을 열 수 있는데, 흐름을 읽어야
    // 알 수 있는 값이라 게이트가 판정할 수 없기 때문이다. 도구는 시작 URL 도 없을 때
    // **같은 no_work_tab 문구로** 거절한다 (tests/record-replay/flow-run-start-url.test.ts).
    expect(result.noWorkTab).toBe(false);
    // 바뀌지 않은 것: 사용자가 보고 있는 탭은 절대 주입하지 않는다.
    expect(result.args.tabId).toBeUndefined();
    expect(gate.requiresWorkTab(RR.FLOW_RUN, { flowId: 'daily', _mcpSessionId: SESSION })).toBe(
      false,
    );
  });

  it('강제 목록은 flow_run 하나이고, 그 도구는 tabId 주입 대상이다', async () => {
    const gate = await loadGate();
    expect([...gate.FORCED_BACKGROUND_TOOLS]).toEqual([RR.FLOW_RUN]);
    expect(gate.TAB_ID_INJECT_TOOLS.has(RR.FLOW_RUN)).toBe(true);
  });
});
