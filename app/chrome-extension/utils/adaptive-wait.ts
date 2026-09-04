/**
 * auto-chrome-mcp fork: 고정 대기(sleep) 대신 "조건이 충족되면 즉시 반환, 원래의 고정 시간은
 * 상한으로만 남기는" 공용 대기 유틸.
 *
 * 배경: 도구 여러 곳에 `await sleep(2000)` / `sleep(700)` / `sleep(150)` 같은 고정 대기가 있었다.
 * 대부분은 "무언가가 끝나기를" 기다리는 것이라(콘솔 메시지 플러시, 지연 로딩, 헬퍼 준비, 첫 프레임)
 * 그 신호를 직접 보면 대개 상한보다 훨씬 빨리 끝난다. 신호가 없거나 관측이 실패하면 예전과 똑같이
 * 상한까지 기다리므로 결과 품질은 그대로다.
 *
 * 시간은 전부 주입 가능한 `now()` 로 읽고 대기는 setTimeout 만 쓴다 (테스트에서 fake timers 사용).
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export interface WaitUntilOptions<T> {
  /** 상태를 한 번 읽는다. 던지면 "아직 아님"으로 보고 다음 폴링에서 다시 시도한다. */
  probe: () => T | Promise<T>;
  /** 읽은 상태가 종료 조건을 만족하는가 */
  done: (value: T) => boolean;
  /** 상한 (예전의 고정 대기 시간) */
  timeoutMs: number;
  pollMs?: number;
  /** t=0 에 먼저 한 번 확인할지 (기본 true) */
  immediate?: boolean;
  now?: () => number;
}

export interface WaitUntilResult<T> {
  satisfied: boolean;
  waitedMs: number;
  last?: T;
  error?: string;
}

/**
 * 조건이 만족되면 즉시, 아니면 상한까지 폴링한다.
 * probe 가 던진 오류는 실패가 아니라 "아직 아님"으로 취급한다(내비게이션 중 주입 실패 등).
 */
export async function waitUntil<T>(options: WaitUntilOptions<T>): Promise<WaitUntilResult<T>> {
  const { probe, done, timeoutMs, pollMs = 50, immediate = true, now = () => Date.now() } = options;
  const startedAt = now();
  let last: T | undefined;
  let lastError: string | undefined;
  let first = true;

  for (;;) {
    if (immediate || !first) {
      try {
        const value = await probe();
        last = value;
        lastError = undefined;
        if (done(value)) return { satisfied: true, waitedMs: now() - startedAt, last };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    first = false;

    const elapsed = now() - startedAt;
    if (elapsed >= timeoutMs) {
      return { satisfied: false, waitedMs: elapsed, last, error: lastError };
    }
    await sleep(Math.min(pollMs, timeoutMs - elapsed));
  }
}

// ===== 1) content script 준비 대기 =====

/** 예전 상수(SCREENSHOT_CONSTANTS.SCRIPT_INIT_DELAY)와 같은 값 — 이제는 상한으로만 쓴다. */
export const HELPER_READY_MAX_WAIT_MS = 100;
const HELPER_READY_POLL_MS = 10;

/**
 * 방금 주입한 헬퍼가 메시지를 받을 준비가 됐는지 ping 으로 확인한다.
 * pong 이 오면 즉시 반환하고, 끝내 응답이 없으면 상한까지만 기다린다.
 */
export async function waitForHelperReady(options: {
  ping: () => Promise<unknown>;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
}): Promise<{ ready: boolean; waitedMs: number }> {
  const result = await waitUntil<unknown>({
    probe: options.ping,
    done: (response) => (response as { status?: string } | null)?.status === 'pong',
    timeoutMs: options.timeoutMs ?? HELPER_READY_MAX_WAIT_MS,
    pollMs: options.pollMs ?? HELPER_READY_POLL_MS,
    now: options.now,
  });
  return { ready: result.satisfied, waitedMs: result.waitedMs };
}

// ===== 2) 첫 프레임(페인트) 대기 =====

/**
 * 활성화 직후 최소로 기다리는 시간(예전 고정 대기와 같은 값).
 * rAF 두 번은 "한 번 그렸다"만 보장하고 합성이 끝났다는 뜻은 아니라서, 이 하한을 함께 둔다.
 */
export const FRAME_PAINT_MIN_WAIT_MS = 150;
/** rAF 를 확인할 수 없는 탭(최소화된 창, 주입 불가 문서)에서 기다리는 상한 */
export const FRAME_PAINT_MAX_WAIT_MS = 300;

/** 페이지 컨텍스트에서 실행: 두 프레임이 그려질 때까지 기다린다. 외부 스코프 참조 금지. */
function awaitTwoAnimationFrames(): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      resolve(true);
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
  });
}

type ExecuteScriptFn = (injection: {
  target: { tabId: number };
  func: () => Promise<boolean>;
}) => Promise<unknown>;

/**
 * 탭이 실제로 한 프레임을 그렸는지 확인한다(rAF 두 번).
 *
 * 페인트가 확인돼도 minWaitMs 는 채운다 — 활성화 직후에는 rAF 한 번이 지난 중간 프레임이
 * 캡처될 수 있어서, 예전 고정 대기(150ms)를 하한으로 남긴다.
 * 최소화된 창·비활성 탭처럼 rAF 가 아예 돌지 않거나 주입이 불가능한 문서(chrome:// 등)에서는
 * maxWaitMs 까지 기다린다.
 */
