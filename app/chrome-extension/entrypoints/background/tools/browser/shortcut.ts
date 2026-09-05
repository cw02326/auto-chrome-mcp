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
import {
  buildHistoryResults,
  classifyRunOutcome,
  finishRunRecord,
  findRecordById,
  manualRunId,
  maskSecrets,
  normalizeLimit,
  readHistory,
  selectHistory,
  startRunRecord,
} from '@/utils/shortcut-history';
import {
  MAX_SCHEDULES,
  armScheduleAlarm,
  bumpScheduleRevision,
  clearScheduleAlarm,
  computeNextAt,
  currentTimeZoneSignature,
  parseScheduleId,
  putSchedule,
  readSchedules,
  removeSchedule,
  scheduleIdForFlow,
  scheduleIdForShortcut,
  summarizeSchedule,
  validateLoginCheck,
  validateScheduleExpression,
  validateScheduleFirstStep,
  type ScheduleRecord,
  type ScheduleTarget,
} from '@/utils/shortcut-schedule';
import { checkFlowScheduleTarget, commitSchedule } from '../../flow-schedule';

/**
 * auto-chrome-mcp fork: chrome_shortcut — chrome_batch 의 step 목록을 이름 붙여 저장해두고
 * 나중에 이름만으로 재실행하는 "저장된 매크로". 반복되는 로그인 흐름·정기 수집 루틴처럼
 * 세션이 바뀌어도 다시 쓰고 싶은 작업을 chrome.storage.local 에 영속 저장한다.
 *
 * 실행 루프는 chrome_batch 와 공유한다 (./batch-runner.ts).
 */

type ShortcutStep = RunnerStep;

interface ShortcutToolParams {
  action: 'save' | 'run' | 'list' | 'delete' | 'history' | 'schedule' | 'unschedule' | 'schedules';
  name?: string;
  /**
   * action="schedule"/"unschedule"/"history": 단축 이름 대신 발행된 흐름을 대상으로 한다
   * (2026-09-06 사이드패널 3단계). `name` 과 함께 오면 `target_ambiguous` 다.
   */
  flowId?: string;
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
  /** action="run": 실행 중 MCP 탭 그룹에 붙일 제목. 없으면 shortcut 이름을 쓴다. */
  task?: string;
  /** action="history": 이 실행 하나를 results 까지 통째로 돌려준다. */
  runId?: string;
  /** action="history": 목록 개수 (기본 20, 상한 100). */
  limit?: number;
  /** action="history": 이 시각(ISO 또는 epoch ms) 이후 기록만. */
  since?: string | number;
  /** action="history": 상태 필터. */
  status?: string | string[];
  /** action="schedule": `{ every }` 또는 `{ daily, days? }`. */
  schedule?: unknown;
  /** action="schedule": 실패 알림을 받을지 (기본 true). */
  notify?: boolean;
  /** action="schedule": 결과를 다운로드 폴더에 JSON 으로도 남길지 (기본 false). */
  report?: boolean;
  /** action="schedule": 이 이름의 top-level step 이 stopIf 로 멈추면 login_required. */
  loginCheck?: string;
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
  /**
   * auto-chrome-mcp fork(2026-09-05 데일리 자동화 설계 9절 예시 (a)): 저장 시점의 `return`
   * 이름. 예약 실행에는 호출자가 없어 `return` 을 줄 수 없으므로, 무엇을 이력에 남길지는
   * 저장 때 정해 둬야 한다. 수동 `run` 은 인자로 준 `return` 이 우선이다.
   */
  returnNames?: string[];
}

const MAX_SHORTCUTS = 50;

/** `flowId` 를 받는 액션. 나머지 액션에서 오면 잘못 쓴 것이라 알려 준다. */
const FLOW_TARGET_ACTIONS = ['schedule', 'unschedule', 'history'] as const;
const MAX_NAME_LENGTH = 64;
const STORAGE_KEY = 'mcpShortcuts';

