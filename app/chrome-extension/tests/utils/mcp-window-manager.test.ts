/**
 * auto-chrome-mcp fork — windows.onRemoved 가 창 id 재사용 시 새 작업 창 표지를 지우지 않는다.
 *
 * 재현하려는 실패 (2026-09-04 Codex 2차 검토):
 *   이전 작업 창(id=123)의 지연된 onRemoved(123) 가 marker lock 뒤에서 대기하는 동안,
 *   크롬이 **같은 id=123 으로 새 작업 창**을 만들어 새 표지를 등록한다. 예전 리스너는
 *   `marker.id === windowId` 만 보고 새 표지를 지웠다. 그러면 isMcpWindow(123) 이 false 가
 *   되어 새 작업 창을 사용자 창으로 오인하고, activation-guard 가 사용자 탭 활성화를 허용한다.
 *
 * 가드:
 *   1. 이벤트 시점 표지 스냅샷과 지금 표지가 다르면(새 창이 표지를 갈아 끼움) 지우지 않는다.
 *   2. 그 id 의 창이 지금도 존재하면(재사용) 지우지 않는다.
 *   3. 표지가 그대로이고 창이 실제로 닫혔으면 예전처럼 지운다.
 *
 * mcp-window-manager 는 import 시점에 chrome.windows.onRemoved 리스너를 달고 표지를 모듈
 * 스코프에 캐시하므로, mock 설치 → vi.resetModules() → 동적 import 순서로 격리한다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Manager = typeof import('@/utils/mcp-window-manager');

const SESSION_KEY = 'mcpWorkWindowId';

interface Marker {
  id: number;
  createdAt: number;
  type: string;
  tabIds: number[];
}

interface Harness {
  localStore: Record<string, unknown>;
  sessionStore: Record<string, unknown>;
  /** 지금 "존재한다"고 볼 창 id 집합 — chrome.windows.get 이 이걸 본다. */
  liveWindows: Set<number>;
}

function installChrome(): Harness {
  const localStore: Record<string, unknown> = {};
  const sessionStore: Record<string, unknown> = {};
  const liveWindows = new Set<number>();

  const toKeys = (keys: unknown): string[] =>
    Array.isArray(keys) ? (keys as string[]) : typeof keys === 'string' ? [keys] : [];

  const makeArea = (store: Record<string, unknown>) => ({
    get: vi.fn(async (keys: unknown) => {
      const out: Record<string, unknown> = {};
      for (const key of toKeys(keys)) if (key in store) out[key] = store[key];
      return out;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(store, items);
    }),
    remove: vi.fn(async (keys: unknown) => {
      for (const key of toKeys(keys)) delete store[key];
    }),
  });

  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { id: 'test-extension-id' },
    storage: { local: makeArea(localStore), session: makeArea(sessionStore) },
    windows: {
      get: vi.fn(async (windowId: number) => {
        if (!liveWindows.has(windowId)) throw new Error(`No window with id: ${windowId}`);
        return { id: windowId, type: 'normal', focused: false };
      }),
      getAll: vi.fn(async () => []),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onFocusChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };

  return { localStore, sessionStore, liveWindows };
}

async function loadManager(): Promise<Manager> {
  vi.resetModules();
  return await import('@/utils/mcp-window-manager');
}

const OLD_MARKER: Marker = { id: 123, createdAt: 100, type: 'normal', tabIds: [5] };
const NEW_MARKER: Marker = { id: 123, createdAt: 200, type: 'normal', tabIds: [9] };

