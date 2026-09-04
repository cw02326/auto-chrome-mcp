/**
 * batch/shortcut 흐름 제어의 조건식 검증기와 평가기.
 * 설계: `docs/plans/2026-09-04-batch-flow-design.md` 2절 (조건, 반복, 종료).
 *
 * 조건은 문자열 표현식이 아니라 JSON 객체다. 파서가 없으니 임의 코드 실행 경로도 없다.
 * 이 모듈은 순수 함수만 두며 chrome API 를 쓰지 않는다. 반복(repeat) 의 실행 의미와
 * `when`, `stopIf` 의 적용은 실행기(batch-runner) 몫이고, 여기서는 판정만 한다.
 *
 * 두 가지 계약이 중요하다.
 *
 * 1. **경로 해석은 주입한다.** `evaluateCondition` 은 `resolve(path)` 콜백으로만 값을 읽는다.
 *    `{{...}}` 토큰 문법, `$ok`/`$text`/`$error` 메타, `__proto__` 같은 금지 세그먼트 판정은
 *    전부 템플릿 엔진(`utils/step-template.ts`) 담당이다. 여기서는 `{ found, value }` 만 본다.
 * 2. **`value` 는 이미 치환된 값이다.** 조건의 `value` 에 `"{{b.y}}"` 처럼 템플릿 문자열을 쓸 수
 *    있지만, 치환은 호출자가 평가 전에 끝내고 그 결과를 넣어 이 함수를 부른다. 이 모듈은
 *    템플릿을 해석하지 않으므로 남아 있는 `{{...}}` 는 그냥 리터럴 문자열로 비교된다.
 */

