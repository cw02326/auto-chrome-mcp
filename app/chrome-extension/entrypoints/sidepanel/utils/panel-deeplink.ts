/**
 * 팝업이 사이드패널을 열면서 넘기는 한 번짜리 지시 (2026-09-05 사이드패널 1단계 A).
 *
 * 팝업은 `chrome.sidePanel.setOptions({ path })` 로 패널을 연다. 그 path 는 **영구 설정**이라
 * 지시를 그대로 두면 패널을 다시 열 때마다, 새로고침할 때마다 녹화가 또 시작된다. 그래서
 * 지시는 읽는 즉시 소비한다.
 *   1. 현재 문서의 주소에서 지운다 (`history.replaceState`).
 *   2. 패널의 영구 path 도 지시 없는 주소로 되돌린다 (`chrome.sidePanel.setOptions`).
 *
 * 여기 있는 함수는 크롬 API 를 부르지 않는다. 파싱과 "지운 주소" 계산만 하고, 실제 호출은
 * 화면이 한다.
 */

/** 패널이 열릴 때 할 일. */
export type PanelRecordAction = 'start' | 'stop';

export interface PanelDeepLink {
  /** 열 탭 (`?tab=`). 없으면 undefined. */
  tab?: string;
  /** 녹화 지시 (`?record=`). 없거나 모르는 값이면 undefined. */
  record?: PanelRecordAction;
  /**
   * 녹화할 탭 id (`?tabId=`).
   *
   * 팝업이 눌린 순간의 활성 탭이다. 팝업이 닫히고 패널이 뜨는 사이에 사용자가 다른 탭으로
   * 옮겨 가도 처음 보고 있던 탭이 녹화되도록 id 를 실어 나른다.
   */
  recordTabId?: number;
  /** 지시를 뺀 검색 문자열 (`?tab=workflows` 또는 빈 문자열). */
  cleanedSearch: string;
}

/** 사이드패널 주소의 검색 문자열을 읽어 한 번짜리 지시를 꺼낸다. */
export function parsePanelDeepLink(search: string): PanelDeepLink {
  const params = new URLSearchParams(search || '');
  const tab = params.get('tab') || undefined;

  const rawRecord = params.get('record');
  const record: PanelRecordAction | undefined =
    rawRecord === 'start' || rawRecord === 'stop' ? rawRecord : undefined;

  const rawTabId = params.get('tabId');
  const parsedTabId = rawTabId === null ? NaN : Number(rawTabId);
  const recordTabId = Number.isInteger(parsedTabId) && parsedTabId >= 0 ? parsedTabId : undefined;

  // 한 번짜리 지시만 지운다. tab 은 어느 화면을 볼지이므로 남긴다.
  params.delete('record');
  params.delete('tabId');
  const rest = params.toString();

  return { tab, record, recordTabId, cleanedSearch: rest ? `?${rest}` : '' };
}

/** 사이드패널의 영구 path (지시 없는 주소). */
export function sidepanelPath(tab: string | undefined): string {
  return tab ? `sidepanel.html?tab=${encodeURIComponent(tab)}` : 'sidepanel.html';
}

/**
 * 녹화할 수 있는 주소인가.
 *
 * 콘텐츠 스크립트를 넣을 수 없는 주소(chrome://, 확장 페이지, 스토어, about:, devtools 등)
 * 에서는 녹화기가 붙지 못한다. 시작해 봐야 단계가 하나도 잡히지 않으므로 미리 막는다.
 */
export function isRecordableUrl(url: string | undefined): boolean {
  const value = String(url || '').trim();
  if (!value) return false;
  return /^(https?|file):/i.test(value);
}
