/**
 * Background work mode policy gate (auto-chrome-mcp fork).
 *
 * ON 이면 MCP 도구 실행이 사용자의 브라우징을 방해하지 않는다:
 *   - 도구 args 에 background 가 미지정이면 true 로 주입 (tools/index.ts handleCallTool 게이트)
 *   - 도구 args 에 tabId 가 미지정이면 MCP 작업 탭(work-tab-manager)을 주입
 *   - ensureFocus 의 tabs.update({active:true}) 를 skip (forceActivate 제외)
 *
 * 예외 도구 (게이트 미적용): chrome_switch_tab, chrome_request_element_selection,
 * chrome_request_user_consent — 정의상 사용자 대면 동작.
 *
 * 기본값 true — 별도 설정 없이 무간섭 동작. popup 토글로 OFF 가능.
 * OS 윈도우 포커스는 별도 정책 utils/focus-policy.ts 가 담당한다.
 */

const STORAGE_KEY = 'backgroundWorkMode';

export async function isBackgroundModeEnabled(): Promise<boolean> {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEY]);
    return result[STORAGE_KEY] !== false;
  } catch {
    return true;
  }
}

export async function setBackgroundModeEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: enabled });
}

export const BACKGROUND_MODE_STORAGE_KEY = STORAGE_KEY;

/**
 * auto-chrome-mcp fork(2026-09-05 데일리 자동화 설계 2절): **실행 컨텍스트 모드**.
 *
 * 예약 실행처럼 "전역 토글과 무관하게 항상 무간섭이어야 하는" 실행이 있다. 인자
 * `background: true` 만 덮는 방식으로는 부족하다. 전역 토글이 OFF 면 게이트가 작업 탭
 * 주입 자체를 건너뛰고, 그 뒤 도구 구현이 사용자의 활성 탭으로 fallback 하기 때문이다.
 * 그래서 모드를 **호출 체인에 실어** 게이트·url 대상 해석·navigate 재사용·활성화 가드·
 * chrome_close_tabs 가 같은 답을 내게 한다.
 *
 * 전달 경로: runSteps({ forceBackground: true })
 *   -> ToolCallParam.effectiveBackgroundMode (러너 -> handleCallTool)
 *   -> args[EFFECTIVE_BACKGROUND_MODE_ARG] (handleCallTool -> 게이트와 도구 구현)
 *
 * 이 키는 스키마에 없다. 바깥에서 들어온 인자에 적혀 있으면 신뢰하지 않고 버린다
 * (handleCallTool 과 batch-runner 의 prepareStepArgs 가 둘 다 지운다). 모델이 스스로
 * 켤 수 있으면 "무간섭" 판정을 호출자가 조작할 수 있게 되므로 내부 전용으로 둔다.
 */
export const EFFECTIVE_BACKGROUND_MODE_ARG = '_effectiveBackgroundMode';

/** 바깥에서 들어온 인자가 흉내 낼 수 없도록 지워야 하는 키들. */
export const EFFECTIVE_BACKGROUND_MODE_KEYS: readonly string[] = [
  EFFECTIVE_BACKGROUND_MODE_ARG,
  'effectiveBackgroundMode',
];

/** args 에서 실행 컨텍스트 모드를 읽는다. own 속성만 본다(상속 값은 게이트 우회 경로였다). */
export function effectiveBackgroundModeOf(args: unknown): true | undefined {
  if (args === null || typeof args !== 'object') return undefined;
  if (!Object.hasOwn(args as object, EFFECTIVE_BACKGROUND_MODE_ARG)) return undefined;
  return (args as Record<string, unknown>)[EFFECTIVE_BACKGROUND_MODE_ARG] === true
    ? true
    : undefined;
}

/** 내부 전용 모드 키를 인자에서 제거한다 (호출자가 적어 보낸 값은 신뢰하지 않는다). */
export function stripEffectiveBackgroundMode(args: any): void {
  if (args === null || typeof args !== 'object') return;
  for (const key of EFFECTIVE_BACKGROUND_MODE_KEYS) delete args[key];
}

/**
 * 이 호출에 적용할 백그라운드 모드. 실행 컨텍스트 값이 전역 토글보다 **우선**이다.
 * 값이 없으면 지금처럼 전역 토글을 본다.
 */
export async function isBackgroundModeEnabledFor(args: unknown): Promise<boolean> {
  if (effectiveBackgroundModeOf(args) === true) return true;
  return await isBackgroundModeEnabled();
}
