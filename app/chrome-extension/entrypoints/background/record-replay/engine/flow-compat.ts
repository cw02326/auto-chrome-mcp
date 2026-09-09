/**
 * 구버전 실행 차단 게이트 (PR B0).
 *
 * 계약: docs/plans/2026-09-09-recorder-toolbar-and-multitab-design.md 2.8 절.
 *
 * 왜 있나
 * -------
 * 여러 탭 흐름은 `closeTab { tabRef: n }` 같은 단계를 남긴다. 이 필드를 모르는
 * 구버전 실행기는 `nodes/tabs.ts` 의 `closeTabNode` 에서 "인자가 없다" 로 보고 **현재 run
 * 탭을 닫는다**. 사용자가 보던 탭이 사라지는 사고다.
 *
 * 그래서 새 기능을 쓰는 흐름은 실행 자체를 거부해야 한다. 이 모듈은 그 판정 한 곳이고,
 * 실행을 시작하는 모든 진입점이 여기를 지난다.
 *
 * 무엇을 보나
 * -----------
 *   1. `flow.meta.features`  흐름이 요구한다고 스스로 밝힌 기능 이름 목록.
 *   2. `flow.meta.minEngine` 이 흐름을 돌릴 수 있는 최소 확장 버전.
 *   3. 표시가 없어도 단계 어딘가에 `tabRef` 가 들어 있으면 여러 탭 기능을
 *      요구하는 것으로 본다. 표시를 지운 채 내보낸 흐름이나 손으로 고친 JSON 이 게이트를
 *      우회하지 못하게 하는 장치다.
 *
 * 셋 다 없는 흐름(= 지금까지 저장된 모든 흐름)은 언제나 실행 가능하다. 이 파일이 들어와도
 * 사용자가 체감하는 변화는 없어야 한다.
 */

import type { Flow } from '../types';

/** 흐름이 요구할 수 있는 기능 이름. 문자열 상수는 저장 형식의 일부이므로 바꾸지 않는다. */
export const FLOW_FEATURES = {
  /** 여러 탭 녹화·재생 (`tabRef`). 1.14.0 부터 지원한다. */
  MULTITAB: 'multitab',
} as const;

export type FlowFeature = (typeof FLOW_FEATURES)[keyof typeof FLOW_FEATURES];

/** 각 기능이 처음 들어온 확장 버전. 흐름이 `minEngine` 을 밝히지 않았을 때 쓴다. */
export const FEATURE_MIN_ENGINE: Record<string, string> = Object.freeze({
  [FLOW_FEATURES.MULTITAB]: '1.14.0',
});

/**
 * **지금 이 실행기가 지원하는 기능 목록.**
 *
 * 2026-09-09 PR B(여러 탭 본체)로 `tabRef` 를 실제로 해석하게 되어
 * `FLOW_FEATURES.MULTITAB` 이 들어왔다. 순서가 중요하다: 구현과 테스트가 모두 끝난 뒤에
 * 마지막으로 넣는다. 먼저 넣으면 아직 해석하지 못하는 흐름을 실행하게 되고, 반대로 녹화가
 * 표시를 먼저 남기면 자기 브라우저가 자기 흐름을 거절한다.
 */
export const ENGINE_FEATURES: readonly string[] = Object.freeze([FLOW_FEATURES.MULTITAB]);

/**
 * 매니페스트를 읽지 못할 때 쓰는 엔진 버전(테스트 환경 등).
 *
 * 평소에는 `chrome.runtime.getManifest().version` 을 읽으므로 package.json 한 곳만 올리면
 * 된다. 이 상수는 매니페스트가 없는 환경의 폴백일 뿐이다.
 */
export const ENGINE_VERSION_FALLBACK = '1.13.0';

/** 게이트가 거절할 때 쓰는 오류 코드. 기존 `flow_not_published` 등과 같은 자리에 온다. */
export const FLOW_REQUIRES_NEWER_ENGINE = 'flow_requires_newer_engine';

export interface FlowCompatOptions {
  /** 지원 기능 목록 대역(테스트·PR B 검증용). 없으면 `ENGINE_FEATURES`. */
  engineFeatures?: readonly string[];
  /** 엔진 버전 대역. 없으면 매니페스트 버전. */
  engineVersion?: string;
}

