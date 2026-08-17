/**
 * ScaleMaker fork — background-mode / mcp-window-manager 정책 접근자 테스트 (task C1).
 *
 * 두 모듈 모두 "기본값 true" 시맨틱: 키가 없으면(undefined) 켜짐, 명시적 false 만 꺼짐,
 * storage 읽기 실패 시에도 켜짐(fail-safe). setter 는 정해진 키에만 쓴다.
 *
 * mcp-window-manager 는 import 시점에 chrome.windows.onRemoved 리스너를 등록하고
 * 창 id 를 모듈 스코프에 캐시하므로, mock 설치 → vi.resetModules() → 동적 import 로 격리한다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type BackgroundMode = typeof import('@/utils/background-mode');
type McpWindowManager = typeof import('@/utils/mcp-window-manager');

interface ChromeHarness {
  localStore: Record<string, unknown>;
  sessionStore: Record<string, unknown>;
  openWindows: Set<number>;
  windowRemovedListeners: Array<(windowId: number) => void>;
  localGet: ReturnType<typeof vi.fn>;
  localSet: ReturnType<typeof vi.fn>;
  windowsCreate: ReturnType<typeof vi.fn>;
}

async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function installChromeMocks(): ChromeHarness {
  const localStore: Record<string, unknown> = {};
  const sessionStore: Record<string, unknown> = {};
  const openWindows = new Set<number>();
  const windowRemovedListeners: Array<(windowId: number) => void> = [];
  let nextWindowId = 1000;

  const toKeys = (keys: unknown): string[] =>
    Array.isArray(keys) ? (keys as string[]) : typeof keys === 'string' ? [keys] : [];

  const makeArea = (store: Record<string, unknown>) => ({
    get: vi.fn(async (keys: unknown) => {
      const out: Record<string, unknown> = {};
      for (const key of toKeys(keys)) {
        if (key in store) out[key] = store[key];
      }
      return out;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(store, items);
    }),
    remove: vi.fn(async (keys: unknown) => {
      for (const key of toKeys(keys)) delete store[key];
    }),
  });

  const local = makeArea(localStore);
  const session = makeArea(sessionStore);

  const windowsCreate = vi.fn(async (createData: Record<string, unknown>) => {
    const id = nextWindowId++;
    openWindows.add(id);
    return { id, ...createData };
  });

  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local, session },
    tabs: {
      get: vi.fn(async () => ({ id: 1, url: 'https://example.com/' })),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    windows: {
      get: vi.fn(async (windowId: number) => {
        if (!openWindows.has(windowId)) throw new Error(`No window with id: ${windowId}`);
        return { id: windowId };
      }),
      getLastFocused: vi.fn(async () => ({ id: 1 })),
      create: windowsCreate,
      remove: vi.fn(async () => undefined),
      onRemoved: {
        addListener: vi.fn((listener: (windowId: number) => void) => {
          windowRemovedListeners.push(listener);
        }),
        removeListener: vi.fn(),
      },
    },
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
    },
  };

  return {
    localStore,
    sessionStore,
    openWindows,
    windowRemovedListeners,
    localGet: local.get,
    localSet: local.set,
    windowsCreate,
  };
}

async function loadBackgroundMode(): Promise<BackgroundMode> {
  vi.resetModules();
  return await import('@/utils/background-mode');
}

async function loadWindowManager(): Promise<McpWindowManager> {
  vi.resetModules();
  return await import('@/utils/mcp-window-manager');
}

describe('background-mode (scalemaker fork — 백그라운드 작업 모드 정책)', () => {
  let h: ChromeHarness;

  beforeEach(() => {
    h = installChromeMocks();
  });

  it('키가 없으면(undefined) 켜짐이 기본값이다', async () => {
    const mod = await loadBackgroundMode();
    expect(await mod.isBackgroundModeEnabled()).toBe(true);
  });

  it('명시적 false 만 꺼짐으로 읽고, true 는 켜짐', async () => {
    const mod = await loadBackgroundMode();
    h.localStore.backgroundWorkMode = false;
    expect(await mod.isBackgroundModeEnabled()).toBe(false);
    h.localStore.backgroundWorkMode = true;
    expect(await mod.isBackgroundModeEnabled()).toBe(true);
  });

  it('0·null 같은 falsy 값은 꺼짐으로 보지 않는다 (!== false 시맨틱)', async () => {
    const mod = await loadBackgroundMode();
    h.localStore.backgroundWorkMode = 0;
    expect(await mod.isBackgroundModeEnabled()).toBe(true);
    h.localStore.backgroundWorkMode = null;
    expect(await mod.isBackgroundModeEnabled()).toBe(true);
  });

  it('storage 읽기 실패 시에도 켜짐으로 fail-safe', async () => {
    const mod = await loadBackgroundMode();
    h.localGet.mockRejectedValueOnce(new Error('storage down'));
    expect(await mod.isBackgroundModeEnabled()).toBe(true);
  });

  it('setter 는 backgroundWorkMode 키에만 쓴다', async () => {
    const mod = await loadBackgroundMode();
    await mod.setBackgroundModeEnabled(false);
    expect(h.localSet).toHaveBeenCalledWith({ backgroundWorkMode: false });
    expect(h.localStore).toEqual({ backgroundWorkMode: false });

    await mod.setBackgroundModeEnabled(true);
    expect(await mod.isBackgroundModeEnabled()).toBe(true);
    expect(mod.BACKGROUND_MODE_STORAGE_KEY).toBe('backgroundWorkMode');
  });
});

describe('mcp-window-manager (scalemaker fork — 전용 MCP 작업 창)', () => {
  let h: ChromeHarness;

  beforeEach(() => {
    h = installChromeMocks();
  });

  describe('정책 접근자', () => {
    it('키가 없으면 켜짐이 기본값이다', async () => {
      const mod = await loadWindowManager();
      expect(await mod.isDedicatedWindowEnabled()).toBe(true);
    });

    it('명시적 false 만 꺼짐으로 읽는다', async () => {
      const mod = await loadWindowManager();
      h.localStore.dedicatedWorkWindow = false;
      expect(await mod.isDedicatedWindowEnabled()).toBe(false);
      h.localStore.dedicatedWorkWindow = true;
      expect(await mod.isDedicatedWindowEnabled()).toBe(true);
    });

    it('storage 읽기 실패 시에도 켜짐으로 fail-safe', async () => {
      const mod = await loadWindowManager();
      h.localGet.mockRejectedValueOnce(new Error('storage down'));
      expect(await mod.isDedicatedWindowEnabled()).toBe(true);
    });

    it('setter 는 dedicatedWorkWindow 키에만 쓴다', async () => {
      const mod = await loadWindowManager();
      await mod.setDedicatedWindowEnabled(false);
      expect(h.localSet).toHaveBeenCalledWith({ dedicatedWorkWindow: false });
      expect(h.localStore).toEqual({ dedicatedWorkWindow: false });
      expect(mod.DEDICATED_WINDOW_STORAGE_KEY).toBe('dedicatedWorkWindow');
    });
  });

  describe('작업 창 수명주기', () => {
    it('작업 창은 항상 비포커스(focused:false) 로 만든다 — OS 포커스 탈취 금지', async () => {
      const mod = await loadWindowManager();

      const windowId = await mod.getOrCreateMcpWindow();

      expect(windowId).toBe(1000);
      expect(h.windowsCreate).toHaveBeenCalledTimes(1);
      expect(h.windowsCreate.mock.calls[0][0]).toMatchObject({ focused: false, type: 'normal' });
    });

    it('창 id 를 storage.session 에 기록하고 재사용한다', async () => {
      const mod = await loadWindowManager();

      const first = await mod.getOrCreateMcpWindow();
      expect(h.sessionStore.mcpWorkWindowId).toBe(first);

      const second = await mod.getOrCreateMcpWindow();
      expect(second).toBe(first);
      expect(h.windowsCreate).toHaveBeenCalledTimes(1);

      // SW 재시작(모듈 재로드) 후에도 storage 기록으로 복구되어 재사용
      const reloaded = await loadWindowManager();
      expect(await reloaded.getOrCreateMcpWindow()).toBe(first);
      expect(h.windowsCreate).toHaveBeenCalledTimes(1);
    });

    it('기록된 창이 이미 닫혀 있으면 새로 만든다', async () => {
      const mod = await loadWindowManager();
      const first = await mod.getOrCreateMcpWindow();

      h.openWindows.delete(first as number);

      const second = await mod.getOrCreateMcpWindow();
      expect(second).not.toBe(first);
      expect(h.windowsCreate).toHaveBeenCalledTimes(2);
    });

    it('동시 호출이 창을 두 개 만들지 않는다', async () => {
      const mod = await loadWindowManager();

      const [a, b, c] = await Promise.all([
        mod.getOrCreateMcpWindow(),
        mod.getOrCreateMcpWindow(),
        mod.getOrCreateMcpWindow(),
      ]);

      expect(a).toBe(b);
      expect(b).toBe(c);
      expect(h.windowsCreate).toHaveBeenCalledTimes(1);
    });

    it('창 생성이 실패하면 null 로 흘려보낸다 (호출부 fallback)', async () => {
      const mod = await loadWindowManager();
      h.windowsCreate.mockRejectedValueOnce(new Error('cannot create window'));

      expect(await mod.getOrCreateMcpWindow()).toBeNull();
    });

    it('windows.onRemoved 로 사용자가 작업 창을 닫으면 기록을 비운다', async () => {
      const mod = await loadWindowManager();
      expect(h.windowRemovedListeners).toHaveLength(1); // import 시점 등록

      const first = await mod.getOrCreateMcpWindow();
      h.openWindows.delete(first as number);
      h.windowRemovedListeners[0](first as number);
      await flush(10);

      expect(h.sessionStore.mcpWorkWindowId).toBeUndefined();

      const second = await mod.getOrCreateMcpWindow();
      expect(second).not.toBe(first);
    });

    it('다른 창이 닫히는 것은 무시한다', async () => {
      const mod = await loadWindowManager();
      const first = await mod.getOrCreateMcpWindow();

      h.windowRemovedListeners[0](424242);
      await flush(10);

      expect(h.sessionStore.mcpWorkWindowId).toBe(first);
    });

    it('isMcpWindow 는 현재 기록된 살아있는 창에만 true', async () => {
      const mod = await loadWindowManager();

      expect(await mod.isMcpWindow(undefined)).toBe(false);
      expect(await mod.isMcpWindow(null)).toBe(false);

      const first = await mod.getOrCreateMcpWindow();
      expect(await mod.isMcpWindow(first)).toBe(true);
      expect(await mod.isMcpWindow((first as number) + 1)).toBe(false);

      h.openWindows.delete(first as number);
      expect(await mod.isMcpWindow(first)).toBe(false);
    });
  });
});
