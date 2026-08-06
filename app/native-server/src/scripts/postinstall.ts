#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { COMMAND_NAME, EXTENSION_ID } from './constant';
import { colorText, tryRegisterUserLevelHost, writeNodePathFile } from './utils';

// scalemaker fork: extension zip 자동 다운로드
// - 앱 런타임 상태 (cdp-port 등) 는 ~/.mcp-chrome-scalemaker/ 에 유지
// - 사용자가 Finder 에서 직접 찾아야 하는 extension 폴더는 ~/Downloads/ 에 둠
// - v1.0.20: 폴더명에 버전 박제 — 업데이트 시 구버전과 한눈에 구분 + 사용자가
//   chrome://extensions 의 "Load unpacked" 경로를 갱신해야 한다는 시그널.
const SCALEMAKER_INSTALL_ROOT = path.join(os.homedir(), '.mcp-chrome-scalemaker');
function readScalemakerVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version as string;
  } catch {
    return 'unknown';
  }
}
const SCALEMAKER_VERSION = readScalemakerVersion();
const SCALEMAKER_EXT_DIR = path.join(
  os.homedir(),
  'Downloads',
  `mcp-chrome-scalemaker-extension-v${SCALEMAKER_VERSION}`,
);
const SCALEMAKER_EXT_URL =
  'https://github.com/scalemaker-ship-it/mcp-chrome-scalemaker/releases/latest/download/chrome-mcp-scalemaker-extension.zip';

