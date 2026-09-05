/**
 * Spawned-tab tracker (auto-chrome-mcp fork) — 팝업·새 창 인지.
 *
 * 페이지가 window.open / target=_blank / OAuth 팝업 등으로 새 탭·창을 열면
 * 기록해 두고, 게이트(tools/index.ts)가 도구 실행 전후를 비교해
 * "이 도구 호출이 연 새 탭" 을 도구 결과에 첨부한다. 이게 없으면 모델은
 * 팝업이 열린 사실 자체를 모르고 원래 탭에만 명령을 보내다 실패한다.
 *
 * 출처 판단 우선순위:
 *  1) chrome.webNavigation.onCreatedNavigationTarget — sourceTabId 가 가장 정확
 *  2) chrome.tabs.onCreated 의 openerTabId — fallback (1과 중복되면 병합)
 *
 * in-memory ring buffer (TTL 2분, 최대 30건) — SW 재시작 시 유실은 허용
 * (도구 호출 한 번의 전후 비교 용도라 수명이 짧아도 충분).
 */

export interface SpawnedTabRecord {
  tabId: number;
  openerTabId: number | null;
  url: string;
  windowId: number;
  /** 'popup' = window.open 으로 뜬 별도 팝업 창, 'normal' = 일반 창의 탭 */
  windowType: string;
  createdAt: number;
}

import { isBackgroundModeEnabled } from '@/utils/background-mode';
import { addOwnedTab, getAllWorkTabs, getSessionScopedTabIds } from '@/utils/work-tab-manager';
import { CHROME_WINDOW_ID_NONE, scheduleDeferredUnfocus } from '@/utils/window-focus-guard';
import { getCurrentUserWindowId, isMcpWindow } from '@/utils/mcp-window-manager';

const TTL_MS = 120_000;
const MAX_RECORDS = 30;

const records: SpawnedTabRecord[] = [];

/* ------------------------------------------------------------------ *
 * 소유 스코프 (2026-09-05 Codex 리뷰 1)
 *
 * 예약 실행처럼 "전역 토글과 무관하게 무간섭이어야 하는" 실행이 도는 동안, 그 실행의
 * 작업 탭이 `target=_blank`·`window.open` 으로 연 탭·팝업 창은 지금까지 아무 데도 속하지
 * 않았다. 소유 버킷 밖이라 실행이 끝나도 남았고, 활성 탭이 되어 사용자 화면을 가져갔고,
 * 완화 로직은 전역 토글만 보고 있어 토글 OFF 에서는 아예 돌지 않았다.
 *
 * 스코프가 열려 있는 동안 그 세션이 소유한 탭에서 나온 새 탭은
 *   1. 사용자가 보던 탭·창을 즉시 되돌리고
 *   2. 같은 소유 버킷에 등록되어 인계 판정·정리에 함께 걸리고
 *   3. 팝업 창이면 실행이 끝날 때 창째로 닫힌다.
 * ------------------------------------------------------------------ */

export interface SpawnScopeInput {
  /** 소유 버킷 키 (예: `scheduled::daily-dashboard`). */
  sessionKey: string;
  /** 전역 토글과 무관하게 무간섭을 강제하는 실행인가. */
  forced: boolean;
}

interface SpawnScope extends SpawnScopeInput {
  /** 이 스코프가 흡수한, 페이지가 연 팝업 창들. */
  popupWindowIds: Set<number>;
}

const spawnScopes = new Map<string, SpawnScope>();

/** 이미 흡수한 탭 (onCreated 와 webNavigation 이 같은 탭을 두 번 보내도 한 번만 처리한다). */
const adoptedTabs = new Set<number>();

/** 진행 중인 흡수 처리. 인계 판정은 이것이 끝난 뒤에 봐야 한다. */
let adoptionChain: Promise<void> = Promise.resolve();

function trackAdoption(work: () => Promise<void>): void {
  adoptionChain = adoptionChain.then(work, work).then(
    () => undefined,
    () => undefined,
  );
}

/** 진행 중인 흡수 처리가 끝날 때까지 기다린다 (탭 인계 판정 직전에 부른다). */
export async function settleSpawnAdoptions(): Promise<void> {
  await adoptionChain;
}

