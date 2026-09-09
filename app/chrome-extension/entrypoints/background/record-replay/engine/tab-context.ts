/**
 * engine/tab-context.ts
 *
 * The single source of truth for "which tab does this flow run touch".
 *
 * Design rule (v1.11.3):
 *   The record-replay engine never looks up the tab the user happens to be
 *   viewing. Every node, policy, logger and runner works on the tab that the
 *   caller pinned when the run started. If that tab is gone, the run stops with
 *   a structured `run_tab_missing` error instead of silently falling back to the
 *   user's browsing session.
 *
 * This module is the ONE place allowed to resolve a tab from the user's window,
 * and only through `queryEntryPointTab()`, which a user-initiated entry point
 * (side panel Run button, context menu item, keyboard command) calls exactly
 * once before handing the run to the engine. The source guard test
 * `tests/record-replay/no-active-tab-query.test.ts` enforces that.
 */

import { LEASE_TOKEN_ARG, acquireTabLease, isTabLeasedBy, releaseTabLease } from '@/utils/tab-lock';
import { EFFECTIVE_BACKGROUND_MODE_ARG } from '@/utils/background-mode';
import { FLOW_DEADLINE_ARG } from '@/utils/tool-watchdog';
import { RunAbortedError } from '@/utils/tool-watchdog';

/** Where the pinned tab came from. Recorded for diagnostics only. */
export type RunTabSource = 'mcp' | 'sidepanel' | 'explicit';

/**
 * The tab a flow run is pinned to.
 *
 * `ExecCtx` extends this, so anything holding an execution context can be
 * passed straight to `resolveRunTab()`.
 */
export interface RunTabContext {
  /** Chrome tab id this run operates on. Never re-derived from the active tab. */
  tabId: number;
  /** Window that held the tab when the run started. Diagnostics only. */
  windowId?: number;
  /** How the tab was chosen. */
  source: RunTabSource;
  /**
   * MCP session this run belongs to, when it was started by a tool call.
   *
   * Every browser tool the engine drives goes back through `handleCallTool`,
   * which routes work tabs, locks and owned-tab bookkeeping per session and
   * lane. Carrying the pair here means a node's inner call is attributed to the
   * same session/lane bucket as the `record_replay_flow_run` call that started
   * the run, instead of looking like a fresh anonymous session.
   */
  mcpSessionId?: string;
  /** Parallel-agent lane of the caller, for the same reason as mcpSessionId. */
  lane?: string;
  /**
   * Execution-context background mode (2026-09-05 pre-release review, item 2).
   *
   * `true` means "this run must not touch the user's screen, whatever the global
   * toggle says". MCP `record_replay_flow_run` and automatic triggers set it: the
   * caller is not watching, so activating a tab or focusing a window would take
   * the screen away from whatever the user is doing. `runToolArgs` puts it on
   * every inner tool call, where the work-tab gate, the URL target resolver,
   * chrome_navigate's reuse filter and the activation guard all read it before
   * the global toggle.
   *
   * A side panel run (the user pressed Run and is watching) leaves it unset and
   * keeps the existing rules.
   */
  effectiveBackgroundMode?: true;
  /**
   * Absolute deadline (epoch ms) for the whole run, when the caller set one.
   *
   * Rides on every inner tool call as `_deadlineAt` so the tool pipeline caps its
   * watchdog with the run's remaining budget, and long waits (wait_for, page load,
   * scroll collection) stop at the same instant instead of running past the
   * deadline inside a call that nobody is waiting for any more
   * (2026-09-05 pre-release review, item 3).
   */
  deadlineAt?: number;
  /**
   * Owner token of the tab lease this run holds (utils/tab-lock.ts).
   *
   * Rides along on every tool call the engine makes (`_leaseToken`) so the tool
   * pipeline can tell "this is the run that already owns the tab" from "another
   * session wants the same tab" and let the former through without waiting.
   */
  leaseToken?: string;
  /**
   * Tabs this run created. Only these (plus the pinned tab itself) may be
   * closed or switched to; everything else is somebody's browsing session.
   *
   * A Set so the mutable context shared by logger/scheduler/steps sees every
   * registration, whichever layer made the tab.
   */
  ownedTabIds?: Set<number>;
  /**
   * Tab the run started on.
   *
   * Stays in scope after openTab/switchTab move the run elsewhere, so a flow can
   * come back to it. It is not in `ownedTabIds` because the run did not create
   * it: abort cleanup must not close the caller's work tab.
   */
  entryTabId?: number;
  /**
   * Tabs this run took an extra lease on, beyond the tab it started with.
   *
   * The lease used to sit only on the entry tab, so the moment a flow moved onto
   * a tab it opened, that tab had no lock at all and another session could step
   * in between two nodes (2026-09-05 Codex re-review, item 2). Every tab the run
   * moves to or opens now gets a lease under the same token, and they are all
   * released when the run ends.
   */
  leasedTabIds?: Set<number>;
  /**
   * Cancellation signal for the run.
   *
   * Lives here because every node, policy and wait loop already receives this
   * context, so the abort reaches the places that would otherwise keep looping
   * after the caller gave up (2026-09-05 Codex review, item 4).
   */
  signal?: AbortSignal;
  /**
   * 여러 탭 흐름의 공유 상태 (설계 2.1). 참조로 공유한다. 값 복사 금지.
   *
   * 실행기가 둘(nodes 경로·actions 경로)이라 파생 컨텍스트가 필드를 명시 복사한다. 이
   * 객체를 값으로 베끼면 두 실행기가 서로 다른 탭 번호표를 보게 되어, 한쪽에서 묶은
   * 번호가 다른 쪽에서는 "묶이지 않음" 이 된다.
   */
  tabState?: RunTabState;
}

