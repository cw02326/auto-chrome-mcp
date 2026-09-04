/**
 * auto-chrome-mcp fork — mcp-tab-group unit tests.
 *
 * MCP 작업 탭을 크롬 탭 그룹 "MCP"(green) 로 묶는 유틸의 계약을 검증한다:
 *   - 그룹 생성: 같은 창에 "MCP" 그룹이 없으면 만들고 제목·색·collapsed:false 지정
 *   - 그룹 재사용: 같은 창에 이미 있으면 tabGroups.update 를 다시 부르지 않는다
 *   - 창마다 그룹 하나: 다른 창의 탭은 그 창의 그룹으로 간다
 *   - 설정 OFF(mcpTabGroupEnabled:false) 면 아무 API 도 부르지 않고 null
 *   - API 실패(권한 없음/그룹 API 미지원/탭 사라짐) 는 예외 없이 null
 *   - 무간섭 원칙: tabs.update({active}) / windows.update({focused}) 를 절대 부르지 않는다
 *   - work-tab-manager 의 setWorkTab 이 이 편입을 실제로 호출한다 (단일 관문 확인)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type McpTabGroup = typeof import('@/utils/mcp-tab-group');
type WorkTabManager = typeof import('@/utils/work-tab-manager');

interface FakeTab {
  id: number;
  windowId: number;
  groupId: number;
}

interface FakeGroup {
  id: number;
  title?: string;
  color: string;
  windowId: number;
  collapsed: boolean;
}

interface ChromeHarness {
  localStore: Record<string, unknown>;
  sessionStore: Record<string, unknown>;
  tabs: Map<number, FakeTab>;
  groups: FakeGroup[];
  /** 그룹 API 자체를 없앤 환경(구버전 크롬)을 흉내낸다. */
  removeTabGroupApi: () => void;
  tabsGet: ReturnType<typeof vi.fn>;
  tabsGroup: ReturnType<typeof vi.fn>;
  tabsUpdate: ReturnType<typeof vi.fn>;
  groupsQuery: ReturnType<typeof vi.fn>;
  groupsUpdate: ReturnType<typeof vi.fn>;
  windowsUpdate: ReturnType<typeof vi.fn>;
}

const TAB_GROUP_ID_NONE = -1;

