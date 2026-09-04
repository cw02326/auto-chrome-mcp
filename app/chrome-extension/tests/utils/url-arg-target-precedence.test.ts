/**
 * auto-chrome-mcp fork — `url` 인자를 준 호출에 작업 탭 id 가 주입되면 URL 이 무시된다.
 *
 * 재현하려는 실패(2026-09-04 Codex 최종 검토, 기능 회귀 1건):
 *   work-tab-gate 는 background mode 에서 tabId 가 없으면 작업 탭 id 를 넣는다
 *   (utils/work-tab-gate.ts, TAB_ID_INJECT_TOOLS 주입 블록). 그런데 web-fetcher ·
 *   console · inject-script · network capture 는 모두 `tabId` 분기를 `url` 분기보다
 *   먼저 본다(web-fetcher.ts execute 의 `if (typeof explicitTabId === 'number')`).
 *   그래서 세션에 작업 탭이 하나라도 있으면
 *   `chrome_get_web_content({ url: 'https://target.test/page' })` 가 그 URL 을 열지도
 *   찾지도 않고 **기존 작업 탭 내용**을 돌려줬다.
 *
 * 계약:
 *   - background mode ON + `url` 있음 + `tabId` 미지정 → 게이트는 tabId 를 주입하지 않는다.
 *   - `tabId` 와 `url` 을 둘 다 주면 예전 우선순위(tabId)를 유지한다.
 *   - 작업 탭이 없고 url 만 있으면 no_work_tab 이 아니다 (URL 이 곧 대상 지정).
 *   - 도구는 세션 범위에서 URL 일치 탭을 찾고, 없으면 작업 탭이 속한 창에 새 탭을 만든다.
 *   - background mode OFF 는 예전 동작 그대로.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TOOL_NAMES } from 'auto-chrome-mcp-shared';

const B = TOOL_NAMES.BROWSER;

const SESSION = 'stdio-url-arg-precedence';
const TARGET_URL = 'https://target.test/page';
const WORK_URL = 'https://work.test/current';

/** 사용자가 보고 있는 탭 — 공교롭게 요청한 URL 과 같다(하이재킹 재현 조건). */
const USER_TAB = {
  id: 11,
  windowId: 1,
  url: TARGET_URL,
  title: 'user',
  active: true,
  status: 'complete',
};
/** 이 세션의 작업 탭 — 다른 창에 있고 URL 이 다르다. */
const WORK_TAB = {
  id: 99,
  windowId: 2,
  url: WORK_URL,
  title: 'work',
  active: false,
  status: 'complete',
};

interface Harness {
  created: any[];
  queries: any[];
  tabsById: Record<number, any>;
}

let h: Harness;

