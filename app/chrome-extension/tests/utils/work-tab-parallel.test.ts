/**
 * auto-chrome-mcp fork(P1) — 병렬 에이전트 레인 격리 회귀 테스트.
 *
 * 재현하려는 실패: 한 Claude Code 세션에서 서브에이전트 4개를 동시에 띄우면 전원
 * tab_not_found 로 죽었다. 원인은 두 겹이었다.
 *   ① 서브에이전트는 stdio 프로세스를 공유하므로 _mcpSessionId 가 전부 같다.
 *   ② v1.6.0 의 정리 로직이 "같은 세션이 만든 탭 중 지금 실행 중이 아닌 것" 을 전부 닫았다.
 *      isTabBusy 는 도구가 실행 중일 때만 true 라, 에이전트가 다음 수를 고민하는 사이
 *      형제 탭이 유휴로 오인돼 차례로 닫혔다.
 *
 * 여기서 검증하는 계약:
 *   - lane 을 주면 같은 세션 안에서도 작업 탭 버킷이 갈라진다 (sessionKeyOf)
 *   - 레인이 다른 병렬 탭 4개는 서로를 닫지 않는다 (핵심 회귀)
 *   - lane 없이도 유예(grace) 덕에 병렬 탭이 살아남는다 (2차 방어선)
 *   - 그러면서도 탭 축적은 막는다: 유예 밖 유휴 탭 정리 + 레인당 상한 + 방치 탭 전역 청소
 *   - 절대 안 닫는 대상: 방금 만든 탭 / 실행 중 / 어느 레인이든 현재 작업 탭 / 사용자가 보는 탭
 *   - 닫은 탭은 사유를 남겨 도구 에러에 붙일 수 있다 (describeClosedTab)
 *
 * 모듈은 import 시점에 리스너를 달고 map 을 모듈 스코프에 캐시하므로, 테스트마다
 * mock 설치 → vi.resetModules() → 동적 import 순서로 격리한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type WorkTabManager = typeof import('@/utils/work-tab-manager');
type TabLock = typeof import('@/utils/tab-lock');

interface TabState {
  active: boolean;
  windowId: number;
}

interface ChromeHarness {
  sessionStore: Record<string, unknown>;
  tabs: Map<number, TabState>;
  openTab: (tabId: number, state?: Partial<TabState>) => void;
}

function installChromeMocks(): ChromeHarness {
  const sessionStore: Record<string, unknown> = {};
  const tabs = new Map<number, TabState>();

  const toKeys = (keys: unknown): string[] =>
    Array.isArray(keys) ? (keys as string[]) : typeof keys === 'string' ? [keys] : [];

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
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(sessionStore, items);
        }),
        remove: vi.fn(async (keys: unknown) => {
          for (const key of toKeys(keys)) delete sessionStore[key];
        }),
      },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => {
        const state = tabs.get(tabId);
        if (!state) throw new Error(`No tab with id: ${tabId}`);
        return { id: tabId, url: `https://example.com/${tabId}`, ...state };
      }),
      remove: vi.fn(async (tabId: number) => {
        if (!tabs.has(tabId)) throw new Error(`No tab with id: ${tabId}`);
        tabs.delete(tabId);
      }),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    windows: {
      get: vi.fn(async () => {
        throw new Error('no such window');
      }),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: { executeScript: vi.fn(async () => [{ result: undefined }]) },
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
    },
  };

  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;

  return {
    sessionStore,
    tabs,
    openTab: (tabId, state) => tabs.set(tabId, { active: false, windowId: 1, ...state }),
  };
}

/** work-tab-manager 와 tab-lock 은 반드시 같은 모듈 인스턴스여야 한다 (busy 상태 공유). */
async function loadModules(): Promise<{ mod: WorkTabManager; lock: TabLock }> {
  vi.resetModules();
  const mod = await import('@/utils/work-tab-manager');
  const lock = await import('@/utils/tab-lock');
  return { mod, lock };
}

/** navigate 가 새 작업 탭을 만들었을 때 하는 일 그대로 (common.ts rememberWorkTab). */
async function openWorkTab(
  mod: WorkTabManager,
  h: ChromeHarness,
  tabId: number,
  sessionKey: string,
): Promise<void> {
  h.openTab(tabId);
  await mod.setWorkTab(tabId, sessionKey, true);
  await mod.addOwnedTab(tabId, sessionKey);
  await mod.pruneOwnedTabs(sessionKey, tabId);
}

const SESSION = 'stdio-1234-abcdef';

