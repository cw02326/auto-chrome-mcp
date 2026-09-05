/**
 * Activation guard (auto-chrome-mcp fork, v1.9.0 무간섭 모드).
 *
 * "사용자 화면을 바꾸는 크롬 API" 를 한곳으로 모은 모듈이다. 경로마다 조건문을 붙이는
 * 방식은 v1.8.0 까지 여러 번 새어 나갔다 — web-fetcher·console·inject-script·
 * network-capture·gif-recorder·플로우 재생이 각자 다른 조건으로 탭을 활성화했다.
 *
 * 그래서 아래 넷은 **이 모듈을 통해서만** 호출한다:
 *
 *   chrome.tabs.update({active:true})      → activateTab()
 *   chrome.tabs.create({active:true})      → createTab()
 *   chrome.windows.update({focused:true})  → focusWindow()
 *   chrome.windows.create(...)             → mcp-window-manager.createManagedWindow()
 *
 * 예외로 남겨 둔 직접 호출부(의도적):
 *   - 이 모듈 자신과 utils/window-focus-guard.ts(비포커스 전용), utils/mcp-window-manager.ts
 *   - utils/spawned-tab-tracker.ts 의 사용자 창 복귀(windows.update({focused:true}) 만,
 *     대상이 사용자 창일 때. 탭 활성화는 이 모듈의 force 경로를 쓴다)
 *   - 사용자 UI 진입점: entrypoints/popup, entrypoints/sidepanel, quick-panel
 *   - 예외 도구 chrome_request_user_consent(사용자 대면 창)
 *
 * 판정 규칙(activateTab / createTab):
 *   1. force:true — 예외 도구(chrome_switch_tab, chrome_request_element_selection,
 *      chrome_request_user_consent)와 "사용자가 보던 탭을 원래대로 되돌리는" 복구 동작만.
 *   2. 백그라운드 작업 모드 OFF — 사용자가 토글을 껐다는 뜻이므로 예전 동작(항상 활성화).
 *   3. 대상 탭이 전용 MCP 작업 창 안에 있으면 활성화. 그 창은 사용자 화면 밖이라 안전하고,
 *      탭이 보여야 렌더링 throttling 없이 페이지가 정상 동작한다.
 *   4. 그 외 — 활성화하지 않는다(로그만 남긴다). 사용자가 보던 탭을 뺏지 않는다.
 *
 * 윈도우 포커스(focusWindow)는 별개의 토글(강제 포커스, 기본 OFF)이 담당한다.
 * 탭 활성화는 이 토글과 무관하다 — 강제 포커스를 켜도 활성화는 전용 창 안에서만 일어난다.
 */

import { isBackgroundModeEnabled, isBackgroundModeEnabledFor } from './background-mode';
import { isMcpWindow } from './mcp-window-manager';

const FORCE_FOCUS_STORAGE_KEY = 'forceFocusOnToolCall';

export interface ActivationOptions {
  /** 예외 도구·복구 동작만 true. 게이트를 통째로 우회한다. */
  force?: boolean;
  /** 로그에 남길 호출자 이름 (예: 'gif-recorder'). */
  reason?: string;
  /**
   * auto-chrome-mcp fork(2026-09-05 데일리 자동화 설계 2절): 이 호출의 도구 인자.
   * 인자에 실행 컨텍스트 모드가 실려 있으면 전역 토글보다 그 값을 먼저 본다 -
   * 예약 실행은 전역 토글이 OFF 여도 사용자 탭을 활성화하지 않는다.
   */
  contextArgs?: unknown;
}

/**
 * 강제 포커스 정책 — OS 윈도우 포커스를 가져올지. 기본 false.
 * (탭 활성화와는 별개다. 이 토글을 켜도 활성화 규칙은 위 1~4 그대로다.)
 */
export async function isForceFocusEnabled(): Promise<boolean> {
  try {
    const result = await chrome.storage.local.get([FORCE_FOCUS_STORAGE_KEY]);
    return result[FORCE_FOCUS_STORAGE_KEY] === true;
  } catch {
    return false;
  }
}

export async function setForceFocusEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [FORCE_FOCUS_STORAGE_KEY]: enabled });
}

/**
 * 강제 포커스 정책을 통과한 경우에만 chrome.windows.update({focused:true}).
 * (구 이름 focusWindowIfAllowed — utils/focus-policy.ts 가 이 함수를 재수출한다)
 */
export async function focusWindow(
  windowId: number | undefined,
  extra: chrome.windows.UpdateInfo = {},
): Promise<void> {
  if (typeof windowId !== 'number') return;
  const enabled = await isForceFocusEnabled();
  if (!enabled) return;
  await chrome.windows.update(windowId, { ...extra, focused: true });
}

/**
 * 이 창의 탭을 활성화해도 되는가. windowId 를 모르면(새 탭을 어디에 만들지 미지정)
 * 사용자 창으로 간주해 불허한다.
 */
export async function isActivationAllowed(
  windowId: number | undefined | null,
  options: ActivationOptions = {},
): Promise<boolean> {
  if (options.force === true) return true;
  try {
    const enabled =
      options.contextArgs === undefined
        ? await isBackgroundModeEnabled()
        : await isBackgroundModeEnabledFor(options.contextArgs);
    if (!enabled) return true;
  } catch {
    // 조회 실패 시에는 무간섭 쪽(기본 ON)으로 간주한다.
  }
  return await isMcpWindow(windowId ?? null);
}

/**
 * 탭 활성화의 유일한 통로. 활성화했으면 true.
 */
export async function activateTab(
  tabId: number | undefined,
  options: ActivationOptions = {},
): Promise<boolean> {
  if (typeof tabId !== 'number') return false;
  let windowId: number | undefined;
  try {
    const tab = await chrome.tabs.get(tabId);
    windowId = tab.windowId;
  } catch {
    return false;
  }
  if (!(await isActivationAllowed(windowId, options))) {
    console.log(
      `[activation-guard] skip tabs.update({active:true}) tab=${tabId} window=${windowId} reason=${
        options.reason ?? 'unspecified'
      }`,
    );
    return false;
  }
  try {
    await chrome.tabs.update(tabId, { active: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 탭 생성의 유일한 통로. active:true 를 요청해도 규칙에 걸리면 비활성으로 만든다.
 */
export async function createTab(
  createProperties: chrome.tabs.CreateProperties,
  options: ActivationOptions = {},
): Promise<chrome.tabs.Tab> {
  if (createProperties.active !== true) {
    return await chrome.tabs.create(createProperties);
  }
  const allowed = await isActivationAllowed(createProperties.windowId, options);
  if (allowed) return await chrome.tabs.create(createProperties);
  console.log(
    `[activation-guard] downgrade tabs.create active:true → false window=${
      createProperties.windowId ?? 'current'
    } reason=${options.reason ?? 'unspecified'}`,
  );
  return await chrome.tabs.create({ ...createProperties, active: false });
}

export const FORCE_FOCUS_STORAGE_KEY_NAME = FORCE_FOCUS_STORAGE_KEY;