export async function waitForFramePaint(
  tabId: number,
  options: {
    minWaitMs?: number;
    maxWaitMs?: number;
    executeScript?: ExecuteScriptFn;
    now?: () => number;
  } = {},
): Promise<{ painted: boolean; waitedMs: number }> {
  const now = options.now ?? (() => Date.now());
  const maxWaitMs = Math.max(0, options.maxWaitMs ?? FRAME_PAINT_MAX_WAIT_MS);
  const minWaitMs = Math.min(Math.max(0, options.minWaitMs ?? FRAME_PAINT_MIN_WAIT_MS), maxWaitMs);
  const executeScript: ExecuteScriptFn =
    options.executeScript ??
    ((injection) => chrome.scripting.executeScript(injection as never) as Promise<unknown>);
  const startedAt = now();

  let capTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race<'painted' | 'cap' | 'unavailable'>([
      executeScript({ target: { tabId }, func: awaitTwoAnimationFrames }).then(
        () => 'painted' as const,
        () => 'unavailable' as const,
      ),
      new Promise<'cap'>((resolve) => {
        capTimer = setTimeout(() => resolve('cap'), maxWaitMs);
      }),
    ]);

    // 페인트를 확인했으면 하한까지만, 확인하지 못했으면 상한까지 기다린다.
    const floor = outcome === 'painted' ? minWaitMs : maxWaitMs;
    const remaining = floor - (now() - startedAt);
    if (remaining > 0) await sleep(remaining);

    return { painted: outcome === 'painted', waitedMs: now() - startedAt };
  } finally {
    if (capTimer !== undefined) clearTimeout(capTimer);
  }
}

// ===== 3) 스크롤 후 지연 로딩 안정화 대기 =====

/** 샘플 간격. 붙는 중인 콘텐츠를 "멈춘 것"으로 오인하지 않을 만큼은 벌린다. */
export const SCROLL_SETTLE_POLL_MS = 150;
/** 같은 수치가 연속 몇 번 나와야 "멈췄다"고 볼지 */
export const SCROLL_SETTLE_STABLE_SAMPLES = 3;

export interface ContentSample {
  height: number;
  nodes: number;
  /**
   * 진행 중인 네트워크 요청이 없다고 확인됐는가.
   * undefined = 신호를 얻지 못함 → 안정으로 판정하지 않고 상한까지 기다린다.
   */
  networkQuiet?: boolean;
}

/**
 * 스크롤 직후 새 콘텐츠가 붙고 멈출 때까지 기다린다.
 *
 * 안정 조건 세 가지를 **모두** 만족해야 상한보다 일찍 끝난다.
 *  (a) **지금 읽은 샘플이** 스크롤 전보다 크다
 *  (b) 연속 stableSamples 회(각 pollMs) 같은 수치가 나왔다
 *  (c) 진행 중인 네트워크 요청이 없다
 * 스피너 하나가 붙고 두 샘플이 같기만 해도 "안정"으로 보면, 응답이 도착하기 전에 다음 스크롤로
 * 넘어가 지연 로딩 콘텐츠를 놓친다. 신호를 못 얻으면 예전과 똑같이 상한(=delayMs)까지 기다린다.
 *
 * (a) 는 **현재 샘플**로 판정한다. "한 번이라도 자랐다"를 기억해 두고 쓰면, 스피너가 붙었다가
 * 사라져 문서가 스크롤 전 크기로 되돌아온 뒤에도 그 기억 때문에 조기 종료한다(새 콘텐츠는
 * 아직 한 줄도 안 붙었는데 다음 스크롤로 넘어간다). 반환값의 `grew` 는 "대기 중 한 번이라도
 * 자랐는가"라는 보고용 값이라 종료 판정과 별개로 유지한다.
 */
export async function waitForContentSettle(options: {
  probe: () => Promise<ContentSample | null>;
  baseline: ContentSample;
  maxWaitMs: number;
  pollMs?: number;
  stableSamples?: number;
  now?: () => number;
}): Promise<{
  reason: 'settled' | 'cap';
  waitedMs: number;
  grew: boolean;
  last: ContentSample | null;
}> {
  const stableSamples = Math.max(2, options.stableSamples ?? SCROLL_SETTLE_STABLE_SAMPLES);
  let grew = false;
  let previous: ContentSample | null = null;
  let sameStreak = 0;
  let last: ContentSample | null = null;

  const result = await waitUntil<ContentSample | null>({
    probe: options.probe,
    done: (sample) => {
      if (!sample) {
        previous = null;
        sameStreak = 0;
        return false;
      }
      last = sample;
      const grewNow =
        sample.height > options.baseline.height || sample.nodes > options.baseline.nodes;
      if (grewNow) grew = true;
      if (previous && previous.height === sample.height && previous.nodes === sample.nodes) {
        sameStreak++;
      } else {
        sameStreak = 1;
      }
      previous = sample;
      return grewNow && sameStreak >= stableSamples && sample.networkQuiet === true;
    },
    timeoutMs: options.maxWaitMs,
    pollMs: options.pollMs ?? SCROLL_SETTLE_POLL_MS,
    immediate: false,
    now: options.now,
  });

  return {
    reason: result.satisfied ? 'settled' : 'cap',
    waitedMs: result.waitedMs,
    grew,
    last,
  };
}
