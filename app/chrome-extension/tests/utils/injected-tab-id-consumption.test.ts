/**
 * auto-chrome-mcp fork — 게이트가 주입한 top-level tabId 를 핸들러가 실제로 소비하는가.
 *
 * 배경(2026-09-04 Codex 3차 검토, 항목 2): work-tab-gate 는 TAB_ID_INJECT_TOOLS 에 대해
 * `args.tabId` 를 주입해 사용자 탭 대신 세션 작업 탭을 대상으로 만든다. 그런데 아래 네 경로는
 * 그 주입값을 **버리고** 사용자의 활성 탭(또는 URL 일치 탭)을 다시 골랐다.
 *
 *   1. chrome_get_interactive_elements — tabId 필드 자체가 없고 currentWindow 활성 탭 조회
 *   2. chrome_network_capture(통합)   — delegate 호출 때 tabId 를 안 넘김
 *   3. chrome_userscript              — params.args.tabId 만 읽음 (게이트는 top-level 에 주입)
 *   4. legacy capture start           — url 분기가 주입 tabId 보다 우선
 *
 * 게이트가 막아 줘도 핸들러가 소비하지 않으면 무의미하다 — 그 구멍을 여기서 못박는다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const WORK_TAB_ID = 99;
const USER_TAB_ID = 11;

interface Harness {
  /** chrome.tabs.query 호출 인자 기록 (활성 탭 조회가 일어났는지 판정) */
  queries: any[];
  /** chrome.tabs.get 으로 조회된 탭 id */
  gets: number[];
}

let h: Harness;

