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
}

/** Structured error codes surfaced to callers and run logs. */
export type RunTabErrorCode = 'run_tab_missing' | 'run_tab_required';

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
  ctx.tabId = tabId;
  if (isUsableTabId(windowId)) ctx.windowId = windowId;
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

/** Session/lane identity of the caller that started a run. */
export interface RunSessionContext {
  mcpSessionId?: string;
  lane?: string;
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
  return out as T & { tabId: number };
}
