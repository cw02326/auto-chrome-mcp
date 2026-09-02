/**
 * auto-chrome-mcp fork — CDP attach 동시성 회귀 테스트.
 *
 * 재현하려는 실패: attach 는 getTargets → (await) → chrome.debugger.attach 로 await 를 두 번
 * 건넌다. 같은 탭에 attach 가 동시에 들어오면 둘 다 "아무도 안 붙어 있다" 를 보고 각자
 * chrome.debugger.attach 를 불러, 하나가 "Another debugger is already attached" 로 죽고
 * refCount 도 1 로 덮어써져 새어 나갔다 (병렬 레인 + 스크린샷/네트워크 캡처 조합에서 간헐 실패).
 *
 * 계약: 같은 탭의 attach 는 직렬화된다 — 실제 debugger.attach 는 한 번만 불리고,
 * 두 번째는 refcount 를 올리며, 양쪽이 다 detach 해야 실제 detach 가 일어난다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

let attachCalls = 0;
let detachCalls = 0;
let attached = false;

function installDebuggerMock(): void {
  attachCalls = 0;
  detachCalls = 0;
  attached = false;

  const debuggerMock = {
    getTargets: vi.fn(async () => {
      // 실제 chrome API 처럼 한 틱 뒤에 답한다 — 이 await 지점이 레이스의 원인이었다.
      await Promise.resolve();
      return attached
        ? [{ tabId: 7, attached: true, extensionId: 'test-extension-id' }]
        : [{ tabId: 7, attached: false }];
    }),
    attach: vi.fn(async () => {
      if (attached) throw new Error('Another debugger is already attached to the tab with id: 7');
      attached = true;
      attachCalls += 1;
    }),
    detach: vi.fn(async () => {
      attached = false;
      detachCalls += 1;
    }),
    sendCommand: vi.fn(async () => ({})),
    onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
  };

  (globalThis as any).chrome = {
    ...(globalThis as any).chrome,
    runtime: { ...((globalThis as any).chrome?.runtime ?? {}), id: 'test-extension-id' },
    debugger: debuggerMock,
  };
}

describe('CDPSessionManager 동시 attach', () => {
  beforeEach(() => {
    installDebuggerMock();
    vi.resetModules();
  });

  it('같은 탭에 동시에 붙어도 debugger.attach 는 한 번만 불린다 (핵심 회귀)', async () => {
    const { cdpSessionManager } = await import('@/utils/cdp-session-manager');

    await Promise.all([
      cdpSessionManager.attach(7, 'screenshot'),
      cdpSessionManager.attach(7, 'network-capture'),
    ]);

    expect(attachCalls).toBe(1);
    expect(attached).toBe(true);
  });

  it('둘 다 detach 해야 실제로 떨어진다 (refCount 가 새지 않는다)', async () => {
    const { cdpSessionManager } = await import('@/utils/cdp-session-manager');

    await Promise.all([
      cdpSessionManager.attach(7, 'screenshot'),
      cdpSessionManager.attach(7, 'network-capture'),
    ]);

    await cdpSessionManager.detach(7, 'screenshot');
    expect(detachCalls).toBe(0);
    expect(attached).toBe(true);

    await cdpSessionManager.detach(7, 'network-capture');
    expect(detachCalls).toBe(1);
    expect(attached).toBe(false);
  });

  it('앞선 attach 가 실패해도 다음 attach 가 막히지 않는다', async () => {
    const { cdpSessionManager } = await import('@/utils/cdp-session-manager');
    (globalThis as any).chrome.debugger.getTargets = vi.fn(async () => {
      await Promise.resolve();
      throw new Error('getTargets exploded');
    });

    await expect(cdpSessionManager.attach(7, 'first')).rejects.toThrow('getTargets exploded');

    (globalThis as any).chrome.debugger.getTargets = vi.fn(async () => {
      await Promise.resolve();
      return [{ tabId: 7, attached: false }];
    });
    await expect(cdpSessionManager.attach(7, 'second')).resolves.toBeUndefined();
    expect(attachCalls).toBe(1);
  });
});
