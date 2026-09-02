import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';

/**
 * auto-chrome-mcp fork: 여러 도구 호출을 한 번의 MCP 왕복으로 묶어 실행한다.
 * click → fill → click → screenshot 같은 연쇄 작업에서 왕복 지연을 크게 줄인다.
 */

interface BatchStep {
  tool: string;
  args?: Record<string, any>;
}

interface BatchToolParams {
  steps: BatchStep[];
  continueOnError?: boolean;
  /** auto-chrome-mcp fork(P1): 레인 이름 — step 마다 그대로 전달된다. */
  lane?: string;
  _mcpSessionId?: string;
}

interface BatchStepResult {
  index: number;
  tool: string;
  ok: boolean;
  resultText?: string;
  error?: string;
  /** auto-chrome-mcp fork: 이 스텝이 돌려준 이미지 수 (요약 JSON 뒤에 순서대로 붙는다). */
  images?: number;
}

/** auto-chrome-mcp fork: 스텝이 만든 이미지 1장 — 어느 스텝에서 나왔는지 기억해 둔다. */
interface StepImage {
  index: number;
  tool: string;
  content: { type: 'image'; data: string; mimeType: string };
}

const MAX_STEPS = 20;
const MAX_RESULT_TEXT_LENGTH = 4000;
/**
 * auto-chrome-mcp fork: batch 가 돌려줄 이미지 최대 개수.
 * 스키마가 권하는 `click -> fill -> screenshot` 체인이 실제로 그림을 받게 하되,
 * 20 스텝이 전부 스크린샷일 때 컨텍스트가 터지지 않도록 뒤에서부터 이만큼만 남긴다.
 */
const MAX_RESULT_IMAGES = 4;

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
type ToolInvoker = (param: { name: string; args: any }) => Promise<any>;

let invoker: ToolInvoker | null = null;

export function setBatchToolInvoker(fn: ToolInvoker) {
  invoker = fn;
}

/**
 * 결과의 모든 text content 를 이어붙여 잘라낸다.
 * (게이트가 new_tabs_opened 같은 알림을 두 번째 text 항목으로 첨부하므로
 *  첫 항목만 취하면 팝업 감지 알림이 유실된다 — auto-chrome-mcp fork)
 */
function extractResultText(result: any): string | undefined {
  const content = Array.isArray(result?.content) ? result.content : null;
  if (!content) return undefined;
  const texts = content
    .filter((item: any) => item?.type === 'text' && typeof item.text === 'string')
    .map((item: any) => item.text);
  if (texts.length === 0) return undefined;
  const text: string = texts.join('\n');
  return text.length > MAX_RESULT_TEXT_LENGTH
    ? `${text.slice(0, MAX_RESULT_TEXT_LENGTH)}... [truncated]`
    : text;
}

/**
 * auto-chrome-mcp fork: 스텝 결과에서 이미지 content 를 꺼낸다.
 *
 * 예전엔 텍스트만 이어붙이고 이미지를 통째로 버렸다 — 스키마는
 * `click -> fill -> click -> screenshot` 체인을 권하는데 정작 그림이 안 돌아왔다
 * (chrome_screenshot / chrome_computer 가 image content 를 돌려준다).
 */
function extractResultImages(result: any): StepImage['content'][] {
  const content = Array.isArray(result?.content) ? result.content : null;
  if (!content) return [];
  return content
    .filter(
      (item: any) =>
        item?.type === 'image' && typeof item.data === 'string' && item.data.length > 0,
    )
    .map((item: any) => ({
      type: 'image' as const,
      data: item.data as string,
      mimeType: typeof item.mimeType === 'string' ? item.mimeType : 'image/png',
    }));
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

    const results: BatchStepResult[] = [];
    // auto-chrome-mcp fork: 스텝이 만든 이미지는 요약 JSON 뒤에 순서대로 붙여 돌려준다.
    const images: StepImage[] = [];
    let stoppedAtStep: number | undefined;
    let success = true;

    for (let index = 0; index < steps.length; index++) {
      const step = steps[index];

      // 이미 실패해서 중단된 경우: 남은 단계는 skipped 로 보고
      if (stoppedAtStep !== undefined) {
        results.push({
          index,
          tool: typeof step?.tool === 'string' ? step.tool : '',
          ok: false,
          error: 'skipped (batch stopped at earlier failing step)',
        });
        continue;
      }

      const toolName = typeof step?.tool === 'string' ? step.tool.trim() : '';

      const argsInvalid =
        step?.args !== undefined &&
        (typeof step.args !== 'object' || step.args === null || Array.isArray(step.args));

      let stepResult: BatchStepResult;
      if (!toolName) {
        stepResult = { index, tool: '', ok: false, error: 'step.tool must be a non-empty string' };
      } else if (argsInvalid) {
        stepResult = { index, tool: toolName, ok: false, error: 'step.args must be an object' };
      } else if (DISALLOWED_STEP_TOOLS.has(toolName)) {
        stepResult = {
          index,
          tool: toolName,
          ok: false,
          error: `tool "${toolName}" is not allowed inside chrome_batch`,
        };
      } else {
        // auto-chrome-mcp fork: batch 호출 자체의 세션 id 를 각 단계에 주입 —
        // 세션별 작업 탭 라우팅이 단계마다 동일하게 적용되도록.
        const stepArgs = { ...(step?.args ?? {}) } as Record<string, any>;
        if (typeof _mcpSessionId === 'string' && _mcpSessionId) {
          stepArgs._mcpSessionId = _mcpSessionId;
        }
        // auto-chrome-mcp fork(P1): 레인도 함께 물려줘야 step 이 같은 작업 탭을 본다.
        if (typeof lane === 'string' && lane && stepArgs.lane === undefined) {
          stepArgs.lane = lane;
        }

        try {
          const raw = await invoke({ name: toolName, args: stepArgs });
          const ok = raw?.isError !== true;
          const text = extractResultText(raw);
          stepResult = { index, tool: toolName, ok };
          if (ok) {
            if (text !== undefined) stepResult.resultText = text;
          } else {
            stepResult.error = text || 'tool returned an error';
          }
          // 실패 스텝의 이미지(게이트가 붙인 실패 스크린샷)도 원인 파악에 필요하므로 함께 모은다.
          const stepImages = extractResultImages(raw);
          if (stepImages.length > 0) {
            stepResult.images = stepImages.length;
            for (const content of stepImages) {
              images.push({ index, tool: toolName, content });
            }
          }
        } catch (error) {
          stepResult = {
            index,
            tool: toolName,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      results.push(stepResult);

      if (!stepResult.ok) {
        success = false;
        if (!continueOnError) {
          stoppedAtStep = index;
        }
      }
    }

    // 상한을 넘으면 최신 것부터 남긴다 — 체인의 마지막 스크린샷이 보통 가장 중요하다.
    const keptImages = images.slice(-MAX_RESULT_IMAGES);
    const droppedImages = images.length - keptImages.length;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success,
            steps: results,
            ...(stoppedAtStep !== undefined ? { stoppedAtStep } : {}),
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
