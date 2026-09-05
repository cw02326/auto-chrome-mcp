/**
 * auto-chrome-mcp fork: chrome_batch / chrome_shortcut step 간 값 전달 템플릿 엔진.
 *
 * 설계 계약: docs/plans/2026-09-04-batch-flow-design.md 1절·4절.
 * 크롬 API 에 의존하지 않는 순수 함수만 둔다 (단위 테스트에서 그대로 부를 수 있게).
 *
 * 핵심 규칙 요약.
 *   - 치환은 templates:true 이거나 새 흐름 키(as/when/stopIf/repeat/return/params)가
 *     하나라도 있을 때만 켜진다. v1 호출은 `{{...}}` 가 있어도 literal 로 넘어간다.
 *   - 문자열 전체가 토큰 하나면 원래 타입을 보존하고, 문자열 안 일부면 문자열로 끼운다.
 *   - 값이 없으면 조용히 빈 문자열로 넘어가지 않고 unresolved_reference 로 실패한다.
 *   - 꺼낸 객체·배열은 prototype 없는 deep clone 이라 도구 인자를 오염시키지 못한다.
 */

export type StepTemplateErrorCode =
  | 'unresolved_reference'
  | 'embedded_null'
  | 'forbidden_path_segment'
  | 'reference_too_large'
  | 'capture_too_large'
  | 'reserved_name'
  | 'duplicate_as'
  | 'invalid_as_name'
  | 'template_forbidden_key'
  | 'unknown_return_name';

/** 치환·캡처 단계에서 나는 오류 — 모델이 문구가 아니라 code 로 분기할 수 있게 고정한다. */
export class StepTemplateError extends Error {
  readonly code: StepTemplateErrorCode;

  constructor(code: StepTemplateErrorCode, message: string) {
    super(message);
    this.name = 'StepTemplateError';
    this.code = code;
  }
}

/** `as` 이름 규칙 (설계 1절). */
export const AS_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

/** 스코프 루트로 예약된 이름 — `as` 로 쓸 수 없다. */
export const RESERVED_CAPTURE_NAMES: ReadonlySet<string> = new Set(['params', 'prev', 'loop']);

/** 참조 하나가 치환된 뒤 허용되는 최대 길이. */
export const MAX_REFERENCE_CHARS = 20_000;

/** ephemeral `prev` 본문 상한 (UTF-8 byte). 넘으면 본문만 비우고 step 은 살린다. */
export const MAX_PREV_CAPTURE_BYTES = 64 * 1024;

/** `as` 한 건의 상한 (UTF-8 byte). 넘으면 그 step 을 capture_too_large 로 실패시킨다. */
export const MAX_NAMED_CAPTURE_BYTES = 64 * 1024;

/** 한 호출에서 `as` 로 모을 수 있는 총량 (UTF-8 byte). */
export const MAX_TOTAL_CAPTURE_BYTES = 256 * 1024;

/** path 세그먼트로 쓸 수 없는 이름 — prototype 오염 경로를 원천 차단한다. */
const FORBIDDEN_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);

/**
 * step `args` 의 **키 이름**으로도 쓸 수 없는 이름 (2026-09-04 Codex 최종 검토 항목 1).
 *
 * 재현: `{"__proto__": "{{params.target}}"}` 에 `{ tabId: 123 }` 을 치환하면, 치환기가
 * `out.__proto__ = value` 로 대입하는 순간 **대입이 아니라 prototype 교체**가 된다.
 * 그러면 `Object.keys(out)` 은 비어 있어 2차 금지 키 검사가 아무것도 못 보고,
 * `delete out.tabId` 로도 안 지워지며, 게이트의 `args?.tabId` 는 상속된 123 을 읽는다.
 * 곧 사용자 탭을 지정하는 게이트 우회다.
 *
 * 그래서 이 세 이름은 치환 여부와 무관하게 args 키로 오면 입력 단계에서 거절한다.
 * 어떤 도구도 이 이름의 인자를 받지 않으므로 잃는 기능이 없다.
 */
const FORBIDDEN_ARG_KEY_NAMES: ReadonlySet<string> = FORBIDDEN_PATH_SEGMENTS;

