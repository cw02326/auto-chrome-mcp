/**
 * 대상 탭 가드 (auto-chrome-mcp fork).
 *
 * 거의 모든 도구가 `tryGetTab(args.tabId) || getActiveTab...` 꼴로 대상을 정한다. 그래서
 * 탭이 닫힌 뒤 같은 tabId 로 호출하면 조용히 **사용자가 보고 있는 탭**이 대상이 됐다 —
 * 실측으로 스크린샷이 엉뚱한 탭을 찍었고, navigate(refresh:true) 였다면 사용자 페이지를
 * 새로고침했을 것이다. 백그라운드 작업 모드의 무간섭 원칙이 정확히 여기서 깨졌다.
 *
 * 25개 도구를 각자 고치는 대신 게이트에서 한 번 막는다.
 */
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { describeClosedTab } from '@/utils/work-tab-manager';

/**
 * auto-chrome-mcp fork(P1): '탭이 없다' 류 실패에 붙일 설명. 대상이 아닌 실패면 null.
 */
export function describeMissingTab(result: any, tabId: unknown): Record<string, unknown> | null {
  if (typeof tabId !== 'number') return null;
  const text = (result?.content ?? [])
    .map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
    .join(' ');
  if (!/tab not found|no tab with id|tab_not_found/i.test(text)) return null;

  const closedReason = describeClosedTab(tabId);
  return {
    event: 'target_tab_missing',
    tabId,
    reason: closedReason ?? 'the tab was closed (by the user, the page, or the browser)',
    recovery:
      'Do not retry with the same tabId. Call chrome_navigate to open a fresh work tab ' +
      '(its result carries the new tabId), or chrome_set_work_tab to point at an existing tab.',
    parallelHint: closedReason
      ? 'Running several agents at once? Give each one a distinct `lane` argument — ' +
        'lanes never touch each other’s tabs.'
      : undefined,
  };
}

/**
 * auto-chrome-mcp fork: 명시된 대상 탭이 이미 사라졌으면 도구를 돌리기 전에 끊는다.
 *
 * 거의 모든 도구가 `tryGetTab(args.tabId) || getActiveTab...` 꼴로 대상을 정한다.
 * 그래서 탭이 닫힌 뒤 같은 tabId 로 호출하면, 조용히 **사용자가 보고 있는 탭**이 대상이
 * 됐다 — 실측으로 스크린샷이 엉뚱한 탭을 찍었고, navigate(refresh:true) 였다면 사용자
 * 페이지를 새로고침했을 것이다. 무간섭 원칙이 정확히 여기서 깨졌다.
 *
 * 25개 도구를 각자 고치는 대신 게이트에서 한 번 막는다. 게이트가 주입한 작업 탭은
 * getWorkTabId 가 이미 실존을 확인했으므로, 여기서 걸리는 건 호출자가 준 죽은 tabId 뿐이다.
 */
export async function rejectIfTargetTabGone(name: string, args: any): Promise<ToolResult | null> {
  const tabId = args?.tabId;
  if (typeof tabId !== 'number') return null;
  try {
    await chrome.tabs.get(tabId);
    return null;
  } catch {
    const failure = createErrorResponse(`Tab not found: ${tabId} (requested by ${name})`);
    const hint = describeMissingTab(failure, tabId);
    if (hint && Array.isArray(failure.content)) {
      failure.content.push({ type: 'text', text: JSON.stringify(hint) });
    }
    return failure;
  }
}