export interface FlowCompatRejection {
  ok: false;
  errorCode: typeof FLOW_REQUIRES_NEWER_ENGINE;
  /** 사용자에게 그대로 보여도 되는 한국어 문구. */
  error: string;
  /** 흐름이 요구했지만 이 실행기에 없는 기능 이름. */
  missingFeatures: string[];
  /** 흐름이 요구한 최소 버전(있을 때만). */
  minEngine?: string;
}

export type FlowCompatVerdict = { ok: true } | FlowCompatRejection;

/** `assertFlowRunnable` 이 던지는 오류. 호출자가 코드로 구분할 수 있게 필드를 싣는다. */
export class FlowCompatError extends Error {
  readonly errorCode = FLOW_REQUIRES_NEWER_ENGINE;
  readonly missingFeatures: string[];
  readonly minEngine?: string;

  constructor(rejection: FlowCompatRejection) {
    super(rejection.error);
    this.name = 'FlowCompatError';
    this.missingFeatures = rejection.missingFeatures;
    this.minEngine = rejection.minEngine;
  }
}

/** 설치된 확장 버전. 매니페스트를 못 읽으면 폴백 상수. */
export function engineVersion(): string {
  try {
    const version = (
      globalThis as { chrome?: { runtime?: { getManifest?: () => { version?: string } } } }
    ).chrome?.runtime?.getManifest?.()?.version;
    if (typeof version === 'string' && version.trim()) return version.trim();
  } catch {
    // 매니페스트가 없는 환경(테스트 등)은 폴백으로 내려간다.
  }
  return ENGINE_VERSION_FALLBACK;
}

/**
 * `1.14.0` 꼴 버전 비교. a < b 면 음수, 같으면 0, a > b 면 양수.
 *
 * 숫자 마디만 본다. `1.14.0-beta.1` 의 꼬리표는 무시하므로 같은 숫자 버전끼리는 동등하다.
 * 게이트는 "이 이상이면 실행" 만 판정하므로 이 정도로 충분하다.
 */
