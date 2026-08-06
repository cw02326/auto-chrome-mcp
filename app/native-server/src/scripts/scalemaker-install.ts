#!/usr/bin/env node
/**
 * scalemaker-install — mcp-chrome-scalemaker fork 전용 설치 CLI.
 *
 * upstream 의 `register` 명령은 unpacked extension ID 를 인자로 받지 않아,
 * fork extension 을 unpacked load 한 사용자가 silent native-messaging 거부에 빠짐.
 * 본 CLI 는 그 gap 을 메운다:
 *
 *   1. 우리 fork 의 run_host.sh path 자동 해석 (이 파일 경로 기반)
 *   2. allowed_origins 에 사용자 unpacked extension ID + upstream Chrome Web Store ID 모두 등록
 *   3. OS 분기 manifest 위치 (macOS / Windows / Linux)
 *   4. Chrome / Brave / Edge 등 Chromium 기반 브라우저 다중 등록
 *
 * 사용:
 *   mcp-chrome-scalemaker-bridge scalemaker-install --extension-id <ID> [--browser chrome|brave|edge|all]
 *   또는
 *   scalemaker-install --extension-id <ID>
 */
import {
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import path from 'node:path';

// v1.0.2 부터 fork 전용 host name — upstream 과 분리.
const HOST_NAME = 'com.chromemcpscalemaker.nativehost';
const UPSTREAM_CHROME_WEB_STORE_ID = 'hbdgbgagpkpjffpklnamcljpakneikee';

interface CliArgs {
  extensionId?: string;
  browser: string;
  autoDetectId: boolean;
  help: boolean;
}

const parseArgs = (argv: string[]): CliArgs => {
  const out: CliArgs = { browser: 'chrome', autoDetectId: false, help: false };
  for (const a of argv) {
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--auto-detect-id') out.autoDetectId = true;
    else if (a.startsWith('--extension-id=')) out.extensionId = a.split('=', 2)[1];
    else if (a.startsWith('--browser=')) out.browser = a.split('=', 2)[1];
  }
  return out;
};

const printHelp = () => {
  console.log(`scalemaker-install — mcp-chrome-scalemaker fork install helper

사용법:
  scalemaker-install --extension-id <ID>
  scalemaker-install --extension-id <ID> --browser chrome
  scalemaker-install --extension-id <ID> --browser all
  scalemaker-install --auto-detect-id

옵션:
  --extension-id <ID>   Chrome 의 unpacked fork extension ID (32자 영문)
                        chrome://extensions 에서 Developer mode ON 후 카드 ID 확인
  --browser <name>      대상 브라우저 (chrome / brave / edge / chromium / all)
                        기본: chrome
  --auto-detect-id      Chrome Preferences 에서 우리 fork extension ID 자동 검색
                        (Default profile 만 — manual 입력이 더 신뢰)
  --help, -h            이 메시지

동작:
  1. 우리 fork 의 run_host.sh 경로 자동 해석
  2. native messaging host manifest 생성/갱신
     - path: 우리 fork 의 run_host.sh
     - allowed_origins: 사용자 unpacked ID + upstream Chrome Web Store ID 둘 다
  3. 실행 권한 부여 (chmod 755)

다음 단계:
  1. Chrome 완전 종료 (Cmd+Q on macOS / 모든 창 닫기)
  2. Chrome 재시작
  3. extension popup → ⚡ 강제 재연결 버튼 클릭
  4. 5 stage 모두 통과하면 ④ 핸드셰이크 성공
`);
};

const manifestPathFor = (browser: string): string | null => {
  const home = homedir();
  const os = platform();

  const mac: Record<string, string> = {
    chrome: path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
    brave: path.join(
      home,
      'Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts',
    ),
    edge: path.join(home, 'Library/Application Support/Microsoft Edge/NativeMessagingHosts'),
    chromium: path.join(home, 'Library/Application Support/Chromium/NativeMessagingHosts'),
  };
  const win: Record<string, string> = {
    chrome: path.join(home, 'AppData/Local/Google/Chrome/User Data/NativeMessagingHosts'),
    brave: path.join(
      home,
      'AppData/Local/BraveSoftware/Brave-Browser/User Data/NativeMessagingHosts',
    ),
    edge: path.join(home, 'AppData/Local/Microsoft/Edge/User Data/NativeMessagingHosts'),
  };
  const lin: Record<string, string> = {
    chrome: path.join(home, '.config/google-chrome/NativeMessagingHosts'),
    brave: path.join(home, '.config/BraveSoftware/Brave-Browser/NativeMessagingHosts'),
    edge: path.join(home, '.config/microsoft-edge/NativeMessagingHosts'),
    chromium: path.join(home, '.config/chromium/NativeMessagingHosts'),
  };

  const table = os === 'darwin' ? mac : os === 'win32' ? win : lin;
  const dir = table[browser];
  if (!dir) return null;
  return path.join(dir, `${HOST_NAME}.json`);
};

const browsersToInstall = (selector: string): string[] => {
  if (selector === 'all') return ['chrome', 'brave', 'edge', 'chromium'];
  return [selector];
};

/**
 * Chrome Default profile 의 Preferences 에서 우리 fork extension ID 자동 검색.
 * 실패해도 graceful — manual 입력 권유.
 */
const autoDetectExtensionId = (): string | null => {
  const home = homedir();
  const os = platform();
  const prefs = (() => {
    if (os === 'darwin') return path.join(home, 'Library/Application Support/Google/Chrome');
    if (os === 'win32') return path.join(home, 'AppData/Local/Google/Chrome/User Data');
    return path.join(home, '.config/google-chrome');
  })();

  if (!existsSync(prefs)) return null;

  const profiles = ['Default', ...readdirSync(prefs).filter((d) => d.startsWith('Profile '))];
  for (const profile of profiles) {
    const prefFile = path.join(prefs, profile, 'Preferences');
    if (!existsSync(prefFile)) continue;
    try {
      const data = JSON.parse(readFileSync(prefFile, 'utf8'));
      const settings: Record<string, any> = data?.extensions?.settings ?? {};
      for (const [id, info] of Object.entries(settings)) {
        const extPath = (info as any).path || '';
        // 우리 fork extension 의 path 특징 = chrome-extension 하위의 chrome-mv3 dir
        if (
          typeof extPath === 'string' &&
          (extPath.includes('mcp-chrome-scalemaker') || extPath.endsWith('chrome-mv3'))
        ) {
          console.log(`  [auto-detect] profile=${profile} → ${id}`);
          return id;
        }
      }
    } catch {
      // ignore parse errors
    }
  }
  return null;
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // 1. extension id 해석
  let extensionId = args.extensionId;
  if (!extensionId && args.autoDetectId) {
    console.log('🔍 Chrome Preferences 에서 fork extension ID 자동 검색…');
    extensionId = autoDetectExtensionId() ?? undefined;
    if (!extensionId) {
      console.warn(
        '⚠️  자동 감지 실패. chrome://extensions 에서 ID 확인 후 --extension-id <ID> 로 재시도하세요.',
      );
    }
  }

  if (!extensionId) {
    console.warn('⚠️  --extension-id 미지정 — upstream Chrome Web Store ID 만 등록됩니다.');
    console.warn('   unpacked fork extension 은 chrome 이 silent 거부할 수 있습니다.');
    console.warn('   chrome://extensions 에서 ID 확인 후 다시 실행 권장.');
  }

  // 2. run_host.sh 경로 (이 파일은 dist/scripts/ 안에 있으므로 ../run_host.sh)
  const runHostPath = path.resolve(__dirname, '..', 'run_host.sh');
  if (!existsSync(runHostPath)) {
    console.error(`❌ run_host.sh 를 찾을 수 없습니다: ${runHostPath}`);
    console.error('   fork 를 빌드했는지 확인: pnpm --filter mcp-chrome-scalemaker-bridge build');
    process.exit(1);
  }

  // 3. allowed_origins 조합
  const allowedOrigins: string[] = [];
  if (extensionId) {
    allowedOrigins.push(`chrome-extension://${extensionId}/`);
  }
  // upstream Chrome Web Store ID 도 함께 등록 (backward compat — 사용자가 둘 다 쓸 수 있게)
  allowedOrigins.push(`chrome-extension://${UPSTREAM_CHROME_WEB_STORE_ID}/`);

  // 4. manifest content
  const manifest = {
    name: HOST_NAME,
    description: 'Node.js Host for Browser Bridge Extension (mcp-chrome-scalemaker fork)',
    path: runHostPath,
    type: 'stdio',
    allowed_origins: allowedOrigins,
  };

  // 5. 각 browser 에 등록
  const targets = browsersToInstall(args.browser);
  const results: Array<{ browser: string; path: string | null; ok: boolean; error?: string }> = [];

  for (const browser of targets) {
    const manifestPath = manifestPathFor(browser);
    if (!manifestPath) {
      results.push({ browser, path: null, ok: false, error: 'OS or browser not supported' });
      continue;
    }
    try {
      mkdirSync(path.dirname(manifestPath), { recursive: true });
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
      results.push({ browser, path: manifestPath, ok: true });
    } catch (e: any) {
      results.push({ browser, path: manifestPath, ok: false, error: e?.message || String(e) });
    }
  }

  // 6. 실행 권한 (run_host.sh + Node bin)
  try {
    chmodSync(runHostPath, 0o755);
  } catch {
    // best-effort
  }

  // 7. 결과 출력
  console.log('');
  console.log('🚀 scalemaker-install 결과');
  console.log('');
  for (const r of results) {
    const icon = r.ok ? '✅' : '❌';
    console.log(`  ${icon} ${r.browser.padEnd(10)} ${r.path ?? '(skip)'}`);
    if (r.error) console.log(`     ↳ ${r.error}`);
  }
  console.log('');
  console.log(`  Bridge run_host: ${runHostPath}`);
  console.log(`  Allowed origins:`);
  for (const o of allowedOrigins) console.log(`    - ${o}`);
  console.log('');

  if (extensionId) {
    console.log('✅ 다음 단계:');
    console.log('   1. Chrome 완전 종료 (Cmd+Q)');
    console.log('   2. Chrome 재시작');
    console.log('   3. extension popup → ⚡ 강제 재연결 버튼 클릭');
    console.log('   4. ④ 핸드셰이크가 통과하면 성공');
  } else {
    console.log('⚠️  extension-id 없이 진행됨 — unpacked fork extension 은 동작 안 할 가능성 큼.');
    console.log('   chrome://extensions 에서 ID 확인 후 재실행:');
    console.log('   scalemaker-install --extension-id <ID>');
  }
};

main();
