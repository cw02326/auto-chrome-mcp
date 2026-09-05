import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import {
  getToggle,
  setToggle,
  SENSITIVE_PERMISSIONS,
  type SensitivePermission,
} from '@/utils/consent-storage';
import { redactUrlForLog } from '@/utils/log-redact';

/**
 * v1.0.31+: Site permissions consent gate.
 *
 * design: docs/plans/2026-05-29-site-permissions-design.md
 *
 * AI 가 카메라/마이크/위치 정보 같은 민감 기능을 쓰기 전에 호출.
 *   - popup 의 토글 ON → 즉시 {approved: true, source: 'toggle'} 반환
 *   - 토글 OFF → consent.html popup 창 띄움 + 사용자 응답 대기 (60s timeout)
 *
 * 비민감 권한 (popup/notification/clipboard/automaticDownloads) 은 install 시점에
 * contentSettings 가 allow 로 세팅돼 native prompt 자체가 안 뜨므로 이 함수 호출 불요.
 */

const CONSENT_TIMEOUT_MS = 60_000;
const CONSENT_WINDOW_WIDTH = 420;
const CONSENT_WINDOW_HEIGHT = 280;

interface PendingConsent {
  resolve: (value: ConsentResult) => void;
  timer: ReturnType<typeof setTimeout>;
  windowId?: number;
}

type ConsentSource = 'toggle' | 'one-shot' | 'dismissed' | 'timeout';

interface ConsentResult {
  approved: boolean;
  source: ConsentSource;
  remembered?: boolean;
}

interface RequestUserConsentParams {
  action?: SensitivePermission;
  reason?: string;
}

const pendingConsents = new Map<string, PendingConsent>();

// v1.0.31+: SensitivePermission → chrome.contentSettings 키 매핑.
// `geolocation` 토글은 chrome.contentSettings 의 `location` API 와 연결됨.
const CS_KEY: Record<SensitivePermission, string> = {
  camera: 'camera',
  microphone: 'microphone',
  geolocation: 'location',
};

// v1.0.34+: OS 시스템 설정 deep link.
const OS_PERMISSION_URLS: Partial<Record<string, Record<SensitivePermission, string>>> = {
  mac: {
    camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
    microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    geolocation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices',
  },
  win: {
    camera: 'ms-settings:privacy-webcam',
    microphone: 'ms-settings:privacy-microphone',
    geolocation: 'ms-settings:privacy-location',
  },
};

const ACTION_LABEL_KR: Record<SensitivePermission, string> = {
  camera: '카메라',
  microphone: '마이크',
  geolocation: '위치 정보',
};

const ACTION_ICON: Record<SensitivePermission, string> = {
  camera: '📷',
  microphone: '🎤',
  geolocation: '📍',
};

// v1.0.34+: OS 차단 알림 → click 시 deep link 라우팅을 위해 notificationId 박제.
// notificationId 포맷: `os-perm-blocked:<action>`
const NOTIFICATION_ID_PREFIX = 'os-perm-blocked:';
let osBlockedClickRegistered = false;

function ensureOsBlockedClickListener(): void {
  if (osBlockedClickRegistered) return;
  osBlockedClickRegistered = true;
  chrome.notifications.onClicked.addListener(async (notificationId) => {
    if (!notificationId.startsWith(NOTIFICATION_ID_PREFIX)) return;
    const action = notificationId.slice(NOTIFICATION_ID_PREFIX.length) as SensitivePermission;
    try {
      const info = await chrome.runtime.getPlatformInfo();
      const url = OS_PERMISSION_URLS[info.os]?.[action];
      if (url) {
        await chrome.tabs.create({ url });
      } else {
        console.warn(`[user-consent] no OS deep link for ${info.os} / ${action}`);
      }
    } catch (e: any) {
      console.error('[user-consent] OS deep link 실패:', e?.message || e);
    }
    Promise.resolve(chrome.notifications.clear(notificationId)).catch(() => {});
  });
}

/**
 * v1.0.34+: applyOriginAllow 직후 호출. active tab 에서 navigator.permissions.query 실행해
 * OS layer 차단 ('denied') 감지 시 chrome.notifications 로 OS 시스템 설정 deep link 안내.
 *
 * - chrome 레벨은 allow 박혔는데 OS 가 차단하는 케이스만 잡음.
 * - 알림 클릭 시 OS 시스템 설정의 해당 권한 페이지로 자동 점프.
 * - 같은 권한에 대해 5분 내 중복 알림은 skip (사용자 짜증 방지).
 */
const lastNotifiedAt = new Map<SensitivePermission, number>();
const NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;