/** `$` 접두 메타 키 — 실제 JSON 에 같은 키가 있어도 메타가 이긴다. */
const META_KEYS: ReadonlySet<string> = new Set(['$ok', '$text', '$error']);

/**
 * 치환을 켜는 흐름 키. `when`/`stopIf`/`repeat` 은 batch-runner 가 실제로 해석해 실행한다.
 * 활성화 판정은 설계 1절대로 이 목록 전체를 본다.
 */
export const STEP_FLOW_KEYS = ['as', 'when', 'stopIf', 'repeat'] as const;
export const TOP_LEVEL_FLOW_KEYS = ['return', 'params'] as const;

/**
 * 토큰 정규식 (sticky). 설계 1절 정규식에서 점 세그먼트에 `$` 를 더했다.
 * 설계가 같은 절에서 `{{name.$ok}}` 메타를 요구하는데 원문 문자 클래스
 * `[A-Za-z0-9_-]+` 로는 `$ok` 가 매칭되지 않기 때문이다 (구현 보고서에 기록).
 */
const TOKEN_RE = /\{\{[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z0-9_$-]+|\[(?:0|[1-9][0-9]*|-1)\])*\}\}/y;

interface PathSegment {
  kind: 'key' | 'index';
  key?: string;
  index?: number;
}

interface ParsedToken {
  raw: string;
  name: string;
  path: PathSegment[];
}

type Piece = { kind: 'text'; text: string } | { kind: 'token'; token: ParsedToken };

/** 도구 실행 결과 한 건의 캡처본. */
export interface StepCapture {
  ok: boolean;
  /** 실패 시 오류 문구, 성공이면 null. */
  error: string | null;
  /** 첫 `type:"text"` 블록 원문 (표시용으로 자르기 전). 본문을 비웠으면 undefined. */
  text?: string;
  /** text 를 JSON.parse 한 값. 실패하면 raw 문자열. 본문을 비웠으면 undefined. */
  value?: unknown;
  /** JSON.parse 성공 여부. */
  parsed: boolean;
  /** prev 상한을 넘어 본문을 비웠는가. */
  bodyOmitted?: boolean;
  /** 캡처 원문의 UTF-8 byte 길이. */
  bytes: number;
}

/** 치환이 참조하는 스코프. */
export interface TemplateScope {
  named: Map<string, StepCapture>;
  prev?: StepCapture;
  /** repeat 회차 정보. batch-runner 가 회차마다 채우고 묶음이 끝나면 되돌린다. */
  loop?: { index: number; count: number };
  /** shortcut 호출 인자. batch-runner 가 params 가 있을 때 채운다. */
  params?: Record<string, unknown>;
}

export function createTemplateScope(): TemplateScope {
  return { named: new Map<string, StepCapture>() };
}

const textEncoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).length;
}

/* ------------------------------------------------------------------ *
 * 활성화 판정
 * ------------------------------------------------------------------ */

function hasOwn(target: unknown, key: string): boolean {
  return (
    typeof target === 'object' &&
    target !== null &&
    Object.prototype.hasOwnProperty.call(target, key)
  );
}

/** step 하나(또는 repeat 묶음)가 흐름 키를 갖고 있는가. 묶음 안쪽까지 본다. */
function stepHasFlowKey(step: unknown): boolean {
  if (typeof step !== 'object' || step === null) return false;
  for (const key of STEP_FLOW_KEYS) {
    if (hasOwn(step, key)) return true;
  }
  const nested = (step as any).steps;
  if (Array.isArray(nested)) {
    return nested.some((child) => stepHasFlowKey(child));
  }
  return false;
}

/**
 * 이 호출에서 치환기를 켜는가 (설계 1절 "활성화 규칙").
 * 새 키가 하나도 없으면 v1 호출이므로 `{{...}}` 를 literal 로 둔다.
 */
