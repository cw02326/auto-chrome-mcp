/**
 * 저장 마법사의 순수 로직 (2026-09-05 사이드패널 1단계 A).
 *
 * 여기서 지키려는 계약은 셋이다.
 *   1. 체크한 값은 흐름 변수가 되고 단계 값은 엔진 문법(`{이름}`)의 참조로 바뀐다.
 *   2. 민감 변수의 실제 값은 저장되는 흐름 어디에도 남지 않는다.
 *   3. 발행한 뒤 흐름이 바뀌면 "재발행 필요" 로 판정한다.
 */

import { describe, expect, it } from 'vitest';
import {
  applyWizardEdits,
  defaultFlowNameForFlow,
  detectVariables,
  needsRepublish,
  requiredRunVariables,
  validateVariables,
  variableReference,
  type WizardFlow,
} from '@/entrypoints/sidepanel/utils/flow-wizard';

function makeFlow(): WizardFlow {
  return {
    id: 'flow_1',
    name: 'new_workflow',
    version: 1,
    startUrl: 'https://example.com/login',
    meta: { createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' },
    // 녹화기가 비밀번호 칸을 이미 변수로 바꿔 둔 상태를 재현한다.
    variables: [{ key: 'password', sensitive: true, default: '' }],
    nodes: [
      { id: 'n1', type: 'navigate', config: { url: 'https://example.com/login' } },
      {
        id: 'n2',
        type: 'fill',
        config: {
          target: { candidates: [{ type: 'name', value: 'userid' }], selector: '#userid' },
          value: 'hong@example.com',
        },
      },
      {
        id: 'n3',
        type: 'fill',
        config: {
          target: { candidates: [{ type: 'name', value: 'password' }], selector: '#password' },
          value: '{password}',
        },
      },
      { id: 'n4', type: 'click', config: { target: { selector: '#submit' } } },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2', label: 'default' },
      { id: 'e2', from: 'n2', to: 'n3', label: 'default' },
      { id: 'e3', from: 'n3', to: 'n4', label: 'default' },
    ],
  };
}

describe('detectVariables', () => {
  it('세션이 모은 변수를 먼저 싣고, 남은 fill 값은 후보로 붙인다', () => {
    const variables = detectVariables(makeFlow());

    expect(variables).toHaveLength(2);

    const declared = variables[0];
    expect(declared.key).toBe('password');
    expect(declared.declared).toBe(true);
    expect(declared.selected).toBe(true);
    expect(declared.sensitive).toBe(true);
    expect(declared.nodeIds).toEqual(['n3']);
    // 민감 항목은 값이 없다 - 녹화기가 애초에 값을 남기지 않는다.
    expect(declared.value).toBe('');

    const candidate = variables[1];
    expect(candidate.declared).toBe(false);
    expect(candidate.selected).toBe(false);
    expect(candidate.sensitive).toBe(false);
    expect(candidate.nodeIds).toEqual(['n2']);
    expect(candidate.value).toBe('hong@example.com');
  });

  it('이미 다른 변수를 가리키는 값은 후보로 다시 뽑지 않는다', () => {
    const flow = makeFlow();
    flow.variables = [];
    flow.nodes![2].config!.value = '{password}';
    const variables = detectVariables(flow);
    // 선언에 없는 중괄호는 사용자가 친 글자다. 후보에서 빠지면 편집할 방법이 없어진다.
    expect(variables.map((v) => v.nodeIds)).toEqual([['n2'], ['n3']]);
    expect(variables[1].value).toBe('{password}');
  });
});

describe('applyWizardEdits', () => {
  it('체크한 값은 변수 선언이 되고 단계 값은 엔진 문법의 참조로 바뀐다', () => {
    const source = makeFlow();
    const variables = detectVariables(source);
    variables[1].selected = true;
    variables[1].key = 'userid';

    const { flow, changed } = applyWizardEdits(source, {
      name: '예제 로그인',
      startUrl: 'https://example.com/login',
      variables,
      removedNodeIds: [],
    });

    expect(changed).toBe(true);
    expect(flow.name).toBe('예제 로그인');
    // 엔진 치환 문법은 중괄호 하나다 (actions/handlers/common.ts interpolateBraces).
    expect(variableReference('userid')).toBe('{userid}');
    expect(flow.nodes!.find((n) => n.id === 'n2')!.config!.value).toBe('{userid}');
    expect(flow.nodes!.find((n) => n.id === 'n3')!.config!.value).toBe('{password}');

    const userid = flow.variables!.find((v) => v.key === 'userid')!;
    expect(userid.default).toBe('hong@example.com');
    expect(userid.sensitive).toBeUndefined();
  });

  it('민감 변수의 값은 저장되는 흐름 어디에도 남지 않는다', () => {
    const source = makeFlow();
    const variables = detectVariables(source);
    // 사용자가 아이디 칸을 민감으로 표시한 경우까지 확인한다.
    variables[1].selected = true;
    variables[1].key = 'userid';
    variables[1].sensitive = true;

    const { flow } = applyWizardEdits(source, {
      name: '예제 로그인',
      startUrl: 'https://example.com/login',
      variables,
      removedNodeIds: [],
    });

    const secret = flow.variables!.find((v) => v.key === 'userid')!;
    expect(secret.sensitive).toBe(true);
    expect('default' in secret).toBe(false);
    expect(JSON.stringify(flow)).not.toContain('hong@example.com');
  });

  it('체크를 풀면 선언이 사라지고 단계 값이 리터럴로 돌아간다', () => {
    const source = makeFlow();
    const variables = detectVariables(source);
    variables[0].selected = false; // password 선언 해제

    const { flow } = applyWizardEdits(source, {
      name: source.name,
      startUrl: source.startUrl ?? '',
      variables,
      removedNodeIds: [],
    });

    expect(flow.variables).toHaveLength(0);
    expect(flow.nodes!.find((n) => n.id === 'n3')!.config!.value).toBe('');
  });

  it('단계를 지우면 앞뒤 단계가 다시 이어진다', () => {
    const source = makeFlow();
    const variables = detectVariables(source);

    const { flow } = applyWizardEdits(source, {
      name: source.name,
      startUrl: source.startUrl ?? '',
      variables,
      removedNodeIds: ['n2'],
    });

    expect(flow.nodes!.map((n) => n.id)).toEqual(['n1', 'n3', 'n4']);
    expect(flow.edges!.some((e) => e.from === 'n1' && e.to === 'n3')).toBe(true);
    expect(flow.edges!.some((e) => e.from === 'n2' || e.to === 'n2')).toBe(false);
  });

  it('바뀐 것이 없으면 version 을 올리지 않는다', () => {
    const source = makeFlow();
    const { flow, changed } = applyWizardEdits(source, {
      name: source.name,
      startUrl: source.startUrl ?? '',
      variables: detectVariables(source),
      removedNodeIds: [],
    });
    expect(changed).toBe(false);
    expect(flow.version).toBe(source.version);
  });

  it('내용이 바뀌면 version 이 오른다', () => {
    const source = makeFlow();
    const { flow } = applyWizardEdits(source, {
      name: '다른 이름',
      startUrl: source.startUrl ?? '',
      variables: detectVariables(source),
      removedNodeIds: [],
    });
    expect(flow.version).toBe(source.version + 1);
  });
});

/** 같은 변수를 두 칸이 쓰고, 다른 칸에는 변수처럼 생긴 리터럴이 들어 있는 흐름. */
function makeSharedVariableFlow(): WizardFlow {
  return {
    id: 'flow_2',
    name: '주문',
    version: 1,
    startUrl: 'https://shop.example.com/',
    meta: { createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' },
    variables: [{ key: 'pin', sensitive: true }],
    nodes: [
      {
        id: 'n1',
        type: 'fill',
        config: { target: { candidates: [{ type: 'name', value: 'pin1' }] }, value: '{pin}' },
      },
      {
        id: 'n2',
        type: 'fill',
        config: { target: { candidates: [{ type: 'name', value: 'pin2' }] }, value: '{pin}' },
      },
      {
        id: 'n3',
        type: 'fill',
        config: {
          target: { candidates: [{ type: 'name', value: 'memo' }] },
          value: '주문 {order}',
        },
      },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2', label: 'default' },
      { id: 'e2', from: 'n2', to: 'n3', label: 'default' },
    ],
  };
}

describe('여러 단계가 같은 변수를 쓸 때 (Codex 교차 리뷰 1항)', () => {
  it('선언 변수를 참조하는 단계를 모두 모은다', () => {
    const variables = detectVariables(makeSharedVariableFlow());
    const pin = variables.find((v) => v.key === 'pin')!;
    expect(pin.nodeIds).toEqual(['n1', 'n2']);
  });

  it('이름을 바꾸면 참조하는 단계가 전부 따라 바뀐다', () => {
    const source = makeSharedVariableFlow();
    const variables = detectVariables(source);
    variables.find((v) => v.key === 'pin')!.key = 'secret';

    const { flow } = applyWizardEdits(source, {
      name: source.name,
      startUrl: source.startUrl ?? '',
      variables,
      removedNodeIds: [],
    });

    expect(flow.nodes!.find((n) => n.id === 'n1')!.config!.value).toBe('{secret}');
    expect(flow.nodes!.find((n) => n.id === 'n2')!.config!.value).toBe('{secret}');
    // 사라진 이름을 가리키는 단계가 남으면 안 된다.
    expect(JSON.stringify(flow)).not.toContain('{pin}');
    expect(flow.variables!.map((v) => v.key)).toEqual(['secret']);
  });

  it('문자열 안에 섞인 참조도 함께 바뀐다', () => {
    const source = makeSharedVariableFlow();
    // n3 의 리터럴을 변수 참조가 섞인 문장으로 바꿔 둔다.
    source.nodes![2].config!.value = '주문 {pin} 확인';
    const variables = detectVariables(source);
    variables.find((v) => v.key === 'pin')!.key = 'secret';

    const { flow } = applyWizardEdits(source, {
      name: source.name,
      startUrl: source.startUrl ?? '',
      variables,
      removedNodeIds: [],
    });

    expect(flow.nodes!.find((n) => n.id === 'n3')!.config!.value).toBe('주문 {secret} 확인');
  });

  it('선언에 없는 중괄호는 리터럴이라 편집 후보로 남는다', () => {
    const variables = detectVariables(makeSharedVariableFlow());
    const memo = variables.find((v) => v.nodeIds.includes('n3'))!;
    expect(memo.declared).toBe(false);
    expect(memo.selected).toBe(false);
    expect(memo.value).toBe('주문 {order}');
  });

  it('참조하는 단계 하나만 지우면 변수는 남는다', () => {
    const source = makeSharedVariableFlow();
    const variables = detectVariables(source);

    const { flow } = applyWizardEdits(source, {
      name: source.name,
      startUrl: source.startUrl ?? '',
      variables,
      removedNodeIds: ['n1'],
    });

    expect(flow.variables!.map((v) => v.key)).toContain('pin');
    expect(flow.nodes!.find((n) => n.id === 'n2')!.config!.value).toBe('{pin}');
  });

  it('참조하는 단계를 모두 지우면 변수도 사라진다', () => {
    const source = makeSharedVariableFlow();
    const variables = detectVariables(source);

    const { flow } = applyWizardEdits(source, {
      name: source.name,
      startUrl: source.startUrl ?? '',
      variables,
      removedNodeIds: ['n1', 'n2'],
    });

    expect(flow.variables!.map((v) => v.key)).not.toContain('pin');
  });
});

describe('validateVariables', () => {
  it('이름이 겹치면 걸러낸다', () => {
    const result = validateVariables([
      { key: 'a', selected: true, sensitive: false, value: '1', nodeIds: [], declared: false },
      { key: 'a', selected: true, sensitive: false, value: '2', nodeIds: [], declared: false },
    ]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('duplicate_key');
  });

  it('엔진 치환이 깨지는 이름은 거절한다', () => {
    const result = validateVariables([
      { key: 'a b}', selected: true, sensitive: false, value: '1', nodeIds: [], declared: false },
    ]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('invalid_key');
  });
});

describe('needsRepublish', () => {
  it('발행하지 않은 흐름은 재발행 대상이 아니다', () => {
    expect(needsRepublish(makeFlow(), null)).toBe(false);
  });

  it('발행 당시 version 과 같으면 재발행이 필요 없다', () => {
    const flow = makeFlow();
    expect(needsRepublish(flow, { id: flow.id, slug: 'x', version: flow.version })).toBe(false);
  });

  it('발행 뒤 흐름이 바뀌면 재발행이 필요하다', () => {
    const flow = makeFlow();
    const published = { id: flow.id, slug: 'x', version: flow.version };
    const { flow: edited } = applyWizardEdits(flow, {
      name: '수정한 이름',
      startUrl: flow.startUrl ?? '',
      variables: detectVariables(flow),
      removedNodeIds: [],
    });
    expect(needsRepublish(edited, published)).toBe(true);
  });

  it('발행 시각이 있으면 그 뒤의 수정도 잡는다', () => {
    const flow = makeFlow();
    flow.meta!.updatedAt = '2026-09-06T00:00:00.000Z';
    expect(
      needsRepublish(flow, {
        id: flow.id,
        slug: 'x',
        version: flow.version,
        publishedAt: '2026-09-05T00:00:00.000Z',
      }),
    ).toBe(true);
  });
});

describe('defaultFlowNameForFlow (시연 지적 2항)', () => {
  it('녹화 시작 탭의 제목을 쓴다', () => {
    const flow = makeFlow();
    flow.meta!.startTitle = 'Example Domain';
    const at = new Date('2026-09-05T00:00:00.000Z');
    expect(defaultFlowNameForFlow(flow, at)).toBe('Example Domain 2026.09.05');
  });

  it('제목이 없으면 시작 주소의 도메인을 쓴다', () => {
    const flow = makeFlow();
    delete flow.meta!.startTitle;
    const at = new Date('2026-09-05T00:00:00.000Z');
    expect(defaultFlowNameForFlow(flow, at)).toBe('example.com 2026.09.05');
  });

  it('흐름 밖(지금 활성 탭)의 제목은 절대 끼어들지 않는다', () => {
    const flow = makeFlow();
    delete flow.meta!.startTitle;
    // 인자가 흐름 하나뿐이라 다른 탭의 제목이 들어올 통로 자체가 없다.
    expect(defaultFlowNameForFlow(flow)).not.toContain('네이버');
  });
});

describe('requiredRunVariables', () => {
  it('민감 변수와 기본값이 빈 변수만 실행 전에 입력받는다', () => {
    const flow = makeFlow();
    flow.variables = [
      { key: 'password', sensitive: true },
      { key: 'userid', default: 'hong@example.com' },
      { key: 'memo', default: '' },
    ];
    expect(requiredRunVariables(flow).map((v) => v.key)).toEqual(['password', 'memo']);
  });
});
