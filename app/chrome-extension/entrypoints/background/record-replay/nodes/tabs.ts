import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import { handleCallTool } from '@/entrypoints/background/tools';
import type { StepOpenTab, StepSwitchTab, StepCloseTab } from '../types';
import { expandTemplatesDeep } from '../rr-utils';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';
// auto-chrome-mcp fork: 새 윈도우 생성 시 focused 값도 강제 포커스 정책을 따름
// v1.9.0: 창 생성·탭 활성화는 mcp-window-manager / activation-guard 를 통해서만 한다.
import { createTab as createTabGuarded, isForceFocusEnabled } from '@/utils/activation-guard';
import { createManagedWindow } from '@/utils/mcp-window-manager';

export const openTabNode: NodeRuntime<StepOpenTab> = {
  run: async (ctx, step) => {
    const s: any = expandTemplatesDeep(step as any, ctx.vars);
    if (s.newWindow)
      await createManagedWindow({
        url: s.url || undefined,
        focused: await isForceFocusEnabled(),
      });
    else
      await createTabGuarded(
        { url: s.url || undefined, active: true },
        { reason: 'flow:openTabNode' },
      );
    return {} as ExecResult;
  },
};

export const switchTabNode: NodeRuntime<StepSwitchTab> = {
  run: async (ctx, step) => {
    const s: any = expandTemplatesDeep(step as any, ctx.vars);
    let targetTabId: number | undefined = s.tabId;
    if (!targetTabId) {
      const tabs = await chrome.tabs.query({});
      const hit = tabs.find(
        (t) =>
          (s.urlContains && (t.url || '').includes(String(s.urlContains))) ||
          (s.titleContains && (t.title || '').includes(String(s.titleContains))),
      );
      targetTabId = (hit && hit.id) as number | undefined;
    }
    if (!targetTabId) throw new Error('switchTab: no matching tab');
    const res = await handleCallTool({
      name: TOOL_NAMES.BROWSER.SWITCH_TAB,
      args: { tabId: targetTabId },
    });
    if ((res as any).isError) throw new Error('switchTab failed');
    return {} as ExecResult;
  },
};

export const closeTabNode: NodeRuntime<StepCloseTab> = {
  run: async (ctx, step) => {
    const s: any = expandTemplatesDeep(step as any, ctx.vars);
    const args: any = {};
    if (Array.isArray(s.tabIds) && s.tabIds.length) args.tabIds = s.tabIds;
    if (s.url) args.url = s.url;
    const res = await handleCallTool({ name: TOOL_NAMES.BROWSER.CLOSE_TABS, args });
    if ((res as any).isError) throw new Error('closeTab failed');
    return {} as ExecResult;
  },
};
