/**
 * 탭 단위 직렬화 (auto-chrome-mcp fork): 같은 탭을 대상으로 한 도구 호출은 순차 실행.
 * 두 세션이 같은 탭에 동시에 입력을 보내 꼬이는 것을 방지한다.
 * tabId 를 특정할 수 없는 호출은 락 없이 실행.
 *
 * navigate 의 작업 탭 재사용 판정도 여기의 busy 상태를 본다: 탭이 이미 일하는 중이면
 * 재사용하지 않고 새 탭을 만들어, 병렬 작업이 한 탭에서 직렬화되거나 서로의 페이지를
 * 덮어쓰는 것을 막는다.
 */

const tabLockTails = new Map<number, Promise<unknown>>();

/** 락 밖에서 "이 탭은 지금 쓰는 중" 을 표시하는 수동 마크 (navigate + 로딩 대기 구간). */
const manualBusy = new Map<number, number>();

/** 마크 해제를 놓쳐도 영구히 새 지 않도록 하는 안전 상한. */
const MANUAL_BUSY_TTL_MS = 60_000;

export async function withTabLock<T>(tabId: unknown, fn: () => Promise<T>): Promise<T> {
  if (typeof tabId !== 'number') return fn();
  const prev = tabLockTails.get(tabId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tabLockTails.set(tabId, tail);
  void tail.then(() => {
    if (tabLockTails.get(tabId) === tail) tabLockTails.delete(tabId);
  });
  return run;
}

/**
 * 이 탭에서 지금 도구가 실행 중이거나(락 보유), navigate 가 점유를 선언했는가.
 * 판정은 동기여야 한다 — 확인과 점유 선언 사이에 await 가 끼면 두 호출이 같은 탭을 함께
 * 재사용해버린다.
 */
export function isTabBusy(tabId: number): boolean {
  if (tabLockTails.has(tabId)) return true;
  const markedAt = manualBusy.get(tabId);
  if (markedAt === undefined) return false;
  if (Date.now() - markedAt > MANUAL_BUSY_TTL_MS) {
    manualBusy.delete(tabId);
    return false;
  }
  return true;
}

export function markTabBusy(tabId: number): void {
  manualBusy.set(tabId, Date.now());
}

export function unmarkTabBusy(tabId: number): void {
  manualBusy.delete(tabId);
}
