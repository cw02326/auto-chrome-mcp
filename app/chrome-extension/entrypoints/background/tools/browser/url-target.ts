/**
 * auto-chrome-mcp fork — `url` 인자로 대상 탭을 고르는 도구들의 공통 조회·생성 경로.
 *
 * 배경(2026-09-04 Codex 3차 검토, 항목 1): web-fetcher · console · inject-script ·
 * network capture 는 `url` 이 오면 `chrome.tabs.query({})` / `chrome.tabs.query({ url })`
 * 로 **모든 창의 모든 탭**에서 첫 일치 탭을 골랐다. 그래서 백그라운드 작업 모드에서도
 * 사용자가 보고 있는 창의 탭이 읽히고 CDP 디버거가 붙었다.
 *
 * 규칙:
 *   - 백그라운드 작업 모드 ON 이면 후보를 **이 세션·레인이 소유한 탭**으로만 좁힌다.
 *     사용자 탭은 후보에서 아예 빠진다(fail-closed).
 *   - 모드 OFF 면 예전 동작(전체 탭 검색)을 그대로 둔다 — 게이트와 같은 방침이다.
 *   - 새 탭을 만들 때는 호출자가 지정한 windowId 를 반드시 넘기고, 만든 탭을 이 세션의
 *     소유로 등록한다(다음 URL 조회에서 이 탭이 후보가 된다).
 *   - 호출자가 windowId 를 안 줬으면 **이 세션의 작업 탭이 있는 창**에 붙인다. 안 그러면
 *     크롬이 마지막으로 포커스된 창(= 사용자가 보고 있는 창)에 탭을 만든다.
 *     작업 탭이 없으면 예전대로 크롬 기본값에 맡긴다(current 모드 규칙).
 */
import { createTab as createTabGuarded } from '@/utils/activation-guard';
import { isBackgroundModeEnabled } from '@/utils/background-mode';
import { URL_SELECTS_TARGET_TOOLS } from '@/utils/work-tab-gate';
import {
  addOwnedTab,
  getSessionScopedTabIds,
  getWorkTabId,
  sessionKeyOf,
} from '@/utils/work-tab-manager';

/** 비교용 URL 정규화 — 예전 구현과 같이 끝의 슬래시만 무시한다. */
export function normalizeUrlForMatch(url?: string | null): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

/**
 * `url` 과 일치하는 탭을 찾는다. 백그라운드 작업 모드에서는 이 세션이 소유한 탭만 본다.
 * 못 찾으면 null (호출자가 새 탭을 만든다).
 */
export async function findTabByUrlInSessionScope(
  url: string,
  args: any,
): Promise<chrome.tabs.Tab | null> {
  const target = normalizeUrlForMatch(url);
  if (target === null) return null;

  const scoped = await isBackgroundModeEnabled();
  const candidates: chrome.tabs.Tab[] = [];

  if (scoped) {
    const ids = await getSessionScopedTabIds(sessionKeyOf(args));
    for (const id of ids) {
      try {
        candidates.push(await chrome.tabs.get(id));
      } catch {
        // 이미 닫힌 탭은 건너뛴다.
      }
    }
  } else {
    candidates.push(...(await chrome.tabs.query({})));
  }

  for (const tab of candidates) {
    if (normalizeUrlForMatch(tab.url) === target) return tab;
  }
  return null;
}

/**
 * 새 탭을 붙일 창을 정한다. 호출자가 windowId 를 줬으면 그 창이다. 안 줬으면 백그라운드
 * 작업 모드에서 **이 세션의 작업 탭이 있는 창**을 쓴다 — 안 그러면 크롬이 마지막으로
 * 포커스된 창, 즉 사용자가 보고 있는 창에 탭을 만든다. 작업 탭이 없거나 모드가 꺼져 있으면
 * undefined 를 돌려 크롬 기본값(current 모드 규칙의 사용자 창)에 맡긴다.
 */
