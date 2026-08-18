/**
 * MCP work-window policy + tracker (auto-chrome-mcp fork).
 *
 * MCP 작업 탭을 "어느 창에" 만들지 결정한다. 두 가지 모드:
 *
 *  - 'current' (기본) — 사용자가 이미 열어 둔 일반 크롬 창에 **새 탭**을 만든다.
 *    탭은 항상 비활성(백그라운드)으로 생성해 사용자가 보던 탭을 뺏지 않는다.
 *    스크린샷·읽기는 CDP 경로라 탭이 보이지 않아도 정상 동작한다.
 *
 *  - 'dedicated' — MCP 작업 탭들을 별도의 "MCP 작업 창" 하나에 모아 사용자 창과
 *    물리적으로 분리한다. 대량 크롤링처럼 탭이 많이 필요할 때 유용.
 *    창은 항상 focused: false 로 생성 — OS 포커스를 절대 가로채지 않는다.
 *    (강제 포커스 정책 utils/focus-policy.ts 와 무관하게 이 창 생성은 언제나 비포커스)
 *
 * 어느 모드든 실패는 null 로 흘려보낸다 — 호출부는 반드시 기존 동작으로 graceful fallback.
 *
 * 창 id 는 chrome.storage.session 에 persist + in-memory 캐시
 * (MV3 service worker 가 수시로 죽으므로. 브라우저 재시작 시 초기화 — 의도된 수명)
 */

export type WorkWindowMode = 'current' | 'dedicated';

const MODE_STORAGE_KEY = 'mcpWorkWindowMode';
/** v1.3.0 이전의 boolean 설정 — true = dedicated, false = current */
const LEGACY_STORAGE_KEY = 'dedicatedWorkWindow';
const SESSION_KEY = 'mcpWorkWindowId';

const MCP_WINDOW_WIDTH = 1280;
const MCP_WINDOW_HEIGHT = 900;

export const DEFAULT_WORK_WINDOW_MODE: WorkWindowMode = 'current';

/**
 * 현재 작업 창 모드. 신규 키 우선, 없으면 legacy boolean 을 해석, 둘 다 없으면 기본값.
 */
export async function getWorkWindowMode(): Promise<WorkWindowMode> {
  try {
    const result = await chrome.storage.local.get([MODE_STORAGE_KEY, LEGACY_STORAGE_KEY]);
    const mode = result[MODE_STORAGE_KEY];
    if (mode === 'current' || mode === 'dedicated') return mode;
    const legacy = result[LEGACY_STORAGE_KEY];
    if (legacy === true) return 'dedicated';
    if (legacy === false) return 'current';
    return DEFAULT_WORK_WINDOW_MODE;
  } catch {
    return DEFAULT_WORK_WINDOW_MODE;
  }
}

/**
 * 모드 저장. legacy boolean 도 함께 동기화해 구버전 코드/설정 화면과 어긋나지 않게 한다.
 */
export async function setWorkWindowMode(mode: WorkWindowMode): Promise<void> {
  await chrome.storage.local.set({
    [MODE_STORAGE_KEY]: mode,
    [LEGACY_STORAGE_KEY]: mode === 'dedicated',
  });
}

/** 하위 호환 wrapper — 'dedicated' 모드인지 여부. */
export async function isDedicatedWindowEnabled(): Promise<boolean> {
  return (await getWorkWindowMode()) === 'dedicated';
}

/** 하위 호환 wrapper. */
export async function setDedicatedWindowEnabled(enabled: boolean): Promise<void> {
  await setWorkWindowMode(enabled ? 'dedicated' : 'current');
}

export const WORK_WINDOW_MODE_STORAGE_KEY = MODE_STORAGE_KEY;
export const DEDICATED_WINDOW_STORAGE_KEY = LEGACY_STORAGE_KEY;

let cachedWindowId: number | null = null;
let cacheLoaded = false;
// 동시 호출(병렬 navigate)이 창을 두 개 만들지 않도록 생성 중인 promise 를 공유
let creating: Promise<number | null> | null = null;

async function loadCache(): Promise<number | null> {
  if (cacheLoaded) return cachedWindowId;
  try {
    const result = await chrome.storage.session.get([SESSION_KEY]);
    const raw = result[SESSION_KEY];
    cachedWindowId = typeof raw === 'number' ? raw : null;
  } catch {
    cachedWindowId = null;
  }
  cacheLoaded = true;
  return cachedWindowId;
}

