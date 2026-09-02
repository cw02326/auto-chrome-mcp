/**
 * auto-chrome-mcp fork — work-tab-manager unit tests (task C1, background work mode).
 *
 * 세션별 MCP 작업 탭 추적기의 계약을 검증한다:
 *   - 세션별 set/get 왕복
 *   - 닫힌 탭(chrome.tabs.get reject) 은 null + 기록 삭제
 *   - MAX_SESSIONS(10) 초과 시 LRU 퇴출 (조회로 갱신된 최근성 반영)
 *   - chrome.tabs.onRemoved 리스너가 해당 탭을 쓰는 세션 전부 정리
 *   - 뱃지("MCP") set/clear 호출
 *
 * 이 모듈은 import 시점에 chrome.tabs.onRemoved 리스너를 등록하고 map 을 모듈
 * 스코프에 캐시한다. 따라서 테스트마다 mock 을 먼저 설치 → vi.resetModules() →
 * 동적 import 순서로 격리한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type WorkTabManager = typeof import('@/utils/work-tab-manager');

interface ChromeHarness {
  sessionStore: Record<string, unknown>;
  openTabs: Set<number>;
  tabRemovedListeners: Array<(tabId: number, info: unknown) => void>;
  tabUpdatedListeners: Array<(tabId: number, info: unknown) => void>;
  setBadgeText: ReturnType<typeof vi.fn>;
  setBadgeBackgroundColor: ReturnType<typeof vi.fn>;
  sessionSet: ReturnType<typeof vi.fn>;
}

/** 마이크로태스크 큐를 비워, `void setBadge(...)` 같은 fire-and-forget 을 관측 가능하게 한다. */
async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function installChromeMocks(): ChromeHarness {
  const sessionStore: Record<string, unknown> = {};
  const openTabs = new Set<number>();
  const tabRemovedListeners: Array<(tabId: number, info: unknown) => void> = [];
  const tabUpdatedListeners: Array<(tabId: number, info: unknown) => void> = [];

  const toKeys = (keys: unknown): string[] =>
    Array.isArray(keys) ? (keys as string[]) : typeof keys === 'string' ? [keys] : [];

  const sessionSet = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(sessionStore, items);
  });
  const setBadgeText = vi.fn(async () => undefined);
  const setBadgeBackgroundColor = vi.fn(async () => undefined);

  const chromeMock = {
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
      session: {
        get: vi.fn(async (keys: unknown) => {
          const out: Record<string, unknown> = {};
          for (const key of toKeys(keys)) {
            if (key in sessionStore) out[key] = sessionStore[key];
          }
          return out;
        }),
        set: sessionSet,
        remove: vi.fn(async (keys: unknown) => {
          for (const key of toKeys(keys)) delete sessionStore[key];
        }),
      },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => {
        if (!openTabs.has(tabId)) throw new Error(`No tab with id: ${tabId}`);
        return { id: tabId, url: `https://example.com/tab/${tabId}` };
      }),
      onRemoved: {
        addListener: vi.fn((listener: (tabId: number, info: unknown) => void) => {
          tabRemovedListeners.push(listener);
        }),
        removeListener: vi.fn(),
      },
      // auto-chrome-mcp fork: 작업 탭 이동 시 페이지 표시기를 다시 붙이는 리스너용
      onUpdated: {
        addListener: vi.fn((listener: (tabId: number, info: unknown) => void) => {
          tabUpdatedListeners.push(listener);
        }),
        removeListener: vi.fn(),
      },
      remove: vi.fn(async (tabId: number) => {
        openTabs.delete(tabId);
      }),
    },
    scripting: {
      executeScript: vi.fn(async () => [{ result: undefined }]),
    },
    action: {
      setBadgeText,
      setBadgeBackgroundColor,
    },
  };

  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;

  return {
    sessionStore,
    openTabs,
    tabRemovedListeners,
    tabUpdatedListeners,
    setBadgeText,
    setBadgeBackgroundColor,
    sessionSet,
  };
}

async function loadModule(): Promise<WorkTabManager> {
  vi.resetModules();
  return await import('@/utils/work-tab-manager');
}

