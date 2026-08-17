/**
 * Download tracker (scalemaker fork).
 *
 * 도구 호출(클릭 등)이 파일 다운로드를 유발해도 결과에 아무 표시가 없어
 * 모델이 다운로드 사실·저장 경로를 모르는 문제 해결. 게이트가 도구 실행
 * 전후를 비교해 그 사이 시작된 다운로드를 결과에 첨부한다.
 *
 * chrome.downloads 이벤트에는 tabId 가 없어 완전한 귀속은 불가 —
 * "도구 실행 중 시작된 다운로드" 시간 창으로 귀속한다 (실용적으로 충분).
 */

export interface DownloadRecord {
  id: number;
  url: string;
  filename: string;
  state: string; // in_progress | complete | interrupted
  totalBytes: number;
  startedAt: number;
}

const TTL_MS = 120_000;
const MAX_RECORDS = 20;
const records: DownloadRecord[] = [];

function prune(now: number): void {
  while (records.length > 0 && now - records[0].startedAt > TTL_MS) records.shift();
  while (records.length > MAX_RECORDS) records.shift();
}

try {
  chrome.downloads?.onCreated?.addListener((item) => {
    prune(Date.now());
    records.push({
      id: item.id,
      url: item.finalUrl || item.url || '',
      filename: item.filename || '',
      state: item.state || 'in_progress',
      totalBytes: item.totalBytes ?? -1,
      startedAt: Date.now(),
    });
  });

  chrome.downloads?.onChanged?.addListener((delta) => {
    const rec = records.find((r) => r.id === delta.id);
    if (!rec) return;
    if (delta.state?.current) rec.state = delta.state.current;
    if (delta.filename?.current) rec.filename = delta.filename.current;
  });
} catch {
  // chrome API 불가 환경 (테스트 등) — 추적 없이 동작
}

/** since 이후 시작된 다운로드 스냅샷 (게이트의 결과 첨부용) */
export function getDownloadsSince(since: number): DownloadRecord[] {
  prune(Date.now());
  return records.filter((r) => r.startedAt >= since).map((r) => ({ ...r }));
}
