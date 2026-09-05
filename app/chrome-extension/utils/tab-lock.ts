/**
 * 탭 단위 직렬화 (auto-chrome-mcp fork): 같은 탭을 대상으로 한 도구 호출은 순차 실행.
 * 두 세션이 같은 탭에 동시에 입력을 보내 꼬이는 것을 방지한다.
 * tabId 를 특정할 수 없는 호출은 락 없이 실행.
 *
 * navigate 의 작업 탭 재사용 판정도 여기의 busy 상태를 본다: 탭이 이미 일하는 중이면
 * 재사용하지 않고 새 탭을 만들어, 병렬 작업이 한 탭에서 직렬화되거나 서로의 페이지를
 * 덮어쓰는 것을 막는다.
 *
 * 리스(lease, 2026-09-05 Codex 검토 항목 3)
 * ------------------------------------------
 * 도구 하나짜리 호출에는 위의 한 번짜리 락으로 충분하다. 그런데 흐름 실행
 * (record_replay_flow_run)은 도구를 수십 번 부르는 하나의 작업이라, 호출과 호출 사이가
 * 비어 있으면 다른 세션이 그 틈에 같은 탭을 조작해 페이지를 바꿔 놓는다. 그래서 run 전체가
 * 탭을 쥐는 **재진입 가능한** 잠금이 필요하다.
 *
 * `withTabLease(tabId, ownerToken, fn)` 이 그것이다. 잠금 테이블(tabLockTails)은 한 번짜리
 * 락과 공유하므로, 리스를 쥔 동안 바깥의 `withTabLock(tabId, fn)` 은 리스가 끝날 때까지
 * 기다린다. 같은 토큰을 들고 온 재진입(`withTabLock(tabId, fn, { token })`)은 줄을 서지 않고
 * 즉시 실행된다.
 */

const tabLockTails = new Map<number, Promise<unknown>>();

/** 락 밖에서 "이 탭은 지금 쓰는 중" 을 표시하는 수동 마크 (navigate + 로딩 대기 구간). */
const manualBusy = new Map<number, number>();

/** 마크 해제를 놓쳐도 영구히 새 지 않도록 하는 안전 상한. */
const MANUAL_BUSY_TTL_MS = 60_000;

/** 리스 보유자 토큰. 같은 토큰으로 들어온 호출만 재진입으로 인정한다. */
export type TabLeaseToken = string;

/**
 * tabId → 그 탭에 걸린 리스 보유 토큰 **스택**.
 *
 * 예전에는 `Map<number, TabLeaseToken>` 하나였고, 리스를 풀 때 "이전 보유자" 를 되살렸다.
 * 그런데 비차단 리스 둘이 겹친 뒤 **역순으로** 끝나면(A 시작 → B 시작 → A 종료 → B 종료),
 * B 가 풀리면서 자기가 기억한 이전 보유자 A 를 되살린다. A 는 이미 끝났으므로 그 토큰은
 * 아무도 풀어 주지 않고 영영 남는다(stale owner) — 그 탭은 계속 busy 로 보이고, A 의 토큰을
 * 아는 호출만 통과하는 유령 리스가 된다 (2026-09-05 Codex 재확인 항목 1).
 *
 * 스택이면 종료 순서와 무관하다: 각자 자기 토큰 하나만 빼고, 남은 것의 마지막이 보유자다.
 */
const leaseStacks = new Map<number, TabLeaseToken[]>();

/** 리스가 완전히 풀리기를 기다리는 대기자들 (tabId → resolve 목록). */
const leaseWaiters = new Map<number, Array<() => void>>();

/** 도구 인자에 리스 토큰을 실을 때 쓰는 키 (engine 의 runToolArgs 가 넣는다). */
export const LEASE_TOKEN_ARG = '_leaseToken';

/**
 * 리스 보유 중 **토큰 없는** withTabLock 호출을 대기시킬지.
 *
 * 이제 도구 파이프라인(`entrypoints/background/tools/index.ts`)이 `args._leaseToken` 을
 * `withTabLock` 에 넘긴다. run 자신의 노드 호출은 토큰이 맞아 즉시 통과하므로 교착하지
 * 않고, 토큰 없는 바깥 호출만 리스가 풀릴 때까지 기다린다. 그래서 기본값이 true 다 —
 * 흐름 실행 중에는 다른 세션이 그 탭에 끼어들 수 없다 (2026-09-05 Codex 재확인 항목 1).
 */
export const LEASE_BLOCKS_UNTOKENED_CALLS = true;

export interface TabLockOptions {
  /**
   * 이 호출이 들고 온 리스 토큰. 그 탭의 리스 보유 토큰과 같으면 줄을 서지 않고 바로
   * 실행한다 (같은 작업의 재진입 호출이라는 뜻).
   */
  token?: TabLeaseToken;
}

export interface TabLeaseOptions {
  /**
   * 리스를 쥔 동안 토큰 없는 호출을 대기시킬지. 기본값은
   * `LEASE_BLOCKS_UNTOKENED_CALLS`.
   */
  blockUntokenedCalls?: boolean;
}

/** FIFO 큐에 붙여 순서대로 실행한다. */
function enqueue<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
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

/** 지금 이 탭의 보유 토큰 목록 (마지막이 현재 보유자). */
function stackOf(tabId: number): TabLeaseToken[] | undefined {
  return leaseStacks.get(tabId);
}

