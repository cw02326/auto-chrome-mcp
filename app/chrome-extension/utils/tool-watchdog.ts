/**
 * 도구 실행 워치독 (auto-chrome-mcp fork).
 *
 * 탭 단위 직렬화(`utils/tab-lock.ts`)는 앞선 호출이 **반드시 끝난다** 는 전제 위에 서 있다.
 * 그런데 `chrome.tabs.sendMessage` 는 상대가 `sendResponse` 를 영영 안 부르면 영원히 pending
 * 이라, 도구 하나가 안 끝나면 그 탭의 이후 호출이 전부 뒤에 줄을 서서 **영구 대기**했다
 * (증상: "그 탭만 통째로 먹통").
 *
 * 예산을 넘기면 락을 풀고 실패로 끝내, 탭이 막히는 대신 원인이 적힌 에러가 나가게 한다.
 * 실제 작업은 백그라운드에서 계속 끝날 수 있다 — 결과만 버린다.
 */

/** 기본 예산. 대부분의 도구는 이보다 훨씬 빨리 끝난다. */
export const WATCHDOG_DEFAULT_MS = 120_000;

/**
 * 흐름 실행(record_replay_flow_run) 하나가 쓸 수 있는 최대 시간.
 *
 * 2026-09-05 Codex 검토 항목 4: 워치독이 예산을 넘겨 응답을 끊어도 실제 실행은 계속 돌아
 * "좀비 run" 이 남았다. `Promise.race` 는 취소 수단이 아니기 때문이다. 그래서 흐름 쪽이
 * 자기 마감을 스스로 들고, 마감에 닿으면 abort 로 **실제 실행을 멈춘다**. 워치독은 그
 * 뒤를 받치는 마지막 안전망으로만 남는다.
 */
export const MAX_FLOW_RUN_TIMEOUT_MS = 600_000;

/** 마감에 닿아 취소된 실행을 알리는 신호. */
export class RunAbortedError extends Error {
  readonly code = 'run_aborted';

  constructor(reason: string) {
    super(`run_aborted: ${reason}`);
    this.name = 'RunAbortedError';
  }
}

export interface TimeoutAbort {
  signal: AbortSignal;
  /** 실제로 적용된 예산 (ms). 상한을 넘겨 요청하면 상한으로 깎인다. */
  timeoutMs: number;
  /** 마감이 지나 abort 됐는가. */
  timedOut(): boolean;
  /** 타이머 정리. 실행이 끝나면 반드시 부른다. */
  dispose(): void;
}

/**
 * `timeoutMs` 뒤에 abort 되는 신호를 만든다. 상한(`capMs`)을 넘겨 요청하면 상한으로 깎는다.
 *
 * `Promise.race` 와 달리 이 신호를 받는 쪽은 실행을 실제로 멈추고 정리할 수 있다.
 */
export function createTimeoutAbort(
  timeoutMs?: number,
  capMs: number = MAX_FLOW_RUN_TIMEOUT_MS,
): TimeoutAbort {
  const requested = Number(timeoutMs);
  const budget =
    Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), capMs) : capMs;
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort(new RunAbortedError(`the run exceeded its ${budget}ms budget`));
  }, budget);
  return {
    signal: controller.signal,
    timeoutMs: budget,
    timedOut: () => expired,
    dispose: () => clearTimeout(timer),
  };
}

/**
 * chrome_batch·chrome_shortcut 흐름 제어의 **절대 마감**을 넘겼다는 신호
 * (2026-09-04 Codex 최종 검토 항목 4).
 *
 * 예전에는 러너가 step 시작 시점에 "남은 ms" 를 계산해 넘겼다. 그런데 게이트 조회,
 * automation guard 지연, 탭 락 대기가 워치독 **바깥**에 있어서, 그 대기 동안 예산이
 * 이미 다 지나가도 stale 한 값으로 워치독을 걸었다. 게다가 워치독이 실제로 끊었을 때는
 * 평범한 오류 응답이라 러너가 `stoppedBy:{reason:"timeout"}` 을 못 붙였다.
 *
 * 이제 절대 시각(`deadlineAt`, epoch ms)을 파이프라인 전체에 적용하고, 만료는 이 예외로
 * 러너까지 올린다. 러너는 이걸 받으면 그 step 을 `stopped` 로 닫고 timeout 을 보고한다.
 */
export class FlowDeadlineExceededError extends Error {
  readonly code = 'flow_deadline_exceeded';
  readonly tool: string;

  constructor(tool: string, where: string) {
    super(
      `flow_deadline_exceeded: ${tool} did not finish before the chrome_batch/chrome_shortcut ` +
        `time budget ran out (${where}). Split the flow into smaller calls.`,
    );
    this.name = 'FlowDeadlineExceededError';
    this.tool = tool;
  }
}

