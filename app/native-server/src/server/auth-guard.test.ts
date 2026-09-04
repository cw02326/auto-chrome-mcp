import { describe, expect, test } from '@jest/globals';
import { decideAuthorization, normalizeRoutePath, isPublicPath, TOKEN_HEADER } from './auth-guard';

/**
 * auto-chrome-mcp fork — 인증 게이트 판정 단위 테스트.
 *
 * 독립 검증에서 지적된 두 구멍을 고정한다:
 *   ① 확장 origin 을 신원으로 인정해 토큰 없이 통과시키던 예외 (확장이 아닌 프로세스도
 *      Origin 헤더를 자유롭게 붙일 수 있다 — 브라우저 밖에서 온 요청은 아무 값이나 가능).
 *   ② Host 헤더를 보지 않아 DNS rebinding(attacker.example → 127.0.0.1)이 통했던 문제.
 */
const TOKEN = 'a'.repeat(64);
const PORT = 12320;

const decide = (over: Partial<Parameters<typeof decideAuthorization>[0]> = {}) =>
  decideAuthorization({
    method: 'POST',
    url: '/admin/kill-self',
    headers: { host: `127.0.0.1:${PORT}` },
    expectedToken: TOKEN,
    expectedPort: PORT,
    ...over,
  });

describe('server/auth-guard 판정', () => {
  test('경로 정규화', () => {
    expect(normalizeRoutePath('/ping?x=1')).toBe('/ping');
    expect(normalizeRoutePath('/health/')).toBe('/health');
    expect(isPublicPath('/ping')).toBe(true);
    expect(isPublicPath('/admin/drain')).toBe(false);
  });

  test('확장 origin 이라도 토큰이 없으면 401 이다 (origin 예외 제거)', () => {
    const decision = decide({
      headers: {
        host: `127.0.0.1:${PORT}`,
        origin: 'chrome-extension://hgmoaheomcamnahggoegjcgignmmedmc',
      },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('unauthorized');
    expect(decision.status).toBe(401);
  });

  test('확장 origin + 올바른 토큰은 통과한다', () => {
    const decision = decide({
      headers: {
        host: `127.0.0.1:${PORT}`,
        origin: 'chrome-extension://hgmoaheomcamnahggoegjcgignmmedmc',
        authorization: `Bearer ${TOKEN}`,
      },
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('token');
  });

  test('토큰이 없는 브리지(파일 없음)에서는 확장 origin 도 통과하지 못한다', () => {
    const decision = decide({
      expectedToken: null,
      headers: {
        host: `127.0.0.1:${PORT}`,
        origin: 'chrome-extension://hgmoaheomcamnahggoegjcgignmmedmc',
      },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('unauthorized');
  });

  test('대체 헤더로도 토큰을 받는다', () => {
    const decision = decide({
      headers: { host: `127.0.0.1:${PORT}`, [TOKEN_HEADER]: TOKEN },
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('token');
  });

  test('허용 목록 밖 origin 은 토큰이 있어도 403 이다', () => {
    const decision = decide({
      headers: {
        host: `127.0.0.1:${PORT}`,
        origin: 'https://evil.example',
        authorization: `Bearer ${TOKEN}`,
      },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('bad_origin');
    expect(decision.status).toBe(403);
  });

  test('Host 가 loopback 이 아니면 403 이다 (공개 경로 포함)', () => {
    for (const url of ['/ping', '/health', '/mcp']) {
      const decision = decide({
        method: 'GET',
        url,
        headers: { host: 'attacker.example' },
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('bad_host');
      expect(decision.status).toBe(403);
    }
  });

  test('Host 헤더가 없으면 403 이다', () => {
    const decision = decide({ method: 'GET', url: '/ping', headers: {} });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('bad_host');
  });

  test('Host 의 포트가 listen 포트와 다르면 403 이다', () => {
    const decision = decide({
      method: 'GET',
      url: '/ping',
      headers: { host: `127.0.0.1:${PORT + 1}` },
    });
    expect(decision.reason).toBe('bad_host');
  });

  test('loopback Host 의 공개 경로는 토큰 없이 통과한다', () => {
    for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]) {
      const decision = decide({ method: 'GET', url: '/ping', headers: { host } });
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe('public');
    }
  });

  test('CORS preflight 는 Host 가 맞으면 인증 없이 지나간다', () => {
    const decision = decide({
      method: 'OPTIONS',
      headers: {
        host: `127.0.0.1:${PORT}`,
        origin: 'chrome-extension://hgmoaheomcamnahggoegjcgignmmedmc',
      },
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('preflight');
  });
});