/** 리스가 완전히 풀렸음을 대기자들에게 알린다. */
function notifyLeaseReleased(tabId: number): void {
  const waiters = leaseWaiters.get(tabId);
  if (!waiters) return;
  leaseWaiters.delete(tabId);
  for (const resolve of waiters) resolve();
}

/** 이 탭의 리스가 전부 풀릴 때까지 기다린다. */
function waitForLeaseRelease(tabId: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const waiters = leaseWaiters.get(tabId);
    if (waiters) waiters.push(resolve);
    else leaseWaiters.set(tabId, [resolve]);
  });
}

/**
 * 이 탭에 리스를 하나 더 얹는다. 같은 토큰을 여러 번 얹어도 각각 한 번씩 풀어야 한다.
 *
 * 흐름이 실행 중 자기가 연 탭으로 옮겨갈 때 그 탭에도 같은 토큰의 리스를 거는 데 쓴다
 * (2026-09-05 Codex 재확인 항목 2).
 */
export function acquireTabLease(tabId: unknown, ownerToken: TabLeaseToken): void {
  if (typeof tabId !== 'number') return;
  const stack = leaseStacks.get(tabId);
  if (stack) stack.push(ownerToken);
  else leaseStacks.set(tabId, [ownerToken]);
}

/** `acquireTabLease` 로 얹은 리스를 하나 내린다. 없으면 아무 일도 하지 않는다. */
export function releaseTabLease(tabId: unknown, ownerToken: TabLeaseToken): void {
  if (typeof tabId !== 'number') return;
  const stack = leaseStacks.get(tabId);
  if (!stack) return;
  // 마지막 것부터 뺀다 — 중첩 획득의 짝을 안쪽부터 맞춘다.
  const index = stack.lastIndexOf(ownerToken);
  if (index === -1) return;
  stack.splice(index, 1);
  if (stack.length === 0) {
    leaseStacks.delete(tabId);
    notifyLeaseReleased(tabId);
  }
}

/** 이 탭에 그 토큰의 리스가 걸려 있는가. */
export function isTabLeasedBy(tabId: unknown, ownerToken: TabLeaseToken): boolean {
  if (typeof tabId !== 'number') return false;
  return stackOf(tabId)?.includes(ownerToken) === true;
}

export async function withTabLock<T>(
  tabId: unknown,
  fn: () => Promise<T>,
  options?: TabLockOptions,
): Promise<T> {
  if (typeof tabId !== 'number') return fn();
  const token = options?.token;
  for (;;) {
    const stack = stackOf(tabId);
    if (!stack || stack.length === 0) break;
    // 리스 보유자의 재진입: 자기 자신을 기다리지 않는다.
    if (token !== undefined && stack.includes(token)) return fn();
    // 차단 모드가 아니면(테스트·과도기) 예전처럼 스텝 단위 큐에만 선다.
    if (!LEASE_BLOCKS_UNTOKENED_CALLS) break;
    // 리스가 풀린 뒤 다시 확인한다 — 그 사이 다른 리스가 걸렸을 수 있다.
    await waitForLeaseRelease(tabId);
  }
  return enqueue(tabId, fn);
}

/**
 * 하나의 작업(흐름 실행)이 탭을 통째로 쥐는 재진입 리스.
 *
 * 같은 토큰으로 중첩 호출하면 그대로 실행한다(중첩 run/subflow 대비).
 */
export async function withTabLease<T>(
  tabId: unknown,
  ownerToken: TabLeaseToken,
  fn: () => Promise<T>,
  options?: TabLeaseOptions,
): Promise<T> {
  if (typeof tabId !== 'number') return fn();
  if (isTabLeasedBy(tabId, ownerToken)) return fn();

  const block = options?.blockUntokenedCalls ?? LEASE_BLOCKS_UNTOKENED_CALLS;

  const body = async (): Promise<T> => {
    acquireTabLease(tabId, ownerToken);
    try {
      return await fn();
    } finally {
      releaseTabLease(tabId, ownerToken);
    }
  };

  // 차단 모드에서는 리스가 FIFO 큐를 통째로 점유한다 → 바깥 호출이 대기한다.
  // 비차단 모드에서는 큐를 잡지 않고 보유 표시만 남긴다 → 재진입은 즉시, 바깥 호출은
  // 예전처럼 스텝 단위로 직렬화된다.
  return block ? enqueue(tabId, body) : body();
}

/** 지금 이 탭에 리스가 걸려 있는가 (테스트·진단용). */
export function hasTabLease(tabId: number): boolean {
  return (stackOf(tabId)?.length ?? 0) > 0;
}

/** 지금 이 탭의 리스 보유 토큰 (테스트·진단용). 스택의 마지막이 현재 보유자다. */
export function getTabLeaseOwner(tabId: number): TabLeaseToken | undefined {
  const stack = stackOf(tabId);
  return stack && stack.length > 0 ? stack[stack.length - 1] : undefined;
}

/** 겹치지 않는 리스 토큰을 만든다. */
export function createTabLeaseToken(prefix = 'lease'): TabLeaseToken {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 이 탭에서 지금 도구가 실행 중이거나(락 보유·리스 보유), navigate 가 점유를 선언했는가.
 * 판정은 동기여야 한다 — 확인과 점유 선언 사이에 await 가 끼면 두 호출이 같은 탭을 함께
 * 재사용해버린다.
 */
export function isTabBusy(tabId: number): boolean {
  if (tabLockTails.has(tabId)) return true;
  if (hasTabLease(tabId)) return true;
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
