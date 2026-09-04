import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import {
  MAX_STEPS,
  collectFlowParamNames,
  isRepeatGroup,
  runSteps,
  validateFlow,
  type RunnerStep,
  type ToolInvoker,
} from './batch-runner';
import { AS_NAME_PATTERN, areTemplatesActive } from '@/utils/step-template';

/**
 * auto-chrome-mcp fork: chrome_shortcut — chrome_batch 의 step 목록을 이름 붙여 저장해두고
 * 나중에 이름만으로 재실행하는 "저장된 매크로". 반복되는 로그인 흐름·정기 수집 루틴처럼
 * 세션이 바뀌어도 다시 쓰고 싶은 작업을 chrome.storage.local 에 영속 저장한다.
 *
 * 실행 루프는 chrome_batch 와 공유한다 (./batch-runner.ts).
 */

type ShortcutStep = RunnerStep;

interface ShortcutToolParams {
  action: 'save' | 'run' | 'list' | 'delete';
  name?: string;
  steps?: ShortcutStep[];
  description?: string;
  continueOnError?: boolean;
  /** auto-chrome-mcp fork(P1): 레인 이름 — step 마다 그대로 전달된다. */
  lane?: string;
  _mcpSessionId?: string;
  /** action="save": 값 전달 치환을 강제로 켠다. */
  templates?: boolean;
  /** action="run": 응답에 실을 `as` 이름 목록. */
  return?: string[];
  /** action="save": 파라미터 선언. action="run": 파라미터 값. */
  params?: Record<string, unknown>;
}

/** `params` 선언 하나 (설계 3절). */
interface ParamDeclaration {
  required?: boolean;
  default?: unknown;
  secret?: boolean;
  description?: string;
}

interface StoredShortcut {
  steps: ShortcutStep[];
  description?: string;
  createdAt: number;
  updatedAt: number;
  runCount: number;
  /** 저장된 파라미터 선언. 실행 시 전달된 값은 절대 여기 남기지 않는다. */
  params?: Record<string, ParamDeclaration>;
  /**
   * 이 레코드가 값 전달 치환을 쓰는가. 필드가 없는 legacy 레코드는 절대 치환하지 않는다
   * (설계 1절 "활성화 규칙" — 기존 저장본의 실행 의미를 한 글자도 바꾸지 않기 위해서다).
   */
  templates?: boolean;
}

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
 * v2 레코드가 step args 에 담을 수 없는 대상 지정 키 (설계 3절).
 * 저장된 탭 id 는 시간이 지나면 다른 탭, 곧 사용자 탭을 가리킨다.
 */
const STALE_TARGET_KEYS: ReadonlySet<string> = new Set(['tabId', 'windowId', 'tabIds']);

/**
 * auto-chrome-mcp fork: 순환 import 를 피하기 위한 invoker 주입 (batch.ts 와 동일 패턴).
 * tools/index.ts 가 setShortcutToolInvoker(handleCallTool) 로 배선한다.
 */
let invoker: ToolInvoker | null = null;

export function setShortcutToolInvoker(fn: ToolInvoker) {
  invoker = fn;
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

/** 중첩 깊이와 무관하게 이 이름의 키가 있는지 본다. */
function findKeyDeep(value: unknown, keys: ReadonlySet<string>): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findKeyDeep(item, keys);
      if (hit) return hit;
    }
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (keys.has(key)) return key;
    const hit = findKeyDeep((value as Record<string, unknown>)[key], keys);
    if (hit) return hit;
  }
  return null;
}

type StepsValidation = { ok: true; steps: ShortcutStep[] } | { ok: false; error: string };

/**
 * batch.ts 의 step 검증과 동일한 규칙 + chrome_shortcut/chrome_batch 중첩 금지.
 * v2 레코드는 저장 시점에 박제되는 대상 지정 키를 함께 거절한다.
 */
function validateSteps(steps: unknown, isV2: boolean): StepsValidation {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: false, error: 'steps must be a non-empty array' };
  }
  if (steps.length > MAX_STEPS) {
    return { ok: false, error: `steps must contain at most ${MAX_STEPS} items` };
  }

  for (const raw of steps) {
    // auto-chrome-mcp fork(2026-09-04 Codex 최종 검토 항목 5): 반복 묶음 항목에는 `tool` 이
    // 없다. 예전에는 모든 top-level 항목에 tool 을 요구해, 설계 7절 예시 (b) 의 묶음을
    // shortcut 으로 저장하는 길이 아예 막혀 있었다(batch 로만 쓸 수 있었다).
    if (isRepeatGroup(raw)) {
      const inner = (raw as any).steps;
      if (!Array.isArray(inner) || inner.length === 0) {
        return {
          ok: false,
          error: 'repeat_invalid: a repeat group must have a non-empty "steps" array',
        };
      }
      if (inner.length > MAX_STEPS) {
        return {
          ok: false,
          error: `repeat_invalid: a repeat group must contain at most ${MAX_STEPS} steps`,
        };
      }
      for (const child of inner) {
        const childError = validateOneStep(child, isV2);
        if (childError) return { ok: false, error: childError };
      }
      continue;
    }
    const error = validateOneStep(raw, isV2);
    if (error) return { ok: false, error };
  }

  return { ok: true, steps: steps as ShortcutStep[] };
}