function runCmd(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr?.on('data', (d) => (stderr += d.toString()));
    proc.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 200)}`)),
    );
    proc.on('error', reject);
  });
}

/**
 * v1.0.36+: agent chat 기능 제거. better-sqlite3 + drizzle 의존성도 함께 제거.
 * 잔존 agent DB 파일을 silent 삭제. 데이터는 chat 세션 기록뿐이라 무손실 마이그레이션.
 */
function removeLegacyAgentDb(): void {
  const legacyDbPaths = [
    path.join(SCALEMAKER_INSTALL_ROOT, 'agent.db'),
    path.join(SCALEMAKER_INSTALL_ROOT, 'agent.sqlite'),
    path.join(SCALEMAKER_INSTALL_ROOT, 'agent.db-journal'),
    path.join(SCALEMAKER_INSTALL_ROOT, 'agent.db-wal'),
    path.join(SCALEMAKER_INSTALL_ROOT, 'agent.db-shm'),
  ];
  for (const p of legacyDbPaths) {
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        console.log(colorText(`[cleanup] removed legacy agent DB: ${path.basename(p)}`, 'blue'));
      }
    } catch {
      // 실패는 silent — install 자체엔 영향 없음
    }
  }
}

async function downloadAndExtractExtension(): Promise<string | null> {
  if (process.env.SCALEMAKER_SKIP_EXTENSION_DOWNLOAD === '1') {
    console.log(
      colorText('Skipping extension download (SCALEMAKER_SKIP_EXTENSION_DOWNLOAD=1)', 'yellow'),
    );
    return null;
  }

  fs.mkdirSync(SCALEMAKER_INSTALL_ROOT, { recursive: true });
  fs.mkdirSync(path.dirname(SCALEMAKER_EXT_DIR), { recursive: true });
  const zipPath = path.join(SCALEMAKER_INSTALL_ROOT, 'extension.zip');

  console.log(colorText(`Downloading extension from GitHub Release…`, 'blue'));
  try {
    if (os.platform() === 'win32') {
      // v1.0.36: PowerShell 강화 — Windows 10+ 의 silent fail (빈 폴더) 차단.
      //   1) -NoProfile        : 사용자 PS profile 부수효과 차단
      //   2) -ExecutionPolicy Bypass : restricted 정책 회피
      //   3) TLS 1.2 강제      : PS 5.1 default(TLS1.0) 와 GitHub→S3 redirect 충돌 회피
      //   4) $ProgressPreference=SilentlyContinue : progress bar 의 IE DOM 의존성
      //      이 stream 점유해 0 byte 반환되던 흔한 silent fail 회피
      //   5) -UseBasicParsing  : IE DOM 의존성 명시적 제거
      const psCommand = [
        `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12`,
        `$ProgressPreference = 'SilentlyContinue'`,
        `Invoke-WebRequest -UseBasicParsing -Uri "${SCALEMAKER_EXT_URL}" -OutFile "${zipPath}"`,
      ].join('; ');
      await runCmd('powershell', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        psCommand,
      ]);
    } else {
      await runCmd('curl', ['-fsSL', SCALEMAKER_EXT_URL, '-o', zipPath]);
    }

    // v1.0.36: download size 검증. 정상 extension zip 은 5-15MB.
    // 1KB 미만이면 TLS/proxy/redirect 실패로 0 byte 또는 HTML error page 받은 것.
    const downloadedSize = fs.existsSync(zipPath) ? fs.statSync(zipPath).size : 0;
    if (downloadedSize < 1024) {
      try {
        fs.unlinkSync(zipPath);
      } catch {
        /* ignore */
      }
      throw new Error(
        `Downloaded zip is suspiciously small (${downloadedSize} bytes) — likely TLS/proxy/redirect failure`,
      );
    }
  } catch (e) {
    printDownloadFailureGuide((e as Error).message);
    return null;
  }

  // 압축 해제
  try {
    fs.rmSync(SCALEMAKER_EXT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SCALEMAKER_EXT_DIR, { recursive: true });
    if (os.platform() === 'win32') {
      // Windows 10+ 의 내장 tar 사용 (zip 도 처리 가능)
      await runCmd('tar', ['-xf', zipPath, '-C', SCALEMAKER_EXT_DIR]);
    } else {
      await runCmd('unzip', ['-q', '-o', zipPath, '-d', SCALEMAKER_EXT_DIR]);
    }
    fs.unlinkSync(zipPath);

    // v1.0.36: 압축 해제 검증 — manifest.json 존재 = chrome extension 의 필수 파일.
    // 빈 폴더 / 손상된 zip / 잘못된 zip 차단.
    const manifestPath = path.join(SCALEMAKER_EXT_DIR, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      const fileCount = fs.readdirSync(SCALEMAKER_EXT_DIR).length;
      try {
        fs.rmSync(SCALEMAKER_EXT_DIR, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      throw new Error(
        `Extraction produced no manifest.json (${fileCount} files extracted) — corrupt zip`,
      );
    }

    // v1.0.6: Finder 에서 폴더 들어왔을 때 한눈에 버전 보이게 VERSION 파일 작성.
    try {
      const versionLine = `mcp-chrome-scalemaker v${SCALEMAKER_VERSION}\n`;
      const buildLine = `Installed: ${new Date().toISOString()}\n`;
      const releaseLine = `Release: https://github.com/scalemaker-ship-it/mcp-chrome-scalemaker/releases/tag/scalemaker-v${SCALEMAKER_VERSION}\n`;
      const extIdLine = `Extension ID: ${EXTENSION_ID}\n`;
      fs.writeFileSync(
        path.join(SCALEMAKER_EXT_DIR, 'VERSION'),
        versionLine + buildLine + releaseLine + extIdLine,
      );
    } catch {
      // VERSION 파일 fail 해도 install 자체는 OK — silent
    }

    console.log(colorText(`✓ Extension extracted to ${SCALEMAKER_EXT_DIR}`, 'green'));
    return SCALEMAKER_EXT_DIR;
  } catch (e) {
    printDownloadFailureGuide(`extract failed: ${(e as Error).message}`);
    return null;
  }
}

/**
 * v1.0.36: 다운로드/추출 실패 시 사용자에게 보이는 manual fallback 가이드.
 * 단순한 "Manual: <url>" 한 줄 대신 1) 다운로드 URL 2) 압축 풀 폴더 3) chrome://extensions
 * 단계까지 명시 — Windows 빈 폴더 같은 silent fail 후에도 자동 복구 가능하게.
 */
