/**
 * auto-chrome-mcp fork — chrome_read_page 응답 계약 회귀 테스트 (task E3).
 *
 * 계약:
 *   - 정상 경로(트리 성공, sparse 아님): elements/count/fallbackUsed/fallbackSource/reason 는
 *     응답에 아예 없다(예전에는 []/0/false/null/null 로 항상 실렸다). stats 는 실제 값이 있으면 싣는다.
 *   - 폴백 경로(sparse 트리 → interactive-elements 폴백): 위 5개 필드가 실제 값으로 채워져 실린다.
 *
 * 소비처 확인(그렙 결과, 2026-09):
 *   - record-replay 의 여러 handler/node 는 chrome_read_page 를 `await handleCallTool(...)` 로만
 *     호출하고 반환값을 버린다(ref map 갱신이 목적) — elements/count/fallbackUsed 등 어떤 필드도
 *     읽지 않는다.
 *   - record-replay 안의 동명 `fallbackUsed` 는 완전히 다른 개념(선택자 해석 폴백)이며
 *     read_page 의 JSON 응답을 파싱하지 않는다.
 *   - batch-runner.ts 는 read_page 응답 필드를 전혀 참조하지 않는다.
 *   - 기존 테스트(batch-flow 등)의 `.reason`/`.count` 매치는 전부 배치 자체의 필드이지
 *     read_page 응답이 아니다.
 *   → 필드 부재를 안전하게 다룰 소비처가 없으므로 이 변경은 안전하다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type ReadPageModule = typeof import('@/entrypoints/background/tools/browser/read-page');

function baseTreeResp(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    pageContent: Array.from({ length: 12 }, (_, i) => `- button "item ${i}" ref_${i}`).join('\n'),
    refMap: Array.from({ length: 5 }, (_, i) => ({ ref: `ref_${i}` })),
    stats: { processed: 20, included: 12, durationMs: 5 },
    viewport: { width: 1280, height: 800, dpr: 1 },
    ...overrides,
  };
}

function sparseTreeResp(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    pageContent: 'a\nb',
    refMap: [],
    stats: { processed: 2, included: 0, durationMs: 1 },
    viewport: { width: 1280, height: 800, dpr: 1 },
    ...overrides,
  };
}

async function loadTool(sendMock: (tabId: number, message: any) => Promise<any>) {
  vi.resetModules();
  (globalThis as any).chrome.tabs.get = vi.fn(async (id: number) => ({
    id,
    url: `https://example.com/read-page-${Math.random()}`,
    title: 'Example',
    windowId: 1,
    active: true,
  }));

  const mod: ReadPageModule = await import('@/entrypoints/background/tools/browser/read-page');
  const proto = Object.getPrototypeOf(mod.readPageTool) as any;
  proto.injectContentScript = vi.fn(async () => undefined);
  proto.sendMessageToTab = vi.fn(sendMock);
  return mod.readPageTool;
}

function payloadOf(result: any) {
  return JSON.parse(result.content[0].text);
}

describe('chrome_read_page — 부가 필드는 실제로 쓰였을 때만 (task E3)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('정상 경로: elements/count/fallbackUsed/fallbackSource/reason 가 응답에 없다', async () => {
    const tool = await loadTool(async (_tabId, message) => {
      if (message.action === 'generateAccessibilityTree') return baseTreeResp();
      return { success: true, elements: [] };
    });

    const payload = payloadOf(await tool.execute({ tabId: 7, diff: false }));

    expect(payload.success).toBe(true);
    expect(payload).not.toHaveProperty('elements');
    expect(payload).not.toHaveProperty('count');
    expect(payload).not.toHaveProperty('fallbackUsed');
    expect(payload).not.toHaveProperty('fallbackSource');
    expect(payload).not.toHaveProperty('reason');
  });

  it('정상 경로: stats 는 실제 값이 있으면 그대로 싣는다', async () => {
    const tool = await loadTool(async (_tabId, message) => {
      if (message.action === 'generateAccessibilityTree') return baseTreeResp();
      return { success: true, elements: [] };
    });

    const payload = payloadOf(await tool.execute({ tabId: 7, diff: false }));

    expect(payload.stats).toEqual({ processed: 20, included: 12, durationMs: 5 });
  });

  it('폴백 경로(sparse 트리): fallbackUsed/fallbackSource/reason/elements/count 가 실제 값으로 채워진다', async () => {
    const tool = await loadTool(async (_tabId, message) => {
      if (message.action === 'generateAccessibilityTree') return sparseTreeResp();
      if (message.action === 'getInteractiveElements') {
        return {
          success: true,
          elements: [
            { type: 'button', text: 'ok', selector: '#ok' },
            { type: 'link', text: 'more', selector: '#more' },
          ],
        };
      }
      return { success: false };
    });

    const payload = payloadOf(await tool.execute({ tabId: 7, diff: false }));

    expect(payload.fallbackUsed).toBe(true);
    expect(payload.fallbackSource).toBe('get_interactive_elements');
    expect(payload.reason).toBe('sparse_tree');
    expect(Array.isArray(payload.elements)).toBe(true);
    expect(payload.elements.length).toBe(2);
    expect(payload.count).toBe(2);
  });

  it('폴백 경로: 트리 자체가 실패해도 fallback 이 성공하면 elements/count 가 실제 값으로 채워진다', async () => {
    const tool = await loadTool(async (_tabId, message) => {
      if (message.action === 'generateAccessibilityTree') {
        return { success: false, error: 'helper crashed' };
      }
      if (message.action === 'getInteractiveElements') {
        return {
          success: true,
          elements: [{ type: 'button', text: 'retry', selector: '#retry' }],
        };
      }
      return { success: false };
    });

    const payload = payloadOf(await tool.execute({ tabId: 7, diff: false }));

    expect(payload.fallbackUsed).toBe(true);
    expect(payload.reason).toBe('helper crashed');
    expect(payload.count).toBe(1);
    // 트리가 실패했으므로 stats 는 실제 값이 없다 — 응답에서 아예 빠져야 한다
    expect(payload).not.toHaveProperty('stats');
  });
});
