import { spawn, ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { detectChromeBinary, getEnvironmentInfo } from './detect-binary.js';
import { detectChromeUserDataDir } from './detect-profile.js';
import { ensurePortFree, isChromeCdpEndpoint } from './ensure-port-free.js';

export interface LaunchOptions {
  /** CDP debugging port (default 9222, auto-escalation 시 9223+). */
  port?: number;
  /** override user-data-dir (default = auto-detect). */
  userDataDir?: string;
  /** override Chrome binary path. */
  binaryPath?: string;
  /** Chrome 첫 URL (없으면 New Tab). */
  startUrl?: string;
  /** verbose 로깅. */
  verbose?: boolean;
}

export interface LaunchResult {
  /** Chrome 실행 파일 경로. */
  binary: string;
  /** 실제 user-data-dir. */
  userDataDir: string;
  /** 활성 CDP 포트. */
  cdpPort: number;
  /** Chrome 의 ChildProcess. */
  process: ChildProcess;
  /** 동일 인스턴스 재사용 (이미 9222 떠 있는 경우). */
  reused: boolean;
}

const CDP_PORT_FILE = path.join(homedir(), '.auto-chrome-mcp', 'cdp-port');

/**
 * Chrome 을 --remote-debugging-port + user-data-dir 옵션으로 띄움.
 *
 * 흐름:
 * 1. detect-binary → Chrome 실행 파일 발견 (예: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome)
 * 2. detect-profile → user-data-dir 자동 감지 (없으면 옵션으로 override 필요)
 * 3. 기존 9222 점유 검사:
 *    - 점유 X → 9222 사용
 *    - 점유 O 이지만 우리 (Chrome CDP) 인 경우 → reused: true (skip launch)
 *    - 점유 O 가 다른 프로세스 → 9223 → 9224 escalation
 * 4. spawn Chrome with flags
 * 5. ~/.auto-chrome-mcp/cdp-port 에 port 쓰기 (bridge 가 읽음)
 */
export const launchChrome = async (opts: LaunchOptions = {}): Promise<LaunchResult> => {
  const verbose = opts.verbose ?? false;
  const log = (msg: string) => verbose && console.error(`[launcher] ${msg}`);

  // 1. Binary
  const binary = opts.binaryPath ?? detectChromeBinary()?.path;
  if (!binary) {
    throw new Error(
      `Chrome binary not found. Tried OS-specific candidates for ${getEnvironmentInfo().platform}. ` +
        `Pass options.binaryPath explicitly.`,
    );
  }
  log(`binary: ${binary}`);

  // 2. user-data-dir
  const userDataDir = opts.userDataDir ?? detectChromeUserDataDir();
  if (!userDataDir) {
    throw new Error(
      `Chrome user-data-dir not found. Pass options.userDataDir explicitly. ` +
        `On macOS this is typically ~/Library/Application Support/Google/Chrome.`,
    );
  }
  log(`user-data-dir: ${userDataDir}`);

  // 3. Port
  const desiredPort = opts.port ?? 9222;
  // 우선 desiredPort 가 이미 우리(Chrome CDP) 라면 reuse:
  if (await isChromeCdpEndpoint(desiredPort)) {
    log(`port ${desiredPort} already serving Chrome CDP — reusing`);
    writePortFile(desiredPort);
    return {
      binary,
      userDataDir,
      cdpPort: desiredPort,
      // Dummy process (이미 떠 있음). detach 된 외부 process 라 PID 모름.
      process: new (class extends ChildProcess {})() as ChildProcess,
      reused: true,
    };
  }
  const cdpPort = await ensurePortFree(desiredPort, '127.0.0.1', 10);
  log(`cdp port: ${cdpPort} (auto-escalated from ${desiredPort})`);

  // 4. Spawn
  const args: string[] = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--restore-last-session',
  ];
  if (opts.startUrl) args.push(opts.startUrl);

  log(`spawning: ${binary} ${args.join(' ')}`);
  const child = spawn(binary, args, {
    detached: false,
    stdio: 'ignore',
  });

  // 5. Write port file (bridge 가 fallback transport 진입 시 읽음)
  writePortFile(cdpPort);

  // Wait until CDP endpoint is up (max 10s)
  const ready = await waitForCdpReady(cdpPort, 10000);
  if (!ready) {
    child.kill('SIGTERM');
    throw new Error(`Chrome CDP endpoint did not become ready within 10s on port ${cdpPort}`);
  }
  log(`CDP ready on port ${cdpPort}`);

  return { binary, userDataDir, cdpPort, process: child, reused: false };
};

const writePortFile = (port: number): void => {
  try {
    const dir = path.dirname(CDP_PORT_FILE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(CDP_PORT_FILE, String(port), 'utf8');
  } catch {
    // best-effort
  }
};

const waitForCdpReady = async (port: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isChromeCdpEndpoint(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

/**
 * Read CDP port from the shared file. Returns null if not present or invalid.
 */
export const readCdpPort = async (): Promise<number | null> => {
  try {
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(CDP_PORT_FILE, 'utf8').trim();
    const port = Number.parseInt(raw, 10);
    return Number.isFinite(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
};

export const cdpPortFilePath = (): string => CDP_PORT_FILE;
