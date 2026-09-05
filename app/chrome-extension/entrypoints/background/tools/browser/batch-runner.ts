/**
 * auto-chrome-mcp fork: chrome_batch 와 chrome_shortcut 이 함께 쓰는 step 실행기.
 *
 * 설계 계약: docs/plans/2026-09-04-batch-flow-design.md (구현 순서 1~4단계).
 * 두 도구에 똑같이 복사돼 있던 실행 루프를 여기로 모았다. 실행 의미는 그대로고,
 * step 결과에 `status` 가 붙고 `as`/`{{...}}`/`return` 과 흐름 제어가 더해진다.
 *
 * 흐름 제어 요약.
 *   - `when`: 실행 전 판정. 거짓이면 도구를 부르지 않고 status "skipped".
 *   - `stopIf`: 캡처 직후 판정. 참이면 그 step 이 "stopped", 남은 step 은 "skipped".
 *   - `repeat`: `{ max, until?, delayMs? }` + `steps` 묶음. 깊이 1, 회차마다 안쪽 이름을 비운다.
 *   - 상한: 도구 호출 100회, 벽시계 100초. 호출 사이에 검사하고 남은 시간을 invoke 에 넘긴다.
 */

import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import { isBackgroundModeEnabled, stripEffectiveBackgroundMode } from '@/utils/background-mode';
import { beginMcpGroupTask, endMcpGroupTask, setMcpGroupTitle } from '@/utils/mcp-tab-group';
import { getWorkTabId, sessionKeyOf } from '@/utils/work-tab-manager';
import { FlowDeadlineExceededError } from '@/utils/tool-watchdog';
import { URL_SELECTS_TARGET_TOOLS } from '@/utils/work-tab-gate';
import {
  ALWAYS_FORBIDDEN_TEMPLATE_KEYS,
  StepTemplateError,
  assertCaptureFits,
  assertNoDangerousArgKeys,
  assertNoInjectedForbiddenKeys,
  assertNoTemplatedForbiddenKeys,
  assertPlainArgsShape,
  assertValidCaptureName,
  buildCapture,
  collectParamNames,
  createTemplateScope,
  paramNameFromPath,
  resolvePathValue,
  substituteArgs,
  toPrevCapture,
  utf8ByteLength,
  type StepCapture,
  type TemplateScope,
} from '@/utils/step-template';
import {
  evaluateCondition,
  surfaceConditionCode,
  validateCondition,
  type ConditionPathResolver,
} from '@/utils/step-condition';
import { sleep } from '@/utils/adaptive-wait';

export const MAX_STEPS = 20;
export const MAX_RESULT_TEXT_LENGTH = 4000;
/**
 * auto-chrome-mcp fork: batch 가 돌려줄 이미지 최대 개수.
 * 스키마가 권하는 `click -> fill -> screenshot` 체인이 실제로 그림을 받게 하되,
 * 20 스텝이 전부 스크린샷일 때 컨텍스트가 터지지 않도록 뒤에서부터 이만큼만 남긴다.
 */
export const MAX_RESULT_IMAGES = 4;

/** `return` 항목 하나의 상한. 넘으면 자르지 않고 통째로 뺀다 (잘린 JSON 은 파싱이 안 된다). */
export const MAX_RETURN_ITEM_CHARS = 8_000;
/** `return` 전체 상한. */
export const MAX_RETURN_TOTAL_CHARS = 24_000;

/** 한 묶음이 돌 수 있는 최대 회차. */
export const MAX_REPEAT = 20;
/** 회차 사이 대기 상한 (ms). */
export const MAX_REPEAT_DELAY_MS = 5_000;
/** 한 호출이 실제로 실행할 수 있는 도구 호출 수. 101번째 직전에 멈춘다. */
export const MAX_TOTAL_RUNS = 100;
/** 한 호출의 벽시계 상한 (ms). stdio 프록시가 120초에 끊으므로 그 전에 응답을 돌려준다. */
export const MAX_BATCH_MS = 100_000;

export type ToolInvoker = (param: {
  name: string;
  args: any;
  /**
   * 벽시계 상한의 **절대 마감 시각** (epoch ms). 흐름 제어가 켜진 호출에서만 실린다.
   * 상대값이면 게이트·지연·락 대기 동안 낡기 때문이다 (항목 4).
   */
  deadlineAt?: number;
  /**
   * auto-chrome-mcp fork(2026-09-05 데일리 자동화 설계 2절): **실행 컨텍스트 모드**.
   *
   * 예약 실행처럼 전역 토글과 무관하게 항상 무간섭이어야 하는 실행에서 `true` 다.
   * 게이트·url 대상 해석·navigate 재사용·활성화 가드·chrome_close_tabs 가 전역 토글보다
   * 이 값을 먼저 읽는다. 스키마에 없는 내부 전용 값이라 step args 로는 실을 수 없다.
   */
  effectiveBackgroundMode?: true;
}) => Promise<any>;

export type StepStatus = 'completed' | 'skipped' | 'stopped' | 'failed';

/**
 * 반복 묶음이 멈춘 이유.
 *
 * 2026-09-05 Codex 재확인 3: 예전에는 `timeout`·`total_runs` 로 멈춘 묶음도 `max` 로 남아
 * `status:"completed"` 로 보고됐다. 최상위 `stoppedBy` 만 진짜 사유를 들고 있어서, 묶음
 * 항목만 읽는 쪽은 "20회 다 돌고 정상 종료"로 잘못 읽었다.
 */
export type RepeatStoppedBy =
  | 'until'
  | 'stopIf'
  | 'max'
  | 'failure'
  | 'timeout'
  | 'total_runs'
  | 'aborted';

/** batch 전체가 멈춘 이유. `aborted` 는 `beforeStep` 훅이 실행을 끊은 것이다. */
export type BatchStopReason = 'stopIf' | 'total_runs_exceeded' | 'timeout' | 'aborted';

/**
 * `beforeStep` 훅이 실행을 끊을 때 던지는 오류.
 *
 * 예약 실행의 탭 인계 검사(사용자가 작업 탭을 활성화했는가)가 이걸 던진다. 실패가
 * 아니라 "여기서 그만둔다" 이므로 `stoppedBy.reason: "aborted"` 로 보고하고,
 * `abortReason` 이 그대로 이력의 status 판정 근거가 된다(예: user_took_over_tab).
 */
export class FlowAbortedError extends Error {
  constructor(
    readonly abortReason: string,
    message?: string,
  ) {
    super(message ?? abortReason);
    this.name = 'FlowAbortedError';
  }
}

