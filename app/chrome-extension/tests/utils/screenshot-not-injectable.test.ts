/**
 * auto-chrome-mcp fork — chrome_screenshot 주입 불가 탭 회귀 테스트.
 *
 * 배경: 확장 자체 페이지(chrome-extension://…/sidepanel.html)를 대상으로 뷰포트 캡처를
 * 부르면, CDP 캡처가 한 번 실패했을 때 헬퍼 주입 경로로 되돌아가
 * "Failed to inject content script … Extension manifest must request permission to access
 * this host" 로 끝났다. 그 탭은 애초에 주입이 불가능한 탭이라 되돌아갈 곳이 아니다.
 *
 * 계약:
 *  1) 주입 불가 탭 + 뷰포트 캡처 → CDP 경로로만 찍고, chrome.scripting.executeScript 를 부르지 않는다.
 *  2) 주입 불가 탭 + fullPage/selector → not_injectable_for_option 으로 거절(캡처 시도 없음).
 *  3) 주입 불가 탭에서 1순위 CDP 파라미터가 실패하면 다음 조합까지 시도한다.
 *  4) 모든 CDP 조합이 실패하고 탭도 보이지 않으면 not_injectable 로 끝난다(주입 시도 없음).
 *  5) 일반 탭은 예전 그대로. CDP 1회 실패 시 헬퍼 주입 경로로 되돌아간다.
 *  6) (2026-09-06 Codex 리뷰 2항) 비활성 MCP 작업 창의 주입 불가 탭은 활성화만 하고
 *     페인트 확인(waitForFramePaint = executeScript)을 건너뛴다. 일반 탭은 그대로 확인한다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    withSession: vi.fn(async (_tabId: number, _owner: string, fn: () => Promise<unknown>) => fn()),
    sendCommand: vi.fn(async () => ({})),
  },
}));

vi.mock('@/utils/screenshot-context', () => ({
  screenshotContextManager: { setContext: vi.fn() },
}));

vi.mock('@/utils/activation-guard', () => ({ activateTab: vi.fn(async () => undefined) }));

vi.mock('@/utils/mcp-window-manager', () => ({ isMcpWindow: vi.fn(async () => false) }));

vi.mock('@/utils/adaptive-wait', () => ({
  sleep: vi.fn(async () => undefined),
  waitForFramePaint: vi.fn(async () => undefined),
  waitForHelperReady: vi.fn(async () => undefined),
}));

vi.mock('@/utils/log-redact', () => ({ redactedArgsForLog: vi.fn((a: unknown) => a) }));

vi.mock('@/utils/artifact-path', () => ({
  saveArtifactToDownloads: vi.fn(async () => ({ downloadId: 1, filename: 'x.png' })),
}));

vi.mock('@/utils/image-utils', () => ({
  canvasToDataURL: vi.fn(),
  createImageBitmapFromUrl: vi.fn(),
  cropAndResizeImage: vi.fn(),
  stitchImages: vi.fn(),
  MODEL_INPUT_MAX_LONG_EDGE: 1568,
  prepareImageForModelInput: vi.fn(async () => ({
    dataUrl: 'data:image/jpeg;base64,ZmFrZQ==',
    mimeType: 'image/jpeg',
    width: 800,
    height: 600,
    originalWidth: 800,
    originalHeight: 600,
    scale: 1,
  })),
}));

const EXTENSION_TAB_URL =
  'chrome-extension://aogfhfajjknomcnmlkbjmihjbknlhbbi/sidepanel.html?tab=daily';
const INJECT_DENIED = `Cannot access contents of url "${EXTENSION_TAB_URL}". Extension manifest must request permission to access this host.`;

type CaptureImpl = (params: Record<string, unknown>, attempt: number) => Promise<unknown>;

async function loadTool(options: {
  url: string;
  active?: boolean;
  isMcpWindow?: boolean;
  capture: CaptureImpl;
}) {
  vi.resetModules();

  const executeScript = vi.fn(async () => {
    throw new Error(INJECT_DENIED);
  });
  (globalThis as any).chrome.scripting = { executeScript };
  (globalThis as any).chrome.tabs.get = vi.fn(async (id: number) => ({
    id,
    url: options.url,
    title: 'Tab',
    windowId: 1,
    active: options.active === true,
  }));
  // content script 가 없는 탭이므로 ping/메시지는 항상 실패한다.
  (globalThis as any).chrome.tabs.sendMessage = vi.fn(async () => {
    throw new Error('Could not establish connection. Receiving end does not exist.');
  });
  (globalThis as any).chrome.tabs.captureVisibleTab = vi.fn(
    async () => 'data:image/png;base64,Zg==',
  );

  const mod = await import('@/entrypoints/background/tools/browser/screenshot');
  const { cdpSessionManager } = await import('@/utils/cdp-session-manager');
  const { isMcpWindow } = await import('@/utils/mcp-window-manager');
  (isMcpWindow as any).mockImplementation(async () => options.isMcpWindow === true);
  const { waitForFramePaint } = await import('@/utils/adaptive-wait');
  (waitForFramePaint as any).mockClear();
  const { activateTab } = await import('@/utils/activation-guard');
  (activateTab as any).mockClear();

  const captureParams: Array<Record<string, unknown>> = [];
  (cdpSessionManager.sendCommand as any).mockImplementation(
    async (_tabId: number, method: string, params: Record<string, unknown>) => {
      if (method === 'Page.getLayoutMetrics') {
        return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
      }
      if (method === 'Page.captureScreenshot') {
        captureParams.push(params);
        return options.capture(params, captureParams.length);
      }
      return {};
    },
  );

  return {
    tool: mod.screenshotTool,
    mod,
    executeScript,
    captureParams,
    waitForFramePaint: waitForFramePaint as any,
    activateTab: activateTab as any,
  };
}

const captureAlwaysOk: CaptureImpl = async () => ({ data: 'ZmFrZS1wbmc=' });
const captureAlwaysFails: CaptureImpl = async () => {
  throw new Error('Unable to capture screenshot');
};
/** 1순위(fromSurface) 조합만 실패하고, 플래그 없는 조합에서는 성공하는 탭을 흉내낸다. */
const captureFailsOnFromSurface: CaptureImpl = async (params) => {
  if (params.fromSurface === true) throw new Error('Unable to capture screenshot');
  return { data: 'ZmFrZS1wbmc=' };
};

