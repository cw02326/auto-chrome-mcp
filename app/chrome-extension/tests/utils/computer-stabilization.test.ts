import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  detach: vi.fn(),
  sendCommand: vi.fn(),
  bitmap: vi.fn(),
  prepare: vi.fn(),
  readState: vi.fn(),
  restore: vi.fn(),
  setContext: vi.fn(),
  record: vi.fn(),
}));

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    attach: mocks.attach,
    detach: mocks.detach,
    sendCommand: mocks.sendCommand,
  },
}));
vi.mock('@/utils/image-utils', () => ({
  createImageBitmapFromUrl: mocks.bitmap,
  prepareImageForModelInput: mocks.prepare,
}));
vi.mock('@/utils/screenshot-observation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/screenshot-observation')>();
  return { ...actual, readObservationPageState: mocks.readState };
});
vi.mock('@/utils/screenshot-context', () => ({
  screenshotContextManager: {
    restore: mocks.restore,
    setContext: mocks.setContext,
    recordObservation: mocks.record,
  },
}));

const page = (overrides: Record<string, unknown> = {}) => ({
  url: 'https://example.test/path',
  lastNavigationAt: 123,
  scrollX: 25,
  scrollY: 40,
  viewportWidth: 1000,
  viewportHeight: 500,
  ...overrides,
});

class TestOffscreenCanvas {
  width: number;
  height: number;
  private color = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  getContext() {
    return {
      drawImage: (bitmap: { color?: number }) => {
        this.color = bitmap.color ?? 0;
      },
      getImageData: () => {
        const pixels = new Uint8ClampedArray(this.width * this.height * 4);
        for (let index = 0; index < pixels.length; index += 4) {
          pixels[index] = this.color;
          pixels[index + 1] = this.color;
          pixels[index + 2] = this.color;
          pixels[index + 3] = 255;
        }
        return { data: pixels };
      },
    };
  }
}

async function load() {
  vi.resetModules();
  return await import('@/utils/computer-stabilization');
}

async function settleWithTime<T>(promise: Promise<T>, milliseconds = 3_000): Promise<T> {
  await vi.advanceTimersByTimeAsync(milliseconds);
  return await promise;
}