/** batch 종료 사유를 반복 묶음의 `attempts.stoppedBy` 값으로 옮긴다. */
function repeatStoppedByFor(reason: BatchStopReason): RepeatStoppedBy {
  if (reason === 'stopIf') return 'stopIf';
  if (reason === 'timeout') return 'timeout';
  if (reason === 'aborted') return 'aborted';
  return 'total_runs';
}

/** 이 사유는 "다 돌아서 끝난 것"이 아니라 "중간에 멈춘 것"인가. */
function isRepeatStop(stoppedBy: RepeatStoppedBy): boolean {
  return (
    stoppedBy === 'stopIf' ||
    stoppedBy === 'timeout' ||
    stoppedBy === 'total_runs' ||
    stoppedBy === 'aborted'
  );
}

export interface RepeatSpec {
  max?: unknown;
  until?: unknown;
  delayMs?: unknown;
}

export interface RunnerStep {
  tool?: string;
  args?: Record<string, any>;
  as?: string;
  when?: unknown;
  stopIf?: unknown;
  repeat?: RepeatSpec;
  steps?: RunnerStep[];
}

export interface RunnerStepResult {
  index: number;
  tool: string;
  ok: boolean;
  resultText?: string;
  error?: string;
  /** auto-chrome-mcp fork: 이 스텝이 돌려준 이미지 수 (요약 JSON 뒤에 순서대로 붙는다). */
  images?: number;
  status: StepStatus;
  as?: string;
  /** 반복 묶음 항목에만 실린다. */
  attempts?: { count: number; stoppedBy: RepeatStoppedBy };
}

/** auto-chrome-mcp fork: 스텝이 만든 이미지 1장 - 어느 스텝에서 나왔는지 기억해 둔다. */
export interface RunnerImage {
  index: number;
  tool: string;
  content: { type: 'image'; data: string; mimeType: string };
}

export interface RunStepsOptions {
  steps: RunnerStep[];
  invoke: ToolInvoker;
  continueOnError?: boolean;
  lane?: string;
  mcpSessionId?: string;
  disallowedTools: ReadonlySet<string>;
  /** 거절 문구에 쓰는 컨테이너 이름 ("chrome_batch" | "chrome_shortcut"). */
  containerLabel: string;
  /** 중단 뒤 남은 step 에 붙일 문구. */
  skippedNote: string;
  /** batch 만 이미지를 모은다 (shortcut 응답 형식은 그대로 둔다). */
  collectImages: boolean;
  templatesEnabled: boolean;
  returnNames?: string[];
  /** shortcut 실행 파라미터 (`{{params.x}}` 의 뿌리). */
  params?: Record<string, unknown>;
  /**
   * auto-chrome-mcp fork(2026-09-05 데일리 자동화 설계 8절): 이 실행은 전역 토글과
   * 무관하게 항상 background 규칙으로 돈다. 예약 실행 전용이며 스키마에 노출하지 않는다.
   *
   * 인자 `background: true` 만 덮으면 전역 OFF 상태의 게이트가 작업 탭 주입 자체를
   * 건너뛰어 도구가 사용자의 활성 탭으로 fallback 한다. 그래서 모드를 실행 컨텍스트에
   * 실어 모든 판정 지점이 같은 답을 내게 한다.
   */
  forceBackground?: boolean;
  /**
   * 각 도구 호출 **직전**에 부른다. 던지면 그 자리에서 실행을 끊는다
   * (`stoppedBy.reason: "aborted"`). 예약 실행의 탭 인계 검사가 여기 붙는다.
   * `FlowAbortedError` 를 던지면 그 `abortReason` 이 결과에 실린다.
   */
  beforeStep?: () => Promise<void> | void;
  /**
   * auto-chrome-mcp fork(2026-09-05 Codex 리뷰 5): 이 실행의 **절대 마감 시각**.
   * 예약 러너의 end-to-end 상한이 batch 자체 상한(100초)보다 앞설 수 있어, 러너가 준
   * 마감을 그대로 쓴다. 주지 않으면 지금처럼 `MAX_BATCH_MS` 로 계산한다.
   */
  deadlineAt?: number;
  /**
   * auto-chrome-mcp fork(2026-09-05 Codex 리뷰 5): 바깥에서 실행을 취소하는 신호.
   * 예전에는 러너가 `Promise.race` 로 타임아웃 응답만 돌려주고 실행 자체는 계속 돌았다 -
   * 도구 호출이 끝나면 취소된 실행이 탭을 더 열었다. 신호가 서면 진행 중인 도구 호출이
   * 끝나는 대로 멈추고 `aborted` 를 실어 돌려준다.
   */
  signal?: { readonly aborted: boolean; readonly reason?: unknown };
  /**
   * auto-chrome-mcp fork(2026-09-05 Codex 리뷰 10): report 파일용 `return` 페이로드를
   * 이 byte 상한으로 한 벌 더 만든다. 이력용 `returned` 는 24,000자에서 잘리므로 그것만
   * 가지고는 설계가 약속한 256KiB report 를 끝까지 만들 수 없다.
   */
  reportLimitBytes?: number;
  /**
   * 실행하는 동안 MCP 탭 그룹에 붙일 제목. 끝나면 "MCP" 로 돌아간다.
   * 무간섭 모드에서는 탭이 배경에 조용히 열리므로, 사용자가 무엇이 도는지 알 수 있는
   * 유일한 표시가 그룹 라벨이다.
   */
  taskTitle?: string;
}

export interface RunStepsOutcome {
  success: boolean;
  results: RunnerStepResult[];
  images: RunnerImage[];
  stoppedAtStep?: number;
  stoppedBy?: { step: number; reason: BatchStopReason };
  returned?: Record<string, unknown>;
  resultsTruncated?: string[];
  /** `reportLimitBytes` 를 준 실행에서만. report 파일에 담을 더 큰 `return` 페이로드. */
  reportReturned?: Record<string, unknown>;
  /** 그 큰 상한에서도 빠진 이름들. */
  reportTruncated?: string[];
  /** `beforeStep` 훅이 실행을 끊었을 때의 사유 (예: user_took_over_tab). */
  aborted?: { reason: string; message: string };
}

/**
 * 결과의 모든 text content 를 이어붙여 잘라낸다.
 * (게이트가 new_tabs_opened 같은 알림을 두 번째 text 항목으로 첨부하므로
 *  첫 항목만 취하면 팝업 감지 알림이 유실된다 - auto-chrome-mcp fork)
 */
