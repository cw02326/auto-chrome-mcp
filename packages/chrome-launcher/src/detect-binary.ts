import { existsSync } from 'node:fs';
import { platform, homedir, arch } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

export interface ChromeBinary {
  /** Absolute path to the Chrome executable. */
  path: string;
  /** Channel hint based on path (stable / beta / dev / canary / chromium). */
  channel: 'stable' | 'beta' | 'dev' | 'canary' | 'chromium' | 'unknown';
}

const macCandidates = (): Array<{ path: string; channel: ChromeBinary['channel'] }> => [
  {
    path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    channel: 'stable',
  },
  {
    path: '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    channel: 'beta',
  },
  {
    path: '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
    channel: 'dev',
  },
  {
    path: '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    channel: 'canary',
  },
  {
    path: '/Applications/Chromium.app/Contents/MacOS/Chromium',
    channel: 'chromium',
  },
];

const winCandidates = (): Array<{ path: string; channel: ChromeBinary['channel'] }> => {
  const localAppData = process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const programFiles86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return [
    {
      path: path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      channel: 'stable',
    },
    {
      path: path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      channel: 'stable',
    },
    {
      path: path.join(programFiles86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      channel: 'stable',
    },
    {
      path: path.join(localAppData, 'Google', 'Chrome Beta', 'Application', 'chrome.exe'),
      channel: 'beta',
    },
  ];
};

const linuxCandidates = (): Array<{ path: string; channel: ChromeBinary['channel'] }> => [
  { path: '/usr/bin/google-chrome', channel: 'stable' },
  { path: '/usr/bin/google-chrome-stable', channel: 'stable' },
  { path: '/usr/bin/google-chrome-beta', channel: 'beta' },
  { path: '/usr/bin/chromium', channel: 'chromium' },
  { path: '/usr/bin/chromium-browser', channel: 'chromium' },
  { path: '/snap/bin/chromium', channel: 'chromium' },
];

/**
 * 모든 OS 에서 Chrome 의 default profile 위치를 자동 감지.
 */
export const detectChromeBinary = (): ChromeBinary | null => {
  const candidates = (() => {
    switch (platform()) {
      case 'darwin':
        return macCandidates();
      case 'win32':
        return winCandidates();
      case 'linux':
        return linuxCandidates();
      default:
        return [];
    }
  })();

  for (const c of candidates) {
    if (existsSync(c.path)) {
      return { path: c.path, channel: c.channel };
    }
  }

  // 후폴백: PATH 에서 google-chrome / chromium 찾기 (Linux/macOS)
  if (platform() !== 'win32') {
    for (const cmd of ['google-chrome', 'chromium', 'chrome']) {
      try {
        const resolved = execSync(`command -v ${cmd}`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (resolved && existsSync(resolved)) {
          return { path: resolved, channel: 'unknown' };
        }
      } catch {
        // command 없음
      }
    }
  }

  return null;
};

/**
 * 실행 환경 진단 정보.
 */
export const getEnvironmentInfo = () => ({
  platform: platform(),
  arch: arch(),
  homedir: homedir(),
});
