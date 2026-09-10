import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OBSERVATION_TTL_MS, projectObservationCoordinates } from '@/utils/screenshot-observation';

describe('screenshot observation session storage', () => {
  let session: Record<string, unknown>;

  beforeEach(() => {
    vi.resetModules();
    session = {};
    (chrome.storage.session.get as any).mockImplementation(async () => ({ ...session }));
    (chrome.storage.session.set as any).mockImplementation(
      async (value: Record<string, unknown>) => {
        Object.assign(session, value);
      },
    );
  });
  afterEach(() => vi.useRealTimers());

  const input = () => ({
    coordinateSpace: 'viewport' as const,
    captureRect: { x: 10, y: 20, width: 800, height: 600 },
    screenshotWidth: 1600,
    screenshotHeight: 1200,
    url: 'https://example.com/page',
    lastNavigationAt: 1234,
    scrollX: 10,
    scrollY: 20,
    viewportWidth: 800,
    viewportHeight: 600,
    hostname: 'example.com',
    metadataAvailable: true,
  });

  it('워커 모듈이 다시 로드돼도 관찰과 레거시 좌표 컨텍스트를 복구한다', async () => {
    const first = await import('@/utils/screenshot-context');
    await first.screenshotContextManager.restore();
    first.screenshotContextManager.setContext(7, {
      screenshotWidth: 1600,
      screenshotHeight: 1200,
      viewportWidth: 800,
      viewportHeight: 600,
    });
    const recorded = await first.screenshotContextManager.recordObservation(7, input());
    expect(chrome.storage.session.set).toHaveBeenCalledTimes(1);

    vi.resetModules();
    const restarted = await import('@/utils/screenshot-context');
    await restarted.screenshotContextManager.restore();

    expect(restarted.screenshotContextManager.getObservation(recorded.observationId)).toMatchObject(
      input(),
    );
    expect(restarted.screenshotContextManager.getContext(7)).toMatchObject({
      viewportWidth: 800,
      viewportHeight: 600,
    });
    expect(
      projectObservationCoordinates(
        200,
        100,
        restarted.screenshotContextManager.getObservation(recorded.observationId)!,
      ),
    ).toEqual({ x: 100, y: 50 });
    expect(chrome.storage.session.set).toHaveBeenCalledTimes(1);
  });

  it('변경 없는 restore는 storage 쓰기를 추가하지 않는다', async () => {
    const first = await import('@/utils/screenshot-context');
    await first.screenshotContextManager.recordObservation(7, input());
    expect(chrome.storage.session.set).toHaveBeenCalledTimes(1);
    await first.screenshotContextManager.restore();
    expect(chrome.storage.session.set).toHaveBeenCalledTimes(1);
  });

  it('탭 종료 리스너가 해당 탭 관찰을 session storage에서도 정리한다', async () => {
    const listeners: Array<(tabId: number) => void> = [];
    (chrome.tabs.onRemoved.addListener as any).mockImplementation(
      (listener: (tabId: number) => void) => listeners.push(listener),
    );
    const manager = (await import('@/utils/screenshot-context')).screenshotContextManager;
    const recorded = await manager.recordObservation(7, input());
    listeners.at(-1)?.(7);
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.getObservation(recorded.observationId)).toBeUndefined();
    await vi.waitFor(() =>
      expect((session.screenshotObservationsV1 as any).observations).toEqual({}),
    );
    vi.resetModules();
    const restarted = (await import('@/utils/screenshot-context')).screenshotContextManager;
    await restarted.restore();
    expect(restarted.getObservation(recorded.observationId)).toBeUndefined();
  });

  it('복구 중 닫힌 탭은 저장소에서도 지우고 다음 재시작에도 되살리지 않는다', async () => {
    const manager = (await import('@/utils/screenshot-context')).screenshotContextManager;
    const recorded = await manager.recordObservation(7, input());
    vi.resetModules();
    let resolveRead!: (value: unknown) => void;
    const oldSnapshot = structuredClone(session);
    vi.mocked(chrome.storage.session.get).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const restarted = (await import('@/utils/screenshot-context')).screenshotContextManager;
    const restoring = restarted.restore();
    restarted.clear(7);
    resolveRead(oldSnapshot);
    await restoring;
    await vi.waitFor(() =>
      expect((session.screenshotObservationsV1 as any).observations).toEqual({}),
    );
    vi.resetModules();
    const third = (await import('@/utils/screenshot-context')).screenshotContextManager;
    await third.restore();
    expect(third.getObservation(recorded.observationId)).toBeUndefined();
    await expect(restarted.recordObservation(7, input())).rejects.toThrow('closed tab');
  });

  it('내비게이션은 관찰만 무효화하고 hostname 가드는 복구 뒤에도 남긴다', async () => {
    const manager = (await import('@/utils/screenshot-context')).screenshotContextManager;
    await manager.restore();
    manager.setContext(7, { ...input(), hostname: 'example.com' });
    const recorded = await manager.recordObservation(7, input());
    vi.resetModules();
    const restarted = (await import('@/utils/screenshot-context')).screenshotContextManager;
    const listener = vi.mocked(chrome.webNavigation.onCommitted.addListener).mock.calls.at(-1)![0];
    listener({ tabId: 7, frameId: 0 } as any);
    await restarted.restore();
    await vi.waitFor(() =>
      expect((session.screenshotObservationsV1 as any).observations).toEqual({}),
    );
    expect(restarted.getObservation(recorded.observationId)).toBeUndefined();
    expect(restarted.getContext(7)?.hostname).toBe('example.com');
  });

  it('하위 프레임 이동은 최상위 관찰을 지우지 않는다', async () => {
    const manager = (await import('@/utils/screenshot-context')).screenshotContextManager;
    const recorded = await manager.recordObservation(7, input());
    vi.mocked(chrome.webNavigation.onCommitted.addListener).mock.calls.at(-1)![0]({
      tabId: 7,
      frameId: 1,
    } as any);
    expect(manager.getObservation(recorded.observationId)).toBeDefined();
  });

  it('만료 관찰은 잠시 남아 거부 사유를 구별하고 오래된 항목은 복구 시 정리한다', async () => {
    vi.useFakeTimers();
    const manager = (await import('@/utils/screenshot-context')).screenshotContextManager;
    await manager.restore();
    manager.setContext(7, input());
    const recorded = await manager.recordObservation(7, input());
    vi.setSystemTime(Date.now() + OBSERVATION_TTL_MS + 1);
    expect(manager.getContext(7)).toBeUndefined();
    expect(manager.getObservation(recorded.observationId)).toBeDefined();
    vi.setSystemTime(Date.now() + OBSERVATION_TTL_MS);
    vi.resetModules();
    const restarted = (await import('@/utils/screenshot-context')).screenshotContextManager;
    await restarted.restore();
    expect(restarted.getObservation(recorded.observationId)).toBeUndefined();
    expect(session.screenshotObservationsV1 as any).toEqual({ observations: {}, contexts: {} });
  });

  it('동시 복구는 한 번 읽고 연속 캡처는 이전 관찰을 잃지 않는다', async () => {
    const manager = (await import('@/utils/screenshot-context')).screenshotContextManager;
    await Promise.all([manager.restore(), manager.restore(), manager.restore()]);
    expect(chrome.storage.session.get).toHaveBeenCalledTimes(1);
    const records = await Promise.all([
      manager.recordObservation(7, input()),
      manager.recordObservation(8, input()),
    ]);
    expect(records[0].observationId).not.toBe(records[1].observationId);
    expect(Object.keys((session.screenshotObservationsV1 as any).observations)).toHaveLength(2);
    expect(chrome.storage.session.set).toHaveBeenCalledTimes(1);
  });

  it('session 쓰기 실패를 숨기지 않고 다음 캡처에서 재시도한다', async () => {
    const manager = (await import('@/utils/screenshot-context')).screenshotContextManager;
    vi.mocked(chrome.storage.session.set).mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(manager.recordObservation(7, input())).rejects.toThrow('Storage unavailable');
    const recorded = await manager.recordObservation(7, input());
    expect(
      (session.screenshotObservationsV1 as any).observations[recorded.observationId],
    ).toBeDefined();
    expect(chrome.storage.session.set).toHaveBeenCalledTimes(2);
  });
});
