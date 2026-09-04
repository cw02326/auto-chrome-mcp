/**
 * 브리지 HTTP 인증 토큰 (auto-chrome-mcp fork).
 *
 * 네이티브 호스트(브리지)는 loopback HTTP 서버를 띄운다. 같은 PC 안의 다른 프로그램이
 * 그 포트로 /admin/kill-self 나 /mcp 를 부를 수 있으므로, 브리지가 기동 시 만든 토큰을
 * 네이티브 메시징(SERVER_STARTED)으로만 확장에 알려 주고 HTTP 요청에서 그것을 확인한다.
 * 네이티브 메시징 채널은 크롬이 manifest 로 상대를 고정하므로 웹 페이지가 끼어들 수 없다.
 *
 * 토큰은 chrome.storage.session 에만 둔다 — 브라우저 세션이 끝나면 사라지고, 디스크에
 * 남지 않는다. 옛 브리지는 토큰을 보내지 않으므로 **없으면 헤더 없이** 보낸다(호환).
 * 토큰 불일치(401/403)는 "브리지와 확장 버전이 다르다" 는 뜻이라 사용자에게 그렇게 알린다.
 */

const AUTH_TOKEN_SESSION_KEY = 'mcpBridgeAuthToken';

/** 401/403 을 받았을 때 사용자에게 보여줄 안내 (한국어, 대시류 금지). */
export const BRIDGE_AUTH_MISMATCH_MESSAGE =
  '브리지와 확장 버전이 다릅니다. 둘 다 최신으로 올리고 크롬을 재시작하세요.';

/** 브리지가 인증을 거절한 응답인가 (토큰 없음·불일치). */
export function isBridgeAuthFailure(status: number): boolean {
  return status === 401 || status === 403;
}

/**
 * 인증 실패 상태 코드면 안내 문구를, 아니면 null 을 준다.
 * 결과 메시지를 만드는 쪽에서 붙여 쓰기 좋게 문자열로 돌려준다.
 */
export function bridgeAuthHint(status: number): string | null {
  return isBridgeAuthFailure(status) ? BRIDGE_AUTH_MISMATCH_MESSAGE : null;
}

/**
 * 브리지가 보내 준 토큰을 저장한다. undefined·빈 문자열이면 기록을 지운다
 * (옛 브리지로 되돌아간 경우 낡은 토큰을 계속 보내지 않게).
 */
export async function setBridgeAuthToken(token: unknown): Promise<void> {
  const value = typeof token === 'string' ? token.trim() : '';
  try {
    if (value.length === 0) {
      await chrome.storage.session.remove(AUTH_TOKEN_SESSION_KEY);
    } else {
      await chrome.storage.session.set({ [AUTH_TOKEN_SESSION_KEY]: value });
    }
  } catch {
    // storage.session 을 못 쓰는 컨텍스트 — 토큰 없이 동작(옛 브리지 경로와 같다).
  }
}

/** 저장된 토큰 (없으면 null). */
export async function getBridgeAuthToken(): Promise<string | null> {
  try {
    const result = await chrome.storage.session.get([AUTH_TOKEN_SESSION_KEY]);
    const token = result?.[AUTH_TOKEN_SESSION_KEY];
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * 브리지 HTTP 호출에 붙일 헤더. 토큰이 없으면 빈 객체 — 옛 브리지는 인증을 요구하지
 * 않으므로 헤더 없이 그대로 통한다.
 */
export async function getBridgeAuthHeaders(): Promise<Record<string, string>> {
  const token = await getBridgeAuthToken();
  return token === null ? {} : { Authorization: `Bearer ${token}` };
}

/** 기존 헤더에 인증 헤더를 합친다 (Content-Type 등을 지우지 않는다). */
export async function withBridgeAuth(
  headers: Record<string, string> = {},
): Promise<Record<string, string>> {
  return { ...headers, ...(await getBridgeAuthHeaders()) };
}
