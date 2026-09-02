/**
 * auto-chrome-mcp fork — 죽은 대상 탭 가드 회귀 테스트.
 *
 * 실측으로 잡은 실패: 작업 탭이 닫힌 뒤 같은 tabId 로 chrome_screenshot 을 부르니,
 * 에러가 나는 대신 **사용자가 보고 있던 유튜브 탭**이 찍혀 돌아왔다. 원인은 도구 25개가
 * 공유하는 `tryGetTab(args.tabId) || getActiveTab...` 패턴 — 명시한 탭이 없으면 조용히
 * 활성 탭으로 흘러간다. navigate(refresh:true) 였다면 사용자 페이지를 새로고침했을 것이다.
 *
 * 계약: 명시된 tabId 가 이미 없으면 도구를 돌리기 전에 끊고, 왜 없어졌는지와 복구 방법을 준다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { describeMissingTab, rejectIfTargetTabGone } from '@/utils/target-tab-guard';

function setLiveTabs(ids: number[]): void {
  (globalThis as any).chrome.tabs.get = vi.fn(async (id: number) => {
    if (!ids.includes(id)) throw new Error(`No tab with id: ${id}`);
    return { id, url: 'https://example.com/', windowId: 1 };
  });
}

function textOf(result: any): string {
  return (result?.content ?? []).map((c: any) => c.text ?? '').join(' ');
}

describe('rejectIfTargetTabGone', () => {
  beforeEach(() => {
    setLiveTabs([7]);
  });

  it('살아 있는 탭은 통과시킨다', async () => {
    await expect(rejectIfTargetTabGone('chrome_screenshot', { tabId: 7 })).resolves.toBeNull();
  });

  it('tabId 를 안 준 호출은 건드리지 않는다', async () => {
    await expect(rejectIfTargetTabGone('chrome_screenshot', {})).resolves.toBeNull();
    await expect(rejectIfTargetTabGone('chrome_screenshot', undefined)).resolves.toBeNull();
  });

  it('죽은 탭이면 도구를 돌리지 않고 끊는다 (핵심 회귀)', async () => {
    const result = await rejectIfTargetTabGone('chrome_screenshot', { tabId: 999 });
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(textOf(result)).toContain('Tab not found: 999');
    expect(textOf(result)).toContain('chrome_screenshot');
  });

  it('끊을 때 복구 방법을 함께 준다', async () => {
    const result = await rejectIfTargetTabGone('chrome_navigate', { tabId: 999 });
    const text = textOf(result);
    expect(text).toContain('target_tab_missing');
    expect(text).toContain('Do not retry with the same tabId');
    expect(text).toContain('chrome_set_work_tab');
  });
});

describe('describeMissingTab', () => {
  it('탭 관련 실패에만 붙는다', () => {
    const notTabFailure = { content: [{ type: 'text', text: 'element not found' }] };
    expect(describeMissingTab(notTabFailure, 7)).toBeNull();

    const tabFailure = { content: [{ type: 'text', text: 'Tab not found: 7' }] };
    expect(describeMissingTab(tabFailure, 7)).not.toBeNull();
  });

  it('tabId 가 없으면 붙이지 않는다', () => {
    const tabFailure = { content: [{ type: 'text', text: 'Tab not found' }] };
    expect(describeMissingTab(tabFailure, undefined)).toBeNull();
  });
});
