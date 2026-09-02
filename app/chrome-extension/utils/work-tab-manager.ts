/**
 * MCP work-tab tracker (auto-chrome-mcp fork) — 세션별 다중 작업 탭.
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

import { hideWorkTabIndicator, showWorkTabIndicator } from '@/utils/work-tab-indicator';
import { isTabBusy } from '@/utils/tab-lock';
import { isMcpWindow } from '@/utils/mcp-window-manager';

const SESSION_KEY = 'mcpWorkTabs';
/** auto-chrome-mcp fork: 세션이 직접 만든 탭 목록 (정리 대상 판정용) */
const OWNED_KEY = 'mcpOwnedTabs';
const LEGACY_SESSION_KEY = 'mcpWorkTabId';
export const DEFAULT_SESSION_ID = 'default';
/** 레인까지 포함한 버킷 수 상한 (한 세션이 여러 레인을 쓰므로 세션 수보다 넉넉해야 한다). */
export const MAX_SESSIONS = 32;

/**
 * auto-chrome-mcp fork(P1): 레인 구분자.
 *
 * 한 Claude Code 세션의 서브에이전트들은 **같은 stdio 프로세스**를 공유하므로
 * _mcpSessionId 가 전부 동일하다. 병렬 에이전트가 서로의 작업 탭을 덮어쓰거나 닫는 것을
 * 막으려면 호출자가 스스로를 구분해 줘야 한다 — 그 수단이 lane 인자다.
 *
 *   sessionKey = _mcpSessionId            (lane 없음 — 기존 동작)
 *   sessionKey = _mcpSessionId::<lane>    (lane 지정 — 완전 격리)
 */
const LANE_SEPARATOR = '::';
const MAX_LANE_LENGTH = 64;

/** 소유 탭 정리 정책 (P1) — 병렬 에이전트를 죽이지 않으면서 탭 축적은 막는 기준. */
/** 최근 이 시간 안에 쓰인 탭은 정리하지 않는다 (에이전트가 '생각하는 중' 인 탭 보호). */
export const OWNED_GRACE_MS = 90_000;
/** 한 레인이 유지할 수 있는 여분 작업 탭 수 상한. 초과분은 오래된 순으로 정리. */
export const MAX_OWNED_PER_KEY = 8;
/** 어떤 레인에서도 이 시간 넘게 안 쓰인 소유 탭은 방치된 것으로 보고 전역 청소. */
export const OWNED_ABANDON_MS = 15 * 60_000;

/**
 * auto-chrome-mcp fork(P1): 도구 인자에서 "작업 탭 버킷 키" 를 만든다.
 * _mcpSessionId 는 stdio 프로세스(=Claude Code 세션) 단위라 서브에이전트끼리 같다.
 * 호출자가 lane 을 주면 그만큼 버킷이 갈라져 병렬 에이전트가 서로 간섭하지 않는다.
 */
export function sessionKeyOf(args: any): string {
  const sid =
    typeof args?._mcpSessionId === 'string' && args._mcpSessionId
      ? args._mcpSessionId
      : DEFAULT_SESSION_ID;
  const rawLane = typeof args?.lane === 'string' ? args.lane.trim() : '';
  if (!rawLane) return sid;
  return `${sid}${LANE_SEPARATOR}${rawLane.slice(0, MAX_LANE_LENGTH)}`;
}

/** 버킷 키에서 레인 이름만 떼어낸다 (표시·진단용). */
export function laneOf(sessionKey: string): string | null {
  const idx = sessionKey.indexOf(LANE_SEPARATOR);
  return idx === -1 ? null : sessionKey.slice(idx + LANE_SEPARATOR.length);
}