/* ------------------------------------------------------------------ *
 * 여러 탭 (설계 2.1 · 2.4)
 * ------------------------------------------------------------------ */

/**
 * run 하나가 공유하는 탭 상태 (설계 2.1).
 *
 * `ownedTabIds` 는 기존 컨텍스트의 Set 을 그대로 담는다(참조 공유). 나머지는 새 값이다.
 */
export interface RunTabState {
  /** run 이 만든 것으로 확인된 탭. `RunTabContext.ownedTabIds` 와 같은 객체다. */
  ownedTabIds: Set<number>;
  /** 논리 번호 -> 실제 탭 id. 한 번 묶이면 바뀌지 않는다. */
  tabRefs: Map<number, number>;
  /** 닫힌 논리 번호. 재사용·재바인딩 금지. */
  closedRefs: Set<number>;
  /** run 진단용 키 (`run::` + runId). */
  scopeKey: string;
}

/**
 * 공통 탭 판정이 필요로 하는 최소 컨텍스트.
 *
 * `RunTabContext`(nodes 경로)와 `ActionExecutionContext`(actions 경로)가 둘 다 구조적으로
 * 이 모양을 만족한다. 두 실행기가 같은 함수를 부르게 하는 것이 목적이다 (설계 2.7).
 */
export interface RunTabScope {
  tabId: number;
  entryTabId?: number;
  ownedTabIds?: Set<number>;
  leasedTabIds?: Set<number>;
  leaseToken?: string;
  tabState?: RunTabState;
  signal?: AbortSignal;
  deadlineAt?: number;
}

/** 새 `RunTabState`. `ownedTabIds` 는 넘겨받은 Set 을 그대로 쓴다(참조 공유). */
export function createRunTabState(scopeKey: string, ownedTabIds: Set<number>): RunTabState {
  return {
    ownedTabIds,
    tabRefs: new Map<number, number>(),
    closedRefs: new Set<number>(),
    scopeKey,
  };
}

/**
 * 이 컨텍스트의 공유 상태. 없으면 만들어 붙인다.
 *
 * 정상 경로에서는 `ExecutionOrchestrator` 가 run 시작 때 한 번 만들고, 파생 컨텍스트는 그
 * 참조를 물려받는다. 여기서 새로 만드는 것은 노드를 직접 부르는 단위 테스트뿐이다.
 */
export function ensureRunTabState(scope: RunTabScope, scopeKey = ''): RunTabState {
  if (!scope.tabState) {
    if (!scope.ownedTabIds) scope.ownedTabIds = new Set<number>();
    scope.tabState = createRunTabState(scopeKey, scope.ownedTabIds);
  }
  return scope.tabState;
}

