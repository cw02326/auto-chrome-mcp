import type { ExecCtx, ExecResult, NodeRuntime } from './types';
import { getRunTabInfo } from '../engine/tab-context';

export const executeFlowNode: NodeRuntime<any> = {
  validate: (step) => {
    const s: any = step;
    const ok = typeof s.flowId === 'string' && !!s.flowId;
    return ok ? { ok } : { ok, errors: ['需提供 flowId'] };
  },
  run: async (ctx: ExecCtx, step) => {
    const s: any = step;
    const { getFlow } = await import('../flow-store');
    const flow = await getFlow(String(s.flowId));
    if (!flow) throw new Error('referenced flow not found');
    const inline = s.inline !== false; // default inline
    if (!inline) {
      const { runFlow } = await import('../flow-runner');
      // The sub-run inherits this run's pinned tab; it never resolves its own.
      await runFlow(
        flow,
        {
          tabId: ctx.tabId,
          windowId: ctx.windowId,
          source: 'explicit',
          mcpSessionId: ctx.mcpSessionId,
          lane: ctx.lane,
        },
        { args: s.args || {}, returnLogs: false },
      );
      return {} as ExecResult;
    }
    const { defaultEdgesOnly, topoOrder, mapDagNodeToStep, waitForNetworkIdle, waitForNavigation } =
      await import('../rr-utils');
    const vars = ctx.vars;
    if (s.args && typeof s.args === 'object') Object.assign(vars, s.args);

    // DAG is required - flow-store guarantees nodes/edges via normalization
    const nodes = ((flow as any).nodes || []) as any[];
    const edges = ((flow as any).edges || []) as any[];
    if (nodes.length === 0) {
      throw new Error(
        'Flow has no DAG nodes. Linear steps are no longer supported. Please migrate this flow to nodes/edges.',
      );
    }
    const defaultEdges = defaultEdgesOnly(edges as any);
    const order = topoOrder(nodes as any, defaultEdges as any);
    const stepsToRun: any[] = order.map((n) => mapDagNodeToStep(n as any));
    for (const st of stepsToRun) {
      const t0 = Date.now();
      const maxRetries = Math.max(0, (st as any).retry?.count ?? 0);
      const baseInterval = Math.max(0, (st as any).retry?.intervalMs ?? 0);
      let attempt = 0;
      const doDelay = async (i: number) => {
        const delay =
          baseInterval > 0
            ? (st as any).retry?.backoff === 'exp'
              ? baseInterval * Math.pow(2, i)
              : baseInterval
            : 0;
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      };
      while (true) {
        try {
          const beforeInfo = await (async () => {
            try {
              const info = await getRunTabInfo(ctx);
              return { url: info.url, status: info.status };
            } catch {
              return { url: '', status: '' };
            }
          })();
          const { executeStep } = await import('../nodes');
          const result = await executeStep(ctx as any, st as any);
          if ((st.type === 'click' || st.type === 'dblclick') && (st as any).after) {
            const after = (st as any).after as any;
            if (after.waitForNavigation)
              await waitForNavigation(ctx, (st as any).timeoutMs, beforeInfo.url);
            else if (after.waitForNetworkIdle)
              await waitForNetworkIdle(ctx, Math.min((st as any).timeoutMs || 5000, 120000), 1200);
          }
          if (!result?.alreadyLogged)
            ctx.logger({ stepId: st.id, status: 'success', tookMs: Date.now() - t0 } as any);
          break;
        } catch (e: any) {
          if (attempt < maxRetries) {
            ctx.logger({
              stepId: st.id,
              status: 'retrying',
              message: e?.message || String(e),
            } as any);
            await doDelay(attempt);
            attempt += 1;
            continue;
          }
          ctx.logger({
            stepId: st.id,
            status: 'failed',
            message: e?.message || String(e),
            tookMs: Date.now() - t0,
          } as any);
          throw e;
        }
      }
    }
    return {} as ExecResult;
  },
};