async function checkOsBlockAndNotify(action: SensitivePermission): Promise<void> {
  try {
    const last = lastNotifiedAt.get(action);
    if (last && Date.now() - last < NOTIFY_COOLDOWN_MS) return;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab?.url) return;
    try {
      const u = new URL(tab.url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    } catch {
      return;
    }

    // active tab 에서 navigator.permissions.query 호출 — page world 의 결과 회수.
    const queryName: string = action; // camera/microphone/geolocation — Web 표준 그대로
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async (name: string) => {
        try {
          const p = await (navigator.permissions as any).query({ name });
          return { state: p.state };
        } catch (e: any) {
          return { error: e?.message || String(e) };
        }
      },
      args: [queryName],
    });
    const state = results?.[0]?.result?.state;
    if (state !== 'denied') return; // granted / prompt / unknown → OS 차단 아님 (또는 확정 불가)

    // OS deep link 가 지원되는 OS 만 알림 (Linux/cros 는 deep link 없어서 알림 의미 작음 — 그래도 띄움)
    const info = await chrome.runtime.getPlatformInfo();
    const hasDeepLink = Boolean(OS_PERMISSION_URLS[info.os]?.[action]);
    const osLabel = info.os === 'mac' ? 'macOS' : info.os === 'win' ? 'Windows' : info.os;
    const label = ACTION_LABEL_KR[action];
    const icon = ACTION_ICON[action];

    await chrome.notifications.create(`${NOTIFICATION_ID_PREFIX}${action}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon/128.png'),
      title: `${icon} ${label} 권한이 ${osLabel} 에서 차단됨`,
      message: hasDeepLink
        ? `Chrome 확장은 허용했지만 OS 권한이 OFF 입니다. 클릭해서 시스템 설정 열기.`
        : `Chrome 확장은 허용했지만 OS 권한이 OFF 입니다. ${osLabel} 시스템 설정에서 직접 켜주세요.`,
      priority: 1,
      requireInteraction: false,
    });
    lastNotifiedAt.set(action, Date.now());
    ensureOsBlockedClickListener();
  } catch (e: any) {
    console.warn('[user-consent] OS 차단 검증 실패 (silent):', e?.message || e);
    // silent — approved 결과엔 영향 없음
  }
}

/**
 * v1.0.31+ design §5.1: approved 결과 시 현재 active tab 의 origin 단위로
 * chrome.contentSettings.X.set({primaryPattern: 'https://example.com/*', setting:'allow'})
 * 호출. Chrome 의 `regular` scope 에 영구 저장 (sticky) → 같은 사이트 재방문 시
 * native prompt 안 뜸.
 *
 * - `<all_urls>` 일괄 allow 는 camera/microphone 에 대해 Chrome 정책상 거부되지만
 *   specific origin pattern 은 통과됨 (검증 완료).
 * - http(s) origin 만 처리. chrome://, file://, about://, data: 등은 silent skip.
 * - set 실패해도 approved 결과는 그대로 반환 — 사이트 JS 가 호출 시 native prompt 만 뜨게 됨.
 */
async function applyOriginAllow(action: SensitivePermission): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) {
      console.warn('[user-consent] active tab url 없음 — origin set skip');
      return;
    }
    let origin: string;
    let protocol: string;
    try {
      const u = new URL(tab.url);
      origin = u.origin;
      protocol = u.protocol;
    } catch {
      console.warn('[user-consent] tab.url 파싱 실패 — origin set skip:', redactUrlForLog(tab.url));
      return;
    }
    if (protocol !== 'https:' && protocol !== 'http:') {
      console.log(`[user-consent] non-http(s) origin (${protocol}) — set skip`);
      return;
    }
    const csKey = CS_KEY[action];
    const setting = (
      chrome.contentSettings as unknown as Record<
        string,
        chrome.contentSettings.ContentSetting<string>
      >
    )[csKey];
    if (!setting?.set) {
      console.warn(`[user-consent] chrome.contentSettings.${csKey} 미지원 — skip`);
      return;
    }
    const pattern = `${origin}/*`;
    await setting.set({ primaryPattern: pattern, setting: 'allow' });
    console.log(`[user-consent] ✓ origin allow set: ${action} (${csKey}) → ${pattern}`);
  } catch (e: any) {
    console.error('[user-consent] applyOriginAllow failed:', e?.message || e);
    // silent — approved 결과는 그대로 반환
  }
}

// chrome.windows.onRemoved listener 는 한 번만 등록.
let onRemovedRegistered = false;
function ensureOnRemovedListener(): void {
  if (onRemovedRegistered) return;
  onRemovedRegistered = true;
  chrome.windows.onRemoved.addListener((closedWindowId) => {
    for (const [id, pending] of pendingConsents.entries()) {
      if (pending.windowId === closedWindowId) {
        clearTimeout(pending.timer);
        pendingConsents.delete(id);
        pending.resolve({ approved: false, source: 'dismissed' });
      }
    }
  });
}

// chrome.runtime.onMessage listener for CONSENT_RESPONSE — 한 번만 등록.
let onMessageRegistered = false;
function ensureOnMessageListener(): void {
  if (onMessageRegistered) return;
  onMessageRegistered = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== 'CONSENT_RESPONSE') return false;
    const { id, approved, remember } = message as {
      id: string;
      approved: boolean;
      remember?: boolean;
    };
    const pending = pendingConsents.get(id);
    if (!pending) {
      sendResponse({ ok: false, error: 'unknown consent id' });
      return false;
    }
    clearTimeout(pending.timer);
    pendingConsents.delete(id);
    pending.resolve({
      approved,
      source: 'one-shot',
      remembered: Boolean(approved && remember),
    });
    sendResponse({ ok: true });
    return false;
  });
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function getActiveTabOrigin(): Promise<string> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return '(unknown)';
    return new URL(tab.url).origin;
  } catch {
    return '(unknown)';
  }
}

class RequestUserConsentTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.REQUEST_USER_CONSENT;

  async execute(args: RequestUserConsentParams): Promise<ToolResult> {
    const { action, reason } = args || {};

    if (!action || !SENSITIVE_PERMISSIONS.includes(action)) {
      return createErrorResponse(`action must be one of: ${SENSITIVE_PERMISSIONS.join(', ')}`);
    }
    if (!reason || typeof reason !== 'string') {
      return createErrorResponse('reason (string) is required');
    }

    // 1. 토글 확인
    try {
      const allowed = await getToggle(action);
      if (allowed) {
        // §5.1: approved 시 현재 active tab origin 단위로 contentSettings.set('allow') — sticky
        await applyOriginAllow(action);
        // v1.0.34+: OS layer 차단 감지 → 알림 띄움 (non-blocking, fire-and-forget)
        checkOsBlockAndNotify(action).catch(() => {});
        const result: ConsentResult = { approved: true, source: 'toggle' };
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          isError: false,
        };
      }
    } catch (e: any) {
      console.error('[user-consent] toggle read failed:', e?.message || e);
      // toggle read 실패 시 안전하게 consent 창으로 fall through
    }

    // 2. consent 창 띄움 + 응답 대기
    ensureOnRemovedListener();
    ensureOnMessageListener();

    const id = generateId();
    const origin = await getActiveTabOrigin();

    const url = new URL(chrome.runtime.getURL('/consent.html'));
    url.searchParams.set('id', id);
    url.searchParams.set('action', action);
    url.searchParams.set('reason', reason);
    url.searchParams.set('origin', origin);

    const consentPromise = new Promise<ConsentResult>((resolve) => {
      const timer = setTimeout(() => {
        const pending = pendingConsents.get(id);
        if (pending) {
          pendingConsents.delete(id);
          if (pending.windowId !== undefined) {
            chrome.windows.remove(pending.windowId).catch(() => {});
          }
          resolve({ approved: false, source: 'timeout' });
        }
      }, CONSENT_TIMEOUT_MS);

      pendingConsents.set(id, { resolve, timer });
    });

    try {
      const win = await chrome.windows.create({
        type: 'popup',
        width: CONSENT_WINDOW_WIDTH,
        height: CONSENT_WINDOW_HEIGHT,
        url: url.toString(),
        focused: true,
      });
      const pending = pendingConsents.get(id);
      if (pending && win?.id !== undefined) {
        pending.windowId = win.id;
      }
    } catch (e: any) {
      const pending = pendingConsents.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingConsents.delete(id);
      }
      return createErrorResponse(
        `Failed to open consent window: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const result = await consentPromise;

    // 3. remember 체크 → 토글 ON 으로 영구 반영
    if (result.approved && result.remembered) {
      try {
        await setToggle(action, true);
      } catch (e: any) {
        console.error('[user-consent] failed to persist toggle ON:', e?.message || e);
        // 영구 반영 실패해도 이번 호출은 approved — silent
      }
    }

    // 4. §5.1 approved 시 현재 active tab origin 단위로 contentSettings.set('allow') — sticky
    if (result.approved) {
      await applyOriginAllow(action);
      // v1.0.34+: OS layer 차단 감지 → 알림 띄움 (non-blocking)
      checkOsBlockAndNotify(action).catch(() => {});
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: false,
    };
  }
}

export const requestUserConsentTool = new RequestUserConsentTool();
