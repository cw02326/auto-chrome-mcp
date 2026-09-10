import type { ComputerObservationResult, ObserveAfterOptions } from './computer-loop-contract';
import { cdpSessionManager } from './cdp-session-manager';
import { createImageBitmapFromUrl, prepareImageForModelInput } from './image-utils';
import { screenshotContextManager } from './screenshot-context';
import { readObservationPageState, type ObservationPageState } from './screenshot-observation';

/** 비교 캡처 사이에 브라우저가 한 프레임 이상 그릴 시간을 주되 액션 루프 지연은 짧게 유지한다. */
export const STABILIZATION_SAMPLE_INTERVAL_MS = 150;
/** 계속 움직이는 페이지에서도 한 액션이 오래 붙잡히지 않도록 전체 관찰을 2.5초 안에 끝낸다. */
export const STABILIZATION_MAX_WAIT_MS = 2_500;
/** 마지막 프레임 검증·이미지 정규화·관찰 저장 시간을 남겨 캡처 타임아웃도 유효한 ID로 돌려준다. */
export const STABILIZATION_FINALIZATION_RESERVE_MS = 600;
/** 최종 메타데이터 검증과 session 저장이 상한 직전에 시작되지 않도록 200ms를 확보한다. */
export const STABILIZATION_MIN_STORAGE_BUDGET_MS = 200;
/** 64px 축소본은 비교 비용을 제한하면서 화면 전역의 큰 움직임은 보존한다. */
export const STABILIZATION_MAX_SAMPLE_EDGE = 64;
/** 축소·압축 과정의 미세한 색 흔들림은 무시하되 평균 채널 변화가 1%를 넘으면 움직임으로 본다. */
export const STABILIZATION_DIFF_THRESHOLD = 0.01;
/** 한 번의 우연한 동일 프레임을 안정으로 오인하지 않도록 낮은 변화가 두 번 연속일 때만 확정한다. */
export const STABILIZATION_REQUIRED_CONSECUTIVE_MATCHES = 2;

const SESSION_OWNER_PREFIX = 'computer:observe-after';
let leaseSequence = 0;
const pendingSessionCleanup = new Map<number, Promise<void>>();

// 마감 뒤 CDP attach/detach가 끝나는 경우 새 입력이 정리 중인 세션을 재사용하지 못하게 한다.
export function isObservationCleanupPending(tabId: number): boolean {
  return pendingSessionCleanup.has(tabId);
}

function trackSessionCleanup(tabId: number, work: Promise<unknown>): Promise<void> {
  const cleanup = work.then(
    () => undefined,
    () => undefined,
  );
  pendingSessionCleanup.set(tabId, cleanup);
  void cleanup.then(() => {
    if (pendingSessionCleanup.get(tabId) === cleanup) pendingSessionCleanup.delete(tabId);
  });
  return cleanup;
}

interface CapturedFrame {
  dataUrl: string;
  pixels: Uint8ClampedArray;
  sampleWidth: number;
  sampleHeight: number;
  width: number;
  height: number;
  before: ObservationPageState;
  after: ObservationPageState;
}

class StabilizationDeadlineError extends Error {
  constructor() {
    super('Screen stabilization timed out');
    this.name = 'StabilizationDeadlineError';
  }
}

function samePageState(a: ObservationPageState, b: ObservationPageState): boolean {
  return (
    a.url === b.url &&
    a.lastNavigationAt === b.lastNavigationAt &&
    a.scrollX === b.scrollX &&
    a.scrollY === b.scrollY &&
    a.viewportWidth === b.viewportWidth &&
    a.viewportHeight === b.viewportHeight
  );
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'Unknown capture error');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function remainingMs(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Date.now());
}

