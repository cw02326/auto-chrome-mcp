/**
 * 산출물 자동 정리 — `Downloads/mcp-screenshots/YYYY-MM-DD/` 의 오래된 날짜 폴더를
 * 보관 폴더로 옮기거나(기본) 지운다.
 *
 * 왜 여기 있나:
 *   확장은 `chrome.downloads` 로만 파일을 쓸 수 있어서 지우거나 옮길 수 없다. 파일 시스템을
 *   만질 수 있는 쪽은 브리지뿐이라, 정리는 네이티브 호스트가 뜰 때 한 번 돈다.
 *
 * 안전 원칙 (사용자의 다운로드 폴더를 건드리는 코드다):
 *   - 대상은 `mcp-screenshots` 아래 **날짜 이름 폴더** 뿐이다. 그 밖의 파일·폴더는 손대지 않는다.
 *   - 산출물 루트와 날짜 폴더가 심볼릭 링크·윈도우 junction(reparse point)이면 통째로
 *     건너뛴다. 문자열 비교만으로는 링크 너머의 바깥 폴더를 막을 수 없기 때문이다.
 *   - 경로 경계는 `realpath` 로 편 **물리 경로** 기준으로 확인하고, 지우거나 옮기기
 *     직전에 한 번 더 확인한다.
 *   - 각 항목은 lstat 으로 확인해 **일반 파일** 만 옮긴다. 심볼릭 링크·하위 폴더는 건너뛴다.
 *   - 오늘 폴더와 받는 중인 파일(.crdownload · .part · .tmp)은 언제나 제외한다.
 *   - 동시에 두 브리지가 뜰 수 있으므로 상태 디렉터리의 `artifacts.lock` 으로 배타 실행한다.
 *   - 이동은 임시 파일에 복사 -> fsync -> 최종 이름으로 연결 -> 원본 삭제 순서다. 도중에
 *     실패하면 임시 파일만 지우고 원본은 남긴다.
 *   - 어떤 실패에서도 던지지 않는다. 서버 시작을 막지 않는 것이 우선이다.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';

import { getStateDir } from '../security/auth-token';
import {
  ArtifactCleanupMode,
  BridgeConfig,
  DEFAULT_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  defaultBridgeConfig,
  loadBridgeConfig,
} from './config';

/** 확장이 쓰는 산출물 루트 폴더명 — chrome-extension/utils/artifact-path.ts 와 같아야 한다. */
export const ARTIFACT_ROOT_DIR = 'mcp-screenshots';

/** 테스트·특수 환경에서 다운로드 폴더를 직접 지정하는 환경 변수 */
export const DOWNLOADS_DIR_ENV = 'AUTO_CHROME_MCP_DOWNLOADS_DIR';

export const LAST_RUN_FILE_NAME = 'artifacts-last-run.json';

/** 프로세스 간 배타 실행용 잠금 파일 (상태 디렉터리) */
export const LOCK_FILE_NAME = 'artifacts.lock';
/** 이 시간이 지난 잠금은 죽은 프로세스가 남긴 것으로 보고 회수한다. */
export const LOCK_STALE_MS = 10 * 60 * 1000;
/** 죽은 잠금을 회수할 때 먼저 옮겨 오는 이름의 접미사. */
export const LOCK_RECLAIM_SUFFIX = '.reclaim-';

/** 아직 받는 중인 파일 — 크롬(.crdownload)·부분 다운로드(.part)·임시 산출물(.tmp) */
const IN_PROGRESS_EXTENSIONS = ['.crdownload', '.part', '.tmp'];

/** 이동 중 임시 파일 접두사 */
const TEMP_PREFIX = '.acm-tmp-';

/** 이름 충돌 시 접미사를 올려 보는 최대 횟수 */
const MAX_NAME_ATTEMPTS = 500;

/** 하드 링크를 못 쓰는 파일 시스템에서 내용을 복사할 때 쓰는 버퍼 크기 */
const COPY_CHUNK_BYTES = 64 * 1024;

/** Windows 의 Downloads known folder GUID */
const DOWNLOADS_FOLDER_GUID = '{374DE290-123F-4565-9164-39C4925E467B}';
const USER_SHELL_FOLDERS_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders';

