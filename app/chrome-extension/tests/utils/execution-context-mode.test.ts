/**
 * auto-chrome-mcp fork — 실행 컨텍스트 모드 (설계 구현 순서 2단계).
 *
 * 계약: docs/plans/2026-09-05-daily-automation-design.md 2절.
 * 테스트 이름 앞의 번호는 같은 문서 10절 체크리스트 번호다 (5, 6).
 *
 * 핵심 주장: 전역 background 토글이 **꺼져 있어도** 예약처럼 컨텍스트가 무간섭을 강제한
 * 실행은 사용자 탭을 건드리지 않는다. 인자 `background: true` 만 덮는 방식으로는
 * 게이트가 작업 탭 주입을 건너뛰어 도구가 사용자의 활성 탭으로 흘러가기 때문이다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface TabRecord {
  id: number;
  windowId: number;
  url: string;
  active: boolean;
  status: string;
  groupId?: number;
}

const USER_WINDOW_ID = 1;
/** 사용자가 지금 보고 있는 탭. 이 id 가 어디에도 나타나면 안 된다. */
const USER_TAB_ID = 11;
const WORK_TAB_ID = 501;
const OWNED_TAB_ID = 502;

const SCHEDULED_ARGS = { _mcpSessionId: 'scheduled', lane: 'daily' };
const SESSION_KEY = 'scheduled::daily';

interface Harness {
  localStore: Record<string, unknown>;
  sessionStore: Record<string, unknown>;
  tabs: TabRecord[];
  tabsRemove: ReturnType<typeof vi.fn>;
  tabsUpdate: ReturnType<typeof vi.fn>;
  windowsUpdate: ReturnType<typeof vi.fn>;
  tabsQuery: ReturnType<typeof vi.fn>;
}

