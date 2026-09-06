import type { StepWait } from '../types';
import { waitForNetworkIdle, waitForNavigation } from '../rr-utils';
import { expandTemplatesDeep } from '../rr-utils';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';
import { resolveRunTab } from '../engine/tab-context';
import { sleepWithSignal } from '@/utils/tool-watchdog';

export const waitNode: NodeRuntime<StepWait> = {
  validate: (step) => {
    const ok = !!(step as any).condition;
    return ok ? { ok } : { ok, errors: ['대기 조건이 없습니다'] };
  },
  run: async (ctx: ExecCtx, step: StepWait) => {
    const s = expandTemplatesDeep(step as StepWait, ctx.vars);
    const cond = (s as StepWait).condition as
      | { selector: string; visible?: boolean }
      | { text: string; appear?: boolean }
      | { navigation: true }
      | { networkIdle: true }
      | { sleep: number };
    if ('text' in cond) {
      const tabId = await resolveRunTab(ctx);
      const frameIds = typeof ctx.frameId === 'number' ? [ctx.frameId] : undefined;
      await chrome.scripting.executeScript({
        target: { tabId, frameIds },
        files: ['inject-scripts/wait-helper.js'],
        world: 'ISOLATED',
      } as any);
      const resp: any = (await chrome.tabs.sendMessage(
        tabId,
        {
          action: 'waitForText',
          text: cond.text,
          appear: (cond as any).appear !== false,
          timeout: Math.max(0, Math.min((s as any).timeoutMs || 10000, 120000)),
        } as any,
        { frameId: ctx.frameId } as any,
      )) as any;
      if (!resp || resp.success !== true) throw new Error('wait text failed');
    } else if ('networkIdle' in cond) {
      const total = Math.min(Math.max(1000, (s as any).timeoutMs || 5000), 120000);
      const idle = Math.min(1500, Math.max(500, Math.floor(total / 3)));
      await waitForNetworkIdle(ctx, total, idle);
    } else if ('navigation' in cond) {
      await waitForNavigation(ctx, (s as any).timeoutMs);
    } else if ('sleep' in cond) {
      const ms = Math.max(0, Number(cond.sleep ?? 0));
      // 취소를 무시하는 고정 sleep 이었다 — 60초 sleep 하나면 abort 뒤에도 60초를 더 돌았다
      // (2026-09-05 Codex 재확인 항목 3).
      await sleepWithSignal(ms, ctx.signal);
    } else if ('selector' in cond) {
      const tabId = await resolveRunTab(ctx);
      const frameIds = typeof ctx.frameId === 'number' ? [ctx.frameId] : undefined;
      await chrome.scripting.executeScript({
        target: { tabId, frameIds },
        files: ['inject-scripts/wait-helper.js'],
        world: 'ISOLATED',
      } as any);
      const resp: any = (await chrome.tabs.sendMessage(
        tabId,
        {
          action: 'waitForSelector',
          selector: (cond as any).selector,
          visible: (cond as any).visible !== false,
          timeout: Math.max(0, Math.min((s as any).timeoutMs || 10000, 120000)),
        } as any,
        { frameId: ctx.frameId } as any,
      )) as any;
      if (!resp || resp.success !== true) throw new Error('wait selector failed');
    }
    return {} as ExecResult;
  },
};