/** 논리 탭 번호로 쓸 수 있는 값인가 (0 이상의 정수). 0 은 유효하다. */
export function isValidTabRef(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * 논리 번호를 실제 탭에 묶는다.
 *
 * 묶기 전에 소유 등록이 끝나 있어야 한다. 이 순서가 I1 을 지키는 자리다: 번호가 붙는 탭은
 * 예외 없이 run 이 만든 것으로 확인된 탭이다.
 */
export function bindTabRef(scope: RunTabScope, ref: number, tabId: number): void {
  if (!isValidTabRef(ref)) {
    throw new RunTabError('tab_ref_conflict', TAB_REF_CONFLICT_MESSAGE, tabId);
  }
  const state = ensureRunTabState(scope);
  if (state.tabRefs.has(ref) || state.closedRefs.has(ref)) {
    throw new RunTabError('tab_ref_conflict', TAB_REF_CONFLICT_MESSAGE, tabId);
  }
  if (!isUsableTabId(tabId) || !isRunOwnedTab(scope, tabId)) {
    throw new RunTabError(
      'tab_ref_conflict',
      `${TAB_REF_CONFLICT_MESSAGE} (tab ${String(tabId)} is not owned by this run)`,
      tabId,
    );
  }
  state.tabRefs.set(ref, tabId);
}

/**
 * 논리 번호를 실제 탭 id 로 푼다. 대기하지 않는다.
 *
 * 묶임은 `openTab` 실행이 끝날 때 이미 확정돼 있어야 한다. 여기서
 * 기다리면 "언젠가 생기겠지" 로 후속 조작이 흘러가고, 그것이 곧 엉뚱한 탭 사고다.
 */
export function resolveTabRef(scope: RunTabScope, ref: number): number {
  if (!isValidTabRef(ref)) {
    throw new RunTabError('tab_ref_conflict', TAB_REF_CONFLICT_MESSAGE);
  }
  const state = ensureRunTabState(scope);
  const tabId = state.tabRefs.get(ref);
  if (!isUsableTabId(tabId)) {
    throw new RunTabError('tab_ref_unbound', tabRefUnboundMessage(ref));
  }
  // 소유는 해석할 때 한 번 더 본다. 묶인 뒤에 정리 경로가 소유를 걷어 갔을 수 있다.
  if (!isRunOwnedTab(scope, tabId)) {
    throw new RunTabError('tab_ref_unbound', tabRefUnboundMessage(ref), tabId);
  }
  return tabId;
}

/**
 * `switchTab` 이 갈 탭을 정한다. 두 실행기가 이 함수 하나를 쓴다.
 *
 *   - `tabRef` 가 있으면 그것만 본다(`tabId` 가 함께 있으면 무시하고 경고).
 *   - `tabRef` 가 없고 `tabId` 가 있으면 예전과 같이 소유 검사만 한다.
 *   - 둘 다 없으면 예전과 같이 `tab_scope_violation`. url·title 전역 검색은 없다 (I2).
 */
export function resolveSwitchTarget(
  scope: RunTabScope,
  input: { tabRef?: unknown; tabId?: unknown },
  onWarn?: (message: string) => void,
): number {
  const rawRef = input?.tabRef;
  if (rawRef !== undefined && rawRef !== null) {
    if (!isValidTabRef(rawRef)) {
      throw new RunTabError('tab_ref_conflict', TAB_REF_CONFLICT_MESSAGE);
    }
    if (input?.tabId !== undefined && input?.tabId !== null) {
      onWarn?.(`switchTab: tabRef ${rawRef} 이 있으므로 tabId 는 무시한다.`);
    }
    return resolveTabRef(scope, rawRef);
  }

  const rawId = input?.tabId;
  const targetTabId = typeof rawId === 'number' ? rawId : Number(rawId) || undefined;
  if (!isUsableTabId(targetTabId)) {
    throw new RunTabError(
      'tab_scope_violation',
      `switchTab needs the id of a tab this run opened; matching by urlContains/titleContains would search the whole browser. This run may only touch the tab it was given and tabs it opened itself (${scopeListing(scope)}).`,
    );
  }
  if (!isRunOwnedTab(scope, targetTabId)) {
    throw new RunTabError(
      'tab_scope_violation',
      `switchTab refused tab ${targetTabId}. This run may only touch the tab it was given and tabs it opened itself (${scopeListing(scope)}).`,
      targetTabId,
    );
  }
  return targetTabId;
}

/** 닫은 번호를 회수한다. 그 번호는 다시 쓰이지 않는다. */
export function releaseTabRef(scope: RunTabScope, ref: number, tabId: number): void {
  const state = ensureRunTabState(scope);
  if (isValidTabRef(ref)) {
    state.tabRefs.delete(ref);
    state.closedRefs.add(ref);
  }
  if (isUsableTabId(tabId)) state.ownedTabIds.delete(tabId);
}

/** 문서 준비 검증의 기본 마감. */
export const DEFAULT_TAB_READY_TIMEOUT_MS = 10_000;

/**
 * 이미 정해진 탭이 조작할 수 있는 상태인지 확인한다 (설계 2.4).
 *
 * 탭을 고르는 일이 아니라 검증이므로 I2 를 어기지 않는다. 여기서 URL 을 보고 다른 탭으로
 * 옮겨 가는 경로는 없다.
 */
export async function verifyTabDocument(
  tabId: number,
  options: { tabRef?: number; urlContains?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<void> {
  const label = isValidTabRef(options.tabRef) ? `${options.tabRef}번 탭` : `탭 ${tabId}`;
  const deadline = Date.now() + Math.max(0, options.timeoutMs ?? DEFAULT_TAB_READY_TIMEOUT_MS);
  let url = '';
  for (;;) {
    // 취소는 "검증 통과" 가 아니다. 여기서 조용히 돌아가면 취소된 run 이 다음 단계를
    // 이어서 실행한다 (검토 C6).
    if (options.signal?.aborted) {
      throw new RunAbortedError('run_aborted: 실행이 취소되어 탭 확인을 멈췄어요.');
    }
    let tab: chrome.tabs.Tab | undefined;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new RunTabError('tab_not_ready', tabNotReadyMessage(label), tabId);
    }
    url = tab?.url || '';
    const ready = tab?.status !== 'loading' && !!url && !isBlankOrInternalUrl(url);
    if (ready) break;
    if (Date.now() >= deadline) {
      throw new RunTabError('tab_not_ready', tabNotReadyMessage(label), tabId);
    }
    await sleepMs(100);
  }

  const needle = typeof options.urlContains === 'string' ? options.urlContains.trim() : '';
  if (needle && !url.includes(needle)) {
    throw new RunTabError('tab_url_mismatch', tabUrlMismatchMessage(label), tabId);
  }
}

function isBlankOrInternalUrl(url: string): boolean {
  return /^(about:|chrome:|chrome-extension:|edge:)/i.test(url);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scopeListing(scope: RunTabScope): string {
  return [...runOwnedTabIds(scope)].join(', ');
}

/* 사용자에게 그대로 보이는 문구 (설계 2.4 표). */
const TAB_REF_CONFLICT_MESSAGE = '탭 번호가 겹치거나 잘못됐어요. 이 흐름을 다시 녹화해 주세요.';
export const WORKER_RESTARTED_MESSAGE =
  '브라우저 확장이 다시 시작되어 실행을 멈췄어요. 자동으로 이어서 실행하지 않아요.';

function tabRefUnboundMessage(ref: number): string {
  return `${ref}번 탭이 아직 열리지 않았어요. 앞 단계에서 새 탭을 여는 동작이 빠졌는지 확인해 주세요.`;
}
function tabNotReadyMessage(label: string): string {
  return `${label}이 아직 준비되지 않았어요. 페이지가 다 열린 뒤 다시 실행해 주세요.`;
}
function tabUrlMismatchMessage(label: string): string {
  return `${label}에 예상과 다른 페이지가 열렸어요. 안전을 위해 여기서 멈췄어요.`;
}

/** What `acquireRunTabLease` needs: the run's token and the tabs it already leased. */
export interface RunLeaseHolder {
  leaseToken?: string;
  leasedTabIds?: Set<number>;
}

/**
 * Take a lease on one more tab under the run's own token.
 *
 * Called whenever the run moves onto a tab or opens one, so the lock follows the
 * run instead of staying behind on the tab it started with. Re-entrant calls the
 * run makes carry the same token, so they still pass straight through.
 */
export function acquireRunTabLease(holder: RunLeaseHolder, tabId: number): void {
  const token = holder.leaseToken;
  if (typeof token !== 'string' || !isUsableTabId(tabId)) return;
  if (!holder.leasedTabIds) holder.leasedTabIds = new Set<number>();
  if (holder.leasedTabIds.has(tabId)) return;
  // The entry tab is already leased by the caller's `withTabLease`; do not stack
  // a second one on it, or the release counts stop matching.
  if (isTabLeasedBy(tabId, token)) return;
  acquireTabLease(tabId, token);
  holder.leasedTabIds.add(tabId);
}

/** Release every extra lease this run took. The entry tab's lease is the caller's. */
export function releaseRunTabLeases(holder: RunLeaseHolder): void {
  const token = holder.leaseToken;
  if (typeof token !== 'string' || !holder.leasedTabIds) return;
  for (const tabId of holder.leasedTabIds) releaseTabLease(tabId, token);
  holder.leasedTabIds.clear();
}

/**
 * Tabs the run may close or switch to: what it created, the tab it is on now,
 * and the tab it started on.
 */
export function runOwnedTabIds(ctx: RunTabScope): Set<number> {
  const owned = new Set<number>(ctx.ownedTabIds ?? []);
  if (isUsableTabId(ctx.tabId)) owned.add(ctx.tabId);
  if (isUsableTabId(ctx.entryTabId)) owned.add(ctx.entryTabId);
  return owned;
}

/** Remember that this run created the tab, so it is allowed to drive and close it. */
export function markRunOwnedTab(ctx: RunTabScope, tabId: number): void {
  if (!isUsableTabId(tabId)) return;
  if (!ctx.ownedTabIds) ctx.ownedTabIds = new Set<number>();
  ctx.ownedTabIds.add(tabId);
  // A tab the run opened is a tab the run drives — it needs the same lease.
  acquireRunTabLease(ctx, tabId);
}

/** Is this tab inside the run's scope? */
export function isRunOwnedTab(ctx: RunTabScope, tabId: number): boolean {
  return runOwnedTabIds(ctx).has(tabId);
}

/** True once the caller asked for the run to stop. */
export function isRunAborted(ctx: Pick<RunTabContext, 'signal'> | null | undefined): boolean {
  return ctx?.signal?.aborted === true;
}

/**
 * Structured error codes surfaced to callers and run logs.
 *
 * `close_scope_violation` / `tab_scope_violation` mark a step that tried to
 * reach a tab outside the run: closing or switching to a tab the run neither
 * received nor created (2026-09-05 Codex review, items 1 and 5).
 */
export type RunTabErrorCode =
  | 'run_tab_missing'
  | 'run_tab_required'
  | 'close_scope_violation'
  | 'tab_scope_violation'
  // 여러 탭 (설계 2.4). 번호가 가리키는 탭이 확실하지 않으면 멈춘다.
  | 'tab_ref_unbound'
  | 'tab_ref_conflict'
  | 'tab_not_ready'
  | 'tab_url_mismatch'
  | 'worker_restarted';

/**
 * Error thrown when the run tab cannot be used.
 *
 * The message is prefixed with the code so it reads clearly in run logs, which
 * store plain strings.
 */
export class RunTabError extends Error {
  readonly code: RunTabErrorCode;
  readonly tabId?: number;

  constructor(code: RunTabErrorCode, message: string, tabId?: number) {
    super(`${code}: ${message}`);
    this.name = 'RunTabError';
    this.code = code;
    this.tabId = tabId;
  }
}

export function isRunTabError(e: unknown): e is RunTabError {
  return e instanceof RunTabError;
}

function isUsableTabId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Return the pinned tab id after confirming the tab still exists.
 *
 * There is deliberately no active-tab fallback. A caller that has no tab must
 * fail rather than borrow one.
 *
 * @throws RunTabError('run_tab_required') when no tab was pinned.
 * @throws RunTabError('run_tab_missing') when the pinned tab has been closed.
 */
export async function resolveRunTab(ctx: RunTabContext | null | undefined): Promise<number> {
  const tabId = ctx?.tabId;
  if (!isUsableTabId(tabId)) {
    throw new RunTabError(
      'run_tab_required',
      'This run has no work tab. Pass an explicit tabId; the engine never falls back to the tab you are viewing.',
    );
  }

  let tab: chrome.tabs.Tab | undefined;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (e) {
    throw new RunTabError(
      'run_tab_missing',
      `Work tab ${tabId} is no longer open (${e instanceof Error ? e.message : String(e)}).`,
      tabId,
    );
  }
  if (!tab || !isUsableTabId(tab.id)) {
    throw new RunTabError('run_tab_missing', `Work tab ${tabId} is no longer open.`, tabId);
  }
  return tab.id;
}

/**
 * Move the run onto a different tab.
 *
 * The only sanctioned way for the pinned tab to change mid-run: a step that
 * opens a tab or switches tabs calls this, so the change is explicit and
 * traceable instead of being inferred from whatever became active.
 */
export function setRunTab(ctx: RunTabContext, tabId: number, windowId?: number): void {
  if (!isUsableTabId(tabId)) return;
  // The lease follows the run onto the new tab (2026-09-05 Codex re-review, item 2).
  acquireRunTabLease(ctx, tabId);
  ctx.tabId = tabId;
  if (isUsableTabId(windowId)) ctx.windowId = windowId;
  // A frame index only means something inside one document. Carrying it over to
  // another tab would aim the next step at a frame that does not exist there.
  (ctx as { frameId?: number }).frameId = undefined;
}

/** Snapshot of the run tab, used by policies and loggers that need the URL. */
export interface RunTabInfo {
  tabId: number;
  url: string;
  status: string;
  windowId?: number;
}

/**
 * Read url/status of the pinned tab.
 *
 * Replaces the old pattern of querying the active tab just to learn "where are
 * we right now".
 */
export async function getRunTabInfo(ctx: RunTabContext): Promise<RunTabInfo> {
  const tabId = await resolveRunTab(ctx);
  const tab = await chrome.tabs.get(tabId);
  return {
    tabId,
    url: tab?.url || '',
    status: (tab?.status as string) || '',
    windowId: tab?.windowId,
  };
}

/** Same as getRunTabInfo but never throws; used on best-effort paths. */
export async function tryGetRunTabInfo(ctx: RunTabContext): Promise<RunTabInfo | null> {
  try {
    return await getRunTabInfo(ctx);
  } catch {
    return null;
  }
}

/**
 * Resolve the tab a user-initiated launch should act on.
 *
 * THE ONLY sanctioned active-tab lookup in record-replay/. It is legitimate
 * here because the user just pressed Run in the side panel (or picked a context
 * menu item) while looking at the page they want automated. The result is
 * pinned once and the engine never asks again.
 */
export async function queryEntryPointTab(
  source: RunTabSource = 'sidepanel',
): Promise<RunTabContext> {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs?.[0];
  if (!tab || !isUsableTabId(tab.id)) {
    throw new RunTabError(
      'run_tab_required',
      'No tab to run against. Open a page first, or start the flow with an explicit tabId.',
    );
  }
  return { tabId: tab.id, windowId: tab.windowId, source };
}

/**
 * Identity and lifetime a derived run context must keep: which session/lane the
 * work is attributed to, which tab lease it re-enters, which tabs it owns and
 * the signal that stops it.
 */
export interface RunSessionContext {
  mcpSessionId?: string;
  lane?: string;
  /** See `RunTabContext.effectiveBackgroundMode`. */
  effectiveBackgroundMode?: true;
  /** See `RunTabContext.deadlineAt`. */
  deadlineAt?: number;
  leaseToken?: string;
  ownedTabIds?: Set<number>;
  /**
   * Tab the run started on.
   *
   * Stays in scope after openTab/switchTab move the run elsewhere, so a flow can
   * come back to it. It is not in `ownedTabIds` because the run did not create
   * it: abort cleanup must not close the caller's work tab.
   */
  entryTabId?: number;
  /** Extra tab leases this run holds (shared by reference, like `ownedTabIds`). */
  leasedTabIds?: Set<number>;
  signal?: AbortSignal;
  /** 여러 탭 공유 상태. `ownedTabIds` 와 같은 이유로 참조로 물려준다 (설계 2.7). */
  tabState?: RunTabState;
}

/** Build a pinned context from a tab id the caller already knows. */
export function runTabFromId(
  tabId: number,
  source: RunTabSource,
  windowId?: number,
  session?: RunSessionContext,
): RunTabContext {
  if (!isUsableTabId(tabId)) {
    throw new RunTabError('run_tab_required', `Invalid work tab id: ${String(tabId)}`);
  }
  return {
    tabId,
    windowId: isUsableTabId(windowId) ? windowId : undefined,
    source,
    mcpSessionId: typeof session?.mcpSessionId === 'string' ? session.mcpSessionId : undefined,
    lane: typeof session?.lane === 'string' ? session.lane : undefined,
    effectiveBackgroundMode: session?.effectiveBackgroundMode === true ? true : undefined,
    deadlineAt: typeof session?.deadlineAt === 'number' ? session.deadlineAt : undefined,
    leaseToken: typeof session?.leaseToken === 'string' ? session.leaseToken : undefined,
    // The owned-tab set is shared by reference on purpose: a tab opened through
    // a derived context still belongs to the run that opened it.
    ownedTabIds: session?.ownedTabIds,
    entryTabId: session?.entryTabId,
    leasedTabIds: session?.leasedTabIds,
    signal: session?.signal,
    // 참조 공유. 빠뜨리면 actions 경로가 빈 번호표를 보게 되어 같은 흐름이 실행기에 따라
    // 다르게 판정된다 (설계 지적 6).
    tabState: session?.tabState,
  };
}

/**
 * Build the args for a browser tool call made on behalf of a run.
 *
 * Stage 2 rule: **every** `handleCallTool` the engine makes carries the run's
 * pinned tab id. Without it the work-tab gate injects whichever tab it thinks
 * the session owns (or refuses with `no_work_tab`), so a flow could be started
 * against tab 99 and then have its click land somewhere else entirely. The
 * session/lane pair rides along so locks and owned-tab bookkeeping stay in the
 * caller's bucket.
 *
 * An explicit `tabId` in `args` wins: a step that deliberately addresses another
 * tab (switchTab) says so, and that is not the run tab being second-guessed.
 */
export function runToolArgs<T extends Record<string, any>>(
  ctx: RunTabContext,
  args?: T,
): T & { tabId: number } {
  const out: Record<string, any> = { ...(args ?? {}) };
  if (!isUsableTabId(out.tabId)) out.tabId = ctx.tabId;
  if (typeof ctx.mcpSessionId === 'string' && out._mcpSessionId === undefined) {
    out._mcpSessionId = ctx.mcpSessionId;
  }
  if (typeof ctx.lane === 'string' && out.lane === undefined) out.lane = ctx.lane;
  // Execution-context background mode: an MCP or trigger run never borrows the
  // user's screen, whatever the global toggle says (pre-release review, item 2).
  // The caller cannot set this from a step: `handleCallTool` strips the key from
  // incoming args and only the engine puts it back here.
  if (ctx.effectiveBackgroundMode === true) out[EFFECTIVE_BACKGROUND_MODE_ARG] = true;
  // The run's deadline, so the tool pipeline caps its watchdog and long waits
  // stop with the run instead of after it (pre-release review, item 3).
  if (typeof ctx.deadlineAt === 'number' && Number.isFinite(ctx.deadlineAt)) {
    out[FLOW_DEADLINE_ARG] = ctx.deadlineAt;
  }
  // Lease token: says "the run that already owns this tab is calling", so the
  // tool pipeline can let the call re-enter instead of queueing it behind the
  // lease the same run is holding.
  if (typeof ctx.leaseToken === 'string' && out[LEASE_TOKEN_ARG] === undefined) {
    out[LEASE_TOKEN_ARG] = ctx.leaseToken;
  }
  return out as T & { tabId: number };
}
