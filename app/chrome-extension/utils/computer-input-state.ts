import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import type {
  ComputerButton,
  ComputerPoint,
  ExtendedInputParams,
} from '@/utils/computer-loop-contract';

const STORAGE_KEY = 'computer-input-state-v1';
const OWNER = 'computer-input-state';
// 조합키·드래그에 수 초를 허용하되 실패한 모델 호출이 사용자 입력을 계속 붙잡지 않게 한다.
const HOLD_WATCHDOG_MS = 10_000;
// CDP 또는 저장소 응답이 멎어도 복구 큐를 진행할 수 있도록 개별 대기는 짧게 제한한다.
const COMMAND_DEADLINE_MS = 2_000;
const RELEASE_RETRY_MS = 1_000;
const WATCHDOG_ALARM_PREFIX = 'computer-input-release-';

type KeyDefinition = { key: string; code?: string; text?: string; modifier?: number };
type HeldTabState = {
  buttons: ComputerButton[];
  keys: KeyDefinition[];
  lastPoint: ComputerPoint;
  deadline?: number;
};
type StoredState = { version: 1; tabs: Record<string, HeldTabState> };
type PendingPress = { settled: Promise<void> };

const BUTTON_BITS: Record<ComputerButton, number> = { left: 1, right: 2, middle: 4 };
const KEY_ALIASES: Record<string, KeyDefinition> = {
  alt: { key: 'Alt', code: 'AltLeft', modifier: 1 },
  option: { key: 'Alt', code: 'AltLeft', modifier: 1 },
  ctrl: { key: 'Control', code: 'ControlLeft', modifier: 2 },
  control: { key: 'Control', code: 'ControlLeft', modifier: 2 },
  meta: { key: 'Meta', code: 'MetaLeft', modifier: 4 },
  cmd: { key: 'Meta', code: 'MetaLeft', modifier: 4 },
  command: { key: 'Meta', code: 'MetaLeft', modifier: 4 },
  win: { key: 'Meta', code: 'MetaLeft', modifier: 4 },
  windows: { key: 'Meta', code: 'MetaLeft', modifier: 4 },
  shift: { key: 'Shift', code: 'ShiftLeft', modifier: 8 },
  enter: { key: 'Enter', code: 'Enter' },
  return: { key: 'Enter', code: 'Enter' },
  backspace: { key: 'Backspace', code: 'Backspace' },
  delete: { key: 'Delete', code: 'Delete' },
  tab: { key: 'Tab', code: 'Tab' },
  escape: { key: 'Escape', code: 'Escape' },
  esc: { key: 'Escape', code: 'Escape' },
  space: { key: ' ', code: 'Space', text: ' ' },
  pageup: { key: 'PageUp', code: 'PageUp' },
  pagedown: { key: 'PageDown', code: 'PageDown' },
  home: { key: 'Home', code: 'Home' },
  end: { key: 'End', code: 'End' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp' },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown' },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft' },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight' },
};

