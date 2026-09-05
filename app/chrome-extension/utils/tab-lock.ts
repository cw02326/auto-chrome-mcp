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

/** tabId → 지금 리스를 쥔 토큰. */
const leaseOwners = new Map<number, TabLeaseToken>();

/** 도구 인자에 리스 토큰을 실을 때 쓰는 키 (engine 의 runToolArgs 가 넣는다). */
export const LEASE_TOKEN_ARG = '_leaseToken';

/**
 * 리스 보유 중 **토큰 없는** withTabLock 호출을 대기시킬지.
 *
 * 현재 도구 파이프라인(`entrypoints/background/tools/index.ts`)은 `args._leaseToken` 을
 * `withTabLock` 에 넘기지 않는다. 그 상태에서 대기를 켜면 run 자신의 노드 호출이 자기
 * 리스에 막혀 교착한다. 그래서 기본값은 false 다 — 리스는 "재진입 즉시 통과 + busy 표시"
 * 로만 동작하고, 바깥 호출 차단은 파이프라인이 토큰을 넘기기 시작하면 켠다.
 *
 * 켜는 법: tools/index.ts 가 `withTabLock(lockTabId, fn, { token: args[LEASE_TOKEN_ARG] })`
 * 로 바뀐 뒤 이 값을 true 로 바꾼다.
 */
export const LEASE_BLOCKS_UNTOKENED_CALLS = false;

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

export async function withTabLock<T>(
  tabId: unknown,
  fn: () => Promise<T>,
  options?: TabLockOptions,
): Promise<T> {
  if (typeof tabId !== 'number') return fn();
  // 리스 보유자의 재진입: 자기 자신을 기다리지 않는다.
  const token = options?.token;
  if (token !== undefined && leaseOwners.get(tabId) === token) return fn();
  // 리스가 걸려 있고 차단 모드가 아니면(= 토큰 전달이 아직 없는 과도기) 평소대로 줄을 선다.
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
  if (leaseOwners.get(tabId) === ownerToken) return fn();

  const block = options?.blockUntokenedCalls ?? LEASE_BLOCKS_UNTOKENED_CALLS;

  const body = async (): Promise<T> => {
    const previous = leaseOwners.get(tabId);
    leaseOwners.set(tabId, ownerToken);
    try {
      return await fn();
    } finally {
      if (leaseOwners.get(tabId) === ownerToken) {
        if (previous === undefined) leaseOwners.delete(tabId);
        else leaseOwners.set(tabId, previous);
      }
    }
  };

  // 차단 모드에서는 리스가 FIFO 큐를 통째로 점유한다 → 바깥 호출이 대기한다.
  // 비차단 모드에서는 큐를 잡지 않고 보유 표시만 남긴다 → 재진입은 즉시, 바깥 호출은
  // 예전처럼 스텝 단위로 직렬화된다.
  return block ? enqueue(tabId, body) : body();
}

/** 지금 이 탭에 리스가 걸려 있는가 (테스트·진단용). */
export function hasTabLease(tabId: number): boolean {
  return leaseOwners.has(tabId);
}

/** 지금 이 탭의 리스 보유 토큰 (테스트·진단용). */
export function getTabLeaseOwner(tabId: number): TabLeaseToken | undefined {
  return leaseOwners.get(tabId);
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
  if (leaseOwners.has(tabId)) return true;
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
