import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OBSERVATION_TTL_MS,
  projectObservationCoordinates,
  readObservationPageState,
  validateObservation,
  type ObservationPageState,
  type ScreenshotObservation,
} from '@/utils/screenshot-observation';

const state: ObservationPageState = {
  url: 'https://example.com/first',
  lastNavigationAt: 1000,
  scrollX: 40,
  scrollY: 300,
  viewportWidth: 800,
  viewportHeight: 600,
};
const observation: ScreenshotObservation = {
  ...state,
  observationId: 'opaque-id',
  tabId: 7,
  timestamp: 2000,
  coordinateSpace: 'viewport',
  captureRect: { x: 40, y: 300, width: 800, height: 600 },
  screenshotWidth: 400,
  screenshotHeight: 300,
  metadataAvailable: true,
};

describe('관찰의 문서·화면 검증', () => {
  it('같은 문서와 화면에서만 관찰을 돌려준다', () => {
    expect(validateObservation(observation, 7, state, 2001)).toEqual({ ok: true, observation });
  });
  it.each([
    ['document_changed', { url: 'https://example.com/second' }],
    ['document_changed', { lastNavigationAt: 1001 }],
    ['scroll_changed', { scrollX: 41 }],
    ['scroll_changed', { scrollY: 301 }],
    ['viewport_changed', { viewportWidth: 801 }],
    ['viewport_changed', { viewportHeight: 601 }],
  ] as const)('%s 변경을 설명하고 재캡처를 안내한다: %j', (reason, change) => {
    expect(validateObservation(observation, 7, { ...state, ...change }, 2001)).toMatchObject({
      ok: false,
      reason,
      message: expect.stringContaining('Take a new screenshot and try again'),
    });
  });
  it('없는 ID·다른 탭·만료·읽기 불가 상태를 구별한다', () => {
    expect(validateObservation(undefined, 7, state, 2001)).toMatchObject({ reason: 'not_found' });
    expect(validateObservation(observation, 8, state, 2001)).toMatchObject({
      reason: 'tab_changed',
    });
    expect(validateObservation(observation, 7, state, 2001 + OBSERVATION_TTL_MS)).toMatchObject({
      reason: 'expired',
    });
    expect(validateObservation(observation, 7, undefined, 2001)).toMatchObject({
      reason: 'metadata_unavailable',
    });
    expect(
      validateObservation({ ...observation, metadataAvailable: false }, 7, state, 2001),
    ).toMatchObject({ reason: 'metadata_unavailable' });
  });
  it('불완전한 캡처 크기로 NaN 입력을 만들지 않는다', () => {
    expect(
      validateObservation({ ...observation, screenshotWidth: 0 }, 7, state, 2001),
    ).toMatchObject({ reason: 'metadata_unavailable' });
    expect(
      validateObservation(
        { ...observation, captureRect: undefined } as unknown as ScreenshotObservation,
        7,
        state,
        2001,
      ),
    ).toMatchObject({ reason: 'metadata_unavailable' });
  });
});

describe('모델 이미지에서 뷰포트 CSS 좌표로 변환', () => {
  it('스크롤한 뷰포트의 축소 이미지를 변환한다', () => {
    expect(projectObservationCoordinates(100, 50, observation)).toEqual({ x: 200, y: 100 });
  });
  it('잘라낸 영역의 문서 원점과 가로·세로 비율을 각각 적용한다', () => {
    expect(
      projectObservationCoordinates(25, 20, {
        ...observation,
        coordinateSpace: 'region',
        captureRect: { x: 200, y: 500, width: 300, height: 100 },
        screenshotWidth: 100,
        screenshotHeight: 100,
      }),
    ).toEqual({ x: 235, y: 220 });
  });
  it('전체 페이지 좌표에서 캡처 당시 스크롤을 뺀다', () => {
    expect(
      projectObservationCoordinates(100, 200, {
        ...observation,
        coordinateSpace: 'fullPage',
        captureRect: { x: 0, y: 0, width: 800, height: 2400 },
        screenshotWidth: 400,
        screenshotHeight: 1200,
      }),
    ).toEqual({ x: 160, y: 100 });
  });
});

describe('현재 문서 상태 읽기', () => {
  const original = chrome.scripting;
  afterEach(() => {
    chrome.scripting = original;
  });
  function mockResult(value: unknown) {
    chrome.scripting = {
      executeScript: vi.fn().mockResolvedValue(value),
    } as unknown as typeof chrome.scripting;
  }
  it('검증 가능한 상태만 반환한다', async () => {
    mockResult([{ result: state }]);
    expect(await readObservationPageState(7)).toEqual(state);
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7 } }),
    );
  });
  it.each([
    { value: [] },
    { value: [{ result: {} }] },
    { value: [{ result: { ...state, lastNavigationAt: NaN } }] },
    { value: [{ result: { ...state, viewportWidth: 0 } }] },
  ])('불완전한 상태를 거부한다: %j', async ({ value }) => {
    mockResult(value);
    expect(await readObservationPageState(7)).toBeUndefined();
  });
  it('주입 거절은 상태 확인 불가로 반환한다', async () => {
    mockResult([]);
    vi.mocked(chrome.scripting.executeScript).mockRejectedValue(new Error('Cannot access page'));
    expect(await readObservationPageState(7)).toBeUndefined();
  });
});