/** 이 세션이 도는 동안 열리는 새 탭을 흡수하도록 스코프를 연다. */
export function beginSpawnScope(input: SpawnScopeInput): void {
  spawnScopes.set(input.sessionKey, { ...input, popupWindowIds: new Set<number>() });
}

/** 스코프를 닫고, 실행이 끝날 때 닫아야 하는 팝업 창 id 를 돌려준다. */
export function endSpawnScope(sessionKey: string): number[] {
  const scope = spawnScopes.get(sessionKey);
  spawnScopes.delete(sessionKey);
  return scope ? Array.from(scope.popupWindowIds) : [];
}

/** 이 창이 지금 도는 실행이 연 팝업 창인가 (사용자가 연 창과 구분한다). */
export function isSpawnedPopupWindow(windowId: number | null | undefined): boolean {
  if (typeof windowId !== 'number') return false;
  for (const scope of spawnScopes.values()) {
    if (scope.popupWindowIds.has(windowId)) return true;
  }
  return false;
}

/** 테스트·정리용 - 열린 스코프와 화면 추적을 모두 버린다. */
export function resetSpawnScopes(): void {
  spawnScopes.clear();
  adoptedTabs.clear();
  adoptedTabScopes.clear();
  focusRestoredSpawns.clear();
  lastActiveTabByWindow.clear();
  focusHistory.length = 0;
}

/* ------------------------------------------------------------------ *
 * 직전 사용자 화면 추적 (2026-09-05 발행 전 검토 1)
 *
 * 예전에는 실행을 시작할 때 "지금 사용자가 보고 있는 탭·창" 을 한 번 찍어 두고, 실행 중
 * 팝업이 뜰 때마다 그 스냅샷으로 되돌렸다. 실행은 2분까지 갈 수 있으므로 그 사이에
 * 사용자가 다른 창으로 옮겼으면, 팝업이 뜨는 순간 **사용자를 옛 창으로 끌고 갔다**.
 * 되돌릴 대상은 실행이 시작될 때가 아니라 **스폰 직전에 실제로 활성이던 것**이다.
 *
 *  - 탭: 스폰이 일어난 **그 창**에서 마지막으로 활성이던 사용자 탭.
 *  - 창: `windows.onFocusChanged` 이력에서 스폰 창·팝업 창·작업 창을 뺀 마지막 창.
 *        스폰이 **새 창(팝업)을 만들었을 때만** 본다.
 *
 * 추적 값이 없으면(워커가 방금 깼다, 이벤트를 놓쳤다) **아무것도 되돌리지 않는다.**
 * 모르는 채로 화면을 옮기는 것이 옛 창으로 끌려가는 것과 같은 종류의 침해다.
 *
 * 2026-09-05 Codex 최종 확인 1 - 추적을 **창별**로 바꿨다. 예전에는
 *   ① `tabs.onActivated` 의 `previousTabId` 를 읽었다. 크롬의 `activeInfo` 는
 *      `{tabId, windowId}` 뿐이라 이 값은 **항상 undefined** 였고,
 *   ② 그래서 매번 전역 대체값(`lastActivatedTabId`)으로 떨어졌다. 창이 둘 이상이면
 *      그 값은 다른 창의 탭이라, 창 A 의 스폰을 되돌린다며 창 B 의 탭을 활성화했다.
 *   ③ 창 포커스도 같은 창에서 열린 일반 탭까지 되돌리려 해, 스폰 창만 빼고 이력을
 *      훑다가 사용자를 **과거의 다른 창**으로 옮겼다.
 * 이제 창별 마지막 활성 탭만 보고, 창 포커스는 팝업 창이 생겼을 때만 되돌린다.
 * ------------------------------------------------------------------ */

/** 창별 마지막 활성 탭을 기억해 두는 상한 (창 하나당 한 줄). */
const MAX_WINDOW_RECORDS = 30;
/** 창 포커스 이력 상한. */
const MAX_FOCUS_HISTORY = 8;

/**
 * 창 id -> 그 창에서 마지막으로 활성이던 **사용자** 탭.
 *
 * 스폰 탭과 자동화 소유 탭은 넣지 않는다. 넣으면 "되돌릴 사용자 화면" 자리에 자동화가
 * 방금 만든 탭이 앉아, 복귀가 사용자를 자동화 탭으로 데려간다.
 */
