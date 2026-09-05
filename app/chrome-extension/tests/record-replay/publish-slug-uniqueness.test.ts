/**
 * publish-slug-uniqueness.test.ts
 *
 * 2026-09-05 Codex 교차 리뷰 3항: **자동 slug 가 겹칠 수 있었다.**
 *
 * slug 는 도구 표면에서 흐름을 부르는 이름이고, `resolvePublishedFlow` 는 id 로 못 찾으면
 * slug 로 찾는다. 이름이 같은 흐름 둘을 발행하면 `toSlug(flow.name)` 이 같은 값을 내므로
 * 두 발행 레코드가 같은 slug 를 갖고, slug 로 들어온 실행 요청이 **어느 흐름인지 알 수
 * 없다**. 여기서 고정하는 계약: 발행은 이미 쓰이는 slug 를 피해 숫자를 붙인다.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  publishFlow,
  resolvePublishedFlow,
} from '@/entrypoints/background/record-replay/flow-store';
import { IndexedDbStorage } from '@/entrypoints/background/record-replay/storage/indexeddb-manager';
import type { Flow } from '@/entrypoints/background/record-replay/types';

function makeFlow(id: string, name: string): Flow {
  return {
    id,
    name,
    version: 1,
    nodes: [{ id: 'n1', type: 'navigate', config: { url: 'https://example.com/' } }],
    edges: [],
    meta: { createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' },
  } as unknown as Flow;
}

/** `ensureMigratedFromLocal` 이 chrome.storage.local 을 실제로 읽으므로 값을 들고 있는 대역을 깐다. */
function installLocalStorage(): void {
  const store: Record<string, unknown> = {};
  (chrome.storage.local as any).get = vi.fn(async (keys: unknown) => {
    const list = Array.isArray(keys) ? keys : keys == null ? Object.keys(store) : [String(keys)];
    const out: Record<string, unknown> = {};
    for (const key of list) if (key in store) out[key] = store[key];
    return out;
  });
  (chrome.storage.local as any).set = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(store, items);
  });
}

async function clearPublished(): Promise<void> {
  for (const p of await IndexedDbStorage.published.list())
    await IndexedDbStorage.published.delete(p.id);
}

describe('발행 slug 는 유일하다 (Codex 교차 리뷰 3항)', () => {
  beforeEach(async () => {
    installLocalStorage();
    await clearPublished();
  });

  it('이름이 같은 두 흐름을 발행하면 뒤엣것에 숫자가 붙는다', async () => {
    const first = await publishFlow(makeFlow('flow_a', 'Naver Login'));
    const second = await publishFlow(makeFlow('flow_b', 'Naver Login'));

    expect(second.slug).not.toBe(first.slug);
    expect(second.slug).toBe(`${first.slug}-2`);
  });

  it('같은 흐름을 다시 발행하면 자기 slug 를 그대로 쓴다', async () => {
    const first = await publishFlow(makeFlow('flow_a', 'Naver Login'));
    const again = await publishFlow(makeFlow('flow_a', 'Naver Login'));

    expect(again.slug).toBe(first.slug);
  });

  it('직접 준 slug 도 남의 것과 겹치면 피해 간다', async () => {
    await publishFlow(makeFlow('flow_a', 'First flow'), 'login');
    const second = await publishFlow(makeFlow('flow_b', 'Second flow'), 'login');

    expect(second.slug).toBe('login-2');
  });

  it('한글 이름은 날짜 부스러기 대신 흐름 id 기반 slug 가 된다', async () => {
    // 재현: toSlug 는 ascii 가 아닌 글자를 구분자로 바꿔 "2026-09-05" 만 남겼다.
    const info = await publishFlow(makeFlow('flow_1757000123456', '짬뽕 : 네이버 검색 2026.09.05'));

    expect(info.slug).not.toBe('2026-09-05');
    expect(info.slug).toBe('flow-123456');
  });

  it('한글 이름이 서로 달라도 slug 는 흐름마다 다르다', async () => {
    const a = await publishFlow(makeFlow('flow_aaaaaa', '주문 넣기'));
    const b = await publishFlow(makeFlow('flow_bbbbbb', '주문 확인'));

    expect(a.slug).not.toBe(b.slug);
  });

  it('겹치지 않은 slug 로는 각 흐름이 정확히 해석된다', async () => {
    const first = await publishFlow(makeFlow('flow_a', 'Naver Login'));
    const second = await publishFlow(makeFlow('flow_b', 'Naver Login'));

    const byFirst = await resolvePublishedFlow(first.slug);
    const bySecond = await resolvePublishedFlow(second.slug);

    expect(byFirst.ok && byFirst.flow.id).toBe('flow_a');
    expect(bySecond.ok && bySecond.flow.id).toBe('flow_b');
  });
});
