/**
 * Viewport override (auto-chrome-mcp fork, v1.9.0).
 *
 * `chrome_navigate` 의 width/height 는 v1.8.0 까지 **새 창**을 만들었다. 새 창은 사용자
 * 바탕화면에 떠서 작업을 방해하는 가장 큰 원인이었고, 정작 요구는 "이 크기의 화면에서
 * 페이지를 보고 싶다" 였다. v1.9.0 부터는 창을 만들지 않고 CDP
 * `Emulation.setDeviceMetricsOverride` 로 **작업 탭의 뷰포트만** 그 크기로 맞춘다.
 * (`chrome_computer` 의 resize_page 가 이미 쓰는 것과 같은 방식이다.)
 *
 * ⚠️ CDP 에뮬레이션은 디버거 세션이 붙어 있는 동안만 유지된다. detach 하면 원래 크기로
 * 돌아가므로, 오버라이드를 건 탭에는 세션을 **붙여 둔 채** 둔다(탭이 닫히면 정리).
 * 대가로 그 탭에 "디버깅 중" 안내줄이 남지만, 작업 탭은 사용자 화면 밖이라 문제되지 않는다.
 */

import { cdpSessionManager } from './cdp-session-manager';

const OWNER = 'viewport-override';

/** 오버라이드를 건 탭 — 중복 attach 방지 + 탭이 닫히면 정리 */
const overriddenTabs = new Set<number>();

export async function applyViewportOverride(
  tabId: number,
  width?: number,
  height?: number,
): Promise<boolean> {
  const w = typeof width === 'number' && Number.isFinite(width) ? Math.round(width) : undefined;
  const h = typeof height === 'number' && Number.isFinite(height) ? Math.round(height) : undefined;
  if ((w === undefined || w <= 0) && (h === undefined || h <= 0)) return false;

  try {
    if (!overriddenTabs.has(tabId)) {
      await cdpSessionManager.attach(tabId, OWNER);
      overriddenTabs.add(tabId);
    }
    const metrics = {
      width: w ?? 0,
      height: h ?? 0,
      deviceScaleFactor: 0,
      mobile: false,
    };
    await cdpSessionManager.sendCommand(tabId, 'Emulation.setDeviceMetricsOverride', metrics);
    return true;
  } catch (error) {
    console.warn(
      `[viewport-override] tab ${tabId} 에 뷰포트 오버라이드를 걸지 못했다:`,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

/** 오버라이드 해제(있을 때만). 탭이 이미 닫혔으면 조용히 넘어간다. */
export async function clearViewportOverride(tabId: number): Promise<void> {
  if (!overriddenTabs.has(tabId)) return;
  overriddenTabs.delete(tabId);
  try {
    await cdpSessionManager.sendCommand(tabId, 'Emulation.clearDeviceMetricsOverride');
  } catch {
    // 탭이 닫혔거나 세션이 이미 끊겼다
  }
  try {
    await cdpSessionManager.detach(tabId, OWNER);
  } catch {
    // ignore
  }
}

/** 테스트용 — 어떤 탭에 오버라이드가 걸려 있는지. */
export function hasViewportOverride(tabId: number): boolean {
  return overriddenTabs.has(tabId);
}

try {
  chrome.tabs?.onRemoved?.addListener((tabId) => {
    overriddenTabs.delete(tabId);
  });
} catch {
  // chrome API 불가 환경(테스트 등)
}