function printDownloadFailureGuide(errorMessage: string): void {
  console.log(colorText(`\n❌ Extension auto-download/extract failed: ${errorMessage}`, 'red'));
  console.log(colorText(`\n수동 설치 절차:`, 'yellow'));
  console.log(`  [1] 브라우저에서 latest release 의 extension zip 다운로드:`);
  console.log(colorText(`      ${SCALEMAKER_EXT_URL}`, 'blue'));
  console.log(`  [2] 다운받은 zip 을 다음 폴더에 압축 해제:`);
  console.log(colorText(`      ${SCALEMAKER_EXT_DIR}`, 'green'));
  console.log(`  [3] chrome://extensions 열기 → Developer mode ON → "Load unpacked"`);
  console.log(`      → [2] 의 폴더 선택`);
}

function printScalemakerNextSteps(extDir: string | null): void {
  console.log('\n' + colorText('===== mcp-chrome-scalemaker — 설치 완료 =====', 'green'));
  if (extDir) {
    console.log('\n' + colorText('[1] Chrome 확장 로드:', 'blue'));
    console.log(`    chrome://extensions → Developer mode ON → "Load unpacked"`);
    console.log(colorText(`    폴더: ${extDir}`, 'green'));
    console.log(`    → 자동 ID = ${EXTENSION_ID} (manifest.key 박제 효과)`);
  } else {
    console.log('\n' + colorText('[1] Extension 자동 다운로드 실패 — 수동 다운로드:', 'yellow'));
    console.log(`    https://github.com/scalemaker-ship-it/mcp-chrome-scalemaker/releases/latest`);
  }

  console.log(
    '\n' + colorText('[2] Claude Code 에 줄 prompt (터미널의 `claude` 에 붙여넣기):', 'blue'),
  );
  console.log(`    ┌────────────────────────────────────────────────────────────────────┐`);
  console.log(`    지금 working dir (이 프로젝트 폴더) 의 .mcp.json 에 우리 chrome MCP`);
  console.log(`    (mcp-chrome-scalemaker) 를 등록해줘. ~/.claude.json 같은 전역 설정엔`);
  console.log(`    손대지 마. 이름 "chrome-mcp-stdio", command "node", args ["<npm root -g>`);
  console.log(`    /mcp-chrome-scalemaker-bridge/dist/mcp/mcp-server-stdio.js"], env`);
  console.log(`    { "CHROME_PORT": "12320" }. 먼저 \`npm root -g\` 실행해서 경로 얻고,`);
  console.log(`    working dir 의 .mcp.json mcpServers.chrome-mcp-stdio 만 추가/갱신.`);
  console.log(`    기존 다른 server 항목 보존. 끝나면 /mcp 로 활성 확인 안내.`);
  console.log(`    └────────────────────────────────────────────────────────────────────┘`);
  console.log('\n' + colorText('[3] /mcp 명령으로 chrome-mcp-stdio 활성 확인', 'blue'));
}

// Check if this script is run directly
const isDirectRun = require.main === module;

// Detect global installation for both npm and pnpm
function detectGlobalInstall(): boolean {
  // npm uses npm_config_global
  if (process.env.npm_config_global === 'true') {
    return true;
  }

  // pnpm detection methods
  // Method 1: Check if PNPM_HOME is set and current path contains it
  if (process.env.PNPM_HOME && __dirname.includes(process.env.PNPM_HOME)) {
    return true;
  }

  // Method 2: Check if we're in a global pnpm directory structure
  // pnpm global packages are typically installed in ~/.local/share/pnpm/global/5/node_modules
  // Windows: %APPDATA%\pnpm\global\5\node_modules
  const globalPnpmPatterns =
    process.platform === 'win32'
      ? ['\\pnpm\\global\\', '\\pnpm-global\\', '\\AppData\\Roaming\\pnpm\\']
      : ['/pnpm/global/', '/.local/share/pnpm/', '/pnpm-global/'];

  if (globalPnpmPatterns.some((pattern) => __dirname.includes(pattern))) {
    return true;
  }

  // Method 3: Check npm_config_prefix for pnpm
  if (process.env.npm_config_prefix && __dirname.includes(process.env.npm_config_prefix)) {
    return true;
  }

  // Method 4: Windows-specific global installation paths
  if (process.platform === 'win32') {
    const windowsGlobalPatterns = [
      '\\npm\\node_modules\\',
      '\\AppData\\Roaming\\npm\\node_modules\\',
      '\\Program Files\\nodejs\\node_modules\\',
      '\\nodejs\\node_modules\\',
    ];

    if (windowsGlobalPatterns.some((pattern) => __dirname.includes(pattern))) {
      return true;
    }
  }

  return false;
}