export function extractResultText(result: any): string | undefined {
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
 * 예전엔 텍스트만 이어붙이고 이미지를 통째로 버렸다 - 스키마는
 * `click -> fill -> click -> screenshot` 체인을 권하는데 정작 그림이 안 돌아왔다
 * (chrome_screenshot / chrome_computer 가 image content 를 돌려준다).
 */
export function extractResultImages(result: any): RunnerImage['content'][] {
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

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 이 항목이 반복 묶음인가. */
export function isRepeatGroup(step: unknown): boolean {
  return isPlainObject(step) && (step as RunnerStep).repeat !== undefined;
}

/**
 * 흐름(치환이 켜진 batch·shortcut) 안에서 부를 수 있는 **읽기 전용** 동작.
 * 목록에 없는 action 은 전부 거절한다 (2026-09-04 Codex 최종 검토 항목 3,
 * 2026-09-05 재확인 2 에서 금지 목록 → 허용 목록으로 뒤집음).
 *
 * `chrome_userscript` 의 create·update·enable 은 스크립트를 chrome.storage 에 영속 저장하고
 * (`persist` 기본값 true), 전역 tabs.onUpdated / webNavigation 리스너가 이후 **모든** 매칭
 * 탭에 다시 주입한다. 흐름 안에서 `{{params.pw}}` 가 치환된 스크립트를 만들면 비밀이
 * 저장소에 평문으로 남고, 그 뒤 사용자가 여는 아무 탭에나 재주입된다. 한 호출 안에서
 * 끝나야 할 흐름이 브라우저 전역 상태를 바꾸는 셈이라 거절한다.
 *
 * 처음에는 이 셋만 막았지만 `disable`·`remove` 도 같은 저장소를 쓰고(`saveAllRecords`),
 * `send_command` 는 이미 영속된 스크립트에 치환된 payload 를 밀어 넣으며, `export` 는
 * 저장된 스크립트 본문을 통째로 흐름 캡처로 끌어온다. 새 action 이 늘 때 빠뜨리지 않도록
 * "읽기 전용만 허용"으로 뒤집는다.
 *
 * 흐름 밖(단일 호출)과 v1 batch 는 예전 그대로다.
 */
const FLOW_READONLY_TOOL_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  [TOOL_NAMES.BROWSER.USERSCRIPT]: new Set(['list', 'get']),
};

/**
 * 이 호출이 흐름 안에서 금지된 stateful 동작인가.
 * `action` 은 치환될 수 있으므로 **치환이 끝난 인자**로 판정한다.
 *
 * `action` 이 문자열이 아니면(누락·객체) 도구가 스스로 `Unknown action` 으로 거절하므로
 * 어떤 핸들러에도 닿지 않는다. 여기서는 판정하지 않고 그대로 내려보낸다.
 */
function flowForbiddenAction(toolName: string, args: Record<string, any>): string | null {
  const allowed = FLOW_READONLY_TOOL_ACTIONS[toolName];
  if (!allowed) return null;
  const action = args?.action;
  if (typeof action !== 'string' || allowed.has(action)) return null;
  return (
    `flow_stateful_tool_forbidden: ${toolName} action "${action}" can change or reveal state ` +
    'that outlives this call (persisted scripts are re-injected into later tabs), so it cannot ' +
    `run inside a templated chrome_batch or chrome_shortcut. Only ${[...allowed].join(', ')} ` +
    'are allowed here. Call it on its own instead.'
  );
}

/* ------------------------------------------------------------------ *
 * 실행 전 검증
 * ------------------------------------------------------------------ */

function describeStep(index: number, groupIndex?: number): string {
  return groupIndex === undefined ? `step ${index}` : `step ${groupIndex} repeat step ${index}`;
}

function validateOneCondition(
  node: unknown,
  key: 'when' | 'stopIf' | 'until',
  where: string,
): string | null {
  const result = validateCondition(node);
  if (result.ok) return null;
  return `${surfaceConditionCode(result.code)}: ${where} "${key}" ${result.message}`;
}

function validateStepConditions(
  step: Record<string, any>,
  index: number,
  groupIndex?: number,
): string | null {
  const where = describeStep(index, groupIndex);
  if (step.when !== undefined) {
    const error = validateOneCondition(step.when, 'when', where);
    if (error) return error;
  }
  if (step.stopIf !== undefined) {
    const error = validateOneCondition(step.stopIf, 'stopIf', where);
    if (error) return error;
  }
  return null;
}

function validateRepeatSpec(spec: unknown, index: number): string | null {
  const where = describeStep(index);
  if (!isPlainObject(spec)) {
    return `repeat_max_invalid: ${where} "repeat" must be an object with an integer "max" from 1 to ${MAX_REPEAT}`;
  }
  for (const key of Object.keys(spec)) {
    if (key !== 'max' && key !== 'until' && key !== 'delayMs') {
      return `repeat_invalid: ${where} "repeat" does not take "${key}"`;
    }
  }
  const max = spec.max;
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > MAX_REPEAT) {
    return `repeat_max_invalid: ${where} "repeat.max" must be an integer from 1 to ${MAX_REPEAT}`;
  }
  if (spec.delayMs !== undefined) {
    const delay = spec.delayMs;
    if (typeof delay !== 'number' || !Number.isInteger(delay) || delay < 0) {
      return `delay_invalid: ${where} "repeat.delayMs" must be an integer from 0 to ${MAX_REPEAT_DELAY_MS}`;
    }
    if (delay > MAX_REPEAT_DELAY_MS) {
      return `delay_too_long: ${where} "repeat.delayMs" must not exceed ${MAX_REPEAT_DELAY_MS}`;
    }
  }
  if (spec.until !== undefined) {
    const error = validateOneCondition(spec.until, 'until', where);
    if (error) return error;
  }
  return null;
}

/**
 * 실행 전 검증: `as` 이름 규칙과 충돌, 조건 형태, 반복 묶음 규칙, `return` 이름.
 * 문제가 있으면 사람이 읽을 오류 문구를, 없으면 null 을 돌려준다.
 */
