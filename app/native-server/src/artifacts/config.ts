/**
 * 브리지 설정 파일 — `~/.auto-chrome-mcp/config.json`
 *
 * 지금은 산출물(스크린샷·GIF·PDF·트레이스) 자동 정리 설정만 담는다. 비밀이 아니라서
 * 인증 토큰과 달리 소유자 전용으로 잠그지 않는다. 파일이 없거나 깨졌으면 조용히 기본값을
 * 쓰고 경고만 남긴다 — 설정 하나 때문에 브리지가 안 뜨는 일은 없어야 한다.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { getStateDir } from '../security/auth-token';

export const CONFIG_FILE_NAME = 'config.json';

export type ArtifactCleanupMode = 'archive' | 'delete' | 'off';

export interface BridgeConfig {
  /** 오래된 날짜 폴더를 옮겨 둘 곳 */
  artifactArchiveDir: string;
  /** 며칠이 지나면 정리 대상인가 (0 이상 정수) */
  artifactRetentionDays: number;
  /** archive: 보관 폴더로 이동 · delete: 삭제 · off: 아무것도 안 함 */
  artifactCleanup: ArtifactCleanupMode;
}

export const DEFAULT_ARCHIVE_DIR_NAME = 'auto-chrome-mcp-archive';
export const DEFAULT_RETENTION_DAYS = 7;
/**
 * 보관 기간의 하한.
 *
 * 0 을 허용하면 오늘 폴더까지 만료로 잡혀서, 지금 받고 있는 스크린샷·GIF·트레이스를
 * 정리해 버린다. 0 이하는 경고 후 1 로 올린다.
 */
export const MIN_RETENTION_DAYS = 1;

export const getConfigFilePath = (): string => path.join(getStateDir(), CONFIG_FILE_NAME);

export const defaultBridgeConfig = (): BridgeConfig => ({
  artifactArchiveDir: path.join(os.homedir(), DEFAULT_ARCHIVE_DIR_NAME),
  artifactRetentionDays: DEFAULT_RETENTION_DAYS,
  artifactCleanup: 'archive',
});

/** `~` 로 시작하는 경로를 홈 디렉터리로 편다 (설정 파일에 손으로 적는 값이라 흔하다). */
export const expandHome = (value: string): string => {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
};

const isCleanupMode = (value: unknown): value is ArtifactCleanupMode =>
  value === 'archive' || value === 'delete' || value === 'off';

export interface LoadedBridgeConfig {
  config: BridgeConfig;
  /** 파일이 실제로 있었는지 (없으면 전부 기본값) */
  fromFile: boolean;
  /** 무시한 값·읽기 실패 사유 */
  warnings: string[];
}

/**
 * 설정을 읽는다. 어떤 오류에서도 던지지 않는다 — 기본값 + 경고로 끝낸다.
 */
export const loadBridgeConfig = (filePath: string = getConfigFilePath()): LoadedBridgeConfig => {
  const config = defaultBridgeConfig();
  const warnings: string[] = [];

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      warnings.push(`config file could not be read (${code ?? 'unknown error'}); using defaults`);
    }
    return { config, fromFile: false, warnings };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnings.push('config file is not valid JSON; using defaults');
    return { config, fromFile: true, warnings };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnings.push('config file must contain a JSON object; using defaults');
    return { config, fromFile: true, warnings };
  }

  const record = parsed as Record<string, unknown>;

  const archiveDir = record.artifactArchiveDir;
  if (typeof archiveDir === 'string' && archiveDir.trim()) {
    // 상대 경로는 받지 않는다. path.resolve 로 펴면 브리지를 띄운 작업 디렉터리에 따라
    // 보관 폴더가 매번 달라져서, 파일이 어디로 갔는지 알 수 없게 된다.
    const expanded = expandHome(archiveDir.trim());
    if (path.isAbsolute(expanded)) {
      config.artifactArchiveDir = path.normalize(expanded);
    } else {
      warnings.push('artifactArchiveDir must be an absolute path; using the default');
    }
  } else if (archiveDir !== undefined) {
    warnings.push('artifactArchiveDir must be a non-empty string; using the default');
  }

  const retention = record.artifactRetentionDays;
  if (typeof retention === 'number' && Number.isInteger(retention)) {
    if (retention >= MIN_RETENTION_DAYS) {
      config.artifactRetentionDays = retention;
    } else if (retention >= 0) {
      config.artifactRetentionDays = MIN_RETENTION_DAYS;
      warnings.push(
        `artifactRetentionDays must be at least ${MIN_RETENTION_DAYS}; using ${MIN_RETENTION_DAYS} so today's downloads are never touched`,
      );
    } else {
      warnings.push(
        `artifactRetentionDays must be an integer of ${MIN_RETENTION_DAYS} or more; using the default`,
      );
    }
  } else if (retention !== undefined) {
    warnings.push(
      `artifactRetentionDays must be an integer of ${MIN_RETENTION_DAYS} or more; using the default`,
    );
  }

  const cleanup = record.artifactCleanup;
  if (isCleanupMode(cleanup)) {
    config.artifactCleanup = cleanup;
  } else if (cleanup !== undefined) {
    warnings.push('artifactCleanup must be "archive", "delete" or "off"; using the default');
  }

  return { config, fromFile: true, warnings };
};
