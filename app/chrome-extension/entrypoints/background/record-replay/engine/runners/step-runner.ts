/**
 * step-runner.ts
 *
 * Encapsulates execution of a single step with policies (retry, navigation wait) and plugins.
 * Uses dependency-injected StepExecutorInterface for actual step execution, enabling
 * seamless switching between legacy and ActionRegistry execution modes.
 */

import type { Flow, Step, StepClick } from '../../types';
import { STEP_TYPES } from 'auto-chrome-mcp-shared';
import type { ExecCtx, ExecResult } from '../../nodes';
import { RunLogger } from '../logging/run-logger';
import { withRetry } from '../policies/retry';
import {
  waitForNavigationDone,
  maybeQuickWaitForNav,
  ensureReadPageIfWeb,
  waitForNetworkIdle,
} from '../policies/wait';
import { ENGINE_CONSTANTS } from '../constants';
import { AfterScriptQueue } from './after-script-queue';
import { PluginManager } from '../plugins/manager';
import type { HookControl } from '../plugins/types';
import type { StepExecutorInterface } from './step-executor';
import { getRunTabInfo as readRunTabInfo, resolveRunTab } from '../tab-context';

// Narrow error-like value used for overlay reporting
interface ErrorLike {
  message?: string;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && 'message' in e) return String((e as any).message);
  return String(e);
}

/**
 * Environment dependencies for StepRunner.
 * Injected by Scheduler to allow flexible configuration and testing.
 */
export interface StepRunEnv {
  /** Unique identifier for this run */
  runId: string;
  /** The flow being executed */
  flow: Flow;
  /** Runtime variables */
  vars: Record<string, any>;
  /** Run logger for recording execution events */
  logger: RunLogger;
  /** Plugin manager for hooks (beforeStep, afterStep, onRetry, onError) */
  pluginManager: PluginManager;
  /** Queue for deferred after-scripts */
  afterScripts: AfterScriptQueue;
  /** Returns remaining time budget from global deadline (ms), Infinity if no deadline */
  getRemainingBudgetMs: () => number;
  /**
   * Step executor for actual step execution.
   * Defaults to LegacyStepExecutor if not provided (for backwards compatibility).
   * In future, Scheduler will inject ActionsStepExecutor or HybridStepExecutor.
   */
  stepExecutor: StepExecutorInterface;
}

export class StepRunner {
  constructor(private env: StepRunEnv) {}

  /**
   * Snapshot the run's pinned tab before a step, so navigation waits can tell
   * whether the URL changed. Reads that tab directly instead of asking which
   * tab is active.
   */
  private async getRunTabInfo(ctx: ExecCtx): Promise<{ url: string; status: string | '' }> {
    try {
      const info = await readRunTabInfo(ctx);
      return { url: info.url, status: info.status };
    } catch {
      return { url: '', status: '' };
    }
  }

