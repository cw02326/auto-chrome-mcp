import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import { handleCallTool } from '@/entrypoints/background/tools';
import type { Step } from '../types';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';
import { runToolArgs } from '../engine/tab-context';

export const navigateNode: NodeRuntime<any> = {
  validate: (step) => {
    const ok = !!(step as any).url;
    return ok ? { ok } : { ok, errors: ['URL 이 없습니다'] };
  },
  run: async (ctx: ExecCtx, step: Step) => {
    const url = (step as any).url;
    // chrome_navigate picks its own tab when none is named; the run tab must win.
    const res = await handleCallTool({
      name: TOOL_NAMES.BROWSER.NAVIGATE,
      args: runToolArgs(ctx, { url }),
    });
    if ((res as any).isError) throw new Error('navigate failed');
    return {} as ExecResult;
  },
};
