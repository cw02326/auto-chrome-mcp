/**
 * ScaleMaker fork — HeartbeatWatchdog unit tests.
 *
 * silent-death 감지 로직(연속 무응답 → onDead) 이 정확히 동작하는지 검증.
 * tick() 을 직접 호출해 타이머 없이 결정론적으로 테스트한다.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  HeartbeatWatchdog,
  type HeartbeatWatchdogOptions,
} from '@/entrypoints/background/native-heartbeat';

function makeWatchdog(overrides: Partial<HeartbeatWatchdogOptions> = {}) {
  const ping = vi.fn<[], Promise<boolean>>().mockResolvedValue(true);
  const onDead = vi.fn();
  const onPhase = vi.fn();
  const wd = new HeartbeatWatchdog({
    intervalMs: 1000,
    maxMisses: 3,
    ping,
    onDead,
    onPhase,
    ...overrides,
  });
  return { wd, ping, onDead, onPhase };
}

describe('HeartbeatWatchdog', () => {
  it('건강한 ping 이 계속되면 onDead 를 절대 호출하지 않고 miss=0 유지', async () => {
    const { wd, onDead } = makeWatchdog();
    for (let i = 0; i < 5; i++) await wd.tick();
    expect(wd.missCount).toBe(0);
    expect(onDead).not.toHaveBeenCalled();
  });

  it('연속 무응답이 maxMisses 에 도달하면 onDead 를 정확히 1회 호출하고 miss 를 리셋', async () => {
    const ping = vi.fn<[], Promise<boolean>>().mockResolvedValue(false);
    const { wd, onDead } = makeWatchdog({ ping });
    await wd.tick(); // miss 1
    expect(wd.missCount).toBe(1);
    expect(onDead).not.toHaveBeenCalled();
    await wd.tick(); // miss 2
    expect(onDead).not.toHaveBeenCalled();
    await wd.tick(); // miss 3 → dead
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(wd.missCount).toBe(0); // 리셋되어 재판정까지 다시 카운트
  });

  it('무응답 중간에 한 번이라도 살아나면 miss 가 0 으로 리셋된다 (일시적 hiccup 무시)', async () => {
    let alive = false;
    const ping = vi.fn<[], Promise<boolean>>().mockImplementation(async () => alive);
    const { wd, onDead, onPhase } = makeWatchdog({ ping, maxMisses: 3 });
    await wd.tick(); // miss 1
    await wd.tick(); // miss 2
    expect(wd.missCount).toBe(2);
    alive = true;
    await wd.tick(); // recover
    expect(wd.missCount).toBe(0);
    expect(onPhase).toHaveBeenLastCalledWith('healthy');
    expect(onDead).not.toHaveBeenCalled();
  });

  it('ping 이 throw 하면 miss 로 취급한다', async () => {
    const ping = vi.fn<[], Promise<boolean>>().mockRejectedValue(new Error('network down'));
    const { wd, onDead } = makeWatchdog({ ping, maxMisses: 2 });
    await wd.tick();
    await wd.tick();
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it('onPhase 전이: 임계 전엔 suspect, 도달 시 dead', async () => {
    const ping = vi.fn<[], Promise<boolean>>().mockResolvedValue(false);
    const { wd, onPhase } = makeWatchdog({ ping, maxMisses: 3 });
    await wd.tick();
    await wd.tick();
    await wd.tick();
    const phases = onPhase.mock.calls.map((c) => c[0]);
    expect(phases).toEqual(['suspect', 'suspect', 'dead']);
  });

  it('inFlight 가드: 느린 ping 이 진행 중이면 겹친 tick 은 무시된다', async () => {
    let resolvePing!: (v: boolean) => void;
    const ping = vi.fn<[], Promise<boolean>>().mockImplementation(
      () => new Promise<boolean>((r) => (resolvePing = r)),
    );
    const { wd } = makeWatchdog({ ping });
    const first = wd.tick(); // ping 시작, 미완
    await wd.tick(); // 겹침 — 즉시 반환, ping 재호출 안 함
    expect(ping).toHaveBeenCalledTimes(1);
    resolvePing(true);
    await first;
  });

  it('start 는 주입된 타이머로 interval 을 걸고, stop 은 해제한다 (idempotent)', () => {
    const setIntervalFn = vi.fn().mockReturnValue(42);
    const clearIntervalFn = vi.fn();
    const { wd } = makeWatchdog({ timers: { setInterval: setIntervalFn, clearInterval: clearIntervalFn } });
    wd.start();
    wd.start(); // 두 번째는 무시
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    expect(wd.running).toBe(true);
    wd.stop();
    expect(clearIntervalFn).toHaveBeenCalledWith(42);
    expect(wd.running).toBe(false);
    wd.stop(); // idempotent
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
  });
});
