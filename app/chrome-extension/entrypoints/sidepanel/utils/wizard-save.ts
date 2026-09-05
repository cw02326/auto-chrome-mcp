/**
 * 저장 화면의 저장·발행 절차 (2026-09-05 시연 지적 3항).
 *
 * 화면 컴포넌트에서 떼어 낸 이유는 하나다. 시연에서 "이름을 고치고 저장하고 발행" 했는데
 * 발행 목록에는 **옛 이름**이 실렸다. 저장과 발행이 서로 다른 흐름 객체를 볼 여지가 있으면
 * 안 되고, 그 계약은 눈으로 보는 대신 테스트로 고정해야 한다.
 *
 * 여기서 지키는 규칙.
 *   1. 저장에 넘긴 흐름 객체를 **그대로** 발행에도 넘긴다. 발행이 저장소를 다시 읽지 않는다.
 *   2. 저장이 실패하면 발행하지 않는다.
 */

import type { WizardFlow } from './flow-wizard';

export interface WizardSaveDeps {
  saveFlow: (flow: WizardFlow) => Promise<void>;
  publishFlow: (flowId: string, options?: { flow?: WizardFlow }) => Promise<void>;
}

export interface WizardSaveResult {
  flow: WizardFlow;
  published: boolean;
}

/**
 * 흐름을 저장하고, 요청하면 같은 내용을 이어서 발행한다.
 *
 * 예외는 그대로 올린다 - 화면이 잡아서 문구로 보여 준다.
 */
export async function saveAndMaybePublish(
  deps: WizardSaveDeps,
  flow: WizardFlow,
  options: { publish: boolean },
): Promise<WizardSaveResult> {
  await deps.saveFlow(flow);
  if (!options.publish) return { flow, published: false };
  // 저장한 그 객체를 넘긴다. id 로 다시 읽게 하면 그 사이에 무엇이 어긋나든 옛 내용이
  // 발행될 수 있다 (시연에서 실제로 옛 이름이 발행됐다).
  await deps.publishFlow(flow.id, { flow });
  return { flow, published: true };
}
