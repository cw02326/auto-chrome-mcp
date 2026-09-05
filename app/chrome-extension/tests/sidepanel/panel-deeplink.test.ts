/**
 * 팝업이 사이드패널에 넘기는 한 번짜리 지시 (2026-09-05 Codex 교차 리뷰 2항).
 *
 * `chrome.sidePanel.setOptions({ path })` 는 **영구 설정**이다. 지시가 그 path 에 남으면
 * 패널을 다시 열 때마다, 새로고침할 때마다 녹화가 또 시작된다. 그래서 지시는 읽는 즉시
 * 주소에서 지워야 하고, 되돌릴 path 도 지시 없는 주소여야 한다.
 */

import { describe, expect, it } from 'vitest';
import {
  isRecordableUrl,
  parsePanelDeepLink,
  sidepanelPath,
} from '@/entrypoints/sidepanel/utils/panel-deeplink';

describe('parsePanelDeepLink', () => {
  it('녹화 지시와 탭 id 를 읽고, 지시를 뺀 주소를 함께 돌려준다', () => {
    const link = parsePanelDeepLink('?tab=workflows&record=start&tabId=42');

    expect(link.tab).toBe('workflows');
    expect(link.record).toBe('start');
    expect(link.recordTabId).toBe(42);
    // 남는 주소에는 지시가 없다 - 새로고침해도 다시 실행되지 않는다.
    expect(link.cleanedSearch).toBe('?tab=workflows');
    expect(parsePanelDeepLink(link.cleanedSearch).record).toBeUndefined();
    expect(parsePanelDeepLink(link.cleanedSearch).recordTabId).toBeUndefined();
  });

  it('되돌릴 영구 path 에도 지시가 없다', () => {
    const link = parsePanelDeepLink('?tab=workflows&record=stop');
    expect(sidepanelPath(link.tab)).toBe('sidepanel.html?tab=workflows');
    expect(sidepanelPath(undefined)).toBe('sidepanel.html');
  });

  it('모르는 지시는 무시한다', () => {
    expect(parsePanelDeepLink('?tab=workflows&record=explode').record).toBeUndefined();
    expect(parsePanelDeepLink('?record=start&tabId=abc').recordTabId).toBeUndefined();
    expect(parsePanelDeepLink('?record=start&tabId=-3').recordTabId).toBeUndefined();
  });

  it('지시가 없으면 주소를 그대로 둔다', () => {
    const link = parsePanelDeepLink('?tab=element-markers');
    expect(link.record).toBeUndefined();
    expect(link.cleanedSearch).toBe('?tab=element-markers');
  });
});

describe('isRecordableUrl', () => {
  it('콘텐츠 스크립트를 넣을 수 있는 주소만 녹화한다', () => {
    expect(isRecordableUrl('https://example.com/')).toBe(true);
    expect(isRecordableUrl('http://localhost:3000/')).toBe(true);
    expect(isRecordableUrl('file:///C:/tmp/a.html')).toBe(true);
  });

  it('제한된 주소는 미리 막는다', () => {
    expect(isRecordableUrl('chrome://extensions')).toBe(false);
    expect(isRecordableUrl('chrome-extension://abc/options.html')).toBe(false);
    expect(isRecordableUrl('about:blank')).toBe(false);
    expect(isRecordableUrl('devtools://devtools/bundled/x.html')).toBe(false);
    expect(isRecordableUrl(undefined)).toBe(false);
    expect(isRecordableUrl('')).toBe(false);
  });

  it('알려진 한계: 웹스토어처럼 https 인데도 스크립트를 막는 곳은 여기서 걸러지지 않는다', () => {
    // 이런 곳은 시작은 되고 단계가 잡히지 않는다. 프로토콜만으로는 구분할 수 없다.
    expect(isRecordableUrl('https://chromewebstore.google.com/')).toBe(true);
  });
});