const isGlobalInstall = detectGlobalInstall();

/**
 * Detect if running with elevated privileges (sudo/admin)
 * This can cause issues because user-level registration will go to root's home directory
 */
function isRunningElevated(): boolean {
  if (process.platform === 'win32') {
    // On Windows, check common admin indicators
    // Note: Full admin check requires is-admin package which is ESM
    return false; // Skip for now, Windows npm usually doesn't run as admin by default
  } else {
    // On Unix, check if running as root (UID 0)
    return process.getuid?.() === 0;
  }
}

/**
 * Ensure executable permissions (regardless of global install).
 */
async function ensureExecutionPermissions(): Promise<void> {
  if (process.platform === 'win32') {
    // Windows path
    await ensureWindowsFilePermissions();
    return;
  }

  // Unix/Linux path
  const filesToCheck = [
    path.join(__dirname, '..', 'index.js'),
    path.join(__dirname, '..', 'run_host.sh'),
    path.join(__dirname, '..', 'cli.js'),
  ];

  for (const filePath of filesToCheck) {
    if (fs.existsSync(filePath)) {
      try {
        fs.chmodSync(filePath, '755');
        console.log(
          colorText(`✓ Set execution permissions for ${path.basename(filePath)}`, 'green'),
        );
      } catch (err: any) {
        console.warn(
          colorText(
            `⚠️ Unable to set execution permissions for ${path.basename(filePath)}: ${err.message}`,
            'yellow',
          ),
        );
      }
    } else {
      console.warn(colorText(`⚠️ File not found: ${filePath}`, 'yellow'));
    }
  }
}

/**
 * Windows file permission handling.
 */
async function ensureWindowsFilePermissions(): Promise<void> {
  const filesToCheck = [
    path.join(__dirname, '..', 'index.js'),
    path.join(__dirname, '..', 'run_host.bat'),
    path.join(__dirname, '..', 'cli.js'),
  ];

  for (const filePath of filesToCheck) {
    if (fs.existsSync(filePath)) {
      try {
        // Check read-only flag; remove it if set
        const stats = fs.statSync(filePath);
        if (!(stats.mode & parseInt('200', 8))) {
          // No write permission → strip read-only
          fs.chmodSync(filePath, stats.mode | parseInt('200', 8));
          console.log(
            colorText(`✓ Removed read-only attribute from ${path.basename(filePath)}`, 'green'),
          );
        }

        // Verify file is readable
        fs.accessSync(filePath, fs.constants.R_OK);
        console.log(
          colorText(`✓ Verified file accessibility for ${path.basename(filePath)}`, 'green'),
        );
      } catch (err: any) {
        console.warn(
          colorText(
            `⚠️ Unable to verify file permissions for ${path.basename(filePath)}: ${err.message}`,
            'yellow',
          ),
        );
      }
    } else {
      console.warn(colorText(`⚠️ File not found: ${filePath}`, 'yellow'));
    }
  }
}

