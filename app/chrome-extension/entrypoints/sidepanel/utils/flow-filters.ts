/**
 * 흐름 카드 필터 (2026-09-05 사이드패널 2단계 E).
 *
 * 검색어와 함께 상위 화면 한 곳에서만 거른다. 순수 함수라 화면 없이 시험할 수 있다.
 * 필터 바는 접이식이 아니라 늘 보이는 한 줄이므로, 지금 무엇이 걸려 있는지도 함께 계산한다.
 */

/** 필터가 보는 흐름의 최소 모양. */
export interface FilterableFlow {
  id: string;
  name?: string;
  published?: { slug: string; version: number } | null;
  meta?: { domain?: string; tags?: string[] };
}

export interface FlowFilterState {
  /** 사이트(도메인). 빈 문자열이면 전체다. */
  site: string;
  /** 발행된 흐름만. */
  published: boolean;
  /** 예약이 걸린 흐름만. */
  scheduled: boolean;
  /** 마지막 실행이 실패한 흐름만. */
  recentFailed: boolean;
}

export const EMPTY_FLOW_FILTER: FlowFilterState = {
  site: '',
  published: false,
  scheduled: false,
  recentFailed: false,
};

export interface FlowFilterContext {
  /** 예약이 걸린 흐름 id. */
  scheduledFlowIds?: Iterable<string>;
  /** 마지막 실행이 실패한 흐름 id. */
  failedFlowIds?: Iterable<string>;
}

/** 필터 바의 사이트 선택지. 도메인이 없는 흐름은 빠진다. */
export function collectSites(flows: readonly FilterableFlow[]): string[] {
  const set = new Set<string>();
  for (const flow of flows) {
    const domain = String(flow?.meta?.domain || '').trim();
    if (domain) set.add(domain);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/** 하나라도 걸려 있는가. "필터 지우기" 버튼을 보일지 정한다. */
export function isFilterActive(state: FlowFilterState): boolean {
  return !!state.site || state.published || state.scheduled || state.recentFailed;
}

/** 조건을 모두 만족하는 흐름만 남긴다. */
export function filterFlows<T extends FilterableFlow>(
  flows: readonly T[],
  state: FlowFilterState,
  context: FlowFilterContext = {},
): T[] {
  const scheduled = new Set(context.scheduledFlowIds || []);
  const failed = new Set(context.failedFlowIds || []);
  const site = String(state.site || '').trim();

  return flows.filter((flow) => {
    if (site && String(flow?.meta?.domain || '') !== site) return false;
    if (state.published && !flow.published) return false;
    if (state.scheduled && !scheduled.has(flow.id)) return false;
    if (state.recentFailed && !failed.has(flow.id)) return false;
    return true;
  });
}