const DATE_FOLDER_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ArtifactCleanupResult {
  mode: ArtifactCleanupMode;
  dryRun: boolean;
  ranAt: string;
  downloadsDir: string;
  artifactDir: string;
  archiveDir: string;
  /** 실제로 적용한 보관 기간 (설정값이 하한보다 작으면 하한) */
  retentionDays: number;
  /** 정리 대상으로 판정된 날짜 폴더 이름 */
  folders: string[];
  files: number;
  bytes: number;
  /** 건너뛴 항목과 이유 (링크·하위 폴더·경계 밖·받는 중·잠금) */
  skipped: string[];
  errors: string[];
}

/** `%USERPROFILE%` 같은 환경 변수 참조를 편다 (REG_EXPAND_SZ 값). */
const expandWindowsEnv = (value: string): string =>
  value.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole);

/**
 * 다운로드 폴더 위치.
 * Windows 는 사용자가 옮겼을 수 있으므로 레지스트리를 먼저 읽고, 없으면 `~/Downloads`.
 */
export const resolveDownloadsDir = (): string => {
  const override = process.env[DOWNLOADS_DIR_ENV];
  if (override && override.trim()) return path.resolve(override.trim());

  if (process.platform === 'win32') {
    try {
      const output = execFileSync(
        'reg.exe',
        ['query', USER_SHELL_FOLDERS_KEY, '/v', DOWNLOADS_FOLDER_GUID],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 },
      );
      // "    {374DE...}    REG_EXPAND_SZ    C:\Users\me\Downloads"
      const line = output
        .split(/\r?\n/)
        .find((row) => row.includes(DOWNLOADS_FOLDER_GUID) && /REG_(EXPAND_)?SZ/.test(row));
      if (line) {
        const match = line.match(/REG_(?:EXPAND_)?SZ\s+(.+)$/);
        const value = match?.[1]?.trim();
        if (value) return path.resolve(expandWindowsEnv(value));
      }
    } catch {
      // 레지스트리를 못 읽으면 기본 위치로 간다.
    }
  }

  return path.join(os.homedir(), 'Downloads');
};

/** 로컬 자정 기준 날짜 값 */
const startOfLocalDay = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/**
 * 날짜 폴더 이름을 로컬 날짜로 읽는다. 형식이 아니거나 실제 날짜가 아니면 null.
 * (2026-02-31 처럼 굴러가는 값은 대상에서 뺀다 — 우리가 만든 폴더가 아니다.)
 */
export const parseDateFolderName = (name: string): Date | null => {
  const match = DATE_FOLDER_RE.exec(name);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (
    date.getFullYear() !== Number(year) ||
    date.getMonth() !== Number(month) - 1 ||
    date.getDate() !== Number(day)
  ) {
    return null;
  }
  return date;
};

/**
 * 정리 대상인가?
 * 폴더 날짜로부터 retentionDays 일이 **지났으면** 대상이다. 정확히 retentionDays 일 된 폴더는
 * 포함된다("7일 지난 것은 정리" 지시 그대로).
 *
 * 오늘 폴더(그리고 시계 차이로 생긴 미래 폴더)는 retentionDays 가 0 이어도 절대 대상이
 * 아니다 — 지금 받고 있는 파일이 그 안에 있다.
 */
export const isExpiredFolderName = (
  name: string,
  retentionDays: number,
  now: Date = new Date(),
): boolean => {
  const folderDate = parseDateFolderName(name);
  if (!folderDate) return false;
  const ageDays = Math.floor((startOfLocalDay(now) - startOfLocalDay(folderDate)) / MS_PER_DAY);
  if (ageDays <= 0) return false;
  return ageDays >= Math.max(MIN_RETENTION_DAYS, retentionDays);
};

// ============================================================================
// 경로 안전 (링크 · 물리 경로 · 경계)
// ============================================================================

/**
 * 심볼릭 링크나 윈도우 junction 같은 reparse point 인가.
 *
 * Node 는 윈도우 junction 도 lstat 에서 심볼릭 링크로 알려 주지만, 그렇지 않은 환경을
 * 대비해 디렉터리에 대해서는 readlink 로 한 번 더 확인한다(보통 디렉터리는 EINVAL).
 */