async function resolveTargetWindowId(
  explicitWindowId: number | undefined,
  args: any,
): Promise<number | undefined> {
  if (typeof explicitWindowId === 'number' && explicitWindowId > 0) return explicitWindowId;
  if (!(await isBackgroundModeEnabled())) return undefined;
  try {
    const workTabId = await getWorkTabId(sessionKeyOf(args));
    if (workTabId === null) return undefined;
    const workTab = await chrome.tabs.get(workTabId);
    return typeof workTab.windowId === 'number' && workTab.windowId > 0
      ? workTab.windowId
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * URL 조회가 빈손일 때 새 탭을 만든다. windowId 를 넘기지 않으면 크롬이 **사용자가 보고
 * 있는 창**에 탭을 붙이므로, 호출자가 지정한 창(없으면 작업 탭의 창)을 반드시 전달한다.
 */
export async function createTabForUrl(
  url: string,
  options: { background: boolean; windowId?: number; reason: string; args: any },
): Promise<chrome.tabs.Tab> {
  const createInfo: chrome.tabs.CreateProperties = {
    url,
    active: options.background ? false : true,
  };
  const windowId = await resolveTargetWindowId(options.windowId, options.args);
  if (typeof windowId === 'number') createInfo.windowId = windowId;
  const tab = await createTabGuarded(createInfo, { reason: options.reason });
  if (typeof tab.id === 'number') {
    try {
      await addOwnedTab(tab.id, sessionKeyOf(options.args));
    } catch {
      // 소유 등록 실패는 정리 시점의 문제일 뿐 이번 호출에는 영향이 없다.
    }
  }
  return tab;
}

/**
 * `url` 인자가 대상 지정인 호출에서, **이미 존재하는** 대상 탭 id 를 미리 해석한다.
 *
 * 배경(2026-09-04 Codex 최종 검토, 남은 항목): tools/index.ts 의 바깥쪽 잠금(withTabLock)
 * 과 busy·touch 추적은 `args.tabId` 로 걸린다. url 로 대상을 고르는 호출
 * (URL_SELECTS_TARGET_TOOLS)에는 게이트가 일부러 tabId 를 주입하지 않으므로, 그 호출들만
 * 잠금 없이 실행됐다. URL 이 기존 작업 탭과 같으면 tabId 를 명시한 click·navigate 와
 * fetch·inject·capture 가 같은 탭에서 동시에 돌았다.
 *
 * 그래서 도구가 쓰는 것과 **같은 조회 규칙**(findTabByUrlInSessionScope)으로 대상 탭을
 * 먼저 확인해, 그 id 로 기존 잠금 경로를 그대로 타게 한다. 규칙이 같으므로 백그라운드
 * 작업 모드에서 사용자 탭은 후보에서 빠진다 — 잠금 대상으로도 뽑히지 않는다.
 *
 * 여기서는 **탭을 만들지 않는다.** 조회가 빈손이면 도구가 새 탭을 만드는데, 그 탭은 이
 * 호출이 만들기 전까지 아무도 모르는 탭이라 동시 사용 대상이 아니다. 게이트·잠금 단계에서
 * 탭을 만들면 automation guard 가 뒤이어 호출을 막았을 때 빈 탭만 남는다.
 */
export async function resolveUrlTargetTabId(
  toolName: string,
  args: any,
): Promise<number | undefined> {
  if (!URL_SELECTS_TARGET_TOOLS.has(toolName)) return undefined;
  // tabId 를 명시했으면 도구도 그 탭을 쓰고 잠금도 이미 그 id 로 걸린다.
  if (typeof args?.tabId === 'number') return undefined;
  const url = typeof args?.url === 'string' ? args.url.trim() : '';
  if (!url) return undefined;
  try {
    const tab = await findTabByUrlInSessionScope(url, args);
    return typeof tab?.id === 'number' ? tab.id : undefined;
  } catch {
    // 조회 실패는 잠금을 포기할 사유일 뿐, 호출을 막을 사유는 아니다(예전 동작 유지).
    return undefined;
  }
}
