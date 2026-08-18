/**
 * Force-focus policy gate (auto-chrome-mcp fork).
 *
 * MCP 도구 실행 시 chrome.windows.update({focused: true}) 가 OS 레벨로 Chrome 윈도우를
 * 다른 앱 앞으로 끌어내는 동작을 사용자가 popup 토글로 끌 수 있게 한다.
 *
 * 범위 — OS 윈도우 포커스만 게이트:
 *   - chrome.windows.update({focused: true})    → 정책 OFF 면 호출 자체 skip
 *   - chrome.windows.create({focused: true})    → 정책 OFF 면 focused: false 로 생성
 * 범위 밖 (항상 호출):
 *   - chrome.tabs.update({active: true})        → 같은 윈도우 내 탭 전환 (screenshot/click 동작에 필수)
 *   - chrome.tabs.create({active: true})        → 새 탭 생성 + 활성화
 *
 * 기본값 false — 새로 설치하는 사용자는 강제 포커스 없음. 사용자가 명시적으로 ON 으로 토글해야 동작.
 */

const STORAGE_KEY = 'forceFocusOnToolCall';

export async function isForceFocusEnabled(): Promise<boolean> {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEY]);
    return result[STORAGE_KEY] === true;
  } catch {
    return false;
  }
}

export async function setForceFocusEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: enabled });
}

export async function focusWindowIfAllowed(
  windowId: number | undefined,
  extra: chrome.windows.UpdateInfo = {},
): Promise<void> {
  if (typeof windowId !== 'number') return;
  const enabled = await isForceFocusEnabled();
  if (!enabled) return;
  await chrome.windows.update(windowId, { ...extra, focused: true });
}

export const FORCE_FOCUS_STORAGE_KEY = STORAGE_KEY;
