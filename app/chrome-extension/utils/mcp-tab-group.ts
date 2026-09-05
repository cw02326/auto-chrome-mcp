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
 * 그룹 제목 상한. 탭 스트립의 그룹 라벨은 좁아서 긴 문구는 어차피 잘려 보인다.
 * 여기서 먼저 자르면 어느 창에서 보든 같은 문구가 나온다.
 */
export const MCP_TAB_GROUP_TITLE_MAX = 24;

/**
 * auto-chrome-mcp fork(2026-09-05 데일리 자동화 설계): 지금 무슨 작업을 하고 있는지 그룹
 * 제목으로 보여 준다. 무간섭 모드에서는 탭이 배경에 조용히 열리므로, 사용자가 "지금 이
 * 창에서 뭐가 돌고 있나" 를 알 방법이 탭 그룹 라벨뿐이다.
 *
 * 규칙:
 *   - batch·shortcut 실행 시작 시 제목을 바꾸고, 끝나면 "MCP" 로 되돌린다.
 *   - chrome_navigate 의 task 인자는 다음 task 나 실행 종료 전까지 유지된다.
 *   - 제목 변경은 chrome.tabGroups.update 만 쓴다. 탭 활성화·창 포커스는 건드리지 않는다.
 *
 * 상태는 워커 메모리에만 둔다. 제목은 표시용이라 워커가 교체돼 "MCP" 로 돌아가도
 * 실행 자체에는 아무 영향이 없다(저장소를 늘릴 이유가 없다).
 */
let activeTaskTitle: string | null = null;
/** 이 실행이 제목을 바꾼 창들 - 끝날 때 되돌릴 대상. */
const titledWindows = new Set<number>();
/** 창별로 우리가 만든 MCP 그룹 id. 제목을 바꾸면 title 조회로는 못 찾으므로 따로 기억한다. */
const groupIdByWindow = new Map<number, number>();

/** 사용자가 준 문구를 그룹 제목으로 다듬는다. 비면 기본 제목. */
export function normalizeMcpGroupTitle(raw: unknown): string {
  if (typeof raw !== 'string') return MCP_TAB_GROUP_TITLE;
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  if (!trimmed) return MCP_TAB_GROUP_TITLE;
  return trimmed.slice(0, MCP_TAB_GROUP_TITLE_MAX);
}