export const isReparsePoint = (target: string): boolean => {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(target);
  } catch {
    return false;
  }
  if (stats.isSymbolicLink()) return true;
  if (!stats.isDirectory()) return false;
  try {
    fs.readlinkSync(target);
    return true;
  } catch {
    return false;
  }
};

/**
 * 물리 경로. 아직 없는 경로는 존재하는 가장 가까운 상위를 풀고 나머지를 이어 붙인다
 * (보관 폴더는 아직 안 만들어졌을 수 있다).
 */
export const realPathOrBestEffort = (target: string): string => {
  let current = path.resolve(target);
  const trailing: string[] = [];
  for (;;) {
    try {
      const resolved = fs.realpathSync.native(current);
      return trailing.length > 0 ? path.join(resolved, ...trailing.reverse()) : resolved;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      trailing.push(path.basename(current));
      current = parent;
    }
  }
};

/** child 가 parent 아래인가 (parent 자신은 제외). */
const isInside = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** child 가 parent 자신이거나 그 아래인가. */
const isSameOrInside = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** 받는 중인 파일인가. */
const isInProgressFile = (name: string): boolean => {
  const lower = name.toLowerCase();
  return IN_PROGRESS_EXTENSIONS.some((ext) => lower.endsWith(ext));
};

// ============================================================================
// 프로세스 간 잠금
// ============================================================================

export interface CleanupLock {
  path: string;
  /** 이 잠금의 소유자 토큰. release 는 파일의 토큰이 이것과 같을 때만 지운다. */
  token: string;
  release: () => void;
}

type LockAttempt = { ok: true; lock: CleanupLock } | { ok: false; reason: string };

/** 잠금 파일에 적는 소유자 토큰. 이 값이 같을 때만 잠금을 푼다. */
const makeLockToken = (): string => `${process.pid}-${randomBytes(12).toString('hex')}`;

/** 잠금 파일에 적힌 소유자 토큰. 못 읽으면 null (남의 것으로 보고 건드리지 않는다). */
const readLockToken = (lockPath: string): string | null => {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { token?: unknown };
    return typeof parsed.token === 'string' && parsed.token ? parsed.token : null;
  } catch {
    return null;
  }
};

/**
 * 상태 디렉터리에 `artifacts.lock` 을 'wx' 로 만들어 배타 실행을 보장한다.
 * 두 브리지가 동시에 뜨면 둘 다 같은 날짜 폴더를 읽고 같은 보관 위치를 골라 서로를 덮는다.
 *
 * 잠금 파일 이름은 고정이라 "지금 이 파일이 내 잠금인가" 를 이름만으로는 알 수 없다.
 * 그래서 소유자 토큰(pid + 난수)을 적어 두고, 풀 때는 파일을 다시 읽어 토큰이 같을 때만
 * 지운다. 예전에는 조건 없이 unlink 라서, 내 잠금이 이미 회수된 뒤였다면 그 사이 남이
 * 새로 만든 잠금을 지웠다.
 *
 * 죽은 프로세스가 남긴 잠금 회수도 `stat` 뒤에 바로 unlink 하지 않는다. 그 사이에 남이
 * 잠금을 새로 만들면 그걸 지우기 때문이다. rename 으로 먼저 내 이름으로 옮겨 오고,
 * rename 이 실패하면 남이 먼저 회수한 것으로 보고 포기한다.
 */