async function tryRegisterNativeHost(): Promise<void> {
  try {
    console.log(colorText('Attempting to register Chrome Native Messaging host...', 'blue'));

    // Always ensure execution permissions, regardless of installation type
    await ensureExecutionPermissions();

    // Check if running with elevated privileges
    if (isRunningElevated()) {
      console.log(
        colorText('\n⚠️  WARNING: Running with elevated privileges (sudo/root)', 'yellow'),
      );
      console.log(
        colorText("   User-level registration will be written to root's home directory,", 'yellow'),
      );
      console.log(
        colorText('   which may not work correctly for your normal user account.', 'yellow'),
      );
      console.log(
        colorText(
          '\n   Please run the following command as your normal user after installation:',
          'blue',
        ),
      );
      console.log(`   ${COMMAND_NAME} register`);
      console.log(colorText('\n   Or if you need system-level installation, use:', 'blue'));
      console.log(`   sudo ${COMMAND_NAME} register --system`);
      // Skip automatic registration when running as root
      return;
    }

    if (isGlobalInstall) {
      // First try user-level installation (no elevated permissions required)
      const userLevelSuccess = await tryRegisterUserLevelHost();

      if (!userLevelSuccess) {
        // User-level installation failed, suggest using register command
        console.log(
          colorText(
            'User-level installation failed, system-level installation may be needed',
            'yellow',
          ),
        );
        console.log(
          colorText('Please run the following command for system-level installation:', 'blue'),
        );
        console.log(`  ${COMMAND_NAME} register --system`);
        printManualInstructions();
      }
    } else {
      // Local installation mode, don't attempt automatic registration
      console.log(
        colorText('Local installation detected, skipping automatic registration', 'yellow'),
      );
      printManualInstructions();
    }
  } catch (error) {
    console.log(
      colorText(
        `등록 중 오류 발생: ${error instanceof Error ? error.message : String(error)}`,
        'red',
      ),
    );
    printManualInstructions();
  }
}

/**
 * Print manual installation guide.
 */
function printManualInstructions(): void {
  console.log('\n' + colorText('===== Manual Registration Guide =====', 'blue'));

  console.log(colorText('1. Try user-level installation (recommended):', 'yellow'));
  if (isGlobalInstall) {
    console.log(`  ${COMMAND_NAME} register`);
  } else {
    console.log(`  npx ${COMMAND_NAME} register`);
  }

  console.log(
    colorText('\n2. If user-level installation fails, try system-level installation:', 'yellow'),
  );

  console.log(colorText('   Use --system parameter (requires admin privileges):', 'yellow'));
  if (isGlobalInstall) {
    console.log(`  ${COMMAND_NAME} register --system`);
  } else {
    console.log(`  npx ${COMMAND_NAME} register --system`);
  }

  console.log(colorText('\n   Or use administrator privileges directly:', 'yellow'));
  if (os.platform() === 'win32') {
    console.log(
      colorText(
        '   Please run Command Prompt or PowerShell as administrator and execute:',
        'yellow',
      ),
    );
    if (isGlobalInstall) {
      console.log(`  ${COMMAND_NAME} register`);
    } else {
      console.log(`  npx ${COMMAND_NAME} register`);
    }
  } else {
    console.log(colorText('   Please run the following command in terminal:', 'yellow'));
    if (isGlobalInstall) {
      console.log(`  sudo ${COMMAND_NAME} register`);
    } else {
      console.log(`  sudo npx ${COMMAND_NAME} register`);
    }
  }

  console.log(
    '\n' +
      colorText(
        'Ensure Chrome extension is installed and refresh the extension to connect to local service.',
        'blue',
      ),
  );
}

/**
 * Main entry — postinstall orchestrator.
 */
/**
 * scalemaker fork v1.0.30+: Claude Code troubleshooting 스킬 자동 설치.
 *
 * 정책:
 * - ~/.claude/ 가 없으면 (= Claude Code 미설치 사용자) skip
 * - SCALEMAKER_NO_SKILL=1 env 면 opt-out
 * - 이미 같은 name (chrome-mcp-scalemaker-doctor) 의 SKILL.md 있으면 scalemaker-version
 *   비교 — 같으면 skip, 다르면 조용히 overwrite
 * - 다른 name (사용자 custom 스킬) 이 같은 경로면 절대 덮지 않음
 */