const lastActiveTabByWindow = new Map<number, number>();
/** 창 포커스 이력 (뒤가 최근). `CHROME_WINDOW_ID_NONE` = 크롬 밖의 다른 앱. */
const focusHistory: number[] = [];
/** 흡수한 탭 -> 그 탭을 흡수한 스코프 (활성화가 흡수보다 늦게 와도 되돌릴 수 있게). */
const adoptedTabScopes = new Map<number, SpawnScope>();
/** 창 포커스를 이미 되돌린 스폰 탭 (중복 복귀 방지). */
const focusRestoredSpawns = new Set<number>();

function rememberActivation(windowId: number, tabId: number): void {
  lastActiveTabByWindow.set(windowId, tabId);
  while (lastActiveTabByWindow.size > MAX_WINDOW_RECORDS) {
    const oldest = lastActiveTabByWindow.keys().next().value;
    if (oldest === undefined) break;
    lastActiveTabByWindow.delete(oldest);
  }
}

function rememberFocus(windowId: number): void {
  if (focusHistory[focusHistory.length - 1] === windowId) return;
  focusHistory.push(windowId);
  if (focusHistory.length > MAX_FOCUS_HISTORY) focusHistory.shift();
}

/**
 * 이 탭이 자동화가 쥐고 있는 탭인가 (스폰 탭 · 세션 작업 탭 · 열린 스코프의 소유 탭).
 *
 * 이런 탭이 활성화된 것은 "사용자가 그 탭을 보러 갔다" 가 아니라 자동화가 화면을 가져간
 * 것이므로, 되돌릴 대상 자리에 기록하면 안 된다.
 */
async function isAutomationTab(tabId: number): Promise<boolean> {
  if (adoptedTabs.has(tabId)) return true;
  try {
    const workTabs = await getAllWorkTabs();
    if (Object.values(workTabs).includes(tabId)) return true;
  } catch {
    // 조회 실패는 "자동화 탭이라는 근거가 없다" 로 본다.
  }
  for (const scope of spawnScopes.values()) {
    try {
      const owned = await getSessionScopedTabIds(scope.sessionKey);
      if (owned.includes(tabId)) return true;
    } catch {
      // 같은 이유로 무시한다.
    }
  }
  return false;
}

/**
 * 되돌릴 사용자 창. 없으면 null (되돌리지 않는다).
 *
 * 이력을 뒤에서부터 훑되 스폰 창·팝업 창·MCP 작업 창은 건너뛰고, **크롬 밖으로 나간
 * 기록(`CHROME_WINDOW_ID_NONE`)을 먼저 만나면 포기한다** - 사용자가 다른 앱을 쓰고 있는데
 * 크롬 창을 앞으로 끌어내지 않기 위해서다(`utils/window-focus-guard.ts` 와 같은 규칙).
 */
async function previousUserFocusedWindow(spawnWindowId: number): Promise<number | null> {
  for (let i = focusHistory.length - 1; i >= 0; i--) {
    const id = focusHistory[i];
    if (id === CHROME_WINDOW_ID_NONE) return null;
    if (id === spawnWindowId) continue;
    if (isSpawnedPopupWindow(id)) continue;
    try {
      if (await isMcpWindow(id)) continue;
    } catch {
      // 판정 불가는 "작업 창일 수 있다" 로 보고 건너뛴다.
      continue;
    }
    try {
      await chrome.windows.get(id);
    } catch {
      continue; // 이미 닫힌 창
    }
    return id;
  }
  return null;
}

/** 이 opener 탭을 소유한 열린 스코프. 없으면 null. */
async function scopeForOpener(openerTabId: number | null): Promise<SpawnScope | null> {
  if (openerTabId === null || spawnScopes.size === 0) return null;
  for (const scope of spawnScopes.values()) {
    try {
      const owned = await getSessionScopedTabIds(scope.sessionKey);
      if (owned.includes(openerTabId)) return scope;
    } catch {
      // 조회 실패는 "이 스코프 소유가 아니다" 로 본다.
    }
  }
  return null;
}

