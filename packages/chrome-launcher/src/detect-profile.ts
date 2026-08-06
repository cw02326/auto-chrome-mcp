import { existsSync } from 'node:fs';
import { platform, homedir } from 'node:os';
import path from 'node:path';

/**
 * OS 별 default Chrome user-data-dir 자동 감지.
 */
export const detectChromeUserDataDir = (): string | null => {
  const home = homedir();
  const candidates = (() => {
    switch (platform()) {
      case 'darwin':
        return [
          path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
          path.join(home, 'Library', 'Application Support', 'Chromium'),
        ];
      case 'win32': {
        const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
        return [
          path.join(localAppData, 'Google', 'Chrome', 'User Data'),
          path.join(localAppData, 'Chromium', 'User Data'),
        ];
      }
      case 'linux':
        return [
          path.join(home, '.config', 'google-chrome'),
          path.join(home, '.config', 'chromium'),
          path.join(home, 'snap', 'chromium', 'common', 'chromium'),
        ];
      default:
        return [];
    }
  })();

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
};
