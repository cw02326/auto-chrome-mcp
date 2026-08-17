/**
 * Content diff cache (scalemaker fork, T2) — "안 변했으면 다시 안 보낸다".
 *
 * read_page / get_web_content 같은 대용량 읽기 도구가 직전 호출과 동일한 내용을
 * 반환하게 될 때, 전체 본문 대신 { unchanged: true, hash } 한 줄을 반환할 수 있게
 * 탭·도구·인자 조합별 콘텐츠 해시를 기억한다. 모델은 이미 대화에 있는 이전 내용을
 * 그대로 쓰면 되므로 품질 손실 없이 토큰만 절약된다. diff:false 로 강제 재전송 가능.
 *
 * in-memory (SW 재시작 시 리셋 = 자연스러운 캐시 무효화). TTL 10분, 최대 50키.
 */

const TTL_MS = 10 * 60_000;
const MAX_KEYS = 50;

interface CacheEntry {
  hash: string;
  at: number;
}

const cache = new Map<string, CacheEntry>();

/** FNV-1a 32bit ×2 (앞/뒤 절반) — 암호학적 강도 불필요, 충돌 확률만 낮으면 됨 */
export function contentHash(content: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  const mid = content.length >> 1;
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    if (i < mid) {
      h1 ^= c;
      h1 = (h1 * 0x01000193) >>> 0;
    } else {
      h2 ^= c;
      h2 = (h2 * 0x01000193) >>> 0;
    }
  }
  return `${h1.toString(16)}-${h2.toString(16)}-${content.length}`;
}

function prune(now: number): void {
  for (const [k, v] of cache) {
    if (now - v.at > TTL_MS) cache.delete(k);
  }
  while (cache.size > MAX_KEYS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * content 의 해시를 계산해 직전 호출과 비교하고, 이번 해시를 기억한다.
 * key 예: `read_page:${tabId}:${filter}` — 결과에 영향 주는 인자를 모두 포함할 것.
 * 반환: unchanged=true 면 호출부는 본문 대신 unchanged 마커를 반환해도 안전.
 */
export function diffCheck(key: string, content: string): { unchanged: boolean; hash: string } {
  const now = Date.now();
  prune(now);
  const hash = contentHash(content);
  const prev = cache.get(key);
  cache.delete(key); // 재삽입으로 LRU 순서 갱신
  cache.set(key, { hash, at: now });
  return { unchanged: prev !== undefined && prev.hash === hash, hash };
}

/** 강제 무효화 (diff:false 재전송 시 호출부가 굳이 부를 필요는 없음 — diffCheck 가 갱신함) */
export function invalidate(keyPrefix: string): void {
  for (const k of cache.keys()) {
    if (k.startsWith(keyPrefix)) cache.delete(k);
  }
}
