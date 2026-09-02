import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

/**
 * auto-chrome-mcp fork(B3): chrome_emulate — 모바일·반응형 화면 확인.
 *
 * CDP Emulation 도메인으로 화면 크기 / 픽셀 밀도 / 터치 / User-Agent 를 바꾼다.
 * 창 크기를 실제로 바꾸지 않으므로 백그라운드 작업 탭에서도 그대로 쓸 수 있고,
 * 사용자가 보고 있는 화면을 건드리지 않는다.
 *
 * 주의: 에뮬레이션이 유지되려면 디버거가 붙어 있어야 한다. 그래서 'set' 은
 * CDP 세션을 잡은 채로 두고, 'reset' 에서만 놓는다 (탭이 닫히면 자동 정리).
 * 에뮬레이션 중인 탭에는 Chrome 의 "자동화 소프트웨어에 의해 제어되고 있습니다"
 * 안내줄이 보일 수 있다 — reset 하면 사라진다.
 */

interface DevicePreset {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  hasTouch: boolean;
  userAgent?: string;
}

const UA_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const UA_IPAD =
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const DEVICE_PRESETS: Record<string, DevicePreset> = {
  'iphone-se': {
    width: 375,
    height: 667,
    deviceScaleFactor: 2,
    mobile: true,
    hasTouch: true,
    userAgent: UA_IOS,
  },
  'iphone-15': {
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
    mobile: true,
    hasTouch: true,
    userAgent: UA_IOS,
  },
  'pixel-8': {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    hasTouch: true,
    userAgent: UA_ANDROID,
  },
  'galaxy-s23': {
    width: 360,
    height: 780,
    deviceScaleFactor: 3,
    mobile: true,
    hasTouch: true,
    userAgent: UA_ANDROID,
  },
  ipad: {
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    mobile: true,
    hasTouch: true,
    userAgent: UA_IPAD,
  },
  'desktop-1080p': {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
    hasTouch: false,
  },
  'desktop-1280': {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
    hasTouch: false,
  },
};

type EmulateAction = 'set' | 'reset' | 'status';

interface EmulateParams {
  action?: EmulateAction;
  device?: string;
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
  hasTouch?: boolean;
  userAgent?: string;
  tabId?: number;
  windowId?: number;
}

interface ActiveEmulation extends DevicePreset {
  device: string | null;
  since: number;
}

const CDP_OWNER = 'emulate';
const MAX_DIMENSION = 4000;
const MIN_DIMENSION = 100;

/** 탭별 활성 에뮬레이션 — CDP 세션을 이중으로 잡지 않기 위해 필요 */
const activeEmulation = new Map<number, ActiveEmulation>();

