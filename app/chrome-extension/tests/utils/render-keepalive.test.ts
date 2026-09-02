/**
 * auto-chrome-mcp fork — 백그라운드 탭 렌더링 유지(frame pump) 테스트.
 *
 * 이 모듈은 원래 `Page.startScreencast` 로 구현돼 있었고 테스트가 하나도 없었다.
 * 실브라우저에서 재 보니 스크린캐스트는 숨은 탭의 프레임을 되살리지 못했는데도
 * 결과에는 성공(assist='screencast')으로 찍혀 "바닥 도달"로 오보고했다.
 * 그래서 여기서는 "실제로 프레임을 강제하는 명령을 주기적으로 보내는가",
 * "못 하면 정직하게 unavailable 로 내려가는가"를 고정한다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const attach = vi.fn(async (_tabId: number, _owner: string) => {});
const detach = vi.fn(async (_tabId: number, _owner: string) => {});
const sendCommand = vi.fn(async (_tabId: number, _method: string, _params?: object) => ({}) as any);

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    attach: (tabId: number, owner: string) => attach(tabId, owner),
    detach: (tabId: number, owner: string) => detach(tabId, owner),
    sendCommand: (tabId: number, method: string, params?: object) =>
      sendCommand(tabId, method, params),
  },
}));

type Mod = typeof import('@/utils/render-keepalive');

const TAB_ID = 7;

function installTabMocks(opts: { active: boolean; windowState?: string }): void {
  (globalThis as any).chrome = {
    tabs: { get: vi.fn(async () => ({ id: TAB_ID, active: opts.active, windowId: 1 })) },
    windows: { get: vi.fn(async () => ({ id: 1, state: opts.windowState ?? 'normal' })) },
  };
}

function captureCalls(): number {
  return sendCommand.mock.calls.filter((c) => c[1] === 'Page.captureScreenshot').length;
}

async function load(): Promise<Mod> {
  vi.resetModules();
  return import('@/utils/render-keepalive');
}

describe('withRenderKeepAlive', () => {
  beforeEach(() => {
    vi.useRealTimers();
    attach.mockClear();
    detach.mockClear();
    sendCommand.mockClear();
    sendCommand.mockImplementation(async () => ({}) as any);
    installTabMocks({ active: false });
  });

  it("renderMode:'off' 는 CDP 를 건드리지 않는다", async () => {
    const { withRenderKeepAlive } = await load();
    const assist = await withRenderKeepAlive(TAB_ID, 'off', async (k) => k.assist);
    expect(assist).toBe('off');
    expect(attach).not.toHaveBeenCalled();
    expect(captureCalls()).toBe(0);
  });

  it("'auto' 는 이미 보이는 탭에는 개입하지 않는다", async () => {
    installTabMocks({ active: true });
    const { withRenderKeepAlive } = await load();
    const assist = await withRenderKeepAlive(TAB_ID, 'auto', async (k) => k.assist);
    expect(assist).toBe('not-needed');
    expect(attach).not.toHaveBeenCalled();
  });

  it("최소화된 창의 활성 탭은 'auto' 에서도 살려 준다", async () => {
    installTabMocks({ active: true, windowState: 'minimized' });
    const { withRenderKeepAlive } = await load();
    await withRenderKeepAlive(TAB_ID, 'auto', async (k) => {
      expect(k.assist).toBe('frame-pump');
    });
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it('숨은 탭에서는 프레임을 강제하고, 작업이 길어지면 주기적으로 다시 누른다', async () => {
    const { withRenderKeepAlive } = await load();

    const assist = await withRenderKeepAlive(TAB_ID, 'auto', async (keepAlive) => {
      // 킥 1회는 fn 진입 전에 이미 나가 있어야 한다 (첫 스크롤이 곧바로 발화하도록).
      expect(captureCalls()).toBe(1);
      await new Promise((r) => setTimeout(r, 700));
      return keepAlive.assist;
    });

    expect(assist).toBe('frame-pump');
    // 킥 + 250ms 간격 펌프 2회 이상
    expect(captureCalls()).toBeGreaterThanOrEqual(3);
    expect(detach).toHaveBeenCalledWith(TAB_ID, 'render-keepalive');
  });

  it('작업이 끝나면 펌프를 멈춘다', async () => {
    const { withRenderKeepAlive } = await load();
    await withRenderKeepAlive(TAB_ID, 'force', async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    const afterRun = captureCalls();
    await new Promise((r) => setTimeout(r, 700));
    expect(captureCalls()).toBe(afterRun);
  });

  it('attach 가 실패하면 unavailable 로 알린다', async () => {
    attach.mockRejectedValueOnce(new Error('debugger already attached'));
    const { withRenderKeepAlive } = await load();
    const assist = await withRenderKeepAlive(TAB_ID, 'force', async (k) => k.assist);
    expect(assist).toBe('unavailable');
    expect(captureCalls()).toBe(0);
  });

  it('첫 캡처가 실패하면 unavailable 로 내려가고 세션을 놓아준다', async () => {
    sendCommand.mockRejectedValueOnce(new Error('Not attached to an active page'));
    const { withRenderKeepAlive } = await load();
    const assist = await withRenderKeepAlive(TAB_ID, 'force', async (k) => k.assist);
    expect(assist).toBe('unavailable');
    expect(detach).toHaveBeenCalledWith(TAB_ID, 'render-keepalive');
  });

  it('도중에 펌프가 계속 실패하면 핸들이 unavailable 로 내려간다 (거짓 성공 방지)', async () => {
    let calls = 0;
    sendCommand.mockImplementation(async () => {
      calls++;
      if (calls === 1) return {} as any; // 킥은 성공
      throw new Error('tab crashed');
    });

    const { withRenderKeepAlive } = await load();
    const keepAliveRef = await withRenderKeepAlive(TAB_ID, 'force', async (keepAlive) => {
      expect(keepAlive.assist).toBe('frame-pump');
      await new Promise((r) => setTimeout(r, 1200));
      return keepAlive;
    });

    expect(keepAliveRef.assist).toBe('unavailable');
  });
});
