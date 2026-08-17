/**
 * Login-redirect detector (scalemaker fork).
 *
 * 도구 실행 중 대상 탭이 로그인 페이지로 리다이렉트되면(세션 만료 등),
 * 게이트가 결과에 login_required_suspected 경고를 첨부해 모델이 헛수고하지
 * 않게 한다. URL 휴리스틱 — 오탐을 줄이기 위해 "실행 전에는 로그인 URL 이
 * 아니었는데 실행 후 로그인 URL 이 된" 전이만 게이트에서 경고한다.
 */

const LOGIN_HOSTS = [
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
  'nid.naver.com',
  'accounts.kakao.com',
  'kauth.kakao.com',
  'auth.openai.com',
  'github.com/login',
];

const LOGIN_PATH_RE =
  /(^|\/)(login|log-in|log_in|signin|sign-in|sign_in|sso|oauth2?\/(auth|authorize)|session\/new|authenticate|members?\/login)(\/|\?|$)/i;

export function looksLikeLoginUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const hostAndPath = `${u.hostname}${u.pathname}`;
    if (LOGIN_HOSTS.some((h) => hostAndPath.startsWith(h) || u.hostname === h)) return true;
    return LOGIN_PATH_RE.test(u.pathname) || LOGIN_PATH_RE.test(u.search);
  } catch {
    return false;
  }
}