// 탭이 닫히면 상태만 정리한다 (디버거는 Chrome 이 자동으로 떼어낸다)
try {
  chrome.tabs?.onRemoved?.addListener((tabId) => {
    activeEmulation.delete(tabId);
  });
} catch {
  // chrome API 불가 환경 — 무시
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

class EmulateTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.EMULATE;

  async execute(args: EmulateParams): Promise<ToolResult> {
    const params = args || ({} as EmulateParams);
    const action: EmulateAction =
      params.action === 'reset' || params.action === 'status' ? params.action : 'set';

    let tab: chrome.tabs.Tab;
    try {
      tab =
        (await this.tryGetTab(params.tabId)) ||
        (await this.getActiveTabOrThrowInWindow(params.windowId));
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error));
    }
    const tabId = tab.id;
    if (typeof tabId !== 'number') return createErrorResponse('Target tab has no id');

    try {
      if (action === 'status') {
        const current = activeEmulation.get(tabId) ?? null;
        return this.ok({
          action,
          tabId,
          url: tab.url,
          emulating: current !== null,
          current,
          availableDevices: Object.keys(DEVICE_PRESETS),
        });
      }

      if (action === 'reset') {
        const current = activeEmulation.get(tabId);
        if (!current) {
          return this.ok({
            action,
            tabId,
            emulating: false,
            message: 'No emulation was active for this tab',
          });
        }
        try {
          await cdpSessionManager.sendCommand(tabId, 'Emulation.clearDeviceMetricsOverride');
          await cdpSessionManager.sendCommand(tabId, 'Emulation.setTouchEmulationEnabled', {
            enabled: false,
          });
          if (current.userAgent) {
            // UA override 해제는 빈 문자열이 아니라 실제 UA 로 되돌려야 안전하다
            await cdpSessionManager.sendCommand(tabId, 'Emulation.setUserAgentOverride', {
              userAgent: navigator.userAgent,
            });
          }
        } finally {
          activeEmulation.delete(tabId);
          // set 에서 잡아 둔 세션을 놓는다
          await cdpSessionManager.detach(tabId, CDP_OWNER);
        }
        return this.ok({ action, tabId, emulating: false, message: 'Emulation cleared' });
      }

      // --- set ---
      const presetName =
        typeof params.device === 'string' ? params.device.trim().toLowerCase() : null;
      let base: DevicePreset | null = null;
      if (presetName) {
        base = DEVICE_PRESETS[presetName] ?? null;
        if (!base) {
          return createErrorResponse(
            `Unknown device "${params.device}". Available: ${Object.keys(DEVICE_PRESETS).join(', ')} — or pass width/height directly.`,
          );
        }
      }

      const width = typeof params.width === 'number' ? params.width : base?.width;
      const height = typeof params.height === 'number' ? params.height : base?.height;
      if (typeof width !== 'number' || typeof height !== 'number') {
        return createErrorResponse(
          `Provide a device preset or explicit width/height. Available devices: ${Object.keys(DEVICE_PRESETS).join(', ')}`,
        );
      }

      const metrics: DevicePreset = {
        width: Math.round(clamp(width, MIN_DIMENSION, MAX_DIMENSION)),
        height: Math.round(clamp(height, MIN_DIMENSION, MAX_DIMENSION)),
        deviceScaleFactor:
          typeof params.deviceScaleFactor === 'number'
            ? clamp(params.deviceScaleFactor, 0, 5)
            : (base?.deviceScaleFactor ?? 1),
        mobile: typeof params.mobile === 'boolean' ? params.mobile : (base?.mobile ?? false),
        hasTouch:
          typeof params.hasTouch === 'boolean' ? params.hasTouch : (base?.hasTouch ?? false),
        userAgent:
          typeof params.userAgent === 'string' && params.userAgent.trim()
            ? params.userAgent.trim()
            : base?.userAgent,
      };

      // 이미 이 탭을 에뮬레이션 중이면 세션을 다시 잡지 않고 값만 갱신한다
      const alreadyActive = activeEmulation.has(tabId);
      if (!alreadyActive) {
        await cdpSessionManager.attach(tabId, CDP_OWNER);
      }

      try {
        await cdpSessionManager.sendCommand(tabId, 'Emulation.setDeviceMetricsOverride', {
          width: metrics.width,
          height: metrics.height,
          deviceScaleFactor: metrics.deviceScaleFactor,
          mobile: metrics.mobile,
        });
        await cdpSessionManager.sendCommand(tabId, 'Emulation.setTouchEmulationEnabled', {
          enabled: metrics.hasTouch,
        });
        if (metrics.userAgent) {
          await cdpSessionManager.sendCommand(tabId, 'Emulation.setUserAgentOverride', {
            userAgent: metrics.userAgent,
          });
        }
      } catch (error) {
        // 적용 실패 시 새로 잡은 세션을 되돌린다 (refCount 누수 방지)
        if (!alreadyActive) {
          await cdpSessionManager.detach(tabId, CDP_OWNER).catch(() => {});
        }
        throw error;
      }

      const state: ActiveEmulation = {
        ...metrics,
        device: presetName,
        since: Date.now(),
      };
      activeEmulation.set(tabId, state);

      return this.ok({
        action: 'set',
        tabId,
        url: tab.url,
        emulating: true,
        applied: state,
        note: 'Emulation stays active until chrome_emulate action="reset" (or the tab closes). Screenshots and read_page now reflect this viewport. Chrome may show an automation notice bar on this tab while emulation is active.',
      });
    } catch (error) {
      return createErrorResponse(
        `chrome_emulate failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private ok(payload: Record<string, unknown>): ToolResult {
    return {
      content: [{ type: 'text', text: JSON.stringify({ success: true, ...payload }) }],
      isError: false,
    };
  }
}

export const emulateTool = new EmulateTool();
