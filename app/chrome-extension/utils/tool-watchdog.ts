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
 * (예산 초과여도 `fn` 을 취소하지는 못한다 — chrome 확장 API 에 취소 수단이 없다.)
 */
export async function runWithWatchdog<T>(
  name: string,
  args: any,
  fn: () => Promise<T>,
  onTimeout: (message: string) => T,
  overrides: Record<string, number> = {},
): Promise<T> {
  const budgetMs = watchdogBudgetMs(name, args, overrides);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          console.warn(`[tool-watchdog] ${name} exceeded ${budgetMs}ms — releasing the tab lock`);
          resolve(onTimeout(watchdogTimeoutMessage(name, budgetMs)));
        }, budgetMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
