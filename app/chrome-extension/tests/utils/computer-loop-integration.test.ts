import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  ready: vi.fn(),
  guardAction: vi.fn(),
  releaseAll: vi.fn(),
  execute: vi.fn(),
  hasHeldInput: vi.fn(),
  hasHeldButtons: vi.fn(),
  modifierMask: vi.fn(),
}));
const mocks = vi.hoisted(() => ({
  observe: vi.fn(),
  send: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  screenshot: vi.fn(),
  click: vi.fn(),
  read: vi.fn(),
  getObservation: vi.fn(),
}));
vi.mock('@/utils/computer-input-state', () => ({ computerInputState: state }));
vi.mock('@/utils/computer-stabilization', () => ({
  observeAfterAction: mocks.observe,
  isObservationCleanupPending: () => false,
}));
vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: { attach: mocks.attach, detach: mocks.detach, sendCommand: mocks.send },
}));
vi.mock('@/entrypoints/background/tools/base-browser', () => ({
  BaseBrowserToolExecutor: class {
    async tryGetTab() {
      return { id: 7, url: 'https://example.test/' };
    }
  },
}));
vi.mock('@/entrypoints/background/tools/browser/interaction', () => ({
  clickTool: { execute: mocks.click },
  fillTool: { execute: vi.fn() },
}));
vi.mock('@/entrypoints/background/tools/browser/keyboard', () => ({
  keyboardTool: { execute: vi.fn() },
}));
vi.mock('@/entrypoints/background/tools/browser/screenshot', () => ({
  screenshotTool: { execute: mocks.screenshot },
}));
vi.mock('@/entrypoints/background/tools/browser/gif-recorder', () => ({
  isAutoCaptureActive: () => false,
  captureFrameOnAction: vi.fn(),
}));
vi.mock('@/utils/screenshot-context', () => ({
  screenshotContextManager: {
    restore: vi.fn(),
    getContext: () => undefined,
    getObservation: mocks.getObservation,
  },
  scaleCoordinates: (x: number, y: number) => ({ x, y }),
}));
vi.mock('@/utils/screenshot-observation', async (original) => ({
  ...(await original<typeof import('@/utils/screenshot-observation')>()),
  readObservationPageState: mocks.read,
}));

import { computerTool } from '@/entrypoints/background/tools/browser/computer';

const page = {
  url: 'https://example.test/',
  lastNavigationAt: 1,
  scrollX: 10,
  scrollY: 20,
  viewportWidth: 800,
  viewportHeight: 600,
};
const payload = (result: any) => JSON.parse(result.content[0].text);
const ok = () => ({
  content: [{ type: 'text' as const, text: '{"success":true}' }],
  isError: false,
});