function installChrome(options: { backgroundMode?: boolean; workTab?: boolean } = {}): Harness {
  const backgroundMode = options.backgroundMode !== false;
  const created: any[] = [];
  const queries: any[] = [];

  const localStore: Record<string, unknown> = {};
  if (!backgroundMode) localStore.backgroundWorkMode = false;

  const sessionStore: Record<string, unknown> = {};
  if (options.workTab !== false) {
    sessionStore.mcpWorkTabs = {
      [SESSION]: { tabId: WORK_TAB.id, lastUsedAt: Date.now(), owned: true },
    };
  }

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
    remove: vi.fn(async () => undefined),
  });

  (globalThis as any).chrome = {
    runtime: { id: 'test-extension-id', lastError: undefined },
    storage: { local: makeArea(localStore), session: makeArea(sessionStore) },
    tabs: {
      query: vi.fn(async (q: any) => {
        queries.push(q);
        return [USER_TAB, WORK_TAB];
      }),
      get: vi.fn(async (id: number) => {
        const tab = tabsById[id];
        if (!tab) throw new Error(`No tab with id: ${id}`);
        return tab;
      }),
      create: vi.fn(async (info: any) => {
        created.push(info);
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
    debugger: {
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async () => ({})),
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
      onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    webRequest: {
      onBeforeRequest: { addListener: vi.fn(), removeListener: vi.fn() },
      onBeforeSendHeaders: { addListener: vi.fn(), removeListener: vi.fn() },
      onSendHeaders: { addListener: vi.fn(), removeListener: vi.fn() },
      onHeadersReceived: { addListener: vi.fn(), removeListener: vi.fn() },
      onCompleted: { addListener: vi.fn(), removeListener: vi.fn() },
      onErrorOccurred: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };

  return { created, queries, tabsById };
}

async function loadGate() {
  return await import('@/utils/work-tab-gate');
}

/** 게이트를 통과한 인자를 그대로 도구에 넘겨 실제 대상 탭을 확인한다. */
async function gateThen(name: string, args: any) {
  const { applyBackgroundModeGate } = await loadGate();
  return await applyBackgroundModeGate(name, args);
}

describe('게이트: url 을 준 호출에는 작업 tabId 를 주입하지 않는다', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  const urlTools = [B.WEB_FETCHER, B.CONSOLE, B.INJECT_SCRIPT, B.NETWORK_CAPTURE];

  for (const name of urlTools) {
    it(`회귀(핵심): ${name} 에 url 만 주면 tabId 가 비어 있다`, async () => {
      h = installChrome();
      const { applyBackgroundModeGate } = await loadGate();

      const gate = await applyBackgroundModeGate(name, {
        _mcpSessionId: SESSION,
        url: TARGET_URL,
      });

      expect(gate.args.tabId).toBeUndefined();
      expect(gate.noWorkTab).toBe(false);
    });
  }

  it('tabId 와 url 을 둘 다 주면 tabId 를 그대로 둔다 (예전 우선순위)', async () => {
    h = installChrome();
    const { applyBackgroundModeGate } = await loadGate();

    const gate = await applyBackgroundModeGate(B.WEB_FETCHER, {
      _mcpSessionId: SESSION,
      url: TARGET_URL,
      tabId: 77,
    });

    expect(gate.args.tabId).toBe(77);
  });

  it('작업 탭이 없어도 url 만 있으면 no_work_tab 으로 막지 않는다', async () => {
    h = installChrome({ workTab: false });
    const { applyBackgroundModeGate } = await loadGate();

    const gate = await applyBackgroundModeGate(B.WEB_FETCHER, {
      _mcpSessionId: SESSION,
      url: TARGET_URL,
    });

    expect(gate.noWorkTab).toBe(false);
    expect(gate.args.tabId).toBeUndefined();
  });

  it('url 이 없으면 예전처럼 작업 탭을 주입한다', async () => {
    h = installChrome();
    const { applyBackgroundModeGate } = await loadGate();

    const gate = await applyBackgroundModeGate(B.WEB_FETCHER, { _mcpSessionId: SESSION });

    expect(gate.args.tabId).toBe(WORK_TAB.id);
  });

  it('빈 문자열 url 은 대상 지정이 아니다 — 작업 탭을 주입한다', async () => {
    h = installChrome();
    const { applyBackgroundModeGate } = await loadGate();

    const gate = await applyBackgroundModeGate(B.WEB_FETCHER, {
      _mcpSessionId: SESSION,
      url: '   ',
    });

    expect(gate.args.tabId).toBe(WORK_TAB.id);
  });

  it('url 분기가 없는 도구는 url 이 있어도 작업 탭을 주입한다', async () => {
    h = installChrome();
    const { applyBackgroundModeGate } = await loadGate();

    const gate = await applyBackgroundModeGate(B.CLICK, {
      _mcpSessionId: SESSION,
      url: TARGET_URL,
      selector: '#go',
    });

    expect(gate.args.tabId).toBe(WORK_TAB.id);
  });

  it('background mode OFF 면 예전 동작 — 인자를 손대지 않는다', async () => {
    h = installChrome({ backgroundMode: false });
    const { applyBackgroundModeGate } = await loadGate();

    const gate = await applyBackgroundModeGate(B.WEB_FETCHER, {
      _mcpSessionId: SESSION,
      url: TARGET_URL,
    });

    expect(gate.args.tabId).toBeUndefined();
    expect(gate.args.background).toBeUndefined();
  });
});

describe('도구: url 이 실제 대상 탭을 고른다', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('회귀(핵심): chrome_get_web_content({url}) 이 작업 탭을 읽지 않는다', async () => {
    h = installChrome();
    const gate = await gateThen(B.WEB_FETCHER, { _mcpSessionId: SESSION, url: TARGET_URL });
    const { webFetcherTool } = await import('@/entrypoints/background/tools/browser/web-fetcher');
    const tool = webFetcherTool as any;
    vi.spyOn(tool, 'injectContentScript').mockResolvedValue(undefined as never);
    vi.spyOn(tool, 'sendMessageToTab').mockResolvedValue({
      success: true,
      textContent: 'x',
      title: 't',
    } as never);

    const res = await tool.execute(gate.args);
    const payload = JSON.parse(res.content[0].text);

    // 작업 탭(99)의 URL 이 아니라 요청한 URL 이어야 한다.
    expect(payload.url).not.toBe(WORK_URL);
    expect(payload.url).toBe(TARGET_URL);
    // 세션 범위에 URL 일치 탭이 없으므로 새 탭을 만들고, 작업 탭이 속한 창에 붙인다.
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ url: TARGET_URL, windowId: WORK_TAB.windowId });
  }, 20000);

  it('회귀: chrome_console({url}) 이 작업 탭에 붙지 않는다', async () => {
    h = installChrome();
    const gate = await gateThen(B.CONSOLE, { _mcpSessionId: SESSION, url: TARGET_URL });
    const { consoleTool } = await import('@/entrypoints/background/tools/browser/console');
    const tool = consoleTool as any;

    await tool.execute({ ...gate.args, mode: 'buffer' });

    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ url: TARGET_URL, windowId: WORK_TAB.windowId });
  }, 20000);

  it('회귀: chrome_inject_script({url}) 이 작업 탭에 주입하지 않는다', async () => {
    h = installChrome();
    const gate = await gateThen(B.INJECT_SCRIPT, {
      _mcpSessionId: SESSION,
      url: TARGET_URL,
      type: 'ISOLATED',
      jsScript: 'void 0;',
    });
    const injectModule = await import('@/entrypoints/background/tools/browser/inject-script');
    const tool = (injectModule as any).injectScriptTool ?? (injectModule as any).default;

    await tool.execute(gate.args);

    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ url: TARGET_URL, windowId: WORK_TAB.windowId });
  }, 20000);

  it('회귀: chrome_network_capture({url}) 이 작업 탭을 캡처하지 않는다', async () => {
    h = installChrome();
    const gate = await gateThen(B.NETWORK_CAPTURE, {
      _mcpSessionId: SESSION,
      action: 'start',
      url: TARGET_URL,
    });
    const mod = await import('@/entrypoints/background/tools/browser/network-capture-web-request');
    const start = mod.networkCaptureStartTool as any;
    const captured: number[] = [];
    vi.spyOn(start, 'startCaptureForTab').mockImplementation(async (tabId: any) => {
      captured.push(tabId as number);
    });
    const { networkCaptureTool } =
      await import('@/entrypoints/background/tools/browser/network-capture');

    await (networkCaptureTool as any).execute(gate.args);

    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toBe(WORK_TAB.id);
    expect(captured[0]).not.toBe(USER_TAB.id);
  }, 20000);
});
