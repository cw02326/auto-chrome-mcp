import { cdpSessionManager } from '@/utils/cdp-session-manager';

/**
 * ConsoleBuffer - 콘솔 로그를 계속 모아 두는 버퍼 관리자
 *
 * 탭마다 순환 버퍼를 하나씩 두고 콘솔 이벤트를 계속 모은다.
 * 탭이 다른 도메인으로 이동하면 버퍼를 비운다. 사이트별 로그가 섞이지 않게 하려는 것이다.
 */

const DEFAULT_MAX_BUFFER_MESSAGES = 2000;
const DEFAULT_MAX_BUFFER_EXCEPTIONS = 500;

// auto-chrome-mcp fork (upstream #215): CDP RemoteObject의 preview는 한 단계까지만 채워지므로
// 중첩 객체가 "Object" / {…} 로 잘려 나오고 깊은 속성이 사라진다.
// preview가 실제로 손실된 인자에 한해 Runtime.callFunctionOn 으로 깊은 직렬화를 시도하고,
// 아래 상한들로 CDP 호출 폭주와 거대 페이로드를 막는다.
export const DEEP_SERIALIZE_MAX_DEPTH = 4;
export const DEEP_SERIALIZE_MAX_JSON_CHARS = 5000;
export const DEEP_SERIALIZE_MAX_PROPS_PER_LEVEL = 100;
export const DEEP_SERIALIZE_MAX_ARGS_PER_MESSAGE = 5;
export const DEEP_SERIALIZE_MAX_PER_RUN = 100;
export const DEEP_SERIALIZE_RUN_DEADLINE_MS = 5000;
export const DEEP_SERIALIZE_TIMEOUT_MS = 800;
export const DEEP_SERIALIZE_TRUNCATION_MARKER = '…[truncated]';

// auto-chrome-mcp fork: buffer 모드는 연속 수집이라 "한 번의 실행" 개념이 없으므로
// 슬라이딩 윈도우(10초당 100회)로 tab별 깊은 직렬화 예산을 제한한다.
const DEEP_SERIALIZE_BUFFER_WINDOW_MS = 10_000;
const DEEP_SERIALIZE_BUFFER_WINDOW_MAX = 100;

export interface BufferedConsoleMessage {
  timestamp: number;
  level: string;
  text: string;
  args?: unknown[];
  // auto-chrome-mcp fork: preview가 손실된 인자를 깊게 직렬화한 결과. 실패 시 shallow 결과가 그대로 남는다.
  argsSerialized?: unknown[];
  argsDeepSerializedCount?: number;
  source?: string;
  url?: string;
  lineNumber?: number;
  stackTrace?: unknown;
}

export interface BufferedConsoleException {
  timestamp: number;
  text: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  stackTrace?: unknown;
}

interface TabConsoleBufferState {
  tabId: number;
  tabUrl: string;
  tabTitle: string;
  hostname: string;
  captureStartTime: number;
  messages: BufferedConsoleMessage[];
  exceptions: BufferedConsoleException[];
  droppedMessageCount: number;
  droppedExceptionCount: number;
  // auto-chrome-mcp fork: 깊은 직렬화 슬라이딩 윈도우 예산
  deepWindowStart: number;
  deepWindowCount: number;
  deepSkippedCount: number;
}

export interface ConsoleBufferReadOptions {
  pattern?: RegExp;
  onlyErrors?: boolean;
  limit?: number;
  includeExceptions?: boolean;
}

export interface ConsoleBufferReadResult {
  tabId: number;
  tabUrl: string;
  tabTitle: string;
  captureStartTime: number;
  captureEndTime: number;
  totalDurationMs: number;
  messages: BufferedConsoleMessage[];
  exceptions: BufferedConsoleException[];
  totalBufferedMessages: number;
  totalBufferedExceptions: number;
  messageCount: number;
  exceptionCount: number;
  messageLimitReached: boolean;
  droppedMessageCount: number;
  droppedExceptionCount: number;
  // auto-chrome-mcp fork: 예산 초과로 깊은 직렬화를 건너뛴 인자 수(0이면 손실 없음)
  deepSerializationSkipped: number;
}

