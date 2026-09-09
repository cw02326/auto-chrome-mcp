import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import { handleCallTool } from '@/entrypoints/background/tools';
import type { StepOpenTab, StepSwitchTab, StepCloseTab } from '../types';
import { expandTemplatesDeep } from '../rr-utils';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';
import { createManagedWindow } from '@/utils/mcp-window-manager';
import { RunAbortedError } from '@/utils/tool-watchdog';
import {
  RunTabError,
  bindTabRef,
  isValidTabRef,
  markRunOwnedTab,
  releaseTabRef,
  resolveRunTab,
  resolveSwitchTarget,
  resolveTabRef,
  runOwnedTabIds,
  runToolArgs,
  setRunTab,
  verifyTabDocument,
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
    // 탭을 여는 사이에 취소됐으면 방금 만든 탭을 닫고 끝낸다. 끝난 시도가 뒤늦게 소유·번호를
    // 남기면 다음 단계가 그 탭에서 이어질 수 있다 (검토 D3).
    if (ctx.signal?.aborted) {
      try {
        await chrome.tabs.remove(created.id);
      } catch {
        // 이미 닫혔으면 그만이다.
      }
      throw new RunAbortedError('run_aborted: 실행이 취소되어 새 탭을 닫았어요.');
    }
    markRunOwnedTab(ctx, created.id);
    // 번호 묶기는 소유 등록 뒤에만 한다 (설계 2.1, 불변식 I1). `openTab` 은 생성이
    // 결정적이라 모호성이 없는 두 묶기 경로 중 하나다.
    if (s.tabRef !== undefined) bindTabRef(ctx, s.tabRef, created.id);
    setRunTab(ctx, created.id, created.windowId);
    return {} as ExecResult;
  },
};

export const switchTabNode: NodeRuntime<StepSwitchTab> = {
  run: async (ctx, step) => {
    const s: any = expandTemplatesDeep(step as any, ctx.vars);
    // 대상 판정은 두 실행기가 같은 함수를 쓴다 (설계 2.7). 대기는 하지 않는다: 번호는
    // 원인 단계가 끝날 때 이미 묶여 있어야 한다.
    const targetTabId = resolveSwitchTarget(ctx, s, (message) =>
      ctx.logger({ stepId: step.id, status: 'warning', message }),
    );

    // 문서 준비 검증 (설계 2.4). 이미 정해진 탭의 상태를 보는 것이지 탭을 고르는 것이
    // 아니므로 I2 를 어기지 않는다.
    //
    // **번호로 지목한 전환에만 건다.** id 로 지목하는 옛 흐름은 `about:blank` 작업 탭으로
    // 옮겨 가는 경우가 있어, 여기에 준비 검증을 걸면 예전에 되던 흐름이 실패한다 (검토 사소).
    if (isValidTabRef(s.tabRef)) {
      await verifyTabDocument(targetTabId, {
        tabRef: s.tabRef,
        urlContains: typeof s.urlContains === 'string' ? s.urlContains : undefined,
        timeoutMs: s.timeoutMs,
        signal: ctx.signal,
      });
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
    /** 닫은 뒤 회수할 논리 번호 (있을 때만). */
    let closedRef: number | undefined;

    if (s.tabRef !== undefined) {
      // 번호가 있으면 그 탭만 닫는다. 해석에 실패하면 `tab_ref_unbound` 로 멈추고, 예전의
      // "인자 없음 = 현재 탭" 폴백은 절대 타지 않는다 (설계 2.4).
      const target = resolveTabRef(ctx, s.tabRef);
      tabIds = [target];
      closedRef = s.tabRef;
    } else if (Array.isArray(s.tabIds) && s.tabIds.length) {
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
    if (closedRef !== undefined) releaseTabRef(ctx, closedRef, tabIds[0]);
    return {} as ExecResult;
  },
};