export function areTemplatesActive(params: unknown): boolean {
  if (typeof params !== 'object' || params === null) return false;
  if ((params as any).templates === true) return true;
  for (const key of TOP_LEVEL_FLOW_KEYS) {
    if ((params as any)[key] !== undefined) return true;
  }
  const steps = (params as any).steps;
  if (Array.isArray(steps)) {
    return steps.some((step) => stepHasFlowKey(step));
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 토큰 파싱
 * ------------------------------------------------------------------ */

function parseTokenText(raw: string): ParsedToken {
  const inner = raw.slice(2, -2);
  let i = 0;
  let name = '';
  while (i < inner.length && /[A-Za-z0-9_$]/.test(inner[i])) {
    name += inner[i];
    i++;
  }
  const path: PathSegment[] = [];
  while (i < inner.length) {
    if (inner[i] === '.') {
      i++;
      let key = '';
      while (i < inner.length && /[A-Za-z0-9_$-]/.test(inner[i])) {
        key += inner[i];
        i++;
      }
      path.push({ kind: 'key', key });
    } else if (inner[i] === '[') {
      i++;
      let digits = '';
      while (i < inner.length && inner[i] !== ']') {
        digits += inner[i];
        i++;
      }
      i++; // ']'
      path.push({ kind: 'index', index: Number(digits) });
    } else {
      i++;
    }
  }
  return { raw, name, path };
}

/**
 * 문자열을 텍스트 조각과 토큰으로 쪼갠다.
 *
 * 이스케이프: `{{` 바로 앞 백슬래시 연속 n 개는 n/2 개로 접히고, n 이 홀수면 `{{` 를
 * literal 로 둔다. 설계 8절 체크리스트 5 의 두 결과("백슬래시 1개 + `{{`" → `{{`,
 * "백슬래시 2개 + `{{a}}`" → 백슬래시 1개 + 치환값)를 둘 다 만족하는 규칙이다.
 */
export function splitTemplateString(input: string): Piece[] {
  const pieces: Piece[] = [];
  let cursor = 0;
  let pending = '';

  const pushText = (text: string) => {
    if (text) pending += text;
  };
  const flush = () => {
    if (pending) {
      pieces.push({ kind: 'text', text: pending });
      pending = '';
    }
  };

  while (cursor < input.length) {
    const open = input.indexOf('{{', cursor);
    if (open === -1) {
      pushText(input.slice(cursor));
      break;
    }

    let slashStart = open;
    while (slashStart > cursor && input[slashStart - 1] === '\\') slashStart--;
    const slashCount = open - slashStart;

    pushText(input.slice(cursor, slashStart));
    pushText('\\'.repeat(Math.floor(slashCount / 2)));

    if (slashCount % 2 === 1) {
      pushText('{{');
      cursor = open + 2;
      continue;
    }

    TOKEN_RE.lastIndex = open;
    const match = TOKEN_RE.exec(input);
    if (match && match.index === open) {
      flush();
      pieces.push({ kind: 'token', token: parseTokenText(match[0]) });
      cursor = open + match[0].length;
    } else {
      // malformed 토큰은 literal 로 둔다.
      pushText('{{');
      cursor = open + 2;
    }
  }

  flush();
  return pieces;
}

/* ------------------------------------------------------------------ *
 * 값 꺼내기
 * ------------------------------------------------------------------ */

/** prototype 없는 deep clone — 페이지에서 온 JSON 이 도구 인자를 오염시키지 못하게 한다. */
export function protoFreeClone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => protoFreeClone(item));
  if (value !== null && typeof value === 'object') {
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value as Record<string, unknown>)) {
      Object.defineProperty(out, key, {
        value: protoFreeClone((value as Record<string, unknown>)[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

const MISSING = Symbol('missing');

function navigate(base: unknown, path: PathSegment[]): unknown | typeof MISSING {
  let current: unknown = base;
  for (const segment of path) {
    if (current === null || current === undefined) return MISSING;
    if (segment.kind === 'index') {
      if (!Array.isArray(current)) return MISSING;
      const index = segment.index! < 0 ? current.length + segment.index! : segment.index!;
      if (index < 0 || index >= current.length) return MISSING;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return MISSING;
    if (!Object.prototype.hasOwnProperty.call(current, segment.key!)) return MISSING;
    current = (current as Record<string, unknown>)[segment.key!];
  }
  return current;
}

function assertPathAllowed(token: ParsedToken): void {
  for (const segment of token.path) {
    if (segment.kind === 'key' && FORBIDDEN_PATH_SEGMENTS.has(segment.key!)) {
      throw new StepTemplateError(
        'forbidden_path_segment',
        `forbidden_path_segment: "${segment.key}" cannot be used in ${token.raw}`,
      );
    }
  }
}

function unresolved(token: ParsedToken): StepTemplateError {
  return new StepTemplateError(
    'unresolved_reference',
    `unresolved_reference: ${token.raw} did not resolve to a value`,
  );
}

/** 토큰 하나를 실제 값으로 바꾼다. 값이 없으면 unresolved_reference 를 던진다. */
export function resolveToken(token: ParsedToken, scope: TemplateScope): unknown {
  assertPathAllowed(token);

  if (token.name === 'loop') {
    if (!scope.loop) throw unresolved(token);
    const value = navigate(scope.loop, token.path);
    if (value === MISSING || value === undefined) throw unresolved(token);
    return protoFreeClone(value);
  }

  if (token.name === 'params') {
    if (!scope.params) throw unresolved(token);
    const value = navigate(scope.params, token.path);
    if (value === MISSING || value === undefined) throw unresolved(token);
    return protoFreeClone(value);
  }

  const capture = token.name === 'prev' ? scope.prev : scope.named.get(token.name);
  if (!capture) throw unresolved(token);

  let base: unknown;
  let rest = token.path;

  const first = token.path[0];
  if (first && first.kind === 'key' && META_KEYS.has(first.key!)) {
    rest = token.path.slice(1);
    if (first.key === '$ok') base = capture.ok;
    else if (first.key === '$error') base = capture.error;
    else {
      // $text: 본문을 비운 캡처는 원문이 없다.
      if (capture.bodyOmitted) throw unresolved(token);
      if (capture.text === undefined) throw unresolved(token);
      base = capture.text;
    }
  } else {
    if (capture.bodyOmitted || capture.value === undefined) throw unresolved(token);
    if (rest.length > 0 && !capture.parsed) {
      // JSON 이 아닌 결과는 루트 문자열만 참조할 수 있다.
      throw unresolved(token);
    }
    base = capture.value;
  }

  const value = navigate(base, rest);
  if (value === MISSING || value === undefined) throw unresolved(token);
  return protoFreeClone(value);
}

function referenceLength(value: unknown): number {
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function assertReferenceSize(token: ParsedToken, length: number): void {
  if (length > MAX_REFERENCE_CHARS) {
    throw new StepTemplateError(
      'reference_too_large',
      `reference_too_large: ${token.raw} expands to ${length} characters (limit ${MAX_REFERENCE_CHARS})`,
    );
  }
}

/** 끼움 치환에서 값을 문자열로 만든다. null 은 조용히 넘기지 않고 오류다. */
function stringifyEmbedded(token: ParsedToken, value: unknown): string {
  if (value === null) {
    throw new StepTemplateError(
      'embedded_null',
      `embedded_null: ${token.raw} is null and cannot be embedded in a string`,
    );
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '';
}

/* ------------------------------------------------------------------ *
 * 치환
 * ------------------------------------------------------------------ */

/** 치환으로 새로 만들어진 객체·배열 — 치환 후 금지 키 재검사가 이 표시를 본다. */
export type InjectedMarks = WeakSet<object>;

function markInjected(value: unknown, marks: InjectedMarks): void {
  if (Array.isArray(value)) {
    marks.add(value);
    for (const item of value) markInjected(item, marks);
    return;
  }
  if (value !== null && typeof value === 'object') {
    marks.add(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      markInjected((value as Record<string, unknown>)[key], marks);
    }
  }
}

function substituteString(input: string, scope: TemplateScope, marks: InjectedMarks): unknown {
  const pieces = splitTemplateString(input);
  if (pieces.length === 0) return input;

  // 통째 치환: 문자열 전체가 토큰 하나면 원래 타입을 그대로 살린다.
  if (pieces.length === 1 && pieces[0].kind === 'token') {
    const token = pieces[0].token;
    const value = resolveToken(token, scope);
    assertReferenceSize(token, referenceLength(value));
    markInjected(value, marks);
    return value;
  }

  let out = '';
  for (const piece of pieces) {
    if (piece.kind === 'text') {
      out += piece.text;
      continue;
    }
    const value = resolveToken(piece.token, scope);
    const text = stringifyEmbedded(piece.token, value);
    assertReferenceSize(piece.token, text.length);
    out += text;
  }
  return out;
}

/**
 * args 안의 모든 문자열 값에 치환을 재귀 적용한다.
 * 키 이름은 치환하지 않으며, 치환된 결과는 다시 스캔하지 않는다(단일 패스).
 */
export function substituteArgs(
  args: Record<string, unknown>,
  scope: TemplateScope,
  marks: InjectedMarks,
): Record<string, unknown> {
  return substituteContainer(args, scope, marks) as Record<string, unknown>;
}

function substituteContainer(value: unknown, scope: TemplateScope, marks: InjectedMarks): unknown {
  if (typeof value === 'string') return substituteString(value, scope, marks);
  if (Array.isArray(value)) return value.map((item) => substituteContainer(item, scope, marks));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      // `out[key] = ...` 로 대입하면 key 가 "__proto__" 일 때 대입이 아니라 prototype
      // 교체가 된다 (항목 1). defineProperty 는 언제나 own 데이터 속성을 만든다.
      Object.defineProperty(out, key, {
        value: substituteContainer((value as Record<string, unknown>)[key], scope, marks),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * 금지 키 2중 검사 (설계 4절)
 * ------------------------------------------------------------------ */

/** 도구와 무관하게 항상 치환을 막는 대상 지정 키. */
export const ALWAYS_FORBIDDEN_TEMPLATE_KEYS: ReadonlySet<string> = new Set([
  'tabId',
  'tabIds',
  'windowId',
  '_mcpSessionId',
  'lane',
]);

function forbiddenKeyError(key: string): StepTemplateError {
  return new StepTemplateError(
    'template_forbidden_key',
    `template_forbidden_key: "${key}" selects the target tab and cannot come from a template`,
  );
}

function subtreeHasTemplate(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('{{');
  if (Array.isArray(value)) return value.some((item) => subtreeHasTemplate(item));
  if (value !== null && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).some((key) =>
      subtreeHasTemplate((value as Record<string, unknown>)[key]),
    );
  }
  return false;
}

/**
 * 1차 검사: 치환 전 원본 args 에서 금지 키의 값에 `{{` 가 들어 있으면 거절한다.
 * 중첩 깊이와 무관하게 같은 이름이면 잡는다 (chrome_userscript 의 args.tabId 등).
 */
export function assertNoTemplatedForbiddenKeys(
  args: unknown,
  forbidden: ReadonlySet<string>,
): void {
  if (Array.isArray(args)) {
    for (const item of args) assertNoTemplatedForbiddenKeys(item, forbidden);
    return;
  }
  if (args === null || typeof args !== 'object') return;
  for (const key of Object.keys(args as Record<string, unknown>)) {
    const value = (args as Record<string, unknown>)[key];
    if (forbidden.has(key) && subtreeHasTemplate(value)) throw forbiddenKeyError(key);
    assertNoTemplatedForbiddenKeys(value, forbidden);
  }
}

/**
 * 0차 검사: args 의 **키 이름** 자체가 prototype 을 건드릴 수 있는지 본다 (항목 1).
 * 중첩 깊이·치환 여부와 무관하게 같은 이름이면 잡는다.
 */
export function assertNoDangerousArgKeys(args: unknown): void {
  if (Array.isArray(args)) {
    for (const item of args) assertNoDangerousArgKeys(item);
    return;
  }
  if (args === null || typeof args !== 'object') return;
  for (const key of Object.keys(args as Record<string, unknown>)) {
    if (FORBIDDEN_ARG_KEY_NAMES.has(key)) {
      throw new StepTemplateError(
        'forbidden_path_segment',
        `forbidden_path_segment: "${key}" cannot be used as an argument name`,
      );
    }
    assertNoDangerousArgKeys((args as Record<string, unknown>)[key]);
  }
}

/**
 * 도구 호출 직전 검사 (항목 1-b): args 트리의 모든 객체가 **평범한 모양** 인지 본다.
 *
 * - 객체의 prototype 은 `null` 이거나 `Object.prototype` 이어야 한다. 그 밖의 prototype 은
 *   상속으로 `tabId`·`url` 같은 대상 지정 키를 몰래 실어 나를 수 있다(게이트는 own 여부를
 *   따지지 않고 `args?.tabId` 로 읽는다).
 * - 상속된 금지 키가 실제로 보이면 own-property 기준으로도 확인해 함께 잡는다.
 *
 * 걸리면 `template_forbidden_key` 로 그 step 을 실패시킨다.
 */
export function assertPlainArgsShape(args: unknown, forbidden: ReadonlySet<string>): void {
  if (Array.isArray(args)) {
    for (const item of args) assertPlainArgsShape(item, forbidden);
    return;
  }
  if (args === null || typeof args !== 'object') return;
  const proto = Object.getPrototypeOf(args);
  if (proto !== null && proto !== Object.prototype) {
    throw forbiddenKeyError('__proto__');
  }
  for (const key of forbidden) {
    // own 이 아닌데 값이 보이면 상속이다 — 위 prototype 검사에서 이미 걸렸어야 한다.
    if (
      !Object.prototype.hasOwnProperty.call(args, key) &&
      (args as Record<string, unknown>)[key] !== undefined
    ) {
      throw forbiddenKeyError(key);
    }
  }
  for (const key of Object.keys(args as Record<string, unknown>)) {
    assertPlainArgsShape((args as Record<string, unknown>)[key], forbidden);
  }
}

/**
 * 2차 검사: 치환 후 전체 args 를 다시 순회해, 치환으로 생성된 subtree 안의 금지 키를 잡는다.
 * literal 로 원래 있던 키는 건드리지 않는다 (batch 의 literal tabId 는 지금과 같이 통과).
 */
export function assertNoInjectedForbiddenKeys(
  args: unknown,
  marks: InjectedMarks,
  forbidden: ReadonlySet<string>,
  insideInjected = false,
): void {
  if (Array.isArray(args)) {
    const inside = insideInjected || marks.has(args);
    for (const item of args) assertNoInjectedForbiddenKeys(item, marks, forbidden, inside);
    return;
  }
  if (args === null || typeof args !== 'object') return;
  const inside = insideInjected || marks.has(args);
  for (const key of Object.keys(args as Record<string, unknown>)) {
    if (inside && forbidden.has(key)) throw forbiddenKeyError(key);
    assertNoInjectedForbiddenKeys((args as Record<string, unknown>)[key], marks, forbidden, inside);
  }
}

/* ------------------------------------------------------------------ *
 * 결과 캡처
 * ------------------------------------------------------------------ */

/** 결과 content 의 첫 `type:"text"` 블록 원문 (표시용 자르기 전). */
export function firstTextBlock(result: unknown): string | undefined {
  const content = Array.isArray((result as any)?.content) ? (result as any).content : null;
  if (!content) return undefined;
  for (const item of content) {
    if (item?.type === 'text' && typeof item.text === 'string') return item.text;
  }
  return undefined;
}

/** 도구 결과 하나를 캡처본으로 만든다. */
export function buildCapture(result: unknown, ok: boolean, error: string | null): StepCapture {
  const text = firstTextBlock(result);
  if (text === undefined) {
    return { ok, error, parsed: false, bytes: 0 };
  }
  let value: unknown = text;
  let parsed = false;
  try {
    value = JSON.parse(text);
    parsed = true;
  } catch {
    value = text;
    parsed = false;
  }
  return { ok, error, text, value, parsed, bytes: utf8ByteLength(text) };
}

/** ephemeral prev 용 캡처 — 상한을 넘으면 본문만 비우고 메타는 남긴다. */
export function toPrevCapture(capture: StepCapture): StepCapture {
  if (capture.bytes <= MAX_PREV_CAPTURE_BYTES) return capture;
  return {
    ok: capture.ok,
    error: capture.error,
    parsed: false,
    bytes: capture.bytes,
    bodyOmitted: true,
  };
}

/** `as` 캡처 상한 검사. 넘으면 그 step 을 실패시킨다 (반쯤 자른 값으로 다음 step 을 돌리지 않는다). */
export function assertCaptureFits(name: string, capture: StepCapture, totalBytes: number): void {
  if (capture.bytes > MAX_NAMED_CAPTURE_BYTES) {
    throw new StepTemplateError(
      'capture_too_large',
      `capture_too_large: "${name}" is ${capture.bytes} bytes (limit ${MAX_NAMED_CAPTURE_BYTES} per step)`,
    );
  }
  if (totalBytes + capture.bytes > MAX_TOTAL_CAPTURE_BYTES) {
    throw new StepTemplateError(
      'capture_too_large',
      `capture_too_large: captured values would reach ${totalBytes + capture.bytes} bytes (limit ${MAX_TOTAL_CAPTURE_BYTES} per call)`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * 이름 검증
 * ------------------------------------------------------------------ */

/** `as` 이름 하나를 검증한다. 문제가 있으면 오류를 던진다. */
export function assertValidCaptureName(name: unknown, seen: Set<string>): string {
  if (typeof name !== 'string' || !AS_NAME_PATTERN.test(name)) {
    throw new StepTemplateError(
      'invalid_as_name',
      `invalid_as_name: "as" must match [A-Za-z_][A-Za-z0-9_]{0,31}`,
    );
  }
  if (RESERVED_CAPTURE_NAMES.has(name)) {
    throw new StepTemplateError(
      'reserved_name',
      `reserved_name: "${name}" cannot be used as a name`,
    );
  }
  if (seen.has(name)) {
    throw new StepTemplateError('duplicate_as', `duplicate_as: "${name}" is used more than once`);
  }
  seen.add(name);
  return name;
}

/* ------------------------------------------------------------------ *
 * 경로 해석 (조건 평가기용) 과 params 참조 수집
 * ------------------------------------------------------------------ */

/** `resolvePathValue` 결과. `found:false` 면 `value` 는 보지 않는다. */
export interface PathResolution {
  found: boolean;
  value?: unknown;
}

/**
 * `{{ }}` 없이 쓰는 조건 `path` 하나를 값으로 바꾼다 (설계 2절).
 *
 * 토큰 문법·메타 키·스코프 규칙을 치환기와 그대로 공유하려고, 안쪽에서 `{{path}}` 를
 * 만들어 같은 파서를 태운다. 문법이 어긋나면 값이 없는 것으로 본다.
 * 금지 세그먼트(`__proto__` 등)만 예외로 던진다 - 조용히 넘기면 판정이 뒤집힌다.
 */
export function resolvePathValue(path: string, scope: TemplateScope): PathResolution {
  if (typeof path !== 'string' || path.length === 0) return { found: false };
  const pieces = splitTemplateString(`{{${path}}}`);
  if (pieces.length !== 1 || pieces[0].kind !== 'token') return { found: false };
  try {
    return { found: true, value: resolveToken(pieces[0].token, scope) };
  } catch (error) {
    if (error instanceof StepTemplateError && error.code === 'unresolved_reference') {
      return { found: false };
    }
    throw error;
  }
}

/** 문자열·객체·배열 안의 `{{params.x}}` 에서 x 를 모은다 (shortcut 저장 시 선언 대조용). */
export function collectParamNames(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    for (const piece of splitTemplateString(value)) {
      if (piece.kind !== 'token' || piece.token.name !== 'params') continue;
      const first = piece.token.path[0];
      if (first && first.kind === 'key' && first.key) out.add(first.key);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectParamNames(item, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      collectParamNames((value as Record<string, unknown>)[key], out);
    }
  }
}

/** 조건 `path` 문자열이 `params.x` 를 가리키면 x 를, 아니면 null 을 돌려준다. */
export function paramNameFromPath(path: unknown): string | null {
  if (typeof path !== 'string' || path.length === 0) return null;
  const pieces = splitTemplateString(`{{${path}}}`);
  if (pieces.length !== 1 || pieces[0].kind !== 'token') return null;
  const token = pieces[0].token;
  if (token.name !== 'params') return null;
  const first = token.path[0];
  return first && first.kind === 'key' && first.key ? first.key : null;
}