function textOf(result: any): string {
  return result.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('\n');
}

describe('chrome_screenshot — 주입 불가 탭(확장 자체 페이지)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('isNotInjectableUrl 은 확장 페이지·devtools·view-source 만 걸러낸다', async () => {
    const { mod } = await loadTool({ url: EXTENSION_TAB_URL, capture: captureAlwaysOk });
    expect(mod.isNotInjectableUrl(EXTENSION_TAB_URL)).toBe(true);
    expect(mod.isNotInjectableUrl('devtools://devtools/bundled/inspector.html')).toBe(true);
    expect(mod.isNotInjectableUrl('view-source:https://example.com/')).toBe(true);
    expect(mod.isNotInjectableUrl('https://example.com/')).toBe(false);
    expect(mod.isNotInjectableUrl('about:blank')).toBe(false);
    expect(mod.isNotInjectableUrl(undefined)).toBe(false);
  });

  it('뷰포트 캡처는 CDP 로 성공하고 content script 주입을 시도하지 않는다', async () => {
    const { tool, executeScript, captureParams } = await loadTool({
      url: EXTENSION_TAB_URL,
      capture: captureAlwaysOk,
    });

    const result = await tool.execute({
      name: 'sidepanel',
      tabId: 42,
      background: true,
      fullPage: false,
      savePng: false,
      storeBase64: false,
    } as any);

    expect(result.isError).toBe(false);
    expect(executeScript).not.toHaveBeenCalled();
    expect(captureParams).toHaveLength(1);
    expect(captureParams[0]).toMatchObject({ format: 'png', fromSurface: true });
  });

  it('1순위 CDP 조합이 실패하면 다음 조합으로 다시 시도한다(주입 없이)', async () => {
    const { tool, executeScript, captureParams } = await loadTool({
      url: EXTENSION_TAB_URL,
      capture: captureFailsOnFromSurface,
    });

    const result = await tool.execute({
      name: 'sidepanel',
      tabId: 42,
      fullPage: false,
      savePng: false,
      storeBase64: false,
    } as any);

    expect(result.isError).toBe(false);
    expect(executeScript).not.toHaveBeenCalled();
    expect(captureParams.length).toBeGreaterThanOrEqual(2);
    expect(captureParams[1].fromSurface).toBeUndefined();
  });

  it('fullPage 는 not_injectable_for_option 으로 거절한다(캡처·주입 시도 없음)', async () => {
    const { tool, executeScript, captureParams } = await loadTool({
      url: EXTENSION_TAB_URL,
      capture: captureAlwaysOk,
    });

    const result = await tool.execute({
      name: 'sidepanel',
      tabId: 42,
      fullPage: true,
      savePng: false,
    } as any);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not_injectable_for_option');
    expect(textOf(result)).toContain('fullPage');
    expect(executeScript).not.toHaveBeenCalled();
    expect(captureParams).toHaveLength(0);
  });

  it('selector 도 not_injectable_for_option 으로 거절한다', async () => {
    const { tool, executeScript } = await loadTool({
      url: EXTENSION_TAB_URL,
      capture: captureAlwaysOk,
    });

    const result = await tool.execute({
      name: 'sidepanel',
      tabId: 42,
      selector: '#app',
      savePng: false,
    } as any);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not_injectable_for_option');
    expect(textOf(result)).toContain('selector');
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('CDP 조합이 모두 실패하고 탭이 보이지 않으면 not_injectable 로 끝난다(주입 시도 없음)', async () => {
    const { tool, executeScript, captureParams } = await loadTool({
      url: EXTENSION_TAB_URL,
      active: false,
      capture: captureAlwaysFails,
    });

    const result = await tool.execute({
      name: 'sidepanel',
      tabId: 42,
      fullPage: false,
      savePng: false,
    } as any);

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('not_injectable');
    expect(text).not.toContain('Failed to inject content script');
    expect(captureParams).toHaveLength(3);
    expect(executeScript).not.toHaveBeenCalled();
  });
});