function installChrome(): Harness {
  const localStore: Record<string, unknown> = {};
  const sessionStore: Record<string, unknown> = {};
  const tabs: TabRecord[] = [
    {
      id: USER_TAB_ID,
      windowId: USER_WINDOW_ID,
      url: 'https://user-page.example/',
      active: true,
      status: 'complete',
    },
    {
      id: WORK_TAB_ID,
      windowId: USER_WINDOW_ID,
      url: 'https://dashboard.example/',
      active: false,
      status: 'complete',
      groupId: -1,
    },
    {
      id: OWNED_TAB_ID,
      windowId: USER_WINDOW_ID,
      url: 'https://dashboard.example/detail',
      active: false,
      status: 'complete',
      groupId: -1,
    },
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

  const tabsQuery = vi.fn(async (query: Record<string, unknown>) => {
    let out = tabs.slice();
    if (query?.active === true) out = out.filter((t) => t.active);
    if (typeof query?.windowId === 'number') out = out.filter((t) => t.windowId === query.windowId);
    return out;
  });

  const tabsRemove = vi.fn(async (target: number | number[]) => {
    for (const id of Array.isArray(target) ? target : [target]) {
      const index = tabs.findIndex((t) => t.id === id);
      if (index >= 0) tabs.splice(index, 1);
    }
  });

  const tabsUpdate = vi.fn(async (tabId: number, props: Record<string, unknown>) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) throw new Error(`no tab ${tabId}`);
    if (typeof props.active === 'boolean') tab.active = props.active;
    return tab;
  });

  const windowsUpdate = vi.fn(async (windowId: number) => ({ id: windowId }));

  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { id: 'test-extension-id', lastError: undefined },
    storage: { local: makeArea(localStore), session: makeArea(sessionStore) },
    tabs: {
      query: tabsQuery,
      get: vi.fn(async (tabId: number) => {
        const tab = tabs.find((t) => t.id === tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}`);
        return tab;
      }),
      create: vi.fn(async () => tabs[1]),
      update: tabsUpdate,
      remove: tabsRemove,
      group: vi.fn(async () => 900),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    tabGroups: {
      query: vi.fn(async () => []),
      get: vi.fn(async () => ({ id: 900, title: 'MCP', color: 'green', windowId: 1 })),
      update: vi.fn(async () => ({ id: 900, title: 'MCP', color: 'green', windowId: 1 })),
      TAB_GROUP_ID_NONE: -1,
    },
    windows: {
      get: vi.fn(async (windowId: number) => ({ id: windowId, type: 'normal' })),
      getAll: vi.fn(async () => [{ id: USER_WINDOW_ID, type: 'normal' }]),
      getLastFocused: vi.fn(async () => ({ id: USER_WINDOW_ID })),
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

  return { localStore, sessionStore, tabs, tabsRemove, tabsUpdate, windowsUpdate, tabsQuery };
}

/** 전역 background 토글을 끈다 - 이 테스트의 전제다. */
function turnGlobalBackgroundModeOff(h: Harness): void {
  h.localStore.backgroundWorkMode = false;
}

/** `scheduled::daily` 버킷에 작업 탭과 소유 탭을 심는다. */
async function seedScheduledSession(): Promise<void> {
  const manager = await import('@/utils/work-tab-manager');
  await manager.setWorkTab(WORK_TAB_ID, SESSION_KEY, true);
  await manager.addOwnedTab(OWNED_TAB_ID, SESSION_KEY);
}

let h: Harness;

beforeEach(() => {
  h = installChrome();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * 5. 러너가 모드를 호출 체인에 싣는다
 * ------------------------------------------------------------------ */

describe('5. forceBackground 는 모든 ToolCallParam 에 실린다', () => {
  it('5. forceBackground 실행의 모든 호출에 effectiveBackgroundMode:true 가 붙는다', async () => {
    const { runSteps } = await import('@/entrypoints/background/tools/browser/batch-runner');
    const calls: any[] = [];

    await runSteps({
      steps: [
        { tool: 'chrome_navigate', args: { url: 'https://dashboard.example/' }, as: 'nav' },
        { tool: 'chrome_extract', args: { fields: { t: 'h1' } }, as: 'kpi' },
      ],
      invoke: async (param: any) => {
        calls.push(param);
        return { content: [{ type: 'text', text: '{}' }], isError: false };
      },
      disallowedTools: new Set<string>(),
      containerLabel: 'test',
      skippedNote: 'skipped',
      collectImages: false,
      templatesEnabled: true,
      forceBackground: true,
      mcpSessionId: 'scheduled',
      lane: 'daily',
    });

    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call.effectiveBackgroundMode).toBe(true);
      expect(call.args.background).toBe(true);
      expect(call.args._mcpSessionId).toBe('scheduled');
      expect(call.args.lane).toBe('daily');
    }
  });

  it('5. forceBackground 없이는 그 필드를 싣지 않는다 (전역 토글 OFF 기준)', async () => {
    turnGlobalBackgroundModeOff(h);
    const { runSteps } = await import('@/entrypoints/background/tools/browser/batch-runner');
    const calls: any[] = [];

    await runSteps({
      steps: [{ tool: 'chrome_extract', args: { fields: { t: 'h1' } }, as: 'kpi' }],
      invoke: async (param: any) => {
        calls.push(param);
        return { content: [{ type: 'text', text: '{}' }], isError: false };
      },
      disallowedTools: new Set<string>(),
      containerLabel: 'test',
      skippedNote: 'skipped',
      collectImages: false,
      templatesEnabled: true,
    });

    expect(calls[0].effectiveBackgroundMode).toBeUndefined();
    expect(calls[0].args.background).toBeUndefined();
  });

  it('5. step args 에 적힌 _mcpSessionId·lane·effectiveBackgroundMode 는 버려진다', async () => {
    const { prepareStepArgs } = await import('@/entrypoints/background/tools/browser/batch-runner');
    const { createTemplateScope } = await import('@/utils/step-template');

    const stepArgs = prepareStepArgs({
      rawArgs: {
        url: 'https://evil.example/',
        _mcpSessionId: 'someone-else',
        lane: 'someone-else',
        background: false,
        _effectiveBackgroundMode: true,
        effectiveBackgroundMode: true,
      },
      toolName: 'chrome_navigate',
      scope: createTemplateScope(),
      templatesEnabled: true,
      backgroundModeOn: false,
      forceBackground: true,
      mcpSessionId: 'scheduled',
      lane: 'daily',
    });

    expect(stepArgs._mcpSessionId).toBe('scheduled');
    expect(stepArgs.lane).toBe('daily');
    expect(stepArgs.background).toBe(true);
    expect(Object.hasOwn(stepArgs, '_effectiveBackgroundMode')).toBe(false);
    expect(Object.hasOwn(stepArgs, 'effectiveBackgroundMode')).toBe(false);
  });

  it('5. step 이 스스로 무간섭을 주장해도 게이트는 그 값을 읽지 않는다', async () => {
    turnGlobalBackgroundModeOff(h);
    await seedScheduledSession();
    const { applyBackgroundModeGate } = await import('@/utils/work-tab-gate');

    // step args 에 직접 적어 온 키는 handleCallTool 이 지운다. 여기서는 "지워진 뒤" 의
    // 인자, 즉 전역 토글만 남은 상태가 예전 동작 그대로임을 확인한다.
    const gate = await applyBackgroundModeGate('chrome_click_element', {
      ...SCHEDULED_ARGS,
      selector: '#go',
    });
    expect(gate.args.background).toBeUndefined();
    expect(gate.args.tabId).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * 6. 전역 토글 OFF 에서도 사용자 탭을 건드리지 않는다
 * ------------------------------------------------------------------ */

describe('6. 전역 토글 OFF + 실행 컨텍스트 모드', () => {
  it('6. 게이트는 전역 토글이 꺼져 있어도 작업 탭을 주입하고 사용자 탭(11)을 고르지 않는다', async () => {
    turnGlobalBackgroundModeOff(h);
    await seedScheduledSession();
    const { applyBackgroundModeGate } = await import('@/utils/work-tab-gate');

    const gate = await applyBackgroundModeGate('chrome_click_element', {
      ...SCHEDULED_ARGS,
      _effectiveBackgroundMode: true,
      selector: '#go',
    });

    expect(gate.args.tabId).toBe(WORK_TAB_ID);
    expect(gate.args.background).toBe(true);
    expect(gate.args.tabId).not.toBe(USER_TAB_ID);
    expect(gate.noWorkTab).toBe(false);
  });

  it('6. 작업 탭이 없으면 사용자 탭으로 흐르지 않고 no_work_tab 으로 거절된다', async () => {
    turnGlobalBackgroundModeOff(h);
    const { applyBackgroundModeGate } = await import('@/utils/work-tab-gate');

    const gate = await applyBackgroundModeGate('chrome_click_element', {
      ...SCHEDULED_ARGS,
      _effectiveBackgroundMode: true,
      selector: '#go',
    });

    expect(gate.noWorkTab).toBe(true);
    expect(gate.args.tabId).toBeUndefined();
  });

  it('6. 인자 없는 chrome_close_tabs 는 세션 소유 탭만 닫고 사용자 탭(11)은 남긴다', async () => {
    turnGlobalBackgroundModeOff(h);
    await seedScheduledSession();
    const { closeTabsTool } = await import('@/entrypoints/background/tools/browser/common');

    const result = await closeTabsTool.execute({
      ...SCHEDULED_ARGS,
      _effectiveBackgroundMode: true,
    } as any);
    const body = JSON.parse((result.content[0] as any).text);

    expect(body.success).toBe(true);
    expect(body.closedTabIds.sort()).toEqual([WORK_TAB_ID, OWNED_TAB_ID].sort());
    expect(body.closedTabIds).not.toContain(USER_TAB_ID);
    expect(h.tabs.map((t) => t.id)).toEqual([USER_TAB_ID]);
  });

  it('6. 소유한 탭이 없으면 사용자 활성 탭을 닫지 않고 오류로 끝난다', async () => {
    turnGlobalBackgroundModeOff(h);
    const { closeTabsTool } = await import('@/entrypoints/background/tools/browser/common');

    const result = await closeTabsTool.execute({
      ...SCHEDULED_ARGS,
      _effectiveBackgroundMode: true,
    } as any);

    expect(result.isError).toBe(true);
    expect(h.tabs.some((t) => t.id === USER_TAB_ID)).toBe(true);
    expect(h.tabsRemove).not.toHaveBeenCalled();
  });

  it('6. 대조: 같은 호출이 실행 컨텍스트 모드 없이 오면 예전대로 활성 탭을 닫는다', async () => {
    turnGlobalBackgroundModeOff(h);
    const { closeTabsTool } = await import('@/entrypoints/background/tools/browser/common');

    const result = await closeTabsTool.execute({ ...SCHEDULED_ARGS } as any);
    const body = JSON.parse((result.content[0] as any).text);

    expect(body.closedTabIds).toEqual([USER_TAB_ID]);
  });

  it('6. url 대상 해석도 전역 토글보다 실행 컨텍스트 모드를 먼저 본다', async () => {
    turnGlobalBackgroundModeOff(h);
    await seedScheduledSession();
    const { findTabByUrlInSessionScope } =
      await import('@/entrypoints/background/tools/browser/url-target');

    // 사용자 탭의 URL 을 주어도 세션 소유 탭만 후보이므로 걸리지 않는다.
    const hit = await findTabByUrlInSessionScope('https://user-page.example/', {
      ...SCHEDULED_ARGS,
      _effectiveBackgroundMode: true,
    });
    expect(hit).toBeNull();

    // 소유 탭의 URL 은 그대로 찾는다.
    const owned = await findTabByUrlInSessionScope('https://dashboard.example/detail', {
      ...SCHEDULED_ARGS,
      _effectiveBackgroundMode: true,
    });
    expect(owned?.id).toBe(OWNED_TAB_ID);
  });

  it('6. 활성화 가드는 실행 컨텍스트 모드에서 탭 활성화·창 포커스를 하지 않는다', async () => {
    turnGlobalBackgroundModeOff(h);
    const guard = await import('@/utils/activation-guard');

    // 전역 토글만 보면 사용자 창에서도 활성화가 허용된다 (예전 동작).
    expect(await guard.isActivationAllowed(USER_WINDOW_ID)).toBe(true);
    // 컨텍스트가 무간섭을 강제하면 사용자 창에서는 막힌다 (전용 작업 창 안에서만 허용).
    expect(
      await guard.isActivationAllowed(USER_WINDOW_ID, {
        contextArgs: { ...SCHEDULED_ARGS, _effectiveBackgroundMode: true },
      }),
    ).toBe(false);

    await guard.activateTab(WORK_TAB_ID, {
      reason: 'test',
      contextArgs: { ...SCHEDULED_ARGS, _effectiveBackgroundMode: true },
    });
    expect(h.tabsUpdate).not.toHaveBeenCalledWith(WORK_TAB_ID, { active: true });
    expect(h.windowsUpdate).not.toHaveBeenCalled();
  });
});