async function persistWindowId(windowId: number | null): Promise<void> {
  cachedWindowId = windowId;
  cacheLoaded = true;
  try {
    if (windowId === null) {
      await chrome.storage.session.remove(SESSION_KEY);
    } else {
      await chrome.storage.session.set({ [SESSION_KEY]: windowId });
    }
  } catch {
    // storage.session 실패해도 in-memory 캐시로 동작
  }
}

/**
 * "MCP 작업 창" id 를 반환. 없거나 이미 닫혔으면 새로 만든다 (항상 비포커스).
 * 어떤 이유로든 실패하면 null — 호출부는 기존 동작으로 fallback 해야 한다.
 */
export async function getOrCreateMcpWindow(): Promise<number | null> {
  try {
    const stored = await loadCache();
    if (stored !== null) {
      try {
        await chrome.windows.get(stored);
        return stored;
      } catch {
        // 사용자가 창을 닫았음 — 기록 정리 후 새로 생성
        await persistWindowId(null);
      }
    }

    if (creating) return await creating;

    creating = (async () => {
      const created = await chrome.windows.create({
        // 절대 focused: true 로 바꾸지 말 것 — 사용자 작업 중 OS 포커스를 뺏는다.
        focused: false,
        url: 'about:blank',
        width: MCP_WINDOW_WIDTH,
        height: MCP_WINDOW_HEIGHT,
        type: 'normal',
      });
      if (!created || typeof created.id !== 'number') return null;
      await persistWindowId(created.id);
      return created.id;
    })();

    try {
      return await creating;
    } finally {
      creating = null;
    }
  } catch (error) {
    console.warn('[mcp-window-manager] Failed to get/create MCP work window:', error);
    return null;
  }
}

/**
 * 'current' 모드용 — 사용자가 이미 열어 둔 창 중 작업 탭을 붙일 창 id.
 *
 * 선택 규칙 (앞순위부터):
 *   1) 마지막으로 포커스됐던 창이 적격이면 그 창
 *   2) 현재 포커스된 적격 창
 *   3) 남은 적격 창 중 첫 번째
 *
 * 적격 = type 'normal' (팝업·개발자도구·앱 창 제외) + 시크릿 아님(확장 권한 밖) +
 *        이전에 만들어 둔 전용 MCP 작업 창이 아님.
 * 열린 일반 창이 하나도 없으면 null — 호출부가 새 창 생성으로 fallback 한다.
 */
export async function getCurrentUserWindowId(): Promise<number | null> {
  try {
    const dedicatedId = await loadCache();
    const all = await chrome.windows.getAll({ populate: false });
    const usable = all.filter(
      (w) =>
        w.type === 'normal' && typeof w.id === 'number' && w.id !== dedicatedId && !w.incognito,
    );
    if (usable.length === 0) return null;

    try {
      const last = await chrome.windows.getLastFocused({ populate: false });
      const match = usable.find((w) => w.id === last?.id);
      if (match?.id !== undefined) return match.id;
    } catch {
      // getLastFocused 실패 — 아래 순위로 진행
    }

    const focused = usable.find((w) => w.focused);
    const picked = focused ?? usable[0];
    return picked.id ?? null;
  } catch (error) {
    console.warn('[mcp-window-manager] Failed to resolve current user window:', error);
    return null;
  }
}

/**
 * 주어진 창이 현재의 "MCP 작업 창" 인지 확인 (기록된 id 와 일치 + 아직 살아있음).
 */
export async function isMcpWindow(windowId: number | undefined | null): Promise<boolean> {
  if (typeof windowId !== 'number') return false;
  try {
    const stored = await loadCache();
    if (stored === null || stored !== windowId) return false;
    await chrome.windows.get(windowId);
    return true;
  } catch {
    return false;
  }
}

// 사용자가 "MCP 작업 창"을 직접 닫으면 기록을 비운다 → 다음 요청 때 새 창 생성.
// (popup 등 chrome.windows 를 못 쓰는 컨텍스트에서 import 돼도 죽지 않도록 가드)
try {
  chrome.windows?.onRemoved?.addListener((windowId) => {
    void (async () => {
      try {
        const stored = await loadCache();
        if (stored === windowId) {
          await persistWindowId(null);
        }
      } catch {
        // ignore
      }
    })();
  });
} catch {
  // ignore
}