/** 지금 새로 만들거나 편입하는 그룹에 붙일 제목. */
export function currentMcpGroupTitle(): string {
  return activeTaskTitle ?? MCP_TAB_GROUP_TITLE;
}

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
  // 제목을 작업 이름으로 바꿔 둔 그룹은 title 조회로 찾을 수 없다 - 먼저 기억해 둔 id 를 본다.
  const tracked = groupIdByWindow.get(windowId);
  if (typeof tracked === 'number') {
    try {
      const group = await chrome.tabGroups.get(tracked);
      if (group && group.windowId === windowId) return tracked;
    } catch {
      // 그룹이 사라졌다 - 기억을 버리고 title 조회로 넘어간다.
    }
    groupIdByWindow.delete(windowId);
  }

  const groups = await chrome.tabGroups.query({
    windowId,
    title: MCP_TAB_GROUP_TITLE,
  });
  if (!Array.isArray(groups)) return null;
  const hit = groups.find((g) => g?.title === MCP_TAB_GROUP_TITLE && typeof g.id === 'number');
  if (!hit) return null;
  groupIdByWindow.set(windowId, hit.id);
  return hit.id;
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
      // 작업이 도는 중이면 그 창의 그룹 제목도 지금 작업 이름에 맞춘다 (탭이 나중에 생겨도
      // 라벨이 맞는다). 작업이 없을 때는 손대지 않는다 - 편입만으로 tabGroups.update 를
      // 부르면 그룹 재사용이 조용히 API 호출을 늘린다.
      if (activeTaskTitle !== null) {
        await applyTitleToGroup(tab.windowId, existingGroupId, activeTaskTitle);
      }
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
    const title = currentMcpGroupTitle();
    await chrome.tabGroups.update(createdGroupId, {
      title,
      color: MCP_TAB_GROUP_COLOR,
      // 접지 않는다. 접으면 사용자가 보던 탭 스트립이 흔들린다.
      collapsed: false,
    });
    groupIdByWindow.set(tab.windowId, createdGroupId);
    if (title !== MCP_TAB_GROUP_TITLE) titledWindows.add(tab.windowId);
    return createdGroupId;
  } catch (error) {
    // 권한 없음(tabGroups) / API 미지원 / 탭이 사라짐 / 그룹 불가 탭(pinned 등) 전부 여기로.
    console.warn(`[mcp-tab-group] skip grouping tab=${tabId}:`, error);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 그룹 제목 (지금 무슨 작업 중인지 탭 스트립에 보여 준다)
 * ------------------------------------------------------------------ */

/**
 * 그룹 제목만 바꾼다. chrome.tabGroups.update 는 탭을 활성화하지도, 창을 포커스하지도
 * 않는다 - 이 모듈의 무간섭 규칙을 그대로 지킨다. 실패는 삼킨다(표시용이다).
 */
async function applyTitleToGroup(
  windowId: number,
  groupId: number,
  title: string,
): Promise<boolean> {
  try {
    const current = await chrome.tabGroups.get(groupId);
    if (current?.title === title) {
      if (title !== MCP_TAB_GROUP_TITLE) titledWindows.add(windowId);
      return true;
    }
  } catch {
    // 조회 실패는 그냥 갱신을 시도한다.
  }
  try {
    await chrome.tabGroups.update(groupId, { title });
    if (title === MCP_TAB_GROUP_TITLE) titledWindows.delete(windowId);
    else titledWindows.add(windowId);
    return true;
  } catch (error) {
    console.warn(`[mcp-tab-group] skip title update window=${windowId}:`, error);
    return false;
  }
}

/**
 * 이 창의 MCP 그룹 제목을 바꾼다. 그룹이 없으면 아무것도 하지 않고 false.
 * 제목은 24자에서 자르고, 빈 문구는 기본 "MCP" 로 되돌린다.
 */
export async function setMcpGroupTitle(windowId: unknown, title: unknown): Promise<boolean> {
  if (typeof windowId !== 'number' || !Number.isInteger(windowId) || windowId <= 0) return false;
  if (!isTabGroupApiAvailable()) return false;
  const normalized = normalizeMcpGroupTitle(title);
  try {
    const groupId = await findMcpGroupInWindow(windowId);
    if (groupId === null) return false;
    return await applyTitleToGroup(windowId, groupId, normalized);
  } catch (error) {
    console.warn(`[mcp-tab-group] skip title lookup window=${windowId}:`, error);
    return false;
  }
}

/** 이 창의 MCP 그룹 제목을 기본값 "MCP" 로 되돌린다. */
export async function resetMcpGroupTitle(windowId: unknown): Promise<boolean> {
  return await setMcpGroupTitle(windowId, MCP_TAB_GROUP_TITLE);
}

/**
 * 지금부터 만들거나 편입하는 MCP 그룹에 이 제목을 쓴다. 실제 그룹에 바로 반영하려면
 * 이어서 setMcpGroupTitle(windowId, ...) 을 부른다(작업 탭 창을 아는 쪽이 부른다).
 * 다듬어진 제목을 돌려준다.
 */
export function beginMcpGroupTask(title: unknown): string {
  const normalized = normalizeMcpGroupTitle(title);
  activeTaskTitle = normalized === MCP_TAB_GROUP_TITLE ? null : normalized;
  return normalized;
}

/**
 * 작업을 끝내고 제목을 바꿨던 창을 전부 "MCP" 로 되돌린다.
 * 어떤 실패도 던지지 않는다 - 실행 결과에 영향을 주면 안 된다.
 */
export async function endMcpGroupTask(): Promise<void> {
  activeTaskTitle = null;
  const windows = Array.from(titledWindows);
  titledWindows.clear();
  for (const windowId of windows) {
    await setMcpGroupTitle(windowId, MCP_TAB_GROUP_TITLE);
  }
}

/** 테스트용 - 워커 메모리 상태를 초기화한다. */
export function resetMcpGroupTaskState(): void {
  activeTaskTitle = null;
  titledWindows.clear();
  groupIdByWindow.clear();
}

export const MCP_TAB_GROUP_STORAGE_KEY = STORAGE_KEY;
