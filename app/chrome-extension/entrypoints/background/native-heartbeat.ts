/**
 * auto-chrome-mcp fork — Native connection heartbeat watchdog.
 *
 * upstream/vibemaker 는 chrome.runtime.Port 의 `onDisconnect` 이벤트에만 의존해
 * 재연결한다. 하지만 bridge 가 "조용히" 죽는 경우(HTTP server hang, half-open
 * socket, sleep/wake 후 좀비) Chrome 이 onDisconnect 를 쏘지 않아 port 객체는
 * 살아있는 것처럼 보이지만 실제로는 응답이 없다 → 사용자가 수동 재연결해야 함.
 *
 * 이 watchdog 은 그 사각지대를 메운다: 주기적으로 bridge 를 능동 ping 하고,
 * 연속 `maxMisses` 회 무응답이면 "silent-dead" 로 판정해 `onDead()` 로 기존
 * 재연결 머신을 트리거한다. 연결이 건강하면 아무 일도 하지 않는다(순수 additive).
 *
 * 로직은 chrome.* 의존성 없이 주입식으로 작성 — 단위 테스트 가능.
 */

export type HeartbeatPhase = 'healthy' | 'suspect' | 'dead';

export interface HeartbeatWatchdogOptions {
  /** ping 주기 (ms). */
  intervalMs: number;
  /** 연속 무응답 몇 회에서 silent-dead 로 판정할지. */
  maxMisses: number;
  /** bridge liveness probe. 응답 200 이면 true, 그 외/throw 면 false. 자체 timeout 포함. */
  ping: () => Promise<boolean>;
  /** silent-dead 판정 시 호출 — 기존 재연결 머신을 트리거하는 콜백. */
  onDead: () => void;
  /** 상태 전이 알림 (UI 뱃지용, 선택). */
  onPhase?: (phase: HeartbeatPhase) => void;
  /** 타이머 주입 (테스트용). 미지정 시 전역 setInterval/clearInterval 사용. */
  timers?: {
    setInterval: (cb: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
}

export class HeartbeatWatchdog {
  private timer: unknown = null;
  private misses = 0;
  private inFlight = false;
  private readonly setIntervalFn: (cb: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;

  constructor(private readonly opts: HeartbeatWatchdogOptions) {
    this.setIntervalFn =
      opts.timers?.setInterval ??
      ((cb, ms) => setInterval(cb, ms) as unknown as ReturnType<typeof setInterval>);
    this.clearIntervalFn =
      opts.timers?.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  }

  /** 현재까지 연속 무응답 횟수 (테스트/디버그용). */
  get missCount(): number {
    return this.misses;
  }

  /** watchdog 이 돌고 있는지. */
  get running(): boolean {
    return this.timer !== null;
  }

  /** 주기적 ping 시작. 이미 돌고 있으면 무시(idempotent). */
  start(): void {
    if (this.timer !== null) return;
    this.misses = 0;
    this.timer = this.setIntervalFn(() => {
      void this.tick();
    }, this.opts.intervalMs);
  }

  /** ping 중단 + 상태 초기화. idempotent. */
  stop(): void {
    if (this.timer === null) return;
    this.clearIntervalFn(this.timer);
    this.timer = null;
    this.misses = 0;
    this.inFlight = false;
  }

  /**
   * 단일 heartbeat 검사. interval 마다 자동 호출되지만, 테스트에서 직접 호출 가능.
   * inFlight 가드로 느린 ping 이 겹치지 않게 한다.
   */
  async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      let alive = false;
      try {
        alive = await this.opts.ping();
      } catch {
        alive = false;
      }

      if (alive) {
        if (this.misses > 0) this.opts.onPhase?.('healthy');
        this.misses = 0;
        return;
      }

      this.misses += 1;
      if (this.misses >= this.opts.maxMisses) {
        this.misses = 0;
        this.opts.onPhase?.('dead');
        this.opts.onDead();
      } else {
        this.opts.onPhase?.('suspect');
      }
    } finally {
      this.inFlight = false;
    }
  }
}
