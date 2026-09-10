// 관찰 생산자와 입력 소비자가 같은 좌표·거부 규약을 사용하도록 분리한다.
export const OBSERVATION_TTL_MS = 5 * 60 * 1000;

export interface ObservationPageState {
  url: string;
  // performance.timeOrigin: 같은 URL의 새 문서(새로고침 포함)를 구분한다.
  lastNavigationAt: number;
  scrollX: number;
  scrollY: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface ScreenshotObservation extends ObservationPageState {
  observationId: string;
  tabId: number;
  timestamp: number;
  coordinateSpace: 'viewport' | 'fullPage' | 'region';
  // 원점은 문서 CSS 좌표, 크기는 리사이즈 전 캡처 영역의 CSS 크기다.
  captureRect: { x: number; y: number; width: number; height: number };
  screenshotWidth: number;
  screenshotHeight: number;
  devicePixelRatio?: number;
  hostname?: string;
  // 제한 페이지 등에서 상태를 읽지 못해도 관찰 ID는 반환하되 입력은 거부한다.
  metadataAvailable: boolean;
}

export type ObservationInput = Omit<ScreenshotObservation, 'observationId' | 'tabId' | 'timestamp'>;
export type ObservationRejectionReason =
  | 'not_found'
  | 'expired'
  | 'tab_changed'
  | 'metadata_unavailable'
  | 'document_changed'
  | 'scroll_changed'
  | 'viewport_changed';
export type ObservationValidation =
  | { ok: true; observation: ScreenshotObservation }
  | { ok: false; reason: ObservationRejectionReason; message: string };

export interface ObservationStore {
  restore(): Promise<void>;
  recordObservation(tabId: number, input: ObservationInput): Promise<ScreenshotObservation>;
  // 만료 레코드도 검증 함수에 넘겨 expired를 구별할 수 있다. 정리된 ID는 not_found다.
  getObservation(observationId: string): ScreenshotObservation | undefined;
}

export function validateObservation(
  observation: ScreenshotObservation | undefined,
  tabId: number,
  current: ObservationPageState | undefined,
  now = Date.now(),
): ObservationValidation {
  const reject = (reason: ObservationRejectionReason, detail: string): ObservationValidation => ({
    ok: false,
    reason,
    message: `Observation rejected: ${detail}. Take a new screenshot and try again.`,
  });
  if (!observation) return reject('not_found', 'observationId was not found');
  if (now - observation.timestamp > OBSERVATION_TTL_MS)
    return reject('expired', 'observation expired');
  if (observation.tabId !== tabId) return reject('tab_changed', 'target tab changed');
  if (!observation.metadataAvailable || !current)
    return reject('metadata_unavailable', 'page metadata is unavailable');
  const rect = observation.captureRect;
  // 저장소 복구나 캡처 실패로 불완전한 크기가 남아도 NaN 좌표로 입력을 보내지 않는다.
  if (
    !rect ||
    ![
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      observation.screenshotWidth,
      observation.screenshotHeight,
    ].every(Number.isFinite) ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    observation.screenshotWidth <= 0 ||
    observation.screenshotHeight <= 0
  )
    return reject('metadata_unavailable', 'capture geometry is unavailable');
  if (observation.url !== current.url || observation.lastNavigationAt !== current.lastNavigationAt)
    return reject('document_changed', 'document URL or navigation generation changed');
  if (observation.scrollX !== current.scrollX || observation.scrollY !== current.scrollY)
    return reject('scroll_changed', 'scroll position changed');
  if (
    observation.viewportWidth !== current.viewportWidth ||
    observation.viewportHeight !== current.viewportHeight
  )
    return reject('viewport_changed', 'viewport size changed');
  return { ok: true, observation };
}

export function projectObservationCoordinates(
  x: number,
  y: number,
  observation: ScreenshotObservation,
): { x: number; y: number } {
  const rect = observation.captureRect;
  return {
    x: Math.round(rect.x + (x * rect.width) / observation.screenshotWidth - observation.scrollX),
    y: Math.round(rect.y + (y * rect.height) / observation.screenshotHeight - observation.scrollY),
  };
}

// 입력 전에 읽기만 한다. 상태를 확인할 수 없으면 ID를 사용한 입력은 실패 폐쇄한다.
export async function readObservationPageState(
  tabId: number,
): Promise<ObservationPageState | undefined> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        url: location.href,
        lastNavigationAt: performance.timeOrigin,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }),
    });
    const state = results?.[0]?.result;
    if (
      !state ||
      typeof state.url !== 'string' ||
      !state.url ||
      ![
        state.lastNavigationAt,
        state.scrollX,
        state.scrollY,
        state.viewportWidth,
        state.viewportHeight,
      ].every(Number.isFinite) ||
      state.lastNavigationAt <= 0 ||
      state.viewportWidth <= 0 ||
      state.viewportHeight <= 0
    )
      return undefined;
    return state;
  } catch {
    return undefined;
  }
}