describe('sessionKeyOf — 세션 + 레인 버킷 키 (P1)', () => {
  beforeEach(() => {
    installChromeMocks();
  });

  it('lane 이 없으면 _mcpSessionId 를 그대로 쓴다 (기존 동작 유지)', async () => {
    const { mod } = await loadModules();
    expect(mod.sessionKeyOf({ _mcpSessionId: SESSION })).toBe(SESSION);
    expect(mod.sessionKeyOf({ _mcpSessionId: SESSION, lane: '   ' })).toBe(SESSION);
    expect(mod.sessionKeyOf({})).toBe(mod.DEFAULT_SESSION_ID);
  });

  it('lane 을 주면 같은 세션이어도 버킷이 갈라진다', async () => {
    const { mod } = await loadModules();
    const a = mod.sessionKeyOf({ _mcpSessionId: SESSION, lane: 'agent-1' });
    const b = mod.sessionKeyOf({ _mcpSessionId: SESSION, lane: 'agent-2' });

    expect(a).not.toBe(b);
    expect(a).not.toBe(SESSION);
    expect(mod.laneOf(a)).toBe('agent-1');
    expect(mod.laneOf(SESSION)).toBeNull();
  });

  it('lane 은 앞뒤 공백을 떼고 64자로 자른다 (저장 키 폭주 방지)', async () => {
    const { mod } = await loadModules();
    const key = mod.sessionKeyOf({ _mcpSessionId: SESSION, lane: `  ${'x'.repeat(200)}  ` });
    expect(mod.laneOf(key)).toBe('x'.repeat(64));
  });
});

