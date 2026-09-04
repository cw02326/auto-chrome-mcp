/**
 * auto-chrome-mcp fork — step 값 전달 템플릿 엔진 단위 테스트.
 *
 * 계약: docs/plans/2026-09-04-batch-flow-design.md 1절.
 * 테스트 이름의 번호는 같은 문서 8절 체크리스트 번호다.
 */
import { describe, expect, it } from 'vitest';

import {
  StepTemplateError,
  areTemplatesActive,
  assertValidCaptureName,
  buildCapture,
  createTemplateScope,
  substituteArgs,
  type TemplateScope,
} from '@/utils/step-template';

const asResult = (text: string) => ({ content: [{ type: 'text', text }], isError: false });

function scopeWith(entries: Record<string, string>): TemplateScope {
  const scope = createTemplateScope();
  for (const [name, text] of Object.entries(entries)) {
    scope.named.set(name, buildCapture(asResult(text), true, null));
  }
  return scope;
}

function sub(args: Record<string, unknown>, scope: TemplateScope): Record<string, unknown> {
  return substituteArgs(args, scope, new WeakSet());
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof StepTemplateError ? error.code : `unexpected:${String(error)}`;
  }
  return 'no-error';
}

describe('step-template 활성화 규칙 (1a)', () => {
  it('1a. 새 키가 없는 v1 호출은 치환기를 켜지 않는다', () => {
    expect(areTemplatesActive({ steps: [{ tool: 'chrome_find', args: { q: '{{a.b}}' } }] })).toBe(
      false,
    );
  });

  it('1a. templates:true 또는 step 의 as 가 있으면 켜진다', () => {
    expect(areTemplatesActive({ templates: true, steps: [{ tool: 'chrome_find' }] })).toBe(true);
    expect(areTemplatesActive({ steps: [{ tool: 'chrome_find', as: 'hit' }] })).toBe(true);
    expect(areTemplatesActive({ steps: [{ tool: 'chrome_find' }], return: ['hit'] })).toBe(true);
    expect(areTemplatesActive({ steps: [{ repeat: { max: 2 }, steps: [] }] })).toBe(true);
  });
});

describe('step-template 타입 보존 (3)', () => {
  const scope = scopeWith({
    a: JSON.stringify({ n: 5, b: true, arr: [1, 2, 3], obj: { x: 1, y: 'z' }, nil: null }),
  });

  it('3. 통째 치환은 숫자·불리언·배열·객체·null 타입을 보존한다', () => {
    const out = sub(
      {
        n: '{{a.n}}',
        b: '{{a.b}}',
        arr: '{{a.arr}}',
        obj: '{{a.obj}}',
        nil: '{{a.nil}}',
      },
      scope,
    );
    expect(out.n).toBe(5);
    expect(out.b).toBe(true);
    expect(out.arr).toEqual([1, 2, 3]);
    expect(out.obj).toEqual({ x: 1, y: 'z' });
    expect(out.nil).toBeNull();
  });

  it('3. 끼움 치환은 숫자를 String(), 객체·배열을 JSON.stringify 와 같게 만든다', () => {
    const out = sub({ s: 'n=({{a.n}}) o={{a.obj}} a={{a.arr}}' }, scope);
    expect(out.s).toBe(
      `n=(5) o=${JSON.stringify({ x: 1, y: 'z' })} a=${JSON.stringify([1, 2, 3])}`,
    );
  });

  it('3. 끼움 치환에서 null 은 embedded_null 이다', () => {
    expect(codeOf(() => sub({ s: 'v={{a.nil}}' }, scope))).toBe('embedded_null');
  });

  it('3. 치환은 객체·배열 안까지 재귀 적용되고 키 이름은 건드리지 않는다', () => {
    const out = sub({ '{{a.n}}': ['{{a.n}}', { deep: '{{a.b}}' }] }, scope);
    expect(Object.keys(out)).toEqual(['{{a.n}}']);
    expect(out['{{a.n}}']).toEqual([5, { deep: true }]);
  });
});

describe('step-template 문법 (5)', () => {
  const scope = scopeWith({
    a: JSON.stringify({ b: 'B', list: ['first', 'mid', 'last'] }),
    v: JSON.stringify({ x: '{{a.b}}' }),
  });

  it('5. 치환된 결과 안의 {{x}} 는 다시 스캔하지 않는다 (단일 패스)', () => {
    expect(sub({ s: '{{v.x}}' }, scope).s).toBe('{{a.b}}');
    expect(sub({ s: 'pre {{v.x}}' }, scope).s).toBe('pre {{a.b}}');
  });

  it('5. 백슬래시 1개 + {{ 는 literal {{ 로, 2개는 백슬래시 하나 + 치환값으로 나간다', () => {
    expect(sub({ s: '\\{{a.b}}' }, scope).s).toBe('{{a.b}}');
    expect(sub({ s: '\\\\{{a.b}}' }, scope).s).toBe('\\B');
  });

  it('5. malformed 토큰은 literal 로 남고 같은 문자열의 유효 토큰만 치환된다', () => {
    expect(sub({ s: '{{ a.b }}' }, scope).s).toBe('{{ a.b }}');
    expect(sub({ s: '{{a..b}}' }, scope).s).toBe('{{a..b}}');
    expect(sub({ s: '{{a[-2]}}' }, scope).s).toBe('{{a[-2]}}');
    expect(sub({ s: '{{ a.b }} / {{a.b}}' }, scope).s).toBe('{{ a.b }} / B');
  });

  it('5. [-1] 은 마지막 원소, [0] 은 첫 원소다', () => {
    expect(sub({ s: '{{a.list[-1]}}' }, scope).s).toBe('last');
    expect(sub({ s: '{{a.list[0]}}' }, scope).s).toBe('first');
  });

  it('5. 20,000자는 통과하고 20,001자는 reference_too_large 다', () => {
    const big = scopeWith({
      big: JSON.stringify({ ok: 'x'.repeat(20000), over: 'x'.repeat(20001) }),
    });
    expect((sub({ s: '{{big.ok}}' }, big).s as string).length).toBe(20000);
    expect(codeOf(() => sub({ s: '{{big.over}}' }, big))).toBe('reference_too_large');
    expect(codeOf(() => sub({ s: 'pre {{big.over}}' }, big))).toBe('reference_too_large');
  });
});