describe('work-tab-manager (auto-chrome-mcp fork — 세션별 MCP 작업 탭)', () => {
  let h: ChromeHarness;

  beforeEach(() => {
    h = installChromeMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('세션별로 작업 탭을 저장하고 그대로 돌려준다 (set/get 왕복)', async () => {
    const mod = await loadModule();
    h.openTabs.add(11);
    h.openTabs.add(22);

    await mod.setWorkTab(11, 'session-a');
    await mod.setWorkTab(22, 'session-b');

    expect(await mod.getWorkTabId('session-a')).toBe(11);
    expect(await mod.getWorkTabId('session-b')).toBe(22);
    expect(await mod.getWorkTabId('session-unknown')).toBeNull();
    expect(await mod.getAllWorkTabs()).toEqual({ 'session-a': 11, 'session-b': 22 });
  });

  it('sessionId 를 생략하면 DEFAULT_SESSION_ID 버킷을 쓴다', async () => {
    const mod = await loadModule();
    h.openTabs.add(5);

    await mod.setWorkTab(5);

    expect(await mod.getWorkTabId()).toBe(5);
    expect(await mod.getWorkTabId(mod.DEFAULT_SESSION_ID)).toBe(5);
    expect(await mod.getAllWorkTabs()).toEqual({ [mod.DEFAULT_SESSION_ID]: 5 });
  });

  it('chrome.storage.session 에 persist 한다 (MV3 service worker 재시작 대비)', async () => {
    const mod = await loadModule();
    h.openTabs.add(77);

    await mod.setWorkTab(77, 'session-a');

    expect(h.sessionSet).toHaveBeenCalled();
    expect(h.sessionStore.mcpWorkTabs).toMatchObject({
      'session-a': { tabId: 77 },
    });

    // 새로 import 한 모듈(=SW 재시작)이 storage 에서 복구
    const reloaded = await loadModule();
    expect(await reloaded.getWorkTabId('session-a')).toBe(77);
  });

  it('탭이 닫혀 chrome.tabs.get 이 reject 하면 null 을 주고 기록을 지운다', async () => {
    const mod = await loadModule();
    h.openTabs.add(33);
    await mod.setWorkTab(33, 'session-a');
    expect(await mod.getWorkTabId('session-a')).toBe(33);

    h.openTabs.delete(33); // 사용자가 탭을 닫음

    expect(await mod.getWorkTabId('session-a')).toBeNull();
    expect(await mod.getAllWorkTabs()).toEqual({});
    expect(h.sessionStore.mcpWorkTabs).toEqual({});
  });

  it('MAX_SESSIONS 를 넘으면 가장 오래 안 쓴 세션을 LRU 로 퇴출한다', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const mod = await loadModule();

    for (let i = 0; i < mod.MAX_SESSIONS; i++) {
      h.openTabs.add(100 + i);
      await mod.setWorkTab(100 + i, `s${i}`);
      vi.setSystemTime(Date.now() + 1000);
    }
    expect(Object.keys(await mod.getAllWorkTabs())).toHaveLength(mod.MAX_SESSIONS);

    // 11번째 세션 → 가장 오래된 s0 퇴출
    h.openTabs.add(999);
    await mod.setWorkTab(999, 'newcomer');

    const all = await mod.getAllWorkTabs();
    expect(Object.keys(all)).toHaveLength(mod.MAX_SESSIONS);
    expect(all).not.toHaveProperty('s0');
    expect(all.newcomer).toBe(999);
    expect(all.s1).toBe(101);

    // 퇴출된 세션의 탭은 뱃지가 꺼진다
    await flush();
    expect(h.setBadgeText).toHaveBeenCalledWith({ tabId: 100, text: '' });
  });

  it('LRU 는 조회(getWorkTabId) 로 갱신된 최근성을 반영한다', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const mod = await loadModule();

    for (let i = 0; i < mod.MAX_SESSIONS; i++) {
      h.openTabs.add(200 + i);
      await mod.setWorkTab(200 + i, `s${i}`);
      vi.setSystemTime(Date.now() + 1000);
    }

    // 가장 오래된 s0 를 조회 → 최근 사용으로 승격
    expect(await mod.getWorkTabId('s0')).toBe(200);
    vi.setSystemTime(Date.now() + 1000);

    h.openTabs.add(999);
    await mod.setWorkTab(999, 'newcomer');

    const all = await mod.getAllWorkTabs();
    expect(all).toHaveProperty('s0', 200); // 살아남음
    expect(all).not.toHaveProperty('s1'); // 이제 s1 이 최고령
  });

  it('chrome.tabs.onRemoved 리스너가 그 탭을 쓰던 세션을 전부 지운다', async () => {
    const mod = await loadModule();
    expect(h.tabRemovedListeners).toHaveLength(1); // import 시점 등록

    h.openTabs.add(42);
    h.openTabs.add(43);
    await mod.setWorkTab(42, 'session-a');
    await mod.setWorkTab(42, 'session-b'); // 같은 탭을 공유
    await mod.setWorkTab(43, 'session-c');

    h.openTabs.delete(42);
    h.tabRemovedListeners[0](42, { windowId: 1, isWindowClosing: false });
    await flush(10);

    expect(await mod.getAllWorkTabs()).toEqual({ 'session-c': 43 });
    expect(h.sessionStore.mcpWorkTabs).toEqual({
      // auto-chrome-mcp fork: owned = MCP 가 직접 만든 탭인지 (재사용 대상 판정용)
      'session-c': { tabId: 43, lastUsedAt: expect.any(Number), owned: false },
    });
  });

  it('관련 없는 탭이 닫히면 onRemoved 는 아무것도 건드리지 않는다', async () => {
    const mod = await loadModule();
    h.openTabs.add(42);
    await mod.setWorkTab(42, 'session-a');

    h.tabRemovedListeners[0](9999, { windowId: 1, isWindowClosing: false });
    await flush(10);

    expect(await mod.getAllWorkTabs()).toEqual({ 'session-a': 42 });
  });

  it('작업 탭 지정 시 "MCP" 뱃지를, 해제 시 빈 뱃지를 설정한다', async () => {
    const mod = await loadModule();
    h.openTabs.add(7);

    await mod.setWorkTab(7, 'session-a');
    await flush();
    expect(h.setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: 'MCP' });
    expect(h.setBadgeBackgroundColor).toHaveBeenCalledWith({ tabId: 7, color: '#6d28d9' });

    h.setBadgeText.mockClear();
    await mod.clearWorkTab('session-a');
    await flush();
    expect(h.setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: '' });
    expect(await mod.getAllWorkTabs()).toEqual({});
  });

  it('세션의 작업 탭을 옮기면 이전 탭 뱃지를 끄고 새 탭에 켠다', async () => {
    const mod = await loadModule();
    h.openTabs.add(7);
    h.openTabs.add(8);

    await mod.setWorkTab(7, 'session-a');
    await flush();
    h.setBadgeText.mockClear();

    await mod.setWorkTab(8, 'session-a');
    await flush();

    expect(h.setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: '' });
    expect(h.setBadgeText).toHaveBeenCalledWith({ tabId: 8, text: 'MCP' });
    expect(await mod.getWorkTabId('session-a')).toBe(8);
  });

  it('다른 세션이 아직 그 탭을 쓰고 있으면 뱃지를 끄지 않는다', async () => {
    const mod = await loadModule();
    h.openTabs.add(7);

    await mod.setWorkTab(7, 'session-a');
    await mod.setWorkTab(7, 'session-b');
    await flush();
    h.setBadgeText.mockClear();

    await mod.clearWorkTab('session-a');
    await flush();

    expect(h.setBadgeText).not.toHaveBeenCalledWith({ tabId: 7, text: '' });
    expect(await mod.getWorkTabId('session-b')).toBe(7);
  });

  it('없는 세션을 clear 해도 조용히 넘어간다 (뱃지 호출 없음)', async () => {
    const mod = await loadModule();

    await mod.clearWorkTab('nope');
    await flush();

    expect(h.setBadgeText).not.toHaveBeenCalled();
  });

  it('storage.session 이 실패해도 in-memory 캐시로 계속 동작한다', async () => {
    const mod = await loadModule();
    h.openTabs.add(50);
    const chromeAny = globalThis.chrome as unknown as {
      storage: { session: { set: ReturnType<typeof vi.fn> } };
    };
    chromeAny.storage.session.set.mockRejectedValue(new Error('session storage unavailable'));

    await mod.setWorkTab(50, 'session-a');

    expect(await mod.getWorkTabId('session-a')).toBe(50);
  });
});