async function beforeDeadline<T>(promise: Promise<T>, deadlineAt: number): Promise<T> {
  const remaining = remainingMs(deadlineAt);
  if (remaining <= 0) throw new StabilizationDeadlineError();

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StabilizationDeadlineError()), remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function downscaleFrame(
  dataUrl: string,
  deadlineAt: number,
): Promise<{
  pixels: Uint8ClampedArray;
  sampleWidth: number;
  sampleHeight: number;
  width: number;
  height: number;
}> {
  const bitmapPromise = createImageBitmapFromUrl(dataUrl);
  let bitmap: ImageBitmap;
  try {
    bitmap = await beforeDeadline(bitmapPromise, deadlineAt);
  } catch (error) {
    // 디코딩이 마감 뒤 끝나도 비트맵 자원이 남지 않게 하고, 후속 저장 작업은 시작하지 않는다.
    void bitmapPromise.then(
      (lateBitmap) => lateBitmap.close?.(),
      () => undefined,
    );
    throw error;
  }
  try {
    const width = bitmap.width;
    const height = bitmap.height;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error('CDP Page.captureScreenshot returned an image with invalid dimensions');
    }
    const scale = Math.min(1, STABILIZATION_MAX_SAMPLE_EDGE / Math.max(width, height));
    const sampleWidth = Math.max(1, Math.round(width * scale));
    const sampleHeight = Math.max(1, Math.round(height * scale));
    const canvas = new OffscreenCanvas(sampleWidth, sampleHeight);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Unable to decode screenshot pixels');
    context.drawImage(bitmap, 0, 0, sampleWidth, sampleHeight);
    const pixels = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
    return { pixels, sampleWidth, sampleHeight, width, height };
  } finally {
    bitmap.close?.();
  }
}

function frameDifference(a: CapturedFrame, b: CapturedFrame): number {
  if (a.sampleWidth !== b.sampleWidth || a.sampleHeight !== b.sampleHeight) return 1;
  let difference = 0;
  // 알파는 캡처마다 불투명하므로 RGB만 비교해 불필요한 연산을 줄인다.
  for (let index = 0; index < a.pixels.length; index += 4) {
    difference += Math.abs(a.pixels[index] - b.pixels[index]);
    difference += Math.abs(a.pixels[index + 1] - b.pixels[index + 1]);
    difference += Math.abs(a.pixels[index + 2] - b.pixels[index + 2]);
  }
  return difference / (a.sampleWidth * a.sampleHeight * 3 * 255);
}

