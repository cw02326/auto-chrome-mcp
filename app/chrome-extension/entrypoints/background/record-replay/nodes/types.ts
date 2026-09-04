import type { RunLogEntry, Step, StepScript } from '../types';
import type { RunTabContext } from '../engine/tab-context';

/**
 * Execution context for step execution.
 * Contains runtime state that may change during flow execution.
 *
 * Extends RunTabContext, so `tabId` is required: every step runs against the
 * tab the run was pinned to. Nodes must read `ctx.tabId` (or call
 * `resolveRunTab(ctx)` when they need the tab verified as still open) and must
 * never query the tab the user is currently viewing. Only `setRunTab()` may
 * move the run onto another tab.
 */
export interface ExecCtx extends RunTabContext {
  /** Runtime variables accessible to steps */
  vars: Record<string, any>;
  /** Logger function for recording execution events */
  logger: (e: RunLogEntry) => void;
  /**
   * Current frame ID within the tab.
   * Used for iframe targeting, 0 for main frame.
   */
  frameId?: number;
}

export interface ExecResult {
  alreadyLogged?: boolean;
  deferAfterScript?: StepScript | null;
  nextLabel?: string;
  control?:
    | { kind: 'foreach'; listVar: string; itemVar: string; subflowId: string; concurrency?: number }
    | { kind: 'while'; condition: any; subflowId: string; maxIterations: number };
}

export interface NodeRuntime<S extends Step = Step> {
  validate?: (step: S) => { ok: boolean; errors?: string[] };
  run: (ctx: ExecCtx, step: S) => Promise<ExecResult | void>;
}
