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
import { getAllWorkTabs } from '@/utils/work-tab-manager';

const TTL_MS = 120_000;
const MAX_RECORDS = 30;

const records: SpawnedTabRecord[] = [];

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
    // 창 초기화 여유를 준 뒤 blur — 일부 사이트는 open 직후 focus 를 다시 잡으므로 2회
    setTimeout(() => {
      void chrome.windows.update(windowId, { focused: false }).catch(() => {});
    }, 300);
    setTimeout(() => {
      void chrome.windows.update(windowId, { focused: false }).catch(() => {});
    }, 1200);
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

// 리스너 등록 — background service worker 밖(테스트/popup 등)에서 import 되어도
// 죽지 않도록 API 존재를 가드한다 (auto-chrome-mcp fork)
try {
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
    void resolveWindowType(tab.windowId).then((type) => {
      const existing = records.find((r) => r.tabId === tab.id);
      if (existing) existing.windowType = type;
      if (type === 'popup') {
        void unfocusPopupIfFromWorkTab(tab.windowId, rec.openerTabId);
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
    void chrome.tabs
      .get(details.tabId)
      .then((tab) => {
        const existing = records.find((r) => r.tabId === details.tabId);
        if (existing && existing.windowId === -1) existing.windowId = tab.windowId;
      })
      .catch(() => {});
  });

  chrome.tabs?.onRemoved?.addListener((tabId) => {
    const idx = records.findIndex((r) => r.tabId === tabId);
    if (idx >= 0) records.splice(idx, 1);
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