const acquireCleanupLock = (): LockAttempt => {
  const stateDir = getStateDir();
  const lockPath = path.join(stateDir, LOCK_FILE_NAME);
  fs.mkdirSync(stateDir, { recursive: true });
  const token = makeLockToken();

  const tryOpen = (): number | null => {
    try {
      return fs.openSync(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      return null;
    }
  };

  let fd = tryOpen();
  if (fd === null) {
    let ageMs = Number.POSITIVE_INFINITY;
    try {
      ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
    } catch {
      // 방금 사라졌을 수 있다 — 회수를 시도한다.
    }
    if (ageMs < LOCK_STALE_MS) {
      return { ok: false, reason: `another cleanup holds the lock (${lockPath})` };
    }
    // 먼저 내 이름으로 옮겨 온 뒤에 지운다. rename 은 한쪽만 성공한다.
    const reclaimed = `${lockPath}${LOCK_RECLAIM_SUFFIX}${randomBytes(8).toString('hex')}`;
    try {
      fs.renameSync(lockPath, reclaimed);
    } catch {
      return { ok: false, reason: `another cleanup reclaimed the lock (${lockPath})` };
    }
    try {
      fs.unlinkSync(reclaimed);
    } catch {
      // 회수본을 못 지워도 잠금 자리는 비었다.
    }
    fd = tryOpen();
    if (fd === null) {
      return { ok: false, reason: `another cleanup holds the lock (${lockPath})` };
    }
  }

  // 토큰을 못 적으면 풀 때 내 잠금인지 확인할 수 없다. 그러면 잠금을 잡지 않는다.
  try {
    fs.writeSync(
      fd,
      `${JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() })}\n`,
    );
    fs.closeSync(fd);
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      // 이미 닫혔으면 그만이다.
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // 방금 만든 파일이다. 못 지워도 오래되면 회수된다.
    }
    return {
      ok: false,
      reason: `cannot write the lock owner token (${error instanceof Error ? error.message : String(error)})`,
    };
  }

  return {
    ok: true,
    lock: {
      path: lockPath,
      token,
      release: (): void => {
        try {
          // 내 토큰이 아니면 남의 잠금이다. 건드리지 않는다.
          if (readLockToken(lockPath) !== token) return;
          fs.unlinkSync(lockPath);
        } catch {
          // 이미 없으면 그만이다.
        }
      },
    },
  };
};

// ============================================================================
// 이동 (원자적)
// ============================================================================

