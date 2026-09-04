/**
 * MCP tab group (auto-chrome-mcp fork) — MCP 작업 탭을 탭 그룹 "MCP" 로 묶는다.
 *
 * 무간섭 모드에서는 MCP 작업 탭이 사용자 창에 백그라운드로 생기기 때문에, 사용자
 * 입장에서 "내가 연 탭" 과 "자동화가 연 탭" 이 탭 스트립에 섞여 구분이 안 된다.
 * 크롬 탭 그룹(초록색 "MCP")으로 묶어 두면 한눈에 갈라지고, 그룹째 접거나 닫을 수 있다.
 *
 * 이 모듈의 절대 규칙 (docs/plans/2026-09-02-no-interference-mode-design.md):
 *   - 탭을 활성화하지 않는다 (chrome.tabs.update({active:true}) 호출 금지)
 *   - 창 포커스를 바꾸지 않는다 (chrome.windows.update({focused:true}) 호출 금지)
 *   - 그룹을 접지 않는다 (collapsed:false) — 접으면 사용자가 보던 탭 위치가 흔들린다
 *   - 어떤 실패도 도구 결과를 실패시키지 않는다 (경고 로그 + null 반환)
 *
 * chrome.tabs.group 은 탭을 그룹 옆으로 이동시키므로 탭 스트립 내 위치는 바뀐다.
 * 이는 활성 탭·포커스와 무관한 재배치라 무간섭 원칙에 저촉되지 않는다(의도된 동작).
 *
 * 편입 지점은 utils/work-tab-manager.ts 의 setWorkTab() 한 곳이다. MCP 가 직접 만든
 * 탭(navigate 계열)과 chrome_set_work_tab 으로 지정한 탭이 모두 그 함수를 지나간다.
 */

const STORAGE_KEY = 'mcpTabGroupEnabled';

/** 그룹 제목. 사용자가 탭 스트립에서 보는 라벨이다. */
export const MCP_TAB_GROUP_TITLE = 'MCP';

/** 그룹 색. chrome.tabGroups.Color 의 'green'. */
export const MCP_TAB_GROUP_COLOR = 'green';

/** 그룹에 속하지 않은 탭의 groupId (chrome.tabGroups.TAB_GROUP_ID_NONE). */
const TAB_GROUP_ID_NONE = -1;

/**
 * 탭 그룹 표시 설정. 기본 true — 명시적으로 false 를 저장한 경우에만 OFF.
 * (조회 실패 시에도 기본 동작인 true 로 간주한다.)
 */
export async function isMcpTabGroupEnabled(): Promise<boolean> {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEY]);
    return result[STORAGE_KEY] !== false;
  } catch {
    return true;
  }
}

export async function setMcpTabGroupEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: enabled });
}

/** chrome.tabGroups / chrome.tabs.group 을 쓸 수 있는 환경인가 (구버전 크롬·테스트 대비). */
function isTabGroupApiAvailable(): boolean {
  try {
    const tabs = chrome?.tabs as (typeof chrome.tabs & { group?: unknown }) | undefined;
    return (
      typeof tabs?.group === 'function' &&
      typeof chrome?.tabGroups?.query === 'function' &&
      typeof chrome?.tabGroups?.update === 'function'
    );
  } catch {
    return false;
  }
}

/**
 * 같은 창에 이미 있는 "MCP" 그룹 id. 없으면 null.
 * tabGroups.query 의 title 은 패턴 매칭이라 정확 일치를 다시 확인한다.
 */
async function findMcpGroupInWindow(windowId: number): Promise<number | null> {
  const groups = await chrome.tabGroups.query({
    windowId,
    title: MCP_TAB_GROUP_TITLE,
  });
  if (!Array.isArray(groups)) return null;
  const hit = groups.find((g) => g?.title === MCP_TAB_GROUP_TITLE && typeof g.id === 'number');
  return hit ? hit.id : null;
}

/**
 * 이 탭을 그 창의 "MCP" 탭 그룹에 넣는다. 편입된(또는 이미 속해 있던) 그룹 id 를 주고,
 * 하지 않았거나 실패했으면 null 을 준다. 절대 throw 하지 않는다.
 *
 * 창마다 그룹은 하나 — 같은 창에 "MCP" 그룹이 있으면 재사용하고, 없으면 만든 뒤
 * 제목·색을 지정한다.
 */
export async function assignTabToMcpGroup(tabId: unknown): Promise<number | null> {
  if (typeof tabId !== 'number') return null;
  try {
    if (!(await isMcpTabGroupEnabled())) return null;
    if (!isTabGroupApiAvailable()) return null;

    // 탭이 이미 사라졌으면 여기서 조용히 끝난다.
    const tab = await chrome.tabs.get(tabId);
    if (!tab || typeof tab.windowId !== 'number') return null;

    const existingGroupId = await findMcpGroupInWindow(tab.windowId);
    if (existingGroupId !== null) {
      // 이미 그 그룹이면 tabs.group 을 다시 부르지 않는다 (불필요한 탭 이동 방지).
      if (tab.groupId === existingGroupId) return existingGroupId;
      await chrome.tabs.group({ tabIds: [tabId], groupId: existingGroupId });
      return existingGroupId;
    }

    // 이 창에 "MCP" 그룹이 없다 — 새로 만들고 제목·색을 지정한다.
    const createdGroupId = await chrome.tabs.group({
      tabIds: [tabId],
      createProperties: { windowId: tab.windowId },
    });
    if (typeof createdGroupId !== 'number' || createdGroupId === TAB_GROUP_ID_NONE) {
      return null;
    }
    await chrome.tabGroups.update(createdGroupId, {
      title: MCP_TAB_GROUP_TITLE,
      color: MCP_TAB_GROUP_COLOR,
      // 접지 않는다 — 접으면 사용자가 보던 탭 스트립이 흔들린다.
      collapsed: false,
    });
    return createdGroupId;
  } catch (error) {
    // 권한 없음(tabGroups) / API 미지원 / 탭이 사라짐 / 그룹 불가 탭(pinned 등) 전부 여기로.
    console.warn(`[mcp-tab-group] skip grouping tab=${tabId}:`, error);
    return null;
  }
}

export const MCP_TAB_GROUP_STORAGE_KEY = STORAGE_KEY;