async function captureFrame(tabId: number, deadlineAt: number): Promise<CapturedFrame> {
  const before = await beforeDeadline(readObservationPageState(tabId), deadlineAt);
  if (!before) throw new Error('Page metadata is unavailable for observation');
  const shot = await beforeDeadline(
    cdpSessionManager.sendCommand<{ data?: string }>(tabId, 'Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    }),
    deadlineAt,
  );
  const data = typeof shot?.data === 'string' ? shot.data : '';
  if (!data) throw new Error('CDP Page.captureScreenshot returned empty data');
  const dataUrl = `data:image/png;base64,${data}`;
  const decoded = await downscaleFrame(dataUrl, deadlineAt);
  const after = await beforeDeadline(readObservationPageState(tabId), deadlineAt);
  if (!after) throw new Error('Page metadata is unavailable for observation');
  return { dataUrl, before, after, ...decoded };
}

function stabilization(
  status: 'stable' | 'timeout' | 'skipped',
  startedAt: number,
  samples: number,
  reason?: string,
): ComputerObservationResult['stabilization'] {
  return {
    status,
    stable: status === 'stable',
    elapsedMs: Math.max(0, Date.now() - startedAt),
    samples,
    ...(reason ? { reason } : {}),
  };
}

function skippedResult(
  startedAt: number,
  samples: number,
  reason: string,
): ComputerObservationResult {
  return { stabilization: stabilization('skipped', startedAt, samples, reason) };
}

/**
 * 액션 직후 대상 탭을 CDP로 반복 캡처해 안정화를 기다리고, 마지막으로 비교한 프레임을
 * 다음 좌표 액션이 검증할 수 있는 관찰 레코드로 만든다.
 */
export async function observeAfterAction(
  tabId: number,
  options: ObserveAfterOptions = {},
): Promise<ComputerObservationResult> {
  const startedAt = Date.now();
  const deadlineAt = startedAt + STABILIZATION_MAX_WAIT_MS;
  const captureDeadlineAt = deadlineAt - STABILIZATION_FINALIZATION_RESERVE_MS;
  if (isObservationCleanupPending(tabId))
    return skippedResult(startedAt, 0, 'Previous observation session cleanup is still pending');
  // 같은 탭의 관찰이 겹쳐도 한 호출의 늦은 정리가 다른 호출의 owner 지분을 지우지 않는다.
  const sessionOwner = `${SESSION_OWNER_PREFIX}:${tabId}:${++leaseSequence}`;
  let attached = false;
  let samples = 0;
  let lastFrame: CapturedFrame | undefined;
  let stable = false;
  let timedOut = false;

  let initialState: ObservationPageState | undefined;
  try {
    initialState = await beforeDeadline(readObservationPageState(tabId), captureDeadlineAt);
  } catch (error) {
    if (error instanceof StabilizationDeadlineError) {
      return skippedResult(
        startedAt,
        samples,
        'Stabilization deadline reached before page metadata was available',
      );
    }
  }
  if (!initialState) {
    return skippedResult(
      startedAt,
      samples,
      'Page metadata is unavailable; observation was skipped',
    );
  }

  try {
    const attaching = cdpSessionManager.attach(tabId, sessionOwner);
    try {
      await beforeDeadline(attaching, captureDeadlineAt);
      attached = true;
    } catch (error) {
      if (error instanceof StabilizationDeadlineError)
        trackSessionCleanup(
          tabId,
          attaching.then(() => cdpSessionManager.detach(tabId, sessionOwner)),
        );
      return skippedResult(
        startedAt,
        samples,
        `Screen capture unavailable; observation was skipped: ${errorText(error)}`,
      );
    }

    let consecutiveMatches = 0;
    let previous: CapturedFrame | undefined;
    while (remainingMs(captureDeadlineAt) > 0) {
      let current: CapturedFrame;
      try {
        current = await captureFrame(tabId, captureDeadlineAt);
      } catch (error) {
        if (error instanceof StabilizationDeadlineError) {
          timedOut = true;
          break;
        }
        return skippedResult(
          startedAt,
          samples,
          `Screen capture unavailable; observation was skipped: ${errorText(error)}`,
        );
      }

      samples += 1;
      lastFrame = current;
      const geometryStable = samePageState(current.before, current.after);
      if (
        previous &&
        samePageState(previous.after, current.before) &&
        geometryStable &&
        frameDifference(previous, current) <= STABILIZATION_DIFF_THRESHOLD
      ) {
        consecutiveMatches += 1;
        if (consecutiveMatches >= STABILIZATION_REQUIRED_CONSECUTIVE_MATCHES) {
          stable = true;
          break;
        }
      } else {
        consecutiveMatches = 0;
      }
      previous = current;

      try {
        await beforeDeadline(sleep(STABILIZATION_SAMPLE_INTERVAL_MS), captureDeadlineAt);
      } catch (error) {
        if (error instanceof StabilizationDeadlineError) timedOut = true;
        break;
      }
    }
    if (!stable) timedOut = true;
  } finally {
    if (attached) {
      // 정리도 전체 마감에 포함한다. 늦은 정리가 남으면 다음 computer 입력은 재사용을 거부한다.
      try {
        await beforeDeadline(
          trackSessionCleanup(tabId, cdpSessionManager.detach(tabId, sessionOwner)),
          deadlineAt,
        );
      } catch {
        // CDP가 이미 강제로 끊겼으면 매니저가 내부 상태를 정리하므로 캡처 결과 처리는 계속한다.
      }
    }
  }

  if (!lastFrame) {
    return {
      stabilization: stabilization(
        'timeout',
        startedAt,
        samples,
        'Stabilization deadline reached before an observation could be captured',
      ),
    };
  }

  if (!samePageState(lastFrame.before, lastFrame.after)) {
    return skippedResult(
      startedAt,
      samples,
      'Page geometry changed during the final capture; observation was skipped',
    );
  }

  let outputDataUrl = lastFrame.dataUrl;
  let mimeType = 'image/png';
  let width = lastFrame.width;
  let height = lastFrame.height;
  let imageScale = 1;
  if (!options.fullResolution) {
    try {
      const imageDeadlineAt = deadlineAt - STABILIZATION_MIN_STORAGE_BUDGET_MS;
      const prepared = await beforeDeadline(
        prepareImageForModelInput(lastFrame.dataUrl),
        imageDeadlineAt,
      );
      outputDataUrl = prepared.dataUrl;
      mimeType = prepared.mimeType;
      width = prepared.width;
      height = prepared.height;
      imageScale = prepared.scale;
    } catch {
      // 정규화 실패 시에도 원본 PNG의 정확한 좌표계로 관찰을 만들 수 있다.
    }
  }

  // 이미지 처리 뒤 다시 확인해 곧바로 거부될 stale ID를 저장하지 않는다.
  let currentState: ObservationPageState | undefined;
  try {
    currentState = await beforeDeadline(readObservationPageState(tabId), deadlineAt);
  } catch {
    return skippedResult(
      startedAt,
      samples,
      'Page metadata is unavailable after capture; observation was skipped',
    );
  }
  if (!currentState || !samePageState(lastFrame.after, currentState)) {
    return skippedResult(
      startedAt,
      samples,
      'Page geometry changed after the final capture; observation was skipped',
    );
  }

  const captureRect = {
    x: currentState.scrollX,
    y: currentState.scrollY,
    width: currentState.viewportWidth,
    height: currentState.viewportHeight,
  };
  let observation: Awaited<ReturnType<typeof screenshotContextManager.recordObservation>>;
  try {
    if (remainingMs(deadlineAt) < STABILIZATION_MIN_STORAGE_BUDGET_MS) {
      throw new StabilizationDeadlineError();
    }
    // Promise를 만들기 전에 남은 시간을 확인해 마감 뒤 restore/storage 작업을 새로 시작하지 않는다.
    await beforeDeadline(screenshotContextManager.restore(), deadlineAt);
    if (remainingMs(deadlineAt) < STABILIZATION_MIN_STORAGE_BUDGET_MS) {
      throw new StabilizationDeadlineError();
    }
    screenshotContextManager.setContext(tabId, {
      screenshotWidth: width,
      screenshotHeight: height,
      viewportWidth: currentState.viewportWidth,
      viewportHeight: currentState.viewportHeight,
      hostname: hostnameOf(currentState.url),
    });
    const recordPromise = screenshotContextManager.recordObservation(tabId, {
      ...currentState,
      coordinateSpace: 'viewport',
      captureRect,
      screenshotWidth: width,
      screenshotHeight: height,
      hostname: hostnameOf(currentState.url),
      metadataAvailable: true,
    });
    // 시작된 chrome.storage 쓰기는 취소할 API가 없으므로 반환만 상한으로 제한하고 후속 쓰기는 만들지 않는다.
    observation = await beforeDeadline(recordPromise, deadlineAt);
  } catch (error) {
    return skippedResult(
      startedAt,
      samples,
      error instanceof StabilizationDeadlineError
        ? 'Observation storage did not finish before the stabilization deadline'
        : `Observation storage unavailable; observation was skipped: ${errorText(error)}`,
    );
  }

  const base64Data = outputDataUrl.replace(/^data:image\/[^;]+;base64,/, '');
  return {
    observationId: observation.observationId,
    stabilization: stabilization(
      stable && !timedOut ? 'stable' : 'timeout',
      startedAt,
      samples,
      stable && !timedOut
        ? undefined
        : 'Maximum stabilization wait reached; observation was captured while the screen may still be moving',
    ),
    observation: {
      ...observation,
      width,
      height,
      cssWidth: currentState.viewportWidth,
      cssHeight: currentState.viewportHeight,
      mimeType,
      imageScale: Number((width / currentState.viewportWidth).toFixed(4)),
      downscaled: imageScale < 1,
    },
    ...(options.includeImage
      ? { image: { type: 'image' as const, data: base64Data, mimeType } }
      : {}),
  };
}
