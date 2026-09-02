/**
 * auto-chrome-mcp fork — navigate 로딩 대기(A2)의 "커밋 전 이전 문서" 경합 테스트.
 *
 * 2026-08-23 실측 버그: tabs.update 직후에는 아직 이전 문서가 살아 있고 readyState 가
 * 'complete' 라, 대기가 1~7ms 만에 성공으로 끝나며 결과의 url·title 도 이전 페이지 것이
 * 그대로 나갔다. 문서 교체(docId)와 탭 status, 그리고 내비게이션 시작 신호로 가린다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Mod = typeof import('@/entrypoints/background/tools/browser/wait-for');

interface Sample {
  readyState: string;
  docId: number;
  status: string;
}

function installChrome(samples: Sample[]): { calls: () => number } {
  let index = 0;
  const current = () => samples[Math.min(index, samples.length - 1)];
  (globalThis as any).chrome = {
    scripting: {
      executeScript: vi.fn(async () => {
        const sample = current();
        index++;
        return [{ result: { readyState: sample.readyState, docId: sample.docId } }];
      }),
    },
    tabs: {
      get: vi.fn(async () => ({ id: 1, url: 'https://example.com/', status: current().status })),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
  return { calls: () => index };
}

async function load(): Promise<Mod> {
  vi.resetModules();
  return import('@/entrypoints/background/tools/browser/wait-for');
}

const OLD_DOC: Sample = { readyState: 'complete', docId: 100, status: 'loading' };
const NEW_DOC: Sample = { readyState: 'interactive', docId: 200, status: 'loading' };

describe('waitForPageLoad', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('커밋 전 이전 문서의 complete 를 로딩 완료로 오인하지 않는다', async () => {
    installChrome([OLD_DOC, OLD_DOC, OLD_DOC, NEW_DOC]);
    const { waitForPageLoad } = await load();

    const result = await waitForPageLoad(1, 'domcontentloaded', 5000, {
      navigationStarted: () => true,
    });

    expect(result.reached).toBe(true);
    expect(result.readyState).toBe('interactive');
    // 이전 문서를 그대로 받아들였다면 사실상 0ms 에 끝난다.
    expect(result.waitedMs).toBeGreaterThanOrEqual(300);
  });

  it("domcontentloaded 는 새 문서의 'interactive' 에서 바로 반환한다 (load 까지 기다리지 않음)", async () => {
    // 서브리소스가 남아 tab.status 는 계속 'loading' 인 상태.
    installChrome([{ readyState: 'interactive', docId: 200, status: 'loading' }]);
    const { waitForPageLoad } = await load();

    const result = await waitForPageLoad(1, 'domcontentloaded', 5000, {
      navigationStarted: () => true,
      targetUrl: 'https://example.com/', // 탭이 이미 목표 URL — 커밋 완료
    });

    expect(result.reached).toBe(true);
    expect(result.waitedMs).toBeLessThan(300);
  });

  it('이미 로딩 중이던 페이지 위에 다시 navigate 하면 이전 문서의 interactive 를 믿지 않는다', async () => {
    // Codex 리뷰 지적: A 페이지가 아직 로딩 중(interactive)인 탭에 B 를 이어서 navigate 하면,
    // 커밋 전 A 의 interactive 가 "새 문서" 증거로 오인돼 이전 URL·제목이 그대로 보고됐다.
    const loadingOldDoc = { readyState: 'interactive', docId: 100, status: 'loading' };
    const newDoc = { readyState: 'interactive', docId: 200, status: 'loading' };
    installChrome([loadingOldDoc, loadingOldDoc, loadingOldDoc, newDoc]);
    const { waitForPageLoad } = await load();

    const result = await waitForPageLoad(1, 'domcontentloaded', 5000, {
      navigationStarted: () => true,
      targetUrl: 'https://example.com/next', // 아직 이 URL 로 안 갔다 (탭 URL 은 이전 페이지)
    });

    expect(result.reached).toBe(true);
    // 이전 문서의 interactive 를 받아들였다면 사실상 0ms 에 끝난다.
    expect(result.waitedMs).toBeGreaterThanOrEqual(300);
  });

  it("waitUntil:'load' 는 'interactive' 로는 끝내지 않는다", async () => {
    installChrome([{ readyState: 'interactive', docId: 200, status: 'loading' }]);
    const { waitForPageLoad } = await load();

    const result = await waitForPageLoad(1, 'load', 500, { navigationStarted: () => true });

    expect(result.reached).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it('이미 새 문서가 커밋돼 있고 로딩이 끝났으면 바로 반환한다', async () => {
    installChrome([{ readyState: 'complete', docId: 200, status: 'complete' }]);
    const { waitForPageLoad } = await load();

    const result = await waitForPageLoad(1, 'load', 5000, { navigationStarted: () => true });

    expect(result.reached).toBe(true);
    expect(result.waitedMs).toBeLessThan(300);
  });

  it('내비게이션이 아예 일어나지 않았으면 grace 만큼만 확인하고 끝낸다', async () => {
    installChrome([{ readyState: 'complete', docId: 100, status: 'complete' }]);
    const { waitForPageLoad } = await load();

    const result = await waitForPageLoad(1, 'domcontentloaded', 5000, {
      navigationStarted: () => false,
      commitGraceMs: 400,
    });

    expect(result.reached).toBe(true);
    expect(result.waitedMs).toBeGreaterThanOrEqual(400);
    expect(result.waitedMs).toBeLessThan(1500);
  });

  it('로딩이 끝나지 않으면 오류가 아니라 timedOut 관측으로 돌려준다', async () => {
    installChrome([{ readyState: 'loading', docId: 200, status: 'loading' }]);
    const { waitForPageLoad } = await load();

    const result = await waitForPageLoad(1, 'load', 500, { navigationStarted: () => true });

    expect(result.reached).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it('탭이 닫히면 타임아웃까지 기다리지 않고 tab_not_found 로 끝낸다', async () => {
    installChrome([{ readyState: 'loading', docId: 200, status: 'loading' }]);
    (globalThis as any).chrome.tabs.get = vi.fn(async () => {
      throw new Error('No tab with id: 1');
    });
    const { waitForPageLoad } = await load();

    const result = await waitForPageLoad(1, 'load', 5000, { navigationStarted: () => true });

    expect(result.reached).toBe(false);
    expect(result.skipped).toBe('tab_not_found');
    expect(result.waitedMs).toBeLessThan(1000);
  });

  it('주입할 수 없는 문서(about:blank·PDF)는 탭 상태로 판정한다', async () => {
    installChrome([{ readyState: 'complete', docId: 200, status: 'complete' }]);
    // readyState 를 영원히 못 읽는 상황
    (globalThis as any).chrome.scripting.executeScript = vi.fn(async () => {
      throw new Error('Cannot access contents of the page');
    });
    const { waitForPageLoad } = await load();

    const result = await waitForPageLoad(1, 'load', 8000, { navigationStarted: () => true });

    expect(result.reached).toBe(true);
    expect(result.skipped).toBe('not_injectable');
    expect(result.waitedMs).toBeLessThan(2000);
  });

  it('grace 가 타임아웃보다 길어도 해시 이동을 timedOut 으로 처리하지 않는다', async () => {
    installChrome([{ readyState: 'complete', docId: 100, status: 'complete' }]);
    const { waitForPageLoad } = await load();

    // 같은 문서 안의 해시 이동: loading 이벤트도 없고 docId 도 그대로다.
    const result = await waitForPageLoad(1, 'domcontentloaded', 400, {
      navigationStarted: () => false,
    });

    expect(result.reached).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it('watchNavigationStart 는 loading 이벤트를 본 탭만 시작으로 친다', async () => {
    installChrome([OLD_DOC]);
    const { watchNavigationStart } = await load();
    const watcher = watchNavigationStart();
    const listener = (globalThis as any).chrome.tabs.onUpdated.addListener.mock.calls[0][0];

    expect(watcher.started(1)).toBe(false);
    listener(1, { status: 'loading' });
    expect(watcher.started(1)).toBe(true);
    expect(watcher.started(2)).toBe(false);

    watcher.stop();
    expect((globalThis as any).chrome.tabs.onUpdated.removeListener).toHaveBeenCalled();
  });
});
