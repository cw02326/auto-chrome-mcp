import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateObservation, type ScreenshotObservation } from '@/utils/screenshot-observation';

const send = vi.fn();
const attach = vi.fn();
const detach = vi.fn();
const click = vi.fn();
const executeScript = vi.fn();

type CoordinateAction =
  | 'left_click'
  | 'right_click'
  | 'double_click'
  | 'triple_click'
  | 'hover'
  | 'left_click_drag';
const actions: CoordinateAction[] = [
  'left_click',
  'right_click',
  'double_click',
  'triple_click',
  'hover',
  'left_click_drag',
];

function input(action: CoordinateAction) {
  return {
    action,
    coordinates: { x: 10, y: 20 },
    ...(action === 'left_click_drag' ? { startCoordinates: { x: 1, y: 2 } } : {}),
  };
}

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: { attach, detach, sendCommand: send },
}));
vi.mock('@/entrypoints/background/tools/browser/interaction', () => ({
  clickTool: { execute: click },
  fillTool: { execute: vi.fn() },
}));

describe('computer 순수 좌표 CDP 경계', () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    vi.resetModules();
    attach.mockReset().mockResolvedValue(undefined);
    detach.mockReset().mockResolvedValue(undefined);
    send.mockReset().mockResolvedValue({});
    click
      .mockReset()
      .mockResolvedValue({ content: [{ type: 'text', text: '{}' }], isError: false });
    executeScript.mockReset().mockResolvedValue([{ result: { success: true } }]);
    (globalThis as any).chrome = { scripting: { executeScript } };
  });

  it.each(actions)('%s는 CDP transport를 반환한다', async (action) => {
    const { computerTool } = await import('@/entrypoints/background/tools/browser/computer');
    const result = await (computerTool as any).executePureCoordinateAction(
      input(action),
      7,
      { x: 10, y: 20 },
      action === 'left_click_drag' ? { x: 1, y: 2 } : undefined,
    );
    expect(JSON.parse(result.content[0].text)).toMatchObject({ success: true, transport: 'cdp' });
    expect(attach).toHaveBeenCalledOnce();
    expect(detach).toHaveBeenCalledOnce();
    const events = send.mock.calls.map(([, method, event]) => ({ method, ...event }));
    expect(events.every((event) => event.method === 'Input.dispatchMouseEvent')).toBe(true);
    expect(events[0]).toMatchObject({
      type: 'mouseMoved',
      x: 10 - (action === 'left_click_drag' ? 9 : 0),
    });
  });

  it.each(actions)('attach 실패 전에는 %s DOM 대체와 사유를 남긴다', async (action) => {
    attach.mockRejectedValueOnce(new Error('attach failed'));
    const { computerTool } = await import('@/entrypoints/background/tools/browser/computer');
    const result = await (computerTool as any).executePureCoordinateAction(
      input(action),
      7,
      { x: 10, y: 20 },
      action === 'left_click_drag' ? { x: 1, y: 2 } : undefined,
    );
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      transport: 'dom',
      transportFallbackReason: 'attach failed',
    });
    if (action === 'hover' || action === 'left_click_drag' || action === 'triple_click')
      expect(executeScript).toHaveBeenCalledOnce();
    else expect(click).toHaveBeenCalledOnce();
    expect(detach).not.toHaveBeenCalled();
  });

  it.each([
    ['첫 mouseMoved', 'left_click', 1],
    ['mousePressed', 'left_click', 2],
    ['mouseReleased', 'left_click', 3],
    ['두 번째 multi-click', 'double_click', 4],
  ] as const)('%s 실패 뒤에는 DOM 재시도를 하지 않는다', async (_name, action, failedCall) => {
    send.mockImplementation(async () => {
      if (send.mock.calls.length === failedCall) throw new Error('lost response');
      return {};
    });
    const { computerTool } = await import('@/entrypoints/background/tools/browser/computer');
    const result = await (computerTool as any).executePureCoordinateAction(input(action), 7, {
      x: 10,
      y: 20,
    });
    expect(result.content[0].text).toContain('Input may have been partially delivered');
    expect(click).not.toHaveBeenCalled();
    expect(executeScript).not.toHaveBeenCalled();
    expect(detach).toHaveBeenCalledOnce();
  });

  it('triple click은 clickCount 1, 2, 3을 순서대로 보낸다', async () => {
    const { computerTool } = await import('@/entrypoints/background/tools/browser/computer');
    await (computerTool as any).executePureCoordinateAction(input('triple_click'), 7, {
      x: 10,
      y: 20,
    });
    expect(send.mock.calls.map(([, , event]) => [event.type, event.clickCount])).toEqual([
      ['mouseMoved', undefined],
      ['mousePressed', 1],
      ['mouseReleased', 1],
      ['mousePressed', 2],
      ['mouseReleased', 2],
      ['mousePressed', 3],
      ['mouseReleased', 3],
    ]);
  });

  it('DOM drag 대체는 양 끝점의 단일 scripting 실행을 사용한다', async () => {
    attach.mockRejectedValueOnce(new Error('attach failed'));
    const { computerTool } = await import('@/entrypoints/background/tools/browser/computer');
    await (computerTool as any).executePureCoordinateAction(
      input('left_click_drag'),
      7,
      { x: 10, y: 20 },
      { x: 1, y: 2 },
    );
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ world: 'MAIN', args: [{ x: 1, y: 2 }, { x: 10, y: 20 }, {}] }),
    );
  });

  it.each(actions)('%s DOM 대체에도 CSS 좌표 경고를 남긴다', async (action) => {
    attach.mockRejectedValueOnce(new Error('attach failed'));
    const { computerTool } = await import('@/entrypoints/background/tools/browser/computer');
    const result = await (computerTool as any).executePureCoordinateAction(
      input(action),
      7,
      { x: 10, y: 20 },
      { x: 1, y: 2 },
      'CSS coordinates warning',
    );
    expect(JSON.parse(result.content[0].text).warning).toBe('CSS coordinates warning');
  });

  it('DOM triple fallback도 클릭 detail 1·2·3을 실제 이벤트로 보낸다', async () => {
    const NativeMouseEvent = MouseEvent;
    // jsdom의 Window 래퍼는 view 타입 검사를 통과하지 않는다. 이벤트 순서는 실제 DOM에서 검증한다.
    vi.stubGlobal(
      'MouseEvent',
      class extends NativeMouseEvent {
        constructor(type: string, init: MouseEventInit) {
          super(type, { ...init, view: undefined });
        }
      },
    );
    attach.mockRejectedValueOnce(new Error('attach failed'));
    const target = document.createElement('button');
    const events: Array<[string, number]> = [];
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick'])
      target.addEventListener(type, (event) => events.push([type, (event as MouseEvent).detail]));
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => target,
    });
    executeScript.mockImplementationOnce(async ({ func, args }) => [{ result: func(...args) }]);
    const { computerTool } = await import('@/entrypoints/background/tools/browser/computer');
    const outcome = await (computerTool as any).executePureCoordinateAction(
      input('triple_click'),
      7,
      { x: 10, y: 20 },
    );
    expect(outcome.isError, JSON.stringify(outcome)).toBe(false);
    expect(events).toEqual([
      ['mousedown', 1],
      ['mouseup', 1],
      ['click', 1],
      ['mousedown', 2],
      ['mouseup', 2],
      ['click', 2],
      ['dblclick', 2],
      ['mousedown', 3],
      ['mouseup', 3],
      ['click', 3],
    ]);
    expect(click).not.toHaveBeenCalled();
  });
});