  async run(
    ctx: ExecCtx,
    step: Step,
    appendOverlayOk: (s: Step) => Promise<void> | void,
    appendOverlayFail: (s: Step, e: ErrorLike) => Promise<void> | void,
  ): Promise<{
    status: 'success' | 'failed' | 'paused';
    nextLabel?: string;
    control?: ExecResult['control'];
  }> {
    const t0 = Date.now();
    let stepNextLabel: string | undefined;
    let controlOut: ExecResult['control'] | undefined = undefined;
    let ctrlStart: HookControl | undefined;
    try {
      ctrlStart = await this.env.pluginManager.beforeStep({
        runId: this.env.runId,
        flow: this.env.flow,
        vars: this.env.vars,
        step,
      });
    } catch (e: unknown) {
      this.env.logger.push({
        stepId: step.id,
        status: 'warning',
        message: `plugin.beforeStep error: ${errorMessage(e)}`,
      });
    }
    if (ctrlStart?.pause) return { status: 'paused' };

    const beforeInfo = await this.getRunTabInfo(ctx);
    try {
      await withRetry(
        async () => {
          // Execute step via injected executor (legacy, actions, or hybrid).
          // The tab comes from the run context and is verified to still exist.
          // There is no active-tab fallback: a run without a live work tab
          // fails with run_tab_missing rather than touching the user's tab.
          const tabId = await resolveRunTab(ctx);

          const execResult = await this.env.stepExecutor.execute(ctx, step, {
            tabId,
            runId: this.env.runId,
            pushLog: (entry) => this.env.logger.push(entry as any),
            remainingBudgetMs: this.env.getRemainingBudgetMs(),
          });
          const result = execResult.result;
          const remainingBudget = this.env.getRemainingBudgetMs();
          // 클릭류와 key 단계의 이동 대기.
          //
          // key 를 넣은 이유 (2026-09-05 Codex 교차 리뷰 5): 엔터로 폼을 제출한 녹화는
          // 이동을 일으키고, 녹화기가 그 사실을 `after.waitForNavigation` 으로 남긴다.
          // 예전에는 click/dblclick 만 이 값을 읽어서 그 표시가 아무 일도 하지 않았고,
          // 다음 단계가 이전 문서에서 대상을 찾다 실패했다.
          //
          // 다만 **표시가 없는 key 는 예전 그대로** 아무 대기도 하지 않는다. 짧은 정찰 대기
          // (maybeQuickWaitForNav)는 클릭 전용이다 - 모든 키 입력마다 350ms 를 더 쓰는 것은
          // 이 수정의 목적이 아니다.
          const isClickLike = step.type === STEP_TYPES.CLICK || step.type === STEP_TYPES.DBLCLICK;
          const isKeyStep = step.type === STEP_TYPES.KEY;
          if (isClickLike || isKeyStep) {
            const after = step.after ?? ({} as NonNullable<StepClick['after']>);
            if (after.waitForNavigation)
              await waitForNavigationDone(
                ctx,
                beforeInfo.url,
                Math.min(step.timeoutMs ?? ENGINE_CONSTANTS.DEFAULT_WAIT_MS, remainingBudget),
              );
            else if (after.waitForNetworkIdle) {
              const totalMs = Math.min(
                step.timeoutMs ?? ENGINE_CONSTANTS.DEFAULT_WAIT_MS,
                remainingBudget,
              );
              const idleMs = Math.min(1500, Math.max(500, Math.floor(totalMs / 3)));
              await waitForNetworkIdle(ctx, totalMs, idleMs);
            } else if (isClickLike)
              await maybeQuickWaitForNav(
                ctx,
                beforeInfo.url,
                Math.min(step.timeoutMs ?? ENGINE_CONSTANTS.DEFAULT_WAIT_MS, remainingBudget),
              );
          }
          if (step.type === STEP_TYPES.NAVIGATE || step.type === STEP_TYPES.OPEN_TAB) {
            await waitForNavigationDone(
              ctx,
              beforeInfo.url,
              Math.min(
                step.timeoutMs ?? ENGINE_CONSTANTS.DEFAULT_WAIT_MS,
                this.env.getRemainingBudgetMs(),
              ),
            );
            await ensureReadPageIfWeb(ctx);
          } else if (step.type === STEP_TYPES.SWITCH_TAB) {
            await ensureReadPageIfWeb(ctx);
          }
          if (!result?.alreadyLogged)
            this.env.logger.push({ stepId: step.id, status: 'success', tookMs: Date.now() - t0 });
          try {
            await this.env.pluginManager.afterStep({
              runId: this.env.runId,
              flow: this.env.flow,
              vars: this.env.vars,
              step,
              result,
            });
          } catch (e: unknown) {
            this.env.logger.push({
              stepId: step.id,
              status: 'warning',
              message: `plugin.afterStep error: ${errorMessage(e)}`,
            });
          }
          await appendOverlayOk(step);
          if (result?.nextLabel) stepNextLabel = String(result.nextLabel);
          if (result?.control) controlOut = result.control;
          if (result?.deferAfterScript) this.env.afterScripts.enqueue(result.deferAfterScript);
          await this.env.afterScripts.flush(ctx, this.env.vars);
        },
        async (attempt, e) => {
          this.env.logger.push({
            stepId: step.id,
            status: 'retrying',
            message: errorMessage(e),
          });
          try {
            await this.env.pluginManager.onRetry({
              runId: this.env.runId,
              flow: this.env.flow,
              vars: this.env.vars,
              step,
              error: e,
              attempt,
            });
          } catch (pe: unknown) {
            this.env.logger.push({
              stepId: step.id,
              status: 'warning',
              message: `plugin.onRetry error: ${errorMessage(pe)}`,
            });
          }
        },
        {
          count: Math.max(0, step.retry?.count ?? 0),
          intervalMs: Math.max(0, step.retry?.intervalMs ?? 0),
          backoff: step.retry?.backoff || 'none',
          // 재시도 백오프도 취소를 본다 (2026-09-05 Codex 재확인 항목 3).
          signal: ctx.signal,
        },
      );
    } catch (e: unknown) {
      this.env.logger.push({
        stepId: step.id,
        status: 'failed',
        message: errorMessage(e),
        tookMs: Date.now() - t0,
      });
      await appendOverlayFail(step, e as ErrorLike);
      try {
        const hook = await this.env.pluginManager.onError({
          runId: this.env.runId,
          flow: this.env.flow,
          vars: this.env.vars,
          step,
          error: e,
        });
        if (hook?.pause) return { status: 'paused' };
      } catch (pe: unknown) {
        this.env.logger.push({
          stepId: step.id,
          status: 'warning',
          message: `plugin.onError error: ${errorMessage(pe)}`,
        });
      }
      return { status: 'failed' };
    }
    return { status: 'success', nextLabel: stepNextLabel, control: controlOut };
  }
}
