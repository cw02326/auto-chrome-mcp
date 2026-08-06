/**
 * CDP client wrapper — chromium.connectOverCDP 의 fork 측 manager.
 *
 * 사용자가 chrome-launcher 로 띄운 Chrome (--remote-debugging-port=9222) 에 attach.
 * Port 는 ~/.mcp-chrome-scalemaker/cdp-port 에서 읽음. attach 실패 시 명확한 에러.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const CDP_PORT_FILE = path.join(homedir(), '.mcp-chrome-scalemaker', 'cdp-port');

export interface CdpAttachState {
  browser: Browser;
  context: BrowserContext;
  /** convenience getter: first page of first context (사용자가 처음 띄운 탭). */
  firstPage: () => Page | undefined;
}

let cached: CdpAttachState | null = null;

/**
 * CDP port file 읽기. 없거나 비어있으면 null.
 */
export const readCdpPortFromFile = (): number | null => {
  if (!existsSync(CDP_PORT_FILE)) return null;
  try {
    const raw = readFileSync(CDP_PORT_FILE, 'utf8').trim();
    const port = Number.parseInt(raw, 10);
    return Number.isFinite(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
};

/**
 * Idempotent attach — 캐시된 browser 가 살아있으면 재사용.
 *
 * @param overridePort  명시적 CDP port. 없으면 파일에서 자동 감지.
 * @throws  파일 없거나 connectOverCDP 실패 시.
 */
export const attachCdp = async (overridePort?: number): Promise<CdpAttachState> => {
  // Cache hit?
  if (cached && cached.browser.isConnected()) {
    return cached;
  }
  if (cached) {
    // 이전 cache 가 disconnect — 정리하고 새로 attach
    try {
      await cached.browser.close().catch(() => {});
    } catch {
      // ignore
    }
    cached = null;
  }

  const port = overridePort ?? readCdpPortFromFile();
  if (!port) {
    throw new Error(
      `No CDP port available. Run \`scalemaker-chrome\` first (writes port to ${CDP_PORT_FILE}).`,
    );
  }

  const endpoint = `http://127.0.0.1:${port}`;
  const browser = await chromium.connectOverCDP(endpoint);

  // contexts[0] = launcher 가 띄운 그 Chrome window 의 default context (사용자 profile).
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    throw new Error(
      `CDP attach ok but no contexts found at ${endpoint}. ` +
        `Chrome may have been launched without a default profile.`,
    );
  }
  const context = contexts[0];

  cached = {
    browser,
    context,
    firstPage: () => context.pages()[0],
  };

  // disconnect 감지: 브라우저 닫히면 cache 정리.
  browser.once('disconnected', () => {
    cached = null;
  });

  return cached;
};

/**
 * 강제 정리 (release).
 */
export const detachCdp = async (): Promise<void> => {
  if (cached) {
    try {
      await cached.browser.close().catch(() => {});
    } catch {
      // ignore
    }
    cached = null;
  }
};

/**
 * 현재 attach 상태 (UI / diagnostic 용).
 */
export const isCdpAttached = (): boolean => cached !== null && cached.browser.isConnected();
