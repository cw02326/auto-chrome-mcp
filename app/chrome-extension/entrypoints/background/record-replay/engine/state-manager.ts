// engine/state-manager.ts — lightweight run state store with events and persistence

type Listener<T> = (payload: T) => void;

export interface RunState {
  id: string;
  flowId: string;
  name?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: number;
  updatedAt: number;
  /**
   * 왜 멈췄는가 (설계 2.6). 지금은 `worker_restarted` 하나만 쓴다.
   *
   * MV3 워커가 죽으면 `RunTabState`·기대·큐가 전부 사라진다. 그 상태에서 이어서 실행하면
   * 어느 탭이 run 의 것인지 모르는 채로 조작하게 되므로, 재개하지 않고 여기서 끝낸다.
   */
  stopReason?: string;
  /**
   * 마지막으로 실행한 단계 번호 (1부터). 사용자에게 "어디까지 갔는지" 를 보여주는 용도다.
   * 재개용이 아니다.
   */
  lastStepIndex?: number;
}

export class StateManager<T extends { id: string }> {
  private key: string;
  private states = new Map<string, T>();
  private listeners: Record<string, Listener<any>[]> = Object.create(null);

  constructor(storageKey: string) {
    this.key = storageKey;
  }

  on<E = any>(name: string, listener: Listener<E>) {
    (this.listeners[name] = this.listeners[name] || []).push(listener);
  }

  off<E = any>(name: string, listener: Listener<E>) {
    const arr = this.listeners[name];
    if (!arr) return;
    const i = arr.indexOf(listener as any);
    if (i >= 0) arr.splice(i, 1);
  }

  private emit<E = any>(name: string, payload: E) {
    const arr = this.listeners[name] || [];
    for (const fn of arr)
      try {
        fn(payload);
      } catch {}
  }

  getAll(): Map<string, T> {
    return this.states;
  }

  get(id: string): T | undefined {
    return this.states.get(id);
  }

  async add(id: string, data: T): Promise<void> {
    this.states.set(id, data);
    this.emit('add', { id, data });
    await this.persist();
  }

  async update(id: string, patch: Partial<T>): Promise<void> {
    const cur = this.states.get(id);
    if (!cur) return;
    const next = Object.assign({}, cur, patch);
    this.states.set(id, next);
    this.emit('update', { id, data: next });
    await this.persist();
  }

  async delete(id: string): Promise<void> {
    this.states.delete(id);
    this.emit('delete', { id });
    await this.persist();
  }

  private async persist(): Promise<void> {
    try {
      const obj = Object.fromEntries(this.states.entries());
      await chrome.storage.local.set({ [this.key]: obj });
    } catch (e) {
      // 저장이 실패하면 워커가 죽었을 때 중단 표시가 남지 않는다. 조용히 넘기지 말고
      // 최소한 흔적은 남긴다 (검토 사소).
      console.warn(`[state-manager] ${this.key} 저장 실패`, e);
    }
  }

  /**
   * 저장소에서 상태를 되읽는다.
   *
   * @returns 실제로 읽었으면 true. 읽지 못했으면 false 다. 예전에는 실패를 통째로 삼켜서
   *   호출자가 "빈 상태" 와 "못 읽음" 을 구분하지 못했다 (검토 D4).
   */
  async restore(): Promise<boolean> {
    try {
      const res = await chrome.storage.local.get(this.key);
      const obj = (res && res[this.key]) || {};
      this.states = new Map(Object.entries(obj) as any);
      return true;
    } catch {
      return false;
    }
  }
}

export const runState = new StateManager<RunState>('rr_run_states');

/**
 * 이 워커 인스턴스가 직접 시작한 run 들 (설계 2.6).
 *
 * 저장소에 `running` 으로 남아 있지만 여기 없는 run 은 **이전 워커의 것**이다. 워커가
 * 죽으면서 `finalize` 를 남기지 못한 것이므로 중단으로 정리한다.
 */
const liveRunIds = new Set<string>();

/** 이 워커에서 시작한 run 으로 등록한다. */
export function markRunLive(runId: string): void {
  if (runId) liveRunIds.add(runId);
}

/** run 이 끝났음을 알린다(성공·실패 무관). */
export function markRunFinished(runId: string): void {
  liveRunIds.delete(runId);
}

/** 이 워커에서 이미 한 번 정리했는가. 한 워커 수명에 한 번만 돌면 된다. */
let reaped = false;

/**
 * 워커 재시작으로 끊긴 run 을 중단 처리한다 (설계 2.6).
 *
 * 자동 재개는 하지 않는다. 열린 탭을 다시 훑어 번호를 붙이는 복구도 하지 않는다. 무엇이
 * run 의 것인지 확인할 방법이 없기 때문이다. 남은 탭은 사용자가 닫는다.
 *
 * @returns 중단으로 바꾼 run id 들.
 */
export async function reapInterruptedRuns(): Promise<string[]> {
  if (reaped) return [];
  // 저장소를 읽지 못하면 아직 아무것도 판단하지 못한 것이다. 여기서 `reaped` 를 세우면
  // 그 워커가 사는 동안 남은 run 을 영원히 놓친다 (검토 사소·D4).
  if (!(await runState.restore())) return [];
  reaped = true;
  const stopped: string[] = [];
  for (const [id, state] of runState.getAll()) {
    if (state?.status !== 'running') continue;
    if (liveRunIds.has(id)) continue;
    stopped.push(id);
  }
  for (const id of stopped) {
    try {
      await runState.update(id, {
        status: 'stopped',
        stopReason: 'worker_restarted',
        updatedAt: Date.now(),
      } as Partial<RunState>);
    } catch {
      // 정리는 best-effort 다. 실패해도 새 run 을 막지 않는다.
    }
  }
  return stopped;
}

/** 테스트 전용: 워커가 새로 뜬 것처럼 되돌린다. */
export function resetRunReaperForTest(): void {
  reaped = false;
  liveRunIds.clear();
}