/**
 * auto-chrome-mcp fork: chrome_batch 의 DISALLOWED_STEP_TOOLS 와 같은 취지의 목록.
 * batch.ts 는 이 집합을 export 하지 않고(barrel 규약상 이 작업은 이 파일만 수정하도록
 * 지시받음) 이 파일에서 직접 import 할 경로도 없으므로, 동일 목록을 여기서 다시 정의하고
 * orchestrator 자기 자신(chrome_shortcut)을 추가한다 — 매크로 안에 매크로를 저장하는
 * 중첩을 막기 위해서다.
 */
export const SHORTCUT_DISALLOWED_STEP_TOOLS = new Set<string>([
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

/**
 * 저장된 shortcut 전체. 예약 러너(entrypoints/background/schedule-runner.ts)가 실행 직전에
 * 정의를 읽어야 하므로 export 한다 - 저장 형식을 두 곳에 복제하지 않기 위해서다.
 */
export async function loadShortcuts(): Promise<Record<string, StoredShortcut>> {
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
  if (SHORTCUT_DISALLOWED_STEP_TOOLS.has(toolName)) {
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

export type ParamResolution =
  | { ok: true; values: Record<string, unknown>; secrets: string[]; warnings: string[] }
  | { ok: false; error: string };

/**
 * action="run" 의 전달값을 선언과 맞춰 실행용 값으로 만든다.
 * 전달값 > `default` 순이고, 둘 다 없는 optional 은 스코프에 넣지 않는다
 * (참조하면 `unresolved_reference` 로 그 step 이 실패한다).
 */
export function resolveShortcutParams(
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

/**
 * 이력 항목에 `target` 을 붙인다 (2026-09-05 사이드패널 2단계 D).
 *
 * 이력 키는 예약 실행이면 scheduleId 다. 그 값에서 대상을 되찾아 실으면, `history` 응답
 * 하나로 "이 실행이 단축인지 흐름인지" 를 알 수 있다. 수동 실행(키가 단축 이름)은 대상이
 * 언제나 그 단축이다.
 */
function withTarget<T extends { name: string; label?: string }>(
  record: T,
): T & { target: ScheduleTarget } {
  const parsed = parseScheduleId(record.name);
  return { ...record, target: parsed ?? { kind: 'shortcut', name: record.name } };
}

function notFoundError(name: string, available: string[]): ToolResult {
  return createErrorResponse(
    available.length > 0
      ? `shortcut "${name}" not found. Available: ${available.join(', ')}`
      : `shortcut "${name}" not found. No shortcuts are saved yet.`,
  );
}

/**
 * 이력 기록 실패가 실행 결과를 삼키지 않게 한다. 이력은 부가 기록이라, 저장소가 꽉 찼다고
 * 해서 성공한 실행이 오류로 보고되면 안 된다. 대신 콘솔에 남겨 원인을 찾을 수 있게 한다.
 */
async function safeHistoryWrite(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.warn('[chrome_shortcut] 실행 이력 기록 실패(실행에는 영향 없음):', error);
  }
}

class ShortcutTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SHORTCUT;

  async execute(args: ShortcutToolParams): Promise<ToolResult> {
    const action = args?.action;

    // 2026-09-06 사이드패널 3단계: 예약·해제·이력은 단축 이름 대신 발행된 흐름도 대상으로
    // 받는다. 둘 다 오면 무엇을 뜻하는지 고를 수 없으므로 조용히 한쪽을 고르지 않는다.
    const flowId = typeof args?.flowId === 'string' ? args.flowId.trim() : '';
    if (flowId) {
      if (!FLOW_TARGET_ACTIONS.includes(action as (typeof FLOW_TARGET_ACTIONS)[number])) {
        return createErrorResponse(
          `flow_target_unsupported: "flowId" works with ${FLOW_TARGET_ACTIONS.join(', ')} only`,
        );
      }
      if (typeof args?.name === 'string' && args.name.trim().length > 0) {
        return createErrorResponse('target_ambiguous: pass either "name" or "flowId", not both');
      }
    }

    switch (action) {
      case 'save':
        return this.handleSave(args);
      case 'run':
        return this.handleRun(args);
      case 'list':
        return this.handleList();
      case 'delete':
        return this.handleDelete(args);
      case 'history':
        return this.handleHistory(args);
      case 'schedule':
        return this.handleSchedule(args);
      case 'unschedule':
        return this.handleUnschedule(args);
      case 'schedules':
        return this.handleSchedules();
      default:
        return createErrorResponse(
          'action must be one of "save", "run", "list", "delete", "history", "schedule", "unschedule", "schedules"',
        );
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

    // 저장 시점의 `return`. 예약 실행에는 호출자가 없어 여기서 정해 두지 않으면 이력에
    // 남길 값이 없다 (설계 9절 예시 (a) 가 save 에 `return` 을 함께 싣는 이유).
    const savedReturnNames =
      Array.isArray(args?.return) && args.return.every((n) => typeof n === 'string')
        ? args.return
        : undefined;

    if (isV2) {
      const flowError = validateFlow(validation.steps, savedReturnNames);
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
      ...(isV2 && savedReturnNames ? { returnNames: savedReturnNames } : {}),
    };

    await saveShortcuts(shortcuts);

    // 정의가 바뀌었으니 이 이름의 예약도 새 정의를 가리킨다. 실행 중이던 run 은 종료 시
    // revision 이 다른 것을 보고 재무장을 포기한다(superseded).
    if (replaced) await bumpScheduleRevision(scheduleIdForShortcut(name));

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
    const returnNames = Array.isArray(args?.return) ? args.return : stored.returnNames;
    if (templatesEnabled) {
      const flowError = validateFlow(steps, returnNames);
      if (flowError) {
        return createErrorResponse(flowError);
      }
    }

    const resolvedParams = resolveShortcutParams(stored.params, args?.params);
    if (!resolvedParams.ok) {
      return createErrorResponse(resolvedParams.error);
    }

    // 이력 기록(설계 4절): 수동 실행도 `trigger: "manual"` 로 남긴다. 시작 레코드를 먼저
    // 써 둬야 워커가 중간에 죽어도 reconcile 이 `interrupted` 로 바꿔 줄 수 있다.
    const startedAt = Date.now();
    const runId = manualRunId(name, startedAt);
    await safeHistoryWrite(() =>
      startRunRecord({
        runId,
        name,
        trigger: 'manual',
        startedAt,
        secrets: resolvedParams.secrets,
      }),
    );

    const outcome = await runSteps({
      steps,
      invoke,
      continueOnError,
      lane,
      mcpSessionId: _mcpSessionId,
      disallowedTools: SHORTCUT_DISALLOWED_STEP_TOOLS,
      containerLabel: 'chrome_shortcut',
      skippedNote: 'skipped (shortcut stopped at earlier failing step)',
      collectImages: false,
      templatesEnabled,
      returnNames: templatesEnabled && Array.isArray(returnNames) ? returnNames : undefined,
      params: templatesEnabled ? resolvedParams.values : undefined,
      // 실행 중 MCP 탭 그룹 라벨. 문구를 주지 않으면 shortcut 이름이 그대로 라벨이 된다.
      taskTitle: typeof args?.task === 'string' && args.task.trim().length > 0 ? args.task : name,
    });

    const endedAt = Date.now();
    const classification = classifyRunOutcome(outcome);
    const history = buildHistoryResults(outcome.returned);
    // 러너가 이미 상한으로 뺀 이름(outcome.resultsTruncated)과 이력 단계에서 뺀 이름을
    // 합쳐 둔다. 어느 층에서 빠졌든 레코드를 읽는 쪽에는 "이 이름은 없다" 가 전부다.
    const truncatedNames = Array.from(
      new Set([...(outcome.resultsTruncated ?? []), ...history.truncated]),
    );
    await safeHistoryWrite(() =>
      finishRunRecord(
        name,
        runId,
        {
          status: classification.status,
          endedAt,
          durationMs: endedAt - startedAt,
          failedStep: classification.failedStep,
          errorCode: classification.errorCode,
          error: classification.error,
          stoppedBy: outcome.stoppedBy ?? null,
          results: history.results,
          ...(truncatedNames.length > 0 ? { resultsTruncated: truncatedNames } : {}),
          ...(resolvedParams.warnings.length > 0 ? { warnings: resolvedParams.warnings } : {}),
        },
        resolvedParams.secrets,
      ),
    );

    // 실행 횟수만 반영한다 - 전달된 params 값은 저장소에 쓰지 않는다.
    stored.runCount = (stored.runCount || 0) + 1;
    shortcuts[name] = stored;
    await saveShortcuts(shortcuts);

    const body = JSON.stringify({
      success: outcome.success,
      name,
      // 방금 실행을 `action: "history"` 로 다시 열 때 쓰는 손잡이.
      runId,
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

  /**
   * action="history": 실행 이력 조회 (설계 4절).
   *
   * `runId` 를 주면 그 레코드 하나를 `results` 까지 통째로, 없으면 요약 목록만 돌려준다.
   * 밤새 30건 x 24,000자를 그대로 실으면 Claude 컨텍스트를 밀어내기 때문이다.
   */
  private async handleHistory(args: ShortcutToolParams): Promise<ToolResult> {
    const map = await readHistory();
    const name = typeof args?.name === 'string' && args.name.length > 0 ? args.name : undefined;

    const runId = typeof args?.runId === 'string' ? args.runId.trim() : '';
    if (runId.length > 0) {
      // 이름으로 좁히지 않는다: 예약 실행은 scheduleId 키에, 수동 실행은 이름 키에 있다.
      const record = findRecordById(map, runId);
      if (!record) {
        return createErrorResponse(`run_not_found: no history record with runId "${runId}"`);
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, run: withTarget(record) }),
          },
        ],
        isError: false,
      };
    }

    const limit = normalizeLimit(args?.limit);
    // 2026-09-05 사이드패널 2단계 D: 예약 실행의 이력 키는 `shortcut:<enc(name)>` 이고
    // 수동 `run` 은 예전 그대로 이름이다. 이름으로 물으면 둘 다 보여 준다 - 사용자에게는
    // 같은 단축의 실행 기록이다.
    // 2026-09-06 3단계: 흐름은 키가 하나다(`flow:<enc(flowId)>`). 흐름의 수동 실행은
    // `record_replay_flow_run` 이 자기 이력에 남기므로 이 저장소에는 예약 실행만 있다.
    const flowId = typeof args?.flowId === 'string' ? args.flowId.trim() : '';
    const flowKey = flowId ? scheduleIdForFlow(flowId) : '';
    const scoped = flowKey
      ? { [flowKey]: Array.isArray(map[flowKey]) ? map[flowKey] : [] }
      : name === undefined
        ? map
        : {
            [name]: Array.isArray(map[name]) ? map[name] : [],
            [scheduleIdForShortcut(name)]: Array.isArray(map[scheduleIdForShortcut(name)])
              ? map[scheduleIdForShortcut(name)]
              : [],
          };
    const { summaries, matched } = selectHistory(scoped, {
      limit,
      since: args?.since,
      status: args?.status,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            runs: summaries.map((summary) => withTarget(summary)),
            matched,
            limit,
          }),
        },
      ],
      isError: false,
    };
  }

  /**
   * action="schedule": 저장된 shortcut 에 실행 시각을 붙인다 (설계 1절).
   *
   * 검증을 전부 **예약 시점**에 한다. 실행 시점에 실패하면 밤에 아무도 못 본다.
   * shortcut 하나에 예약 하나이고, 다시 걸면 덮어쓴다(`replaced: true`).
   */
  private async handleSchedule(args: ShortcutToolParams): Promise<ToolResult> {
    const flowId = typeof args?.flowId === 'string' ? args.flowId.trim() : '';
    if (flowId) return this.handleScheduleFlow(args, flowId);

    const name = validateName(args?.name);
    if (!name) {
      return createErrorResponse(
        'name must be a 1-64 character string without "/" or control characters',
      );
    }

    const shortcuts = await loadShortcuts();
    const stored = shortcuts[name];
    if (!stored) {
      return notFoundError(name, Object.keys(shortcuts));
    }

    const expression = validateScheduleExpression(args?.schedule);
    if (!expression.ok) {
      return createErrorResponse(expression.error);
    }

    const steps = Array.isArray(stored.steps) ? stored.steps : [];

    // 예약은 시간이 지난 뒤 도니 저장된 탭 id 는 반드시 남의 탭이다. v1 grandfathering 은
    // 수동 실행에만 남기고, 예약은 legacy 레코드도 v2 규칙으로 다시 검사한다.
    const stepCheck = validateSteps(steps, true);
    if (!stepCheck.ok) {
      return createErrorResponse(stepCheck.error);
    }

    const firstStepError = validateScheduleFirstStep(steps);
    if (firstStepError) {
      return createErrorResponse(firstStepError);
    }

    const loginCheckError = validateLoginCheck(steps, args?.loginCheck);
    if (loginCheckError) {
      return createErrorResponse(loginCheckError);
    }

    const declarations = isPlainObject(stored.params) ? stored.params : undefined;
    if (declarations) {
      for (const paramName of Object.keys(declarations)) {
        if (
          declarations[paramName]?.secret === true &&
          declarations[paramName]?.required === true
        ) {
          return createErrorResponse(
            `secret_required_unschedulable: "${name}" requires the secret "${paramName}", and secrets are never stored`,
          );
        }
      }
      if (isPlainObject(args?.params)) {
        for (const paramName of Object.keys(args.params)) {
          if (declarations[paramName]?.secret === true) {
            return createErrorResponse(
              `secret_param_in_schedule: "${paramName}" is a secret and cannot be stored in a schedule`,
            );
          }
        }
      }
    } else if (isPlainObject(args?.params) && Object.keys(args.params).length > 0) {
      return createErrorResponse(
        `unknown_param: "${Object.keys(args.params)[0]}" is not declared by this shortcut`,
      );
    }

    // 선언과 대조해 unknown_param·missing_param 을 지금 잡는다.
    const resolved = resolveShortcutParams(declarations, args?.params);
    if (!resolved.ok) {
      return createErrorResponse(resolved.error);
    }

    const now = Date.now();
    const signature = currentTimeZoneSignature(now);
    const scheduleId = scheduleIdForShortcut(name);
    const draft: ScheduleRecord = {
      scheduleId,
      name,
      // 2026-09-05 사이드패널 2단계 D: 대상을 레코드에 명시한다. 없으면 단축으로 읽히므로
      // 옛 레코드와도 뜻이 같다.
      target: { kind: 'shortcut', name },
      enabled: true,
      schedule: expression.parsed.schedule,
      ...(isPlainObject(args?.params) ? { params: args.params } : {}),
      notify: args?.notify !== false,
      report: args?.report === true,
      ...(typeof args?.loginCheck === 'string' ? { loginCheck: args.loginCheck.trim() } : {}),
      nextAt: now,
      anchorAt: now,
      revision: 0,
      // 실제 값은 putSchedule 이 저장소 전역 카운터에서 받아 채운다.
      generation: 0,
      createdAt: now,
      updatedAt: now,
      timeZone: signature.timeZone,
      offsetMinutes: signature.offsetMinutes,
      failStreak: 0,
    };

    const nextAt = computeNextAt(draft, now);
    if (nextAt === null) {
      return createErrorResponse(
        'schedule_invalid: this schedule never comes around. Check "daily" and "days".',
      );
    }
    draft.nextAt = nextAt;

    const saved = await putSchedule(draft, now);
    if (!saved.ok) {
      return createErrorResponse(saved.error);
    }
    await armScheduleAlarm(scheduleId, saved.record.nextAt);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            name,
            scheduleId,
            target: saved.record.target,
            replaced: saved.replaced,
            schedule: saved.record.schedule,
            nextAt: saved.record.nextAt,
            nextAtLocal: new Date(saved.record.nextAt).toString(),
            notify: saved.record.notify,
            report: saved.record.report,
            revision: saved.record.revision,
            ...(resolved.warnings.length > 0 ? { warnings: resolved.warnings } : {}),
          }),
        },
      ],
      isError: false,
    };
  }

  /**
   * action="schedule" + flowId: 발행된 흐름을 예약한다 (2026-09-06 사이드패널 3단계).
   *
   * 검증도 저장도 사이드패널(`DAILY_PUT_SCHEDULE`)과 **같은 함수**를 지난다
   * (`entrypoints/background/flow-schedule.ts`). 거절 코드가 두 접점에서 같아야
   * "화면에서는 막히는데 도구로는 걸리는" 예약이 생기지 않는다.
   */
  private async handleScheduleFlow(args: ShortcutToolParams, flowId: string): Promise<ToolResult> {
    // 흐름에는 `params` 선언이 없다. 도구의 `params` 는 흐름 변수 값(args)으로 간다.
    const check = await checkFlowScheduleTarget({
      flowId,
      args: args?.params,
      loginCheck: args?.loginCheck,
    });
    if (!check.ok) return createErrorResponse(check.error);

    const loginCheck =
      typeof args?.loginCheck === 'string' && args.loginCheck.trim().length > 0
        ? args.loginCheck.trim()
        : undefined;

    const committed = await commitSchedule(check, {
      schedule: args?.schedule,
      notify: args?.notify !== false,
      report: args?.report === true,
      ...(loginCheck ? { loginCheck } : {}),
      enabled: true,
    });
    if (!committed.ok) return createErrorResponse(committed.error);

    const record = committed.record;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            flowId,
            name: record.name,
            scheduleId: record.scheduleId,
            target: record.target,
            replaced: committed.replaced,
            schedule: record.schedule,
            nextAt: record.nextAt,
            nextAtLocal: new Date(record.nextAt).toString(),
            notify: record.notify,
            report: record.report,
            revision: record.revision,
          }),
        },
      ],
      isError: false,
    };
  }

  /** action="unschedule": 예약 레코드와 알람을 지운다. shortcut 정의는 그대로 둔다. */
  private async handleUnschedule(args: ShortcutToolParams): Promise<ToolResult> {
    const flowId = typeof args?.flowId === 'string' ? args.flowId.trim() : '';
    const name = flowId ? '' : validateName(args?.name);
    if (!flowId && !name) {
      return createErrorResponse(
        'name must be a 1-64 character string without "/" or control characters',
      );
    }
    // 실행 중이던 run 이 종료 시 재무장하지 않도록 revision 을 먼저 올린 뒤 지운다.
    const scheduleId = flowId ? scheduleIdForFlow(flowId) : scheduleIdForShortcut(name as string);
    await bumpScheduleRevision(scheduleId);
    const unscheduled = await removeSchedule(scheduleId);
    await clearScheduleAlarm(scheduleId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            ...(flowId ? { flowId } : { name }),
            scheduleId,
            unscheduled,
          }),
        },
      ],
      isError: false,
    };
  }

  /**
   * action="schedules": 예약 목록. 아침에 상태를 훑는 첫 화면이다.
   *
   * 2026-09-05 사이드패널 2단계: 흐름 예약도 같은 목록에 나온다. 항목마다 `target` 이
   * 붙어 있어 무엇을 돌리는 예약인지 응답만 보고 알 수 있다 (스키마 파라미터는 그대로다 -
   * 흐름 예약을 **만드는** 길은 사이드패널뿐이다).
   */
  private async handleSchedules(): Promise<ToolResult> {
    const map = await readSchedules();
    const schedules = Object.keys(map)
      .map((scheduleId) => summarizeSchedule(map[scheduleId]))
      .sort((a, b) => a.nextAt - b.nextAt);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, schedules, max: MAX_SCHEDULES }),
        },
      ],
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

    // shortcut 을 지우면 예약과 알람도 함께 사라져야 한다 - 없는 정의를 가리키는 알람이
    // 밤에 울려 봐야 실패 기록만 쌓인다.
    const scheduleId = scheduleIdForShortcut(name);
    const unscheduled = await removeSchedule(scheduleId);
    if (unscheduled) await clearScheduleAlarm(scheduleId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, name, deleted: true, unscheduled }),
        },
      ],
      isError: false,
    };
  }
}

export const shortcutTool = new ShortcutTool();
