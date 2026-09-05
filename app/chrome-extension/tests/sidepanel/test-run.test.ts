/**
 * 시험 실행용 임시 탭 정리 (2026-09-05 Codex 교차 리뷰 6항).
 *
 * 시험 실행은 자기가 연 백그라운드 탭에서 돌고, **성공하든 실패하든** 그 탭을 닫아야 한다.
 * 반대로 탭을 열지 못했으면 아무 탭도 닫으면 안 된다 - 없는 id 로 remove 를 부르면 엉뚱한
 * 탭을 닫거나 오류가 난다.
 */

import { describe, expect, it, vi } from 'vitest';
import { runFlowInTemporaryTab } from '@/entrypoints/sidepanel/utils/test-run';

function deps(overrides: Partial<Parameters<typeof runFlowInTemporaryTab>[0]> = {}) {
  return {
    createTab: vi.fn(async () => ({ id: 7 })),
    waitForTab: vi.fn(async () => {}),
    runFlow: vi.fn(async () => ({
      success: true,
      summary: { total: 2, success: 2, failed: 0, tookMs: 100 },
    })),
    removeTab: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('runFlowInTemporaryTab', () => {
  it('성공하면 결과를 돌려주고 탭을 닫는다', async () => {
    const d = deps();
    const outcome = await runFlowInTemporaryTab(d, 'https://example.com/');

    expect(outcome.ok).toBe(true);
    expect(outcome.result?.summary?.success).toBe(2);
    expect(d.createTab).toHaveBeenCalledWith('https://example.com/');
    expect(d.runFlow).toHaveBeenCalledWith(7);
    expect(d.removeTab).toHaveBeenCalledWith(7);
  });

  it('실행이 실패로 끝나도 탭을 닫는다', async () => {
    const d = deps({
      runFlow: vi.fn(async () => ({
        success: false,
        summary: { total: 2, success: 1, failed: 1, tookMs: 80 },
      })),
    });
    const outcome = await runFlowInTemporaryTab(d, 'https://example.com/');

    expect(outcome.ok).toBe(false);
    expect(outcome.result?.summary?.failed).toBe(1);
    expect(d.removeTab).toHaveBeenCalledWith(7);
  });

  it('실행이 예외로 끝나도 탭을 닫고 사유를 남긴다', async () => {
    const d = deps({
      runFlow: vi.fn(async () => {
        throw new Error('flow not found');
      }),
    });
    const outcome = await runFlowInTemporaryTab(d, 'https://example.com/');

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('flow not found');
    expect(d.removeTab).toHaveBeenCalledWith(7);
  });

  it('탭을 열지 못하면 아무 탭도 닫지 않는다', async () => {
    const d = deps({ createTab: vi.fn(async () => ({})) });
    const outcome = await runFlowInTemporaryTab(d, 'https://example.com/');

    expect(outcome.ok).toBe(false);
    expect(outcome.tabId).toBeUndefined();
    expect(d.runFlow).not.toHaveBeenCalled();
    expect(d.removeTab).not.toHaveBeenCalled();
  });

  it('탭 생성이 예외로 끝나도 아무 탭도 닫지 않는다', async () => {
    const d = deps({
      createTab: vi.fn(async () => {
        throw new Error('cannot create tab');
      }),
    });
    const outcome = await runFlowInTemporaryTab(d, 'https://example.com/');

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('cannot create tab');
    expect(d.removeTab).not.toHaveBeenCalled();
  });

  it('탭 닫기가 실패해도 결과는 그대로 나온다', async () => {
    const d = deps({
      removeTab: vi.fn(async () => {
        throw new Error('tab already closed');
      }),
    });
    const outcome = await runFlowInTemporaryTab(d, 'https://example.com/');

    expect(outcome.ok).toBe(true);
  });
});