/** 마이크로태스크 큐를 비워 `void setBadge(...)` 같은 fire-and-forget 을 관측 가능하게 한다. */
async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function installChromeMocks(): ChromeHarness {
  const localStore: Record<string, unknown> = {};
  const sessionStore: Record<string, unknown> = {};
  const tabs = new Map<number, FakeTab>();
  const groups: FakeGroup[] = [];
  let nextGroupId = 900;

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

  const tabsGet = vi.fn(async (tabId: number) => {
    const tab = tabs.get(tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}`);
    return { ...tab, url: `https://example.com/tab/${tabId}` };
  });

  const tabsGroup = vi.fn(
    async (options: {
      tabIds?: number | number[];
      groupId?: number;
      createProperties?: { windowId?: number };
    }) => {
      const ids = Array.isArray(options.tabIds)
        ? options.tabIds
        : typeof options.tabIds === 'number'
          ? [options.tabIds]
          : [];
      let groupId = options.groupId;
      if (typeof groupId !== 'number') {
        groupId = nextGroupId++;
        groups.push({
          id: groupId,
          title: undefined,
          color: 'grey',
          windowId: options.createProperties?.windowId ?? 1,
          collapsed: false,
        });
      }
      for (const id of ids) {
        const tab = tabs.get(id);
        if (tab) tab.groupId = groupId;
      }
      return groupId;
    },
  );

  const tabsUpdate = vi.fn(async () => ({}));
  const windowsUpdate = vi.fn(async () => ({ id: 1 }));

  const groupsQuery = vi.fn(async (info: { windowId?: number; title?: string }) =>
    groups
      .filter((g) => (typeof info.windowId === 'number' ? g.windowId === info.windowId : true))
      .filter((g) => (typeof info.title === 'string' ? g.title === info.title : true))
      .map((g) => ({ ...g })),
  );

  const groupsUpdate = vi.fn(
    async (
      groupId: number,
      props: { title?: string; color?: string; collapsed?: boolean },
    ): Promise<FakeGroup> => {
      const group = groups.find((g) => g.id === groupId);
      if (!group) throw new Error(`No group with id: ${groupId}`);
      if (props.title !== undefined) group.title = props.title;
      if (props.color !== undefined) group.color = props.color;
      if (props.collapsed !== undefined) group.collapsed = props.collapsed;
      return { ...group };
    },
  );

  const chromeMock: Record<string, unknown> = {
    storage: {
      local: makeArea(localStore),
      session: makeArea(sessionStore),
    },
    tabs: {
      get: tabsGet,
      group: tabsGroup,
      update: tabsUpdate,
      query: vi.fn(async () => []),
      remove: vi.fn(async (tabId: number) => {
        tabs.delete(tabId);
      }),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    tabGroups: {
      query: groupsQuery,
      update: groupsUpdate,
      TAB_GROUP_ID_NONE,
    },
    windows: {
      get: vi.fn(async (windowId: number) => ({ id: windowId, type: 'normal' })),
      getAll: vi.fn(async () => []),
      getCurrent: vi.fn(async () => ({ id: 1 })),
      getLastFocused: vi.fn(async () => ({ id: 1 })),
      update: windowsUpdate,
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onFocusChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      WINDOW_ID_NONE: -1,
    },
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
    },
    scripting: {
      executeScript: vi.fn(async () => [{ result: undefined }]),
    },
  };

  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;

  return {
    localStore,
    sessionStore,
    tabs,
    groups,
    removeTabGroupApi: () => {
      delete chromeMock.tabGroups;
      delete (chromeMock.tabs as Record<string, unknown>).group;
    },
    tabsGet,
    tabsGroup,
    tabsUpdate,
    groupsQuery,
    groupsUpdate,
    windowsUpdate,
  };
}

function addTab(h: ChromeHarness, id: number, windowId = 1, groupId = TAB_GROUP_ID_NONE): void {
  h.tabs.set(id, { id, windowId, groupId });
}

async function loadModule(): Promise<McpTabGroup> {
  vi.resetModules();
  return await import('@/utils/mcp-tab-group');
}

