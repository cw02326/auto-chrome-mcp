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
  _mcpSessionId?: string;
}

interface BatchStepResult {
  index: number;
  tool: string;
  ok: boolean;
  resultText?: string;
  error?: string;
}

const MAX_STEPS = 20;
const MAX_RESULT_TEXT_LENGTH = 4000;

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
 * Execute a sequence of tool calls in a single MCP round trip
 */
class BatchTool extends BaseBrowserToolExecutor {
  name = 'chrome_batch';

  async execute(args: BatchToolParams): Promise<ToolResult> {
    const { steps, continueOnError, _mcpSessionId } = args || ({} as BatchToolParams);

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

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success,
            steps: results,
            ...(stoppedAtStep !== undefined ? { stoppedAtStep } : {}),
          }),
        },
      ],
      // 단계별 실패는 본문 JSON 으로 보고한다 (batch 자체가 잘못된 경우만 isError:true).
      isError: false,
    };
  }
}

export const batchTool = new BatchTool();
