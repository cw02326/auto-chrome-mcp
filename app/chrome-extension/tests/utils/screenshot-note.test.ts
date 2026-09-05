/**
 * auto-chrome-mcp fork — chrome_screenshot storeBase64 응답 회귀 테스트.
 *
 * 계약: storeBase64:true 응답 JSON 에는 더 이상 254자짜리 note 문구가 없다.
 * imageScale/cssWidth/cssHeight 등 실제로 좌표 환산에 쓰이는 필드는 그대로 남는다.
 *
 * 무거운 의존성(cdp-session-manager, image-utils, screenshot-context 등)은 모두 모킹해
 * CDP 뷰포트 캡처 경로(가장 단순한 분기: fullPage=false, selector 없음)만 태운다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    withSession: vi.fn(async (_tabId: number, _owner: string, fn: () => Promise<unknown>) => fn()),
    sendCommand: vi.fn(async (_tabId: number, method: string) => {
      if (method === 'Page.getLayoutMetrics') {
        return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
      }
      if (method === 'Page.captureScreenshot') {
        return { data: 'ZmFrZS1wbmc=' };
      }
      return {};
    }),
  },
}));

vi.mock('@/utils/screenshot-context', () => ({
  screenshotContextManager: { setContext: vi.fn() },
}));

vi.mock('@/utils/activation-guard', () => ({ activateTab: vi.fn(async () => undefined) }));

vi.mock('@/utils/mcp-window-manager', () => ({ isMcpWindow: vi.fn(async () => false) }));

vi.mock('@/utils/adaptive-wait', () => ({
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

type ScreenshotModule = typeof import('@/entrypoints/background/tools/browser/screenshot');

async function loadTool() {
  vi.resetModules();
  (globalThis as any).chrome.tabs.get = vi.fn(async (id: number) => ({
    id,
    url: 'https://example.com/',
    title: 'Example',
    windowId: 1,
    active: true,
  }));

  const mod: ScreenshotModule = await import('@/entrypoints/background/tools/browser/screenshot');
  return mod.screenshotTool;
}

function payloadOf(result: any) {
  return JSON.parse(result.content[0].text);
}

describe('chrome_screenshot — note 필드 제거', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('storeBase64 응답에 note 가 없고, imageScale/cssWidth/cssHeight 는 그대로 남는다', async () => {
    const tool = await loadTool();

    const result = await tool.execute({
      name: 'test',
      tabId: 7,
      storeBase64: true,
      fullPage: false,
      savePng: false,
    } as any);

    expect(result.isError).toBe(false);
    const payload = payloadOf(result);

    expect(payload).not.toHaveProperty('note');
    expect(payload.success).toBe(true);
    expect(typeof payload.imageScale).toBe('number');
    expect(typeof payload.cssWidth).toBe('number');
    expect(typeof payload.cssHeight).toBe('number');
    expect(payload.width).toBe(800);
    expect(payload.height).toBe(600);

    // 이미지는 여전히 별도 MCP image 블록으로 온다 (본문 텍스트에는 base64 가 없다)
    expect(result.content[1].type).toBe('image');
    expect(payload.base64Data).toBeUndefined();
  });
});
