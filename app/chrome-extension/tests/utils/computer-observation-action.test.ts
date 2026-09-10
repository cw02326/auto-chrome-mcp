import { beforeEach, describe, expect, it, vi } from 'vitest';

const attach = vi.fn();
const detach = vi.fn();
const sendCommand = vi.fn();
const click = vi.fn();
const executeScript = vi.fn();
const restore = vi.fn();
const getObservation = vi.fn();
const getContext = vi.fn();
const readPageState = vi.fn();
const recordObservation = vi.fn();

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: { attach, detach, sendCommand },
}));
vi.mock('@/entrypoints/background/tools/browser/interaction', () => ({
  clickTool: { execute: click },
  fillTool: { execute: vi.fn() },
}));
vi.mock('@/utils/screenshot-context', () => ({
  screenshotContextManager: { restore, getObservation, getContext, recordObservation },
  scaleCoordinates: (x: number, y: number) => ({ x, y }),
}));
vi.mock('@/utils/image-utils', () => ({
  MODEL_INPUT_MAX_LONG_EDGE: 1568,
  prepareImageForModelInput: vi.fn(async () => ({
    dataUrl: 'data:image/jpeg;base64,eA==',
    mimeType: 'image/jpeg',
    width: 100,
    height: 50,
    originalWidth: 200,
    originalHeight: 100,
    scale: 0.5,
  })),
}));
vi.mock('@/utils/screenshot-observation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/screenshot-observation')>();
  return { ...actual, readObservationPageState: readPageState };
});

const page = () => ({
  url: 'https://example.test/a',
  lastNavigationAt: 100,
  scrollX: 3,
  scrollY: 4,
  viewportWidth: 1000,
  viewportHeight: 700,
});
const observation = (change: Record<string, unknown> = {}) => ({
  observationId: 'obs-1',
  tabId: 7,
  timestamp: Date.now(),
  coordinateSpace: 'viewport' as const,
  ...page(),
  captureRect: { x: 3, y: 4, width: 1000, height: 700 },
  screenshotWidth: 1000,
  screenshotHeight: 700,
  metadataAvailable: true,
  ...change,
});
const tab = { id: 7, url: 'https://example.test/a' } as chrome.tabs.Tab;