function installClaudeCodeSkill(): void {
  if (process.env.SCALEMAKER_NO_SKILL === '1') {
    console.log(colorText('[skill] SCALEMAKER_NO_SKILL=1 — skipping skill install', 'yellow'));
    return;
  }

  const claudeRoot = path.join(os.homedir(), '.claude');
  if (!fs.existsSync(claudeRoot)) {
    // Claude Code 미설치. 조용히 skip.
    return;
  }

  const skillSource = path.join(__dirname, '..', 'skill', 'SKILL.md');
  if (!fs.existsSync(skillSource)) {
    console.warn(colorText(`[skill] source 없음, skip: ${skillSource}`, 'yellow'));
    return;
  }

  const skillDir = path.join(claudeRoot, 'skills', 'chrome-mcp-scalemaker-doctor');
  const skillDest = path.join(skillDir, 'SKILL.md');

  // 기존 파일 있으면 안전성 점검
  if (fs.existsSync(skillDest)) {
    try {
      const existing = fs.readFileSync(skillDest, 'utf8');
      const nameMatch = existing.match(/^name:\s*(\S+)/m);
      if (nameMatch && nameMatch[1] !== 'chrome-mcp-scalemaker-doctor') {
        console.log(
          colorText(
            `[skill] 기존 SKILL 의 name='${nameMatch[1]}' (custom) — 절대 덮지 않음: ${skillDest}`,
            'yellow',
          ),
        );
        return;
      }
      const existingVersion = existing.match(/^# scalemaker-version:\s*(\S+)/m)?.[1];
      const newSource = fs.readFileSync(skillSource, 'utf8');
      const newVersion = newSource.match(/^# scalemaker-version:\s*(\S+)/m)?.[1];
      if (existingVersion && newVersion && existingVersion === newVersion) {
        console.log(colorText(`[skill] 이미 최신 (v${existingVersion}) — skip`, 'blue'));
        return;
      }
      console.log(
        colorText(`[skill] 갱신: v${existingVersion ?? '?'} → v${newVersion ?? '?'}`, 'green'),
      );
    } catch (e: any) {
      console.warn(
        colorText(`[skill] 기존 파일 확인 실패, overwrite 진행: ${e.message}`, 'yellow'),
      );
    }
  }

  try {
    fs.mkdirSync(skillDir, { recursive: true });
    fs.copyFileSync(skillSource, skillDest);
    console.log(colorText(`✓ [skill] 설치 완료: ${skillDest}`, 'green'));
    console.log(
      colorText('  Claude Code 다음 conversation 시작부터 자동 발동 ("MCP 안 돼" 등)', 'blue'),
    );
  } catch (e: any) {
    console.warn(colorText(`[skill] 설치 실패 (무시): ${e.message}`, 'yellow'));
  }
}

async function main(): Promise<void> {
  console.log(colorText(`Installing ${COMMAND_NAME}...`, 'green'));

  // Debug information
  console.log(colorText('Installation environment debug info:', 'blue'));
  console.log(`  __dirname: ${__dirname}`);
  console.log(`  npm_config_global: ${process.env.npm_config_global}`);
  console.log(`  PNPM_HOME: ${process.env.PNPM_HOME}`);
  console.log(`  npm_config_prefix: ${process.env.npm_config_prefix}`);
  console.log(`  isGlobalInstall: ${isGlobalInstall}`);

  // Always ensure execution permissions first
  await ensureExecutionPermissions();

  // Write Node.js path for run_host scripts to use
  writeNodePathFile(path.join(__dirname, '..'));

  // If global installation, try automatic registration
  if (isGlobalInstall) {
    // v1.0.36: agent chat 제거 → 잔존 sqlite DB 파일 청소 (있을 경우만)
    removeLegacyAgentDb();
    await tryRegisterNativeHost();
    // scalemaker fork: extension zip 자동 다운로드 + 압축 해제
    const extDir = await downloadAndExtractExtension();
    // scalemaker fork v1.0.30+: Claude Code troubleshooting 스킬 자동 설치
    installClaudeCodeSkill();
    printScalemakerNextSteps(extDir);
  } else {
    console.log(colorText('Local installation detected', 'yellow'));
    printManualInstructions();
  }
}

// Only execute main function when running this script directly
if (isDirectRun) {
  main().catch((error) => {
    console.error(
      colorText(
        `Installation script error: ${error instanceof Error ? error.message : String(error)}`,
        'red',
      ),
    );
    // Set non-zero exit code to indicate installation failure
    process.exitCode = 1;
  });
}
