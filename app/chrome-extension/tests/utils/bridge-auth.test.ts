/**
 * auto-chrome-mcp fork — 브리지 HTTP 인증 토큰 헬퍼의 계약.
 *
 * 브리지는 loopback HTTP 서버라 같은 PC 안의 다른 프로그램도 그 포트를 두드릴 수 있다.
 * 브리지가 기동 시 만든 토큰을 네이티브 메시징(SERVER_STARTED)으로만 확장에 알려 주고,
 * 확장은 모든 브리지 HTTP 호출에 그 토큰을 실어 보낸다.
 *
 * 계약:
 *   - 토큰이 없으면 헤더 없이 보낸다 (토큰을 안 주는 옛 브리지와 그대로 붙는다)
 *   - 토큰이 있으면 Authorization: Bearer <token>
 *   - 빈 값을 저장하면 기록을 지운다 (옛 브리지로 되돌아갔을 때 낡은 토큰을 안 보낸다)
 *   - storage.session 을 못 쓰는 컨텍스트에서도 죽지 않고 "토큰 없음" 으로 동작한다
 *   - 401/403 은 버전 불일치 안내로 이어진다
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type BridgeAuth = typeof import('@/utils/bridge-auth');

const TOKEN_KEY = 'mcpBridgeAuthToken';

function installChrome(options: { broken?: boolean } = {}): Record<string, unknown> {
  const store: Record<string, unknown> = {};
  const toKeys = (keys: unknown): string[] =>
    Array.isArray(keys) ? (keys as string[]) : typeof keys === 'string' ? [keys] : [];

  const area = options.broken
    ? {
        get: vi.fn(async () => {
          throw new Error('storage.session unavailable');
        }),
        set: vi.fn(async () => {
          throw new Error('storage.session unavailable');
        }),
        remove: vi.fn(async () => {
          throw new Error('storage.session unavailable');
        }),
      }
    : {
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
      };

  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { id: 'test-extension-id' },
    storage: { session: area },
  };
  return store;
}

async function loadModule(): Promise<BridgeAuth> {
  vi.resetModules();
  return await import('@/utils/bridge-auth');
}

describe('bridge-auth — 브리지 HTTP 인증 토큰', () => {
  let store: Record<string, unknown>;

  beforeEach(() => {
    store = installChrome();
  });

  it('토큰이 없으면 헤더를 붙이지 않는다 (토큰을 안 주는 옛 브리지 호환)', async () => {
    const mod = await loadModule();
    expect(await mod.getBridgeAuthToken()).toBeNull();
    expect(await mod.getBridgeAuthHeaders()).toEqual({});
  });

  it('토큰을 저장하면 Authorization: Bearer 로 실어 보낸다', async () => {
    const mod = await loadModule();
    await mod.setBridgeAuthToken('tok-abc123');

    expect(store[TOKEN_KEY]).toBe('tok-abc123');
    expect(await mod.getBridgeAuthHeaders()).toEqual({ Authorization: 'Bearer tok-abc123' });
  });

  it('기존 헤더를 지우지 않고 합친다', async () => {
    const mod = await loadModule();
    await mod.setBridgeAuthToken('tok-abc123');

    expect(await mod.withBridgeAuth({ 'Content-Type': 'application/json' })).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer tok-abc123',
    });
  });

  it('빈 값·undefined 를 저장하면 기록을 지운다 (낡은 토큰을 계속 보내지 않는다)', async () => {
    const mod = await loadModule();
    await mod.setBridgeAuthToken('tok-abc123');
    await mod.setBridgeAuthToken(undefined);

    expect(store[TOKEN_KEY]).toBeUndefined();
    expect(await mod.getBridgeAuthHeaders()).toEqual({});

    await mod.setBridgeAuthToken('tok-abc123');
    await mod.setBridgeAuthToken('   ');
    expect(await mod.getBridgeAuthHeaders()).toEqual({});
  });

  it('storage.session 을 못 쓰는 컨텍스트에서도 죽지 않는다', async () => {
    installChrome({ broken: true });
    const mod = await loadModule();

    await expect(mod.setBridgeAuthToken('tok')).resolves.toBeUndefined();
    expect(await mod.getBridgeAuthToken()).toBeNull();
    expect(await mod.getBridgeAuthHeaders()).toEqual({});
  });

  it('401·403 만 버전 불일치 안내로 이어진다', async () => {
    const mod = await loadModule();
    expect(mod.isBridgeAuthFailure(401)).toBe(true);
    expect(mod.isBridgeAuthFailure(403)).toBe(true);
    expect(mod.isBridgeAuthFailure(200)).toBe(false);
    expect(mod.isBridgeAuthFailure(500)).toBe(false);

    expect(mod.bridgeAuthHint(401)).toBe(mod.BRIDGE_AUTH_MISMATCH_MESSAGE);
    expect(mod.bridgeAuthHint(500)).toBeNull();
    expect(mod.BRIDGE_AUTH_MISMATCH_MESSAGE).toContain('브리지와 확장 버전이 다릅니다');
  });
});