function resolveKey(token: string): KeyDefinition {
  const trimmed = token.trim();
  const known = KEY_ALIASES[trimmed.toLowerCase()];
  if (known) return { ...known };
  if (/^f([1-9]|1[0-2])$/i.test(trimmed))
    return { key: trimmed.toUpperCase(), code: trimmed.toUpperCase() };
  if (trimmed.length === 1) {
    const upper = trimmed.toUpperCase();
    return { key: upper, code: /^[A-Z]$/.test(upper) ? `Key${upper}` : undefined, text: trimmed };
  }
  return { key: trimmed };
}
function explicitModifierMask(modifiers?: ExtendedInputParams['modifiers']): number {
  return (
    (modifiers?.altKey ? 1 : 0) |
    (modifiers?.ctrlKey ? 2 : 0) |
    (modifiers?.metaKey ? 4 : 0) |
    (modifiers?.shiftKey ? 8 : 0)
  );
}
function sameKey(a: KeyDefinition, b: KeyDefinition): boolean {
  return a.key === b.key && a.code === b.code;
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** CDP timeout 뒤에도 원 요청이 늦게 도착할 수 있어, down보다 먼저 release하지 않도록 완료 신호를 보관한다. */
class CommandTimeoutError extends Error {
  constructor(
    method: string,
    readonly settled: Promise<void>,
  ) {
    super(`CDP command timed out: ${method}`);
  }
}

/**
 * MV3 worker 재시작은 JS 메모리를 잃는다. down 이전에 session storage에 pending 상태를 기록하고,
 * 다음 기동에서 그 상태를 즉시 release한다. storage 기록 실패면 down을 보내지 않는다.
 */
class ComputerInputState {
  private states = new Map<number, HeldTabState>();
  private chains = new Map<number, Promise<unknown>>();
  private watchdogs = new Map<number, ReturnType<typeof setTimeout>>();
  private attached = new Set<number>();
  private pendingPresses = new Map<number, PendingPress>();
  private cancelledTabs = new Set<number>();
  private generations = new Map<number, number>();
  /** storage 복구가 늦을 때 이미 닫힌/전환된 탭의 stale down을 되살리지 않기 위한 lifecycle tombstone. */
  private closedTabs = new Set<number>();
  private restoreInvalidatedTabs = new Set<number>();
  private persistTail: Promise<void> = Promise.resolve();
  private readonly restorePromise: Promise<void>;
  private recoveryFailed = false;
  private restored = false;

  constructor() {
    this.registerLifecycleListeners();
    this.restorePromise = this.restoreAndRelease();
  }
  async ready(): Promise<void> {
    await this.restorePromise;
  }
  hasHeldInput(tabId: number): boolean {
    const state = this.states.get(tabId);
    return !!state && (!!state.buttons.length || !!state.keys.length);
  }
  hasHeldButtons(tabId: number): boolean {
    return !!this.states.get(tabId)?.buttons.length;
  }
  modifierMask(tabId: number): number {
    return (this.states.get(tabId)?.keys ?? []).reduce(
      (mask, key) => mask | (key.modifier ?? 0),
      0,
    );
  }

  /** 누른 마우스에는 기존 클릭의 button mask가 없으므로 막고, 동일 CDP 경로인 hover/release/key 전환만 허용한다. */
  async guardAction(tabId: number, action: string, pureCoordinate: boolean): Promise<void> {
    await this.ready();
    if (this.recoveryFailed)
      throw new Error('Input state recovery failed. Retry after restarting the extension worker.');
    if ((this.states.get(tabId)?.deadline ?? Infinity) <= Date.now()) this.cancelledTabs.add(tabId);
    if (this.pendingPresses.has(tabId) || this.cancelledTabs.has(tabId)) {
      if (['wait', 'screenshot', 'zoom'].includes(action)) return;
      throw new Error('Input recovery is pending; wait for held input to be released');
    }
    if (this.hasHeldButtons(tabId)) {
      if (
        ['hover', 'wait', 'screenshot', 'zoom', 'mouse_up', 'key_down', 'key_up'].includes(action)
      )
        return;
      throw new Error('Cannot run this action while a mouse button is held; release it first');
    }
    if (
      !this.hasHeldInput(tabId) ||
      pureCoordinate ||
      [
        'wait',
        'screenshot',
        'zoom',
        'key_down',
        'key_up',
        'mouse_down',
        'drag_path',
        'hover',
      ].includes(action)
    )
      return;
    throw new Error('Cannot run this action while a key is held; release it first');
  }

  async execute(tabId: number, params: ExtendedInputParams): Promise<ToolResult> {
    await this.ready();
    try {
      if (this.recoveryFailed)
        throw new Error(
          'Input state recovery failed. Retry after restarting the extension worker.',
        );
      return await this.serial(tabId, () => this.executeExclusive(tabId, params));
    } catch (error) {
      await this.enqueueRelease(tabId);
      return createErrorResponse(`Input action failed: ${errorText(error)}`);
    }
  }
  async releaseAll(tabId: number): Promise<void> {
    await this.ready();
    await this.serial(tabId, () => this.releaseExclusive(tabId));
  }

  private async executeExclusive(tabId: number, params: ExtendedInputParams): Promise<ToolResult> {
    const generation = this.generations.get(tabId) ?? 0;
    const check = () => this.assertActive(tabId, generation);
    check();
    const state = this.stateFor(tabId);
    const point = params.coordinates;
    const button = params.button ?? 'left';
    if (this.cancelledTabs.has(tabId))
      throw new Error('Input state is being released after navigation or watchdog timeout');
    this.requireButton(button);
    if (params.action === 'mouse_down') {
      this.requirePoint(point);
      if (state.buttons.length)
        throw new Error('Cannot press another mouse button while one is held');
      await this.ensureAttached(tabId);
      check();
      state.buttons.push(button);
      state.lastPoint = this.roundPoint(point!);
      await this.persistOrRollback(tabId, () => {
        state.buttons = state.buttons.filter((held) => held !== button);
      });
      this.armWatchdog(tabId); // timeout 난 press도 뒤늦게 도착할 수 있어 CDP 전송 전에 안전장치를 건다.
      check();
      try {
        await this.mouse(tabId, 'mousePressed', point!, button, 1, params.modifiers);
      } catch (error) {
        this.releaseWhenSafe(tabId, error);
        throw error;
      }
      return this.ok(tabId, { action: params.action, transport: 'cdp' });
    }
    if (params.action === 'mouse_up') {
      this.requirePoint(point);
      if (!state.buttons.includes(button)) throw new Error('Mouse button is not held');
      state.lastPoint = this.roundPoint(point!);
      try {
        await this.mouse(tabId, 'mouseReleased', point!, button, 1, params.modifiers, button);
      } catch (error) {
        this.armWatchdog(tabId);
        throw error;
      }
      state.buttons = state.buttons.filter((held) => held !== button);
      await this.persist();
      await this.finishIfReleased(tabId);
      return this.ok(tabId, { action: params.action, transport: 'cdp' });
    }
    if (params.action === 'hover') {
      this.requirePoint(point);
      await this.ensureAttached(tabId);
      check();
      state.lastPoint = this.roundPoint(point!);
      try {
        await this.mouse(tabId, 'mouseMoved', point!, undefined, 0, params.modifiers);
      } finally {
        if (!this.hasHeldInput(tabId)) await this.detachIfUnused(tabId);
      }
      return this.ok(tabId, { action: params.action, transport: 'cdp' });
    }
    if (params.action === 'key_down') {
      const key = this.requireKey(params.key);
      if (state.keys.some((held) => sameKey(held, key))) throw new Error('Key is already held');
      await this.ensureAttached(tabId);
      check();
      state.keys.push(key);
      await this.persistOrRollback(tabId, () => {
        state.keys = state.keys.filter((held) => !sameKey(held, key));
      });
      this.armWatchdog(tabId);
      check();
      try {
        await this.key(tabId, 'rawKeyDown', key, explicitModifierMask(params.modifiers));
      } catch (error) {
        this.releaseWhenSafe(tabId, error);
        throw error;
      }
      return this.ok(tabId, { action: params.action, transport: 'cdp' });
    }
    if (params.action === 'key_up') {
      const key = this.requireKey(params.key);
      const held = state.keys.find((candidate) => sameKey(candidate, key));
      if (!held) throw new Error('Key is not held');
      try {
        await this.key(tabId, 'keyUp', held, explicitModifierMask(params.modifiers), held);
      } catch (error) {
        this.armWatchdog(tabId);
        throw error;
      }
      state.keys = state.keys.filter((candidate) => !sameKey(candidate, held));
      await this.persist();
      await this.finishIfReleased(tabId);
      return this.ok(tabId, { action: params.action, transport: 'cdp' });
    }
    if (params.action === 'drag_path') {
      if (this.hasHeldButtons(tabId))
        throw new Error('Cannot run this action while a mouse button is held; release it first');
      if (!Array.isArray(params.path) || params.path.length < 2 || params.path.length > 1000)
        throw new Error('Path must contain between 2 and 1000 points');
      params.path.forEach((pathPoint) => this.requirePoint(pathPoint));
      await this.ensureAttached(tabId);
      check();
      state.buttons.push(button);
      state.lastPoint = this.roundPoint(params.path[0]);
      await this.persistOrRollback(tabId, () => {
        state.buttons = state.buttons.filter((held) => held !== button);
      });
      this.armWatchdog(tabId);
      check();
      try {
        await this.mouse(tabId, 'mousePressed', params.path[0], button, 1, params.modifiers);
        for (const pathPoint of params.path.slice(1)) {
          check();
          state.lastPoint = this.roundPoint(pathPoint);
          await this.mouse(tabId, 'mouseMoved', pathPoint, undefined, 0, params.modifiers);
          check();
        }
        await this.mouse(
          tabId,
          'mouseReleased',
          params.path[params.path.length - 1],
          button,
          1,
          params.modifiers,
          button,
        );
      } catch (error) {
        this.releaseWhenSafe(tabId, error);
        throw error;
      }
      state.buttons = state.buttons.filter((held) => held !== button);
      await this.persist();
      await this.finishIfReleased(tabId);
      return this.ok(tabId, {
        action: params.action,
        transport: 'cdp',
        points: params.path.length,
      });
    }
    if (params.action === 'ime_type') {
      if (typeof params.text !== 'string' || !params.text)
        throw new Error('Text parameter is required');
      if (this.hasHeldButtons(tabId))
        throw new Error('Cannot run this action while a mouse button is held; release it first');
      await this.ensureAttached(tabId);
      check();
      let compositionSent = false;
      try {
        // replacement 범위를 생략해야 현재 selection을 0번째 문자로 잘못 치환하지 않는다.
        await this.command(tabId, 'Input.imeSetComposition', {
          text: params.text,
          selectionStart: params.text.length,
          selectionEnd: params.text.length,
        });
        compositionSent = true;
        check();
        await this.command(tabId, 'Input.insertText', { text: params.text });
        compositionSent = false;
      } catch (error) {
        // 조합 시작은 성공하고 commit만 실패할 수 있다. 남은 composing 밑줄을 best-effort로 취소한다.
        if (compositionSent)
          await this.command(tabId, 'Input.imeSetComposition', {
            text: '',
            selectionStart: 0,
            selectionEnd: 0,
          }).catch(() => undefined);
        throw error;
      } finally {
        await this.detachIfUnused(tabId);
      }
      return this.ok(tabId, { action: params.action, transport: 'cdp' });
    }
    throw new Error(`Unsupported input action: ${params.action}`);
  }

  private async mouse(
    tabId: number,
    type: string,
    point: ComputerPoint,
    button?: ComputerButton,
    clickCount = 0,
    modifiers?: ExtendedInputParams['modifiers'],
    releasedButton?: ComputerButton,
  ) {
    const state = this.stateFor(tabId);
    const buttons = state.buttons
      .filter((held) => held !== releasedButton)
      .reduce((mask, held) => mask | BUTTON_BITS[held], 0);
    const params: Record<string, unknown> = {
      type,
      x: Math.round(point.x),
      y: Math.round(point.y),
      buttons,
      modifiers: this.modifierMask(tabId) | explicitModifierMask(modifiers),
    };
    params.button = button ?? state.buttons[0] ?? 'none';
    if (type !== 'mouseMoved') params.clickCount = clickCount || 1;
    await this.command(tabId, 'Input.dispatchMouseEvent', params);
  }
  private async key(
    tabId: number,
    type: 'rawKeyDown' | 'keyUp',
    key: KeyDefinition,
    extraModifiers: number,
    releasedKey?: KeyDefinition,
  ) {
    const heldMask = (this.states.get(tabId)?.keys ?? [])
      .filter((held) => !releasedKey || !sameKey(held, releasedKey))
      .reduce((mask, held) => mask | (held.modifier ?? 0), 0);
    await this.command(tabId, 'Input.dispatchKeyEvent', {
      type,
      key: key.key,
      code: key.code,
      text: type === 'rawKeyDown' ? key.text : undefined,
      modifiers: heldMask | extraModifiers,
    });
  }
  private releaseWhenSafe(tabId: number, error: unknown) {
    this.cancelledTabs.add(tabId);
    // 응답만 유실돼 실제 down이 이미 전달됐을 수 있으므로 지금도 release를 보낸다.
    // 다만 원 요청이 늦게 전달될 가능성은 기록에 남겨, 완료 신호 뒤 한 번 더 해제한다.
    if (error instanceof CommandTimeoutError) {
      const pending = { settled: error.settled };
      this.pendingPresses.set(tabId, pending);
      void error.settled.then(() => {
        if (this.pendingPresses.get(tabId) !== pending) return;
        this.pendingPresses.delete(tabId);
        return this.enqueueRelease(tabId);
      });
    }
    void this.enqueueRelease(tabId);
  }
  private async enqueueRelease(tabId: number): Promise<void> {
    await this.serial(tabId, () => this.releaseExclusive(tabId)).catch(() => undefined);
  }
  private async releaseExclusive(tabId: number): Promise<void> {
    const state = this.states.get(tabId);
    if (!state || (!state.buttons.length && !state.keys.length)) {
      await this.finishIfReleased(tabId);
      return;
    }
    try {
      await this.ensureAttached(tabId);
    } catch (error) {
      this.armWatchdog(tabId);
      throw error;
    }
    for (const button of [...state.buttons])
      try {
        await this.mouse(tabId, 'mouseReleased', state.lastPoint, button, 1, undefined, button);
        if (!this.pendingPresses.has(tabId))
          state.buttons = state.buttons.filter((held) => held !== button);
        await this.persist();
      } catch {
        /* 실패 항목은 watchdog/다음 worker가 재시도한다. */
      }
    for (const key of [...state.keys].reverse())
      try {
        await this.key(tabId, 'keyUp', key, 0, key);
        if (!this.pendingPresses.has(tabId))
          state.keys = state.keys.filter((held) => !sameKey(held, key));
        await this.persist();
      } catch {
        /* 실패한 키도 storage에 남겨 재시도한다. */
      }
    if (this.hasHeldInput(tabId)) {
      this.armWatchdog(tabId);
      if (this.pendingPresses.has(tabId)) return;
      throw new Error('Unable to release all held input');
    }
    await this.finishIfReleased(tabId);
  }

  private stateFor(tabId: number): HeldTabState {
    let state = this.states.get(tabId);
    if (!state) {
      state = { buttons: [], keys: [], lastPoint: { x: 0, y: 0 } };
      this.states.set(tabId, state);
    }
    return state;
  }
  private roundPoint(point: ComputerPoint): ComputerPoint {
    return { x: Math.round(point.x), y: Math.round(point.y) };
  }
  private requireButton(button: unknown): asserts button is ComputerButton {
    if (button !== 'left' && button !== 'right' && button !== 'middle')
      throw new Error('Button must be left, right, or middle');
  }
  private requireKey(key: unknown): KeyDefinition {
    if (
      typeof key !== 'string' ||
      !key ||
      key !== key.trim() ||
      /\s/.test(key) ||
      (key.length > 1 && key.includes('+'))
    )
      throw new Error('Key must be one non-empty key or key alias');
    return resolveKey(key);
  }
  private assertActive(tabId: number, generation?: number) {
    const expired = (this.states.get(tabId)?.deadline ?? Infinity) <= Date.now();
    if (
      this.closedTabs.has(tabId) ||
      this.pendingPresses.has(tabId) ||
      this.cancelledTabs.has(tabId) ||
      expired ||
      (generation !== undefined && generation !== (this.generations.get(tabId) ?? 0))
    )
      throw new Error('Input operation was cancelled by navigation or watchdog timeout');
  }
  private async ensureAttached(tabId: number): Promise<void> {
    if (this.attached.has(tabId)) return;
    const attaching = cdpSessionManager.attach(tabId, OWNER);
    try {
      await this.withDeadline(attaching, 'CDP attach');
      this.attached.add(tabId);
    } catch (error) {
      void attaching.then(() => cdpSessionManager.detach(tabId, OWNER)).catch(() => undefined);
      throw error;
    }
  }
  private async detachIfUnused(tabId: number): Promise<void> {
    if (!this.hasHeldInput(tabId) && this.attached.delete(tabId))
      await this.waitBounded(cdpSessionManager.detach(tabId, OWNER), 'CDP detach');
  }
  private async finishIfReleased(tabId: number): Promise<void> {
    if (this.hasHeldInput(tabId)) return;
    this.states.delete(tabId);
    this.pendingPresses.delete(tabId);
    this.cancelledTabs.delete(tabId);
    this.restoreInvalidatedTabs.delete(tabId);
    this.clearWatchdog(tabId);
    await this.persist();
    await this.detachIfUnused(tabId);
  }
  private requirePoint(point: unknown): asserts point is ComputerPoint {
    if (
      !point ||
      typeof (point as ComputerPoint).x !== 'number' ||
      typeof (point as ComputerPoint).y !== 'number' ||
      !Number.isFinite((point as ComputerPoint).x) ||
      !Number.isFinite((point as ComputerPoint).y)
    )
      throw new Error('Coordinates parameter is required');
  }
  private ok(tabId: number, payload: Record<string, unknown>): ToolResult {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            ...payload,
            heldInput: this.hasHeldInput(tabId),
            heldButtons: this.hasHeldButtons(tabId),
            modifierMask: this.modifierMask(tabId),
          }),
        },
      ],
      isError: false,
    };
  }
  private async command<T = unknown>(tabId: number, method: string, params?: object): Promise<T> {
    return this.withDeadline(cdpSessionManager.sendCommand<T>(tabId, method, params), method);
  }
  private async withDeadline<T>(work: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new CommandTimeoutError(label, settled)),
        COMMAND_DEADLINE_MS,
      );
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private async waitBounded<T>(work: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), COMMAND_DEADLINE_MS);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private async serial<T>(tabId: number, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(tabId) ?? Promise.resolve();
    const run = previous.then(work, work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(tabId, tail);
    void tail.then(() => {
      if (this.chains.get(tabId) === tail) this.chains.delete(tabId);
    });
    return run;
  }

  private armWatchdog(tabId: number) {
    const state = this.states.get(tabId);
    if (!state || !this.hasHeldInput(tabId)) return;
    // 10초는 사람의 modifier/drag보다 충분히 길면서, 오류 뒤 실제 사용자 입력을 오래 가로막지 않는 상한이다.
    const deadline = state.deadline ?? (state.deadline = Date.now() + HOLD_WATCHDOG_MS);
    // 이미 만료된 상태의 release가 실패해도 0ms 반복으로 worker를 굶기지 않고 1초마다 재시도한다.
    const remaining = deadline > Date.now() ? deadline - Date.now() : RELEASE_RETRY_MS;
    this.clearWatchdogTimer(tabId);
    this.watchdogs.set(
      tabId,
      setTimeout(() => {
        this.cancelledTabs.add(tabId);
        void this.enqueueRelease(tabId);
      }, remaining),
    );
    // alarms는 worker 재시작 backup이다. packaged Chrome은 30초 최소/지연이 가능하므로, 10초 목표는 살아 있는 worker의 timer가 담당한다.
    const alarms = (globalThis as any).chrome?.alarms;
    if (alarms?.create) alarms.create(`${WATCHDOG_ALARM_PREFIX}${tabId}`, { when: deadline });
  }
  private clearWatchdogTimer(tabId: number) {
    const timer = this.watchdogs.get(tabId);
    if (timer) clearTimeout(timer);
    this.watchdogs.delete(tabId);
  }
  private clearWatchdog(tabId: number) {
    this.clearWatchdogTimer(tabId);
    const alarms = (globalThis as any).chrome?.alarms;
    if (alarms?.clear) void alarms.clear(`${WATCHDOG_ALARM_PREFIX}${tabId}`);
  }
  private snapshot(): StoredState {
    const tabs: Record<string, HeldTabState> = {};
    for (const [tabId, state] of this.states)
      if (state.buttons.length || state.keys.length)
        tabs[String(tabId)] = {
          buttons: [...state.buttons],
          keys: state.keys.map((key) => ({ ...key })),
          lastPoint: { ...state.lastPoint },
          deadline: state.deadline,
        };
    return { version: 1, tabs };
  }
  private persist(): Promise<void> {
    if (!this.restored || this.recoveryFailed)
      return Promise.reject(
        new Error('Input state has not been recovered; refusing to overwrite recovery data'),
      );
    const snapshot = this.snapshot();
    const write: Promise<void> = this.persistTail.then(() =>
      this.waitBounded<void>(
        (globalThis as any).chrome.storage.session.set({ [STORAGE_KEY]: snapshot }),
        'Input state storage write',
      ),
    );
    this.persistTail = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }
  private async persistOrRollback(tabId: number, rollback: () => void) {
    const pending = this.states.get(tabId);
    if (pending && pending.deadline === undefined) pending.deadline = Date.now() + HOLD_WATCHDOG_MS;
    try {
      await this.persist();
    } catch (error) {
      rollback();
      const state = this.states.get(tabId);
      if (state && !state.buttons.length && !state.keys.length) this.states.delete(tabId);
      await this.persist().catch(() => undefined);
      await this.detachIfUnused(tabId);
      throw new Error(`Unable to persist pending input state: ${errorText(error)}`);
    }
  }
  private async restoreAndRelease(): Promise<void> {
    try {
      const result = await this.waitBounded<Record<string, unknown>>(
        (globalThis as any).chrome.storage.session.get(STORAGE_KEY),
        'Input state storage read',
      );
      const stored = result?.[STORAGE_KEY] as StoredState | undefined;
      if (stored?.version === 1 && stored.tabs)
        for (const [id, saved] of Object.entries(stored.tabs)) {
          const tabId = Number(id);
          if (
            Number.isInteger(tabId) &&
            !this.closedTabs.has(tabId) &&
            saved &&
            Array.isArray(saved.buttons) &&
            Array.isArray(saved.keys)
          ) {
            this.states.set(tabId, {
              buttons: saved.buttons,
              keys: saved.keys,
              lastPoint:
                saved.lastPoint &&
                Number.isFinite(saved.lastPoint.x) &&
                Number.isFinite(saved.lastPoint.y)
                  ? saved.lastPoint
                  : { x: 0, y: 0 },
              deadline: saved.deadline,
            });
            if (this.restoreInvalidatedTabs.has(tabId)) this.cancelledTabs.add(tabId);
          }
        }
    } catch {
      // 저장된 down을 못 읽은 채 빈 스냅샷으로 덮어쓰면 복구 근거가 사라진다.
      // Chrome API가 있는 실제 worker에서 읽기 실패하면 새 입력을 실패 폐쇄한다.
      this.recoveryFailed = Boolean((globalThis as any).chrome?.storage?.session?.get);
      this.restored = !this.recoveryFailed;
      return;
    }
    this.restored = true;
    // ready()를 거치지 않는 내부 release다. restorePromise가 자기 자신을 await하면 worker 시작이 영구 정지한다.
    await Promise.all(
      [...this.states.keys()].map((tabId) =>
        this.serial(tabId, () => this.releaseExclusive(tabId)).catch(() => undefined),
      ),
    );
    if (this.closedTabs.size) await this.persist().catch(() => undefined);
  }
  private cleanupDisconnected(tabId: number, tabClosed = false) {
    // tab close는 target 자체가 사라져 stale release를 지운다. debugger detach는 Chrome 입력 정리 여부를 보장할 수 없으므로,
    // 상태를 storage에 남기고 다음 attach/worker 기동에서 release를 재시도한다.
    this.attached.delete(tabId);
    // 끊긴 CDP 세션은 더 이상 입력을 전달할 수 없다. 복구 기록은 유지하고 응답 대기만 해제한다.
    this.pendingPresses.delete(tabId);
    this.generations.set(tabId, (this.generations.get(tabId) ?? 0) + 1);
    this.restoreInvalidatedTabs.add(tabId);
    if (tabClosed) {
      this.closedTabs.add(tabId);
      this.states.delete(tabId);
      this.pendingPresses.delete(tabId);
      this.cancelledTabs.delete(tabId);
      this.clearWatchdog(tabId);
    } else if (this.hasHeldInput(tabId)) {
      this.cancelledTabs.add(tabId);
      this.armWatchdog(tabId);
    }
    void this.persist().catch(() => undefined);
  }
  private registerLifecycleListeners() {
    const chromeApi = (globalThis as any).chrome;
    const listen = (event: any, callback: (...args: any[]) => void) =>
      event?.addListener?.(callback);
    listen(chromeApi?.tabs?.onRemoved, (tabId: number) => this.cleanupDisconnected(tabId, true));
    listen(chromeApi?.tabs?.onUpdated, (tabId: number, change: any) => {
      if (change?.status === 'loading') {
        this.generations.set(tabId, (this.generations.get(tabId) ?? 0) + 1);
        this.restoreInvalidatedTabs.add(tabId);
        if (this.hasHeldInput(tabId)) this.cancelledTabs.add(tabId);
        void this.enqueueRelease(tabId);
      }
    });
    listen(chromeApi?.webNavigation?.onCommitted, (details: any) => {
      if (details?.frameId === 0) {
        this.generations.set(details.tabId, (this.generations.get(details.tabId) ?? 0) + 1);
        this.restoreInvalidatedTabs.add(details.tabId);
        if (this.hasHeldInput(details.tabId)) this.cancelledTabs.add(details.tabId);
        void this.enqueueRelease(details.tabId);
      }
    });
    listen(chromeApi?.debugger?.onDetach, (source: any) => {
      if (typeof source?.tabId === 'number') this.cleanupDisconnected(source.tabId);
    });
    listen(chromeApi?.alarms?.onAlarm, (alarm: any) => {
      if (typeof alarm?.name === 'string' && alarm.name.startsWith(WATCHDOG_ALARM_PREFIX)) {
        const tabId = Number(alarm.name.slice(WATCHDOG_ALARM_PREFIX.length));
        if (Number.isInteger(tabId)) void this.enqueueRelease(tabId);
      }
    });
  }
}

export const computerInputState = new ComputerInputState();
