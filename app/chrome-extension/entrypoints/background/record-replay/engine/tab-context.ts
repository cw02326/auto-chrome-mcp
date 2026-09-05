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
export function runOwnedTabIds(ctx: RunTabContext): Set<number> {
  const owned = new Set<number>(ctx.ownedTabIds ?? []);
  if (isUsableTabId(ctx.tabId)) owned.add(ctx.tabId);
  if (isUsableTabId(ctx.entryTabId)) owned.add(ctx.entryTabId);
  return owned;
}

/** Remember that this run created the tab, so it is allowed to drive and close it. */
export function markRunOwnedTab(ctx: RunTabContext, tabId: number): void {
  if (!isUsableTabId(tabId)) return;
  if (!ctx.ownedTabIds) ctx.ownedTabIds = new Set<number>();
  ctx.ownedTabIds.add(tabId);
  // A tab the run opened is a tab the run drives — it needs the same lease.
  acquireRunTabLease(ctx, tabId);
}

/** Is this tab inside the run's scope? */
export function isRunOwnedTab(ctx: RunTabContext, tabId: number): boolean {
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
  | 'tab_scope_violation';

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
    leaseToken: typeof session?.leaseToken === 'string' ? session.leaseToken : undefined,
    // The owned-tab set is shared by reference on purpose: a tab opened through
    // a derived context still belongs to the run that opened it.
    ownedTabIds: session?.ownedTabIds,
    entryTabId: session?.entryTabId,
    leasedTabIds: session?.leasedTabIds,
    signal: session?.signal,
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
  // Lease token: says "the run that already owns this tab is calling", so the
  // tool pipeline can let the call re-enter instead of queueing it behind the
  // lease the same run is holding.
  if (typeof ctx.leaseToken === 'string' && out[LEASE_TOKEN_ARG] === undefined) {
    out[LEASE_TOKEN_ARG] = ctx.leaseToken;
  }
  return out as T & { tabId: number };
}