/** `list` 에 실을 도구 이름 - 묶음은 "repeat" 와 안쪽 도구 이름을 함께 낸다. */
function collectStepToolNames(steps: unknown): string[] {
  if (!Array.isArray(steps)) return [];
  const names: string[] = [];
  for (const step of steps) {
    if (isRepeatGroup(step)) {
      names.push('repeat', ...collectStepToolNames((step as any).steps));
      continue;
    }
    if (typeof (step as any)?.tool === 'string') names.push((step as any).tool);
  }
  return names;
}

/** step 하나(묶음 안쪽 포함)의 규칙. 문제가 있으면 문구를, 없으면 null 을 돌려준다. */
function validateOneStep(raw: unknown, isV2: boolean): string | null {
  const toolName = typeof (raw as any)?.tool === 'string' ? (raw as any).tool.trim() : '';
  if (!toolName) {
    return 'each step must have a non-empty "tool" string';
  }
  const argsInvalid =
    (raw as any)?.args !== undefined &&
    (typeof (raw as any).args !== 'object' ||
      (raw as any).args === null ||
      Array.isArray((raw as any).args));
  if (argsInvalid) {
    return `step "${toolName}": args must be an object`;
  }
  if (DISALLOWED_STEP_TOOLS.has(toolName)) {
    return `tool "${toolName}" is not allowed inside a chrome_shortcut`;
  }
  if (isV2) {
    const stale = findKeyDeep((raw as any)?.args, STALE_TARGET_KEYS);
    if (stale) {
      return `stale_target_forbidden: step "${toolName}" stores "${stale}", which points at a different tab later`;
    }
    if (
      toolName === TOOL_NAMES.BROWSER.CLOSE_TABS &&
      findKeyDeep((raw as any)?.args, new Set(['url']))
    ) {
      return `stale_target_forbidden: step "${toolName}" stores "url", which picks tabs to close later`;
    }
  }
  return null;
}

/** 한 shortcut 이 선언할 수 있는 파라미터 수 (설계 3절). */
const MAX_PARAMS = 16;

/** 선언에서 허용하는 필드. 그 밖의 필드는 param_declaration_invalid. */
const PARAM_FIELDS: ReadonlySet<string> = new Set(['required', 'default', 'secret', 'description']);

/** 8자 미만 비밀은 응답 곳곳에서 우연히 일치할 수 있어 경고를 붙인다. */
const SHORT_SECRET_LENGTH = 8;

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

type ParamDeclarationValidation =
  | { ok: true; declarations?: Record<string, ParamDeclaration> }
  | { ok: false; error: string };

/** action="save" 의 `params` 선언을 검증한다 (설계 3절). */
function validateParamDeclarations(params: unknown): ParamDeclarationValidation {
  if (params === undefined) return { ok: true };
  if (!isPlainObject(params)) {
    return { ok: false, error: 'param_declaration_invalid: "params" must be an object' };
  }
  const names = Object.keys(params);
  if (names.length > MAX_PARAMS) {
    return {
      ok: false,
      error: `param_declaration_invalid: at most ${MAX_PARAMS} params can be declared`,
    };
  }

  const declarations: Record<string, ParamDeclaration> = {};
  for (const name of names) {
    if (!AS_NAME_PATTERN.test(name)) {
      return {
        ok: false,
        error: `param_declaration_invalid: "${name}" must match [A-Za-z_][A-Za-z0-9_]{0,31}`,
      };
    }
    const raw = params[name];
    if (!isPlainObject(raw)) {
      return { ok: false, error: `param_declaration_invalid: "${name}" must be an object` };
    }
    for (const field of Object.keys(raw)) {
      if (!PARAM_FIELDS.has(field)) {
        return {
          ok: false,
          error: `param_declaration_invalid: "${name}" does not take "${field}"`,
        };
      }
    }
    const declaration: ParamDeclaration = {};
    if (raw.required !== undefined) {
      if (typeof raw.required !== 'boolean') {
        return {
          ok: false,
          error: `param_declaration_invalid: "${name}.required" must be a boolean`,
        };
      }
      declaration.required = raw.required;
    }
    if (raw.secret !== undefined) {
      if (typeof raw.secret !== 'boolean') {
        return {
          ok: false,
          error: `param_declaration_invalid: "${name}.secret" must be a boolean`,
        };
      }
      declaration.secret = raw.secret;
    }
    if (raw.description !== undefined) {
      if (typeof raw.description !== 'string') {
        return {
          ok: false,
          error: `param_declaration_invalid: "${name}.description" must be a string`,
        };
      }
      declaration.description = raw.description;
    }
    if (hasOwn(raw, 'default')) {
      if (declaration.required === true) {
        return {
          ok: false,
          error: `param_declaration_invalid: "${name}" cannot be both required and have a default`,
        };
      }
      if (declaration.secret === true) {
        return {
          ok: false,
          error: `param_declaration_invalid: "${name}" is secret and cannot have a default`,
        };
      }
      declaration.default = raw.default;
    }
    declarations[name] = declaration;
  }

  return { ok: true, declarations };
}

