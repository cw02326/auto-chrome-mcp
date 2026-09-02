/**
 * auto-chrome-mcp fork — content script 응답 대기 상한 회귀 테스트.
 *
 * 재현하려는 실패: chrome.tabs.sendMessage 는 상대가 sendResponse 를 영영 안 부르면
 * **영원히 pending** 이다 (헬퍼가 비동기 예외로 죽거나 페이지가 멎었을 때). 그러면 도구
 * 호출이 끝나지 않고, 탭 단위 직렬화 때문에 같은 탭의 이후 호출이 전부 뒤에 막혔다.
 *
 * 계약: 상한을 넘기면 "무엇이 응답을 안 했는지 + 무엇을 하면 되는지" 가 적힌 에러로 끝난다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import type { ToolResult } from '@/common/tool-handler';

class Probe extends BaseBrowserToolExecutor {
  name = 'chrome_probe';
  async execute(): Promise<ToolResult> {
    return { content: [], isError: false };
  }
  send(tabId: number, message: any, frameId?: number, timeoutMs?: number) {
    return this.sendMessageToTab(tabId, message, frameId, timeoutMs);
  }
}

describe('sendMessageToTab 응답 대기 상한', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('응답이 영영 안 오면 상한에서 원인이 적힌 에러로 끝난다 (핵심 회귀)', async () => {
    (globalThis as any).chrome.tabs.sendMessage = vi.fn(() => new Promise(() => {}));

    const probe = new Probe();
    const pending = probe.send(7, { action: 'clickElement' }, undefined, 5_000);
    const assertion = expect(pending).rejects.toThrow(
      /did not respond to 'clickElement' within 5s/,
    );
    await vi.advanceTimersByTimeAsync(5_001);
    await assertion;
  });

  it('에러가 복구 방법을 알려 준다', async () => {
    (globalThis as any).chrome.tabs.sendMessage = vi.fn(() => new Promise(() => {}));
    const probe = new Probe();
    const pending = probe.send(7, { action: 'x' }, undefined, 1_000).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await pending).toContain('chrome_navigate refresh:true');
  });

  it('상한 안에 응답이 오면 그대로 통과시킨다', async () => {
    (globalThis as any).chrome.tabs.sendMessage = vi.fn(async () => ({ success: true, v: 1 }));
    const probe = new Probe();
    await expect(probe.send(7, { action: 'x' })).resolves.toEqual({ success: true, v: 1 });
  });

  it('content script 가 error 를 담아 보내면 기존처럼 throw 한다', async () => {
    (globalThis as any).chrome.tabs.sendMessage = vi.fn(async () => ({
      error: 'element not found',
    }));
    const probe = new Probe();
    await expect(probe.send(7, { action: 'x' })).rejects.toThrow('element not found');
  });
});