/**
 * 스폰 탭이 가져간 화면을 **직전 상태로** 되돌린다.
 *
 * 되돌릴 대상은 위 추적기가 관측한 것뿐이다: 스폰이 일어난 창에서 마지막으로 활성이던
 * 사용자 탭과, 스폰이 **새 창(팝업)을 만들었을 때** 그 직전에 포커스를 쥐고 있던 사용자 창.
 * 둘 중 관측값이 없는 쪽은 그냥 두고, 어느 쪽도 없으면 아무것도 하지 않는다 (`force` 로
 * 밀어 넣던 옛 경로는 없앴다 - 스냅샷이 낡았을 때 사용자를 옛 창으로 끌고 가는 원인이
 * 그 강제 경로였다).
 *
 * 같은 창에서 열린 탭은 창 포커스를 옮긴 적이 없으므로 창 포커스를 건드리지 않는다.
 * 예전에는 여기서도 이력을 훑어, 스폰 창만 빼고 나온 **과거의 다른 창**으로 사용자를
 * 옮겼다 (2026-09-05 Codex 최종 확인 1).
 *
 * 두 호출 모두 activation-guard 를 거치지 않고 크롬 API 를 직접 부른다. 대상이 **사용자가
 * 방금까지 보고 있던 탭·창** 일 때만 허용되는 예외이고(activation-guard 상단 주석의
 * 예외 목록), 게이트를 거치면 무간섭 모드에서 복구 자체가 막혀 사용자가 팝업에 갇힌다.
 */
async function restoreUserView(tabId: number, windowId: number): Promise<void> {
  const prevTabId = lastActiveTabByWindow.get(windowId);
  // 직전 탭이 이 실행이 연 다른 탭이면 되돌릴 사용자 화면이 아니다.
  if (typeof prevTabId === 'number' && prevTabId !== tabId && !adoptedTabs.has(prevTabId)) {
    try {
      // 그 탭이 아직 활성이면 스폰 탭이 활성 슬롯을 가져가지 않았다는 뜻이다
      // (별도 팝업 창으로 떴다). 되돌릴 것이 없으므로 건드리지 않는다.
      const prev = await chrome.tabs.get(prevTabId);
      if (prev?.active !== true) await chrome.tabs.update(prevTabId, { active: true });
    } catch {
      // 탭이 이미 닫혔을 수 있다 - best-effort
    }
  }
  // 창 포커스는 스폰이 **새 창을 만들었을 때만** 되돌린다. 같은 창 안의 탭 스폰은 창
  // 포커스를 가져간 적이 없다.
  if (!isSpawnedPopupWindow(windowId)) return;
  // 스폰 탭 하나당 한 번만 되돌린다. 흡수와 활성화 이벤트가 둘 다 이 함수를 부르므로
  // (어느 쪽이 먼저 올지는 정해져 있지 않다) 확인이 없으면 두 번 건다.
  if (focusRestoredSpawns.has(tabId)) return;
  const prevWindowId = await previousUserFocusedWindow(windowId);
  if (prevWindowId !== null) {
    focusRestoredSpawns.add(tabId);
    try {
      await chrome.windows.update(prevWindowId, { focused: true });
    } catch {
      // 창이 이미 닫혔을 수 있다 - best-effort
    }
  }
}

/**
 * 스코프가 도는 동안 그 소유 탭이 연 새 탭·창을 흡수한다.
 * 흡수했으면 true (전역 토글만 보는 옛 완화 로직은 건너뛴다).
 */
async function adoptSpawnedTab(record: SpawnedTabRecord, windowType: string): Promise<boolean> {
  if (adoptedTabs.has(record.tabId)) return true;
  const scope = await scopeForOpener(record.openerTabId);
  if (!scope) return false;
  adoptedTabs.add(record.tabId);
  adoptedTabScopes.set(record.tabId, scope);
  try {
    await addOwnedTab(record.tabId, scope.sessionKey);
  } catch {
    // 소유 등록 실패는 정리 경로가 창 단위로 한 번 더 걷는다.
  }
  if (windowType === 'popup') scope.popupWindowIds.add(record.windowId);
  await restoreUserView(record.tabId, record.windowId);
  return true;
}

/**
 * auto-chrome-mcp fork(F7): MCP 작업 탭이 연 팝업 창은 OS 포커스를 훔친다 —
 * 백그라운드 작업 모드 ON 이면 즉시 blur 해서 사용자가 쓰던 창으로 포커스를
 * 되돌린다 (팝업은 비포커스 상태로도 정상 렌더·스크립트 실행됨).
 */