const fsyncFile = (target: string): void => {
  let fd: number | null = null;
  try {
    fd = fs.openSync(target, 'r+');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
};

/** 같은 이름이 있으면 `-2`, `-3` … 을 붙여 **만들어지는** 폴더를 돌려준다(EEXIST 로 판정). */
const createUniqueDir = (parent: string, name: string): string => {
  for (let suffix = 1; suffix <= MAX_NAME_ATTEMPTS; suffix += 1) {
    const candidate = path.join(parent, suffix === 1 ? name : `${name}-${suffix}`);
    try {
      fs.mkdirSync(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error(`no free archive folder name for ${name} in ${parent}`);
};

/**
 * 임시 파일의 내용을 **새로 만드는** 파일에만 써 넣는다. 이미 있으면 EEXIST 로 던진다.
 *
 * 하드 링크를 못 만드는 파일 시스템의 폴백이다. 예전에는 `existsSync` 로 보고 없으면
 * `renameSync` 였는데, rename 은 POSIX 에서 기존 파일을 조용히 덮어쓴다. 확인과 rename
 * 사이에 다른 정리가 같은 이름을 만들면 그 파일이 사라졌다. 여기서는 'wx' 로 자리를
 * 먼저 잡고 그 fd 에만 쓰므로 남의 파일을 덮을 수 없다.
 */
const copyIntoNewFile = (temp: string, dest: string): void => {
  const destFd = fs.openSync(dest, 'wx');
  let closed = false;
  try {
    const srcFd = fs.openSync(temp, 'r');
    try {
      const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      for (;;) {
        const read = fs.readSync(srcFd, buffer, 0, buffer.length, null);
        if (read <= 0) break;
        let written = 0;
        while (written < read) {
          written += fs.writeSync(destFd, buffer, written, read - written, null);
        }
      }
    } finally {
      fs.closeSync(srcFd);
    }
    fs.fsyncSync(destFd);
    fs.closeSync(destFd);
    closed = true;
  } catch (error) {
    if (!closed) {
      try {
        fs.closeSync(destFd);
      } catch {
        // 닫기 실패는 원래 오류를 가리지 않는다.
      }
    }
    try {
      fs.unlinkSync(dest);
    } catch {
      // 반쪽짜리 파일을 못 지워도 원본은 그대로 남는다.
    }
    throw error;
  }
};

/**
 * 임시 파일을 최종 이름으로 확정한다. 존재하면 EEXIST 로 판정해 접미사를 올린다
 * (existsSync 로 미리 보고 rename 하면 그 사이에 다른 프로세스가 같은 이름을 만든다).
 *
 * `linkFn` 은 테스트에서 하드 링크 실패를 재현하기 위한 자리다. 기본값은 fs.linkSync.
 */
export const linkIntoPlace = (
  temp: string,
  dir: string,
  fileName: string,
  linkFn: (from: string, to: string) => void = fs.linkSync,
): { finalPath: string; tempConsumed: boolean } => {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  for (let suffix = 1; suffix <= MAX_NAME_ATTEMPTS; suffix += 1) {
    const candidate = path.join(dir, suffix === 1 ? fileName : `${stem}-${suffix}${ext}`);
    try {
      linkFn(temp, candidate);
      return { finalPath: candidate, tempConsumed: false };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'EEXIST') continue;
      if (
        code === 'EPERM' ||
        code === 'EXDEV' ||
        code === 'ENOSYS' ||
        code === 'EOPNOTSUPP' ||
        code === 'ENOTSUP'
      ) {
        // 하드 링크를 못 만드는 파일 시스템 — 'wx' 로 자리를 잡고 내용을 복사한다.
        // rename 은 쓰지 않는다 (기존 파일을 덮어쓴다).
        try {
          copyIntoNewFile(temp, candidate);
        } catch (fallbackError) {
          if ((fallbackError as NodeJS.ErrnoException)?.code === 'EEXIST') continue;
          throw fallbackError;
        }
        return { finalPath: candidate, tempConsumed: false };
      }
      throw error;
    }
  }
  throw new Error(`no free name for ${fileName} in ${dir}`);
};

/** 원본이 복사 도중 바뀌지 않았는지 볼 때 쓰는 지문. */
interface SourceFingerprint {
  size: number;
  mtimeMs: number;
  ino: number;
  dev: number;
}

const fingerprint = (stat: fs.Stats): SourceFingerprint => ({
  size: stat.size,
  mtimeMs: stat.mtimeMs,
  ino: stat.ino,
  dev: stat.dev,
});

const sameFingerprint = (a: SourceFingerprint, b: SourceFingerprint): boolean =>
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.dev === b.dev;

export interface ArchiveMoveResult {
  finalPath: string;
  /** 원본을 지웠는가. false 면 보관본과 원본이 함께 남는다. */
  sourceRemoved: boolean;
  /** 원본을 남긴 이유 (지웠으면 없음). */
  keptReason?: string;
}

/**
 * 파일 하나를 보관 폴더로 옮긴다.
 *
 * 예전에는 rename 을 먼저 하고 EXDEV(다른 드라이브)면 최종 파일에 바로 복사한 뒤 fsync 도
 * 없이 원본을 지웠다. 도중에 죽으면 반쪽짜리 파일만 남고 원본은 사라졌다.
 * 이제는 항상 임시 파일에 복사하고 fsync 한 뒤에야 최종 이름으로 확정하고 원본을 지운다.
 *
 * 복사에는 시간이 걸린다. 그 사이에 크롬이 같은 이름으로 새 산출물을 쓰면, 지우는 것은
 * 우리가 보관한 그 파일이 아니라 **새 파일** 이다. 그래서 복사 전에 원본의 지문(크기·
 * mtime·inode·device)을 잡고, 지우기 직전에 다시 재서 넷 다 같을 때만 지운다. 다르면
 * 보관본은 그대로 두고 원본은 남긴다 (중복이 파일 유실보다 낫다).
 */
const moveFileToArchive = (from: string, destDir: string, fileName: string): ArchiveMoveResult => {
  const temp = path.join(destDir, `${TEMP_PREFIX}${process.pid}-${randomBytes(6).toString('hex')}`);
  let tempExists = false;
  try {
    const before = fingerprint(fs.lstatSync(from));
    fs.copyFileSync(from, temp, fs.constants.COPYFILE_EXCL);
    tempExists = true;
    fsyncFile(temp);
    const placed = linkIntoPlace(temp, destDir, fileName);
    if (!placed.tempConsumed) {
      fs.unlinkSync(temp);
    }
    tempExists = false;

    // 여기서 실패하면 보관본과 원본이 함께 남는다(중복). 파일이 사라지는 것보다 낫다.
    let after: SourceFingerprint | null = null;
    try {
      after = fingerprint(fs.lstatSync(from));
    } catch {
      after = null;
    }
    if (after === null) {
      return {
        finalPath: placed.finalPath,
        sourceRemoved: false,
        keptReason: 'the original could not be checked again before deleting it',
      };
    }
    if (!sameFingerprint(before, after)) {
      return {
        finalPath: placed.finalPath,
        sourceRemoved: false,
        keptReason:
          'the original changed while it was being archived; the copy was kept and the original was left in place',
      };
    }
    fs.unlinkSync(from);
    return { finalPath: placed.finalPath, sourceRemoved: true };
  } catch (error) {
    if (tempExists) {
      try {
        fs.unlinkSync(temp);
      } catch {
        // 임시 파일 정리 실패는 원래 오류를 가리지 않는다.
      }
    }
    throw error;
  }
};

// ============================================================================
// 정리
// ============================================================================

export interface ArtifactCleanupOptions {
  config?: BridgeConfig;
  downloadsDir?: string;
  now?: Date;
  dryRun?: boolean;
}

interface FolderCleanupContext {
  folderPath: string;
  folderName: string;
  mode: ArtifactCleanupMode;
  archiveRoot: string | null;
  dryRun: boolean;
  result: ArtifactCleanupResult;
}

/**
 * 한 번 정리한다. 던지지 않는다 — 실패는 결과의 errors 에 담긴다.
 */
export const runArtifactCleanup = (options: ArtifactCleanupOptions = {}): ArtifactCleanupResult => {
  const now = options.now ?? new Date();
  const config = options.config ?? loadBridgeConfig().config;
  const downloadsDir = options.downloadsDir ?? resolveDownloadsDir();
  const artifactDir = path.join(downloadsDir, ARTIFACT_ROOT_DIR);
  const dryRun = options.dryRun === true;

  const requested = Number.isFinite(config.artifactRetentionDays)
    ? Math.floor(config.artifactRetentionDays)
    : DEFAULT_RETENTION_DAYS;
  const retentionDays = Math.max(MIN_RETENTION_DAYS, requested);

  const result: ArtifactCleanupResult = {
    mode: config.artifactCleanup,
    dryRun,
    ranAt: now.toISOString(),
    downloadsDir,
    artifactDir,
    archiveDir: config.artifactArchiveDir,
    retentionDays,
    folders: [],
    files: 0,
    bytes: 0,
    skipped: [],
    errors: [],
  };

  if (config.artifactCleanup === 'off') return result;

  // (1) 산출물 루트가 링크·junction 이면 통째로 건너뛴다. 바깥을 가리키는 junction 이면
  //     readdir 이 바깥 폴더를 읽어, 우리가 만들지도 않은 파일을 옮기거나 지우게 된다.
  if (isReparsePoint(artifactDir)) {
    result.skipped.push(`${artifactDir}: symlink or junction (reparse point); nothing was touched`);
    return result;
  }

  // (2) 물리 경로로 경계를 다시 확인한다.
  let realArtifactDir: string;
  try {
    realArtifactDir = fs.realpathSync.native(artifactDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    // 폴더가 아직 없으면 정리할 것도 없다 — 오류가 아니다.
    if (code !== 'ENOENT') result.errors.push(`cannot read ${artifactDir}: ${code ?? 'unknown'}`);
    return result;
  }
  const realDownloadsDir = realPathOrBestEffort(downloadsDir);
  if (!isInside(realDownloadsDir, realArtifactDir)) {
    result.skipped.push(
      `${artifactDir}: resolves outside the downloads folder (${realArtifactDir})`,
    );
    return result;
  }

  // (3) 보관 폴더 위치 검증 — 절대 경로여야 하고, 산출물 폴더와 겹치면 안 된다.
  let archiveRoot: string | null = null;
  if (config.artifactCleanup === 'archive') {
    const configured = config.artifactArchiveDir;
    if (typeof configured !== 'string' || !configured.trim() || !path.isAbsolute(configured)) {
      result.errors.push(
        `artifactArchiveDir must be an absolute path (got ${String(configured)}); nothing was archived`,
      );
      return result;
    }
    const realArchive = realPathOrBestEffort(configured);
    if (
      isSameOrInside(realArtifactDir, realArchive) ||
      isSameOrInside(realArchive, realArtifactDir)
    ) {
      result.errors.push(
        `artifactArchiveDir (${realArchive}) must be outside the artifact folder (${realArtifactDir}); nothing was archived`,
      );
      return result;
    }
    archiveRoot = realArchive;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(realArtifactDir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') result.errors.push(`cannot read ${artifactDir}: ${code ?? 'unknown'}`);
    return result;
  }

  // (4) 실제로 건드리기 전에 프로세스 간 잠금을 잡는다. dry-run 은 아무것도 바꾸지 않으므로
  //     잠금 파일도 만들지 않는다.
  let lock: CleanupLock | null = null;
  if (!dryRun) {
    let attempt: LockAttempt;
    try {
      attempt = acquireCleanupLock();
    } catch (error) {
      result.errors.push(
        `cannot take the cleanup lock: ${error instanceof Error ? error.message : String(error)}`,
      );
      return result;
    }
    if (!attempt.ok) {
      result.skipped.push(`cleanup skipped: ${attempt.reason}`);
      return result;
    }
    lock = attempt.lock;
  }

  try {
    for (const entry of entries) {
      if (!entry.isDirectory()) continue; // 파일·링크는 우리가 만든 것이 아니다
      if (!isExpiredFolderName(entry.name, retentionDays, now)) continue;

      const folderPath = path.join(realArtifactDir, entry.name);

      // 날짜 폴더가 링크·junction 이면 그 폴더는 건드리지 않는다.
      if (isReparsePoint(folderPath)) {
        result.skipped.push(`${entry.name}: symlink or junction (reparse point)`);
        continue;
      }

      let realFolder: string;
      try {
        realFolder = fs.realpathSync.native(folderPath);
      } catch {
        result.skipped.push(`${entry.name}: cannot resolve the real path`);
        continue;
      }
      if (!isInside(realArtifactDir, realFolder)) {
        result.skipped.push(`${entry.name}: resolves outside the artifact folder (${realFolder})`);
        continue;
      }

      try {
        const moved = cleanupOneFolder({
          folderPath: realFolder,
          folderName: entry.name,
          mode: config.artifactCleanup,
          archiveRoot,
          dryRun,
          result,
        });
        if (moved) result.folders.push(entry.name);
      } catch (error) {
        result.errors.push(
          `${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } finally {
    lock?.release();
  }

  return result;
};

/**
 * 지우거나 옮기기 **직전** 에 다시 확인한다. readdir 과 실제 변경 사이에 항목이 링크로
 * 바뀌었을 수 있다.
 *
 * (하드 링크는 물리 경로가 하나뿐이라 이 검사로 구분되지 않는다. 다만 하드 링크를 지우는
 * 것은 날짜 폴더 안의 이름 하나를 지우는 것이고, 옮기는 것도 복사 후 그 이름만 지운다 —
 * 폴더 밖 원본은 그대로 남는다.)
 */
const verifyRegularFileInside = (
  folderPath: string,
  childPath: string,
): { ok: true; stat: fs.Stats } | { ok: false; reason: string } => {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(childPath);
  } catch {
    return { ok: false, reason: 'cannot stat' };
  }
  if (stat.isSymbolicLink()) return { ok: false, reason: 'symlink' };
  if (!stat.isFile()) return { ok: false, reason: 'not a regular file' };

  let realChild: string;
  try {
    realChild = fs.realpathSync.native(childPath);
  } catch {
    return { ok: false, reason: 'cannot resolve the real path' };
  }
  if (!isInside(folderPath, realChild)) {
    return { ok: false, reason: `outside the date folder (${realChild})` };
  }
  return { ok: true, stat };
};

/** 날짜 폴더 하나를 처리한다. 한 파일이라도 다뤘으면 true. */
const cleanupOneFolder = (context: FolderCleanupContext): boolean => {
  const { folderPath, folderName, mode, archiveRoot, dryRun, result } = context;
  const children = fs.readdirSync(folderPath);
  let destDir: string | null = null;
  let handled = 0;

  for (const child of children) {
    const childPath = path.join(folderPath, child);

    // (1) 경계 검사 — 확정 경로가 날짜 폴더 안이어야 한다.
    if (!isInside(folderPath, path.resolve(childPath))) {
      result.skipped.push(`${folderName}/${child}: outside the date folder`);
      continue;
    }

    // (2) 받는 중인 파일은 건드리지 않는다.
    if (isInProgressFile(child)) {
      result.skipped.push(`${folderName}/${child}: download in progress`);
      continue;
    }

    // (3) 우리가 만든 임시 파일도 건너뛴다 (다른 정리가 쓰는 중일 수 있다).
    if (child.startsWith(TEMP_PREFIX)) {
      result.skipped.push(`${folderName}/${child}: temporary file from a cleanup in progress`);
      continue;
    }

    // (4) lstat + 물리 경로 — 링크는 따라가지 않는다.
    const verified = verifyRegularFileInside(folderPath, childPath);
    if (!verified.ok) {
      result.skipped.push(`${folderName}/${child}: ${verified.reason}`);
      continue;
    }
    const size = verified.stat.size;

    if (dryRun) {
      result.files += 1;
      result.bytes += size;
      handled += 1;
      continue;
    }

    // (5) 바꾸기 직전 재확인 — 여기서 실패하면 아무것도 하지 않는다.
    const recheck = verifyRegularFileInside(folderPath, childPath);
    if (!recheck.ok) {
      result.skipped.push(`${folderName}/${child}: ${recheck.reason}`);
      continue;
    }

    if (mode === 'delete') {
      fs.unlinkSync(childPath);
    } else {
      if (archiveRoot === null) {
        // runArtifactCleanup 이 archive 모드에서 반드시 채운다.
        throw new Error('archive directory was not resolved');
      }
      if (destDir === null) {
        const monthDir = path.join(archiveRoot, folderName.slice(0, 7));
        fs.mkdirSync(monthDir, { recursive: true });
        destDir = createUniqueDir(monthDir, folderName);
      }
      const moved = moveFileToArchive(childPath, destDir, child);
      if (!moved.sourceRemoved) {
        result.skipped.push(
          `${folderName}/${child}: ${moved.keptReason ?? 'the original was left in place'}`,
        );
      }
    }

    result.files += 1;
    result.bytes += size;
    handled += 1;
  }

  // 비었으면 날짜 폴더 자체도 치운다. 뭔가 남았으면(건너뛴 항목) 그대로 둔다.
  if (!dryRun) {
    try {
      fs.rmdirSync(folderPath);
    } catch {
      // 비어 있지 않으면 남긴다 — 실패로 보지 않는다.
    }
  }

  return handled > 0;
};

/** doctor 가 나중에 읽을 수 있게 마지막 결과를 남긴다. 실패해도 무시한다. */
export const writeLastRunFile = (result: ArtifactCleanupResult): void => {
  try {
    const stateDir = getStateDir();
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, LAST_RUN_FILE_NAME),
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8',
    );
  } catch {
    // 기록은 편의 기능이다 — 실패해도 정리 결과는 유효하다.
  }
};

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const describeCleanupResult = (result: ArtifactCleanupResult): string => {
  if (result.mode === 'off') return '[artifacts] cleanup is off (artifactCleanup: "off")';
  const verb = result.dryRun
    ? 'would ' + (result.mode === 'delete' ? 'delete' : 'archive')
    : result.mode === 'delete'
      ? 'deleted'
      : 'archived';
  const where = result.mode === 'delete' ? '' : ` to ${result.archiveDir}`;
  const failures = result.errors.length > 0 ? `, ${result.errors.length} error(s)` : '';
  return (
    `[artifacts] ${verb} ${result.files} file(s) (${formatBytes(result.bytes)}) ` +
    `from ${result.folders.length} folder(s) older than ${result.retentionDays} day(s)${where}${failures}`
  );
};

/**
 * 네이티브 호스트가 listen 한 뒤 한 번 부른다. 비동기이고, 어떤 실패에서도 서버에 영향이 없다.
 */
export const startupArtifactCleanup = (): void => {
  // 테스트에서는 절대 돌지 않는다 — 진짜 다운로드 폴더를 만지는 코드다.
  if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined) return;

  const timer = setTimeout(() => {
    try {
      const loaded = loadBridgeConfig();
      for (const warning of loaded.warnings) console.error(`[artifacts] ${warning}`);
      const result = runArtifactCleanup({ config: loaded.config });
      if (result.mode !== 'off' && (result.files > 0 || result.errors.length > 0)) {
        console.error(describeCleanupResult(result));
      }
      writeLastRunFile(result);
    } catch (error) {
      console.error(
        `[artifacts] cleanup skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, 0) as unknown as { unref?: () => void };
  timer.unref?.();
};

export { defaultBridgeConfig };