describe('computer action 후 화면 안정화', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.stubGlobal('OffscreenCanvas', TestOffscreenCanvas);

    mocks.attach.mockReset().mockResolvedValue(undefined);
    mocks.detach.mockReset().mockResolvedValue(undefined);
    mocks.sendCommand.mockReset().mockResolvedValue({ data: 'frame' });
    mocks.bitmap.mockReset().mockImplementation(async (dataUrl: string) => ({
      width: 2000,
      height: 1000,
      color: dataUrl.endsWith('dark') ? 255 : 10,
      close: vi.fn(),
    }));
    mocks.prepare.mockReset().mockResolvedValue({
      dataUrl: 'data:image/jpeg;base64,cHJlcGFyZWQ=',
      mimeType: 'image/jpeg',
      width: 1000,
      height: 500,
      originalWidth: 2000,
      originalHeight: 1000,
      scale: 0.5,
    });
    mocks.readState.mockReset().mockResolvedValue(page());
    mocks.restore.mockReset().mockResolvedValue(undefined);
    mocks.setContext.mockReset();
    mocks.record.mockReset().mockImplementation(async (_tabId, input) => ({
      ...input,
      observationId: 'obs-after',
      tabId: 7,
      timestamp: Date.now(),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('낮은 변화가 두 번 연속일 때 세 번째 프레임을 새 관찰로 저장한다', async () => {
    const { observeAfterAction } = await load();
    const result = await settleWithTime(observeAfterAction(7), 500);
    const { validateObservation } = await import('@/utils/screenshot-observation');

    expect(result.stabilization).toMatchObject({ status: 'stable', stable: true, samples: 3 });
    expect(result.observationId).toBe('obs-after');
    expect(result.image).toBeUndefined();
    expect(mocks.sendCommand).toHaveBeenCalledTimes(3);
    expect(mocks.sendCommand).toHaveBeenCalledWith(
      7,
      'Page.captureScreenshot',
      expect.objectContaining({ fromSurface: true, captureBeyondViewport: false }),
    );
    expect(mocks.record).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        coordinateSpace: 'viewport',
        captureRect: { x: 25, y: 40, width: 1000, height: 500 },
        screenshotWidth: 1000,
        screenshotHeight: 500,
        metadataAvailable: true,
      }),
    );
    expect(mocks.setContext).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ screenshotWidth: 1000, screenshotHeight: 500 }),
    );
    expect(mocks.attach).toHaveBeenCalledOnce();
    expect(mocks.detach).toHaveBeenCalledOnce();
    expect(validateObservation(result.observation as any, 7, page())).toMatchObject({ ok: true });
  });

  it('includeImage만 켰을 때 정규화 이미지와 그 이미지의 좌표 크기를 함께 반환한다', async () => {
    const { observeAfterAction } = await load();
    const result = await settleWithTime(observeAfterAction(7, { includeImage: true }), 500);

    expect(result.image).toEqual({
      type: 'image',
      data: 'cHJlcGFyZWQ=',
      mimeType: 'image/jpeg',
    });
    expect(result.observation).toMatchObject({
      observationId: 'obs-after',
      width: 1000,
      height: 500,
      cssWidth: 1000,
      cssHeight: 500,
      imageScale: 1,
      downscaled: true,
    });
  });

  it('계속 바뀌는 화면도 캡처 예산 상한에서 끝내고 마지막 프레임 ID를 반환한다', async () => {
    let frame = 0;
    mocks.sendCommand.mockImplementation(async () => ({
      data: ++frame % 2 === 0 ? 'dark' : 'light',
    }));
    const { observeAfterAction, STABILIZATION_MAX_WAIT_MS } = await load();
    const startedAt = Date.now();
    const result = await settleWithTime(observeAfterAction(7), STABILIZATION_MAX_WAIT_MS);

    expect(result.stabilization.status).toBe('timeout');
    expect(result.stabilization.stable).toBe(false);
    expect(result.stabilization.samples).toBeGreaterThan(2);
    expect(result.stabilization.elapsedMs).toBeLessThanOrEqual(STABILIZATION_MAX_WAIT_MS);
    expect(Date.now() - startedAt).toBe(STABILIZATION_MAX_WAIT_MS);
    expect(result.observationId).toBe('obs-after');
    expect(result.stabilization.reason).toContain('may still be moving');
    expect(mocks.record).toHaveBeenCalledOnce();
    expect(mocks.detach).toHaveBeenCalledOnce();
  });

  it('두 번째 캡처가 영원히 멎어도 상한 내에 첫 프레임을 저장하고 늦은 완료는 무시한다', async () => {
    let resolveLateCapture!: (value: { data: string }) => void;
    const lateCapture = new Promise<{ data: string }>((resolve) => {
      resolveLateCapture = resolve;
    });
    mocks.sendCommand.mockResolvedValueOnce({ data: 'light' }).mockReturnValueOnce(lateCapture);

    const { observeAfterAction, STABILIZATION_MAX_WAIT_MS } = await load();
    const pending = observeAfterAction(7);
    const result = await settleWithTime(pending, STABILIZATION_MAX_WAIT_MS);

    expect(result.stabilization).toMatchObject({ status: 'timeout', stable: false, samples: 1 });
    expect(result.observationId).toBe('obs-after');
    expect(mocks.record).toHaveBeenCalledOnce();
    expect(mocks.detach).toHaveBeenCalledOnce();

    resolveLateCapture({ data: 'dark' });
    await vi.runAllTimersAsync();
    await Promise.resolve();
    expect(mocks.bitmap).toHaveBeenCalledTimes(1);
    expect(mocks.record).toHaveBeenCalledOnce();
    expect(mocks.detach).toHaveBeenCalledOnce();
  });

  it('제한 스킴처럼 페이지 메타데이터를 읽지 못하면 캡처를 건너뛰고 오류로 던지지 않는다', async () => {
    mocks.readState.mockResolvedValue(undefined);
    const { observeAfterAction } = await load();
    const result = await observeAfterAction(7, { includeImage: true });

    expect(result.stabilization).toMatchObject({ status: 'skipped', stable: false, samples: 0 });
    expect(result.stabilization.reason).toContain('metadata is unavailable');
    expect(result.observationId).toBeUndefined();
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(mocks.sendCommand).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('CDP 캡처 거부는 skipped로 반환하고 이미 얻은 세션을 해제한다', async () => {
    mocks.sendCommand.mockRejectedValue(new Error('Not allowed on chrome:// pages'));
    const { observeAfterAction } = await load();
    const result = await observeAfterAction(7);

    expect(result.stabilization.status).toBe('skipped');
    expect(result.stabilization.reason).toContain('Not allowed on chrome:// pages');
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.detach).toHaveBeenCalledOnce();
  });

  it('관찰 저장이 멎어도 전체 상한을 넘기지 않고 사용 불가능한 ID를 반환하지 않는다', async () => {
    mocks.record.mockReturnValue(new Promise(() => undefined));
    const { observeAfterAction, STABILIZATION_MAX_WAIT_MS } = await load();
    const pending = observeAfterAction(7);
    const result = await settleWithTime(pending, STABILIZATION_MAX_WAIT_MS);

    expect(result.stabilization.status).toBe('skipped');
    expect(result.stabilization.elapsedMs).toBeLessThanOrEqual(STABILIZATION_MAX_WAIT_MS);
    expect(result.stabilization.reason).toContain('storage did not finish');
    expect(result.observationId).toBeUndefined();
    expect(mocks.detach).toHaveBeenCalledOnce();
  });

  it('이미지 정규화가 멎으면 원본 좌표계로 폴백해 저장 시간과 관찰 ID를 확보한다', async () => {
    mocks.prepare.mockReturnValue(new Promise(() => undefined));
    const { observeAfterAction, STABILIZATION_MAX_WAIT_MS } = await load();
    const result = await settleWithTime(
      observeAfterAction(7, { includeImage: true }),
      STABILIZATION_MAX_WAIT_MS,
    );

    expect(result.stabilization.status).toBe('stable');
    expect(result.observationId).toBe('obs-after');
    expect(result.image).toEqual({ type: 'image', data: 'frame', mimeType: 'image/png' });
    expect(result.observation).toMatchObject({
      width: 2000,
      height: 1000,
      mimeType: 'image/png',
      downscaled: false,
    });
    expect(mocks.record).toHaveBeenCalledOnce();
  });

  it('최종 캡처 뒤 스크롤이 바뀌면 곧바로 거부될 stale 관찰을 저장하지 않는다', async () => {
    mocks.readState
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(page({ scrollY: 41 }));
    const { observeAfterAction } = await load();
    const result = await settleWithTime(observeAfterAction(7), 500);

    expect(result.stabilization.status).toBe('skipped');
    expect(result.stabilization.reason).toContain('geometry changed after');
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.detach).toHaveBeenCalledOnce();
  });

  it.each(['attach', 'detach'] as const)(
    '%s 응답이 멎어도 상한에서 반환하고 다음 세션 재사용을 막는다',
    async (phase) => {
      let complete!: () => void;
      mocks[phase].mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          }),
      );
      const { observeAfterAction, STABILIZATION_MAX_WAIT_MS, isObservationCleanupPending } =
        await load();
      const outcome = await settleWithTime(observeAfterAction(7), STABILIZATION_MAX_WAIT_MS);
      expect(outcome.stabilization.elapsedMs).toBeLessThanOrEqual(STABILIZATION_MAX_WAIT_MS);
      expect(isObservationCleanupPending(7)).toBe(true);
      const skipped = await observeAfterAction(7);
      expect(skipped.stabilization.reason).toContain('cleanup');
      complete();
      await vi.advanceTimersByTimeAsync(0);
      expect(isObservationCleanupPending(7)).toBe(false);
      expect(mocks.attach).toHaveBeenCalledTimes(1);
      expect(mocks.detach).toHaveBeenCalledTimes(1);
      expect(mocks.record).not.toHaveBeenCalled();
    },
  );
});