export function compareEngineVersions(a: string, b: string): number {
  const parse = (value: string): number[] =>
    String(value)
      .trim()
      .split(/[-+]/)[0]
      .split('.')
      .map((part) => {
        const n = Number.parseInt(part, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const left = parse(a);
  const right = parse(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * 값 하나가 여러 탭 필드를 들고 있는가.
 *
 * 지금 저장 형식에서 여러 탭을 쓴다는 표시는 `tabRef` 하나뿐이다. (클릭에 붙이던
 * `opensTab` 기대는 2026-09-09 축소 결정으로 없앴다. 브라우저가 "이 클릭이 이 탭을
 * 만들었다" 는 인과를 알려 주지 않아, 무관한 탭을 잡을 위험을 없앨 수 없었다.)
 */
function carriesMultitabFields(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return (value as Record<string, unknown>).tabRef !== undefined;
}

/**
 * 흐름이 요구하는 기능 이름 전부.
 *
 * 스스로 밝힌 `meta.features` 와, 단계에서 읽어 낸 것을 합친다. 중복은 없앤다.
 */
export function collectRequiredFeatures(flow: unknown): string[] {
  const required = new Set<string>();

  const meta = (flow as { meta?: { features?: unknown } } | null | undefined)?.meta;
  const declared = meta?.features;
  if (Array.isArray(declared)) {
    for (const name of declared) {
      if (typeof name === 'string' && name.trim()) required.add(name.trim());
    }
  }

  if (scanNodes((flow as { nodes?: unknown } | null | undefined)?.nodes)) {
    required.add(FLOW_FEATURES.MULTITAB);
  }

  // 옛 steps 배열로 들어온 흐름(가져오기·예전 내보내기)도 같은 눈으로 본다.
  if (!required.has(FLOW_FEATURES.MULTITAB)) {
    const steps = (flow as { steps?: unknown } | null | undefined)?.steps;
    if (Array.isArray(steps) && steps.some((step) => carriesMultitabFields(step))) {
      required.add(FLOW_FEATURES.MULTITAB);
    }
  }

  // 하위 흐름(foreach·while·loopElements 가 도는 subflows)도 같은 실행기가 돌린다. 여기를
  // 보지 않으면 표시 없는 subflow 안의 `tabRef` 가 게이트를 그냥 지나간다 (검토 사소).
  if (!required.has(FLOW_FEATURES.MULTITAB)) {
    const subflows = (flow as { subflows?: unknown } | null | undefined)?.subflows;
    if (subflows && typeof subflows === 'object') {
      for (const sub of Object.values(subflows as Record<string, unknown>)) {
        const subNodes = (sub as { nodes?: unknown } | null | undefined)?.nodes;
        const subSteps = (sub as { steps?: unknown } | null | undefined)?.steps;
        if (
          scanNodes(subNodes) ||
          (Array.isArray(subSteps) && subSteps.some((step) => carriesMultitabFields(step)))
        ) {
          required.add(FLOW_FEATURES.MULTITAB);
          break;
        }
      }
    }
  }

  return [...required];
}

/** 노드 배열에 여러 탭 필드가 있는가. */
function scanNodes(nodes: unknown): boolean {
  if (!Array.isArray(nodes)) return false;
  return nodes.some((node) => carriesMultitabFields((node as { config?: unknown } | null)?.config));
}

/** 흐름이 밝힌 최소 엔진 버전. 없거나 형식이 아니면 undefined. */
function declaredMinEngine(flow: unknown): string | undefined {
  const value = (flow as { meta?: { minEngine?: unknown } } | null | undefined)?.meta?.minEngine;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

const UPDATE_GUIDE = '확장을 최신 버전으로 업데이트한 뒤 다시 실행해 주세요.';

/**
 * 이 흐름을 지금 실행기가 돌려도 되는지 판정한다. 던지지 않는 판.
 *
 * 결과를 그대로 응답에 실을 수 있게 `errorCode` 와 한국어 `error` 를 함께 돌려준다.
 */
export function checkFlowRunnable(
  flow: Flow | unknown,
  options: FlowCompatOptions = {},
): FlowCompatVerdict {
  const supported = new Set(options.engineFeatures ?? ENGINE_FEATURES);
  const required = collectRequiredFeatures(flow);
  const missing = required.filter((name) => !supported.has(name));

  // 흐름이 최소 버전을 밝히지 않았어도, 그 기능이 처음 들어온 버전은 우리가 안다.
  // 밝히지 않은 흐름이 옛 실행기에서 그냥 도는 구멍을 막는다 (검토 D5).
  const impliedMinEngine = required.includes(FLOW_FEATURES.MULTITAB)
    ? FEATURE_MIN_ENGINE[FLOW_FEATURES.MULTITAB]
    : undefined;
  // 선언값과 기능이 요구하는 값 중 **높은 쪽**을 쓴다. 낮은 값을 적어 두면 하한이
  // 우회되기 때문이다 (검토 E4).
  const declared = declaredMinEngine(flow);
  const minEngine =
    declared && impliedMinEngine
      ? compareEngineVersions(declared, impliedMinEngine) >= 0
        ? declared
        : impliedMinEngine
      : (declared ?? impliedMinEngine);
  const current = options.engineVersion ?? engineVersion();
  const tooOld = minEngine ? compareEngineVersions(current, minEngine) < 0 : false;

  if (missing.length === 0 && !tooOld) return { ok: true };

  const detail = tooOld
    ? `이 흐름은 확장 ${minEngine} 이상에서 실행할 수 있어요. 지금 설치된 확장은 ${current} 이에요.`
    : `이 흐름은 더 새로운 버전의 확장에서 만들어졌어요. 지금 설치된 확장이 아직 모르는 기능(${missing.join(', ')})을 씁니다.`;

  return {
    ok: false,
    errorCode: FLOW_REQUIRES_NEWER_ENGINE,
    error: `${FLOW_REQUIRES_NEWER_ENGINE}: ${detail} ${UPDATE_GUIDE}`,
    missingFeatures: missing,
    ...(minEngine ? { minEngine } : {}),
  };
}

/**
 * 실행 직전 관문. 돌릴 수 없는 흐름이면 `FlowCompatError` 를 던진다.
 *
 * 응답 형태를 스스로 만드는 진입점은 `checkFlowRunnable` 을 쓰고, 예외로 멈추는 편이 나은
 * 자리(엔진 본체 등)는 이쪽을 쓴다. 판정 규칙은 한 곳뿐이다.
 */
export function assertFlowRunnable(flow: Flow | unknown, options: FlowCompatOptions = {}): void {
  const verdict = checkFlowRunnable(flow, options);
  if (!verdict.ok) throw new FlowCompatError(verdict);
}
