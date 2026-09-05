import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import { handleCallTool } from '@/entrypoints/background/tools';
import type { StepOpenTab, StepSwitchTab, StepCloseTab } from '../types';
import { expandTemplatesDeep } from '../rr-utils';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';
import { createManagedWindow } from '@/utils/mcp-window-manager';
import {
  RunTabError,
  isRunOwnedTab,
  markRunOwnedTab,
  resolveRunTab,
  runOwnedTabIds,
  runToolArgs,
  setRunTab,
} from '../engine/tab-context';

/**
 * Tab nodes (2026-09-05 Codex 검토 항목 1·5).
 *
 * 규칙 셋:
 *   - run 은 자기 탭과 **자기가 만든 탭** 밖으로 나가지 않는다. url·title 로 브라우저
 *     전체를 뒤져 탭을 고르는 경로는 없앴다 (사용자 탭이 걸리면 그 탭을 조작하게 된다).
 *   - 새 탭은 run 이 있는 창에 **백그라운드로** 만든다. 재생 중 사용자의 화면을 빼앗지
 *     않는다.
 *   - 탭이 바뀌면 반드시 setRunTab() 으로 재고정한다. 그래야 logger·정리·응답까지
 *     같은 탭을 본다.
 */

/** run 소유가 아닌 탭을 건드리려 할 때 쓰는 공통 에러. */
function scopeViolation(
  code: 'close_scope_violation' | 'tab_scope_violation',
  what: string,
  ctx: ExecCtx,
): RunTabError {
  const owned = [...runOwnedTabIds(ctx)].join(', ');
  return new RunTabError(
    code,
    `${what} This run may only touch the tab it was given and tabs it opened itself (${owned}).`,
  );
}

export const openTabNode: NodeRuntime<StepOpenTab> = {
  run: async (ctx, step) => {
    const s: any = expandTemplatesDeep(step as any, ctx.vars);
    const url = typeof s.url === 'string' && s.url.trim() ? s.url : 'about:blank';
    let created: chrome.tabs.Tab | undefined;
    if (s.newWindow) {
      // 창 생성은 mcp-window-manager 한곳에서만 (배치·비포커스·복귀 규칙). 재생은 포커스를
      // 가져가지 않으므로 focused 는 항상 false 다.
      const win = await createManagedWindow({ url, focused: false });
      created = win?.tabs?.[0];
    } else {
      // tab-create-ok: the run opens its own work tab. It is created in the run's
      // window, in the background, and registered as run-owned, so nothing here
      // reaches a tab the user is using.
      created = await chrome.tabs.create({
        url,
        active: false,
        ...(typeof ctx.windowId === 'number' ? { windowId: ctx.windowId } : {}),
      });
    }
    if (typeof created?.id !== 'number') throw new Error('openTab: could not open a tab');
    markRunOwnedTab(ctx, created.id);
    setRunTab(ctx, created.id, created.windowId);
    return {} as ExecResult;
  },
};

export const switchTabNode: NodeRuntime<StepSwitchTab> = {
  run: async (ctx, step) => {
    const s: any = expandTemplatesDeep(step as any, ctx.vars);
    const targetTabId: number | undefined =
      typeof s.tabId === 'number' ? s.tabId : Number(s.tabId) || undefined;

    if (!targetTabId) {
      // url/title 검색은 브라우저 전체를 뒤지는 일이라 격리를 깬다. run 이 만든 탭은
      // id 를 알고 있으므로 그 id 로 지목한다.
      throw scopeViolation(
        'tab_scope_violation',
        'switchTab needs the id of a tab this run opened; matching by urlContains/titleContains would search the whole browser.',
        ctx,
      );
    }
    if (!isRunOwnedTab(ctx, targetTabId)) {
      throw scopeViolation('tab_scope_violation', `switchTab refused tab ${targetTabId}.`, ctx);
    }

    // 탭이 아직 살아 있는지 확인만 하고, 활성화(포커스 이동)는 하지 않는다.
    const tab = await chrome.tabs.get(targetTabId);
    setRunTab(ctx, targetTabId, tab?.windowId);
    return {} as ExecResult;
  },
};

export const closeTabNode: NodeRuntime<StepCloseTab> = {
  run: async (ctx, step) => {
    const s: any = expandTemplatesDeep(step as any, ctx.vars);
    const owned = runOwnedTabIds(ctx);
    let tabIds: number[];

    if (Array.isArray(s.tabIds) && s.tabIds.length) {
      tabIds = s.tabIds
        .map((id: unknown) => Number(id))
        .filter((id: number) => Number.isFinite(id));
      const outside = tabIds.filter((id) => !owned.has(id));
      if (outside.length) {
        throw scopeViolation(
          'close_scope_violation',
          `closeTab refused tab(s) ${outside.join(', ')}.`,
          ctx,
        );
      }
    } else if (s.url) {
      // url 로 닫을 때도 후보는 run 소유 탭뿐이다. 전체 탭을 훑지 않는다.
      const pattern = String(s.url).toLowerCase();
      const matched: number[] = [];
      for (const id of owned) {
        try {
          const tab = await chrome.tabs.get(id);
          if ((tab?.url || '').toLowerCase().includes(pattern)) matched.push(id);
        } catch {
          // 이미 닫힌 탭은 후보가 아니다.
        }
      }
      if (!matched.length) {
        throw scopeViolation(
          'close_scope_violation',
          `closeTab found no run-owned tab whose url contains "${s.url}".`,
          ctx,
        );
      }
      tabIds = matched;
    } else {
      // 인자가 없으면 run 탭을 닫는다. CloseTabsTool 은 tabIds 배열만 읽으므로 singular
      // tabId 를 보내면 무시돼 활성 탭이 닫혔다 (검토 항목 1).
      tabIds = [await resolveRunTab(ctx)];
    }

    const res = await handleCallTool({
      name: TOOL_NAMES.BROWSER.CLOSE_TABS,
      args: runToolArgs(ctx, { tabIds }),
    });
    if ((res as any).isError) throw new Error('closeTab failed');
    return {} as ExecResult;
  },
};
