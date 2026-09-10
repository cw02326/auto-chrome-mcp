import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cdp = vi.hoisted(() => ({ attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn() }));
vi.mock('@/utils/cdp-session-manager', () => ({ cdpSessionManager: cdp }));

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const result = (value: any) => JSON.parse(value.content[0].text);

function chromeMock() {
  const listeners: Record<string, ((...args: any[]) => void) | undefined> = {};
  const event = (name: string) => ({
    addListener: vi.fn((listener) => {
      listeners[name] = listener;
    }),
  });
  const storage = { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined) };
  return {
    storage: { session: storage },
    storageSession: storage,
    alarms: { create: vi.fn(), clear: vi.fn().mockResolvedValue(true), onAlarm: event('alarm') },
    tabs: { onRemoved: event('removed'), onUpdated: event('updated') },
    webNavigation: { onCommitted: event('committed') },
    debugger: { onDetach: event('detached') },
    listeners,
  };
}

describe('computer input state', () => {
  let chromeState: ReturnType<typeof chromeMock>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    cdp.attach.mockResolvedValue(undefined);
    cdp.detach.mockResolvedValue(undefined);
    cdp.sendCommand.mockResolvedValue({});
    chromeState = chromeMock();
    (globalThis as any).chrome = chromeState;
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  async function inputState() {
    const mod = await import('@/utils/computer-input-state');
    await mod.computerInputState.ready();
    return mod.computerInputState;
  }

  it('mouse_down/up tracks button masks and uses the last actual coordinates for recovery', async () => {
    const state = await inputState();
    expect(
      (await state.execute(7, { action: 'mouse_down', coordinates: { x: 12.4, y: 20.8 } })).isError,
    ).toBe(false);
    expect(cdp.sendCommand.mock.calls[0][2]).toMatchObject({
      type: 'mousePressed',
      x: 12,
      y: 21,
      buttons: 1,
    });
    await state.execute(7, { action: 'mouse_up', coordinates: { x: 30, y: 40 } });
    expect(cdp.sendCommand.mock.calls[1][2]).toMatchObject({
      type: 'mouseReleased',
      x: 30,
      y: 40,
      buttons: 0,
    });
    expect(state.hasHeldInput(7)).toBe(false);
  });

  it('key_down/up keeps modifier bit while down and removes it on keyUp', async () => {
    const state = await inputState();
    await state.execute(7, { action: 'key_down', key: 'Shift' });
    await state.execute(7, { action: 'key_up', key: 'Shift' });
    expect(cdp.sendCommand.mock.calls.map((call) => call[2])).toEqual([
      expect.objectContaining({ type: 'rawKeyDown', key: 'Shift', modifiers: 8 }),
      expect.objectContaining({ type: 'keyUp', key: 'Shift', modifiers: 0 }),
    ]);
  });

  it('held modifier permits coordinate mouse_down and drag_path, then key_up releases it', async () => {
    const state = await inputState();
    await state.execute(7, { action: 'key_down', key: 'Control' });
    await expect(state.guardAction(7, 'mouse_down', false)).resolves.toBeUndefined();
    await expect(state.guardAction(7, 'drag_path', false)).resolves.toBeUndefined();
    await state.execute(7, { action: 'key_up', key: 'Control' });
    expect(state.hasHeldInput(7)).toBe(false);
  });

  it('drag_path dispatches every point and releases its temporary held button', async () => {
    const state = await inputState();
    const outcome = await state.execute(7, {
      action: 'drag_path',
      path: [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
        { x: 5, y: 6 },
      ],
    });
    expect(result(outcome)).toMatchObject({ action: 'drag_path', points: 3, heldInput: false });
    expect(cdp.sendCommand.mock.calls.map((call) => call[2].type)).toEqual([
      'mousePressed',
      'mouseMoved',
      'mouseMoved',
      'mouseReleased',
    ]);
    expect(cdp.sendCommand.mock.calls.at(-1)![2]).toMatchObject({ buttons: 0, x: 5, y: 6 });
  });

  it('ime_type sends composition then commit without replacement offsets', async () => {
    const state = await inputState();
    await state.execute(7, { action: 'ime_type', text: '한글' });
    expect(cdp.sendCommand.mock.calls).toEqual([
      [7, 'Input.imeSetComposition', { text: '한글', selectionStart: 2, selectionEnd: 2 }],
      [7, 'Input.insertText', { text: '한글' }],
    ]);
  });

  it('does not dispatch a down event when durable pending-state persistence fails', async () => {
    chromeState.storageSession.set.mockRejectedValueOnce(new Error('quota'));
    const state = await inputState();
    const outcome = await state.execute(7, { action: 'mouse_down', coordinates: { x: 1, y: 2 } });
    expect(outcome.isError).toBe(true);
    expect((outcome.content[0] as any).text).toContain('Unable to persist pending input state');
    expect(cdp.sendCommand).not.toHaveBeenCalled();
    expect(state.hasHeldInput(7)).toBe(false);
  });

  it('watchdog uses the first down deadline rather than extending it on activity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const state = await inputState();
    await state.execute(7, { action: 'mouse_down', coordinates: { x: 1, y: 2 } });
    await vi.advanceTimersByTimeAsync(9_000);
    await state.execute(7, { action: 'hover', coordinates: { x: 4, y: 5 } });
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(cdp.sendCommand.mock.calls.map((call) => call[2].type)).toContain('mouseReleased');
    expect(state.hasHeldInput(7)).toBe(false);
  });

  it('failed release remains pending and watchdog retries it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    cdp.sendCommand
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('release lost'))
      .mockResolvedValueOnce({});
    const state = await inputState();
    await state.execute(7, { action: 'mouse_down', coordinates: { x: 7, y: 9 } });
    await expect(state.releaseAll(7)).rejects.toThrow('Unable to release all held input');
    expect(state.hasHeldInput(7)).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    await flush();
    expect(state.hasHeldInput(7)).toBe(false);
    expect(
      cdp.sendCommand.mock.calls.filter((call) => call[2].type === 'mouseReleased'),
    ).toHaveLength(2);
  });

  it('CDP timeout preserves the hold until a late down has settled, then releases it', async () => {
    vi.useFakeTimers();
    let resolveDown!: () => void;
    cdp.sendCommand
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveDown = resolve;
          }),
      )
      .mockResolvedValueOnce({});
    const state = await inputState();
    const pending = state.execute(7, { action: 'mouse_down', coordinates: { x: 1, y: 2 } });
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await pending).isError).toBe(true);
    expect(state.hasHeldInput(7)).toBe(true);
    // public computer 경계가 오류 뒤 releaseAll을 호출해도, late down보다 먼저 상태를 버리면 안 된다.
    await state.releaseAll(7);
    expect(state.hasHeldInput(7)).toBe(true);
    resolveDown();
    await flush();
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(
      cdp.sendCommand.mock.calls.filter((call) => call[2].type === 'mouseReleased').length,
    ).toBeGreaterThanOrEqual(2);
    expect(cdp.sendCommand.mock.calls.at(-1)![2]).toMatchObject({
      type: 'mouseReleased',
      buttons: 0,
    });
    expect(state.hasHeldInput(7)).toBe(false);
  });

  it('응답이 영원히 사라진 press도 해제하며 불확실한 탭의 새 입력은 거부한다', async () => {
    let physicallyPressed = false;
    cdp.sendCommand.mockImplementation(async (_tab, _method, event) => {
      if (event.type === 'mousePressed') {
        physicallyPressed = true;
        return new Promise(() => {});
      }
      if (event.type === 'mouseReleased') physicallyPressed = false;
      return {};
    });
    const state = await inputState();
    const action = state.execute(7, { action: 'mouse_down', coordinates: { x: 1, y: 2 } });
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await action).isError).toBe(true);
    expect(physicallyPressed).toBe(false);
    expect(state.hasHeldInput(7)).toBe(true);
    await expect(state.guardAction(7, 'hover', true)).rejects.toThrow('recovery');
    const releases = cdp.sendCommand.mock.calls.filter(
      (call) => call[2].type === 'mouseReleased',
    ).length;
    await vi.advanceTimersByTimeAsync(9_000);
    expect(
      cdp.sendCommand.mock.calls.filter((call) => call[2].type === 'mouseReleased').length,
    ).toBeGreaterThan(releases);
    expect(physicallyPressed).toBe(false);
  });

  it('watchdog은 느린 경로 드래그를 중단하고 버튼을 해제한다', async () => {
    let physicallyPressed = false;
    cdp.sendCommand.mockImplementation(async (_tab, _method, event) => {
      if (event.type === 'mousePressed') physicallyPressed = true;
      if (event.type === 'mouseReleased') physicallyPressed = false;
      if (event.type === 'mouseMoved') await new Promise((resolve) => setTimeout(resolve, 1_000));
      return {};
    });
    const state = await inputState();
    const action = state.execute(7, {
      action: 'drag_path',
      path: Array.from({ length: 30 }, (_, x) => ({ x, y: x })),
    });
    await vi.advanceTimersByTimeAsync(12_000);
    expect((await action).isError).toBe(true);
    expect(physicallyPressed).toBe(false);
    expect(state.hasHeldInput(7)).toBe(false);
    expect(
      cdp.sendCommand.mock.calls.filter((call) => call[2].type === 'mouseMoved').length,
    ).toBeLessThan(29);
  });

  it.each(['updated', 'removed'] as const)(
    'attach 대기 중 %s 이벤트가 오면 press를 보내지 않는다',
    async (event) => {
      let completeAttach!: () => void;
      cdp.attach.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            completeAttach = resolve;
          }),
      );
      const state = await inputState();
      const action = state.execute(7, { action: 'mouse_down', coordinates: { x: 1, y: 2 } });
      await vi.advanceTimersByTimeAsync(0);
      chromeState.listeners[event]!(7, { status: 'loading' });
      completeAttach();
      expect((await action).isError).toBe(true);
      expect(cdp.sendCommand).not.toHaveBeenCalled();
      expect(state.hasHeldInput(7)).toBe(false);
    },
  );

  it('잘못된 키와 버튼은 전송 전에 거부한다', async () => {
    const state = await inputState();
    for (const key of ['', ' ', 'Ctrl+a'])
      expect((await state.execute(7, { action: 'key_down', key })).isError).toBe(true);
    expect(
      (
        await state.execute(7, {
          action: 'mouse_down',
          button: 'unknown' as any,
          coordinates: { x: 1, y: 2 },
        })
      ).isError,
    ).toBe(true);
    expect(cdp.sendCommand).not.toHaveBeenCalled();
  });

  it('restores persisted presses and releases them without waiting on ready recursively', async () => {
    chromeState.storageSession.get.mockResolvedValueOnce({
      'computer-input-state-v1': {
        version: 1,
        tabs: { '7': { buttons: ['left'], keys: [], lastPoint: { x: 33, y: 44 } } },
      },
    });
    const state = await inputState();
    expect(cdp.sendCommand).toHaveBeenCalledWith(
      7,
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mouseReleased', x: 33, y: 44 }),
    );
    expect(state.hasHeldInput(7)).toBe(false);
  });

  it('does not revive a persisted press when its tab closes while storage restore is pending', async () => {
    let resolveStorage!: (value: any) => void;
    chromeState.storageSession.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStorage = resolve;
        }),
    );
    const imported = import('@/utils/computer-input-state');
    await vi.waitFor(() => expect(chromeState.listeners.removed).toBeTypeOf('function'));
    chromeState.listeners.removed!(7);
    resolveStorage({
      'computer-input-state-v1': {
        version: 1,
        tabs: { '7': { buttons: ['left'], keys: [], lastPoint: { x: 1, y: 2 } } },
      },
    });
    const state = (await imported).computerInputState;
    await state.ready();
    expect(state.hasHeldInput(7)).toBe(false);
    expect(cdp.sendCommand).not.toHaveBeenCalled();
  });

  it('navigation and debugger detach clear/release tracked state; held guard permits only safe transitions', async () => {
    const state = await inputState();
    await state.execute(7, { action: 'mouse_down', coordinates: { x: 1, y: 2 } });
    await expect(state.guardAction(7, 'left_click', false)).rejects.toThrow('mouse button');
    await expect(state.guardAction(7, 'hover', true)).resolves.toBeUndefined();
    chromeState.listeners.updated!(7, { status: 'loading' });
    await vi.waitFor(() => expect(state.hasHeldInput(7)).toBe(false));
    await state.execute(7, { action: 'key_down', key: 'Control' });
    chromeState.listeners.detached!({ tabId: 7 });
    await flush();
    // detach 후에는 runtime lease만 버리고 pending release 기록은 남긴다. Chrome 입력 정리 여부를 추측하지 않는다.
    expect(state.hasHeldInput(7)).toBe(true);
    expect(chromeState.storageSession.set).toHaveBeenCalled();
  });
});