async function unfocusPopupIfFromWorkTab(
  windowId: number,
  openerTabId: number | null,
): Promise<void> {
  try {
    if (openerTabId === null) return;
    if (!(await isBackgroundModeEnabled())) return;
    const workTabs = await getAllWorkTabs();
    if (!Object.values(workTabs).includes(openerTabId)) return;
    // 창 초기화 여유를 준 뒤 blur — 일부 사이트는 open 직후 focus 를 다시 잡으므로 2회.
    // v1.9.0: 전용 작업 창 생성 경로와 같은 코드를 쓰도록 utils/window-focus-guard.ts 로 뺐다.
    // (사용자 창 복귀까지 포함 — 팝업이 포커스를 끝내 놓지 않으면 사용자 창을 되돌린다)
    const userWindowId = await getCurrentUserWindowId();
    scheduleDeferredUnfocus(windowId, userWindowId);
  } catch {
    // 실패해도 기능 자체에는 영향 없음
  }
}

function prune(now: number): void {
  while (records.length > 0 && now - records[0].createdAt > TTL_MS) {
    records.shift();
  }
  while (records.length > MAX_RECORDS) {
    records.shift();
  }
}

function upsert(partial: Omit<SpawnedTabRecord, 'windowType'> & { windowType?: string }): void {
  const now = Date.now();
  prune(now);
  const existing = records.find((r) => r.tabId === partial.tabId);
  if (existing) {
    // webNavigation 이벤트가 늦게 와서 openerTabId/url 을 보강하는 경우
    if (partial.openerTabId !== null) existing.openerTabId = partial.openerTabId;
    if (partial.url) existing.url = partial.url;
    return;
  }
  records.push({
    tabId: partial.tabId,
    openerTabId: partial.openerTabId,
    url: partial.url,
    windowId: partial.windowId,
    windowType: partial.windowType ?? 'normal',
    createdAt: partial.createdAt,
  });
}

async function resolveWindowType(windowId: number): Promise<string> {
  try {
    const win = await chrome.windows.get(windowId);
    return win.type ?? 'normal';
  } catch {
    return 'normal';
  }
}

/**
 * `chrome.tabs.onActivated` 한 건. 리스너 본문을 함수로 뺀 것은 테스트가 크롬 이벤트를
 * 그대로 흉내 낼 수 있게 하려는 것이다 (jsdom 에는 `chrome.tabs.onActivated` 가 없다).
 *
 * 크롬이 주는 값은 `{tabId, windowId}` 뿐이다. `previousTabId` 는 없다 - 예전 코드가
 * 그 필드를 읽고 전역 대체값으로 떨어져 다중 창에서 엉뚱한 탭을 되돌린 원인이었다.
 */
export function noteTabActivated(tabId: number, windowId: number): void {
  if (typeof tabId !== 'number' || typeof windowId !== 'number') return;
  trackAdoption(async () => {
    // 흡수는 storage 조회를 기다리므로 이 활성화보다 늦게 끝날 수 있다. 같은 체인에
    // 실어 두면 여기 올 때는 흡수 판정이 이미 끝나 있다.
    if (adoptedTabs.has(tabId) || adoptedTabScopes.has(tabId)) {
      await restoreUserView(tabId, windowId);
      return;
    }
    // 자동화가 쥔 탭은 "사용자가 보던 화면" 이 아니다 - 되돌릴 대상으로 기록하지 않는다.
    if (await isAutomationTab(tabId)) return;
    rememberActivation(windowId, tabId);
  });
}

/** `chrome.windows.onFocusChanged` 한 건 (같은 이유로 함수로 뺐다). */
export function noteWindowFocus(windowId: number): void {
  if (typeof windowId !== 'number') return;
  rememberFocus(windowId);
}

