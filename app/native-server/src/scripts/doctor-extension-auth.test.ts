import { describe, expect, test, beforeEach, afterAll, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkExtensionAuth, resolveExtensionAuthPorts } from './doctor';
import { STATE_DIR_ENV, getStateDir, getTokenFilePath } from '../security/auth-token';

/**
 * auto-chrome-mcp fork — doctor 의 stale-extension 검사가 고정 포트만 보던 회귀.
 *
 * 예전에는 `checkExtensionAuth(EXPECTED_PORT)` 라 12320 하나만 조회했다. 그래서
 * `.mcp.json` 의 `env.CHROME_PORT` 로 포트를 바꿔 쓰거나 팝업에서 동적 포트를 쓰는
 * 설치에서는, 확장이 토큰 없이 브리지를 두드려 401 을 받고 있어도 doctor 가
 * "the extension sends the bridge token" 이라고 답했다.
 */
const tempRoots: string[] = [];
const originalStateDir = process.env[STATE_DIR_ENV];
const originalFetch = globalThis.fetch;

const TOKEN = 'a'.repeat(64);

const freshStateDir = (): void => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-doctor-test-'));
  tempRoots.push(dir);
  process.env[STATE_DIR_ENV] = path.join(dir, '.auto-chrome-mcp');
  fs.mkdirSync(getStateDir(), { recursive: true });
  fs.writeFileSync(getTokenFilePath(), `${TOKEN}\n`);
};

/** 지정한 포트에서만 /health 상세를 주는 브리지 흉내. 나머지 포트는 연결 거부. */
const mockBridges = (byPort: Record<number, { staleClientRejections: number }>) => {
  const seen: string[] = [];
  const fake = async (input: any) => {
    const url = String(input);
    seen.push(url);
    const matched = /^http:\/\/127\.0\.0\.1:(\d+)\/health$/.exec(url);
    const port = matched ? Number(matched[1]) : -1;
    const detail = byPort[port];
    if (!detail) throw new Error(`connect ECONNREFUSED 127.0.0.1:${port}`);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        extension_auth: {
          stale_client_rejections: detail.staleClientRejections,
          last_origin: 'chrome-extension://aogfhfajjknomcnmlkbjmihjbknlhbbi',
        },
      }),
    };
  };
  globalThis.fetch = fake as unknown as typeof globalThis.fetch;
  return seen;
};

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalStateDir === undefined) delete process.env[STATE_DIR_ENV];
  else process.env[STATE_DIR_ENV] = originalStateDir;
  for (const dir of tempRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 정리 실패는 테스트 결과에 영향 없음 */
    }
  }
});

describe('doctor / extension token support', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    freshStateDir();
  });

  test('커스텀 포트의 브리지가 stale 카운트를 주면 warn 이 된다', async () => {
    // 12320 은 아무도 안 듣고, 사용자가 .mcp.json 으로 지정한 12345 에만 브리지가 있다.
    const seen = mockBridges({ 12345: { staleClientRejections: 3 } });

    const ports = resolveExtensionAuthPorts({ configuredPort: 12345, responsivePorts: [] });
    const result = await checkExtensionAuth(ports);

    expect(seen).toContain('http://127.0.0.1:12345/health');
    expect(result.check.status).toBe('warn');
    expect(result.check.message).toContain('3');
    expect(result.nextStep).toBeTruthy();
    const details = result.check.details as Record<string, unknown>;
    expect(details.staleClientRejections).toBe(3);
  });

  test('여러 포트에 걸쳐 stale 카운트를 합산한다', async () => {
    mockBridges({
      12320: { staleClientRejections: 0 },
      12345: { staleClientRejections: 2 },
    });

    const result = await checkExtensionAuth([12320, 12345]);

    expect(result.check.status).toBe('warn');
    const details = result.check.details as Record<string, unknown>;
    expect(details.staleClientRejections).toBe(2);
    expect(details.reportingPorts).toEqual([12320, 12345]);
  });

  test('응답한 브리지가 모두 0 이면 ok 다', async () => {
    mockBridges({ 12320: { staleClientRejections: 0 } });

    const result = await checkExtensionAuth([12320, 12345]);

    expect(result.check.status).toBe('ok');
    expect(result.check.message).toContain('token');
    expect(result.nextStep).toBeUndefined();
  });

  test('아무 포트도 응답하지 않으면 검사하지 않았다고 말한다 (통과했다고 하지 않는다)', async () => {
    mockBridges({});

    const result = await checkExtensionAuth([12320, 12345]);

    expect(result.check.status).toBe('ok');
    expect(result.check.message).toContain('not checked');
  });

  test('resolveExtensionAuthPorts 는 env · 설정 · 기본 · 응답 포트를 중복 없이 모은다', () => {
    expect(
      resolveExtensionAuthPorts({
        envPort: '12345',
        configuredPort: 12320,
        responsivePorts: [12317, 12320],
      }),
    ).toEqual([12345, 12320, 12317]);

    // 값이 없거나 포트가 될 수 없으면 버린다. 기본 포트는 언제나 후보에 남는다.
    expect(
      resolveExtensionAuthPorts({ envPort: 'abc', configuredPort: 0, responsivePorts: [70000] }),
    ).toEqual([12320]);
  });
});