describe('step-template 경로 안전 (2b)', () => {
  it('2b. __proto__·prototype·constructor 세그먼트는 forbidden_path_segment 다', () => {
    const scope = scopeWith({ a: JSON.stringify({ b: 1 }) });
    expect(codeOf(() => sub({ s: '{{a.__proto__}}' }, scope))).toBe('forbidden_path_segment');
    expect(codeOf(() => sub({ s: '{{a.prototype}}' }, scope))).toBe('forbidden_path_segment');
    expect(codeOf(() => sub({ s: '{{a.constructor.x}}' }, scope))).toBe('forbidden_path_segment');
  });

  it('2b. __proto__ 를 품은 결과를 통째 치환해도 오염되지 않고 prototype 이 null 이다', () => {
    const scope = scopeWith({ a: '{"__proto__":{"polluted":true},"keep":1}' });
    const out = sub({ v: '{{a}}' }, scope);
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(out.v as object)).toBeNull();
    expect((out.v as any).keep).toBe(1);
  });
});

describe('step-template 이름 규칙 (2c)', () => {
  it('2c. 규칙에 안 맞는 이름은 거절한다', () => {
    expect(codeOf(() => assertValidCaptureName('9abc', new Set()))).toBe('invalid_as_name');
    expect(codeOf(() => assertValidCaptureName('a'.repeat(33), new Set()))).toBe('invalid_as_name');
    expect(assertValidCaptureName('a'.repeat(32), new Set())).toBe('a'.repeat(32));
  });

  it('2c. params·prev·loop 는 reserved_name 이다', () => {
    for (const name of ['params', 'prev', 'loop']) {
      expect(codeOf(() => assertValidCaptureName(name, new Set()))).toBe('reserved_name');
    }
  });

  it('2c. 같은 scope 의 중복 이름은 duplicate_as 다', () => {
    const seen = new Set<string>();
    assertValidCaptureName('hit', seen);
    expect(codeOf(() => assertValidCaptureName('hit', seen))).toBe('duplicate_as');
  });
});

describe('step-template 뿌리와 메타 (2d)', () => {
  it('2d. JSON 이 아닌 결과는 {{name}} 이 그 문자열, path 접근은 unresolved_reference 다', () => {
    const scope = createTemplateScope();
    scope.named.set('t', buildCapture(asResult('plain text here'), true, null));
    expect(sub({ s: '{{t}}' }, scope).s).toBe('plain text here');
    expect(codeOf(() => sub({ s: '{{t.x}}' }, scope))).toBe('unresolved_reference');
  });

  it('2d. $ok 는 boolean, $text 는 string, $error 는 성공 시 null 실패 시 string 이다', () => {
    const scope = createTemplateScope();
    scope.named.set('okStep', buildCapture(asResult('{"a":1}'), true, null));
    scope.named.set('badStep', buildCapture(asResult('boom'), false, 'boom'));

    const out = sub(
      { ok: '{{okStep.$ok}}', text: '{{okStep.$text}}', err: '{{okStep.$error}}' },
      scope,
    );
    expect(out.ok).toBe(true);
    expect(out.text).toBe('{"a":1}');
    expect(out.err).toBeNull();

    const bad = sub({ ok: '{{badStep.$ok}}', err: '{{badStep.$error}}' }, scope);
    expect(bad.ok).toBe(false);
    expect(bad.err).toBe('boom');
  });

  it('2d. 결과 JSON 에 "$ok" 키가 있어도 메타가 이긴다', () => {
    const scope = scopeWith({ a: '{"$ok":"fake"}' });
    expect(sub({ v: '{{a.$ok}}' }, scope).v).toBe(true);
  });

  it('4. 없는 이름과 닿지 않는 path 는 unresolved_reference 다', () => {
    const scope = scopeWith({ a: JSON.stringify({ list: [] }) });
    expect(codeOf(() => sub({ s: '{{nope.x}}' }, scope))).toBe('unresolved_reference');
    expect(codeOf(() => sub({ s: '{{a.list[0]}}' }, scope))).toBe('unresolved_reference');
    expect(codeOf(() => sub({ s: '{{a.missing}}' }, scope))).toBe('unresolved_reference');
  });
});
