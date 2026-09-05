/**
 * auto-chrome-mcp fork — automation-guard unit tests (task C1, background work mode).
 *
 * E1 도메인별 soft throttle (10초/30회 초과분 지연, 상한 5초) 과
 * E2 동일 호출 반복 가드 (120초 내 12회 → 차단, 다른 호출이 끼면 리셋) 를 검증한다.
 *
 * 이 모듈은 도메인/세션 상태를 모듈 스코프 Map 에 들고 있으므로 테스트마다
 * mock 설치 → vi.resetModules() → 동적 import 로 격리한다.
 * Date.now 는 vi.useFakeTimers + vi.setSystemTime 으로 결정론화한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type AutomationGuard = typeof import('@/utils/automation-guard');

interface ChromeHarness {
  localStore: Record<string, unknown>;
  tabUrls: Map<number, string>;
  localGet: ReturnType<typeof vi.fn>;
  localSet: ReturnType<typeof vi.fn>;
  /** popup 등 외부에서 값을 바꾼 것처럼 onChanged 리스너를 직접 울린다 (localSet 을 거치지 않고). */
  fireChanged: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) => void;
}

const T0 = new Date('2026-01-01T00:00:00Z').getTime();

function installChromeMocks(): ChromeHarness {
  const localStore: Record<string, unknown> = {};
  const tabUrls = new Map<number, string>();
  type ChangeListener = (
    changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
    areaName: string,
  ) => void;
  const changeListeners: ChangeListener[] = [];

  const toKeys = (keys: unknown): string[] =>
    Array.isArray(keys) ? (keys as string[]) : typeof keys === 'string' ? [keys] : [];

  const localGet = vi.fn(async (keys: unknown) => {
    const out: Record<string, unknown> = {};
    for (const key of toKeys(keys)) {
      if (key in localStore) out[key] = localStore[key];
    }
    return out;
  });
  const localSet = vi.fn(async (items: Record<string, unknown>) => {
    const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
    for (const key of Object.keys(items)) {
      changes[key] = { oldValue: localStore[key], newValue: items[key] };
    }
    Object.assign(localStore, items);
    // 실제 chrome.storage.onChanged 는 변경을 발생시킨 컨텍스트에도 발화한다.
    for (const listener of changeListeners) listener(changes, 'local');
  });
  const fireChanged: ChromeHarness['fireChanged'] = (changes) => {
    for (const listener of changeListeners) listener(changes, 'local');
  };

  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: { get: localGet, set: localSet, remove: vi.fn(async () => undefined) },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
      onChanged: {
        addListener: vi.fn((fn: ChangeListener) => changeListeners.push(fn)),
        removeListener: vi.fn((fn: ChangeListener) => {
          const idx = changeListeners.indexOf(fn);
          if (idx >= 0) changeListeners.splice(idx, 1);
        }),
      },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => {
        const url = tabUrls.get(tabId);
        if (!url) throw new Error(`No tab with id: ${tabId}`);
        return { id: tabId, url };
      }),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
    },
  };

  return { localStore, tabUrls, localGet, localSet, fireChanged };
}

async function loadModule(): Promise<AutomationGuard> {
  vi.resetModules();
  return await import('@/utils/automation-guard');
}

function isBlocked(verdict: unknown): verdict is { blocked: string } {
  return !!verdict && typeof verdict === 'object' && 'blocked' in (verdict as object);
}

function delayOf(verdict: unknown): number {
  if (verdict && typeof verdict === 'object' && 'delayMs' in (verdict as object)) {
    return (verdict as { delayMs: number }).delayMs;
  }
  return 0;
}