describe('pruneOwnedTabs — 병렬 에이전트 격리 (P1)', () => {
  let h: ChromeHarness;

  beforeEach(() => {
    h = installChromeMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('회귀: 레인이 다른 병렬 에이전트 4개의 작업 탭이 모두 살아남는다', async () => {
    const { mod } = await loadModules();
    const lanes = ['agent-1', 'agent-2', 'agent-3', 'agent-4'];

    // 4개 에이전트가 차례로 자기 작업 탭을 연다 (실제로는 동시, 결과는 같다).
    for (let i = 0; i < lanes.length; i++) {
      const key = mod.sessionKeyOf({ _mcpSessionId: SESSION, lane: lanes[i] });
      await openWorkTab(mod, h, 201 + i, key);
      // 에이전트가 다음 수를 고민하는 시간 — v1.6.0 은 이 구간의 탭을 유휴로 보고 닫았다.
      vi.setSystemTime(Date.now() + 5_000);
    }

    expect([...h.tabs.keys()].sort()).toEqual([201, 202, 203, 204]);
    for (let i = 0; i < lanes.length; i++) {
      const key = mod.sessionKeyOf({ _mcpSessionId: SESSION, lane: lanes[i] });
      expect(await mod.getWorkTabId(key)).toBe(201 + i);
    }
  });

  it('lane 이 없어도 유예(grace) 안의 병렬 탭은 닫지 않는다 (2차 방어선)', async () => {
    const { mod } = await loadModules();

    for (let i = 0; i < 4; i++) {
      await openWorkTab(mod, h, 301 + i, SESSION);
      vi.setSystemTime(Date.now() + 5_000);
    }

    expect([...h.tabs.keys()].sort()).toEqual([301, 302, 303, 304]);
    // 다만 작업 탭 자리는 마지막 것이 차지한다 — lane 없이 병렬을 돌리면 tabId 를
    // 매번 명시해야 하는 이유이자, lane 을 쓰라고 권하는 이유.
    expect(await mod.getWorkTabId(SESSION)).toBe(304);
  });

  it('유예를 넘긴 유휴 탭은 정리해 탭 축적을 막는다', async () => {
    const { mod } = await loadModules();

    await openWorkTab(mod, h, 401, SESSION);
    // 401 이 작업 탭 자리에서 밀려나도록 새 탭을 하나 연다.
    vi.setSystemTime(Date.now() + 1_000);
    await openWorkTab(mod, h, 402, SESSION);

    // 유예(90s) 를 넘겨 방치
    vi.setSystemTime(Date.now() + mod.OWNED_GRACE_MS + 1_000);
    await openWorkTab(mod, h, 403, SESSION);

    // 401·402 는 유예 밖 유휴 탭이 됐고, 작업 탭 자리는 403 이 가져갔다 → 둘 다 회수.
    expect(h.tabs.has(401)).toBe(false);
    expect(h.tabs.has(402)).toBe(false);
    expect(h.tabs.has(403)).toBe(true);
    expect(mod.describeClosedTab(401)).toMatch(/closed by MCP cleanup/);
    expect(mod.describeClosedTab(403)).toBeNull();
  });

  it('touchOwnedTab 으로 최근 사용을 알리면 유예가 되살아난다', async () => {
    const { mod } = await loadModules();

    await openWorkTab(mod, h, 501, SESSION);
    vi.setSystemTime(Date.now() + 1_000);
    await openWorkTab(mod, h, 502, SESSION);

    // 501 을 오래 방치했지만, 정리 직전에 도구 호출이 있었다.
    vi.setSystemTime(Date.now() + mod.OWNED_GRACE_MS + 1_000);
    mod.touchOwnedTab(501);
    await openWorkTab(mod, h, 503, SESSION);

    expect(h.tabs.has(501)).toBe(true);
  });

  it('다른 레인의 탭은 유예를 넘겨도 건드리지 않는다', async () => {
    const { mod } = await loadModules();
    const laneA = mod.sessionKeyOf({ _mcpSessionId: SESSION, lane: 'a' });
    const laneB = mod.sessionKeyOf({ _mcpSessionId: SESSION, lane: 'b' });

    await openWorkTab(mod, h, 601, laneB);
    vi.setSystemTime(Date.now() + 1_000);
    // 601 을 작업 탭 자리에서 밀어내 "보호받지 않는 레인 B 의 탭" 으로 만든다.
    await openWorkTab(mod, h, 602, laneB);

    vi.setSystemTime(Date.now() + mod.OWNED_GRACE_MS + 60_000);
    await openWorkTab(mod, h, 611, laneA);

    expect(h.tabs.has(601)).toBe(true);
    expect(h.tabs.has(602)).toBe(true);
  });

  it('아주 오래 방치된 탭은 레인을 가리지 않고 청소한다 (사라진 에이전트 뒷정리)', async () => {
    const { mod } = await loadModules();
    const laneA = mod.sessionKeyOf({ _mcpSessionId: SESSION, lane: 'a' });
    const laneB = mod.sessionKeyOf({ _mcpSessionId: SESSION, lane: 'b' });

    await openWorkTab(mod, h, 701, laneB);
    vi.setSystemTime(Date.now() + 1_000);
    await openWorkTab(mod, h, 702, laneB); // 701 은 이제 작업 탭이 아니다

    vi.setSystemTime(Date.now() + mod.OWNED_ABANDON_MS + 60_000);
    await openWorkTab(mod, h, 711, laneA);

    expect(h.tabs.has(701)).toBe(false);
    expect(mod.describeClosedTab(701)).toMatch(/unused for \d+min/);
    // 702 는 레인 B 의 현재 작업 탭 — 아무리 오래돼도 남긴다.
    expect(h.tabs.has(702)).toBe(true);
  });

  it('레인당 상한을 넘으면 오래된 순으로 정리한다', async () => {
    const { mod } = await loadModules();
    const opened: number[] = [];

    // 유예 안에서 상한 + 3 개를 연다.
    for (let i = 0; i < mod.MAX_OWNED_PER_KEY + 3; i++) {
      const tabId = 800 + i;
      opened.push(tabId);
      await openWorkTab(mod, h, tabId, SESSION);
      vi.setSystemTime(Date.now() + 1_000);
    }

    // 현재 작업 탭 1개 + 유예 안 여분 상한만큼만 남는다.
    expect(h.tabs.size).toBeLessThanOrEqual(mod.MAX_OWNED_PER_KEY + 1);
    // 가장 오래된 것부터 닫혔다.
    expect(h.tabs.has(opened[0])).toBe(false);
    expect(h.tabs.has(opened[opened.length - 1])).toBe(true);
  });

  it('실행 중인 탭 / 사용자가 보고 있는 탭은 절대 닫지 않는다', async () => {
    const { mod, lock } = await loadModules();

    await openWorkTab(mod, h, 901, SESSION); // busy 로 만들 탭
    vi.setSystemTime(Date.now() + 1_000);
    await openWorkTab(mod, h, 902, SESSION); // 사용자가 보고 있는 탭
    vi.setSystemTime(Date.now() + 1_000);
    await openWorkTab(mod, h, 903, SESSION);

    // 세 탭 모두 유예 밖으로 보낸 뒤, 정리 직전 상태만 다르게 만든다.
    vi.setSystemTime(Date.now() + mod.OWNED_GRACE_MS + 1_000);
    lock.markTabBusy(901); // 도구 실행 중
    h.tabs.set(902, { active: true, windowId: 1 }); // 사용자가 보고 있음

    await openWorkTab(mod, h, 904, SESSION);

    expect(h.tabs.has(901)).toBe(true);
    expect(h.tabs.has(902)).toBe(true);
    expect(h.tabs.has(903)).toBe(false); // 보호 사유가 없는 유휴 탭만 정리
  });

  it('구버전 저장 형식(number[]) 을 읽어도 깨지지 않는다', async () => {
    const { mod } = await loadModules();
    h.openTab(1001);
    h.openTab(1002);
    // v1.6.0 이 남긴 형식
    h.sessionStore['mcpOwnedTabs'] = { [SESSION]: [1001, 1002] };

    await openWorkTab(mod, h, 1003, SESSION);

    // 마이그레이션된 항목은 "지금 막 쓴 것" 으로 취급 → 유예 안이라 살아남는다.
    expect(h.tabs.has(1001)).toBe(true);
    expect(h.tabs.has(1002)).toBe(true);
    expect(h.tabs.has(1003)).toBe(true);
  });
});
