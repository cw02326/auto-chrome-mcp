/**
 * Site permissions consent storage helpers (v1.0.31+).
 *
 * design: docs/plans/2026-05-29-site-permissions-design.md
 *
 * 핵심:
 * - `sitePermissionToggles` storage key 에 3종 boolean 박제 (camera/mic/geo)
 * - 토글 ON = AI 가 묻지 않고 즉시 사용 (auto-chrome-mcp default — 자동화 흐름 안 끊김)
 * - 토글 OFF = AI 가 consent 창으로 사용자 confirm 받음
 * - install 이벤트 시 default true 로 초기화 (update 시엔 사용자 OFF 보존)
 */

export type SensitivePermission = 'camera' | 'microphone' | 'geolocation';

export const SENSITIVE_PERMISSIONS: readonly SensitivePermission[] = [
  'camera',
  'microphone',
  'geolocation',
] as const;

export const STORAGE_KEY = 'sitePermissionToggles';

export type SitePermissionToggles = Record<SensitivePermission, boolean>;

/**
 * Default 정책 (v1.0.31+ 옵션 A):
 * - 3종 모두 **true** — auto-chrome-mcp 는 AI 자동화가 주 목적이라 default 위임.
 * - camera / microphone 은 `chrome.contentSettings.X` 의 `<all_urls>` allow 가 Chrome
 *   정책상 거부되지만, `user-consent.ts` 의 `applyOriginAllow()` 가 consent 통과 시
 *   현재 active tab 의 origin 단위로 `set({primaryPattern:'https://X.com/*', setting:'allow'})`
 *   를 호출해 동적으로 처리 — 한 사이트당 평생 1회 set 만 일어남 (sticky 영구 저장).
 * - 사용자가 의식적으로 OFF 로 내리면 그 이후로는 AI 호출마다 consent 창이 뜸.
 * - update / chrome_update 이벤트 시엔 이미 storage 에 값 있으면 보존 (사용자 OFF 가 유지됨).
 */
export const DEFAULT_TOGGLES: SitePermissionToggles = {
  camera: true,
  microphone: true,
  geolocation: true,
};

/**
 * Read all toggles. Missing keys → DEFAULT_TOGGLES 값.
 */
export async function getToggles(): Promise<SitePermissionToggles> {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEY]);
    const stored = (result[STORAGE_KEY] || {}) as Partial<SitePermissionToggles>;
    return {
      camera: stored.camera ?? DEFAULT_TOGGLES.camera,
      microphone: stored.microphone ?? DEFAULT_TOGGLES.microphone,
      geolocation: stored.geolocation ?? DEFAULT_TOGGLES.geolocation,
    };
  } catch {
    return { ...DEFAULT_TOGGLES };
  }
}

export async function getToggle(action: SensitivePermission): Promise<boolean> {
  const toggles = await getToggles();
  return toggles[action];
}

export async function setToggle(action: SensitivePermission, value: boolean): Promise<void> {
  const current = await getToggles();
  current[action] = value;
  await chrome.storage.local.set({ [STORAGE_KEY]: current });
}

export async function setToggles(toggles: SitePermissionToggles): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: toggles });
}

/**
 * install 이벤트 한정 초기화. 이미 키 존재하면 skip (사용자가 OFF 로 내린 값 보존).
 */
export async function initializeTogglesIfMissing(): Promise<void> {
  const result = await chrome.storage.local.get([STORAGE_KEY]);
  if (result[STORAGE_KEY]) return; // 이미 존재 — 보존
  await setToggles({ ...DEFAULT_TOGGLES });
}
