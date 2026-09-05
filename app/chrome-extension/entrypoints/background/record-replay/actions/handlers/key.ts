/**
 * Key Action Handler
 *
 * Handles keyboard input:
 * - Resolves key sequences via variables/templates
 * - Optionally focuses a target element before sending keys
 * - Dispatches keyboard events via the keyboard tool
 */

import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { handleCallTool } from '@/entrypoints/background/tools';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import { ENGINE_CONSTANTS } from '../../engine/constants';
import { waitForNavigationDone } from '../../engine/policies/wait';
import { waitForNetworkIdle } from '../../rr-utils';
import { runTabFromId } from '../../engine/tab-context';
import { failed, invalid, ok } from '../registry';
import type { ActionHandler, ElementTarget } from '../types';
import {
  actionToolArgs,
  clampInt,
  ensureElementVisible,
  logSelectorFallback,
  readTabUrl,
  resolveString,
  selectorLocator,
  sendMessageToTab,
  toSelectorTarget,
} from './common';

/** Extract error text from tool result */
function extractToolError(result: unknown, fallback: string): string {
  const content = (result as { content?: Array<{ text?: string }> })?.content;
  return content?.find((c) => typeof c?.text === 'string')?.text || fallback;
}

/** Check if target has valid selector specification */
function hasTargetSpec(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const t = target as { ref?: unknown; candidates?: unknown };
  const hasRef = typeof t.ref === 'string' && t.ref.trim().length > 0;
  const hasCandidates = Array.isArray(t.candidates) && t.candidates.length > 0;
  return hasRef || hasCandidates;
}

/** Strip frame prefix from composite selector */
function stripCompositeSelector(selector: string): string {
  const raw = String(selector || '').trim();
  if (!raw || !raw.includes('|>')) return raw;
  const parts = raw
    .split('|>')
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : raw;
}

