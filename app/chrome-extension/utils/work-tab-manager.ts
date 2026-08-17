/**
 * MCP work-tab tracker (scalemaker fork) — 세션별 다중 작업 탭.
 *
 * 각 Claude Code 세션(stdio 프로세스)은 고유 _mcpSessionId 를 모든 도구 호출 인자에 실어 보낸다.
 * 이 모듈은 세션별로 "MCP 작업 탭"을 기억해 두고, tabId 미지정 도구 호출이 사용자의 활성 탭
 * 대신 해당 세션의 작업 탭을 대상으로 하게 한다 (주입은 tools/index.ts handleCallTool 게이트).
 *
 * - 최대 MAX_SESSIONS(10) 세션, 초과 시 가장 오래 안 쓴 세션부터 LRU 퇴출
 * - 작업 탭에는 확장 액션 뱃지 "MCP" 표시 (해당 탭을 볼 때만 보임 — 페이지 무간섭)
 * - MV3 service worker 는 수시로 종료되므로 chrome.storage.session 에 persist
 *   (브라우저 세션 동안 유지, 브라우저 재시작 시 초기화 — 의도된 수명)
 */

const SESSION_KEY = 'mcpWorkTabs';
const LEGACY_SESSION_KEY = 'mcpWorkTabId';
export const DEFAULT_SESSION_ID = 'default';
export const MAX_SESSIONS = 10;

interface WorkTabEntry {
  tabId: number;
  lastUsedAt: number;
}

type WorkTabMap = Record<string, WorkTabEntry>;

let cachedMap: WorkTabMap | null = null;

async function loadMap(): Promise<WorkTabMap> {
  if (cachedMap) return cachedMap;
  try {
    const result = await chrome.storage.session.get([SESSION_KEY]);
    cachedMap = (result[SESSION_KEY] as WorkTabMap) ?? {};
  } catch {
    cachedMap = {};
  }
  return cachedMap;
}

async function persistMap(map: WorkTabMap): Promise<void> {
  cachedMap = map;
  try {
    await chrome.storage.session.set({ [SESSION_KEY]: map });
  } catch {
    // storage.session 실패해도 in-memory 캐시로 동작
  }
}

async function setBadge(tabId: number, on: boolean): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text: on ? 'MCP' : '' });
    if (on) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#6d28d9' });
    }
  } catch {
    // 탭이 이미 닫혔거나 action API 불가 — 무시
  }
}

export async function setWorkTab(
  tabId: number,
  sessionId: string = DEFAULT_SESSION_ID,
): Promise<void> {
  const map = { ...(await loadMap()) };
  const prev = map[sessionId];
  map[sessionId] = { tabId, lastUsedAt: Date.now() };

  // LRU 퇴출: MAX_SESSIONS 초과 시 가장 오래 안 쓴 세션 제거
  const sessions = Object.entries(map);
  if (sessions.length > MAX_SESSIONS) {
    sessions.sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    for (const [sid, entry] of sessions.slice(0, sessions.length - MAX_SESSIONS)) {
      delete map[sid];
      if (!Object.values(map).some((e) => e.tabId === entry.tabId)) {
        void setBadge(entry.tabId, false);
      }
    }
  }

  await persistMap(map);
  if (prev && prev.tabId !== tabId && !Object.values(map).some((e) => e.tabId === prev.tabId)) {
    void setBadge(prev.tabId, false);
  }
  void setBadge(tabId, true);
}

export async function clearWorkTab(sessionId: string = DEFAULT_SESSION_ID): Promise<void> {
  const map = { ...(await loadMap()) };
  const entry = map[sessionId];
  if (!entry) return;
  delete map[sessionId];
  await persistMap(map);
  if (!Object.values(map).some((e) => e.tabId === entry.tabId)) {
    void setBadge(entry.tabId, false);
  }
}

/**
 * 유효한(아직 존재하는) 세션 작업 탭 id 를 반환. 없거나 닫혔으면 null.
 * 조회 시 LRU 타임스탬프 갱신.
 */
export async function getWorkTabId(sessionId: string = DEFAULT_SESSION_ID): Promise<number | null> {
  const map = await loadMap();
  const entry = map[sessionId];
  if (!entry) return null;
  try {
    await chrome.tabs.get(entry.tabId);
    entry.lastUsedAt = Date.now();
    void persistMap({ ...map });
    return entry.tabId;
  } catch {
    await clearWorkTab(sessionId);
    return null;
  }
}

/**
 * 전체 세션 → 작업 탭 매핑 스냅샷 (popup 표시, 전용 창 관리용).
 * 닫힌 탭 정리는 하지 않음 — 표시 전 chrome.tabs.get 으로 검증할 것.
 */
export async function getAllWorkTabs(): Promise<Record<string, number>> {
  const map = await loadMap();
  const out: Record<string, number> = {};
  for (const [sid, entry] of Object.entries(map)) {
    out[sid] = entry.tabId;
  }
  return out;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const map = await loadMap();
    const affected = Object.entries(map).filter(([, e]) => e.tabId === tabId);
    if (affected.length === 0) return;
    const next = { ...map };
    for (const [sid] of affected) delete next[sid];
    await persistMap(next);
  })();
});

// 구버전 단일 작업 탭 키 정리 (1.0.38 dev 빌드 잔재)
try {
  void chrome.storage.session.remove(LEGACY_SESSION_KEY).catch(() => {});
} catch {
  // ignore
}
