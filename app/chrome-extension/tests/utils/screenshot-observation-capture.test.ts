import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  record: vi.fn(),
  restore: vi.fn(),
  setContext: vi.fn(),
  prepare: vi.fn(),
  bitmap: vi.fn(),
}));

vi.mock('@/utils/screenshot-context', () => ({
  screenshotContextManager: {
    restore: mocks.restore,
    setContext: mocks.setContext,
    recordObservation: mocks.record,
  },
}));
vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    withSession: vi.fn(async (_id: number, _owner: string, fn: () => Promise<unknown>) => fn()),
    sendCommand: vi.fn(async (_id: number, method: string) =>
      method === 'Page.getLayoutMetrics'
        ? {
            cssLayoutViewport: { clientWidth: 800, clientHeight: 600 },
            cssContentSize: { width: 1200, height: 3000 },
          }
        : { data: 'ZmFrZQ==' },
    ),
  },
}));
vi.mock('@/utils/image-utils', () => ({
  canvasToDataURL: vi.fn(() => 'data:image/png;base64,ZmFrZQ=='),
  createImageBitmapFromUrl: mocks.bitmap,
  cropAndResizeImage: vi.fn(),
  stitchImages: vi.fn(),
  MODEL_INPUT_MAX_LONG_EDGE: 1568,
  prepareImageForModelInput: mocks.prepare,
}));
vi.mock('@/utils/activation-guard', () => ({ activateTab: vi.fn() }));
vi.mock('@/utils/mcp-window-manager', () => ({ isMcpWindow: vi.fn(async () => false) }));
vi.mock('@/utils/adaptive-wait', () => ({
  waitForFramePaint: vi.fn(),
  waitForHelperReady: vi.fn(),
}));
vi.mock('@/utils/log-redact', () => ({ redactedArgsForLog: (x: unknown) => x }));
vi.mock('@/utils/artifact-path', () => ({ saveArtifactToDownloads: vi.fn() }));

const page = (overrides: Record<string, unknown> = {}) => ({
  url: 'https://example.com/a',
  lastNavigationAt: 100,
  scrollX: 10,
  scrollY: 20,
  viewportWidth: 800,
  viewportHeight: 600,
  ...overrides,
});

async function load(states: Array<Record<string, unknown> | undefined>) {
  vi.resetModules();
  (chrome.tabs.get as any).mockResolvedValue({
    id: 7,
    url: 'https://example.com/a',
    windowId: 1,
    active: true,
  });
  (chrome as any).scripting ??= {};
  (chrome as any).scripting.executeScript = vi.fn();
  (chrome.scripting.executeScript as any).mockImplementation(async (args: any) => {
    if (args.files) return [];
    const state = states.shift();
    return state ? [{ result: state }] : [];
  });
  (chrome.tabs as any).sendMessage = vi.fn(async (_id: number, message: any) => {
    if (message.action === 'preparePageForCapture') return { success: true };
    if (message.action === 'getPageDetails')
      return {
        totalWidth: 1200,
        totalHeight: 3000,
        viewportWidth: 800,
        viewportHeight: 600,
        devicePixelRatio: 2,
        currentScrollX: 10,
        currentScrollY: 20,
      };
    if (message.action === 'getElementDetails')
      return { rect: { x: 30, y: 40, width: 200, height: 100 }, devicePixelRatio: 2 };
    return { success: true };
  });
  const mod = await import('@/entrypoints/background/tools/browser/screenshot');
  return mod.screenshotTool as any;
}

function resultPayload(result: any) {
  return JSON.parse(result.content[0].text);
}