describe('computer observation 소비자 경계', () => {
  beforeEach(() => {
    vi.resetModules();
    attach.mockReset().mockResolvedValue(undefined);
    detach.mockReset().mockResolvedValue(undefined);
    sendCommand.mockReset().mockResolvedValue({});
    click
      .mockReset()
      .mockResolvedValue({ content: [{ type: 'text', text: 'unchanged' }], isError: false });
    executeScript.mockReset().mockResolvedValue([{ result: { success: true } }]);
    restore.mockReset().mockResolvedValue(undefined);
    getObservation.mockReset().mockReturnValue(observation());
    getContext.mockReset().mockReturnValue(undefined);
    readPageState.mockReset().mockResolvedValue(page());
    recordObservation
      .mockReset()
      .mockImplementation(async (_id, value) => ({ ...value, observationId: 'zoom-id' }));
    (globalThis as any).chrome = { scripting: { executeScript } };
  });

  it.each([
    ['missing', undefined, page()],
    ['expired', observation({ timestamp: Date.now() - 5 * 60_000 - 1 }), page()],
    ['wrong tab', observation({ tabId: 8 }), page()],
    ['URL', observation(), { ...page(), url: 'https://example.test/b' }],
    ['navigation', observation(), { ...page(), lastNavigationAt: 101 }],
    ['scroll X', observation(), { ...page(), scrollX: 4 }],
    ['scroll Y', observation(), { ...page(), scrollY: 5 }],
    ['viewport width', observation(), { ...page(), viewportWidth: 999 }],
    ['viewport height', observation(), { ...page(), viewportHeight: 699 }],
    ['metadata', observation({ metadataAvailable: false }), page()],
  ])('%s ID는 입력 전에 거부된다', async (_name, candidate, current) => {
    getObservation.mockReturnValue(candidate);
    readPageState.mockResolvedValue(current);
    const { computerTool } = await import('@/entrypoints/background/tools/browser/computer');
    const result = await (computerTool as any).executeAction(
      { action: 'left_click', coordinates: { x: 10, y: 20 }, observationId: 'obs-1' },
      tab,
    );
    expect(result.isError).toBe(true);
    expect(attach).not.toHaveBeenCalled();
    expect(sendCommand).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('유효 ID 좌표를 captureRect 좌표계에서 viewport로 투영한다', async () => {
    getObservation.mockReturnValue(
      observation({
        captureRect: { x: 103, y: 204, width: 500, height: 350 },
        screenshotWidth: 1000,
        screenshotHeight: 700,
      }),
    );
    const { computerTool } = await import('@/entrypoints/background/tools/browser/computer');
    const result = await (computerTool as any).executeAction(
      { action: 'left_click', coordinates: { x: 500, y: 350 }, observationId: 'obs-1' },
      tab,
    );
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      transport: 'cdp',
      coordinates: { x: 350, y: 375 },
    });
    expect(sendCommand.mock.calls[0][2]).toMatchObject({ x: 350, y: 375 });
  });

  it('ref/selector 경로는 observation ID가 있어도 기존 click 응답을 그대로 반환한다', async () => {
    const { computerTool } = await import('@/entrypoints/background/tools/browser/computer');
    const sentinel = { content: [{ type: 'text', text: 'exact legacy result' }], isError: false };
    click.mockResolvedValue(sentinel);
    await expect(
      (computerTool as any).executeAction(
        { action: 'left_click', ref: 'r1', observationId: 'missing' },
        tab,
      ),
    ).resolves.toBe(sentinel);
    await expect(
      (computerTool as any).executeAction(
        { action: 'left_click', selector: '#x', observationId: 'missing' },
        tab,
      ),
    ).resolves.toBe(sentinel);
    expect(getObservation).not.toHaveBeenCalled();
  });

  it('관찰 ID 없는 좌표 입력은 warning을 포함한다', async () => {
    const { computerTool } = await import('@/entrypoints/background/tools/browser/computer');
    const result = await (computerTool as any).executeAction(
      { action: 'left_click', coordinates: { x: 1, y: 2 } },
      tab,
    );
    expect(JSON.parse(result.content[0].text).warning).toContain('Take a new screenshot');
  });

  it('빈 observationId도 생략으로 취급하지 않고 거부한다', async () => {
    getObservation.mockReturnValue(undefined);
    const { computerTool } = await import('@/entrypoints/background/tools/browser/computer');
    const result = await (computerTool as any).executeAction(
      { action: 'left_click', coordinates: { x: 1, y: 2 }, observationId: '' },
      tab,
    );
    expect(result.isError).toBe(true);
    expect(attach).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it('zoom은 실제 clip 원점과 모델 픽셀 크기를 새 관찰로 반환한다', async () => {
    sendCommand.mockImplementation(async (_id, method) =>
      method === 'Page.getLayoutMetrics'
        ? { cssLayoutViewport: { clientWidth: 1000, clientHeight: 700, pageX: 3, pageY: 4 } }
        : { data: 'eA==' },
    );
    const { computerTool } = await import('@/entrypoints/background/tools/browser/computer');
    const result = await (computerTool as any).executeAction(
      { action: 'zoom', region: { x0: 10, y0: 20, x1: 210, y1: 120 } },
      tab,
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      observationId: 'zoom-id',
      width: 100,
      height: 50,
    });
    expect(recordObservation).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        coordinateSpace: 'region',
        captureRect: { x: 13, y: 24, width: 200, height: 100 },
        screenshotWidth: 100,
        screenshotHeight: 50,
        metadataAvailable: true,
      }),
    );
    expect(detach).toHaveBeenCalledOnce();
  });

  it('zoom 관찰 저장 실패에서도 detach는 한 번이다', async () => {
    sendCommand.mockResolvedValue({ data: 'eA==' });
    recordObservation.mockRejectedValue(new Error('persist failed'));
    const { computerTool } = await import('@/entrypoints/background/tools/browser/computer');
    const result = await (computerTool as any).executeAction(
      { action: 'zoom', region: { x0: 1, y0: 2, x1: 11, y1: 12 } },
      tab,
    );
    expect(result.isError).toBe(true);
    expect(detach).toHaveBeenCalledOnce();
  });

  it('hostname 변경 hover는 입력 전에 차단한다', async () => {
    getContext.mockReturnValue({ hostname: 'other.test' });
    const { computerTool } = await import('@/entrypoints/background/tools/browser/computer');
    const result = await (computerTool as any).executeAction(
      { action: 'hover', coordinates: { x: 1, y: 2 } },
      tab,
    );
    expect(result.isError).toBe(true);
    expect(sendCommand).not.toHaveBeenCalled();
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('mixed drag의 startRef와 raw end도 invalid observation ID면 입력 전에 거부된다', async () => {
    const { computerTool } = await import('@/entrypoints/background/tools/browser/computer');
    getObservation.mockReturnValue(undefined);
    const result = await (computerTool as any).executeAction(
      {
        action: 'left_click_drag',
        startRef: 'r1',
        coordinates: { x: 10, y: 20 },
        observationId: 'missing',
      },
      tab,
    );
    expect(result.isError).toBe(true);
    expect(attach).not.toHaveBeenCalled();
    expect(sendCommand).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(executeScript).not.toHaveBeenCalled();
  });
});