describe('computer observation 거부 계약', () => {
  const now = 1_000_000;
  const observation = (): ScreenshotObservation => ({
    observationId: 'obs-1',
    tabId: 7,
    timestamp: now,
    coordinateSpace: 'viewport',
    url: 'https://example.test/a',
    lastNavigationAt: 100,
    scrollX: 3,
    scrollY: 4,
    viewportWidth: 1000,
    viewportHeight: 700,
    captureRect: { x: 3, y: 4, width: 1000, height: 700 },
    screenshotWidth: 1000,
    screenshotHeight: 700,
    metadataAvailable: true,
  });
  const current = () => ({
    url: 'https://example.test/a',
    lastNavigationAt: 100,
    scrollX: 3,
    scrollY: 4,
    viewportWidth: 1000,
    viewportHeight: 700,
  });

  it.each([
    ['missing', undefined, 7, current(), 'not_found'],
    ['expired', { timestamp: now - 5 * 60 * 1000 - 1 }, 7, current(), 'expired'],
    ['wrong tab', {}, 8, current(), 'tab_changed'],
    ['URL', {}, 7, { ...current(), url: 'https://example.test/b' }, 'document_changed'],
    ['navigation', {}, 7, { ...current(), lastNavigationAt: 101 }, 'document_changed'],
    ['scroll X', {}, 7, { ...current(), scrollX: 5 }, 'scroll_changed'],
    ['scroll Y', {}, 7, { ...current(), scrollY: 5 }, 'scroll_changed'],
    ['viewport width', {}, 7, { ...current(), viewportWidth: 999 }, 'viewport_changed'],
    ['viewport height', {}, 7, { ...current(), viewportHeight: 699 }, 'viewport_changed'],
    ['metadata unavailable', { metadataAvailable: false }, 7, current(), 'metadata_unavailable'],
  ] as const)(
    '%s observation은 입력 전 거부 이유를 반환한다',
    (name, change, tabId, page, reason) => {
      const candidate = observation();
      const result = validateObservation(
        name === 'missing' ? undefined : { ...candidate, ...change },
        tabId,
        page,
        now,
      );
      expect(result).toMatchObject({ ok: false, reason });
    },
  );
});
