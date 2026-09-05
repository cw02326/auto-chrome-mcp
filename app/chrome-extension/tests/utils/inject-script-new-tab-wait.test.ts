/**
 * auto-chrome-mcp fork — chrome_inject_script 새 탭 생성 후 대기 회귀 테스트 (task E5).
 *
 * 계약: url 로 새 탭을 만든 뒤 예전에는 고정 3000ms 를 무조건 쉬었다. 이제는
 * waitForPageLoad(관측 기반) 를 먼저 기다리고, 로드가 그보다 일찍 끝나면 그만큼 빨리 돌아온다.
 * waitForPageLoad 자체가 실패(reject)하면 예전과 같은 고정 3000ms 로 폴백한다.
 *
 * url-target.ts / wait-for.ts 는 이 작업 범위 밖이라 수정하지 않고, 여기서는 모듈째 모킹한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/entrypoints/background/tools/browser/url-target', () => ({
  findTabByUrlInSessionScope: vi.fn(async () => null),
  createTabForUrl: vi.fn(async () => ({
    id: 9,
    url: 'https://example.com/new',
    title: 'New Tab',
    windowId: 1,
    active: true,
  })),
}));

type WaitForPageLoadFn = (
  tabId: number,
  waitUntil: string,
  timeoutMs: number,
  options?: unknown,
) => Promise<unknown>;

const waitForPageLoadMock = vi.fn<WaitForPageLoadFn>();

vi.mock('@/entrypoints/background/tools/browser/wait-for', () => ({
  waitForPageLoad: (...args: Parameters<WaitForPageLoadFn>) => waitForPageLoadMock(...args),
}));

type InjectScriptModule = typeof import('@/entrypoints/background/tools/browser/inject-script');

async function loadTool() {
  vi.resetModules();
  (globalThis as any).chrome.scripting = {
    executeScript: vi.fn(async () => [{ result: undefined }]),
  };

  const mod: InjectScriptModule =
    await import('@/entrypoints/background/tools/browser/inject-script');
  return mod.injectScriptTool;
}

describe('chrome_inject_script — 새 탭 대기(task E5)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    waitForPageLoadMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('로드가 200ms 에 끝나면 3000ms 를 다 기다리지 않고 그 근처에서 끝난다', async () => {
    waitForPageLoadMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ waitUntil: 'domcontentloaded', reached: true }), 200);
        }),
    );

    const tool = await loadTool();
    const promise = tool.execute({
      url: 'https://example.com/new',
      type: 'ISOLATED',
      jsScript: '1+1',
    } as any);

    await vi.advanceTimersByTimeAsync(250);
    const result = await promise;

    expect(waitForPageLoadMock).toHaveBeenCalledTimes(1);
    expect(waitForPageLoadMock.mock.calls[0][0]).toBe(9);
    expect(waitForPageLoadMock.mock.calls[0][1]).toBe('domcontentloaded');
    expect(result.isError).toBeFalsy();
  });

  it('waitForPageLoad 가 실패(reject)하면 예전과 같은 고정 3000ms 로 폴백한다', async () => {
    waitForPageLoadMock.mockImplementation(() => Promise.reject(new Error('boom')));

    const tool = await loadTool();
    const promise = tool.execute({
      url: 'https://example.com/new',
      type: 'ISOLATED',
      jsScript: '1+1',
    } as any);

    await vi.advanceTimersByTimeAsync(2000);
    let settled = false;
    promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1200);
    const result = await promise;
    expect(result.isError).toBeFalsy();
  });
});