describe('computer loop 공개 실행 통합', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    state.ready.mockResolvedValue(undefined);
    state.guardAction.mockResolvedValue(undefined);
    state.releaseAll.mockResolvedValue(undefined);
    state.hasHeldInput.mockReturnValue(false);
    state.hasHeldButtons.mockReturnValue(false);
    state.modifierMask.mockReturnValue(0);
    state.execute.mockResolvedValue(ok());
    mocks.attach.mockResolvedValue(undefined);
    mocks.detach.mockResolvedValue(undefined);
    mocks.send.mockResolvedValue({});
    mocks.screenshot.mockResolvedValue(ok());
    mocks.click.mockResolvedValue(ok());
    mocks.read.mockResolvedValue(page);
    mocks.getObservation.mockImplementation((id) =>
      id === 'after-id'
        ? {
            ...page,
            observationId: id,
            tabId: 7,
            timestamp: Date.now(),
            coordinateSpace: 'viewport',
            captureRect: { x: 10, y: 20, width: 800, height: 600 },
            screenshotWidth: 400,
            screenshotHeight: 300,
            metadataAvailable: true,
          }
        : undefined,
    );
    mocks.observe.mockResolvedValue({
      observationId: 'after-id',
      stabilization: { status: 'stable', stable: true, elapsedMs: 400, samples: 3 },
      observation: { width: 400, height: 300 },
    });
  });

  it('기본 호출은 기존 결과 객체를 그대로 반환하고 재캡처하지 않는다', async () => {
    const original = ok();
    mocks.screenshot.mockResolvedValue(original);
    expect(await computerTool.execute({ action: 'screenshot' })).toBe(original);
    expect(mocks.observe).not.toHaveBeenCalled();
    expect(
      await computerTool.execute({ action: 'screenshot', observeAfter: false, includeImage: true }),
    ).toBe(original);
    expect(mocks.observe).not.toHaveBeenCalled();
  });

  it('observeAfter로 반환한 ID를 바로 다음 좌표 클릭에 투영한다', async () => {
    const first = await computerTool.execute({
      action: 'left_click',
      coordinates: { x: 1, y: 2 },
      observeAfter: true,
    });
    expect(payload(first)).toMatchObject({
      success: true,
      transport: 'cdp',
      observationId: 'after-id',
    });
    expect(first.content).toHaveLength(1);
    mocks.send.mockClear();
    const next = await computerTool.execute({
      action: 'left_click',
      coordinates: { x: 100, y: 50 },
      observationId: payload(first).observationId,
    });
    expect(next.isError).toBe(false);
    expect(mocks.send.mock.calls[0][2]).toMatchObject({ x: 200, y: 100 });
  });

  it('재관찰 ID에 이전 screenshot 이미지를 섞지 않는다', async () => {
    mocks.screenshot.mockResolvedValue({
      content: [
        { type: 'text', text: '{"observationId":"old-id"}' },
        { type: 'image', data: 'old-image', mimeType: 'image/png' },
      ],
      isError: false,
    });
    const result = await computerTool.execute({ action: 'screenshot', observeAfter: true });
    expect(payload(result).observationId).toBe('after-id');
    expect(result.content).toHaveLength(1);
  });

  it('이미지 옵션과 안정화 상한 상태를 결과에 보존한다', async () => {
    mocks.observe.mockResolvedValue({
      observationId: 'after-id',
      stabilization: { status: 'timeout', stable: false, elapsedMs: 2000, samples: 8 },
      image: { type: 'image', data: 'eA==', mimeType: 'image/png' },
    });
    const result = await computerTool.execute({
      action: 'key_up',
      key: 'Shift',
      observeAfter: true,
      includeImage: true,
    });
    expect(mocks.observe).toHaveBeenCalledWith(7, {
      includeImage: true,
      fullResolution: undefined,
    });
    expect(payload(result).stabilization).toMatchObject({ status: 'timeout', stable: false });
    expect(result.content[1]).toMatchObject({ type: 'image' });
  });

  it('관찰 불가 상태가 성공한 입력을 오류로 바꾸지 않는다', async () => {
    mocks.observe.mockResolvedValue({
      stabilization: {
        status: 'skipped',
        stable: false,
        elapsedMs: 0,
        samples: 0,
        reason: 'Capture unavailable',
      },
    });
    const result = await computerTool.execute({
      action: 'key_up',
      key: 'Shift',
      observeAfter: true,
    });
    expect(result.isError).toBe(false);
    expect(payload(result).stabilization.status).toBe('skipped');
  });

  it('재관찰을 건너뛰면 이전 screenshot ID를 새 ID처럼 반환하지 않는다', async () => {
    mocks.screenshot.mockResolvedValue({
      content: [{ type: 'text', text: '{"observationId":"old-id"}' }],
      isError: false,
    });
    mocks.observe.mockResolvedValue({
      stabilization: { status: 'skipped', stable: false, elapsedMs: 0, samples: 0 },
    });
    const result = await computerTool.execute({ action: 'screenshot', observeAfter: true });
    expect(payload(result).observationId).toBeUndefined();
    expect(payload(result).stabilization.status).toBe('skipped');
  });

  it.each(['mouse_down', 'mouse_up', 'drag_path'] as const)(
    '%s의 좌표 전체가 관찰 좌표계로 투영된다',
    async (action) => {
      await computerTool.execute({
        action,
        coordinates: { x: 100, y: 50 },
        path: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
        observationId: 'after-id',
      });
      expect(state.execute).toHaveBeenCalledWith(
        7,
        expect.objectContaining({
          action,
          coordinates: { x: 200, y: 100 },
          path: [
            { x: 2, y: 4 },
            { x: 6, y: 8 },
          ],
        }),
      );
    },
  );

  it('오래된 관찰로 mouse_up이 거부되어도 남은 입력은 즉시 정리한다', async () => {
    state.hasHeldInput.mockReturnValue(true);
    const result = await computerTool.execute({
      action: 'mouse_up',
      coordinates: { x: 1, y: 2 },
      observationId: 'missing',
      observeAfter: true,
    });
    expect(result.isError).toBe(true);
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.releaseAll).toHaveBeenCalledWith(7);
    expect(mocks.observe).not.toHaveBeenCalled();
  });

  it('액션 오류와 예외 모두 눌린 상태를 정리한다', async () => {
    state.hasHeldInput.mockReturnValue(true);
    state.execute.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'failure' }],
      isError: true,
    });
    expect(
      (await computerTool.execute({ action: 'mouse_down', coordinates: { x: 1, y: 2 } })).isError,
    ).toBe(true);
    expect(state.releaseAll).toHaveBeenCalledTimes(1);
    state.execute.mockRejectedValueOnce(new Error('CDP timeout'));
    expect((await computerTool.execute({ action: 'key_down', key: 'Shift' })).isError).toBe(true);
    expect(state.releaseAll).toHaveBeenCalledTimes(2);
  });

  it('유지한 조합키를 기존 순수 좌표 CDP 입력에 전달한다', async () => {
    state.hasHeldInput.mockReturnValue(true);
    state.modifierMask.mockReturnValue(8);
    await computerTool.execute({
      action: 'left_click',
      coordinates: { x: 10, y: 20 },
      modifiers: { ctrlKey: true },
    });
    expect(mocks.send.mock.calls.every(([, , event]) => event.modifiers === 10)).toBe(true);
  });

  it('유지한 버튼의 hover는 눌린 버튼 상태를 보존하는 경로로 보낸다', async () => {
    state.hasHeldButtons.mockReturnValue(true);
    await computerTool.execute({ action: 'hover', coordinates: { x: 10, y: 20 } });
    expect(state.execute).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ action: 'hover', coordinates: { x: 10, y: 20 } }),
    );
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('유지한 키가 있으면 CDP attach 실패에도 DOM 폴백하지 않는다', async () => {
    state.hasHeldInput.mockReturnValue(true);
    mocks.attach.mockRejectedValue(new Error('Attach failed'));
    expect(
      (await computerTool.execute({ action: 'left_click', coordinates: { x: 1, y: 2 } })).isError,
    ).toBe(true);
    expect(mocks.click).not.toHaveBeenCalled();
    expect(state.releaseAll).toHaveBeenCalledWith(7);
  });
});