describe('chrome_screenshot observation capture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.calls.length = 0;
    mocks.restore.mockImplementation(async () => {
      mocks.calls.push('restore');
    });
    mocks.setContext.mockImplementation(() => {
      mocks.calls.push('setContext');
    });
    mocks.record.mockImplementation(async (_id, input) => {
      mocks.calls.push('record');
      return { ...input, observationId: 'obs-1' };
    });
    mocks.prepare.mockResolvedValue({
      dataUrl: 'data:image/jpeg;base64,ZmFrZQ==',
      mimeType: 'image/jpeg',
      width: 400,
      height: 300,
      originalWidth: 1600,
      originalHeight: 1200,
      scale: 0.25,
    });
    mocks.bitmap.mockResolvedValue({ width: 1600, height: 1200 });
  });

  it('downscale된 모델 이미지 좌표와 observationId를 기록하고 restore→context→record 순서를 지킨다', async () => {
    const tool = await load([page(), page()]);
    const result = await tool.execute({ name: 'v', tabId: 7, storeBase64: true, savePng: false });
    expect(resultPayload(result).observationId).toBe('obs-1');
    expect(mocks.record).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        coordinateSpace: 'viewport',
        captureRect: { x: 10, y: 20, width: 800, height: 600 },
        screenshotWidth: 400,
        screenshotHeight: 300,
        metadataAvailable: true,
      }),
    );
    expect(mocks.calls).toEqual(['restore', 'setContext', 'record']);
  });

  it('storeBase64=false도 원본 이미지 크기의 observationId를 반환한다', async () => {
    const tool = await load([page(), page()]);
    const result = await tool.execute({ name: 'v', tabId: 7, storeBase64: false, savePng: false });
    expect(resultPayload(result).observationId).toBe('obs-1');
    expect(mocks.record).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ screenshotWidth: 1600, screenshotHeight: 1200 }),
    );
  });

  it.each([
    ['URL/navigation', page({ url: 'https://example.com/b', lastNavigationAt: 200 })],
    ['scroll', page({ scrollY: 21 })],
    ['viewport', page({ viewportWidth: 799 })],
  ])('viewport 캡처 전후 %s 변경은 metadataAvailable=false로 기록한다', async (_label, after) => {
    const tool = await load([page(), after]);
    await tool.execute({ name: 'v', tabId: 7, storeBase64: false, savePng: false });
    expect(mocks.record).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ metadataAvailable: false }),
    );
  });

  it('fullPage maxHeight를 CSS 좌표계 높이로 기록한다', async () => {
    const tool = await load([page(), page()]);
    await tool.execute({ name: 'f', tabId: 7, fullPage: true, maxHeight: 1000, savePng: false });
    expect(mocks.record).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        coordinateSpace: 'fullPage',
        captureRect: { x: 0, y: 0, width: 1200, height: 500 },
      }),
    );
  });

  it('selector 관찰 원점은 실제 CDP clip 문서 원점이다', async () => {
    const tool = await load([
      page(),
      page({ scrollX: 50, scrollY: 70 }),
      page({ scrollX: 50, scrollY: 70 }),
    ]);
    vi.mocked(cdpSessionManager.sendCommand).mockResolvedValueOnce({
      cssLayoutViewport: { clientWidth: 800, clientHeight: 600, pageX: 50, pageY: 70 },
    });
    await tool.execute({ name: 'e', tabId: 7, selector: '#x', savePng: false });
    expect(mocks.record).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        coordinateSpace: 'region',
        captureRect: { x: 80, y: 110, width: 200, height: 100 },
      }),
    );
  });

  it('fullPage는 헬퍼 추정치 대신 실제 CDP 콘텐츠 크기를 기록한다', async () => {
    const tool = await load([page(), page()]);
    vi.mocked(cdpSessionManager.sendCommand).mockResolvedValueOnce({
      cssLayoutViewport: { clientWidth: 800, clientHeight: 600 },
      cssContentSize: { width: 1400, height: 3200 },
    });
    await tool.execute({ name: 'f', tabId: 7, fullPage: true, savePng: false });
    expect(mocks.record).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ captureRect: { x: 0, y: 0, width: 1400, height: 3200 } }),
    );
  });

  it('요소를 자동 스크롤한 뒤 다시 움직이면 관찰을 무효화한다', async () => {
    const tool = await load([page(), page({ scrollY: 70 }), page({ scrollY: 80 })]);
    await tool.execute({ name: 'e', tabId: 7, selector: '#x', savePng: false });
    expect(mocks.record).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ metadataAvailable: false }),
    );
  });

  it('관찰 기록 실패는 observationId 없는 성공으로 반환하지 않는다', async () => {
    mocks.record.mockRejectedValueOnce(new Error('persist failed'));
    const tool = await load([page(), page()]);
    const result = await tool.execute({ name: 'v', tabId: 7, savePng: false });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('persist failed');
  });
});