type ParamResolution =
  | { ok: true; values: Record<string, unknown>; secrets: string[]; warnings: string[] }
  | { ok: false; error: string };

/**
 * action="run" 의 전달값을 선언과 맞춰 실행용 값으로 만든다.
 * 전달값 > `default` 순이고, 둘 다 없는 optional 은 스코프에 넣지 않는다
 * (참조하면 `unresolved_reference` 로 그 step 이 실패한다).
 */
function resolveParams(
  declarations: Record<string, ParamDeclaration> | undefined,
  supplied: unknown,
): ParamResolution {
  if (supplied !== undefined && !isPlainObject(supplied)) {
    return { ok: false, error: 'params must be an object' };
  }
  const declared = declarations ?? {};
  const given = isPlainObject(supplied) ? supplied : undefined;

  if (given) {
    for (const name of Object.keys(given)) {
      if (!hasOwn(declared, name)) {
        return { ok: false, error: `unknown_param: "${name}" is not declared by this shortcut` };
      }
    }
  }

  const values: Record<string, unknown> = {};
  const secrets: string[] = [];
  const warnings: string[] = [];

  for (const name of Object.keys(declared)) {
    const declaration = declared[name];
    let value: unknown;
    if (given && hasOwn(given, name)) {
      // null 도 "전달됨" 으로 본다 - 오타를 조용히 무시하면 로그인이 빈 값으로 들어간다.
      value = given[name];
    } else if (hasOwn(declaration, 'default')) {
      value = declaration.default;
    } else if (declaration.required === true) {
      return { ok: false, error: `missing_param: "${name}" is required` };
    } else {
      continue;
    }

    if (declaration.secret === true) {
      if (typeof value !== 'string') {
        return { ok: false, error: `param_type_invalid: "${name}" is secret and must be a string` };
      }
      if (value.length > 0) secrets.push(value);
      if (value.length < SHORT_SECRET_LENGTH) {
        warnings.push(
          `secret "${name}" is shorter than ${SHORT_SECRET_LENGTH} characters, so masking may hide unrelated text in this response`,
        );
      }
    }
    values[name] = value;
  }

  return { ok: true, values, secrets, warnings };
}

/**
 * 응답 문자열에서 비밀값을 가린다. JSON 으로 escape 된 형태까지 함께 지운다.
 * 길이와 무관하게 항상 가리는 것이 설계 3절 규칙이다.
 */
function maskSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    const variants = new Set<string>([secret, JSON.stringify(secret).slice(1, -1)]);
    for (const variant of variants) {
      if (variant.length === 0) continue;
      out = out.split(variant).join('***');
    }
  }
  return out;
}

/**
 * `list` 에 실을 선언 요약. `secret` 은 값이 될 만한 것을 싣지 않는다
 * (secret 은 `default` 를 가질 수 없으므로 이름·필수 여부·설명만 남는다).
 */
