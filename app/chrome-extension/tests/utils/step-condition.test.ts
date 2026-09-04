/**
 * batch/shortcut 조건식 검증기와 평가기 테스트.
 * 계약: `docs/plans/2026-09-04-batch-flow-design.md` 2절 표(연산자 truth table)와
 * 8절 체크리스트 8, 8a, 8b, 10c 중 조건에 관한 줄.
 *
 * 경로 해석은 템플릿 엔진 몫이라 여기서는 `resolve` 콜백을 Map 으로 흉내 낸다.
 * 조건의 `value` 는 이미 치환이 끝난 값으로 넘어온다는 계약이므로 테스트도 치환된 값을 쓴다.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_NODES,
  deepEqual,
  evaluateCondition,
  isEmptyValue,
  surfaceConditionCode,
  validateCondition,
  type ConditionPathResolver,
} from '@/utils/step-condition';

/** Map 을 쓰는 이유: `__proto__` 같은 키도 평범한 문자열 키로 다루기 위해서다. */
function resolverFor(entries: Array<[string, unknown]>): ConditionPathResolver {
  const table = new Map<string, unknown>(entries);
  return (path: string) =>
    table.has(path) ? { found: true, value: table.get(path) } : { found: false };
}

const EMPTY_RESOLVER: ConditionPathResolver = () => ({ found: false });

function nestedNot(depth: number): unknown {
  let node: unknown = { path: 'a', op: 'exists' };
  for (let level = 1; level < depth; level += 1) {
    node = { not: node };
  }
  return node;
}

function leafList(count: number): unknown[] {
  return Array.from({ length: count }, (_unused, index) => ({
    path: `a${index}`,
    op: 'exists',
  }));
}

