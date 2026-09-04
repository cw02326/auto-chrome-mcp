import { describe, expect, test, beforeEach } from '@jest/globals';
import * as originModule from './origin';
import {
  collectExtensionOriginsFromArgv,
  getTrustedExtensionOrigins,
  isAllowedCorsOrigin,
  isAllowedHostHeader,
  isExtensionOrigin,
  isLoopbackOrigin,
  parseHostHeader,
  parseOrigin,
  setTrustedExtensionOrigins,
} from './origin';

/**
 * auto-chrome-mcp fork — Origin / Host 판정 회귀 테스트.
 *
 * 예전 CORS 검사는 `origin.startsWith('http://127.0.0.1')` 였다. 그래서
 * `http://127.0.0.1.attacker.example` 같은 원격 origin 이 로컬로 취급됐다
 * (공격자가 DNS 를 127.0.0.1 로 돌려놓으면 브라우저 안에서 로컬 브리지에 붙는다).
 *
 * 그리고 확장 origin 을 "토큰 없이 통과" 신원으로 쓰던 예외는 제거됐다. 신뢰 목록은
 * 이제 로그·doctor 정보용이며 인증 판정에는 쓰이지 않는다.
 */
describe('security/origin', () => {
  beforeEach(() => {
    setTrustedExtensionOrigins([]);
  });

  test('loopback prefix 를 흉내낸 원격 origin 은 통과하지 못한다 (startsWith 회귀)', () => {
    const spoofed = [
      'http://127.0.0.1.attacker.example',
      'http://127.0.0.1.attacker.example:8080',
      'https://127.0.0.1.evil.test',
      'http://127.0.0.1evil.test',
      'http://localhost.attacker.example',
    ];
    for (const origin of spoofed) {
      // 예전 검사(prefix 비교)는 이 값들을 로컬로 봤다.
      const passedOldCheck =
        origin.startsWith('http://127.0.0.1') ||
        origin.startsWith('http://localhost') ||
        origin.startsWith('https://127.0.0.1');
      expect(passedOldCheck).toBe(true);
      expect(isLoopbackOrigin(origin)).toBe(false);
      expect(isAllowedCorsOrigin(origin)).toBe(false);
    }
  });

  test('진짜 loopback origin 은 포트에 상관없이 허용된다', () => {
    for (const origin of [
      'http://127.0.0.1',
      'http://127.0.0.1:12320',
      'http://localhost:5173',
      'https://localhost',
      'http://[::1]:12320',
    ]) {
      expect(isLoopbackOrigin(origin)).toBe(true);
      expect(isAllowedCorsOrigin(origin)).toBe(true);
    }
  });

  test('확장 origin 판정', () => {
    expect(isExtensionOrigin('chrome-extension://abcdefghijklmnop')).toBe(true);
    expect(isExtensionOrigin('moz-extension://abcdefghijklmnop')).toBe(true);
    expect(isExtensionOrigin('http://chrome-extension.attacker.example')).toBe(false);
    expect(isExtensionOrigin('chrome-extension://')).toBe(false);
    expect(isExtensionOrigin('null')).toBe(false);
    expect(isExtensionOrigin(undefined)).toBe(false);
  });

  test('경로·쿼리가 붙은 값은 origin 으로 신뢰하지 않는다', () => {
    expect(parseOrigin('http://127.0.0.1:12320/admin')).toBeNull();
    expect(parseOrigin('http://user@127.0.0.1')).toBeNull();
    expect(parseOrigin('not-a-url')).toBeNull();
    expect(parseOrigin('')).toBeNull();
  });

  test('Chrome 이 넘겨준 caller origin 은 기록만 하고 인증 판정에는 쓰지 않는다', () => {
    const argv = [
      '/usr/bin/node',
      '/opt/bridge/dist/index.js',
      'chrome-extension://ourextensionidaaaaaaaaaaaaaaaaaa/',
      '--parent-window=0',
    ];
    const origins = collectExtensionOriginsFromArgv(argv);
    expect(origins).toEqual(['chrome-extension://ourextensionidaaaaaaaaaaaaaaaaaa']);

    setTrustedExtensionOrigins(origins);
    expect(getTrustedExtensionOrigins()).toEqual(origins);

    // 신뢰 목록이 있어도 CORS 판정 외에는 특권이 없다 — 토큰 면제 API 는 존재하지 않는다.
    expect(Object.keys(originModule)).not.toContain('isTrustedExtensionOrigin');
  });

  test('caller origin 이 없어도 확장 전체를 신뢰하는 fail-open 이 없다', () => {
    expect(collectExtensionOriginsFromArgv(['/usr/bin/node', 'index.js'])).toEqual([]);
    setTrustedExtensionOrigins([]);
    expect(getTrustedExtensionOrigins()).toEqual([]);
  });

  test('Host 헤더는 loopback 이름만 받는다', () => {
    expect(isAllowedHostHeader('127.0.0.1:12320', 12320)).toBe(true);
    expect(isAllowedHostHeader('localhost:12320', 12320)).toBe(true);
    expect(isAllowedHostHeader('[::1]:12320', 12320)).toBe(true);
    // 포트가 다르면 거절 (DNS rebinding 으로 다른 브리지를 노리는 요청)
    expect(isAllowedHostHeader('127.0.0.1:12321', 12320)).toBe(false);
    // 이름이 로컬이 아니면 거절 (DNS rebinding: attacker.example → 127.0.0.1)
    expect(isAllowedHostHeader('evil.example:12320', 12320)).toBe(false);
    expect(isAllowedHostHeader('127.0.0.1.attacker.example:12320', 12320)).toBe(false);
    expect(isAllowedHostHeader('', 12320)).toBe(false);
    expect(isAllowedHostHeader(undefined, 12320)).toBe(false);
    expect(isAllowedHostHeader('127.0.0.1:12320/x', 12320)).toBe(false);
  });

  test('listen 포트를 모르면(null) 포트는 검사하지 않고 이름만 본다', () => {
    expect(isAllowedHostHeader('127.0.0.1:59123', null)).toBe(true);
    expect(isAllowedHostHeader('localhost', null)).toBe(true);
    expect(isAllowedHostHeader('evil.example', null)).toBe(false);
  });

  test('포트 80 은 Host 헤더에서 생략될 수 있다', () => {
    expect(isAllowedHostHeader('127.0.0.1', 80)).toBe(true);
    expect(isAllowedHostHeader('127.0.0.1', 12320)).toBe(false);
    expect(parseHostHeader('[::1]:12320')).toEqual({ hostname: '[::1]', port: '12320' });
  });
});