function extractHostname(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function isErrorLevel(level?: string): boolean {
  const normalized = (level || '').toLowerCase();
  return normalized === 'error' || normalized === 'assert';
}

function matchesPattern(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

function formatConsoleArgs(args: unknown[]): string {
  if (!args || args.length === 0) return '';

  return args
    .map((arg: unknown) => {
      const a = arg as Record<string, unknown>;
      if (a.type === 'string') return (a.value as string) || '';
      if (a.type === 'number') return String(a.value ?? '');
      if (a.type === 'boolean') return String(a.value ?? '');
      if (a.type === 'object') return (a.description as string) || '[Object]';
      if (a.type === 'undefined') return 'undefined';
      if (a.type === 'function') return (a.description as string) || '[Function]';
      return (a.description as string) || (a.value as string) || String(arg);
    })
    .join(' ');
}

/**
 * CDP RemoteObject 에서 안전한 미리보기만 뽑는다. objectId 는 버려 메모리 누수를 막는다
 */
function extractArgPreview(arg: unknown): unknown {
  const a = arg as Record<string, unknown>;
  if (!a || typeof a !== 'object') return arg;

  // 안전한 필드만 남기고 objectId 는 버린다
  const preview: Record<string, unknown> = {
    type: a.type,
  };

  if ('value' in a) preview.value = a.value;
  if ('unserializableValue' in a) preview.unserializableValue = a.unserializableValue;
  if ('description' in a) preview.description = a.description;
  if ('subtype' in a) preview.subtype = a.subtype;
  if ('className' in a) preview.className = a.className;

  return preview;
}

/* ------------------------------------------------------------------------- *
 * auto-chrome-mcp fork (upstream #215): RemoteObject 깊은 직렬화
 * ------------------------------------------------------------------------- */

interface RemoteObjectPreview {
  type?: string;
  subtype?: string;
  description?: string;
  overflow?: boolean;
  properties?: RemoteObjectPropertyPreview[];
  entries?: RemoteObjectEntryPreview[];
}

interface RemoteObjectPropertyPreview {
  name: string;
  type?: string;
  subtype?: string;
  value?: string;
  valuePreview?: RemoteObjectPreview;
}

interface RemoteObjectEntryPreview {
  key?: RemoteObjectPreview;
  value?: RemoteObjectPreview;
}

interface RemoteObjectLike {
  type?: string;
  subtype?: string;
  className?: string;
  description?: string;
  value?: unknown;
  unserializableValue?: string;
  objectId?: string;
  preview?: RemoteObjectPreview;
}

/**
 * auto-chrome-mcp fork: 깊은 직렬화를 시도하지 않는 subtype.
 * - node/proxy: 순회 비용이 크거나 트랩이 임의 코드를 실행할 수 있음
 * - promise/weakmap/weakset/generator/iterator: 순회해도 얻을 정보가 없음
 */
const SKIP_DEEP_SUBTYPES = new Set([
  'node',
  'proxy',
  'promise',
  'weakmap',
  'weakset',
  'generator',
  'iterator',
]);

/** auto-chrome-mcp fork: preview의 value 문자열만으로 이미 완전한 subtype (중첩 손실 아님) */
const SELF_DESCRIBING_SUBTYPES = new Set([
  'null',
  'date',
  'regexp',
  'error',
  'node',
  'proxy',
  'promise',
  'weakmap',
  'weakset',
  'generator',
  'iterator',
  'wasmvalue',
]);

function isPreviewLossy(preview: RemoteObjectPreview, depth: number): boolean {
  if (preview.overflow === true) return true;
  if (depth >= 3) return false; // 방어적 상한 (preview는 사실상 1~2단계만 채워짐)

  for (const prop of preview.properties || []) {
    if (prop.valuePreview) {
      if (isPreviewLossy(prop.valuePreview, depth + 1)) return true;
      continue;
    }
    // 중첩 객체/배열이 valuePreview 없이 "Object" 같은 문자열로만 남은 경우 = 손실
    if (prop.type === 'object' && !SELF_DESCRIBING_SUBTYPES.has(prop.subtype || '')) return true;
  }

  for (const entry of preview.entries || []) {
    if (entry.key && isPreviewLossy(entry.key, depth + 1)) return true;
    if (entry.value && isPreviewLossy(entry.value, depth + 1)) return true;
  }

  return false;
}

/**
 * auto-chrome-mcp fork: shallow preview만으로는 정보가 손실되는 인자인지 판정.
 * 손실이 아니면 CDP 왕복 없이 preview 재구성(fast path)으로 충분하다.
 */
export function isLossyRemoteObject(arg: unknown): boolean {
  const a = arg as RemoteObjectLike | null;
  if (!a || typeof a !== 'object') return false;
  if (a.type !== 'object') return false; // 원시값/function은 이미 완전
  if (a.subtype === 'null') return false;
  if (typeof a.objectId !== 'string' || !a.objectId) return false; // 깊은 직렬화 불가
  if (SKIP_DEEP_SUBTYPES.has(a.subtype || '')) return false;
  if (!a.preview) return true;
  return isPreviewLossy(a.preview, 0);
}

function previewPropertyToValue(prop: RemoteObjectPropertyPreview): unknown {
  if (prop.valuePreview) return previewToValue(prop.valuePreview);
  switch (prop.type) {
    case 'number': {
      const n = Number(prop.value);
      return Number.isFinite(n) ? n : (prop.value ?? null);
    }
    case 'boolean':
      return prop.value === 'true';
    case 'string':
      return prop.value ?? '';
    case 'undefined':
      return '[undefined]';
    default:
      return prop.value ?? prop.subtype ?? prop.type ?? null;
  }
}

/** auto-chrome-mcp fork: 손실 없는 preview를 CDP 왕복 없이 평범한 JS 값으로 복원한다 (fast path). */
function previewToValue(preview: RemoteObjectPreview): unknown {
  const props = preview.properties || [];

  if (preview.subtype === 'array' || preview.subtype === 'typedarray') {
    const arr: unknown[] = props.map(previewPropertyToValue);
    if (preview.overflow === true) arr.push(DEEP_SERIALIZE_TRUNCATION_MARKER);
    return arr;
  }

  if (preview.entries && preview.entries.length > 0) {
    const isMap = preview.subtype === 'map';
    if (isMap) {
      return {
        __type: 'Map',
        entries: preview.entries.map((e) => [
          e.key ? previewToValue(e.key) : null,
          e.value ? previewToValue(e.value) : null,
        ]),
        truncated: preview.overflow === true || undefined,
      };
    }
    return {
      __type: preview.subtype === 'set' ? 'Set' : 'Entries',
      values: preview.entries.map((e) => (e.value ? previewToValue(e.value) : null)),
      truncated: preview.overflow === true || undefined,
    };
  }

  const out: Record<string, unknown> = {};
  for (const prop of props) {
    out[prop.name] = previewPropertyToValue(prop);
  }
  if (preview.overflow === true) out[DEEP_SERIALIZE_TRUNCATION_MARKER] = true;
  if (preview.description && preview.description !== 'Object') out.__class = preview.description;
  return out;
}

/** auto-chrome-mcp fork: CDP 호출 없이 RemoteObject를 최선의 값으로 변환 (기존 fast path 유지) */
export function shallowSerializeRemoteObject(arg: unknown): unknown {
  const a = arg as RemoteObjectLike | null;
  if (!a || typeof a !== 'object') return arg;
  if (typeof a.unserializableValue === 'string') return a.unserializableValue;
  if ('value' in a) return a.value;
  if (a.preview) return previewToValue(a.preview);
  if (typeof a.description === 'string') return a.description;
  return `[${a.type || 'unknown'}]`;
}

/**
 * auto-chrome-mcp fork: 페이지 컨텍스트에서 실행되는 깊이 제한 직렬화기.
 * 재귀 walk로 평범한 구조를 만든 뒤 JSON.stringify 하며, 순환 참조는 WeakSet으로 끊는다.
 * 상한: depth=maxDepth, 레벨당 속성 maxProps개, 최종 JSON maxChars자(초과 시 marker로 절단).
 */
const DEEP_SERIALIZE_FUNCTION_DECLARATION = `function (maxDepth, maxProps, maxChars, marker) {
  var seen = new WeakSet();
  var budget = maxChars * 2;
  var used = 0;

  function label(v) {
    try {
      return (v && v.constructor && v.constructor.name) || 'Object';
    } catch (e) {
      return 'Object';
    }
  }

  function walk(v, d) {
    if (used > budget) return '[budget exceeded]';
    if (v === null) return null;
    var t = typeof v;
    if (t === 'undefined') return '[undefined]';
    if (t === 'boolean') { used += 5; return v; }
    if (t === 'number') { used += 8; return Number.isFinite(v) ? v : String(v); }
    if (t === 'bigint') { used += 12; return v.toString() + 'n'; }
    if (t === 'symbol') { used += 12; return String(v); }
    if (t === 'string') {
      used += v.length + 2;
      return v.length > maxChars ? v.slice(0, maxChars) + marker : v;
    }
    if (t === 'function') { used += 16; return '[Function' + (v.name ? ' ' + v.name : '') + ']'; }
    if (t !== 'object') { used += 8; return String(v); }

    if (seen.has(v)) return '[Circular]';
    if (d <= 0) {
      return Array.isArray(v)
        ? '[Array(' + v.length + ') ' + marker + ']'
        : '[' + label(v) + ' ' + marker + ']';
    }

    seen.add(v);
    try {
      if (v instanceof Date) { used += 26; return { __type: 'Date', value: v.toISOString() }; }
      if (v instanceof RegExp) { used += 16; return { __type: 'RegExp', value: String(v) }; }
      if (v instanceof Error) {
        used += 64;
        var err = {
          __type: 'Error',
          name: v.name,
          message: v.message,
          stack: typeof v.stack === 'string' ? v.stack.slice(0, maxChars) : undefined
        };
        var ekeys = Object.keys(v);
        for (var ei = 0; ei < ekeys.length && ei < maxProps; ei++) {
          try { err[ekeys[ei]] = walk(v[ekeys[ei]], d - 1); } catch (e) { err[ekeys[ei]] = '[getter threw]'; }
        }
        return err;
      }
      if (Array.isArray(v)) {
        var arr = [];
        for (var i = 0; i < v.length; i++) {
          if (i >= maxProps || used > budget) { arr.push(marker); break; }
          arr.push(walk(v[i], d - 1));
        }
        return arr;
      }
      if (typeof Map !== 'undefined' && v instanceof Map) {
        var mo = { __type: 'Map', size: v.size, entries: [] };
        var mc = 0;
        v.forEach(function (val, key) {
          if (mc++ >= maxProps || used > budget) return;
          mo.entries.push([walk(key, d - 1), walk(val, d - 1)]);
        });
        if (mc > maxProps) mo.truncated = true;
        return mo;
      }
      if (typeof Set !== 'undefined' && v instanceof Set) {
        var so = { __type: 'Set', size: v.size, values: [] };
        var sc = 0;
        v.forEach(function (val) {
          if (sc++ >= maxProps || used > budget) return;
          so.values.push(walk(val, d - 1));
        });
        if (sc > maxProps) so.truncated = true;
        return so;
      }
      if (typeof Node !== 'undefined' && v instanceof Node) {
        used += 32;
        return '[' + label(v) + ' ' + (v.nodeName || '') + ']';
      }
      if (ArrayBuffer.isView(v) && typeof v.length === 'number') {
        var tv = [];
        for (var ti = 0; ti < v.length && ti < maxProps; ti++) tv.push(v[ti]);
        used += tv.length * 4;
        return { __type: label(v), length: v.length, values: tv, truncated: v.length > maxProps };
      }

      var out = {};
      var keys;
      try { keys = Object.keys(v); } catch (e) { keys = []; }
      var n = 0;
      for (var k = 0; k < keys.length; k++) {
        if (n++ >= maxProps || used > budget) { out[marker] = true; break; }
        var key = keys[k];
        used += key.length + 3;
        try {
          out[key] = walk(v[key], d - 1);
        } catch (e) {
          out[key] = '[getter threw: ' + (e && e.message ? e.message : String(e)) + ']';
        }
      }
      var ctor = label(v);
      if (ctor && ctor !== 'Object') out.__class = ctor;
      return out;
    } finally {
      seen.delete(v);
    }
  }

  try {
    var built = walk(this, maxDepth);
    var json;
    try { json = JSON.stringify(built); } catch (e) { json = null; }
    if (typeof json !== 'string') {
      return { ok: false, error: '[unserializable: JSON.stringify failed]' };
    }
    var truncated = false;
    if (json.length > maxChars) {
      json = json.slice(0, maxChars) + marker;
      truncated = true;
    }
    return { ok: true, json: json, truncated: truncated };
  } catch (e) {
    return { ok: false, error: '[unserializable: ' + (e && e.message ? e.message : String(e)) + ']' };
  }
}`;

interface DeepSerializePayload {
  ok?: boolean;
  json?: string;
  truncated?: boolean;
  error?: string;
}

interface CallFunctionOnResponse {
  result?: { value?: DeepSerializePayload };
  exceptionDetails?: unknown;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`deep-serialize timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * auto-chrome-mcp fork: objectId를 Runtime.callFunctionOn 으로 깊게 직렬화한다.
 * best-effort — 객체 GC, 컨텍스트 파괴, 세션 detach 등 어떤 실패도 undefined를 반환하고
 * 호출부가 기존 shallow 결과를 그대로 쓰게 한다. 절대 예외를 던지지 않는다.
 */
export async function deepSerializeRemoteObject(
  tabId: number,
  objectId: string,
): Promise<unknown | undefined> {
  try {
    const resp = await withTimeout(
      cdpSessionManager.sendCommand<CallFunctionOnResponse>(tabId, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: DEEP_SERIALIZE_FUNCTION_DECLARATION,
        arguments: [
          { value: DEEP_SERIALIZE_MAX_DEPTH },
          { value: DEEP_SERIALIZE_MAX_PROPS_PER_LEVEL },
          { value: DEEP_SERIALIZE_MAX_JSON_CHARS },
          { value: DEEP_SERIALIZE_TRUNCATION_MARKER },
        ],
        silent: true,
        returnByValue: true,
        awaitPromise: false,
      }),
      DEEP_SERIALIZE_TIMEOUT_MS,
    );

    if (!resp || resp.exceptionDetails) return undefined;
    const payload = resp.result?.value;
    if (!payload || payload.ok !== true || typeof payload.json !== 'string') return undefined;
    // 절단된 JSON은 파싱할 수 없으므로 마커가 붙은 문자열 그대로 노출한다.
    if (payload.truncated === true) return payload.json;
    try {
      return JSON.parse(payload.json);
    } catch {
      return payload.json;
    }
  } catch {
    return undefined;
  }
}

/** auto-chrome-mcp fork: 깊은 직렬화 횟수 예산. take()가 false면 해당 인자는 shallow 결과로 남는다. */
export interface DeepSerializeBudget {
  take(): boolean;
}

/**
 * auto-chrome-mcp fork: snapshot 1회 실행용 예산.
 * 총 maxCalls회 + 전체 deadline(벽시계) 두 가지로 CDP 폭주와 툴 지연을 동시에 제한한다.
 */
export function createRunBudget(
  maxCalls: number = DEEP_SERIALIZE_MAX_PER_RUN,
  deadlineMs: number = DEEP_SERIALIZE_RUN_DEADLINE_MS,
): DeepSerializeBudget & { skipped: number } {
  let remaining = maxCalls;
  const expiresAt = Date.now() + deadlineMs;
  return {
    skipped: 0,
    take(): boolean {
      if (remaining <= 0 || Date.now() >= expiresAt) {
        this.skipped += 1;
        return false;
      }
      remaining -= 1;
      return true;
    },
  };
}

/**
 * auto-chrome-mcp fork: 콘솔 인자 배열을 직렬화한다.
 * 모든 인자는 CDP 왕복 없는 shallow 경로로 먼저 변환하고,
 * preview가 손실된 인자만 (메시지당 최대 DEEP_SERIALIZE_MAX_ARGS_PER_MESSAGE개,
 * 예산이 허용하는 범위에서) 깊은 직렬화 결과로 덮어쓴다.
 */
export async function buildSerializedConsoleArgs(
  tabId: number,
  rawArgs: unknown[],
  budget: DeepSerializeBudget,
): Promise<{ args: unknown[]; deepCount: number }> {
  const args = rawArgs.map(shallowSerializeRemoteObject);
  let deepCount = 0;

  const limit = Math.min(rawArgs.length, DEEP_SERIALIZE_MAX_ARGS_PER_MESSAGE);
  for (let i = 0; i < limit; i++) {
    const candidate = rawArgs[i] as RemoteObjectLike;
    if (!isLossyRemoteObject(candidate)) continue;
    if (!budget.take()) break;
    const deep = await deepSerializeRemoteObject(tabId, candidate.objectId as string);
    if (deep !== undefined) {
      args[i] = deep;
      deepCount += 1;
    }
  }

  return { args, deepCount };
}

function safeTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return Date.now();
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

class ConsoleBuffer {
  private buffers = new Map<number, TabConsoleBufferState>();
  private starting = new Map<number, Promise<void>>();
  private static instance: ConsoleBuffer | null = null;

  constructor() {
    if (ConsoleBuffer.instance) {
      return ConsoleBuffer.instance;
    }
    ConsoleBuffer.instance = this;

    chrome.debugger.onEvent.addListener(this.handleDebuggerEvent.bind(this));
    chrome.debugger.onDetach.addListener(this.handleDebuggerDetach.bind(this));
    chrome.tabs.onRemoved.addListener(this.handleTabRemoved.bind(this));
    chrome.tabs.onUpdated.addListener(this.handleTabUpdated.bind(this));
  }

  /**
   * 이 탭이 버퍼 모드로 수집 중인지 확인한다
   */
  isCapturing(tabId: number): boolean {
    return this.buffers.has(tabId);
  }

  /**
   * 이 탭의 버퍼 수집이 켜져 있게 한다
   */
  async ensureStarted(tabId: number): Promise<void> {
    if (this.buffers.has(tabId)) return;

    const existing = this.starting.get(tabId);
    if (existing) return existing;

    const promise = this.startCapture(tabId).finally(() => {
      this.starting.delete(tabId);
    });
    this.starting.set(tabId, promise);
    return promise;
  }

  /**
   * 이 탭의 버퍼를 비운다
   */
  clear(
    tabId: number,
    reason: string = 'manual',
  ): { clearedMessages: number; clearedExceptions: number } | null {
    const state = this.buffers.get(tabId);
    if (!state) return null;

    const clearedMessages = state.messages.length;
    const clearedExceptions = state.exceptions.length;

    state.messages.length = 0;
    state.exceptions.length = 0;
    state.droppedMessageCount = 0;
    state.droppedExceptionCount = 0;
    state.captureStartTime = Date.now();
    // auto-chrome-mcp fork: 깊은 직렬화 통계도 함께 초기화
    state.deepSkippedCount = 0;

    console.log(
      `ConsoleBuffer: Cleared buffer for tab ${tabId} (reason=${reason}). ` +
        `${clearedMessages} messages, ${clearedExceptions} exceptions.`,
    );

    return { clearedMessages, clearedExceptions };
  }

  /**
   * 이 탭의 버퍼 내용을 읽는다
   */
  read(tabId: number, options: ConsoleBufferReadOptions = {}): ConsoleBufferReadResult | null {
    const state = this.buffers.get(tabId);
    if (!state) return null;

    const { pattern, onlyErrors = false, limit, includeExceptions = true } = options;

    const totalBufferedMessages = state.messages.length;
    const totalBufferedExceptions = state.exceptions.length;

    // 메시지 거르기
    let messages = state.messages;
    if (onlyErrors) {
      messages = messages.filter((m) => isErrorLevel(m.level));
    }
    if (pattern) {
      messages = messages.filter((m) => matchesPattern(pattern, m.text || ''));
    }

    // 시간순 정렬
    messages = [...messages].sort((a, b) => a.timestamp - b.timestamp);

    // limit 적용
    let messageLimitReached = false;
    const normalizedLimit =
      typeof limit === 'number' && Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : null;
    if (normalizedLimit !== null && messages.length > normalizedLimit) {
      messageLimitReached = true;
      // 최신 메시지만 남긴다
      messages = messages.slice(messages.length - normalizedLimit);
    }

    // 예외 거르기
    let exceptions: BufferedConsoleException[] = [];
    if (includeExceptions) {
      exceptions = state.exceptions;
      if (pattern) {
        exceptions = exceptions.filter((e) => matchesPattern(pattern, e.text || ''));
      }
      exceptions = [...exceptions].sort((a, b) => a.timestamp - b.timestamp);
    }

    const now = Date.now();

    return {
      tabId,
      tabUrl: state.tabUrl,
      tabTitle: state.tabTitle,
      captureStartTime: state.captureStartTime,
      captureEndTime: now,
      totalDurationMs: now - state.captureStartTime,
      messages,
      exceptions,
      totalBufferedMessages,
      totalBufferedExceptions,
      messageCount: messages.length,
      exceptionCount: exceptions.length,
      messageLimitReached,
      droppedMessageCount: state.droppedMessageCount,
      droppedExceptionCount: state.droppedExceptionCount,
      deepSerializationSkipped: state.deepSkippedCount,
    };
  }

  private async startCapture(tabId: number): Promise<void> {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || '';
    const title = tab.title || '';
    const hostname = extractHostname(url);

    const state: TabConsoleBufferState = {
      tabId,
      tabUrl: url,
      tabTitle: title,
      hostname,
      captureStartTime: Date.now(),
      messages: [],
      exceptions: [],
      droppedMessageCount: 0,
      droppedExceptionCount: 0,
      deepWindowStart: Date.now(),
      deepWindowCount: 0,
      deepSkippedCount: 0,
    };

    this.buffers.set(tabId, state);

    try {
      await cdpSessionManager.attach(tabId, 'console-buffer');
      await cdpSessionManager.sendCommand(tabId, 'Runtime.enable');
      await cdpSessionManager.sendCommand(tabId, 'Log.enable');
    } catch (error) {
      this.buffers.delete(tabId);
      await cdpSessionManager.detach(tabId, 'console-buffer').catch(() => {});
      throw error;
    }
  }

  private handleTabRemoved(tabId: number): void {
    if (!this.buffers.has(tabId)) return;
    void this.stopCapture(tabId, 'tab_closed');
  }

  private handleTabUpdated(
    tabId: number,
    changeInfo: chrome.tabs.TabChangeInfo,
    tab: chrome.tabs.Tab,
  ): void {
    const state = this.buffers.get(tabId);
    if (!state) return;

    const nextUrl = changeInfo.url ?? tab.url;
    const nextTitle = tab.title;

    if (typeof nextUrl === 'string') {
      const nextHost = extractHostname(nextUrl);
      // 도메인이 바뀌면 버퍼를 비운다
      if (nextHost !== state.hostname) {
        this.clear(tabId, 'domain_changed');
        state.hostname = nextHost;
      }
      state.tabUrl = nextUrl;
    }

    if (typeof nextTitle === 'string') {
      state.tabTitle = nextTitle;
    }
  }

  private handleDebuggerDetach(source: chrome.debugger.Debuggee, reason: string): void {
    if (typeof source.tabId !== 'number') return;
    if (!this.buffers.has(source.tabId)) return;

    console.log(
      `ConsoleBuffer: Debugger detached from tab ${source.tabId} (reason=${reason}), cleaning up.`,
    );

    this.buffers.delete(source.tabId);
    this.starting.delete(source.tabId);
    cdpSessionManager.detach(source.tabId, 'console-buffer').catch(() => {});
  }

  private handleDebuggerEvent(
    source: chrome.debugger.Debuggee,
    method: string,
    params?: unknown,
  ): void {
    const tabId = source.tabId;
    if (typeof tabId !== 'number') return;

    const state = this.buffers.get(tabId);
    if (!state) return;

    const p = params as Record<string, unknown>;

    if (method === 'Log.entryAdded' && p?.entry) {
      const entry = p.entry as Record<string, unknown>;
      state.messages.push({
        timestamp: safeTimestamp(entry.timestamp),
        level: safeString(entry.level) || 'log',
        text: safeString(entry.text),
        source: safeString(entry.source),
        url: safeString(entry.url),
        lineNumber: safeNumber(entry.lineNumber),
        stackTrace: entry.stackTrace,
      });
      this.trimMessages(state);
      return;
    }

    if (method === 'Runtime.consoleAPICalled' && p) {
      const stackTrace = p.stackTrace as Record<string, unknown[]> | undefined;
      const callFrame = stackTrace?.callFrames?.[0] as Record<string, unknown> | undefined;
      const rawArgs = (p.args as unknown[]) || [];

      const message: BufferedConsoleMessage = {
        timestamp: safeTimestamp(p.timestamp),
        level: safeString(p.type) || 'log',
        text: formatConsoleArgs(rawArgs),
        source: 'console-api',
        url: safeString(callFrame?.url),
        lineNumber: safeNumber(callFrame?.lineNumber),
        stackTrace: stackTrace,
        // 안전한 미리보기만 저장한다. 메모리 누수를 막으려는 것이다
        args: rawArgs.map(extractArgPreview),
        // auto-chrome-mcp fork (upstream #215): extractArgPreview는 preview 필드를 통째로 버리므로
        // 손실 없는 객체까지 description("Object")만 남았다. CDP 왕복 없이 preview를 복원해
        // 즉시 채워 두고, 손실된 인자만 아래에서 비동기로 덮어쓴다.
        argsSerialized: rawArgs.map(shallowSerializeRemoteObject),
      };
      state.messages.push(message);
      this.trimMessages(state);
      // auto-chrome-mcp fork (upstream #215): objectId는 수집 시점에만 유효하고 버퍼는
      // 임의 시점에 읽히므로, 손실된 인자는 지금 깊이 직렬화해 메시지에 채워 넣는다.
      this.scheduleDeepSerialization(tabId, state, message, rawArgs);
      return;
    }

    if (method === 'Runtime.exceptionThrown' && p?.exceptionDetails) {
      const exceptionDetails = p.exceptionDetails as Record<string, unknown>;
      const exception = exceptionDetails.exception as Record<string, unknown> | undefined;
      state.exceptions.push({
        timestamp: Date.now(),
        text:
          safeString(exceptionDetails.text) ||
          safeString(exception?.description) ||
          'Unknown exception',
        url: safeString(exceptionDetails.url),
        lineNumber: safeNumber(exceptionDetails.lineNumber),
        columnNumber: safeNumber(exceptionDetails.columnNumber),
        stackTrace: exceptionDetails.stackTrace,
      });
      this.trimExceptions(state);
    }
  }

  /**
   * auto-chrome-mcp fork: tab별 슬라이딩 윈도우 예산(10초당 100회).
   * 로그 폭주 페이지에서 CDP 호출이 쏟아지는 것을 막고, 윈도우가 지나면 자동 회복된다.
   */
  private takeDeepBudget(state: TabConsoleBufferState): boolean {
    const now = Date.now();
    if (now - state.deepWindowStart >= DEEP_SERIALIZE_BUFFER_WINDOW_MS) {
      state.deepWindowStart = now;
      state.deepWindowCount = 0;
    }
    if (state.deepWindowCount >= DEEP_SERIALIZE_BUFFER_WINDOW_MAX) {
      state.deepSkippedCount += 1;
      return false;
    }
    state.deepWindowCount += 1;
    return true;
  }

  /**
   * auto-chrome-mcp fork (upstream #215): preview가 손실된 인자를 수집 시점에 깊이 직렬화한다.
   *
   * 왜 수집 시점인가:
   *  - 버퍼는 objectId를 일부러 버리므로(extractArgPreview, 렌더러 메모리 누수 방지)
   *    읽기 시점에는 되살릴 참조가 남아 있지 않다.
   *  - 버퍼는 롤링(최대 2000건)이라 읽히는 시점이 임의로 늦고, 그 사이 네비게이션/GC로
   *    실행 컨텍스트가 사라져 지연 직렬화는 대부분 실패한다.
   *  - read()는 동기 API라 지연 직렬화를 넣으려면 시그니처를 바꿔야 한다.
   * 이벤트 핸들러는 동기이므로 결과는 비동기로 채워 넣는다(메시지 객체를 그대로 변형).
   */
  private scheduleDeepSerialization(
    tabId: number,
    state: TabConsoleBufferState,
    message: BufferedConsoleMessage,
    rawArgs: unknown[],
  ): void {
    if (!rawArgs.length) return;

    const limit = Math.min(rawArgs.length, DEEP_SERIALIZE_MAX_ARGS_PER_MESSAGE);
    let hasLossyArg = false;
    for (let i = 0; i < limit; i++) {
      if (isLossyRemoteObject(rawArgs[i])) {
        hasLossyArg = true;
        break;
      }
    }
    if (!hasLossyArg) return;

    const budget: DeepSerializeBudget = { take: () => this.takeDeepBudget(state) };

    void buildSerializedConsoleArgs(tabId, rawArgs, budget)
      .then(({ args, deepCount }) => {
        if (deepCount === 0) return;
        // best-effort: 이미 trim 되어 버퍼에서 빠진 메시지를 변형해도 무해하다.
        message.argsSerialized = args;
        message.argsDeepSerializedCount = deepCount;
      })
      .catch(() => {
        // best-effort — 실패하면 shallow preview(args)가 그대로 남는다.
      });
  }

  private trimMessages(state: TabConsoleBufferState): void {
    const overflow = state.messages.length - DEFAULT_MAX_BUFFER_MESSAGES;
    if (overflow <= 0) return;
    state.messages.splice(0, overflow);
    state.droppedMessageCount += overflow;
  }

  private trimExceptions(state: TabConsoleBufferState): void {
    const overflow = state.exceptions.length - DEFAULT_MAX_BUFFER_EXCEPTIONS;
    if (overflow <= 0) return;
    state.exceptions.splice(0, overflow);
    state.droppedExceptionCount += overflow;
  }

  private async stopCapture(tabId: number, reason: string): Promise<void> {
    if (!this.buffers.has(tabId)) return;

    this.buffers.delete(tabId);
    this.starting.delete(tabId);

    try {
      await cdpSessionManager.sendCommand(tabId, 'Runtime.disable');
    } catch {
      // best effort
    }
    try {
      await cdpSessionManager.sendCommand(tabId, 'Log.disable');
    } catch {
      // best effort
    }
    await cdpSessionManager.detach(tabId, 'console-buffer').catch(() => {});
    console.log(`ConsoleBuffer: Stopped buffer for tab ${tabId} (reason=${reason}).`);
  }
}

export const consoleBuffer = new ConsoleBuffer();
