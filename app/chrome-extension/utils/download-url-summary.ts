/**
 * downloads_started 이벤트에 실을 URL 요약.
 *
 * 스크린샷 저장처럼 data: URL 로 시작한 다운로드는 url 필드에 base64 본문 전체가 들어와
 * 응답 한 건이 수십만 자가 된다(2026-09-05 실측 394,613자). 모델에게는 "어떤 종류의 데이터가
 * 얼마나 큰지" 만 필요하므로 scheme·mime·길이만 남긴다. 일반 URL 도 상한을 둔다.
 */
export const DOWNLOAD_URL_MAX_CHARS = 200;

export function summarizeDownloadUrl(url: unknown): string {
  if (typeof url !== 'string') return '';
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    const header = comma === -1 ? url.slice(0, 80) : url.slice(0, Math.min(comma, 80));
    return `${header},[${url.length - (comma === -1 ? 0 : comma + 1)} chars omitted]`;
  }
  if (url.startsWith('blob:')) return `blob:[${url.length} chars omitted]`;
  if (url.length <= DOWNLOAD_URL_MAX_CHARS) return url;
  return `${url.slice(0, DOWNLOAD_URL_MAX_CHARS)}…[${url.length - DOWNLOAD_URL_MAX_CHARS} more]`;
}
