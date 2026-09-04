/**
 * auto-chrome-mcp fork — chrome_console(snapshot) 의 플러시 대기.
 *
 * 계약: 스냅샷은 **고정 2초**를 기다린다. "잠깐 조용해졌다"를 끝으로 보면 늦게 도착하는
 * 오류(예: 800ms 뒤 터지는 예외)를 통째로 놓친다. 콘솔은 그 늦은 한 줄을 보려고 쓰는 도구라
 * 빠른 반환보다 유실 방지가 우선이다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    attach: vi.fn(async () => undefined),
    sendCommand: vi.fn(async () => ({})),
    detach: vi.fn(async () => undefined),
  },
}));

import type { ToolResult } from '@/common/tool-handler';
import { consoleTool } from '@/entrypoints/background/tools/browser/console';

type CdpListener = (source: { tabId: number }, method: string, params?: any) => void;

function installChrome(): { emit: CdpListener } {
  let listener: CdpListener | null = null;

  (globalThis as any).chrome = {
    tabs: {
      get: vi.fn(async (id: number) => ({
        id,
        url: 'https://example.com/',
        title: 'example',
        status: 'complete',
        windowId: 1,
      })),
      query: vi.fn(async () => []),
    },
    debugger: {
      onEvent: {
        addListener: vi.fn((fn: CdpListener) => {
          listener = fn;
        }),
        removeListener: vi.fn(),
      },
    },
  };

  return {
    emit: (source, method, params) => {
      if (listener) listener(source, method, params);
    },
  };
}

function payloadOf(result: ToolResult): any {
  const first = result.content[0];
  return JSON.parse(first && first.type === 'text' ? first.text : '{}');
}

describe('chrome_console snapshot 플러시 대기', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('조용해졌다고 일찍 끝내지 않고 늦게 도착한 메시지까지 담는다 (항목 3)', async () => {
    const chromeMock = installChrome();

    let settled = false;
    const pending = consoleTool.execute({ tabId: 1 }).then((result) => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(100);
    chromeMock.emit({ tabId: 1 }, 'Log.entryAdded', {
      entry: { timestamp: 1, level: 'log', text: 'early' },
    });

    // 마지막 메시지 이후 300ms 가 지나도(=조용해져도) 아직 끝나면 안 된다.
    await vi.advanceTimersByTimeAsync(600);
    expect(settled).toBe(false);

    chromeMock.emit({ tabId: 1 }, 'Log.entryAdded', {
      entry: { timestamp: 2, level: 'error', text: 'late boom' },
    });

    await vi.advanceTimersByTimeAsync(1500);
    const payload = payloadOf(await pending);

    expect(settled).toBe(true);
    expect(payload.messageCount).toBe(2);
    expect(payload.messages.map((m: { text: string }) => m.text)).toEqual(['early', 'late boom']);
  });
});