/** 문서 2절 표에 있는 연산자 집합. 정규식 연산자는 두지 않는다(ReDoS 와 엔진 차이). */
export const CONDITION_OPERATORS = [
  'exists',
  'notExists',
  'empty',
  'notEmpty',
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/** `value` 를 반드시 함께 받아야 하는 연산자. 나머지는 `value` 를 받으면 거절한다. */
const VALUE_OPERATORS: ReadonlySet<string> = new Set([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
]);

const NUMERIC_OPERATORS: ReadonlySet<string> = new Set(['gt', 'gte', 'lt', 'lte']);

const OPERATOR_SET: ReadonlySet<string> = new Set(CONDITION_OPERATORS);

const GROUP_KEYS = ['all', 'any', 'not'] as const;
type GroupKey = (typeof GROUP_KEYS)[number];

const LEAF_KEYS = ['path', 'op', 'value'] as const;

const KNOWN_KEYS: ReadonlySet<string> = new Set<string>([...GROUP_KEYS, ...LEAF_KEYS]);

/** 트리 깊이 상한. 루트 노드가 깊이 1이다. */
export const MAX_CONDITION_DEPTH = 8;

/** 트리 전체 노드 수 상한(leaf 와 all/any/not 묶음을 모두 센다). */
export const MAX_CONDITION_NODES = 64;

/** 오류 메시지에 경로를 실을 때의 길이 상한. */
const MAX_PATH_IN_MESSAGE = 120;

export interface ConditionLeaf {
  path: string;
  op: ConditionOperator;
  value?: unknown;
}

export interface ConditionAll {
  all: ConditionNode[];
}

export interface ConditionAny {
  any: ConditionNode[];
}

export interface ConditionNot {
  not: ConditionNode;
}

export type ConditionNode = ConditionLeaf | ConditionAll | ConditionAny | ConditionNot;

export type ConditionValidationCode =
  | 'condition_invalid'
  | 'condition_too_deep'
  | 'condition_too_large'
  | 'unknown_operator';

export type ConditionEvaluationCode = 'condition_unresolved' | 'condition_invalid';

export type ConditionValidationResult =
  | { ok: true }
  | { ok: false; code: ConditionValidationCode; message: string };

export type ConditionEvaluationResult =
  | { ok: true; value: boolean }
  | { ok: false; code: ConditionEvaluationCode; message: string };

/** 경로 해석 결과. `found: false` 면 `value` 는 보지 않는다. */
export interface ConditionPathResolution {
  found: boolean;
  value?: unknown;
}

/**
 * 경로 하나를 값으로 바꾸는 콜백. 템플릿 엔진이 제공한다.
 * 던지지 않아야 한다(던지면 그대로 호출자에게 전파된다).
 */
export type ConditionPathResolver = (path: string) => ConditionPathResolution;

/**
 * 응답에 실을 코드로 바꾼다. 검수 체크리스트 10c 는 `op: "matches"` 를 `condition_invalid` 로
 * 돌려주길 요구하므로, 내부 진단용 `unknown_operator` 는 표면에서 `condition_invalid` 가 된다.
 */
export function surfaceConditionCode(
  code: ConditionValidationCode | ConditionEvaluationCode,
): 'condition_invalid' | 'condition_too_deep' | 'condition_too_large' | 'condition_unresolved' {
  return code === 'unknown_operator' ? 'condition_invalid' : code;
}

function invalid(message: string): ConditionValidationResult {
  return { ok: false, code: 'condition_invalid', message };
}

function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** own property 만 읽는다. getter 는 호출하지 않는다(페이지에서 온 값일 수 있다). */
function readOwn(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return undefined;
  return 'value' in descriptor ? descriptor.value : undefined;
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function describePath(path: string): string {
  return path.length > MAX_PATH_IN_MESSAGE ? `${path.slice(0, MAX_PATH_IN_MESSAGE)}...` : path;
}

function findGroupKey(keys: string[]): GroupKey | null {
  for (const key of keys) {
    if (key === 'all' || key === 'any' || key === 'not') return key;
  }
  return null;
}

interface WalkBudget {
  nodes: number;
}

function validateNode(node: unknown, depth: number, budget: WalkBudget): ConditionValidationResult {
  if (depth > MAX_CONDITION_DEPTH) {
    return {
      ok: false,
      code: 'condition_too_deep',
      message: `condition is nested deeper than ${MAX_CONDITION_DEPTH} levels`,
    };
  }

  budget.nodes += 1;
  if (budget.nodes > MAX_CONDITION_NODES) {
    return {
      ok: false,
      code: 'condition_too_large',
      message: `condition has more than ${MAX_CONDITION_NODES} nodes`,
    };
  }

  if (!isRecord(node)) {
    return invalid('condition must be an object with one form: leaf, all, any or not');
  }

  const keys = Object.keys(node);
  if (keys.length === 0) {
    return invalid('condition must be an object with one form: leaf, all, any or not');
  }

  for (const key of keys) {
    if (!KNOWN_KEYS.has(key)) {
      return invalid(`unknown condition key: ${key}`);
    }
  }

  const groupKeys = keys.filter((key) => key === 'all' || key === 'any' || key === 'not');
  const leafKeys = keys.filter((key) => key === 'path' || key === 'op' || key === 'value');

  if (groupKeys.length > 1) {
    return invalid(`condition must use only one of all, any or not, got: ${groupKeys.join(', ')}`);
  }
  if (groupKeys.length === 1 && leafKeys.length > 0) {
    return invalid(
      `condition must be either a leaf (path, op) or one of all, any, not, not both: ${keys.join(', ')}`,
    );
  }

  const groupKey = findGroupKey(keys);
  if (groupKey === 'all' || groupKey === 'any') {
    const children = readOwn(node, groupKey);
    if (!Array.isArray(children)) {
      return invalid(`"${groupKey}" must be an array of conditions`);
    }
    if (children.length === 0) {
      return invalid(`"${groupKey}" must contain at least one condition`);
    }
    for (const child of children) {
      const result = validateNode(child, depth + 1, budget);
      if (!result.ok) return result;
    }
    return { ok: true };
  }

  if (groupKey === 'not') {
    return validateNode(readOwn(node, 'not'), depth + 1, budget);
  }

  const path = readOwn(node, 'path');
  if (typeof path !== 'string' || path.length === 0) {
    return invalid('"path" must be a non empty string');
  }

  const op = readOwn(node, 'op');
  if (typeof op !== 'string' || op.length === 0) {
    return invalid('"op" must be a string');
  }
  if (!OPERATOR_SET.has(op)) {
    return {
      ok: false,
      code: 'unknown_operator',
      message: `unknown condition operator: ${op}`,
    };
  }

  const valueGiven = hasOwn(node, 'value');
  if (VALUE_OPERATORS.has(op) && !valueGiven) {
    return invalid(`operator "${op}" requires a "value"`);
  }
  if (!VALUE_OPERATORS.has(op) && valueGiven) {
    return invalid(`operator "${op}" does not take a "value"`);
  }

  return { ok: true };
}

/**
 * 조건 객체의 형태를 검사한다. 실행 전에 한 번 부르고, 실패하면 그 batch 를 거절한다.
 *
 * 규칙: 정확히 한 형태(leaf `{ path, op, value? }` 또는 `all`/`any`/`not` 중 하나),
 * 빈 `all`/`any` 거절, 모르는 키 거절, 깊이 최대 8, 노드 최대 64.
 * `path` 문법 자체는 템플릿 엔진이 해석하므로 여기서는 비어 있지 않은 문자열인지만 본다.
 */
export function validateCondition(node: unknown): ConditionValidationResult {
  return validateNode(node, 1, { nodes: 0 });
}

/** 문서 2절: null, undefined, 빈 문자열, 빈 배열, 빈 객체가 "비었음" 이다. */
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

/**
 * 타입 강제 없는 엄격 동등. 객체는 키 순서를 무시한 재귀 비교, 배열은 순서까지 본다.
 * own property 만 읽으므로 prototype 이 없는 객체와 `__proto__` 키를 가진 JSON 도 안전하다.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return false;

  if (aIsArray && bIsArray) {
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      if (!deepEqual(a[index], b[index])) return false;
    }
    return true;
  }

  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    if (!hasOwn(b, key)) return false;
    if (!deepEqual(readOwn(a, key), readOwn(b, key))) return false;
  }
  return true;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function containsValue(haystack: unknown, needle: unknown): boolean {
  if (typeof haystack === 'string') {
    return typeof needle === 'string' && haystack.includes(needle);
  }
  if (Array.isArray(haystack)) {
    return haystack.some((item) => deepEqual(item, needle));
  }
  return false;
}

function truth(value: boolean): ConditionEvaluationResult {
  return { ok: true, value };
}

function unresolved(path: string): ConditionEvaluationResult {
  return {
    ok: false,
    code: 'condition_unresolved',
    message: `condition path did not resolve: ${describePath(path)}`,
  };
}

function evaluateLeaf(node: object, resolve: ConditionPathResolver): ConditionEvaluationResult {
  const path = readOwn(node, 'path') as string;
  const op = readOwn(node, 'op') as ConditionOperator;
  const expected = readOwn(node, 'value');

  const resolution = resolve(path);
  const found = isRecord(resolution) && readOwn(resolution, 'found') === true;
  const actual = found ? readOwn(resolution as object, 'value') : undefined;

  switch (op) {
    case 'exists':
      return truth(found);
    case 'notExists':
      return truth(!found);
    case 'empty':
      return truth(found ? isEmptyValue(actual) : true);
    case 'notEmpty':
      return truth(found ? !isEmptyValue(actual) : false);
    default:
      break;
  }

  // 나머지 연산자는 값을 읽어야 하므로 경로가 닿지 않으면 그 step 을 실패시킨다.
  if (!found) return unresolved(path);

  switch (op) {
    case 'eq':
      return truth(deepEqual(actual, expected));
    case 'ne':
      return truth(!deepEqual(actual, expected));
    case 'contains':
      return truth(containsValue(actual, expected));
    default:
      break;
  }

  if (NUMERIC_OPERATORS.has(op)) {
    if (!isFiniteNumber(actual) || !isFiniteNumber(expected)) {
      return {
        ok: false,
        code: 'condition_invalid',
        message: `operator "${op}" needs a finite number on both sides: ${describePath(path)}`,
      };
    }
    switch (op) {
      case 'gt':
        return truth(actual > expected);
      case 'gte':
        return truth(actual >= expected);
      case 'lt':
        return truth(actual < expected);
      default:
        return truth(actual <= expected);
    }
  }

  return {
    ok: false,
    code: 'condition_invalid',
    message: `unknown condition operator: ${String(op)}`,
  };
}

function evaluateNode(node: object, resolve: ConditionPathResolver): ConditionEvaluationResult {
  if (hasOwn(node, 'all')) {
    const children = readOwn(node, 'all') as unknown[];
    for (const child of children) {
      const result = evaluateNode(child as object, resolve);
      if (!result.ok) return result;
      if (!result.value) return truth(false);
    }
    return truth(true);
  }

  if (hasOwn(node, 'any')) {
    const children = readOwn(node, 'any') as unknown[];
    for (const child of children) {
      const result = evaluateNode(child as object, resolve);
      if (!result.ok) return result;
      if (result.value) return truth(true);
    }
    return truth(false);
  }

  if (hasOwn(node, 'not')) {
    const result = evaluateNode(readOwn(node, 'not') as object, resolve);
    return result.ok ? truth(!result.value) : result;
  }

  return evaluateLeaf(node, resolve);
}

/**
 * 조건을 평가한다. 평가 전에 형태를 다시 검사하므로 잘못된 입력에도 던지지 않는다.
 *
 * `all` 은 첫 거짓에서, `any` 는 첫 참에서 멈춘다. 판정이 끝난 뒤의 자식은 보지 않으므로
 * 뒤쪽 자식의 `condition_unresolved` 는 나타나지 않는다. 판정 전에 만난 오류는 그대로 올린다.
 *
 * 깊이, 노드 수 위반은 실행 전 `validateCondition` 이 잡는 것이 정상 경로라, 여기서는
 * 반환 타입에 맞춰 `condition_invalid` 로 접어 돌려준다.
 */
export function evaluateCondition(
  node: unknown,
  resolve: ConditionPathResolver,
): ConditionEvaluationResult {
  const validation = validateCondition(node);
  if (!validation.ok) {
    return { ok: false, code: 'condition_invalid', message: validation.message };
  }
  return evaluateNode(node as object, resolve);
}
