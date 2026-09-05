/**
 * auto-chrome-mcp fork — MCP 탭 그룹 제목 ("지금 무슨 작업 중인가").
 *
 * 계약: docs/plans/2026-09-05-daily-automation-design.md (탭 그룹 제목).
 * 무간섭 모드에서는 작업 탭이 배경에 조용히 열리므로, 사용자가 "이 창에서 뭐가 돌고
 * 있나" 를 알 수 있는 유일한 표시가 탭 그룹 라벨이다. 그래서 batch·shortcut 실행 동안
 * 라벨을 작업 이름으로 바꾸고 끝나면 "MCP" 로 되돌린다.
 *
 * 절대 조건: 제목 변경은 chrome.tabGroups.update 만 쓴다. 탭 활성화(tabs.update{active})
 * 나 창 포커스(windows.update{focused}) 를 곁들이면 그 순간 무간섭이 깨진다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeTab {
  id: number;
  windowId: number;
  groupId: number;
  url: string;
  active: boolean;
  status: string;
}

interface FakeGroup {
  id: number;
  title?: string;
  color: string;
  windowId: number;
  collapsed: boolean;
}

const WINDOW_ID = 1;
const WORK_TAB_ID = 501;
const MCP_GROUP_ID = 900;

interface Harness {
  localStore: Record<string, unknown>;
  sessionStore: Record<string, unknown>;
  groups: FakeGroup[];
  tabsUpdate: ReturnType<typeof vi.fn>;
  windowsUpdate: ReturnType<typeof vi.fn>;
  groupsUpdate: ReturnType<typeof vi.fn>;
}

function installChrome(): Harness {
  const localStore: Record<string, unknown> = {};
  const sessionStore: Record<string, unknown> = {};
  const tabs: FakeTab[] = [
    {
      id: WORK_TAB_ID,
      windowId: WINDOW_ID,
      groupId: MCP_GROUP_ID,
      url: 'https://dashboard.example/',
      active: false,
      status: 'complete',
    },
  ];
  const groups: FakeGroup[] = [
    { id: MCP_GROUP_ID, title: 'MCP', color: 'green', windowId: WINDOW_ID, collapsed: false },
  ];

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

  const tabsUpdate = vi.fn(async (tabId: number, props: Record<string, unknown>) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) throw new Error(`no tab ${tabId}`);
    if (typeof props.active === 'boolean') tab.active = props.active;
    return tab;
  });
  const windowsUpdate = vi.fn(async (windowId: number) => ({ id: windowId }));

  const groupsUpdate = vi.fn(async (groupId: number, props: Record<string, unknown>) => {
    const group = groups.find((g) => g.id === groupId);
    if (!group) throw new Error(`no group ${groupId}`);
    if (typeof props.title === 'string') group.title = props.title;
    if (typeof props.color === 'string') group.color = props.color;
    if (typeof props.collapsed === 'boolean') group.collapsed = props.collapsed;
    return { ...group };
  });

  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { id: 'test-extension-id', lastError: undefined },
    storage: { local: makeArea(localStore), session: makeArea(sessionStore) },
    tabs: {
      query: vi.fn(async () => tabs.slice()),
      get: vi.fn(async (tabId: number) => {
        const tab = tabs.find((t) => t.id === tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}`);
        return tab;
      }),
      create: vi.fn(async () => tabs[0]),
      update: tabsUpdate,
      remove: vi.fn(async () => undefined),
      group: vi.fn(async () => MCP_GROUP_ID),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    tabGroups: {
      query: vi.fn(async (info: { windowId?: number; title?: string }) =>
        groups
          .filter((g) => (typeof info.windowId === 'number' ? g.windowId === info.windowId : true))
          .filter((g) => (typeof info.title === 'string' ? g.title === info.title : true))
          .map((g) => ({ ...g })),
      ),
      get: vi.fn(async (groupId: number) => {
        const group = groups.find((g) => g.id === groupId);
        if (!group) throw new Error(`no group ${groupId}`);
        return { ...group };
      }),
      update: groupsUpdate,
      TAB_GROUP_ID_NONE: -1,
    },
    windows: {
      get: vi.fn(async (windowId: number) => ({ id: windowId, type: 'normal' })),
      getAll: vi.fn(async () => [{ id: WINDOW_ID, type: 'normal' }]),
      getLastFocused: vi.fn(async () => ({ id: WINDOW_ID })),
      create: vi.fn(async () => ({ id: 100, tabs: [] })),
      update: windowsUpdate,
      remove: vi.fn(async () => undefined),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onFocusChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      WINDOW_ID_NONE: -1,
    },
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
      setTitle: vi.fn(async () => undefined),
    },
    scripting: { executeScript: vi.fn(async () => [{ result: undefined }]) },
    debugger: {
      getTargets: vi.fn(async () => []),
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async () => ({})),
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
      onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    downloads: { onCreated: { addListener: vi.fn(), removeListener: vi.fn() } },
    webNavigation: {
      onCommitted: { addListener: vi.fn(), removeListener: vi.fn() },
      onDOMContentLoaded: { addListener: vi.fn(), removeListener: vi.fn() },
      onCompleted: { addListener: vi.fn(), removeListener: vi.fn() },
      onCreatedNavigationTarget: { addListener: vi.fn(), removeListener: vi.fn() },
      onErrorOccurred: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };

  return { localStore, sessionStore, groups, tabsUpdate, windowsUpdate, groupsUpdate };
}

let h: Harness;

beforeEach(() => {
  h = installChrome();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MCP 탭 그룹 제목', () => {
  it('제목을 바꾸고 되돌린다. 기본값은 "MCP" 다', async () => {
    const mod = await import('@/utils/mcp-tab-group');

    expect(await mod.setMcpGroupTitle(WINDOW_ID, '일일 대시보드 확인')).toBe(true);
    expect(h.groups[0].title).toBe('일일 대시보드 확인');

    expect(await mod.resetMcpGroupTitle(WINDOW_ID)).toBe(true);
    expect(h.groups[0].title).toBe('MCP');
  });

  it('24자를 넘으면 자르고, 빈 문구는 기본 제목으로 되돌린다', async () => {
    const mod = await import('@/utils/mcp-tab-group');

    const long = '가'.repeat(40);
    expect(mod.normalizeMcpGroupTitle(long)).toHaveLength(mod.MCP_TAB_GROUP_TITLE_MAX);
    expect(mod.normalizeMcpGroupTitle('   ')).toBe('MCP');
    expect(mod.normalizeMcpGroupTitle(undefined)).toBe('MCP');
    // 공백이 여러 개면 하나로 줄인다 (탭 스트립에서 이상하게 벌어지지 않게).
    expect(mod.normalizeMcpGroupTitle('  일일   확인 ')).toBe('일일 확인');

    await mod.setMcpGroupTitle(WINDOW_ID, long);
    expect(h.groups[0].title).toHaveLength(mod.MCP_TAB_GROUP_TITLE_MAX);
  });

  it('제목 변경은 탭 활성화도 창 포커스도 하지 않는다', async () => {
    const mod = await import('@/utils/mcp-tab-group');

    await mod.setMcpGroupTitle(WINDOW_ID, '수집 중');
    await mod.resetMcpGroupTitle(WINDOW_ID);

    expect(h.groupsUpdate).toHaveBeenCalled();
    for (const call of h.groupsUpdate.mock.calls) {
      // 제목 말고 다른 것을 함께 바꾸지 않는다.
      expect(Object.keys(call[1] as object)).toEqual(['title']);
    }
    expect(h.tabsUpdate).not.toHaveBeenCalled();
    expect(h.windowsUpdate).not.toHaveBeenCalled();
  });

  it('그룹이 없는 창은 조용히 false 다 (실행을 막지 않는다)', async () => {
    const mod = await import('@/utils/mcp-tab-group');
    expect(await mod.setMcpGroupTitle(77, '수집 중')).toBe(false);
    expect(await mod.setMcpGroupTitle(undefined, '수집 중')).toBe(false);
  });

  it('batch 는 task 문구로 라벨을 바꾸고 끝나면 "MCP" 로 되돌린다', async () => {
    const manager = await import('@/utils/work-tab-manager');
    await manager.setWorkTab(WORK_TAB_ID, 'sess::main', true);

    const { runSteps } = await import('@/entrypoints/background/tools/browser/batch-runner');
    const seen: string[] = [];

    await runSteps({
      steps: [{ tool: 'chrome_extract', args: { fields: { t: 'h1' } }, as: 'kpi' }],
      invoke: async () => {
        seen.push(h.groups[0].title ?? '');
        return { content: [{ type: 'text', text: '{}' }], isError: false };
      },
      disallowedTools: new Set<string>(),
      containerLabel: 'chrome_batch',
      skippedNote: 'skipped',
      collectImages: false,
      templatesEnabled: true,
      mcpSessionId: 'sess',
      lane: 'main',
      taskTitle: '일일 대시보드',
    });

    // 실행 중에는 작업 이름이 보이고,
    expect(seen).toEqual(['일일 대시보드']);
    // 끝나면 기본 제목으로 돌아온다.
    expect(h.groups[0].title).toBe('MCP');
  });

  it('task 없이 도는 실행은 라벨을 건드리지 않는다', async () => {
    const manager = await import('@/utils/work-tab-manager');
    await manager.setWorkTab(WORK_TAB_ID, 'sess::main', true);
    h.groupsUpdate.mockClear();

    const { runSteps } = await import('@/entrypoints/background/tools/browser/batch-runner');
    await runSteps({
      steps: [{ tool: 'chrome_extract', args: { fields: { t: 'h1' } }, as: 'kpi' }],
      invoke: async () => ({ content: [{ type: 'text', text: '{}' }], isError: false }),
      disallowedTools: new Set<string>(),
      containerLabel: 'chrome_batch',
      skippedNote: 'skipped',
      collectImages: false,
      templatesEnabled: true,
      mcpSessionId: 'sess',
      lane: 'main',
    });

    expect(h.groupsUpdate).not.toHaveBeenCalled();
    expect(h.groups[0].title).toBe('MCP');
  });

  it('실행 중 새로 편입되는 탭도 지금 작업 이름이 붙은 그룹으로 간다', async () => {
    const mod = await import('@/utils/mcp-tab-group');
    mod.beginMcpGroupTask('주간 리포트');

    // 새 작업 탭이 생기면 setWorkTab 이 그룹 편입의 단일 관문이다.
    const manager = await import('@/utils/work-tab-manager');
    await manager.setWorkTab(WORK_TAB_ID, 'sess::main', true);

    expect(h.groups[0].title).toBe('주간 리포트');

    await mod.endMcpGroupTask();
    expect(h.groups[0].title).toBe('MCP');
  });
});
