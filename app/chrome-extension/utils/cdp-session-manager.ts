import { TOOL_NAMES } from 'auto-chrome-mcp-shared';

type OwnerTag = string;

interface TabSessionState {
  refCount: number;
  owners: Set<OwnerTag>;
  attachedByUs: boolean;
}

const DEBUGGER_PROTOCOL_VERSION = '1.3';
const ATTACH_CONFLICT_RETRY_DELAY_MS = 300;

class CDPSessionManager {
  private sessions = new Map<number, TabSessionState>();

  /**
   * auto-chrome-mcp fork: 탭별 attach 직렬화.
   *
   * attach 는 getTargets → (대기) → chrome.debugger.attach 순서로 await 를 두 번 건넌다.
   * 같은 탭에 attach 가 동시에 들어오면 둘 다 '아무도 안 붙어 있다' 를 보고 각자
   * chrome.debugger.attach 를 불러, 하나가 "Another debugger is already attached" 로 죽고
   * refCount 도 1 로 덮어써져 새어 나갔다. 진행 중인 attach 뒤에 줄을 세워 막는다.
   */
  private attachChains = new Map<number, Promise<unknown>>();

  constructor() {
    // auto-chrome-mcp fork: Chrome이 강제로 detach한 경우(사용자가 infobar에서 취소를 누르는 등)
    // 내부 Map에 stale 항목이 남지 않도록 정리해 다음 attach가 깨끗한 상태에서 시작되게 한다.
    chrome.debugger.onDetach.addListener((source) => {
      if (typeof source.tabId === 'number') {
        this.sessions.delete(source.tabId);
      }
    });
  }

  private getState(tabId: number): TabSessionState | undefined {
    return this.sessions.get(tabId);
  }

  private setState(tabId: number, state: TabSessionState) {
    this.sessions.set(tabId, state);
  }

  // auto-chrome-mcp fork: getTargets 조회 1회분을 담당. 다른 클라이언트가 붙어 있으면 'conflict'를 반환해
  // 호출부(attach)가 재시도 여부를 판단하게 한다.
  private async tryAttachOnce(
    tabId: number,
    owner: OwnerTag,
    priorState: TabSessionState | undefined,
  ): Promise<'adopted' | 'conflict' | 'clear'> {
    const targets = await chrome.debugger.getTargets();
    const existing = targets.find((t) => t.tabId === tabId && t.attached);
    if (!existing) return 'clear';
    if (existing.extensionId === chrome.runtime.id) {
      // Already attached by us (e.g., previous tool). Adopt and refcount.
      this.setState(tabId, {
        refCount: priorState ? priorState.refCount + 1 : 1,
        owners: new Set([...(priorState?.owners || []), owner]),
        attachedByUs: true,
      });
      return 'adopted';
    }
    return 'conflict';
  }

  async attach(tabId: number, owner: OwnerTag = 'unknown'): Promise<void> {
    const prev = this.attachChains.get(tabId) ?? Promise.resolve();
    const run = prev.then(
      () => this.attachExclusive(tabId, owner),
      () => this.attachExclusive(tabId, owner),
    );
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.attachChains.set(tabId, tail);
    void tail.then(() => {
      if (this.attachChains.get(tabId) === tail) this.attachChains.delete(tabId);
    });
    return run;
  }

  private async attachExclusive(tabId: number, owner: OwnerTag): Promise<void> {
    const state = this.getState(tabId);
    if (state && state.attachedByUs) {
      state.refCount += 1;
      state.owners.add(owner);
      return;
    }

    // Check existing attachments
    let result = await this.tryAttachOnce(tabId, owner, state);
    if (result === 'adopted') return;
    if (result === 'conflict') {
      // auto-chrome-mcp fork: DevTools를 방금 닫았거나 stale attach가 해제 중일 수 있으므로
      // 300ms 대기 후 1회만 재시도한다 (총 추가 지연은 최대 300ms로 제한).
      await new Promise((resolve) => setTimeout(resolve, ATTACH_CONFLICT_RETRY_DELAY_MS));
      result = await this.tryAttachOnce(tabId, owner, state);
      if (result === 'adopted') return;
      if (result === 'conflict') {
        // auto-chrome-mcp fork: 모델이 바로 다음 행동을 판단할 수 있도록 원인과 조치를 한 줄로 안내
        throw new Error(
          `CDP unavailable for tab ${tabId}: another debugger is attached (likely DevTools/F12 or another extension). Close DevTools for that tab and retry.`,
        );
      }
    }

    // Attach freshly
    await chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
    this.setState(tabId, { refCount: 1, owners: new Set([owner]), attachedByUs: true });
  }

  async detach(tabId: number, owner: OwnerTag = 'unknown'): Promise<void> {
    const state = this.getState(tabId);
    if (!state) return; // Nothing to do

    // Update ownership/refcount
    if (state.owners.has(owner)) state.owners.delete(owner);
    state.refCount = Math.max(0, state.refCount - 1);

    if (state.refCount > 0) {
      // Still in use by other owners
      return;
    }

    // We are the last owner
    try {
      if (state.attachedByUs) {
        await chrome.debugger.detach({ tabId });
      }
    } catch (e) {
      // auto-chrome-mcp fork: detach 실패(Chrome이 이미 세션을 끊은 경우 등)해도 refCount가 새는 걸 막기 위해
      // 아래 finally에서 반드시 Map 항목을 정리한다. best-effort로 무시.
    } finally {
      this.sessions.delete(tabId);
    }
  }

  /**
   * Convenience wrapper: ensures attach before fn, and balanced detach after.
   */
  async withSession<T>(tabId: number, owner: OwnerTag, fn: () => Promise<T>): Promise<T> {
    await this.attach(tabId, owner);
    try {
      return await fn();
    } finally {
      await this.detach(tabId, owner);
    }
  }

  /**
   * Send a CDP command. Requires that this manager has attached to the tab.
   * If not attached by us, will attempt a one-shot attach around the call.
   */
  async sendCommand<T = any>(tabId: number, method: string, params?: object): Promise<T> {
    const state = this.getState(tabId);
    if (state && state.attachedByUs) {
      return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
    }
    // Fallback: temporary session
    return await this.withSession<T>(tabId, `send:${method}`, async () => {
      return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
    });
  }
}

export const cdpSessionManager = new CDPSessionManager();
