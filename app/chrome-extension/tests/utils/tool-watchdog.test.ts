/**
 * auto-chrome-mcp fork — 도구 워치독 회귀 테스트.
 *
 * 재현하려는 실패: content script 가 sendResponse 를 영영 안 부르면 도구 호출이 끝나지
 * 않고, 탭 단위 직렬화 때문에 같은 탭의 이후 호출이 전부 그 뒤에 줄을 서서 영구 대기했다.
 * (증상: "그 탭만 통째로 먹통 — 재시작 말고는 방법이 없다")
 *
 * 여기서 못박는 계약:
 *   - 예산을 넘기면 워치독이 끼어들어 호출이 끝난다 (탭 락이 풀린다)
 *   - 예산 안에 끝나면 워치독은 아무것도 안 한다
 *   - 호출자가 명시한 대기 시간이 기본 예산보다 크면 예산이 그만큼 늘어난다 (정상 동작 보호)
 *   - 도구별 override 가 기본 예산을 이긴다
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FLOW_DEADLINE_ARG,
  FlowDeadlineExceededError,
  WATCHDOG_DEFAULT_MS,
  assertWithinFlowDeadline,
  earlierDeadline,
  flowDeadlineOf,
  remainingFlowBudgetMs,
  runWithWatchdog,
  waitBudgetMs,
  watchdogBudgetMs,
} from '@/utils/tool-watchdog';
import { withTabLock } from '@/utils/tab-lock';

describe('watchdogBudgetMs', () => {
  it('기본 예산을 쓴다', () => {
    expect(watchdogBudgetMs('chrome_click_element', {})).toBe(WATCHDOG_DEFAULT_MS);
    expect(watchdogBudgetMs('chrome_click_element', undefined)).toBe(WATCHDOG_DEFAULT_MS);
  });

  it('도구별 override 가 기본 예산을 이긴다', () => {
    const budget = watchdogBudgetMs(
      'chrome_request_user_consent',
      {},
      {
        chrome_request_user_consent: 11 * 60_000,
      },
    );
    expect(budget).toBe(11 * 60_000);
  });

  it('호출자가 선언한 대기 시간이 길면 예산이 따라 늘어난다', () => {
    // 정상 동작을 워치독이 끊으면 안 된다 — 선언값의 2배 + 30초.
    const budget = watchdogBudgetMs('chrome_wait_for', { timeoutMs: 300_000 });
    expect(budget).toBe(300_000 * 2 + 30_000);
  });

  it('선언값이 기본 예산보다 짧으면 기본 예산을 유지한다', () => {
    expect(watchdogBudgetMs('chrome_wait_for', { timeoutMs: 1_000 })).toBe(WATCHDOG_DEFAULT_MS);
  });

  it('쓰레기 값은 무시한다', () => {
    expect(watchdogBudgetMs('x', { timeoutMs: 'nope' })).toBe(WATCHDOG_DEFAULT_MS);
    expect(watchdogBudgetMs('x', { timeoutMs: Number.NaN })).toBe(WATCHDOG_DEFAULT_MS);
    expect(watchdogBudgetMs('x', { timeoutMs: -5 })).toBe(WATCHDOG_DEFAULT_MS);
  });
});

describe('runWithWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('예산 안에 끝나면 그대로 통과시킨다', async () => {
    const promise = runWithWatchdog(
      'chrome_click_element',
      {},
      async () => 'done',
      () => 'timeout',
    );
    await expect(promise).resolves.toBe('done');
  });

  it('예산을 넘기면 끼어들어 호출을 끝낸다', async () => {
    const never = new Promise<string>(() => {});
    const promise = runWithWatchdog(
      'chrome_click_element',
      {},
      () => never,
      (message) => message,
      { chrome_click_element: 1_000 },
    );
    await vi.advanceTimersByTimeAsync(1_001);
    const result = await promise;
    expect(result).toContain('did not finish within 1s');
    expect(result).toContain('chrome_navigate refresh:true');
  });

  it('영원히 안 끝나는 도구가 탭 락을 영구 점유하지 못한다 (핵심 회귀)', async () => {
    const order: string[] = [];
    const stuck = withTabLock(7, () =>
      runWithWatchdog(
        'chrome_click_element',
        {},
        () => new Promise<string>(() => {}),
        (message) => {
          order.push('stuck-abandoned');
          return message;
        },
        { chrome_click_element: 1_000 },
      ),
    );
    const queued = withTabLock(7, async () => {
      order.push('queued-ran');
      return 'ok';
    });

    await vi.advanceTimersByTimeAsync(1_001);
    await stuck;
    await expect(queued).resolves.toBe('ok');
    // 워치독이 먼저 락을 풀어야 뒤 호출이 돈다.
    expect(order).toEqual(['stuck-abandoned', 'queued-ran']);
  });
});

describe('runWithWatchdog capMs (batch 흐름 제어 deadline)', () => {
  it('capMs 는 예산을 줄이고, 끊을 때는 FlowDeadlineExceededError 다', async () => {
    vi.useFakeTimers();
    try {
      const never = () => new Promise<string>(() => {});
      const race = runWithWatchdog('chrome_screenshot', {}, never, () => 'timed out', {}, 1_000);
      const settled = race.catch((error) => error);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await settled).toBeInstanceOf(FlowDeadlineExceededError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('capMs 가 0 이하면 도구를 아예 실행하지 않는다 (항목 4)', async () => {
    // 예전에는 `capMs > 0` 검사에 걸려 0 이 "상한 없음" 으로 무시됐고, 예산이 다 된
    // 뒤에도 도구가 최대 120초짜리 워치독으로 새로 돌기 시작했다.
    let started = false;
    await expect(
      runWithWatchdog(
        'chrome_screenshot',
        {},
        async () => {
          started = true;
          return 'ran';
        },
        () => 'timed out',
        {},
        0,
      ),
    ).rejects.toBeInstanceOf(FlowDeadlineExceededError);
    expect(started).toBe(false);
  });

  it('capMs 가 없으면 기본 예산으로 돌고 워치독 문구를 그대로 쓴다', async () => {
    vi.useFakeTimers();
    try {
      const never = () => new Promise<string>(() => {});
      const plain = runWithWatchdog('chrome_screenshot', {}, never, (message) => message);
      await vi.advanceTimersByTimeAsync(WATCHDOG_DEFAULT_MS + 1);
      expect(await plain).toContain('did not finish within');
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * 항목 4: 절대 마감(deadlineAt)은 게이트·지연·락 대기까지 포함한 파이프라인 전 구간에
 * 적용돼야 한다. 상대값(남은 ms)은 락 대기 동안 낡아서, 예산이 끝난 뒤에도 도구가 새로
 * 돌기 시작했다.
 */