function installChrome(): Harness {
  const queries: any[] = [];
  const gets: number[] = [];
  const store: Record<string, unknown> = {};

  const makeArea = () => ({
    get: vi.fn(async (keys: unknown) => {
      const out: Record<string, unknown> = {};
      const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : [];
      for (const k of list as string[]) if (k in store) out[k] = store[k];
      return out;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(store, items);
    }),
    remove: vi.fn(async () => undefined),
  });

  const tabOf = (id: number) => ({
    id,
    windowId: id === WORK_TAB_ID ? 2 : 1,
    url: `https://example.com/${id}`,
    title: `tab-${id}`,
    active: id === USER_TAB_ID,
    status: 'complete',
  });

  (globalThis as any).chrome = {
    runtime: { id: 'test-extension-id', lastError: undefined },
    storage: { local: makeArea(), session: makeArea() },
    tabs: {
      query: vi.fn(async (q: any) => {
        queries.push(q);
        // URL 로 검색하면 "다른 창의 사용자 탭" 이 걸리도록 만든다 (하이재킹 재현용).
        return [tabOf(USER_TAB_ID)];
      }),
      get: vi.fn(async (id: number) => {
        gets.push(id);
        return tabOf(id);
      }),
      create: vi.fn(async (info: any) => ({ ...tabOf(500), ...info, id: 500 })),
      update: vi.fn(async () => tabOf(USER_TAB_ID)),
      sendMessage: vi.fn(async () => ({ success: true })),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    windows: {
      get: vi.fn(async () => ({ id: 2, type: 'normal' })),
      update: vi.fn(async () => undefined),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: {
      executeScript: vi.fn(async () => [{ result: undefined }]),
      insertCSS: vi.fn(async () => undefined),
      removeCSS: vi.fn(async () => undefined),
    },
    webRequest: {
      onBeforeRequest: { addListener: vi.fn(), removeListener: vi.fn() },
      onBeforeSendHeaders: { addListener: vi.fn(), removeListener: vi.fn() },
      onSendHeaders: { addListener: vi.fn(), removeListener: vi.fn() },
      onHeadersReceived: { addListener: vi.fn(), removeListener: vi.fn() },
      onResponseStarted: { addListener: vi.fn(), removeListener: vi.fn() },
      onCompleted: { addListener: vi.fn(), removeListener: vi.fn() },
      onErrorOccurred: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    webNavigation: {
      onCommitted: { addListener: vi.fn(), removeListener: vi.fn() },
      onDOMContentLoaded: { addListener: vi.fn(), removeListener: vi.fn() },
      onCompleted: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
    },
    debugger: {
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async () => ({})),
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
      onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };

  return { queries, gets };
}

/** 활성 탭 조회(= 사용자 탭으로 흘러가는 경로)가 일어났는가. */
function queriedActiveTab(harness: Harness): boolean {
  return harness.queries.some((q) => q && q.active === true);
}

/** URL 검색(= 모든 창을 훑는 경로)이 일어났는가. */
function queriedByUrl(harness: Harness): boolean {
  return harness.queries.some((q) => q && typeof q.url === 'string');
}

beforeEach(() => {
  h = installChrome();
  vi.resetModules();
});

describe('chrome_get_interactive_elements 는 주입된 tabId 를 쓴다 (항목 2-1)', () => {
  it('회귀: tabId 를 줬는데 활성 탭을 조회하면 안 된다', async () => {
    const { getInteractiveElementsTool } =
      await import('@/entrypoints/background/tools/browser/web-fetcher');
    const tool = getInteractiveElementsTool as any;
    const inject = vi.spyOn(tool, 'injectContentScript').mockResolvedValue(undefined as never);
    const send = vi
      .spyOn(tool, 'sendMessageToTab')
      .mockResolvedValue({ success: true, elements: [] } as never);

    await tool.execute({ tabId: WORK_TAB_ID, textQuery: 'button' });

    expect(send).toHaveBeenCalled();
    expect((send.mock.calls[0] as any[])[0]).toBe(WORK_TAB_ID);
    expect((inject.mock.calls[0] as any[])[0]).toBe(WORK_TAB_ID);
    expect(queriedActiveTab(h)).toBe(false);
  });

  it('tabId 가 없으면 예전대로 활성 탭을 쓴다', async () => {
    const { getInteractiveElementsTool } =
      await import('@/entrypoints/background/tools/browser/web-fetcher');
    const tool = getInteractiveElementsTool as any;
    vi.spyOn(tool, 'injectContentScript').mockResolvedValue(undefined as never);
    const send = vi
      .spyOn(tool, 'sendMessageToTab')
      .mockResolvedValue({ success: true, elements: [] } as never);

    await tool.execute({ textQuery: 'button' });

    expect((send.mock.calls[0] as any[])[0]).toBe(USER_TAB_ID);
  });
});

describe('통합 chrome_network_capture 는 tabId 를 delegate 로 넘긴다 (항목 2-2)', () => {
  it('회귀: start 위임 인자에 tabId 가 실려야 한다', async () => {
    const { networkCaptureTool } =
      await import('@/entrypoints/background/tools/browser/network-capture');
    const { networkCaptureStartTool } =
      await import('@/entrypoints/background/tools/browser/network-capture-web-request');
    const spy = vi.spyOn(networkCaptureStartTool, 'execute').mockResolvedValue({
      content: [{ type: 'text', text: '{"success":true}' }],
      isError: false,
    } as never);

    await networkCaptureTool.execute({ action: 'start', tabId: WORK_TAB_ID } as any);

    expect(spy).toHaveBeenCalled();
    expect((spy.mock.calls[0] as any[])[0]).toMatchObject({ tabId: WORK_TAB_ID });
  });

  it('회귀: stop 위임 인자에도 tabId 가 실려야 한다', async () => {
    const { networkCaptureTool } =
      await import('@/entrypoints/background/tools/browser/network-capture');
    const { networkCaptureStartTool, networkCaptureStopTool } =
      await import('@/entrypoints/background/tools/browser/network-capture-web-request');
    // webRequest 백엔드가 활성인 것처럼 보이게 한다.
    (networkCaptureStartTool as any).captureData.set(WORK_TAB_ID, { startTime: Date.now() });
    const spy = vi.spyOn(networkCaptureStopTool, 'execute').mockResolvedValue({
      content: [{ type: 'text', text: '{"success":true}' }],
      isError: false,
    } as never);

    await networkCaptureTool.execute({ action: 'stop', tabId: WORK_TAB_ID } as any);
    (networkCaptureStartTool as any).captureData.delete(WORK_TAB_ID);

    expect(spy).toHaveBeenCalled();
    expect((spy.mock.calls[0] as any[])[0]).toMatchObject({ tabId: WORK_TAB_ID });
  });
});

describe('chrome_userscript 는 top-level tabId 를 소비한다 (항목 2-3)', () => {
  it('회귀: top-level tabId 를 주면 활성 탭을 조회하지 않는다', async () => {
    const { userscriptTool } = await import('@/entrypoints/background/tools/browser/userscript');

    await userscriptTool.execute({
      action: 'send_command',
      tabId: WORK_TAB_ID,
      args: { id: 'no-such-script' },
    } as any);

    expect(h.gets).toContain(WORK_TAB_ID);
    expect(queriedActiveTab(h)).toBe(false);
  });

  it('중첩 args.tabId 가 있으면 그 값이 우선한다 (호출자 명시 존중)', async () => {
    const { userscriptTool } = await import('@/entrypoints/background/tools/browser/userscript');

    await userscriptTool.execute({
      action: 'send_command',
      tabId: WORK_TAB_ID,
      args: { id: 'no-such-script', tabId: 12345 },
    } as any);

    expect(h.gets).toContain(12345);
    expect(h.gets).not.toContain(WORK_TAB_ID);
  });
});

describe('legacy capture start 는 url 보다 tabId 를 먼저 본다 (항목 2-4)', () => {
  it('회귀: {url, tabId} 면 url 검색으로 남의 탭을 잡지 않는다 (webRequest)', async () => {
    const { networkCaptureStartTool } =
      await import('@/entrypoints/background/tools/browser/network-capture-web-request');
    const start = vi
      .spyOn(networkCaptureStartTool as any, 'startCaptureForTab')
      .mockResolvedValue(undefined as never);

    await networkCaptureStartTool.execute({
      url: 'https://example.com/11',
      tabId: WORK_TAB_ID,
    } as any);

    expect((start.mock.calls[0] as any[])[0]).toBe(WORK_TAB_ID);
    expect(queriedByUrl(h)).toBe(false);
  });

  it('회귀: {url, tabId} 면 url 검색으로 남의 탭을 잡지 않는다 (debugger)', async () => {
    const { networkDebuggerStartTool } =
      await import('@/entrypoints/background/tools/browser/network-capture-debugger');
    const start = vi
      .spyOn(networkDebuggerStartTool as any, 'startCaptureForTab')
      .mockResolvedValue(undefined as never);

    await networkDebuggerStartTool.execute({
      url: 'https://example.com/11',
      tabId: WORK_TAB_ID,
    } as any);

    expect((start.mock.calls[0] as any[])[0]).toBe(WORK_TAB_ID);
    expect(queriedByUrl(h)).toBe(false);
  });
});