describe('chrome_screenshot — 일반 탭은 기존 경로 그대로', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('CDP 캡처가 실패하면 예전처럼 헬퍼 주입 경로로 되돌아간다(재시도 조합 없음)', async () => {
    const { tool, executeScript, captureParams } = await loadTool({
      url: 'https://example.com/',
      active: true,
      capture: captureAlwaysFails,
    });

    const result = await tool.execute({
      name: 'page',
      tabId: 42,
      fullPage: false,
      savePng: false,
    } as any);

    // 주입은 시도되고(= 기존 경로), 이 테스트 환경에서는 주입이 거부되므로 그 에러로 끝난다.
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Failed to inject content script');
    // 일반 탭에서는 CDP 파라미터 재시도가 없어야 한다.
    expect(captureParams).toHaveLength(1);
  });

  it('CDP 캡처가 성공하면 예전처럼 그대로 반환한다', async () => {
    const { tool, executeScript, captureParams } = await loadTool({
      url: 'https://example.com/',
      active: true,
      capture: captureAlwaysOk,
    });

    const result = await tool.execute({
      name: 'page',
      tabId: 42,
      fullPage: false,
      savePng: false,
    } as any);

    expect(result.isError).toBe(false);
    expect(executeScript).not.toHaveBeenCalled();
    expect(captureParams).toHaveLength(1);
  });
});

describe('chrome_screenshot — 비활성 MCP 작업 창 탭의 활성화 경로', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('주입 불가 탭이면 활성화만 하고 페인트 확인(executeScript)을 건너뛴다', async () => {
    const { tool, executeScript, waitForFramePaint, activateTab } = await loadTool({
      url: EXTENSION_TAB_URL,
      active: false,
      isMcpWindow: true,
      capture: captureAlwaysOk,
    });

    const result = await tool.execute({
      name: 'sidepanel',
      tabId: 42,
      fullPage: false,
      savePng: false,
      storeBase64: false,
    } as any);

    expect(result.isError).toBe(false);
    // 작업 창 탭이므로 활성화는 한다.
    expect(activateTab).toHaveBeenCalledTimes(1);
    // 페인트 확인은 곧 executeScript 다. 주입 불가 탭에서는 부르지 않는다.
    expect(waitForFramePaint).not.toHaveBeenCalled();
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('일반 탭이면 예전처럼 활성화 후 페인트를 확인한다', async () => {
    const { tool, waitForFramePaint, activateTab } = await loadTool({
      url: 'https://example.com/',
      active: false,
      isMcpWindow: true,
      capture: captureAlwaysOk,
    });

    const result = await tool.execute({
      name: 'page',
      tabId: 42,
      fullPage: false,
      savePng: false,
      storeBase64: false,
    } as any);

    expect(result.isError).toBe(false);
    expect(activateTab).toHaveBeenCalledTimes(1);
    expect(waitForFramePaint).toHaveBeenCalledTimes(1);
  });
});
