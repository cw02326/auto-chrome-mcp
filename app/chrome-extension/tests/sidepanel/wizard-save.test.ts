/**
 * 저장 화면의 저장·발행 절차 (2026-09-05 시연 지적 3항).
 *
 * 시연에서 이름을 "example 링크 클릭 시연" 으로 고치고 "저장하고 발행" 을 눌렀는데 발행
 * 목록에는 옛 기본 이름이 실렸다. 원인이 무엇이든, 고친 내용이 발행까지 그대로 가야 한다는
 * 계약은 합성 이벤트와 무관하게 여기서 고정한다.
 *   - 편집 결과(`applyWizardEdits`) → 저장 → 발행이 **같은 객체 하나**를 본다.
 *   - 저장이 실패하면 발행하지 않는다.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  applyWizardEdits,
  detectVariables,
  type WizardFlow,
} from '@/entrypoints/sidepanel/utils/flow-wizard';
import {
  saveAndMaybePublish,
  type WizardSaveDeps,
} from '@/entrypoints/sidepanel/utils/wizard-save';

/** 저장·발행 대역. 인자 타입을 명시해야 호출 기록을 그대로 들여다볼 수 있다. */
function makeDeps() {
  const saveFlow = vi.fn<WizardSaveDeps['saveFlow']>(async () => {});
  const publishFlow = vi.fn<WizardSaveDeps['publishFlow']>(async () => {});
  return { saveFlow, publishFlow };
}

function recordedFlow(): WizardFlow {
  return {
    id: 'flow_1757000000000',
    name: 'new_workflow',
    version: 1,
    startUrl: 'https://example.com/',
    meta: {
      createdAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:00:00.000Z',
      startTitle: 'Example Domain',
    },
    nodes: [{ id: 'n1', type: 'navigate', config: { url: 'https://example.com/' } }],
    edges: [],
  };
}

/** 사용자가 이름을 고친 뒤 저장 버튼을 누른 상태를 그대로 만든다. */
function editedWithName(newName: string): WizardFlow {
  const source = recordedFlow();
  const { flow } = applyWizardEdits(source, {
    name: newName,
    startUrl: source.startUrl ?? '',
    variables: detectVariables(source),
    removedNodeIds: [],
  });
  return flow;
}

describe('saveAndMaybePublish', () => {
  it('고친 이름이 저장과 발행에 똑같이 실린다', async () => {
    const { saveFlow, publishFlow } = makeDeps();
    const edited = editedWithName('example 링크 클릭 시연');

    const result = await saveAndMaybePublish({ saveFlow, publishFlow }, edited, { publish: true });

    expect(saveFlow).toHaveBeenCalledTimes(1);
    expect(saveFlow.mock.calls[0][0].name).toBe('example 링크 클릭 시연');

    expect(publishFlow).toHaveBeenCalledTimes(1);
    expect(publishFlow.mock.calls[0][0]).toBe(edited.id);
    // 발행이 저장소를 다시 읽지 않도록 흐름 본문을 함께 넘긴다.
    expect(publishFlow.mock.calls[0][1]?.flow?.name).toBe('example 링크 클릭 시연');
    // 저장에 넘긴 객체와 발행에 넘긴 객체가 같은 것이어야 한다.
    expect(publishFlow.mock.calls[0][1]?.flow).toBe(saveFlow.mock.calls[0][0]);
    expect(result.published).toBe(true);
  });

  it('저장만 누르면 발행하지 않는다', async () => {
    const { saveFlow, publishFlow } = makeDeps();

    const result = await saveAndMaybePublish({ saveFlow, publishFlow }, editedWithName('저장만'), {
      publish: false,
    });

    expect(saveFlow).toHaveBeenCalledTimes(1);
    expect(publishFlow).not.toHaveBeenCalled();
    expect(result.published).toBe(false);
  });

  it('저장이 실패하면 발행하지 않는다', async () => {
    const { publishFlow } = makeDeps();
    const saveFlow = vi.fn<WizardSaveDeps['saveFlow']>(async () => {
      throw new Error('storage full');
    });

    await expect(
      saveAndMaybePublish({ saveFlow, publishFlow }, editedWithName('실패'), { publish: true }),
    ).rejects.toThrow('storage full');
    expect(publishFlow).not.toHaveBeenCalled();
  });
});