export const keyHandler: ActionHandler<'key'> = {
  type: 'key',

  validate: (action) => {
    if (action.params.keys === undefined) {
      return invalid('Missing keys parameter');
    }

    if (action.params.target !== undefined && !hasTargetSpec(action.params.target)) {
      return invalid('Target must include a non-empty ref or selector candidates');
    }

    return ok();
  },

  describe: (action) => {
    const keys = typeof action.params.keys === 'string' ? action.params.keys : '(dynamic)';
    const display = keys.length > 30 ? keys.slice(0, 30) + '...' : keys;
    return `Keys "${display}"`;
  },

  run: async (ctx, action) => {
    const vars = ctx.vars;
    const tabId = ctx.tabId;

    if (typeof tabId !== 'number') {
      return failed('TAB_NOT_FOUND', 'No active tab found for key action');
    }

    // 2026-09-05 Codex 교차 리뷰 5: 엔터로 폼을 제출한 녹화는 이동을 일으킨다. 녹화기가
    // 그 사실을 관측했을 때만 `after.waitForNavigation` 이 붙으므로, 붙어 있으면 이동이
    // 끝날 때까지 기다린다. StepRunner 가 대기를 맡는 모드에서는 여기서 하지 않는다.
    const skipNavWait = ctx.execution?.skipNavWait === true;
    const after = action.params.after ?? {};
    const wantsAfterWait =
      !skipNavWait && (after.waitForNavigation === true || after.waitForNetworkIdle === true);
    const beforeUrl = wantsAfterWait ? await readTabUrl(tabId) : '';

    // Resolve keys string
    const keysResolved = resolveString(action.params.keys, vars);
    if (!keysResolved.ok) {
      return failed('VALIDATION_ERROR', keysResolved.error);
    }

    const keys = keysResolved.value.trim();
    if (!keys) {
      return failed('VALIDATION_ERROR', 'Keys string is empty');
    }

    let frameId = ctx.frameId;
    let selectorForTool: string | undefined;
    let firstCandidateType: string | undefined;
    let resolvedBy: string | undefined;

    // Handle optional target focusing
    const target = action.params.target as ElementTarget | undefined;
    if (target) {
      await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: actionToolArgs(ctx, {}) });

      const {
        selectorTarget,
        firstCandidateType: firstType,
        firstCssOrAttr,
      } = toSelectorTarget(target, vars);
      firstCandidateType = firstType;

      const located = await selectorLocator.locate(tabId, selectorTarget, {
        frameId: ctx.frameId,
        preferRef: false,
      });

      frameId = located?.frameId ?? ctx.frameId;
      const refToUse = located?.ref ?? selectorTarget.ref;

      if (!refToUse && !firstCssOrAttr) {
        return failed('TARGET_NOT_FOUND', 'Could not locate target element for key action');
      }

      resolvedBy = located?.resolvedBy || (located?.ref ? 'ref' : '');

      // Only verify visibility for freshly located refs (not stale refs from payload)
      if (located?.ref) {
        const visible = await ensureElementVisible(tabId, located.ref, frameId);
        if (!visible) {
          return failed('ELEMENT_NOT_VISIBLE', 'Target element is not visible');
        }

        const focusResult = await sendMessageToTab<{ success?: boolean; error?: string }>(
          tabId,
          { action: 'focusByRef', ref: located.ref },
          frameId,
        );

        if (!focusResult.ok || focusResult.value?.success !== true) {
          const focusErr = focusResult.ok ? focusResult.value?.error : focusResult.error;

          if (!firstCssOrAttr) {
            return failed(
              'TARGET_NOT_FOUND',
              `Failed to focus target element: ${focusErr || 'ref may be stale'}`,
            );
          }

          ctx.log(`focusByRef failed; falling back to selector: ${focusErr}`, 'warn');
        }

        // Try to resolve ref to CSS selector for tool
        const resolved = await sendMessageToTab<{
          success?: boolean;
          selector?: string;
          error?: string;
        }>(tabId, { action: TOOL_MESSAGE_TYPES.RESOLVE_REF, ref: located.ref }, frameId);

        if (
          resolved.ok &&
          resolved.value?.success !== false &&
          typeof resolved.value?.selector === 'string'
        ) {
          const sel = resolved.value.selector.trim();
          if (sel) selectorForTool = sel;
        }
      }

      // Fallback to CSS/attr selector
      if (!selectorForTool && firstCssOrAttr) {
        const stripped = stripCompositeSelector(firstCssOrAttr);
        if (stripped) selectorForTool = stripped;
      }
    }

    // Execute keyboard input
    const keyboardResult = await handleCallTool({
      name: TOOL_NAMES.BROWSER.KEYBOARD,
      args: actionToolArgs(ctx, {
        keys,
        selector: selectorForTool,
        selectorType: selectorForTool ? 'css' : undefined,
        tabId,
        frameId,
      }),
    });

    if ((keyboardResult as { isError?: boolean })?.isError) {
      return failed('UNKNOWN', extractToolError(keyboardResult, 'Keyboard input failed'));
    }

    // Log fallback after successful execution
    const fallbackUsed =
      resolvedBy && firstCandidateType && resolvedBy !== 'ref' && resolvedBy !== firstCandidateType;
    if (fallbackUsed) {
      logSelectorFallback(ctx, action.id, String(firstCandidateType), String(resolvedBy));
    }

    if (wantsAfterWait) {
      const waitMs = clampInt(
        action.policy?.timeout?.ms ?? ENGINE_CONSTANTS.DEFAULT_WAIT_MS,
        0,
        ENGINE_CONSTANTS.MAX_WAIT_MS,
      );
      // 대기는 이 액션이 돈 탭에만 건다 (사용자가 보고 있는 탭이 아니다).
      const runTab = runTabFromId(tabId, 'explicit', undefined, ctx);
      if (after.waitForNavigation) {
        await waitForNavigationDone(runTab, beforeUrl, waitMs);
      } else {
        const totalMs = clampInt(waitMs, 1000, ENGINE_CONSTANTS.MAX_WAIT_MS);
        const idleMs = Math.min(1500, Math.max(500, Math.floor(totalMs / 3)));
        await waitForNetworkIdle(runTab, totalMs, idleMs);
      }
    }

    return { status: 'success' };
  },
};
