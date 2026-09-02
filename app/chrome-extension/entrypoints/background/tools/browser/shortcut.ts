import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';

/**
 * auto-chrome-mcp fork: chrome_shortcut — chrome_batch 의 step 목록을 이름 붙여 저장해두고
 * 나중에 이름만으로 재실행하는 "저장된 매크로". 반복되는 로그인 흐름·정기 수집 루틴처럼
 * 세션이 바뀌어도 다시 쓰고 싶은 작업을 chrome.storage.local 에 영속 저장한다.
 */

interface ShortcutStep {
  tool: string;
  args?: Record<string, any>;
}

interface ShortcutToolParams {
  action: 'save' | 'run' | 'list' | 'delete';
  name?: string;
  steps?: ShortcutStep[];
  description?: string;
  continueOnError?: boolean;
  /** auto-chrome-mcp fork(P1): 레인 이름 — step 마다 그대로 전달된다. */
  lane?: string;
  _mcpSessionId?: string;
}

interface StoredShortcut {
  steps: ShortcutStep[];
  description?: string;
  createdAt: number;
  updatedAt: number;
  runCount: number;
}

interface ShortcutStepResult {
  index: number;
  tool: string;
  ok: boolean;
  resultText?: string;
  error?: string;
}

const MAX_STEPS = 20;
const MAX_RESULT_TEXT_LENGTH = 4000;
const MAX_SHORTCUTS = 50;
const MAX_NAME_LENGTH = 64;
const STORAGE_KEY = 'mcpShortcuts';

/**
 * auto-chrome-mcp fork: chrome_batch 의 DISALLOWED_STEP_TOOLS 와 같은 취지의 목록.
 * batch.ts 는 이 집합을 export 하지 않고(barrel 규약상 이 작업은 이 파일만 수정하도록
 * 지시받음) 이 파일에서 직접 import 할 경로도 없으므로, 동일 목록을 여기서 다시 정의하고
 * orchestrator 자기 자신(chrome_shortcut)을 추가한다 — 매크로 안에 매크로를 저장하는
 * 중첩을 막기 위해서다.
 */
const DISALLOWED_STEP_TOOLS = new Set<string>([
  'chrome_batch',
  'chrome_shortcut',
  'chrome_switch_tab',
  'chrome_request_element_selection',
  'chrome_request_user_consent',
  'record_replay_flow_run',
]);

/**
 * auto-chrome-mcp fork: 순환 import 를 피하기 위한 invoker 주입 (batch.ts 와 동일 패턴).
 * tools/index.ts 가 setShortcutToolInvoker(handleCallTool) 로 배선한다.
 */
type ToolInvoker = (param: { name: string; args: any }) => Promise<any>;

let invoker: ToolInvoker | null = null;

export function setShortcutToolInvoker(fn: ToolInvoker) {
  invoker = fn;
}

/**
 * 결과의 모든 text content 를 이어붙여 잘라낸다 (batch.ts extractResultText 와 동일 로직 —
 * new_tabs_opened 같은 부가 알림이 두 번째 text 항목으로 붙는 경우를 놓치지 않기 위함).
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

async function loadShortcuts(): Promise<Record<string, StoredShortcut>> {
  const r = await chrome.storage.local.get([STORAGE_KEY]);
  const raw = (r as any)?.[STORAGE_KEY];
  return raw && typeof raw === 'object' ? (raw as Record<string, StoredShortcut>) : {};
}

async function saveShortcuts(map: Record<string, StoredShortcut>): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: map });
}

/**
 * 이름 검증: 공백 trim, 길이 1-64, '/' 및 제어문자 금지 (경로/저장소 오염 방지).
 */
function validateName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_NAME_LENGTH) return null;
  if (trimmed.includes('/')) return null;
  // 제어문자 금지 (no-control-regex 회피를 위해 코드포인트로 검사)
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return null;
  }
  return trimmed;
}

type StepsValidation = { ok: true; steps: ShortcutStep[] } | { ok: false; error: string };

/**
 * batch.ts 의 step 검증과 동일한 규칙 + chrome_shortcut/chrome_batch 중첩 금지.
 */
function validateSteps(steps: unknown): StepsValidation {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: false, error: 'steps must be a non-empty array' };
  }
  if (steps.length > MAX_STEPS) {
    return { ok: false, error: `steps must contain at most ${MAX_STEPS} items` };
  }

  for (const raw of steps) {
    const toolName = typeof (raw as any)?.tool === 'string' ? (raw as any).tool.trim() : '';
    if (!toolName) {
      return { ok: false, error: 'each step must have a non-empty "tool" string' };
    }
    const argsInvalid =
      (raw as any)?.args !== undefined &&
      (typeof (raw as any).args !== 'object' ||
        (raw as any).args === null ||
        Array.isArray((raw as any).args));
    if (argsInvalid) {
      return { ok: false, error: `step "${toolName}": args must be an object` };
    }
    if (DISALLOWED_STEP_TOOLS.has(toolName)) {
      return { ok: false, error: `tool "${toolName}" is not allowed inside a chrome_shortcut` };
    }
  }

  return { ok: true, steps: steps as ShortcutStep[] };
}

function notFoundError(name: string, available: string[]): ToolResult {
  return createErrorResponse(
    available.length > 0
      ? `shortcut "${name}" not found. Available: ${available.join(', ')}`
      : `shortcut "${name}" not found. No shortcuts are saved yet.`,
  );
}

class ShortcutTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SHORTCUT;

  async execute(args: ShortcutToolParams): Promise<ToolResult> {
    const action = args?.action;

    switch (action) {
      case 'save':
        return this.handleSave(args);
      case 'run':
        return this.handleRun(args);
      case 'list':
        return this.handleList();
      case 'delete':
        return this.handleDelete(args);
      default:
        return createErrorResponse('action must be one of "save", "run", "list", "delete"');
    }
  }

  private async handleSave(args: ShortcutToolParams): Promise<ToolResult> {
    const name = validateName(args?.name);
    if (!name) {
      return createErrorResponse(
        'name must be a 1-64 character string without "/" or control characters',
      );
    }

    const validation = validateSteps(args?.steps);
    if (!validation.ok) {
      return createErrorResponse(validation.error);
    }

    const shortcuts = await loadShortcuts();
    const existing = Object.prototype.hasOwnProperty.call(shortcuts, name)
      ? shortcuts[name]
      : undefined;
    const replaced = existing !== undefined;

    if (!replaced && Object.keys(shortcuts).length >= MAX_SHORTCUTS) {
      return createErrorResponse(
        `at most ${MAX_SHORTCUTS} shortcuts can be saved — delete one before saving a new one`,
      );
    }

    const now = Date.now();
    const description =
      typeof args?.description === 'string' && args.description.trim().length > 0
        ? args.description.trim()
        : undefined;

    shortcuts[name] = {
      steps: validation.steps,
      description,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      // auto-chrome-mcp fork: 덮어쓰기는 새 정의로 취급 — 실행 횟수는 리셋한다.
      runCount: 0,
    };

    await saveShortcuts(shortcuts);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            name,
            stepCount: validation.steps.length,
            replaced,
          }),
        },
      ],
      isError: false,
    };
  }

  private async handleRun(args: ShortcutToolParams): Promise<ToolResult> {
    const name = validateName(args?.name);
    if (!name) {
      return createErrorResponse(
        'name must be a 1-64 character string without "/" or control characters',
      );
    }

    // 배선 여부를 지역 const 로 고정 (모듈 레벨 let 은 실행 중 재할당될 수 있음)
    const invoke = invoker;
    if (!invoke) {
      return createErrorResponse('shortcut invoker not wired');
    }

    const shortcuts = await loadShortcuts();
    const stored = shortcuts[name];
    if (!stored) {
      return notFoundError(name, Object.keys(shortcuts));
    }

    const { continueOnError, lane, _mcpSessionId } = args || ({} as ShortcutToolParams);
    const steps = Array.isArray(stored.steps) ? stored.steps : [];

    const results: ShortcutStepResult[] = [];
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
          error: 'skipped (shortcut stopped at earlier failing step)',
        });
        continue;
      }

      const toolName = typeof step?.tool === 'string' ? step.tool.trim() : '';

      const argsInvalid =
        step?.args !== undefined &&
        (typeof step.args !== 'object' || step.args === null || Array.isArray(step.args));

      let stepResult: ShortcutStepResult;
      if (!toolName) {
        stepResult = { index, tool: '', ok: false, error: 'step.tool must be a non-empty string' };
      } else if (argsInvalid) {
        stepResult = { index, tool: toolName, ok: false, error: 'step.args must be an object' };
      } else if (DISALLOWED_STEP_TOOLS.has(toolName)) {
        stepResult = {
          index,
          tool: toolName,
          ok: false,
          error: `tool "${toolName}" is not allowed inside chrome_shortcut`,
        };
      } else {
        // auto-chrome-mcp fork: run 호출 자체의 세션 id 를 각 단계에 주입 —
        // 세션별 작업 탭 라우팅이 단계마다 동일하게 적용되도록.
        const stepArgs = { ...(step?.args ?? {}) } as Record<string, any>;
        if (typeof _mcpSessionId === 'string' && _mcpSessionId) {
          stepArgs._mcpSessionId = _mcpSessionId;
        }
        // auto-chrome-mcp fork(P1): 레인도 함께 물려준다.
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

    // 실행 횟수 반영 — 재조회 없이 이미 들고 있는 맵에 반영 후 그대로 저장.
    stored.runCount = (stored.runCount || 0) + 1;
    shortcuts[name] = stored;
    await saveShortcuts(shortcuts);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success,
            name,
            steps: results,
            ...(stoppedAtStep !== undefined ? { stoppedAtStep } : {}),
          }),
        },
      ],
      // 단계별 실패는 본문 JSON 으로 보고한다 (chrome_shortcut 자체가 잘못된 경우만 isError:true).
      isError: false,
    };
  }

  private async handleList(): Promise<ToolResult> {
    const shortcuts = await loadShortcuts();

    // 전체 step args 는 절대 덤프하지 않는다 — 목록은 가볍게 유지.
    const list = Object.entries(shortcuts).map(([name, s]) => ({
      name,
      description: s.description,
      stepCount: Array.isArray(s.steps) ? s.steps.length : 0,
      tools: Array.from(new Set((s.steps || []).map((step) => step.tool))),
      createdAt: s.createdAt,
      runCount: s.runCount || 0,
    }));

    return {
      content: [{ type: 'text', text: JSON.stringify({ success: true, shortcuts: list }) }],
      isError: false,
    };
  }

  private async handleDelete(args: ShortcutToolParams): Promise<ToolResult> {
    const name = validateName(args?.name);
    if (!name) {
      return createErrorResponse(
        'name must be a 1-64 character string without "/" or control characters',
      );
    }

    const shortcuts = await loadShortcuts();
    if (!Object.prototype.hasOwnProperty.call(shortcuts, name)) {
      return notFoundError(name, Object.keys(shortcuts));
    }

    delete shortcuts[name];
    await saveShortcuts(shortcuts);

    return {
      content: [{ type: 'text', text: JSON.stringify({ success: true, name, deleted: true }) }],
      isError: false,
    };
  }
}

export const shortcutTool = new ShortcutTool();
