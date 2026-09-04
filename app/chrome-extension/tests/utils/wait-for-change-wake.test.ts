/**
 * auto-chrome-mcp fork — chrome_wait_for 의 "폴링 간격을 다 채우지 않고 DOM 변화로 깨어나기".
 *
 * 예전에는 조건이 이미 충족됐어도 다음 폴링(기본 250ms)까지 무조건 기다렸다.
 * 이제는 페이지에 MutationObserver 를 걸어 두고 변화가 생기면 즉시 다시 확인한다.
 * 변화가 없으면 예전과 같은 간격(폴링)이 폴백으로 남는다.
 *
 * 두 가지 계약이 더 있다.
 *  - 확장 쪽 타이머가 유일한 기준이다. 페이지 타이머가 스로틀돼 in-page 대기가 늦게 돌아와도
 *    전체 소요는 timeoutMs 를 넘지 않는다.
 *  - in-page 관찰자는 문서당 하나다. 새로 걸기 전에 이전 것을 반드시 끊는다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolResult } from '@/common/tool-handler';
import { waitForDomChange, waitForTool } from '@/entrypoints/background/tools/browser/wait-for';

interface Probe {
  readyState: string;
  selectorFound?: boolean;
  selectorVisible?: boolean;
}

function installChrome(options: {
  probes: Probe[];
  /** DOM 변화 대기(in-page)가 언제 돌아오는지 */
  wake: 'immediate' | 'sliceTimer' | 'throttled';
}): { wakeCalls: () => number; probeCalls: () => number; wakeArgs: () => unknown[][] } {
  let probeIndex = 0;
  let wakeCalls = 0;
  const wakeArgs: unknown[][] = [];

  (globalThis as any).chrome = {
    tabs: {
      get: vi.fn(async (id: number) => ({ id, url: 'https://example.com/', status: 'complete' })),
      query: vi.fn(async () => []),
    },
    scripting: {
      executeScript: vi.fn(async (injection: { args?: unknown[] }) => {
        const args = injection.args ?? [];
        // waitForDomChange(sliceMs, minMs, key) 는 첫 인자가 숫자다 — probePageState 와 구분.
        if (typeof args[0] === 'number') {
          wakeCalls++;
          wakeArgs.push(args);
          if (options.wake === 'immediate') return [{ result: 'change' }];
          const sliceMs = args[0] as number;
          // throttled: 백그라운드 탭에서 페이지 타이머가 늦게 도는 상황
          const delay = options.wake === 'throttled' ? sliceMs * 20 : sliceMs;
          return await new Promise((resolve) =>
            setTimeout(() => resolve([{ result: 'timeout' }]), delay),
          );
        }
        const probe = options.probes[Math.min(probeIndex, options.probes.length - 1)];
        probeIndex++;
        return [{ result: probe }];
      }),
    },
  };

  return {
    wakeCalls: () => wakeCalls,
    probeCalls: () => probeIndex,
    wakeArgs: () => wakeArgs,
  };
}

function payloadOf(result: ToolResult): any {
  const first = result.content[0];
  return JSON.parse(first && first.type === 'text' ? first.text : '{}');
}

const NOT_READY: Probe = { readyState: 'loading', selectorFound: false, selectorVisible: false };
const READY: Probe = { readyState: 'complete', selectorFound: true, selectorVisible: true };

describe('chrome_wait_for — DOM 변화로 깨어나기', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('변화가 생기면 폴링 간격(250ms)을 다 채우지 않고 즉시 조건을 다시 확인한다 (핵심)', async () => {
    const chromeMock = installChrome({ probes: [NOT_READY, READY], wake: 'immediate' });

    let settled = false;
    const pending = waitForTool.execute({ tabId: 1, selector: '#ready' }).then((result) => {
      settled = true;
      return result;
    });

    // 타이머를 전혀 진행시키지 않아도(=폴링 간격을 기다리지 않아도) 끝나야 한다.
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);

    const payload = payloadOf(await pending);
    expect(payload.success).toBe(true);
    expect(payload.waitedMs).toBeLessThan(250);
    expect(chromeMock.wakeCalls()).toBe(1);
    expect(chromeMock.wakeArgs()[0]).toEqual([250, 50, expect.any(String)]);
  });

  it('변화가 없으면 예전과 같은 폴링 간격이 폴백으로 남는다', async () => {
    installChrome({ probes: [NOT_READY, READY], wake: 'sliceTimer' });

    let settled = false;
    const pending = waitForTool.execute({ tabId: 1, selector: '#ready' }).then((result) => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(250);
    const payload = payloadOf(await pending);
    expect(payload.success).toBe(true);
    expect(settled).toBe(true);
  });

  it('조건이 처음부터 충족돼 있으면 대기 없이 반환한다(기존 동작)', async () => {
    const chromeMock = installChrome({ probes: [READY], wake: 'immediate' });

    const result = await waitForTool.execute({ tabId: 1, selector: '#ready' });
    const payload = payloadOf(result);

    expect(payload.success).toBe(true);
    expect(chromeMock.wakeCalls()).toBe(0);
    expect(chromeMock.probeCalls()).toBe(1);
  });

  it('타임아웃은 예전처럼 isError:false + timedOut:true 로 보고한다', async () => {
    installChrome({ probes: [NOT_READY], wake: 'sliceTimer' });

    const pending = waitForTool.execute({ tabId: 1, selector: '#never', timeoutMs: 600 });
    await vi.advanceTimersByTimeAsync(700);
    const result = await pending;
    const payload = payloadOf(result);

    expect(result.isError).toBe(false);
    expect(payload.timedOut).toBe(true);
    expect(payload.lastState.selectorFound).toBe(false);
  });

  it('페이지 타이머가 스로틀돼도 전체 소요가 timeoutMs 를 넘지 않는다 (항목 5)', async () => {
    installChrome({ probes: [NOT_READY], wake: 'throttled' });

    const pending = waitForTool.execute({ tabId: 1, selector: '#never', timeoutMs: 600 });
    await vi.advanceTimersByTimeAsync(5_000);
    const payload = payloadOf(await pending);

    expect(payload.timedOut).toBe(true);
    expect(payload.waitedMs).toBeLessThanOrEqual(650);
  });
});

describe('waitForDomChange (in-page 관찰자)', () => {
  afterEach(() => {
    delete (window as any).__acmWaitForWake;
    vi.restoreAllMocks();
  });

  it('새로 걸기 전에 이전 관찰자를 끊는다 — 문서당 하나만 산다 (항목 5)', async () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');

    const first = waitForDomChange(10_000, 50, 'k');
    expect((window as any).__acmWaitForWake).toBeTruthy();

    const second = waitForDomChange(10_000, 50, 'k');

    await expect(first).resolves.toBe('cancelled');
    expect(disconnect).toHaveBeenCalledTimes(1);

    // 두 번째 것도 취소해 테스트가 타이머를 남기지 않게 한다.
    (window as any).__acmWaitForWake.cancel();
    await expect(second).resolves.toBe('cancelled');
  });
});
