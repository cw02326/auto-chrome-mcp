/**
 * Origin / Host 판정 — CORS 화이트리스트와 인증 게이트가 함께 쓴다.
 *
 * 기존 구현은 `origin.startsWith('http://127.0.0.1')` 였다. 그래서
 * `http://127.0.0.1.attacker.example` 같은 원격 origin 이 그대로 통과했다
 * (DNS 를 127.0.0.1 로 돌려놓으면 브라우저 안에서 로컬 브리지에 붙는다).
 * 이제 반드시 URL 로 파싱해 protocol + hostname + port 를 정확히 본다.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const EXTENSION_PROTOCOLS = new Set(['chrome-extension:', 'moz-extension:']);

export interface NormalizedOrigin {
  protocol: string;
  hostname: string;
  port: string;
  /** `<protocol>//<hostname>` (포트 제외) — 확장 origin 비교용 정규형. */
  base: string;
}

export const parseOrigin = (origin: unknown): NormalizedOrigin | null => {
  if (typeof origin !== 'string' || origin.length === 0) return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  // origin 헤더는 scheme://host[:port] 형태여야 한다. 경로·쿼리가 붙어 있으면 신뢰하지 않는다.
  // (chrome-extension: 처럼 non-special scheme 은 pathname 이 빈 문자열로 나온다)
  if (
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== ''
  ) {
    return null;
  }
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    base: `${url.protocol}//${url.hostname}`,
  };
};

/** chrome-extension:// 또는 moz-extension:// origin 인가. */
export const isExtensionOrigin = (origin: unknown): boolean => {
  const parsed = parseOrigin(origin);
  return Boolean(parsed && EXTENSION_PROTOCOLS.has(parsed.protocol) && parsed.hostname.length > 0);
};

/** http(s)://127.0.0.1[:port] / localhost / [::1] 인가 (포트는 자유). */
export const isLoopbackOrigin = (origin: unknown): boolean => {
  const parsed = parseOrigin(origin);
  if (!parsed) return false;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return LOOPBACK_HOSTS.has(parsed.hostname);
};

/**
 * Origin 허용 목록 — CORS 응답 헤더와 인증 게이트가 같은 목록을 쓴다.
 * (확장 origin + loopback. 그 밖은 전부 거절)
 */
export const isAllowedCorsOrigin = (origin: unknown): boolean =>
  isExtensionOrigin(origin) || isLoopbackOrigin(origin);

// ============================================================
// Host 헤더
// ============================================================
// Origin 만 봐서는 DNS rebinding 을 막지 못한다. 공격자가 attacker.example 을
// 127.0.0.1 로 돌려놓고 그 페이지에서 `fetch('http://attacker.example:12320/...')` 을
// 던지면 브라우저는 same-origin 으로 판단해 Origin 헤더를 아예 붙이지 않는다.
// 그래서 Host 가 loopback 이름인지도 반드시 본다 (공개 경로 포함).

export interface NormalizedHost {
  hostname: string;
  port: string;
}

export const parseHostHeader = (host: unknown): NormalizedHost | null => {
  if (typeof host !== 'string') return null;
  const raw = host.trim();
  if (raw.length === 0) return null;
  let url: URL;
  try {
    url = new URL(`http://${raw}`);
  } catch {
    return null;
  }
  // Host 는 host[:port] 뿐이어야 한다. 경로·자격증명이 섞이면 신뢰하지 않는다.
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '') {
    return null;
  }
  return { hostname: url.hostname, port: url.port };
};

/**
 * 요청 Host 가 이 브리지를 가리키는가.
 *
 * @param expectedPort listen 중인 포트. null/undefined 면 포트는 검사하지 않는다
 *                     (아직 listen 하기 전이거나 테스트가 임의 포트를 쓰는 경우).
 */
export const isAllowedHostHeader = (host: unknown, expectedPort?: number | null): boolean => {
  const parsed = parseHostHeader(host);
  if (!parsed) return false;
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return false;
  if (expectedPort === null || expectedPort === undefined) return true;
  // Host 헤더는 기본 포트(80)를 생략할 수 있다.
  const effectivePort = parsed.port === '' ? '80' : parsed.port;
  return effectivePort === String(expectedPort);
};

// ============================================================
// 호출자 확장 origin (Chrome 이 native host 에 넘겨준 값) — 정보용
// ============================================================
// Chrome 은 native messaging host 를 띄울 때 첫 인자로 호출자 origin
// (`chrome-extension://<id>/`) 을 준다. 예전에는 이 값(또는 값이 없으면 확장 origin 전체)을
// "토큰 없이 통과" 신원으로 인정했다. 그 예외는 제거됐다:
//   - Origin 헤더는 브라우저가 붙일 때만 신뢰할 수 있고, 로컬의 다른 프로세스는 아무 값이나
//     붙일 수 있다 (curl 한 줄이면 확장을 흉내낸다).
//   - 목록이 비면 모든 확장을 신뢰하는 fail-open 이었고, 래퍼 스크립트가 argv 를 넘기지
//     않아 실제로 목록은 늘 비어 있었다.
// 이제 이 값은 로그와 doctor 표시용으로만 남는다. 인증은 토큰 하나로만 판정한다.

let trustedExtensionOrigins: string[] = [];

export const collectExtensionOriginsFromArgv = (argv: readonly string[]): string[] => {
  const found: string[] = [];
  for (const arg of argv) {
    const parsed = parseOrigin(String(arg).replace(/\/+$/, ''));
    if (parsed && EXTENSION_PROTOCOLS.has(parsed.protocol) && parsed.hostname.length > 0) {
      if (!found.includes(parsed.base)) found.push(parsed.base);
    }
  }
  return found;
};

/** 호출자 확장 origin 기록 (정보용 — 인증 판정에는 쓰지 않는다). */
export const setTrustedExtensionOrigins = (origins: readonly string[]): void => {
  trustedExtensionOrigins = [...origins];
};

export const getTrustedExtensionOrigins = (): string[] => [...trustedExtensionOrigins];
