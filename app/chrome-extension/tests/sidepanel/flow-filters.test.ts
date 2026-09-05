/**
 * 흐름 카드 필터 (2026-09-05 사이드패널 2단계 E).
 *
 * 확인하려는 것.
 *   1. 사이트·발행됨·예약 있음·최근 실패가 각각 걸리고, 함께 걸면 모두 만족해야 남는다.
 *   2. 사이트 선택지는 중복 없이 정렬돼 나온다.
 *   3. 아무것도 안 걸렸을 때 "필터 지우기" 를 보이지 않는다.
 */

import { describe, expect, it } from 'vitest';
import {
  EMPTY_FLOW_FILTER,
  collectSites,
  filterFlows,
  isFilterActive,
  type FilterableFlow,
} from '@/entrypoints/sidepanel/utils/flow-filters';

const flows: FilterableFlow[] = [
  {
    id: 'a',
    name: '주문 확인',
    published: { slug: 'a', version: 1 },
    meta: { domain: 'shop.com' },
  },
  { id: 'b', name: '메일 확인', meta: { domain: 'mail.com' } },
  {
    id: 'c',
    name: '재고 확인',
    published: { slug: 'c', version: 2 },
    meta: { domain: 'shop.com' },
  },
  { id: 'd', name: '이름만' },
];

describe('flow-filters', () => {
  it('아무것도 안 걸면 그대로 돌려준다', () => {
    expect(filterFlows(flows, EMPTY_FLOW_FILTER).map((f) => f.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(isFilterActive(EMPTY_FLOW_FILTER)).toBe(false);
  });

  it('사이트로 거른다', () => {
    const result = filterFlows(flows, { ...EMPTY_FLOW_FILTER, site: 'shop.com' });
    expect(result.map((f) => f.id)).toEqual(['a', 'c']);
  });

  it('발행된 것만 남긴다', () => {
    const result = filterFlows(flows, { ...EMPTY_FLOW_FILTER, published: true });
    expect(result.map((f) => f.id)).toEqual(['a', 'c']);
  });

  it('예약이 걸린 흐름만 남긴다', () => {
    const result = filterFlows(
      flows,
      { ...EMPTY_FLOW_FILTER, scheduled: true },
      { scheduledFlowIds: ['b', 'c'] },
    );
    expect(result.map((f) => f.id)).toEqual(['b', 'c']);
  });

  it('최근 실패만 남긴다', () => {
    const result = filterFlows(
      flows,
      { ...EMPTY_FLOW_FILTER, recentFailed: true },
      { failedFlowIds: ['d'] },
    );
    expect(result.map((f) => f.id)).toEqual(['d']);
  });

  it('여러 조건은 모두 만족해야 남는다', () => {
    const result = filterFlows(
      flows,
      { site: 'shop.com', published: true, scheduled: true, recentFailed: false },
      { scheduledFlowIds: ['c'] },
    );
    expect(result.map((f) => f.id)).toEqual(['c']);
  });

  it('사이트 선택지는 중복 없이 정렬한다', () => {
    expect(collectSites(flows)).toEqual(['mail.com', 'shop.com']);
  });

  it('하나라도 걸리면 활성으로 본다', () => {
    expect(isFilterActive({ ...EMPTY_FLOW_FILTER, recentFailed: true })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FLOW_FILTER, site: 'shop.com' })).toBe(true);
  });
});
