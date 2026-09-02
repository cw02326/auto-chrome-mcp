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

import { WATCHDOG_DEFAULT_MS, runWithWatchdog, watchdogBudgetMs } from '@/utils/tool-watchdog';
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