export function validateFlow(steps: RunnerStep[], returnNames?: unknown): string | null {
  const seen = new Set<string>();
  try {
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index];
      if (!isPlainObject(step)) continue;

      if (step.as !== undefined) assertValidCaptureName(step.as, seen);

      const conditionError = validateStepConditions(step, index);
      if (conditionError) return conditionError;

      if (isRepeatGroup(step)) {
        const specError = validateRepeatSpec(step.repeat, index);
        if (specError) return specError;

        const inner = step.steps;
        if (!Array.isArray(inner) || inner.length === 0) {
          return `repeat_invalid: ${describeStep(index)} must have a non-empty "steps" array`;
        }
        if (inner.length > MAX_STEPS) {
          return `repeat_invalid: ${describeStep(index)} steps must contain at most ${MAX_STEPS} items`;
        }
        for (let innerIndex = 0; innerIndex < inner.length; innerIndex++) {
          const child = inner[innerIndex];
          if (!isPlainObject(child)) continue;
          if (child.repeat !== undefined || Array.isArray(child.steps)) {
            return `nested_repeat: ${describeStep(innerIndex, index)} cannot contain another repeat group`;
          }
          if (child.as !== undefined) assertValidCaptureName(child.as, seen);
          const childError = validateStepConditions(child, innerIndex, index);
          if (childError) return childError;
        }
      } else if (Array.isArray(step.steps)) {
        // repeat 없이 steps 만 있는 항목: 이름 충돌만 본다 (실행 시점에 tool 누락으로 실패한다).
        for (const child of step.steps) {
          if (isPlainObject(child) && child.as !== undefined) {
            assertValidCaptureName(child.as, seen);
          }
        }
      }
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  if (returnNames !== undefined) {
    if (!Array.isArray(returnNames) || returnNames.some((n) => typeof n !== 'string')) {
      return 'return must be an array of names';
    }
    for (const name of returnNames as string[]) {
      if (!seen.has(name)) {
        return `unknown_return_name: "${name}" is not produced by any step "as"`;
      }
    }
  }

  return null;
}

/** 조건 노드 안의 모든 `path` 를 훑는다 (shortcut 이 `{{params.x}}` 선언을 대조할 때 쓴다). */
function forEachConditionPath(node: unknown, visit: (path: unknown) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) forEachConditionPath(child, visit);
    return;
  }
  if (!isPlainObject(node)) return;
  for (const key of Object.keys(node)) {
    if (key === 'all' || key === 'any' || key === 'not') forEachConditionPath(node[key], visit);
    else if (key === 'path') visit(node[key]);
  }
}

/** step 목록이 참조하는 `params` 이름 전부 (args 토큰 + 조건 path). */
export function collectFlowParamNames(steps: unknown): Set<string> {
  const names = new Set<string>();
  const addFromCondition = (node: unknown) => {
    forEachConditionPath(node, (path) => {
      const name = paramNameFromPath(path);
      if (name) names.add(name);
    });
  };
  const visitStep = (step: unknown) => {
    if (!isPlainObject(step)) return;
    collectParamNames(step.args, names);
    if (step.when !== undefined) addFromCondition(step.when);
    if (step.stopIf !== undefined) addFromCondition(step.stopIf);
    if (isPlainObject(step.repeat) && step.repeat.until !== undefined) {
      addFromCondition(step.repeat.until);
    }
    if (Array.isArray(step.steps)) {
      for (const child of step.steps) visitStep(child);
    }
  };
  if (Array.isArray(steps)) {
    for (const step of steps) visitStep(step);
  }
  return names;
}

/* ------------------------------------------------------------------ *
 * 조건 평가 (템플릿 스코프와 연결)
 * ------------------------------------------------------------------ */

type ConditionVerdict = { ok: true; value: boolean } | { ok: false; message: string };

/**
 * 조건의 `value` 만 먼저 치환한다 (설계 8b). `path` 는 조건 문법이라 치환하지 않는다.
 * 모르는 키는 그대로 남겨 `evaluateCondition` 의 형태 검사가 잡게 한다.
 */
function substituteConditionValues(node: unknown, scope: TemplateScope): unknown {
  if (Array.isArray(node)) return node.map((child) => substituteConditionValues(child, scope));
  if (!isPlainObject(node)) return node;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (key === 'all' || key === 'any' || key === 'not') {
      out[key] = substituteConditionValues(child, scope);
    } else if (key === 'value') {
      out[key] = substituteArgs({ value: child }, scope, new WeakSet<object>()).value;
    } else {
      out[key] = child;
    }
  }
  return out;
}

