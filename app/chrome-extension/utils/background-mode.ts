/**
 * Background work mode policy gate (scalemaker fork).
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
