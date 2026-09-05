import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import {
  MAX_RESULT_IMAGES,
  MAX_STEPS,
  runSteps,
  validateFlow,
  type RunnerStep,
  type ToolInvoker,
} from './batch-runner';
import { areTemplatesActive } from '@/utils/step-template';

/**
 * auto-chrome-mcp fork: 여러 도구 호출을 한 번의 MCP 왕복으로 묶어 실행한다.
 * click → fill → click → screenshot 같은 연쇄 작업에서 왕복 지연을 크게 줄인다.
 *
 * 실행 루프 자체는 chrome_shortcut 과 공유한다 (./batch-runner.ts).
 */

interface BatchToolParams {
  steps: RunnerStep[];
  continueOnError?: boolean;
  /** auto-chrome-mcp fork(P1): 레인 이름 — step 마다 그대로 전달된다. */
  lane?: string;
  _mcpSessionId?: string;
  /** 값 전달 치환을 강제로 켠다 (새 흐름 키가 하나라도 있으면 자동으로 켜진다). */
  templates?: boolean;
  /** 응답에 실을 `as` 이름 목록. 없으면 results 필드를 아예 싣지 않는다. */
  return?: string[];
  /**
   * auto-chrome-mcp fork(2026-09-05): 지금 하는 작업을 한 문구로. 실행하는 동안 MCP 탭
   * 그룹 라벨이 이 문구가 되고, 끝나면 "MCP" 로 돌아간다. 무간섭 모드에서는 탭이 배경에
   * 조용히 열리므로 사용자가 무엇이 도는지 아는 유일한 표시가 그룹 라벨이다.
   */
  task?: string;
}

/**
 * auto-chrome-mcp fork: batch 안에서 실행하면 안 되는 도구들.
 * - chrome_batch: 중첩 금지 (무한 재귀/폭주 방지)
 * - 나머지: 사용자 대면 상호작용이거나 세션 상태를 바꿔 batch 뒤 단계의 전제를 깨뜨림
 */
const DISALLOWED_STEP_TOOLS = new Set<string>([
  'chrome_batch',
  'chrome_switch_tab',
  'chrome_request_element_selection',
  'chrome_request_user_consent',
  'record_replay_flow_run',
]);

/**
 * auto-chrome-mcp fork: 순환 import 를 피하기 위한 invoker 주입.
 * tools/index.ts 가 setBatchToolInvoker(handleCallTool) 로 배선한다.
 * (batch.ts 가 tools/index.ts 를 직접 import 하면 index → browser → batch → index 순환)
 */
let invoker: ToolInvoker | null = null;

export function setBatchToolInvoker(fn: ToolInvoker) {
  invoker = fn;
}

/**
 * Execute a sequence of tool calls in a single MCP round trip
 */
class BatchTool extends BaseBrowserToolExecutor {
  name = 'chrome_batch';

  async execute(args: BatchToolParams): Promise<ToolResult> {
    const { steps, continueOnError, lane, _mcpSessionId } = args || ({} as BatchToolParams);

    if (!Array.isArray(steps) || steps.length === 0) {
      return createErrorResponse('steps must be a non-empty array');
    }
    if (steps.length > MAX_STEPS) {
      return createErrorResponse(`steps must contain at most ${MAX_STEPS} items`);
    }
    // 배선 여부를 지역 const 로 고정 (모듈 레벨 let 은 실행 중 재할당될 수 있음)
    const invoke = invoker;
    if (!invoke) {
      return createErrorResponse('batch invoker not wired');
    }

    const templatesEnabled = areTemplatesActive(args);
    const returnNames = args?.return;
    if (templatesEnabled) {
      const flowError = validateFlow(steps, returnNames);
      if (flowError) {
        return createErrorResponse(flowError);
      }
    }

    const outcome = await runSteps({
      steps,
      invoke,
      continueOnError,
      lane,
      mcpSessionId: _mcpSessionId,
      disallowedTools: DISALLOWED_STEP_TOOLS,
      containerLabel: 'chrome_batch',
      skippedNote: 'skipped (batch stopped at earlier failing step)',
      collectImages: true,
      templatesEnabled,
      returnNames: templatesEnabled && Array.isArray(returnNames) ? returnNames : undefined,
      taskTitle: typeof args?.task === 'string' ? args.task : undefined,
    });

    // 상한을 넘으면 최신 것부터 남긴다 — 체인의 마지막 스크린샷이 보통 가장 중요하다.
    const keptImages = outcome.images.slice(-MAX_RESULT_IMAGES);
    const droppedImages = outcome.images.length - keptImages.length;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: outcome.success,
            steps: outcome.results,
            ...(outcome.stoppedAtStep !== undefined
              ? { stoppedAtStep: outcome.stoppedAtStep }
              : {}),
            ...(keptImages.length > 0
              ? {
                  attachedImages: keptImages.map((img) => ({ step: img.index, tool: img.tool })),
                }
              : {}),
            ...(droppedImages > 0
              ? {
                  droppedImages,
                  droppedImagesNote: `Only the last ${MAX_RESULT_IMAGES} image(s) are attached. Split the batch or drop screenshot steps if you need the earlier ones.`,
                }
              : {}),
            ...(outcome.stoppedBy !== undefined ? { stoppedBy: outcome.stoppedBy } : {}),
            ...(outcome.returned !== undefined ? { results: outcome.returned } : {}),
            ...(outcome.resultsTruncated !== undefined
              ? { resultsTruncated: outcome.resultsTruncated }
              : {}),
          }),
        },
        ...keptImages.map((img) => img.content),
      ],
      // 단계별 실패는 본문 JSON 으로 보고한다 (batch 자체가 잘못된 경우만 isError:true).
      isError: false,
    };
  }
}

export const batchTool = new BatchTool();
