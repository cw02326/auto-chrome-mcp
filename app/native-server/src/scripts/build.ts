import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const distDir = path.join(__dirname, '..', '..', 'dist');
// Clean previous build
console.log('[build] 이전 빌드 정리...');
try {
  fs.rmSync(distDir, { recursive: true, force: true });
} catch (err) {
  console.log(err);
}

// Create dist directory
fs.mkdirSync(distDir, { recursive: true });
fs.mkdirSync(path.join(distDir, 'logs'), { recursive: true });
console.log('[build] dist + dist/logs 디렉토리 생성');

// Compile TypeScript
console.log('[build] TypeScript 컴파일...');
execSync('tsc', { stdio: 'inherit' });

// Copy stdio-config.json
console.log('[build] stdio-config.json 복사...');
const configSourcePath = path.join(__dirname, '..', 'mcp', 'stdio-config.json');
const configDestPath = path.join(distDir, 'mcp', 'stdio-config.json');
try {
  fs.mkdirSync(path.dirname(configDestPath), { recursive: true });
  if (fs.existsSync(configSourcePath)) {
    fs.copyFileSync(configSourcePath, configDestPath);
    console.log(`[build] stdio-config.json → ${configDestPath}`);
  } else {
    console.error(`[build] ERROR: 설정 파일 없음: ${configSourcePath}`);
  }
} catch (error) {
  console.error('[build] 설정 파일 복사 실패:', error);
}

// scalemaker fork v1.0.29+: Claude Code SKILL.md 복사 + version stamp 주입.
// 사용자가 welcome 페이지의 prompt 로 ~/.claude/skills/ 로 install 함.
console.log('[build] SKILL.md 복사 + version stamp...');
const skillSourcePath = path.join(__dirname, '..', '..', 'skill', 'SKILL.md');
const skillDestDir = path.join(distDir, 'skill');
const skillDestPath = path.join(skillDestDir, 'SKILL.md');
try {
  fs.mkdirSync(skillDestDir, { recursive: true });
  if (fs.existsSync(skillSourcePath)) {
    const skillSource = fs.readFileSync(skillSourcePath, 'utf8');
    const packageJsonForVersion = require('../../package.json');
    const stamped = skillSource.replace(
      '<bridge version at build time>',
      packageJsonForVersion.version,
    );
    fs.writeFileSync(skillDestPath, stamped, 'utf8');
    console.log(`[build] SKILL.md → ${skillDestPath} (version=${packageJsonForVersion.version})`);
  } else {
    console.error(`[build] ERROR: SKILL.md 원본 없음: ${skillSourcePath}`);
  }
} catch (error) {
  console.error('[build] SKILL.md 복사 실패:', error);
}

// Generate README.md from package.json metadata
console.log('[build] README.md 생성...');
const packageJson = require('../../package.json');
const readmeContent = `# ${packageJson.name}

Chrome 확장의 Native Messaging host (scalemaker fork).

## 설치

\`\`\`bash
npm install -g ${packageJson.name}
\`\`\`

postinstall 이 자동으로:
- Native Messaging manifest 등록
- Extension zip 다운로드 → \`~/Downloads/${packageJson.name.replace('-bridge', '')}-extension-v${packageJson.version}/\`

## 진단

\`\`\`bash
${packageJson.name} doctor          # 설치/manifest/권한/Node 경로 점검
${packageJson.name} doctor --fix    # 자동 복구
${packageJson.name} report --copy   # GH Issue 용 진단 리포트 (클립보드)
\`\`\`

## 사용

이 host 는 Chrome 확장에 의해 자동 실행됩니다. 수동 실행 불필요.
`;
fs.writeFileSync(path.join(distDir, 'README.md'), readmeContent);

// Copy wrapper scripts
console.log('[build] wrapper 스크립트 복사...');
const scriptsSourceDir = path.join(__dirname, '.');
const macOsWrapperSourcePath = path.join(scriptsSourceDir, 'run_host.sh');
const windowsWrapperSourcePath = path.join(scriptsSourceDir, 'run_host.bat');
const macOsWrapperDestPath = path.join(distDir, 'run_host.sh');
const windowsWrapperDestPath = path.join(distDir, 'run_host.bat');

try {
  if (fs.existsSync(macOsWrapperSourcePath)) {
    fs.copyFileSync(macOsWrapperSourcePath, macOsWrapperDestPath);
    console.log(`[build] ${macOsWrapperSourcePath} → ${macOsWrapperDestPath}`);
  } else {
    console.error(`[build] ERROR: macOS wrapper 원본 없음: ${macOsWrapperSourcePath}`);
  }

  if (fs.existsSync(windowsWrapperSourcePath)) {
    fs.copyFileSync(windowsWrapperSourcePath, windowsWrapperDestPath);
    console.log(`[build] ${windowsWrapperSourcePath} → ${windowsWrapperDestPath}`);
  } else {
    console.error(`[build] ERROR: Windows wrapper 원본 없음: ${windowsWrapperSourcePath}`);
  }
} catch (error) {
  console.error('[build] wrapper 스크립트 복사 실패:', error);
}

// Set executable permissions on critical JS files and macOS wrapper
console.log('[build] 실행 권한 부여...');
const filesToMakeExecutable = ['index.js', 'cli.js', 'run_host.sh'];

filesToMakeExecutable.forEach((file) => {
  const filePath = path.join(distDir, file);
  try {
    if (fs.existsSync(filePath)) {
      fs.chmodSync(filePath, '755');
      console.log(`[build] chmod 755 ${file}`);
    } else {
      console.warn(`[build] WARN: ${filePath} 없음 — 권한 부여 건너뜀`);
    }
  } catch (error) {
    console.error(`[build] ${file} 권한 부여 실패:`, error);
  }
});

// Write node_path.txt immediately after build to ensure Chrome uses the correct Node.js version.
// This is critical for development mode where dist is deleted on each rebuild.
console.log('[build] node_path.txt 작성...');
const nodePathFile = path.join(distDir, 'node_path.txt');
fs.writeFileSync(nodePathFile, process.execPath, 'utf8');
console.log(`[build] node 경로 박제: ${process.execPath}`);

console.log('✅ [build] 완료');
