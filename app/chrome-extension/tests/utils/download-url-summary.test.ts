import { describe, expect, it } from 'vitest';
import { summarizeDownloadUrl, DOWNLOAD_URL_MAX_CHARS } from '../../utils/download-url-summary';

describe('summarizeDownloadUrl (downloads_started 토큰 폭탄 방지)', () => {
  it('data: URL 은 헤더와 생략 길이만 남긴다', () => {
    const body = 'A'.repeat(300000);
    const out = summarizeDownloadUrl(`data:image/png;base64,${body}`);
    expect(out.startsWith('data:image/png;base64,[')).toBe(true);
    expect(out).toContain('300000 chars omitted');
    expect(out.length).toBeLessThan(120);
  });
  it('blob: URL 은 본문을 싣지 않는다', () => {
    expect(summarizeDownloadUrl('blob:https://a.test/12345')).toBe('blob:[25 chars omitted]');
  });
  it('짧은 일반 URL 은 그대로, 긴 것은 상한에서 자른다', () => {
    expect(summarizeDownloadUrl('https://a.test/file.zip')).toBe('https://a.test/file.zip');
    const long = 'https://a.test/' + 'x'.repeat(500);
    const out = summarizeDownloadUrl(long);
    expect(out.length).toBeLessThan(DOWNLOAD_URL_MAX_CHARS + 30);
    expect(out).toContain('more]');
  });
  it('문자열이 아니면 빈 문자열', () => {
    expect(summarizeDownloadUrl(undefined)).toBe('');
  });
});