function evaluateFlowCondition(node: unknown, scope: TemplateScope): ConditionVerdict {
  let prepared: unknown;
  try {
    prepared = substituteConditionValues(node, scope);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  // resolve 는 던지지 않아야 한다. 금지 세그먼트 같은 오류는 여기 담아 두고 판정 뒤에 올린다.
  let pending: string | null = null;
  const resolve: ConditionPathResolver = (path) => {
    try {
      return resolvePathValue(path, scope);
    } catch (error) {
      if (pending === null) pending = error instanceof Error ? error.message : String(error);
      return { found: false };
    }
  };

  const result = evaluateCondition(prepared, resolve);
  if (pending !== null) return { ok: false, message: pending };
  if (!result.ok) {
    return { ok: false, message: `${surfaceConditionCode(result.code)}: ${result.message}` };
  }
  return { ok: true, value: result.value };
}

/* ------------------------------------------------------------------ *
 * 실행 컨텍스트
 * ------------------------------------------------------------------ */

interface RunContext {
  invoke: ToolInvoker;
  scope: TemplateScope;
  disallowedTools: ReadonlySet<string>;
  containerLabel: string;
  collectImages: boolean;
  templatesEnabled: boolean;
  backgroundModeOn: boolean;
  forceBackground: boolean;
  beforeStep?: () => Promise<void> | void;
  signal?: { readonly aborted: boolean; readonly reason?: unknown };
  aborted?: { reason: string; message: string };
  continueOnError: boolean;
  lane?: string;
  mcpSessionId?: string;
  images: RunnerImage[];
  capturedBytes: number;
  totalRuns: number;
  /** 벽시계 마감 시각. 흐름 제어가 꺼진 v1 호출에서는 null (실행 의미를 바꾸지 않는다). */
  deadline: number | null;
}

interface SingleOutcome {
  result: RunnerStepResult;
  stop?: { reason: BatchStopReason };
  captured?: { name: string; capture: StepCapture };
}

function setCapture(ctx: RunContext, name: string, capture: StepCapture): void {
  const previous = ctx.scope.named.get(name);
  if (previous) ctx.capturedBytes -= previous.bytes;
  ctx.scope.named.set(name, capture);
  ctx.capturedBytes += capture.bytes;
}

function clearCapture(ctx: RunContext, name: string): void {
  const previous = ctx.scope.named.get(name);
  if (!previous) return;
  ctx.capturedBytes -= previous.bytes;
  ctx.scope.named.delete(name);
}

/**
 * 바깥에서 실행이 취소됐는가 (2026-09-05 Codex 리뷰 5). 취소됐으면 이력 status 로 쓸
 * 사유와 문구를, 아니면 null 을 돌려준다.
 */
function abortSignalReason(ctx: RunContext): { reason: string; message: string } | null {
  if (ctx.signal?.aborted !== true) return null;
  const raw = ctx.signal.reason;
  const reason = typeof raw === 'string' && /^[a-z][a-z0-9_]*$/.test(raw) ? raw : 'aborted';
  return { reason, message: `${reason}: the run was cancelled before this step` };
}

/** 호출 직전 상한 검사. 넘었으면 그 이유를, 아니면 null 을 돌려준다. */
function limitReached(ctx: RunContext): BatchStopReason | null {
  if (ctx.deadline === null) return null;
  if (ctx.totalRuns >= MAX_TOTAL_RUNS) return 'total_runs_exceeded';
  if (Date.now() >= ctx.deadline) return 'timeout';
  return null;
}

/** 회차 사이 대기. 남은 예산을 넘겨 기다리지 않는다. */
async function sleepWithinDeadline(ms: number, ctx: RunContext): Promise<void> {
  if (ms <= 0) return;
  const budget = ctx.deadline === null ? ms : Math.min(ms, Math.max(0, ctx.deadline - Date.now()));
  if (budget > 0) await sleep(budget);
}

/* ------------------------------------------------------------------ *
 * step 하나 실행
 * ------------------------------------------------------------------ */

async function runSingleStep(
  step: RunnerStep,
  index: number,
  ctx: RunContext,
): Promise<SingleOutcome> {
  const toolName = typeof step?.tool === 'string' ? step.tool.trim() : '';
  const failed = (error: string): SingleOutcome => ({
    result: { index, tool: toolName, ok: false, error, status: 'failed' },
  });

  if (!toolName) return failed('step.tool must be a non-empty string');

  const argsInvalid =
    step?.args !== undefined &&
    (typeof step.args !== 'object' || step.args === null || Array.isArray(step.args));
  if (argsInvalid) return failed('step.args must be an object');

  if (ctx.disallowedTools.has(toolName)) {
    return failed(`tool "${toolName}" is not allowed inside ${ctx.containerLabel}`);
  }

  if (ctx.templatesEnabled && step.when !== undefined) {
    const verdict = evaluateFlowCondition(step.when, ctx.scope);
    if (!verdict.ok) return failed(verdict.message);
    if (!verdict.value) {
      // 건너뛴 step 은 prev 도 스냅샷도 갱신하지 않는다.
      return { result: { index, tool: toolName, ok: true, status: 'skipped' } };
    }
  }

  const limit = limitReached(ctx);
  if (limit) {
    return {
      result: { index, tool: toolName, ok: true, status: 'skipped' },
      stop: { reason: limit },
    };
  }

  // 바깥이 실행을 취소했으면 도구를 더 부르지 않는다 (탭이 더 열리는 것을 막는다).
  const cancelled = abortSignalReason(ctx);
  if (cancelled) {
    if (ctx.aborted === undefined) ctx.aborted = cancelled;
    return {
      result: { index, tool: toolName, ok: true, status: 'stopped', error: cancelled.message },
      stop: { reason: 'aborted' },
    };
  }

  let stepArgs: Record<string, any>;
  try {
    stepArgs = prepareStepArgs({
      rawArgs: step?.args,
      toolName,
      scope: ctx.scope,
      templatesEnabled: ctx.templatesEnabled,
      backgroundModeOn: ctx.backgroundModeOn,
      forceBackground: ctx.forceBackground,
      lane: ctx.lane,
      mcpSessionId: ctx.mcpSessionId,
    });
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }

  if (ctx.templatesEnabled) {
    const forbiddenAction = flowForbiddenAction(toolName, stepArgs);
    if (forbiddenAction) return failed(forbiddenAction);
  }

  // 도구를 부르기 직전에 실행을 계속해도 되는지 확인한다 (예약 실행의 탭 인계 검사).
  if (ctx.beforeStep) {
    try {
      await ctx.beforeStep();
    } catch (error) {
      const reason = error instanceof FlowAbortedError ? error.abortReason : 'aborted';
      const message = error instanceof Error ? error.message : String(error);
      if (ctx.aborted === undefined) ctx.aborted = { reason, message };
      return {
        result: { index, tool: toolName, ok: true, status: 'stopped', error: message },
        stop: { reason: 'aborted' },
      };
    }
  }

  let raw: any;
  ctx.totalRuns += 1;
  try {
    raw = await ctx.invoke({
      name: toolName,
      args: stepArgs,
      ...(ctx.deadline === null ? {} : { deadlineAt: ctx.deadline }),
      ...(ctx.forceBackground ? { effectiveBackgroundMode: true as const } : {}),
    });
  } catch (error) {
    // 흐름 제어 마감 초과는 실패가 아니라 "여기서 끊었다" 다 (항목 4).
    if (error instanceof FlowDeadlineExceededError) {
      return {
        result: { index, tool: toolName, ok: true, status: 'stopped', error: error.message },
        stop: { reason: 'timeout' },
      };
    }
    return failed(error instanceof Error ? error.message : String(error));
  }

  const ok = raw?.isError !== true;
  const text = extractResultText(raw);
  const result: RunnerStepResult = {
    index,
    tool: toolName,
    ok,
    status: ok ? 'completed' : 'failed',
  };
  if (ok) {
    if (text !== undefined) result.resultText = text;
  } else {
    result.error = text || 'tool returned an error';
  }

  // 실패 스텝의 이미지(게이트가 붙인 실패 스크린샷)도 원인 파악에 필요하므로 함께 모은다.
  if (ctx.collectImages) {
    const stepImages = extractResultImages(raw);
    if (stepImages.length > 0) {
      result.images = stepImages.length;
      for (const content of stepImages) {
        ctx.images.push({ index, tool: toolName, content });
      }
    }
  }

  const outcome: SingleOutcome = { result };

  if (!ctx.templatesEnabled) return outcome;

  const capture = buildCapture(raw, ok, ok ? null : (result.error ?? null));
  ctx.scope.prev = toPrevCapture(capture);

  if (typeof step.as === 'string') {
    try {
      assertCaptureFits(step.as, capture, ctx.capturedBytes);
      setCapture(ctx, step.as, capture);
      outcome.captured = { name: step.as, capture };
    } catch (error) {
      result.ok = false;
      result.status = 'failed';
      result.error = error instanceof Error ? error.message : String(error);
    }
  }

  if (result.ok && step.stopIf !== undefined) {
    const verdict = evaluateFlowCondition(step.stopIf, ctx.scope);
    if (!verdict.ok) {
      result.ok = false;
      result.status = 'failed';
      result.error = verdict.message;
    } else if (verdict.value) {
      result.status = 'stopped';
      outcome.stop = { reason: 'stopIf' };
    }
  }

  // 항목 6: raw 성공으로 먼저 기록한 캡처를 **최종 status 로** 맞춘다.
  // capture_too_large 나 stopIf 평가 오류로 step 이 실패로 뒤집혀도 예전에는
  // `{{prev.$ok}}` 가 true 였다 - 뒤 step 의 조건 판정이 조용히 반대로 갔다.
  syncCaptureWithStatus(ctx, result, outcome);

  return outcome;
}

/**
 * step 이 실패로 확정됐으면 `prev` 와 named capture 의 `$ok`·`$error` 를 맞춘다.
 * 본문(`$text`·값)은 실제로 돌아온 것이므로 그대로 둔다.
 */
function syncCaptureWithStatus(
  ctx: RunContext,
  result: RunnerStepResult,
  outcome: SingleOutcome,
  /** 묶음은 `prev` 를 만들지 않는다 - 안쪽 마지막 step 의 prev 를 뒤집으면 안 된다. */
  syncPrev = true,
): void {
  if (result.ok) return;
  const error = result.error ?? null;
  if (syncPrev && ctx.scope.prev !== undefined && ctx.scope.prev.ok) {
    ctx.scope.prev = { ...ctx.scope.prev, ok: false, error };
  }
  const name = outcome.captured?.name;
  if (name === undefined) return;
  const stored = ctx.scope.named.get(name);
  if (stored === undefined || !stored.ok) return;
  const synced: StepCapture = { ...stored, ok: false, error };
  setCapture(ctx, name, synced);
  outcome.captured = { name, capture: synced };
}

/* ------------------------------------------------------------------ *
 * 반복 묶음 실행
 * ------------------------------------------------------------------ */

async function runRepeatGroup(
  step: RunnerStep,
  index: number,
  ctx: RunContext,
): Promise<SingleOutcome> {
  const spec = (step.repeat ?? {}) as RepeatSpec;
  const max = typeof spec.max === 'number' ? spec.max : 0;
  const delayMs = typeof spec.delayMs === 'number' ? spec.delayMs : 0;
  const inner = Array.isArray(step.steps) ? step.steps : [];
  const innerNames = inner
    .map((child) => (isPlainObject(child) && typeof child.as === 'string' ? child.as : null))
    .filter((name): name is string => name !== null);

  if (step.when !== undefined) {
    const verdict = evaluateFlowCondition(step.when, ctx.scope);
    if (!verdict.ok) {
      return {
        result: { index, tool: 'repeat', ok: false, error: verdict.message, status: 'failed' },
      };
    }
    if (!verdict.value) {
      return { result: { index, tool: 'repeat', ok: true, status: 'skipped' } };
    }
  }

  const snapshots: Record<string, unknown>[] = [];
  const savedLoop = ctx.scope.loop;
  let stoppedBy: RepeatStoppedBy = 'max';
  let groupOk = true;
  let groupError: string | undefined;
  let lastResultText: string | undefined;
  let stop: { reason: BatchStopReason } | undefined;
  let count = 0;

  for (let iteration = 0; iteration < max; iteration++) {
    const limit = limitReached(ctx);
    if (limit) {
      stop = { reason: limit };
      stoppedBy = repeatStoppedByFor(limit);
      break;
    }

    // 회차 시작: 안쪽 이름과 prev 를 비운다 (회차 경계를 넘는 값은 없다).
    for (const name of innerNames) clearCapture(ctx, name);
    ctx.scope.prev = undefined;
    ctx.scope.loop = { index: iteration, count: iteration + 1 };
    count = iteration + 1;

    const snapshot: Record<string, unknown> = {};
    let iterationFailed = false;
    let iterationStopped = false;

    for (let innerIndex = 0; innerIndex < inner.length; innerIndex++) {
      const outcome = await runSingleStep(inner[innerIndex], innerIndex, ctx);
      // 항목 7: stopIf 로 멈춘 step 도 실제로 실행돼 결과가 있다. 예전에는 status 가
      // 'stopped' 라는 이유로 후보에서 빠져 묶음 resultText 가 비었다.
      if (
        (outcome.result.status === 'completed' || outcome.result.status === 'stopped') &&
        outcome.result.resultText !== undefined
      ) {
        lastResultText = outcome.result.resultText;
      }
      if (outcome.captured) {
        snapshot[outcome.captured.name] = outcome.captured.capture.value;
      }
      if (!outcome.result.ok) {
        groupOk = false;
        if (groupError === undefined) groupError = outcome.result.error;
        // 우선순위: 치명적 실패 > stopIf > until > continueOnError.
        if (!ctx.continueOnError) {
          iterationFailed = true;
          stoppedBy = 'failure';
          break;
        }
      }
      if (outcome.stop) {
        stop = outcome.stop;
        stoppedBy = repeatStoppedByFor(outcome.stop.reason);
        iterationStopped = true;
        break;
      }
    }

    snapshots.push(snapshot);
    if (iterationFailed || iterationStopped) break;

    if (spec.until !== undefined) {
      const verdict = evaluateFlowCondition(spec.until, ctx.scope);
      if (!verdict.ok) {
        groupOk = false;
        if (groupError === undefined) groupError = verdict.message;
        stoppedBy = 'failure';
        break;
      }
      if (verdict.value) {
        stoppedBy = 'until';
        break;
      }
    }

    if (iteration === max - 1) {
      stoppedBy = 'max';
      break;
    }

    if (delayMs > 0) await sleepWithinDeadline(delayMs, ctx);
  }

  ctx.scope.loop = savedLoop;

  const result: RunnerStepResult = {
    index,
    tool: 'repeat',
    ok: groupOk,
    status: groupOk ? (isRepeatStop(stoppedBy) ? 'stopped' : 'completed') : 'failed',
    attempts: { count, stoppedBy },
  };
  if (lastResultText !== undefined) result.resultText = lastResultText;
  if (groupError !== undefined) result.error = groupError;

  const outcome: SingleOutcome = { result };
  if (stop) outcome.stop = stop;

  if (typeof step.as === 'string') {
    const text = JSON.stringify(snapshots) ?? '[]';
    const capture: StepCapture = {
      ok: groupOk,
      error: groupError ?? null,
      text,
      value: snapshots,
      parsed: true,
      bytes: utf8ByteLength(text),
    };
    try {
      assertCaptureFits(step.as, capture, ctx.capturedBytes);
      setCapture(ctx, step.as, capture);
      outcome.captured = { name: step.as, capture };
    } catch (error) {
      result.ok = false;
      result.status = 'failed';
      result.error = error instanceof Error ? error.message : String(error);
    }
  }

  if (result.ok && step.stopIf !== undefined) {
    const verdict = evaluateFlowCondition(step.stopIf, ctx.scope);
    if (!verdict.ok) {
      result.ok = false;
      result.status = 'failed';
      result.error = verdict.message;
    } else if (verdict.value) {
      result.status = 'stopped';
      outcome.stop = { reason: 'stopIf' };
    }
  }

  syncCaptureWithStatus(ctx, result, outcome, false);

  return outcome;
}

/* ------------------------------------------------------------------ *
 * 실행기
 * ------------------------------------------------------------------ */

export async function runSteps(options: RunStepsOptions): Promise<RunStepsOutcome> {
  const {
    steps,
    invoke,
    continueOnError,
    lane,
    mcpSessionId,
    disallowedTools,
    containerLabel,
    skippedNote,
    collectImages,
    templatesEnabled,
    returnNames,
    params,
    forceBackground,
    beforeStep,
    deadlineAt,
    signal,
    reportLimitBytes,
    taskTitle,
  } = options;

  const titled = await beginTaskTitle(taskTitle, mcpSessionId, lane);
  try {
    return await runStepsInner();
  } finally {
    if (titled) await endMcpGroupTask();
  }

  async function runStepsInner(): Promise<RunStepsOutcome> {
    const results: RunnerStepResult[] = [];
    const scope = createTemplateScope();
    if (params !== undefined) scope.params = params;

    // 게이트에 들어가기 전에 background 를 강제할지 한 번만 정한다.
    const backgroundModeOn = templatesEnabled ? await isBackgroundModeEnabled() : false;

    const ctx: RunContext = {
      invoke,
      scope,
      disallowedTools,
      containerLabel,
      collectImages,
      templatesEnabled,
      backgroundModeOn,
      forceBackground: forceBackground === true,
      beforeStep,
      signal,
      continueOnError: continueOnError === true,
      lane,
      mcpSessionId,
      images: [],
      capturedBytes: 0,
      totalRuns: 0,
      // 상한은 흐름 제어가 켜진 호출에만 적용한다. v1 호출의 실행 의미를 바꾸지 않기 위해서다.
      // 바깥이 더 이른 마감을 줬으면(예약 러너의 end-to-end 예산) 그쪽을 따른다.
      deadline: templatesEnabled
        ? typeof deadlineAt === 'number'
          ? Math.min(deadlineAt, Date.now() + MAX_BATCH_MS)
          : Date.now() + MAX_BATCH_MS
        : typeof deadlineAt === 'number'
          ? deadlineAt
          : null,
    };

    let stoppedAtStep: number | undefined;
    let stoppedBy: { step: number; reason: BatchStopReason } | undefined;
    let success = true;

    for (let index = 0; index < steps.length; index++) {
      const step = steps[index];
      const toolName =
        typeof step?.tool === 'string' ? step.tool : isRepeatGroup(step) ? 'repeat' : '';

      // 앞에서 실패로 멈춘 경우: 남은 단계는 사유와 함께 skipped 로 보고한다.
      if (stoppedAtStep !== undefined) {
        results.push({ index, tool: toolName, ok: false, error: skippedNote, status: 'skipped' });
        continue;
      }
      // stopIf 나 상한으로 멈춘 경우: 남은 단계는 실패가 아니다.
      if (stoppedBy !== undefined) {
        results.push({ index, tool: toolName, ok: true, status: 'skipped' });
        continue;
      }

      const outcome =
        templatesEnabled && isRepeatGroup(step)
          ? await runRepeatGroup(step, index, ctx)
          : await runSingleStep(step, index, ctx);

      if (typeof step?.as === 'string' && outcome.result.as === undefined) {
        outcome.result.as = step.as;
      }
      results.push(outcome.result);

      if (!outcome.result.ok) {
        success = false;
        if (!ctx.continueOnError) stoppedAtStep = index;
      }
      if (outcome.stop && stoppedBy === undefined) {
        stoppedBy = { step: index, reason: outcome.stop.reason };
      }
    }

    const outcome: RunStepsOutcome = { success, results, images: ctx.images };
    if (stoppedAtStep !== undefined) outcome.stoppedAtStep = stoppedAtStep;
    if (stoppedBy !== undefined) outcome.stoppedBy = stoppedBy;

    if (Array.isArray(returnNames) && returnNames.length > 0) {
      const { returned, truncated } = buildReturnPayload(returnNames, scope.named);
      outcome.returned = returned;
      if (truncated.length > 0) outcome.resultsTruncated = truncated;
      if (typeof reportLimitBytes === 'number' && reportLimitBytes > 0) {
        const report = buildReportPayload(returnNames, scope.named, reportLimitBytes);
        outcome.reportReturned = report.returned;
        if (report.truncated.length > 0) outcome.reportTruncated = report.truncated;
      }
    }
    if (ctx.aborted !== undefined) outcome.aborted = ctx.aborted;

    return outcome;
  }
}

/**
 * 실행 중 MCP 탭 그룹 제목을 작업 이름으로 바꾼다. 제목을 실제로 바꿨으면 true.
 *
 * 이 세션·레인의 작업 탭이 이미 있으면 그 창의 그룹에 지금 바로 반영하고, 아직 없으면
 * 실행 중 navigate 가 탭을 만들 때 그 제목으로 그룹이 생긴다(mcp-tab-group 이 현재 작업
 * 제목을 읽는다). 어떤 실패도 실행을 막지 않는다 - 제목은 표시용이다.
 */
async function beginTaskTitle(
  taskTitle: string | undefined,
  mcpSessionId: string | undefined,
  lane: string | undefined,
): Promise<boolean> {
  if (typeof taskTitle !== 'string' || taskTitle.trim().length === 0) return false;
  try {
    beginMcpGroupTask(taskTitle);
    const workTabId = await getWorkTabId(sessionKeyOf({ _mcpSessionId: mcpSessionId, lane }));
    if (workTabId !== null) {
      const tab = await chrome.tabs.get(workTabId);
      await setMcpGroupTitle(tab?.windowId, taskTitle);
    }
    return true;
  } catch (error) {
    console.warn('[batch-runner] 탭 그룹 제목 지정 실패(무시):', error);
    return true;
  }
}

/** 이 도구에서 `url` 이 대상 탭을 고르는가 (고르면 치환 금지 키가 된다). */
function urlSelectsTarget(toolName: string): boolean {
  return URL_SELECTS_TARGET_TOOLS.has(toolName) || toolName === TOOL_NAMES.BROWSER.CLOSE_TABS;
}

function forbiddenKeysFor(toolName: string): ReadonlySet<string> {
  if (!urlSelectsTarget(toolName)) return ALWAYS_FORBIDDEN_TEMPLATE_KEYS;
  return new Set([...ALWAYS_FORBIDDEN_TEMPLATE_KEYS, 'url']);
}

interface PrepareArgsInput {
  rawArgs: Record<string, any> | undefined;
  toolName: string;
  scope: TemplateScope;
  templatesEnabled: boolean;
  backgroundModeOn: boolean;
  /** 예약 실행처럼 전역 토글과 무관하게 background 를 강제하는 실행인가. */
  forceBackground?: boolean;
  lane?: string;
  mcpSessionId?: string;
}

/**
 * step 하나의 인자를 실행 직전 형태로 만든다.
 *
 * 순서(설계 4절): 금지 키 1차 검사 -> 치환 -> 금지 키 2차 검사 ->
 * `_mcpSessionId`·`lane` 제거 후 바깥 컨텍스트 재주입 -> background 강제.
 */
export function prepareStepArgs(input: PrepareArgsInput): Record<string, any> {
  const {
    rawArgs,
    toolName,
    scope,
    templatesEnabled,
    backgroundModeOn,
    forceBackground,
    lane,
    mcpSessionId,
  } = input;

  let stepArgs: Record<string, any>;

  if (templatesEnabled) {
    const forbidden = forbiddenKeysFor(toolName);
    const source = rawArgs ?? {};
    // 0차: prototype 을 건드릴 수 있는 키 이름은 값과 무관하게 먼저 거절한다 (항목 1-a).
    assertNoDangerousArgKeys(source);
    assertNoTemplatedForbiddenKeys(source, forbidden);
    const marks: WeakSet<object> = new WeakSet();
    stepArgs = substituteArgs(source, scope, marks);
    assertNoInjectedForbiddenKeys(stepArgs, marks, forbidden);
    // 2차 검사는 own 키만 보므로, 상속으로 실려 온 대상 지정 키를 여기서 한 번 더 막는다.
    assertPlainArgsShape(stepArgs, forbidden);
  } else {
    stepArgs = { ...(rawArgs ?? {}) };
  }

  // auto-chrome-mcp fork: 실행 컨텍스트 키는 step 이 정하지 못한다.
  // 무조건 지운 뒤, 바깥 batch/shortcut 호출에 값이 있을 때만 다시 넣는다.
  delete stepArgs._mcpSessionId;
  delete stepArgs.lane;
  if (typeof mcpSessionId === 'string' && mcpSessionId) {
    stepArgs._mcpSessionId = mcpSessionId;
  }
  if (typeof lane === 'string' && lane) {
    stepArgs.lane = lane;
  }

  // auto-chrome-mcp fork(2026-09-05 설계 2절): 실행 컨텍스트 모드는 스키마에 없는 내부
  // 전용 값이다. step args 에 적혀 있어도 신뢰하지 않고 지운다 - 저장된 step 이 스스로
  // "나는 무간섭 실행이다" 라고 주장할 수 있으면 판정을 호출자가 조작하게 된다.
  stripEffectiveBackgroundMode(stepArgs);

  // 전역 background mode 가 켜져 있으면 게이트 전에 background 를 true 로 덮는다.
  // 실행 컨텍스트가 background 를 강제하는 실행(예약)도 마찬가지다.
  if (backgroundModeOn || forceBackground === true) {
    stepArgs.background = true;
  }

  return stepArgs;
}

function buildReturnPayload(
  names: string[],
  named: Map<string, StepCapture>,
): { returned: Record<string, unknown>; truncated: string[] } {
  const returned: Record<string, unknown> = {};
  const truncated: string[] = [];
  let total = 0;

  for (const name of names) {
    const capture = named.get(name);
    if (!capture || capture.value === undefined) continue;
    let serialized: string;
    try {
      serialized = JSON.stringify(capture.value) ?? '';
    } catch {
      truncated.push(name);
      continue;
    }
    if (
      serialized.length > MAX_RETURN_ITEM_CHARS ||
      total + serialized.length > MAX_RETURN_TOTAL_CHARS
    ) {
      truncated.push(name);
      continue;
    }
    total += serialized.length;
    returned[name] = capture.value;
  }

  return { returned, truncated };
}

/**
 * report 파일용 `return` 페이로드 (2026-09-05 Codex 리뷰 10).
 *
 * 이력용 페이로드와 상한만 다르다: 항목 하나도 전체도 `limitBytes`(UTF-8 byte) 안에
 * 담기며, 넘는 항목은 자르지 않고 통째로 뺀다. 잘린 JSON 은 파싱이 안 되기 때문이다.
 */
const reportEncoder = new TextEncoder();

export function buildReportPayload(
  names: string[],
  named: Map<string, StepCapture>,
  limitBytes: number,
): { returned: Record<string, unknown>; truncated: string[] } {
  const returned: Record<string, unknown> = {};
  const truncated: string[] = [];
  let total = 0;

  for (const name of names) {
    const capture = named.get(name);
    if (!capture || capture.value === undefined) continue;
    let serialized: string;
    try {
      serialized = JSON.stringify(capture.value) ?? '';
    } catch {
      truncated.push(name);
      continue;
    }
    const size = reportEncoder.encode(serialized).length;
    if (size > limitBytes || total + size > limitBytes) {
      truncated.push(name);
      continue;
    }
    total += size;
    returned[name] = capture.value;
  }

  return { returned, truncated };
}

export { StepTemplateError };