/** 절대 마감까지 남은 시간. 마감이 없으면 undefined, 이미 지났으면 0. */
export function remainingFlowBudgetMs(deadlineAt?: number): number | undefined {
  if (typeof deadlineAt !== 'number' || !Number.isFinite(deadlineAt)) return undefined;
  return Math.max(0, deadlineAt - Date.now());
}

/**
 * 파이프라인의 각 지점(게이트 뒤·지연 뒤·락 획득 뒤·실행 직전)에서 마감을 확인한다.
 * 이미 지났으면 즉시 던진다 — 0 이하를 "상한 없음" 으로 흘려보내지 않는다.
 */
export function assertWithinFlowDeadline(
  tool: string,
  deadlineAt: number | undefined,
  where: string,
): void {
  const remaining = remainingFlowBudgetMs(deadlineAt);
  if (remaining !== undefined && remaining <= 0) {
    throw new FlowDeadlineExceededError(tool, where);
  }
}

/**
 * 호출자가 명시한 대기 시간이 기본 예산보다 크면 그쪽에 맞춰 늘린다.
 * 워치독은 "정상 동작을 끊는 장치" 가 아니라 "무한 대기를 끊는 장치" 이므로,
 * 선언된 대기 시간의 2배 + 30초로 넉넉히 잡는다.
 */
export function watchdogBudgetMs(
  name: string,
  args: any,
  overrides: Record<string, number> = {},
): number {
  const base = overrides[name] ?? WATCHDOG_DEFAULT_MS;
  const declared = [
    args?.timeoutMs,
    args?.waitTimeoutMs,
    args?.durationMs,
    args?.maxDurationMs,
    args?.maxWaitMs,
  ].filter((v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  if (declared.length === 0) return base;
  return Math.max(base, Math.max(...declared) * 2 + 30_000);
}

export function watchdogTimeoutMessage(name: string, budgetMs: number): string {
  return (
    `${name} did not finish within ${Math.round(budgetMs / 1000)}s and was abandoned so the tab would not stay blocked. ` +
    'The page may be frozen or a content script never replied. Reload the tab (chrome_navigate refresh:true) before retrying, ' +
    'or pass a larger timeoutMs if this work is genuinely slow.'
  );
}

/**
 * `fn` 을 예산 안에서 실행한다. 예산을 넘기면 `onTimeout(message)` 가 만든 값으로 즉시 끝낸다.
 *
 * 주의: 이 race 는 `fn` 을 **취소하지 못한다**. 그래서 여러 도구 호출을 이어 붙이는 긴 작업
 * (흐름 실행)은 여기에 기대면 안 된다 — 응답만 끊기고 실행은 계속 도는 좀비가 된다.
 * 그런 작업은 `createTimeoutAbort()` 로 자기 마감을 들고 abort 로 스스로 멈춘 뒤,
 * 이 워치독은 마지막 안전망으로만 쓴다.
 */
export async function runWithWatchdog<T>(
  name: string,
  args: any,
  fn: () => Promise<T>,
  onTimeout: (message: string) => T,
  overrides: Record<string, number> = {},
  /**
   * 호출자가 남긴 예산 상한 (ms). chrome_batch·chrome_shortcut 이 흐름 제어 상한(100초)의
   * 남은 시간을 step 마다 넘긴다. 예산을 늘리지는 않고 줄이기만 한다.
   */
  capMs?: number,
): Promise<T> {
  let budgetMs = watchdogBudgetMs(name, args, overrides);
  // 흐름 제어 상한은 "줄이기만" 한다. 0 이하는 이미 만료라 실행 자체를 하지 않는다
  // (예전에는 `capMs > 0` 검사에 걸려 0 이 조용히 무시됐다 — 항목 4).
  let cappedByFlow = false;
  if (typeof capMs === 'number' && Number.isFinite(capMs)) {
    if (capMs <= 0) throw new FlowDeadlineExceededError(name, 'before execute');
    if (capMs < budgetMs) {
      budgetMs = capMs;
      cappedByFlow = true;
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => {
          console.warn(`[tool-watchdog] ${name} exceeded ${budgetMs}ms — releasing the tab lock`);
          // 흐름 제어 상한이 끊은 것이면 러너가 timeout 으로 알아볼 수 있게 typed error 다.
          if (cappedByFlow) {
            reject(new FlowDeadlineExceededError(name, 'while the tool was running'));
            return;
          }
          resolve(onTimeout(watchdogTimeoutMessage(name, budgetMs)));
        }, budgetMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