describe('절대 마감 (deadlineAt)', () => {
  it('remainingFlowBudgetMs 는 마감이 없으면 undefined, 지났으면 0 이다', () => {
    expect(remainingFlowBudgetMs(undefined)).toBeUndefined();
    expect(remainingFlowBudgetMs(Number.NaN)).toBeUndefined();
    expect(remainingFlowBudgetMs(Date.now() - 1_000)).toBe(0);
    expect(remainingFlowBudgetMs(Date.now() + 5_000)).toBeGreaterThan(4_000);
  });

  it('마감이 지나면 assertWithinFlowDeadline 이 즉시 던진다', () => {
    expect(() =>
      assertWithinFlowDeadline('chrome_click_element', Date.now() - 1, 'before the gate'),
    ).toThrow(FlowDeadlineExceededError);
    expect(() =>
      assertWithinFlowDeadline('chrome_click_element', Date.now() + 10_000, 'before the gate'),
    ).not.toThrow();
    expect(() =>
      assertWithinFlowDeadline('chrome_click_element', undefined, 'before the gate'),
    ).not.toThrow();
  });

  it('탭 락을 기다리는 동안 마감이 끝나면 도구를 실행하지 않는다 (핵심 회귀)', async () => {
    vi.useFakeTimers();
    try {
      const deadlineAt = Date.now() + 1_000;
      let secondToolRan = false;

      // 앞 호출이 락을 2초 동안 잡는다 - 뒤 호출의 1초 예산은 대기 중에 끝난다.
      const holder = withTabLock(42, async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
        return 'first';
      });

      // index.ts 의 실행 구조와 같은 순서: 락 획득 -> 마감 확인 -> 워치독.
      // 예산 계산이 락 **앞**에서 일어나도(예전 구조) 절대 마감이면 결과가 같아야 한다.
      const staleBudget = remainingFlowBudgetMs(deadlineAt);
      expect(staleBudget).toBe(1_000);

      const queued = withTabLock(42, () => {
        assertWithinFlowDeadline(
          'chrome_click_element',
          deadlineAt,
          'after acquiring the tab lock',
        );
        return runWithWatchdog(
          'chrome_click_element',
          {},
          async () => {
            secondToolRan = true;
            return 'second';
          },
          (message) => message,
          {},
          remainingFlowBudgetMs(deadlineAt),
        );
      });
      const settled = queued.catch((error) => error);

      // 마감 확인 없이 워치독 상한만 걸어도 fail-closed 여야 한다 (예전엔 0 이 무시됐다).
      let capOnlyRan = false;
      const capOnly = withTabLock(42, () =>
        runWithWatchdog(
          'chrome_click_element',
          {},
          async () => {
            capOnlyRan = true;
            return 'third';
          },
          (message) => message,
          {},
          remainingFlowBudgetMs(deadlineAt),
        ),
      ).catch((error) => error);

      await vi.advanceTimersByTimeAsync(2_100);
      await holder;

      expect(await settled).toBeInstanceOf(FlowDeadlineExceededError);
      expect(secondToolRan).toBe(false);
      expect(await capOnly).toBeInstanceOf(FlowDeadlineExceededError);
      expect(capOnlyRan).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * 2026-09-05 발행 전 검토 3: 흐름 실행은 마감을 args 에 실어 보낸다(노드가
 * `handleCallTool({name, args})` 를 직접 부르므로 ToolCallParam 자리가 없다).
 * 긴 대기를 가진 도구는 이 값을 대기 상한으로 쓴다.
 */
describe('args 에 실린 흐름 마감 (_deadlineAt)', () => {
  it('flowDeadlineOf 는 own 속성의 유한한 숫자만 읽는다', () => {
    expect(flowDeadlineOf({ [FLOW_DEADLINE_ARG]: 1_700_000_000_000 })).toBe(1_700_000_000_000);
    expect(flowDeadlineOf({})).toBeUndefined();
    expect(flowDeadlineOf({ [FLOW_DEADLINE_ARG]: 'soon' })).toBeUndefined();
    expect(flowDeadlineOf({ [FLOW_DEADLINE_ARG]: Number.NaN })).toBeUndefined();
    expect(flowDeadlineOf(null)).toBeUndefined();
    // 상속된 값은 게이트 우회 경로였다 - own 이 아니면 읽지 않는다.
    const inherited = Object.create({ [FLOW_DEADLINE_ARG]: 123 });
    expect(flowDeadlineOf(inherited)).toBeUndefined();
  });

  it('earlierDeadline 은 둘 중 이른 쪽을 고른다', () => {
    expect(earlierDeadline(100, 200)).toBe(100);
    expect(earlierDeadline(300, 200)).toBe(200);
    expect(earlierDeadline(undefined, 200)).toBe(200);
    expect(earlierDeadline(100, undefined)).toBe(100);
    expect(earlierDeadline(undefined, undefined)).toBeUndefined();
  });

  it('waitBudgetMs 는 요청한 대기를 남은 마감 안으로 자른다', () => {
    const now = Date.now();
    // 마감이 없으면 요청값 그대로.
    expect(waitBudgetMs({}, 10_000)).toBe(10_000);
    // 남은 시간이 요청보다 짧으면 남은 시간까지만 기다린다.
    const capped = waitBudgetMs({ [FLOW_DEADLINE_ARG]: now + 500 }, 10_000);
    expect(capped).toBeGreaterThan(0);
    expect(capped).toBeLessThanOrEqual(500);
    // 남은 시간이 더 길면 요청값을 늘리지 않는다.
    expect(waitBudgetMs({ [FLOW_DEADLINE_ARG]: now + 60_000 }, 1_000)).toBe(1_000);
    // 이미 지난 마감은 0 - 호출부는 기다리지 않고 바로 돌아온다.
    expect(waitBudgetMs({ [FLOW_DEADLINE_ARG]: now - 1 }, 10_000)).toBe(0);
  });
});
