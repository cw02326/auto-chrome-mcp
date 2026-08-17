/**
 * Dedicated MCP work window policy + tracker (scalemaker fork).
 *
 * 백그라운드 작업 모드가 ON 일 때, MCP 작업 탭들을 사용자의 창이 아니라 별도의
 * "MCP 작업 창" 하나에 모아 둔다. 세션별 작업 탭(최대 10개, work-tab-manager)이
 * 한 창에 모이므로 사용자의 브라우징과 물리적·시각적으로 분리된다.
 *
 * - 창은 항상 focused: false 로 생성 — OS 포커스를 절대 가로채지 않는다.
 *   (강제 포커스 정책 utils/focus-policy.ts 와 무관하게 이 창 생성은 언제나 비포커스)
 * - 창 id 는 chrome.storage.session 에 persist + in-memory 캐시
 *   (MV3 service worker 가 수시로 죽으므로. 브라우저 재시작 시 초기화 — 의도된 수명)
 * - 사용자가 이 창을 닫으면 onRemoved 로 기록을 지우고, 다음 요청 때 새로 만든다.
 * - 모든 실패는 null 로 흘려보낸다 — 호출부는 반드시 기존(사용자 창) 동작으로 graceful fallback.
 *
 * 기본값 true — 별도 설정 없이 분리 동작. popup 토글로 OFF 가능.
 */

const STORAGE_KEY = 'dedicatedWorkWindow';
const SESSION_KEY = 'mcpWorkWindowId';

const MCP_WINDOW_WIDTH = 1280;
const MCP_WINDOW_HEIGHT = 900;

export async function isDedicatedWindowEnabled(): Promise<boolean> {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEY]);
    return result[STORAGE_KEY] !== false;
  } catch {
    return true;
  }
}

export async function setDedicatedWindowEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: enabled });
}

export const DEDICATED_WINDOW_STORAGE_KEY = STORAGE_KEY;

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