// 리스너 등록 — background service worker 밖(테스트/popup 등)에서 import 되어도
// 죽지 않도록 API 존재를 가드한다 (auto-chrome-mcp fork)
try {
  // 화면 추적: 되돌릴 대상을 "스폰 직전에 실제로 활성이던 것" 으로 잡기 위한 두 리스너.
  chrome.tabs?.onActivated?.addListener((activeInfo) => {
    if (!activeInfo) return;
    noteTabActivated(activeInfo.tabId, activeInfo.windowId);
  });

  chrome.windows?.onFocusChanged?.addListener((windowId) => {
    noteWindowFocus(windowId);
  });

  chrome.tabs?.onCreated?.addListener((tab) => {
    if (typeof tab.id !== 'number') return;
    const rec = {
      tabId: tab.id,
      openerTabId: typeof tab.openerTabId === 'number' ? tab.openerTabId : null,
      url: tab.pendingUrl || tab.url || '',
      windowId: tab.windowId,
      createdAt: Date.now(),
    };
    upsert(rec);
    trackAdoption(async () => {
      const type = await resolveWindowType(tab.windowId);
      const existing = records.find((r) => r.tabId === tab.id);
      if (existing) existing.windowType = type;
      // 무간섭을 강제하는 실행이 열어 놓은 스코프가 먼저다 - 전역 토글을 보지 않는다.
      const adopted = await adoptSpawnedTab({ ...rec, windowType: type }, type);
      if (!adopted && type === 'popup') {
        await unfocusPopupIfFromWorkTab(tab.windowId, rec.openerTabId);
      }
    });
  });

  chrome.webNavigation?.onCreatedNavigationTarget?.addListener((details) => {
    upsert({
      tabId: details.tabId,
      openerTabId: details.sourceTabId,
      url: details.url,
      // windowId 는 tabs.onCreated 쪽 기록이 이미 갖고 있으면 병합됨; 신규면 -1 → 아래에서 보강
      windowId: records.find((r) => r.tabId === details.tabId)?.windowId ?? -1,
      createdAt: details.timeStamp,
    });
    trackAdoption(async () => {
      let windowId = records.find((r) => r.tabId === details.tabId)?.windowId ?? -1;
      try {
        const tab = await chrome.tabs.get(details.tabId);
        windowId = tab.windowId;
        const existing = records.find((r) => r.tabId === details.tabId);
        if (existing && existing.windowId === -1) existing.windowId = tab.windowId;
      } catch {
        return;
      }
      // onCreated 가 opener 를 몰랐던 경우 여기서 처음 소유가 정해진다.
      const type = await resolveWindowType(windowId);
      await adoptSpawnedTab(
        {
          tabId: details.tabId,
          openerTabId: details.sourceTabId,
          url: details.url,
          windowId,
          windowType: type,
          createdAt: details.timeStamp,
        },
        type,
      );
    });
  });

  chrome.tabs?.onRemoved?.addListener((tabId) => {
    const idx = records.findIndex((r) => r.tabId === tabId);
    if (idx >= 0) records.splice(idx, 1);
    adoptedTabs.delete(tabId);
    adoptedTabScopes.delete(tabId);
    focusRestoredSpawns.delete(tabId);
    // 닫힌 탭으로는 되돌리지 않는다.
    for (const [windowId, active] of lastActiveTabByWindow.entries()) {
      if (active === tabId) lastActiveTabByWindow.delete(windowId);
    }
  });
} catch {
  // chrome API 불가 환경 — 추적 없이 동작 (getSpawnedTabsSince 는 빈 결과)
}

/**
 * since 이후에 생성됐고, openerTabIds 중 하나가 연 (또는 opener 미상이지만
 * includeOrphans 허용 시) 새 탭 기록을 반환. 이미 닫힌 탭은 제외하도록
 * 호출부에서 chrome.tabs.get 검증을 권장하지만, onRemoved 로 대부분 정리됨.
 */
export function getSpawnedTabsSince(
  since: number,
  openerTabIds: number[],
  includeOrphans = false,
): SpawnedTabRecord[] {
  prune(Date.now());
  const openers = new Set(openerTabIds);
  return records.filter((r) => {
    if (r.createdAt < since) return false;
    if (r.openerTabId !== null) return openers.has(r.openerTabId);
    return includeOrphans;
  });
}

/** get_windows_and_tabs 강화용 — 최근 스폰 기록 전체 스냅샷 */
export function getRecentSpawnedTabs(): SpawnedTabRecord[] {
  prune(Date.now());
  return [...records];
}