describe('handleWindowRemoved — 창 id 재사용 시 새 표지를 지키다', () => {
  let h: Harness;

  beforeEach(() => {
    h = installChrome();
  });

  it('회귀(핵심): 대기 중 새 작업 창이 같은 id 로 표지를 갈아 끼웠으면 지우지 않는다', async () => {
    const mgr = await loadManager();
    // 이벤트가 대기하는 사이 새 작업 창이 등록한 표지가 지금 표지다.
    h.sessionStore[SESSION_KEY] = NEW_MARKER;
    // 그 새 창은 실제로 살아 있다 — 표지가 가리키는 창이 존재한다는 것이 재사용의 정의다.
    // (2026-09-04 항목 4: 판정 기준은 스냅샷 대조가 아니라 창 생존이다.)
    h.liveWindows.add(123);
    // 이벤트 시점 스냅샷은 옛 표지였다.
    await mgr.__testing.handleWindowRemoved(123, OLD_MARKER);

    // 새 표지를 지우면 안 된다.
    expect(h.sessionStore[SESSION_KEY]).toEqual(NEW_MARKER);
  });

  // =========================================================================
  // 항목 4 (2026-09-04 Codex 3차 검토): 진짜 닫힘인데 stale marker 가 남던 경로.
  //
  // 재현하려는 실패: onRemoved 스냅샷을 잡은 뒤 registerWorkWindowTab() 이 tabIds 만
  // 갱신하면 sameMarker() 가 false 가 된다. 예전 순서는 스냅샷 대조가 먼저라 "창이
  // 살아 있는지" 확인도 하기 전에 return 했고, 창이 진짜 닫혔는데 표지가 남았다.
  // 그 뒤 isMcpWindow(닫힌 id) 가 true 로 남아 판정이 계속 어긋난다.
  // =========================================================================
  it('회귀(항목 4): 스냅샷 이후 탭이 등록됐어도 창이 진짜 닫혔으면 표지를 지운다', async () => {
    const mgr = await loadManager();
    h.sessionStore[SESSION_KEY] = OLD_MARKER;

    // 이벤트 스냅샷(OLD_MARKER) 이후 작업 탭 등록이 끼어들어 tabIds 만 늘어났다.
    await mgr.registerWorkWindowTab(123, 7);
    expect((h.sessionStore[SESSION_KEY] as Marker).tabIds).toEqual([5, 7]);

    // 창은 실제로 닫혔다 (liveWindows 에 123 없음).
    await mgr.__testing.handleWindowRemoved(123, OLD_MARKER);

    expect(h.sessionStore[SESSION_KEY]).toBeUndefined();
  });

  it('회귀(핵심): 그 id 의 창이 지금도 존재하면(재사용) 표지를 지우지 않는다', async () => {
    const mgr = await loadManager();
    // 표지는 그대로지만(스냅샷 == 현재), 크롬이 같은 id 로 새 창을 살려 두었다.
    h.sessionStore[SESSION_KEY] = OLD_MARKER;
    h.liveWindows.add(123);

    await mgr.__testing.handleWindowRemoved(123, OLD_MARKER);

    expect(h.sessionStore[SESSION_KEY]).toEqual(OLD_MARKER);
  });

  it('표지가 그대로이고 창이 실제로 닫혔으면 예전처럼 지운다', async () => {
    const mgr = await loadManager();
    h.sessionStore[SESSION_KEY] = OLD_MARKER;
    // liveWindows 에 123 없음 → chrome.windows.get 실패 → 정말 닫힌 것.

    await mgr.__testing.handleWindowRemoved(123, OLD_MARKER);

    expect(h.sessionStore[SESSION_KEY]).toBeUndefined();
  });

  it('다른 창 id 의 onRemoved 는 우리 표지를 건드리지 않는다', async () => {
    const mgr = await loadManager();
    h.sessionStore[SESSION_KEY] = OLD_MARKER;

    await mgr.__testing.handleWindowRemoved(999, null);

    expect(h.sessionStore[SESSION_KEY]).toEqual(OLD_MARKER);
  });

  it('스냅샷이 없어도(cache 미로딩) 창 생존 확인만으로 재사용을 막는다', async () => {
    const mgr = await loadManager();
    h.sessionStore[SESSION_KEY] = OLD_MARKER;
    h.liveWindows.add(123);

    // 이벤트 시점 캐시가 비어 snapshot 이 null 이던 경우 — 창 생존 가드가 지켜야 한다.
    await mgr.__testing.handleWindowRemoved(123, null);

    expect(h.sessionStore[SESSION_KEY]).toEqual(OLD_MARKER);
  });
});