describe('automation-guard (auto-chrome-mcp fork — 밴 예방 안전장치)', () => {
  let h: ChromeHarness;

  beforeEach(() => {
    h = installChromeMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('설정 접근자', () => {
    it('기본값은 true (키 없음 → 활성)', async () => {
      const mod = await loadModule();
      expect(await mod.isAutomationGuardEnabled()).toBe(true);
    });

    it('명시적 false 만 비활성으로 읽는다', async () => {
      const mod = await loadModule();
      h.localStore[mod.AUTOMATION_GUARD_STORAGE_KEY] = false;
      expect(await mod.isAutomationGuardEnabled()).toBe(false);
      // 캐시가 생겼으므로 storage 를 직접 고쳐도 반영되지 않는다 — onChanged 로 알려야 한다
      // (실제 chrome 에서는 storage.local.set 이 이 이벤트를 발생시킨다).
      h.fireChanged({ [mod.AUTOMATION_GUARD_STORAGE_KEY]: { oldValue: false, newValue: true } });
      expect(await mod.isAutomationGuardEnabled()).toBe(true);
    });

    it('storage 읽기 실패 시에도 true 로 fail-safe', async () => {
      const mod = await loadModule();
      h.localGet.mockRejectedValueOnce(new Error('storage down'));
      expect(await mod.isAutomationGuardEnabled()).toBe(true);
    });

    it('setter 는 automationGuardEnabled 키에 쓴다', async () => {
      const mod = await loadModule();
      await mod.setAutomationGuardEnabled(false);
      expect(h.localSet).toHaveBeenCalledWith({ automationGuardEnabled: false });
      expect(mod.AUTOMATION_GUARD_STORAGE_KEY).toBe('automationGuardEnabled');
    });
  });

  describe('캐시 (task E4)', () => {
    it('두 번째 호출부터는 storage.local.get 을 다시 부르지 않는다', async () => {
      const mod = await loadModule();
      expect(await mod.isAutomationGuardEnabled()).toBe(true);
      expect(await mod.isAutomationGuardEnabled()).toBe(true);
      expect(await mod.isAutomationGuardEnabled()).toBe(true);
      expect(h.localGet).toHaveBeenCalledTimes(1);
    });

    it('storage 읽기 실패는 캐시하지 않는다 (다음 호출에서 다시 시도)', async () => {
      const mod = await loadModule();
      h.localGet.mockRejectedValueOnce(new Error('storage down'));
      expect(await mod.isAutomationGuardEnabled()).toBe(true); // fail-safe, 캐시 안 됨
      expect(h.localGet).toHaveBeenCalledTimes(1);

      h.localStore[mod.AUTOMATION_GUARD_STORAGE_KEY] = false;
      expect(await mod.isAutomationGuardEnabled()).toBe(false); // 재조회 성공 → 이제 캐시됨
      expect(h.localGet).toHaveBeenCalledTimes(2);
    });

    it('setAutomationGuardEnabled 직후 재조회 없이 새 값을 즉시 반영한다', async () => {
      const mod = await loadModule();
      expect(await mod.isAutomationGuardEnabled()).toBe(true);
      expect(h.localGet).toHaveBeenCalledTimes(1);

      await mod.setAutomationGuardEnabled(false);
      expect(await mod.isAutomationGuardEnabled()).toBe(false);
      // set() 이 즉시 캐시를 갱신하므로 get 은 여전히 처음 1회뿐이어야 한다
      expect(h.localGet).toHaveBeenCalledTimes(1);
    });

    it('popup 등 외부에서 storage.local.set 으로 값을 바꾸면 onChanged 로 캐시가 즉시 갱신된다', async () => {
      const mod = await loadModule();
      expect(await mod.isAutomationGuardEnabled()).toBe(true);
      expect(h.localGet).toHaveBeenCalledTimes(1);

      // 이 모듈의 setter 를 거치지 않고, popup 이 직접 storage 에 쓰는 상황을 재현한다.
      await h.localSet({ [mod.AUTOMATION_GUARD_STORAGE_KEY]: false });

      expect(await mod.isAutomationGuardEnabled()).toBe(false);
      expect(h.localGet).toHaveBeenCalledTimes(1); // onChanged 로 갱신됐으니 재조회 없음
    });

    it('다른 키의 변경은 캐시를 건드리지 않는다', async () => {
      const mod = await loadModule();
      expect(await mod.isAutomationGuardEnabled()).toBe(true);
      await h.localSet({ someUnrelatedKey: 123 });
      expect(await mod.isAutomationGuardEnabled()).toBe(true);
      expect(h.localGet).toHaveBeenCalledTimes(1);
    });
  });

  describe('가드 비활성 시', () => {
    it('반복이든 폭주든 항상 null 을 반환한다', async () => {
      const mod = await loadModule();
      h.localStore.automationGuardEnabled = false;
      vi.useFakeTimers();
      vi.setSystemTime(T0);

      for (let i = 0; i < 50; i++) {
        const verdict = await mod.applyAutomationGuard('chrome_click_element', {
          url: 'https://shop.example.com/item',
          selector: '#buy',
        });
        expect(verdict).toBeNull();
      }
    });
  });

  describe('E2 — 동일 호출 반복 가드', () => {
    const args = { url: 'https://shop.example.com/item', selector: '#buy' };

    it('동일 호출 11회까지는 통과, 12회째에 차단한다', async () => {
      const mod = await loadModule();
      vi.useFakeTimers();
      vi.setSystemTime(T0);

      for (let i = 1; i <= 11; i++) {
        const verdict = await mod.applyAutomationGuard('chrome_click_element', { ...args });
        expect(isBlocked(verdict), `call #${i} should pass`).toBe(false);
        vi.setSystemTime(Date.now() + 100);
      }

      const verdict = await mod.applyAutomationGuard('chrome_click_element', { ...args });
      expect(isBlocked(verdict)).toBe(true);
      if (isBlocked(verdict)) {
        expect(verdict.blocked).toContain('chrome_click_element');
        expect(verdict.blocked).toContain('runaway loop');
      }
    });

    it('중간에 다른 호출이 끼면 연속 카운트가 리셋된다', async () => {
      const mod = await loadModule();
      vi.useFakeTimers();
      vi.setSystemTime(T0);

      for (let i = 1; i <= 11; i++) {
        await mod.applyAutomationGuard('chrome_click_element', { ...args });
        vi.setSystemTime(Date.now() + 100);
      }

      // 다른 호출 1건 → 연속 스트릭 리셋
      const other = await mod.applyAutomationGuard('chrome_click_element', {
        ...args,
        selector: '#other',
      });
      expect(isBlocked(other)).toBe(false);

      for (let i = 1; i <= 11; i++) {
        const verdict = await mod.applyAutomationGuard('chrome_click_element', { ...args });
        expect(isBlocked(verdict), `post-reset call #${i} should pass`).toBe(false);
        vi.setSystemTime(Date.now() + 100);
      }
    });

    it('반복 윈도우(120초) 를 넘기면 스트릭이 다시 시작된다', async () => {
      const mod = await loadModule();
      vi.useFakeTimers();
      vi.setSystemTime(T0);

      for (let i = 1; i <= 11; i++) {
        await mod.applyAutomationGuard('chrome_click_element', { ...args });
      }
      vi.setSystemTime(T0 + 121_000);

      const verdict = await mod.applyAutomationGuard('chrome_click_element', { ...args });
      expect(isBlocked(verdict)).toBe(false);
    });

    it('세션마다 독립적으로 추적한다 (다른 세션이 남의 스트릭을 리셋하지 못함)', async () => {
      const mod = await loadModule();
      vi.useFakeTimers();
      vi.setSystemTime(T0);

      const callA = () =>
        mod.applyAutomationGuard('chrome_click_element', {
          ...args,
          _mcpSessionId: 'stdio-1-aaaaaa',
        });
      const callB = () =>
        mod.applyAutomationGuard('chrome_click_element', {
          ...args,
          _mcpSessionId: 'stdio-2-bbbbbb',
        });

      for (let i = 1; i <= 11; i++) {
        expect(isBlocked(await callA())).toBe(false);
        // B 세션이 같은 호출을 껴 넣어도 A 의 스트릭은 유지되어야 한다
        expect(isBlocked(await callB()), `session B call #${i} should pass`).toBe(false);
        vi.setSystemTime(Date.now() + 100);
      }

      expect(isBlocked(await callA())).toBe(true); // A 는 12회째 → 차단
      expect(isBlocked(await callB())).toBe(true); // B 도 자기 12회째 → 차단
    });

    it('한 세션의 차단이 다른 세션을 막지 않는다', async () => {
      const mod = await loadModule();
      vi.useFakeTimers();
      vi.setSystemTime(T0);

      for (let i = 1; i <= 12; i++) {
        await mod.applyAutomationGuard('chrome_click_element', {
          ...args,
          _mcpSessionId: 'stdio-1-aaaaaa',
        });
      }

      const fresh = await mod.applyAutomationGuard('chrome_click_element', {
        ...args,
        _mcpSessionId: 'stdio-2-bbbbbb',
      });
      expect(isBlocked(fresh)).toBe(false);
    });

    it('_mcpSessionId 는 반복 키에서 제외된다 (세션 id 만 다른 동일 호출은 같은 호출)', async () => {
      const mod = await loadModule();
      vi.useFakeTimers();
      vi.setSystemTime(T0);

      // 세션 버킷은 같고(문자열 아님 → 'default') _mcpSessionId 값만 매번 다르다.
      // 키에서 제외되지 않는다면 매 호출이 새 스트릭이라 절대 차단되지 않는다.
      let verdict: unknown = null;
      for (let i = 1; i <= 12; i++) {
        verdict = await mod.applyAutomationGuard('chrome_click_element', {
          ...args,
          _mcpSessionId: i,
        });
      }
      expect(isBlocked(verdict)).toBe(true);
    });

    it('레인이 다르면 반복 카운터도 분리된다 (병렬 에이전트가 서로를 폭주로 만들지 않음)', async () => {
      const mod = await loadModule();
      vi.useFakeTimers();
      vi.setSystemTime(T0);

      // 서브에이전트 4개는 stdio 세션을 공유한다 — 레인이 없으면 같은 버킷을 쓴다.
      const lanes = ['agent-1', 'agent-2', 'agent-3', 'agent-4'];
      let verdict: unknown = null;
      for (let round = 1; round <= 11; round++) {
        for (const lane of lanes) {
          verdict = await mod.applyAutomationGuard('chrome_click_element', {
            ...args,
            _mcpSessionId: 'stdio-1-aaaaaa',
            lane,
          });
          expect(isBlocked(verdict), `lane ${lane} round ${round} should pass`).toBe(false);
        }
        vi.setSystemTime(Date.now() + 100);
      }

      // 각 레인이 자기 12회째에 도달했을 때만 차단된다.
      verdict = await mod.applyAutomationGuard('chrome_click_element', {
        ...args,
        _mcpSessionId: 'stdio-1-aaaaaa',
        lane: 'agent-1',
      });
      expect(isBlocked(verdict)).toBe(true);
    });

    it('lane 은 반복 키에서 제외된다 (같은 레인의 동일 호출은 여전히 폭주로 잡힌다)', async () => {
      const mod = await loadModule();
      vi.useFakeTimers();
      vi.setSystemTime(T0);

      let verdict: unknown = null;
      for (let i = 1; i <= 12; i++) {
        verdict = await mod.applyAutomationGuard('chrome_click_element', {
          ...args,
          _mcpSessionId: 'stdio-1-aaaaaa',
          lane: 'agent-1',
        });
      }
      expect(isBlocked(verdict)).toBe(true);
    });

    it('직렬화 불가능한 인자(순환 참조) 여도 던지지 않는다', async () => {
      const mod = await loadModule();
      vi.useFakeTimers();
      vi.setSystemTime(T0);

      const circular: Record<string, unknown> = { url: 'https://shop.example.com/item' };
      circular.self = circular;

      await expect(
        mod.applyAutomationGuard('chrome_click_element', circular),
      ).resolves.not.toThrow();
    });
  });

  describe('E1 — 도메인별 soft throttle', () => {
    /** 같은 도메인, 매번 다른 인자 (반복 가드를 건드리지 않기 위해) */
    const call = (mod: AutomationGuard, domain: string, i: number) =>
      mod.applyAutomationGuard('chrome_click_element', {
        url: `https://${domain}/page/${i}`,
        selector: `#n${i}`,
      });

    it('윈도우 내 30회까지는 지연 없음, 31회째부터 지연이 붙는다', async () => {
      const mod = await loadModule();
      vi.useFakeTimers();
      vi.setSystemTime(T0);

      for (let i = 0; i < 30; i++) {
        expect(await call(mod, 'a.example.com', i), `call #${i + 1}`).toBeNull();
      }

      const verdict = await call(mod, 'a.example.com', 30);
      expect(delayOf(verdict)).toBeGreaterThan(0);
    });

    it('지연은 절대 5000ms 를 넘지 않는다', async () => {
      const mod = await loadModule();
      vi.useFakeTimers();
      vi.setSystemTime(T0);

      for (let i = 0; i < 120; i++) {
        const verdict = await call(mod, 'a.example.com', i);
        expect(delayOf(verdict)).toBeLessThanOrEqual(5000);
      }
    });

    it('도메인 버킷은 서로 독립이다', async () => {
      const mod = await loadModule();
      vi.useFakeTimers();
      vi.setSystemTime(T0);

      for (let i = 0; i < 31; i++) await call(mod, 'a.example.com', i);

      expect(await call(mod, 'b.example.com', 0)).toBeNull();
    });

    it('윈도우(10초) 가 지나면 지연이 사라진다', async () => {
      const mod = await loadModule();
      vi.useFakeTimers();
      vi.setSystemTime(T0);

      for (let i = 0; i < 31; i++) await call(mod, 'a.example.com', i);
      expect(delayOf(await call(mod, 'a.example.com', 31))).toBeGreaterThan(0);

      vi.setSystemTime(T0 + 30_000);
      expect(await call(mod, 'a.example.com', 32)).toBeNull();
    });

    it('url 이 없으면 tabId 로 도메인을 해석해 같은 버킷을 쓴다', async () => {
      const mod = await loadModule();
      h.tabUrls.set(1, 'https://a.example.com/current');
      vi.useFakeTimers();
      vi.setSystemTime(T0);

      for (let i = 0; i < 30; i++) await call(mod, 'a.example.com', i);

      const verdict = await mod.applyAutomationGuard('chrome_click_element', {
        tabId: 1,
        selector: '#via-tab',
      });
      expect(delayOf(verdict)).toBeGreaterThan(0);
    });

    it('http(s) 가 아닌 url 은 도메인 버킷을 만들지 않는다 (전역 버킷)', async () => {
      const mod = await loadModule();
      vi.useFakeTimers();
      vi.setSystemTime(T0);

      for (let i = 0; i < 30; i++) await call(mod, 'a.example.com', i);

      // chrome:// 은 도메인 추출 실패 → __global__ 버킷 → 아직 여유 있음
      const verdict = await mod.applyAutomationGuard('chrome_click_element', {
        url: 'chrome://extensions/',
        selector: '#x',
      });
      expect(verdict).toBeNull();
    });
  });
});