interface WorkTabEntry {
  tabId: number;
  lastUsedAt: number;
  /**
   * auto-chrome-mcp fork: 이 탭을 MCP 가 직접 만들었는가.
   * true 인 탭만 다음 navigate 가 재사용(=다른 URL 로 이동)한다. 사용자가
   * chrome_set_work_tab 으로 지정한 자기 탭을 MCP 가 임의로 이동시키지 않게 하는 구분이다.
   */
  owned?: boolean;
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
  // auto-chrome-mcp fork: 툴바 뱃지는 그 탭을 보고 있을 때만 보인다. 페이지 안에도
  // "Claude 작업 중" 표시를 띄워, 어떤 탭이 자동화에 쓰이는지 한눈에 보이게 한다.
  if (on) {
    void showWorkTabIndicator(tabId);
  } else {
    void hideWorkTabIndicator(tabId);
  }
}

export async function setWorkTab(
  tabId: number,
  sessionId: string = DEFAULT_SESSION_ID,
  owned = false,
): Promise<void> {
  const map = { ...(await loadMap()) };
  const prev = map[sessionId];
  // 같은 탭을 다시 기록할 때 소유 표시를 잃지 않는다 (도구가 owned 를 안 넘겨도 유지).
  const keptOwned = owned || (prev?.tabId === tabId && prev.owned === true);
  map[sessionId] = { tabId, lastUsedAt: Date.now(), owned: keptOwned };

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
 * auto-chrome-mcp fork: MCP 가 직접 만든(재사용해도 되는) 작업 탭 id. 없으면 null.
 * navigate 가 새 탭을 만들기 전에 이 탭을 먼저 재사용해 탭이 무한히 쌓이는 것을 막는다.
 */
export async function getOwnedWorkTabId(
  sessionId: string = DEFAULT_SESSION_ID,
): Promise<number | null> {
  const map = await loadMap();
  const entry = map[sessionId];
  if (!entry || entry.owned !== true) return null;
  return await getWorkTabId(sessionId);
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

/**
 * auto-chrome-mcp fork(P1): 소유 탭 1건. touchedAt 은 "이 탭을 대상으로 마지막 도구 호출이
 * 있었던 시각" — 정리 판정의 핵심 신호다. isTabBusy 는 호출이 *실행 중일 때만* true 라서,
 * 에이전트가 다음 행동을 고민하는 사이 병렬 형제 탭이 idle 로 오인돼 닫히던 것이 원인이었다.
 */
interface OwnedEntry {
  tabId: number;
  touchedAt: number;
}

type OwnedMap = Record<string, OwnedEntry[]>;

/** 구버전(number[]) 저장 형식 호환 — 브라우저 세션이 살아 있는 채로 업데이트된 경우. */
function normalizeOwned(raw: unknown): OwnedMap {
  const out: OwnedMap = {};
  if (!raw || typeof raw !== 'object') return out;
  const now = Date.now();
  for (const [key, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const entries: OwnedEntry[] = [];
    for (const item of list) {
      if (typeof item === 'number') {
        entries.push({ tabId: item, touchedAt: now });
      } else if (item && typeof (item as OwnedEntry).tabId === 'number') {
        const e = item as OwnedEntry;
        entries.push({
          tabId: e.tabId,
          touchedAt: typeof e.touchedAt === 'number' ? e.touchedAt : now,
        });
      }
    }
    if (entries.length > 0) out[key] = entries;
  }
  return out;
}

let cachedOwned: OwnedMap | null = null;

async function loadOwned(): Promise<OwnedMap> {
  if (cachedOwned) return cachedOwned;
  try {
    const result = await chrome.storage.session.get([OWNED_KEY]);
    cachedOwned = normalizeOwned(result[OWNED_KEY]);
  } catch {
    cachedOwned = {};
  }
  return cachedOwned;
}

async function persistOwned(map: OwnedMap): Promise<void> {
  cachedOwned = map;
  try {
    await chrome.storage.session.set({ [OWNED_KEY]: map });
  } catch {
    // 저장 실패 시 정리를 못 할 뿐, 도구 동작에는 영향 없음
  }
}

/** MCP 가 직접 만든 탭을 이 버킷 소유로 등록한다. */
export async function addOwnedTab(
  tabId: number,
  sessionKey: string = DEFAULT_SESSION_ID,
): Promise<void> {
  const map = await loadOwned();
  const list = map[sessionKey] ?? [];
  const now = Date.now();
  const existing = list.find((e) => e.tabId === tabId);
  if (existing) {
    existing.touchedAt = now;
    await persistOwned({ ...map, [sessionKey]: [...list] });
    return;
  }
  await persistOwned({ ...map, [sessionKey]: [...list, { tabId, touchedAt: now }] });
}

/**
 * auto-chrome-mcp fork(P1): 이 탭을 지금 쓰고 있다고 표시한다 (게이트가 매 도구 호출마다 호출).
 * 정리 로직은 이 시각을 보고 "살아 있는 병렬 작업" 과 "방치된 탭" 을 구분한다.
 * 저장 쓰기는 디바운스한다 — 호출 빈도가 높고, 최대 몇 초 낡아도 판정에 지장이 없다.
 */
let touchPersistTimer: ReturnType<typeof setTimeout> | null = null;

function applyTouch(map: OwnedMap, tabId: number): void {
  let hit = false;
  const now = Date.now();
  for (const list of Object.values(map)) {
    for (const entry of list) {
      if (entry.tabId === tabId) {
        entry.touchedAt = now;
        hit = true;
      }
    }
  }
  if (!hit || touchPersistTimer !== null) return;
  touchPersistTimer = setTimeout(() => {
    touchPersistTimer = null;
    void persistOwned({ ...map });
  }, 3000);
}

export function touchOwnedTab(tabId: unknown): void {
  if (typeof tabId !== 'number') return;
  const map = cachedOwned;
  if (!map) {
    // 캐시가 비었으면(service worker 재시작 직후) 먼저 로드한 뒤 반영
    void loadOwned().then((loaded) => applyTouch(loaded, tabId));
    return;
  }
  applyTouch(map, tabId);
}

async function forgetOwnedTab(tabId: number): Promise<void> {
  const map = await loadOwned();
  let changed = false;
  const next: OwnedMap = {};
  for (const [key, list] of Object.entries(map)) {
    const filtered = list.filter((e) => e.tabId !== tabId);
    if (filtered.length !== list.length) changed = true;
    if (filtered.length > 0) next[key] = filtered;
  }
  if (changed) await persistOwned(next);
}

/**
 * auto-chrome-mcp fork(P1): MCP 가 닫은 탭의 사유 기록 (진단용, 메모리 전용).
 * 탭이 사라져 도구가 실패했을 때 "왜 없어졌는지" 를 에러에 붙여 준다.
 */
const closedByMcp = new Map<number, { at: number; reason: string }>();
const CLOSED_LOG_LIMIT = 50;

function rememberClosed(tabId: number, reason: string): void {
  closedByMcp.set(tabId, { at: Date.now(), reason });
  if (closedByMcp.size > CLOSED_LOG_LIMIT) {
    const oldest = closedByMcp.keys().next();
    if (!oldest.done) closedByMcp.delete(oldest.value);
  }
}

/** 이 탭을 MCP 가 닫았다면 사람이 읽을 수 있는 사유를, 아니면 null 을 준다. */
export function describeClosedTab(tabId: number): string | null {
  const hit = closedByMcp.get(tabId);
  if (!hit) return null;
  const agoSec = Math.max(0, Math.round((Date.now() - hit.at) / 1000));
  return `${hit.reason} (${agoSec}s ago)`;
}

/** 지금 어떤 버킷에서든 작업 탭으로 등록된 탭 집합 — 정리 절대 금지 대상. */
async function registeredWorkTabIds(): Promise<Set<number>> {
  const map = await loadMap();
  return new Set(Object.values(map).map((e) => e.tabId));
}

/**
 * 이 탭을 닫으면 안 되는 이유가 있으면 그 사유를, 닫아도 되면 null 을 준다.
 */
async function reasonToKeep(
  tabId: number,
  exceptTabId: number | undefined,
  workTabIds: Set<number>,
): Promise<string | null> {
  if (tabId === exceptTabId) return 'just created';
  if (isTabBusy(tabId)) return 'busy';
  // 어떤 세션·레인이든 현재 작업 탭이면 건드리지 않는다 (병렬 형제 탭 보호의 핵심).
  if (workTabIds.has(tabId)) return 'active work tab';

  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return 'gone';
  }
  if (tab.active && !(await isMcpWindow(tab.windowId))) return 'user is viewing';
  return null;
}

/**
 * auto-chrome-mcp fork(P1): 새 작업 탭이 열릴 때 소유 탭을 정리한다.
 *
 * v1.6.0 은 "같은 세션이 만든 탭 중 지금 실행 중이 아닌 것" 을 전부 닫았다. 서브에이전트가
 * stdio 세션을 공유하는 탓에, 병렬 에이전트 4개가 서로의 탭을 차례로 닫아 전원
 * tab_not_found 로 죽었다. 이제 정리 기준은 세 겹이다:
 *
 *   1. 절대 안 닫음 — 방금 만든 탭 / 실행 중 / 어느 레인이든 현재 작업 탭 / 사용자가 보는 탭
 *   2. 유예        — 최근 OWNED_GRACE_MS 안에 쓰인 탭은 남긴다 (에이전트가 생각하는 중)
 *   3. 상한        — 위를 통과하고도 남은 여분이 MAX_OWNED_PER_KEY 를 넘으면 오래된 순 정리
 *
 * 남의 레인 탭은 OWNED_ABANDON_MS 넘게 안 쓰인 "방치" 상태일 때만 청소한다 — 레인을 쓰고
 * 사라진 에이전트의 탭이 영원히 남지 않게 하되, 살아 있는 병렬 작업은 절대 끊지 않는다.
 */
export async function pruneOwnedTabs(
  sessionKey: string = DEFAULT_SESSION_ID,
  exceptTabId?: number,
): Promise<number[]> {
  const map = await loadOwned();
  const workTabIds = await registeredWorkTabIds();
  const now = Date.now();
  const closed: number[] = [];
  const next: OwnedMap = {};

  for (const [key, list] of Object.entries(map)) {
    const isOwnBucket = key === sessionKey;
    // 최근 사용 순 — 상한 판정은 이 순서를 따른다.
    const ordered = [...list].sort((a, b) => b.touchedAt - a.touchedAt);
    const kept: OwnedEntry[] = [];
    let spare = 0;

    for (const entry of ordered) {
      const keepReason = await reasonToKeep(entry.tabId, exceptTabId, workTabIds);
      if (keepReason === 'gone') continue; // 이미 닫힌 탭 — 목록에서만 제거
      if (keepReason !== null) {
        kept.push(entry);
        continue;
      }

      const idleMs = now - entry.touchedAt;
      const abandoned = idleMs > OWNED_ABANDON_MS;
      if (!isOwnBucket && !abandoned) {
        kept.push(entry);
        continue;
      }
      if (!abandoned && idleMs <= OWNED_GRACE_MS && spare < MAX_OWNED_PER_KEY) {
        spare += 1;
        kept.push(entry);
        continue;
      }

      try {
        await chrome.tabs.remove(entry.tabId);
        closed.push(entry.tabId);
        rememberClosed(
          entry.tabId,
          abandoned
            ? `closed by MCP cleanup: unused for ${Math.round(idleMs / 60000)}min`
            : 'closed by MCP cleanup: per-lane tab limit reached',
        );
      } catch {
        kept.push(entry);
      }
    }

    if (kept.length > 0) next[key] = kept;
  }

  await persistOwned(next);

  if (closed.length > 0) {
    console.log(`[work-tab] pruned ${closed.length} MCP tab(s): ${closed.join(', ')}`);
  }
  return closed;
}

// auto-chrome-mcp fork: 작업 탭이 다른 페이지로 이동하면 표시기 DOM 이 사라지므로 다시 붙인다.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  void (async () => {
    const map = await loadMap();
    if (!Object.values(map).some((e) => e.tabId === tabId)) return;
    await showWorkTabIndicator(tabId);
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void forgetOwnedTab(tabId);
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