describe('validateCondition (체크리스트 8b, 10c)', () => {
  it('leaf 형태(path, op)를 통과시킨다', () => {
    expect(validateCondition({ path: 'hit.matches[0].ref', op: 'exists' })).toEqual({ ok: true });
  });

  it('leaf 형태(path, op, value)를 통과시킨다', () => {
    expect(validateCondition({ path: 'page.values.title', op: 'contains', value: '품절' })).toEqual(
      {
        ok: true,
      },
    );
  });

  it('all, any, not 묶음을 통과시킨다', () => {
    const node = {
      all: [
        { path: 'a', op: 'exists' },
        { any: [{ path: 'b', op: 'empty' }, { not: { path: 'c', op: 'notEmpty' } }] },
      ],
    };
    expect(validateCondition(node)).toEqual({ ok: true });
  });

  it('8b: 빈 all 은 condition_invalid', () => {
    const result = validateCondition({ all: [] });
    expect(result).toMatchObject({ ok: false, code: 'condition_invalid' });
  });

  it('8b: 빈 any 는 condition_invalid', () => {
    const result = validateCondition({ any: [] });
    expect(result).toMatchObject({ ok: false, code: 'condition_invalid' });
  });

  it('8b: 모르는 키는 condition_invalid', () => {
    const result = validateCondition({ path: 'a', op: 'exists', mode: 'loose' });
    expect(result).toMatchObject({ ok: false, code: 'condition_invalid' });
    expect(result.ok === false && result.message).toContain('mode');
  });

  it('8b: leaf 와 any 혼용은 condition_invalid', () => {
    const result = validateCondition({
      path: 'a',
      op: 'exists',
      any: [{ path: 'b', op: 'exists' }],
    });
    expect(result).toMatchObject({ ok: false, code: 'condition_invalid' });
  });

  it('8b: all 과 any 를 함께 쓰면 condition_invalid', () => {
    const result = validateCondition({
      all: [{ path: 'a', op: 'exists' }],
      any: [{ path: 'b', op: 'exists' }],
    });
    expect(result).toMatchObject({ ok: false, code: 'condition_invalid' });
  });

  it('all 이 배열이 아니면 condition_invalid', () => {
    expect(validateCondition({ all: { path: 'a', op: 'exists' } })).toMatchObject({
      ok: false,
      code: 'condition_invalid',
    });
  });

  it('not 이 배열이면 condition_invalid', () => {
    expect(validateCondition({ not: [{ path: 'a', op: 'exists' }] })).toMatchObject({
      ok: false,
      code: 'condition_invalid',
    });
  });

  it('빈 객체, null, 배열, 문자열은 condition_invalid', () => {
    for (const node of [{}, null, undefined, [], 'exists', 42]) {
      expect(validateCondition(node)).toMatchObject({ ok: false, code: 'condition_invalid' });
    }
  });

  it('path 가 비어 있거나 문자열이 아니면 condition_invalid', () => {
    expect(validateCondition({ path: '', op: 'exists' })).toMatchObject({
      ok: false,
      code: 'condition_invalid',
    });
    expect(validateCondition({ path: 3, op: 'exists' })).toMatchObject({
      ok: false,
      code: 'condition_invalid',
    });
  });

  it('op 가 없으면 condition_invalid', () => {
    expect(validateCondition({ path: 'a' })).toMatchObject({
      ok: false,
      code: 'condition_invalid',
    });
  });

  it('10c: op "matches" 는 unknown_operator 이며 표면 코드는 condition_invalid', () => {
    const result = validateCondition({ path: 'a', op: 'matches', value: '^x' });
    expect(result).toMatchObject({ ok: false, code: 'unknown_operator' });
    expect(result.ok === false && surfaceConditionCode(result.code)).toBe('condition_invalid');
  });

  it('eq 는 value 가 없으면 condition_invalid', () => {
    expect(validateCondition({ path: 'a', op: 'eq' })).toMatchObject({
      ok: false,
      code: 'condition_invalid',
    });
  });

  it('eq 의 value 가 null 이어도 제공된 값으로 본다', () => {
    expect(validateCondition({ path: 'a', op: 'eq', value: null })).toEqual({ ok: true });
  });

  it('exists 는 value 를 받지 않는다', () => {
    expect(validateCondition({ path: 'a', op: 'exists', value: true })).toMatchObject({
      ok: false,
      code: 'condition_invalid',
    });
  });

  it('10c: 깊이 9 는 condition_too_deep, 깊이 8 은 통과', () => {
    expect(validateCondition(nestedNot(MAX_CONDITION_DEPTH))).toEqual({ ok: true });
    expect(validateCondition(nestedNot(MAX_CONDITION_DEPTH + 1))).toMatchObject({
      ok: false,
      code: 'condition_too_deep',
    });
  });

  it('10c: 노드 65 는 condition_too_large, 64 는 통과', () => {
    expect(validateCondition({ all: leafList(MAX_CONDITION_NODES - 1) })).toEqual({ ok: true });
    expect(validateCondition({ all: leafList(MAX_CONDITION_NODES) })).toMatchObject({
      ok: false,
      code: 'condition_too_large',
    });
  });

  it('JSON 의 __proto__ 키가 조건 객체에 있으면 모르는 키로 거절한다', () => {
    const node = JSON.parse('{"path":"a","op":"exists","__proto__":{"polluted":true}}');
    expect(validateCondition(node)).toMatchObject({ ok: false, code: 'condition_invalid' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('prototype 없는 객체도 검사한다', () => {
    const node = Object.assign(Object.create(null), { path: 'a', op: 'exists' });
    expect(validateCondition(node)).toEqual({ ok: true });
  });
});

describe('evaluateCondition truth table (체크리스트 8a)', () => {
  const present = resolverFor([['a', 'hello']]);

  it('exists: 값이 있으면 true, 경로가 닿지 않으면 false', () => {
    expect(evaluateCondition({ path: 'a', op: 'exists' }, present)).toEqual({
      ok: true,
      value: true,
    });
    expect(evaluateCondition({ path: 'a', op: 'exists' }, EMPTY_RESOLVER)).toEqual({
      ok: true,
      value: false,
    });
  });

  it('exists: null 도 있음으로 본다', () => {
    expect(evaluateCondition({ path: 'a', op: 'exists' }, resolverFor([['a', null]]))).toEqual({
      ok: true,
      value: true,
    });
  });

  it('notExists: 값이 있으면 false, 경로가 닿지 않으면 true', () => {
    expect(evaluateCondition({ path: 'a', op: 'notExists' }, present)).toEqual({
      ok: true,
      value: false,
    });
    expect(evaluateCondition({ path: 'a', op: 'notExists' }, EMPTY_RESOLVER)).toEqual({
      ok: true,
      value: true,
    });
  });

  it('empty: 경로가 닿지 않으면 true', () => {
    expect(evaluateCondition({ path: 'a', op: 'empty' }, EMPTY_RESOLVER)).toEqual({
      ok: true,
      value: true,
    });
  });

  it('empty: null, undefined, 빈 문자열, 빈 배열, 빈 객체는 true', () => {
    for (const value of [null, undefined, '', [], {}]) {
      expect(evaluateCondition({ path: 'a', op: 'empty' }, resolverFor([['a', value]]))).toEqual({
        ok: true,
        value: true,
      });
    }
  });

  it('empty: 내용이 있는 값과 숫자, 불리언은 false', () => {
    for (const value of [' ', ['x'], { k: 1 }, 0, false]) {
      expect(evaluateCondition({ path: 'a', op: 'empty' }, resolverFor([['a', value]]))).toEqual({
        ok: true,
        value: false,
      });
    }
  });

  it('notEmpty: 경로가 닿지 않으면 false', () => {
    expect(evaluateCondition({ path: 'a', op: 'notEmpty' }, EMPTY_RESOLVER)).toEqual({
      ok: true,
      value: false,
    });
  });

  it('notEmpty: 값이 비어 있지 않으면 true', () => {
    expect(
      evaluateCondition({ path: 'a', op: 'notEmpty' }, resolverFor([['a', [{ ref: 'e1' }]]])),
    ).toEqual({ ok: true, value: true });
  });

  it('eq: 경로가 닿지 않으면 condition_unresolved', () => {
    expect(evaluateCondition({ path: 'a', op: 'eq', value: 1 }, EMPTY_RESOLVER)).toMatchObject({
      ok: false,
      code: 'condition_unresolved',
    });
  });

  it('ne: 경로가 닿지 않으면 condition_unresolved', () => {
    expect(evaluateCondition({ path: 'a', op: 'ne', value: 1 }, EMPTY_RESOLVER)).toMatchObject({
      ok: false,
      code: 'condition_unresolved',
    });
  });

  it('contains: 경로가 닿지 않으면 condition_unresolved', () => {
    expect(
      evaluateCondition({ path: 'a', op: 'contains', value: 'x' }, EMPTY_RESOLVER),
    ).toMatchObject({ ok: false, code: 'condition_unresolved' });
  });

  it('gt, gte, lt, lte: 경로가 닿지 않으면 condition_unresolved', () => {
    for (const op of ['gt', 'gte', 'lt', 'lte']) {
      expect(evaluateCondition({ path: 'a', op, value: 1 }, EMPTY_RESOLVER)).toMatchObject({
        ok: false,
        code: 'condition_unresolved',
      });
    }
  });
});

describe('evaluateCondition eq, ne (체크리스트 8a)', () => {
  it('eq: 타입 강제 없이 비교하므로 숫자와 숫자 문자열은 다르다', () => {
    expect(evaluateCondition({ path: 'a', op: 'eq', value: '5' }, resolverFor([['a', 5]]))).toEqual(
      { ok: true, value: false },
    );
    expect(evaluateCondition({ path: 'a', op: 'eq', value: 5 }, resolverFor([['a', 5]]))).toEqual({
      ok: true,
      value: true,
    });
  });

  it('eq: false 와 null, 0 을 서로 다르게 본다', () => {
    expect(
      evaluateCondition({ path: 'a', op: 'eq', value: false }, resolverFor([['a', 0]])),
    ).toEqual({ ok: true, value: false });
    expect(
      evaluateCondition({ path: 'a', op: 'eq', value: null }, resolverFor([['a', false]])),
    ).toEqual({ ok: true, value: false });
  });

  it('8a: eq 는 키 순서가 다른 객체를 같게 본다', () => {
    const actual = { b: { d: 2, c: [1, 2] }, a: 1 };
    const expected = { a: 1, b: { c: [1, 2], d: 2 } };
    expect(
      evaluateCondition({ path: 'a', op: 'eq', value: expected }, resolverFor([['a', actual]])),
    ).toEqual({ ok: true, value: true });
  });

  it('8a: eq 는 순서가 다른 배열을 다르게 본다', () => {
    expect(
      evaluateCondition({ path: 'a', op: 'eq', value: [1, 2] }, resolverFor([['a', [2, 1]]])),
    ).toEqual({ ok: true, value: false });
  });

  it('eq: 키 개수가 다른 객체는 다르다', () => {
    expect(
      evaluateCondition(
        { path: 'a', op: 'eq', value: { x: 1 } },
        resolverFor([['a', { x: 1, y: 2 }]]),
      ),
    ).toEqual({ ok: true, value: false });
  });

  it('ne 는 eq 의 반대다', () => {
    expect(evaluateCondition({ path: 'a', op: 'ne', value: 5 }, resolverFor([['a', 5]]))).toEqual({
      ok: true,
      value: false,
    });
    expect(evaluateCondition({ path: 'a', op: 'ne', value: 6 }, resolverFor([['a', 5]]))).toEqual({
      ok: true,
      value: true,
    });
  });

  it('eq: prototype 없는 객체와 평범한 객체를 같게 본다', () => {
    const actual = Object.assign(Object.create(null), { x: 1 });
    expect(
      evaluateCondition({ path: 'a', op: 'eq', value: { x: 1 } }, resolverFor([['a', actual]])),
    ).toEqual({ ok: true, value: true });
  });

  it('eq: __proto__ 키를 가진 JSON 을 비교해도 Object.prototype 이 오염되지 않는다', () => {
    const actual = JSON.parse('{"__proto__":{"polluted":true},"x":1}');
    const sameShape = JSON.parse('{"x":1,"__proto__":{"polluted":true}}');
    expect(
      evaluateCondition({ path: 'a', op: 'eq', value: sameShape }, resolverFor([['a', actual]])),
    ).toEqual({ ok: true, value: true });
    expect(
      evaluateCondition({ path: 'a', op: 'eq', value: { x: 1 } }, resolverFor([['a', actual]])),
    ).toEqual({ ok: true, value: false });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(deepEqual({}, JSON.parse('{"__proto__":{}}'))).toBe(false);
  });
});

describe('evaluateCondition gt, gte, lt, lte (체크리스트 8a)', () => {
  it('유한 숫자끼리 비교한다', () => {
    const resolve = resolverFor([['a', 5]]);
    expect(evaluateCondition({ path: 'a', op: 'gt', value: 4 }, resolve)).toEqual({
      ok: true,
      value: true,
    });
    expect(evaluateCondition({ path: 'a', op: 'gte', value: 5 }, resolve)).toEqual({
      ok: true,
      value: true,
    });
    expect(evaluateCondition({ path: 'a', op: 'lt', value: 5 }, resolve)).toEqual({
      ok: true,
      value: false,
    });
    expect(evaluateCondition({ path: 'a', op: 'lte', value: 5 }, resolve)).toEqual({
      ok: true,
      value: true,
    });
  });

  it('숫자 문자열은 condition_invalid (문자열 비교로 넘어가지 않는다)', () => {
    expect(
      evaluateCondition({ path: 'a', op: 'gt', value: '4' }, resolverFor([['a', 5]])),
    ).toMatchObject({ ok: false, code: 'condition_invalid' });
    expect(
      evaluateCondition({ path: 'a', op: 'gt', value: 4 }, resolverFor([['a', '5']])),
    ).toMatchObject({ ok: false, code: 'condition_invalid' });
  });

  it('NaN 과 Infinity 비교는 condition_invalid', () => {
    expect(
      evaluateCondition({ path: 'a', op: 'lt', value: Number.NaN }, resolverFor([['a', 1]])),
    ).toMatchObject({ ok: false, code: 'condition_invalid' });
    expect(
      evaluateCondition(
        { path: 'a', op: 'gt', value: 1 },
        resolverFor([['a', Number.POSITIVE_INFINITY]]),
      ),
    ).toMatchObject({ ok: false, code: 'condition_invalid' });
  });

  it('null 이나 객체 비교도 condition_invalid', () => {
    expect(
      evaluateCondition({ path: 'a', op: 'gte', value: 1 }, resolverFor([['a', null]])),
    ).toMatchObject({ ok: false, code: 'condition_invalid' });
    expect(
      evaluateCondition({ path: 'a', op: 'lte', value: {} }, resolverFor([['a', 1]])),
    ).toMatchObject({ ok: false, code: 'condition_invalid' });
  });
});

describe('evaluateCondition contains (체크리스트 8a)', () => {
  it('문자열은 부분 일치를 본다', () => {
    const resolve = resolverFor([['a', '오늘 품절되었습니다']]);
    expect(evaluateCondition({ path: 'a', op: 'contains', value: '품절' }, resolve)).toEqual({
      ok: true,
      value: true,
    });
    expect(evaluateCondition({ path: 'a', op: 'contains', value: '재고' }, resolve)).toEqual({
      ok: true,
      value: false,
    });
  });

  it('배열은 원소를 깊게 비교한다', () => {
    const resolve = resolverFor([['a', [{ ref: 'e1' }, { ref: 'e2' }]]]);
    expect(evaluateCondition({ path: 'a', op: 'contains', value: { ref: 'e2' } }, resolve)).toEqual(
      {
        ok: true,
        value: true,
      },
    );
    expect(evaluateCondition({ path: 'a', op: 'contains', value: { ref: 'e3' } }, resolve)).toEqual(
      {
        ok: true,
        value: false,
      },
    );
  });

  it('문자열에 숫자를 찾거나 숫자, 객체 안을 찾으면 false', () => {
    expect(
      evaluateCondition({ path: 'a', op: 'contains', value: 1 }, resolverFor([['a', '123']])),
    ).toEqual({ ok: true, value: false });
    expect(
      evaluateCondition({ path: 'a', op: 'contains', value: 1 }, resolverFor([['a', 123]])),
    ).toEqual({ ok: true, value: false });
    expect(
      evaluateCondition({ path: 'a', op: 'contains', value: 'k' }, resolverFor([['a', { k: 1 }]])),
    ).toEqual({ ok: true, value: false });
  });
});

describe('evaluateCondition 묶음 (체크리스트 8b)', () => {
  const resolve = resolverFor([
    ['a.$ok', false],
    ['b.matches', []],
    ['c.title', '품절'],
  ]);

  it('all 은 모두 참일 때만 true', () => {
    expect(
      evaluateCondition(
        {
          all: [
            { path: 'a.$ok', op: 'eq', value: false },
            { path: 'b.matches', op: 'empty' },
          ],
        },
        resolve,
      ),
    ).toEqual({ ok: true, value: true });
    expect(
      evaluateCondition(
        {
          all: [
            { path: 'b.matches', op: 'notEmpty' },
            { path: 'c.title', op: 'contains', value: '품절' },
          ],
        },
        resolve,
      ),
    ).toEqual({ ok: true, value: false });
  });

  it('any 는 하나만 참이어도 true', () => {
    expect(
      evaluateCondition(
        {
          any: [
            { path: 'b.matches', op: 'notEmpty' },
            { path: 'a.$ok', op: 'eq', value: false },
          ],
        },
        resolve,
      ),
    ).toEqual({ ok: true, value: true });
  });

  it('any 는 참을 만나면 뒤 조건을 평가하지 않는다', () => {
    const spy = vi.fn(resolve);
    const result = evaluateCondition(
      {
        any: [
          { path: 'b.matches', op: 'empty' },
          { path: 'missing', op: 'eq', value: 1 },
        ],
      },
      spy,
    );
    expect(result).toEqual({ ok: true, value: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('all 은 거짓을 만나면 뒤 조건을 평가하지 않는다', () => {
    const spy = vi.fn(resolve);
    const result = evaluateCondition(
      {
        all: [
          { path: 'b.matches', op: 'notEmpty' },
          { path: 'missing', op: 'eq', value: 1 },
        ],
      },
      spy,
    );
    expect(result).toEqual({ ok: true, value: false });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('not 은 결과를 뒤집는다', () => {
    expect(evaluateCondition({ not: { path: 'b.matches', op: 'empty' } }, resolve)).toEqual({
      ok: true,
      value: false,
    });
  });

  it('판정 전에 만난 condition_unresolved 는 묶음 밖으로 전파된다', () => {
    expect(
      evaluateCondition(
        {
          all: [
            { path: 'a.$ok', op: 'eq', value: false },
            { not: { path: 'missing', op: 'gt', value: 1 } },
          ],
        },
        resolve,
      ),
    ).toMatchObject({ ok: false, code: 'condition_unresolved' });
  });

  it('8b: 이미 치환된 value 로 두 결과값을 비교할 수 있다', () => {
    // 호출자가 `value: "{{b.y}}"` 를 먼저 7 로 치환해 넘긴다는 계약.
    expect(
      evaluateCondition({ path: 'a.x', op: 'eq', value: 7 }, resolverFor([['a.x', 7]])),
    ).toEqual({ ok: true, value: true });
  });
});

describe('evaluateCondition 방어 (체크리스트 10c)', () => {
  it('형태가 잘못된 조건은 던지지 않고 condition_invalid 로 돌아온다', () => {
    expect(evaluateCondition({ all: [] }, EMPTY_RESOLVER)).toMatchObject({
      ok: false,
      code: 'condition_invalid',
    });
    expect(
      evaluateCondition({ path: 'a', op: 'matches', value: 'x' }, EMPTY_RESOLVER),
    ).toMatchObject({ ok: false, code: 'condition_invalid' });
    expect(evaluateCondition(nestedNot(MAX_CONDITION_DEPTH + 1), EMPTY_RESOLVER)).toMatchObject({
      ok: false,
      code: 'condition_invalid',
    });
  });

  it('resolve 가 이상한 값을 돌려주면 닿지 않은 것으로 본다', () => {
    const weird = (() => null) as unknown as ConditionPathResolver;
    expect(evaluateCondition({ path: 'a', op: 'exists' }, weird)).toEqual({
      ok: true,
      value: false,
    });
  });

  it('resolve 가 prototype 없는 결과를 돌려줘도 값을 읽는다', () => {
    const resolve: ConditionPathResolver = () =>
      Object.assign(Object.create(null), { found: true, value: 'hello' });
    expect(evaluateCondition({ path: 'a', op: 'contains', value: 'ell' }, resolve)).toEqual({
      ok: true,
      value: true,
    });
  });

  it('prototype 없는 조건 노드도 평가한다', () => {
    const leaf = Object.assign(Object.create(null), { path: 'a', op: 'notEmpty' });
    const group = Object.assign(Object.create(null), { all: [leaf] });
    expect(evaluateCondition(group, resolverFor([['a', 'x']]))).toEqual({ ok: true, value: true });
  });

  it('조건 안에 __proto__ 를 넣어도 평가 경로에서 Object.prototype 이 오염되지 않는다', () => {
    const node = JSON.parse('{"not":{"path":"a","op":"exists"},"__proto__":{"polluted":true}}');
    expect(evaluateCondition(node, EMPTY_RESOLVER)).toMatchObject({
      ok: false,
      code: 'condition_invalid',
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('보조 함수', () => {
  it('isEmptyValue 는 문서의 빈 값 정의를 따른다', () => {
    expect([null, undefined, '', [], {}].map(isEmptyValue)).toEqual([true, true, true, true, true]);
    expect([0, false, ' ', [0], { a: 1 }].map(isEmptyValue)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('deepEqual 은 NaN 을 서로 다르게, 0 과 -0 을 같게 본다', () => {
    expect(deepEqual(Number.NaN, Number.NaN)).toBe(false);
    expect(deepEqual(0, -0)).toBe(true);
  });

  it('surfaceConditionCode 는 unknown_operator 만 접는다', () => {
    expect(surfaceConditionCode('unknown_operator')).toBe('condition_invalid');
    expect(surfaceConditionCode('condition_too_deep')).toBe('condition_too_deep');
    expect(surfaceConditionCode('condition_too_large')).toBe('condition_too_large');
    expect(surfaceConditionCode('condition_unresolved')).toBe('condition_unresolved');
  });
});