function summarizeParams(
  declarations: Record<string, ParamDeclaration>,
): Record<string, unknown>[] {
  return Object.keys(declarations).map((name) => {
    const declaration = declarations[name];
    const summary: Record<string, unknown> = { name, required: declaration.required === true };
    if (declaration.secret === true) summary.secret = true;
    else if (hasOwn(declaration, 'default')) summary.default = declaration.default;
    if (declaration.description !== undefined) summary.description = declaration.description;
    return summary;
  });
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

    const isV2 = areTemplatesActive(args);

    const validation = validateSteps(args?.steps, isV2);
    if (!validation.ok) {
      return createErrorResponse(validation.error);
    }

    const declaration = validateParamDeclarations(args?.params);
    if (!declaration.ok) {
      return createErrorResponse(declaration.error);
    }

    if (isV2) {
      const flowError = validateFlow(validation.steps);
      if (flowError) {
        return createErrorResponse(flowError);
      }
      // `{{params.x}}` 를 쓰면서 선언이 없으면 저장 시점에 막는다.
      for (const referenced of collectFlowParamNames(validation.steps)) {
        if (!declaration.declarations || !hasOwn(declaration.declarations, referenced)) {
          return createErrorResponse(
            `undeclared_param: "${referenced}" is used by a step but not declared in "params"`,
          );
        }
      }
    }

    const shortcuts = await loadShortcuts();
    const existing = Object.prototype.hasOwnProperty.call(shortcuts, name)
      ? shortcuts[name]
      : undefined;
    const replaced = existing !== undefined;

    if (!replaced && Object.keys(shortcuts).length >= MAX_SHORTCUTS) {
      return createErrorResponse(
        `at most ${MAX_SHORTCUTS} shortcuts can be saved. Delete one before saving a new one.`,
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
      // 치환 활성 여부를 레코드에 함께 기록한다 (legacy 레코드는 이 필드가 없다).
      ...(isV2 ? { templates: true } : {}),
      ...(declaration.declarations ? { params: declaration.declarations } : {}),
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

    // legacy 레코드(templates 필드 없음)는 절대 치환하지 않는다.
    const templatesEnabled = stored.templates === true;
    const returnNames = args?.return;
    if (templatesEnabled) {
      const flowError = validateFlow(steps, returnNames);
      if (flowError) {
        return createErrorResponse(flowError);
      }
    }

    const resolvedParams = resolveParams(stored.params, args?.params);
    if (!resolvedParams.ok) {
      return createErrorResponse(resolvedParams.error);
    }

    const outcome = await runSteps({
      steps,
      invoke,
      continueOnError,
      lane,
      mcpSessionId: _mcpSessionId,
      disallowedTools: DISALLOWED_STEP_TOOLS,
      containerLabel: 'chrome_shortcut',
      skippedNote: 'skipped (shortcut stopped at earlier failing step)',
      collectImages: false,
      templatesEnabled,
      returnNames: templatesEnabled && Array.isArray(returnNames) ? returnNames : undefined,
      params: templatesEnabled ? resolvedParams.values : undefined,
    });

    // 실행 횟수만 반영한다 - 전달된 params 값은 저장소에 쓰지 않는다.
    stored.runCount = (stored.runCount || 0) + 1;
    shortcuts[name] = stored;
    await saveShortcuts(shortcuts);

    const body = JSON.stringify({
      success: outcome.success,
      name,
      steps: outcome.results,
      ...(outcome.stoppedAtStep !== undefined ? { stoppedAtStep: outcome.stoppedAtStep } : {}),
      ...(outcome.stoppedBy !== undefined ? { stoppedBy: outcome.stoppedBy } : {}),
      ...(outcome.returned !== undefined ? { results: outcome.returned } : {}),
      ...(outcome.resultsTruncated !== undefined
        ? { resultsTruncated: outcome.resultsTruncated }
        : {}),
      ...(resolvedParams.warnings.length > 0 ? { warnings: resolvedParams.warnings } : {}),
    });

    return {
      content: [
        {
          type: 'text',
          // 비밀값은 응답 어디에도 원문으로 남지 않는다 (길이와 무관하게 항상 가린다).
          text: maskSecrets(body, resolvedParams.secrets),
        },
      ],
      // 단계별 실패는 본문 JSON 으로 보고한다 (chrome_shortcut 자체가 잘못된 경우만 isError:true).
      isError: false,
    };
  }

  private async handleList(): Promise<ToolResult> {
    const shortcuts = await loadShortcuts();

    // 전체 step args 는 절대 덤프하지 않는다 - 목록은 가볍게 유지.
    const list = Object.entries(shortcuts).map(([name, s]) => ({
      name,
      description: s.description,
      stepCount: Array.isArray(s.steps) ? s.steps.length : 0,
      // 반복 묶음 항목에는 tool 이 없다 - 묶음은 "repeat" 로, 안쪽 도구도 함께 싣는다.
      tools: Array.from(new Set(collectStepToolNames(s.steps))),
      createdAt: s.createdAt,
      runCount: s.runCount || 0,
      ...(isPlainObject(s.params) ? { params: summarizeParams(s.params) } : {}),
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