describe('mcp-tab-group (auto-chrome-mcp fork — MCP 작업 탭 그룹)', () => {
  let h: ChromeHarness;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    h = installChromeMocks();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  describe('설정 (mcpTabGroupEnabled)', () => {
    it('기본값은 true — 저장된 값이 없으면 켜져 있다', async () => {
      const mod = await loadModule();
      await expect(mod.isMcpTabGroupEnabled()).resolves.toBe(true);
    });

    it('명시적 false 만 OFF 로 본다 (true / 잡값은 ON)', async () => {
      const mod = await loadModule();

      h.localStore[mod.MCP_TAB_GROUP_STORAGE_KEY] = false;
      await expect(mod.isMcpTabGroupEnabled()).resolves.toBe(false);

      h.localStore[mod.MCP_TAB_GROUP_STORAGE_KEY] = true;
      await expect(mod.isMcpTabGroupEnabled()).resolves.toBe(true);

      h.localStore[mod.MCP_TAB_GROUP_STORAGE_KEY] = 'nonsense';
      await expect(mod.isMcpTabGroupEnabled()).resolves.toBe(true);
    });

    it('storage 조회가 실패해도 기본 동작(true) 으로 간주한다', async () => {
      const mod = await loadModule();
      (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('storage unavailable'),
      );
      await expect(mod.isMcpTabGroupEnabled()).resolves.toBe(true);
    });

    it('setMcpTabGroupEnabled 가 storage.local 에 값을 쓴다', async () => {
      const mod = await loadModule();
      await mod.setMcpTabGroupEnabled(false);
      expect(h.localStore[mod.MCP_TAB_GROUP_STORAGE_KEY]).toBe(false);
      await mod.setMcpTabGroupEnabled(true);
      expect(h.localStore[mod.MCP_TAB_GROUP_STORAGE_KEY]).toBe(true);
    });
  });

  describe('그룹 생성', () => {
    it('같은 창에 "MCP" 그룹이 없으면 만들고 제목·색·collapsed:false 를 지정한다', async () => {
      const mod = await loadModule();
      addTab(h, 11, 7);

      const groupId = await mod.assignTabToMcpGroup(11);

      expect(typeof groupId).toBe('number');
      expect(h.tabsGroup).toHaveBeenCalledTimes(1);
      expect(h.tabsGroup).toHaveBeenCalledWith({
        tabIds: [11],
        createProperties: { windowId: 7 },
      });
      expect(h.groupsUpdate).toHaveBeenCalledTimes(1);
      expect(h.groupsUpdate).toHaveBeenCalledWith(groupId, {
        title: 'MCP',
        color: 'green',
        collapsed: false,
      });

      const created = h.groups.find((g) => g.id === groupId);
      expect(created).toMatchObject({
        title: mod.MCP_TAB_GROUP_TITLE,
        color: mod.MCP_TAB_GROUP_COLOR,
        windowId: 7,
        collapsed: false,
      });
      expect(h.tabs.get(11)?.groupId).toBe(groupId);
    });

    it('그룹 제목은 "MCP", 색은 green 이다 (상수 계약)', async () => {
      const mod = await loadModule();
      expect(mod.MCP_TAB_GROUP_TITLE).toBe('MCP');
      expect(mod.MCP_TAB_GROUP_COLOR).toBe('green');
    });
  });

  describe('그룹 재사용', () => {
    it('같은 창에 이미 "MCP" 그룹이 있으면 재사용하고 tabGroups.update 를 부르지 않는다', async () => {
      const mod = await loadModule();
      h.groups.push({ id: 500, title: 'MCP', color: 'green', windowId: 3, collapsed: false });
      addTab(h, 21, 3);

      const groupId = await mod.assignTabToMcpGroup(21);

      expect(groupId).toBe(500);
      expect(h.tabsGroup).toHaveBeenCalledWith({ tabIds: [21], groupId: 500 });
      expect(h.groupsUpdate).not.toHaveBeenCalled();
      expect(h.groups).toHaveLength(1);
      expect(h.tabs.get(21)?.groupId).toBe(500);
    });

    it('탭 두 개를 연달아 넣어도 그룹은 창당 하나만 만들어진다', async () => {
      const mod = await loadModule();
      addTab(h, 31, 4);
      addTab(h, 32, 4);

      const first = await mod.assignTabToMcpGroup(31);
      const second = await mod.assignTabToMcpGroup(32);

      expect(first).toBe(second);
      expect(h.groups).toHaveLength(1);
      expect(h.groupsUpdate).toHaveBeenCalledTimes(1);
    });

    it('이미 그 그룹에 속한 탭이면 tabs.group 을 다시 부르지 않는다', async () => {
      const mod = await loadModule();
      h.groups.push({ id: 501, title: 'MCP', color: 'green', windowId: 5, collapsed: false });
      addTab(h, 41, 5, 501);

      const groupId = await mod.assignTabToMcpGroup(41);

      expect(groupId).toBe(501);
      expect(h.tabsGroup).not.toHaveBeenCalled();
      expect(h.groupsUpdate).not.toHaveBeenCalled();
    });

    it('창마다 그룹이 따로 생긴다 (다른 창의 "MCP" 그룹을 가져오지 않는다)', async () => {
      const mod = await loadModule();
      h.groups.push({ id: 502, title: 'MCP', color: 'green', windowId: 8, collapsed: false });
      addTab(h, 51, 9);

      const groupId = await mod.assignTabToMcpGroup(51);

      expect(groupId).not.toBe(502);
      expect(h.groupsQuery).toHaveBeenCalledWith({ windowId: 9, title: 'MCP' });
      expect(h.tabsGroup).toHaveBeenCalledWith({
        tabIds: [51],
        createProperties: { windowId: 9 },
      });
      expect(h.groups.filter((g) => g.title === 'MCP')).toHaveLength(2);
    });

    it('제목이 다른 그룹(query 패턴 매칭 여파)은 재사용하지 않는다', async () => {
      const mod = await loadModule();
      // tabGroups.query 의 title 은 패턴 매칭이라 "MCP work" 같은 그룹이 섞여 올 수 있다.
      h.groupsQuery.mockResolvedValueOnce([
        { id: 777, title: 'MCP work', color: 'blue', windowId: 2, collapsed: false },
      ]);
      addTab(h, 61, 2);

      const groupId = await mod.assignTabToMcpGroup(61);

      expect(groupId).not.toBe(777);
      expect(h.groupsUpdate).toHaveBeenCalledWith(groupId, {
        title: 'MCP',
        color: 'green',
        collapsed: false,
      });
    });
  });

  describe('설정 OFF', () => {
    it('mcpTabGroupEnabled:false 면 그룹 API 를 전혀 부르지 않고 null 을 준다', async () => {
      const mod = await loadModule();
      h.localStore[mod.MCP_TAB_GROUP_STORAGE_KEY] = false;
      addTab(h, 71, 1);

      await expect(mod.assignTabToMcpGroup(71)).resolves.toBeNull();

      expect(h.tabsGroup).not.toHaveBeenCalled();
      expect(h.groupsQuery).not.toHaveBeenCalled();
      expect(h.groupsUpdate).not.toHaveBeenCalled();
      expect(h.tabsGet).not.toHaveBeenCalled();
    });
  });

  describe('실패는 조용히 넘어간다 (도구 결과를 실패시키지 않는다)', () => {
    it('그룹 API 미지원 환경이면 예외 없이 null', async () => {
      const mod = await loadModule();
      addTab(h, 81, 1);
      h.removeTabGroupApi();

      await expect(mod.assignTabToMcpGroup(81)).resolves.toBeNull();
    });

    it('tabs.group 이 거부(권한 없음)하면 예외 없이 null + 경고 로그', async () => {
      const mod = await loadModule();
      addTab(h, 82, 1);
      h.tabsGroup.mockRejectedValueOnce(new Error('Missing tabGroups permission'));

      await expect(mod.assignTabToMcpGroup(82)).resolves.toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    });

    it('tabGroups.query 가 거부해도 예외 없이 null', async () => {
      const mod = await loadModule();
      addTab(h, 83, 1);
      h.groupsQuery.mockRejectedValueOnce(new Error('tabGroups unavailable'));

      await expect(mod.assignTabToMcpGroup(83)).resolves.toBeNull();
    });

    it('tabGroups.update 가 거부해도 예외 없이 null', async () => {
      const mod = await loadModule();
      addTab(h, 84, 1);
      h.groupsUpdate.mockRejectedValueOnce(new Error('cannot update group'));

      await expect(mod.assignTabToMcpGroup(84)).resolves.toBeNull();
    });

    it('탭이 이미 사라졌으면 예외 없이 null', async () => {
      const mod = await loadModule();
      // 탭을 등록하지 않았으므로 chrome.tabs.get 이 reject 한다.
      await expect(mod.assignTabToMcpGroup(999)).resolves.toBeNull();
      expect(h.tabsGroup).not.toHaveBeenCalled();
    });

    it('tabId 가 숫자가 아니면 아무 것도 하지 않고 null', async () => {
      const mod = await loadModule();
      await expect(mod.assignTabToMcpGroup(undefined)).resolves.toBeNull();
      await expect(mod.assignTabToMcpGroup(null)).resolves.toBeNull();
      await expect(mod.assignTabToMcpGroup('12')).resolves.toBeNull();
      expect(h.tabsGet).not.toHaveBeenCalled();
      expect(h.tabsGroup).not.toHaveBeenCalled();
    });

    it('tabs.group 이 TAB_GROUP_ID_NONE 을 주면 그룹 설정을 시도하지 않고 null', async () => {
      const mod = await loadModule();
      addTab(h, 85, 1);
      h.tabsGroup.mockResolvedValueOnce(TAB_GROUP_ID_NONE);

      await expect(mod.assignTabToMcpGroup(85)).resolves.toBeNull();
      expect(h.groupsUpdate).not.toHaveBeenCalled();
    });
  });

  describe('무간섭 원칙 — 활성화·포커스 API 를 부르지 않는다', () => {
    it('그룹 생성 경로에서 tabs.update({active}) / windows.update({focused}) 를 부르지 않는다', async () => {
      const mod = await loadModule();
      addTab(h, 91, 6);

      await mod.assignTabToMcpGroup(91);

      expect(h.tabsUpdate).not.toHaveBeenCalled();
      expect(h.windowsUpdate).not.toHaveBeenCalled();
    });

    it('그룹 재사용 경로에서도 활성화·포커스 API 를 부르지 않는다', async () => {
      const mod = await loadModule();
      h.groups.push({ id: 503, title: 'MCP', color: 'green', windowId: 6, collapsed: false });
      addTab(h, 92, 6);

      await mod.assignTabToMcpGroup(92);

      expect(h.tabsUpdate).not.toHaveBeenCalled();
      expect(h.windowsUpdate).not.toHaveBeenCalled();
    });

    it('그룹을 접지 않는다 (collapsed:false)', async () => {
      const mod = await loadModule();
      addTab(h, 93, 6);

      const groupId = await mod.assignTabToMcpGroup(93);

      expect(h.groups.find((g) => g.id === groupId)?.collapsed).toBe(false);
      // collapsed:true 로 부른 적이 없어야 한다.
      for (const call of h.groupsUpdate.mock.calls) {
        expect((call[1] as { collapsed?: boolean }).collapsed).not.toBe(true);
      }
    });
  });

  describe('단일 관문 — work-tab-manager.setWorkTab 이 편입을 호출한다', () => {
    async function loadWorkTabManager(): Promise<WorkTabManager> {
      vi.resetModules();
      return await import('@/utils/work-tab-manager');
    }

    it('setWorkTab 이 작업 탭을 "MCP" 그룹에 넣는다', async () => {
      const wtm = await loadWorkTabManager();
      addTab(h, 101, 12);

      await wtm.setWorkTab(101, 'session-a', true);
      await flush();

      expect(h.tabsGroup).toHaveBeenCalledWith({
        tabIds: [101],
        createProperties: { windowId: 12 },
      });
      expect(h.groupsUpdate).toHaveBeenCalledWith(expect.any(Number), {
        title: 'MCP',
        color: 'green',
        collapsed: false,
      });
      expect(h.tabs.get(101)?.groupId).toBe(h.groups[0].id);
    });

    it('그룹 편입이 실패해도 setWorkTab 은 throw 하지 않고 작업 탭 기록을 남긴다', async () => {
      const wtm = await loadWorkTabManager();
      addTab(h, 102, 12);
      h.tabsGroup.mockRejectedValue(new Error('Missing tabGroups permission'));

      await expect(wtm.setWorkTab(102, 'session-b', true)).resolves.toBeUndefined();
      await flush();

      await expect(wtm.getWorkTabId('session-b')).resolves.toBe(102);
    });

    it('설정 OFF 면 setWorkTab 이 그룹 API 를 부르지 않는다', async () => {
      const mod = await loadModule();
      h.localStore[mod.MCP_TAB_GROUP_STORAGE_KEY] = false;
      const wtm = await loadWorkTabManager();
      addTab(h, 103, 12);

      await wtm.setWorkTab(103, 'session-c', true);
      await flush();

      expect(h.tabsGroup).not.toHaveBeenCalled();
      expect(h.groupsQuery).not.toHaveBeenCalled();
    });
  });
});
