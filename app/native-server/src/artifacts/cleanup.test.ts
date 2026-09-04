/**
 * 산출물 자동 정리 회귀.
 *
 * 이 코드는 사용자의 **다운로드 폴더** 를 건드린다. 조용히 틀리면 파일이 사라지므로
 * 경계를 하나하나 못 박는다: 무엇을 옮기고(정확히 7일), 무엇을 절대 건드리지 않는지
 * (날짜 폴더 밖, 하위 폴더, 심볼릭 링크), 설정이 없거나 깨졌을 때 어떻게 되는지.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  ARTIFACT_ROOT_DIR,
  DOWNLOADS_DIR_ENV,
  LAST_RUN_FILE_NAME,
  isExpiredFolderName,
  linkIntoPlace,
  parseDateFolderName,
  resolveDownloadsDir,
  runArtifactCleanup,
  startupArtifactCleanup,
  writeLastRunFile,
} from './cleanup';
import { BridgeConfig, defaultBridgeConfig, loadBridgeConfig } from './config';

const NOW = new Date(2026, 8, 5, 12, 0, 0); // 2026-09-05 12:00 로컬

/**
 * `import * as fs` 는 읽기 전용 래퍼라 그 위에는 spy 를 걸 수 없다(Cannot redefine
 * property). 실제 모듈 객체를 잡아 그 위에 건다 — cleanup.ts 의 fs 도 같은 객체를 읽는다.
 */
const nodeFs = jest.requireActual<typeof fs>('fs');

let root: string;
let downloadsDir: string;
let artifactDir: string;
let archiveDir: string;
let stateDir: string;

const envBackup: Record<string, string | undefined> = {};

const setEnv = (key: string, value: string | undefined): void => {
  if (!(key in envBackup)) envBackup[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

const makeConfig = (overrides: Partial<BridgeConfig> = {}): BridgeConfig => ({
  artifactArchiveDir: archiveDir,
  artifactRetentionDays: 7,
  artifactCleanup: 'archive',
  ...overrides,
});

/** 날짜 폴더와 그 안의 파일을 만든다. */
const makeDateFolder = (name: string, files: Record<string, string> = { 'a.png': 'x' }): string => {
  const dir = path.join(artifactDir, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, file), content, 'utf8');
  }
  return dir;
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-artifacts-'));
  downloadsDir = path.join(root, 'Downloads');
  artifactDir = path.join(downloadsDir, ARTIFACT_ROOT_DIR);
  archiveDir = path.join(root, 'archive');
  stateDir = path.join(root, 'state');
  fs.mkdirSync(artifactDir, { recursive: true });
  // 정리 잠금(artifacts.lock)은 상태 디렉터리에 만들어진다. 테스트가 사용자의 진짜
  // 홈 디렉터리를 건드리지 않도록 언제나 임시 폴더로 돌린다.
  setEnv('AUTO_CHROME_MCP_HOME', stateDir);
});

afterEach(() => {
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(envBackup)) delete envBackup[key];
  fs.rmSync(root, { recursive: true, force: true });
});

describe('날짜 폴더 판정', () => {
  it('날짜 형식만 인정하고 존재하지 않는 날짜는 거른다', () => {
    expect(parseDateFolderName('2026-09-05')).toBeInstanceOf(Date);
    expect(parseDateFolderName('2026-9-5')).toBeNull();
    expect(parseDateFolderName('2026-02-31')).toBeNull();
    expect(parseDateFolderName('mcp-screenshots')).toBeNull();
    expect(parseDateFolderName('2026-09-05-backup')).toBeNull();
  });

  it('보관 기간 경계는 "정확히 7일이면 대상"이다', () => {
    expect(isExpiredFolderName('2026-08-29', 7, NOW)).toBe(true); // 7일 전
    expect(isExpiredFolderName('2026-08-30', 7, NOW)).toBe(false); // 6일 전
    expect(isExpiredFolderName('2026-09-05', 7, NOW)).toBe(false); // 오늘
    expect(isExpiredFolderName('2026-09-06', 7, NOW)).toBe(false); // 미래(시계 차이)
    // retention 0 이라도 오늘 폴더는 대상이 아니다 - 지금 받는 중인 파일이 들어 있다.
    expect(isExpiredFolderName('2026-09-05', 0, NOW)).toBe(false);
  });
});

describe('archive 모드', () => {
  it('오래된 폴더만 보관 폴더의 YYYY-MM 아래로 옮긴다', () => {
    makeDateFolder('2026-08-20', { 'screenshot_a_101010.png': 'aaaa' });
    makeDateFolder('2026-08-29', { 'gif_demo_101010.gif': 'bb' });
    makeDateFolder('2026-09-01', { 'pdf_notice_101010.pdf': 'keep me' });

    const result = runArtifactCleanup({ config: makeConfig(), downloadsDir, now: NOW });

    expect(result.mode).toBe('archive');
    expect(result.folders.sort()).toEqual(['2026-08-20', '2026-08-29']);
    expect(result.files).toBe(2);
    expect(result.bytes).toBe(6);
    expect(result.errors).toEqual([]);

    expect(
      fs.existsSync(path.join(archiveDir, '2026-08', '2026-08-20', 'screenshot_a_101010.png')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(archiveDir, '2026-08', '2026-08-29', 'gif_demo_101010.gif')),
    ).toBe(true);

    // 옮긴 폴더는 사라지고, 보관 기간 안의 폴더는 그대로다.
    expect(fs.existsSync(path.join(artifactDir, '2026-08-20'))).toBe(false);
    expect(fs.existsSync(path.join(artifactDir, '2026-08-29'))).toBe(false);
    expect(fs.existsSync(path.join(artifactDir, '2026-09-01', 'pdf_notice_101010.pdf'))).toBe(true);
  });

  it('보관 폴더에 같은 이름이 있으면 접미사를 붙인다', () => {
    makeDateFolder('2026-08-20', { 'shot.png': 'new' });
    const existing = path.join(archiveDir, '2026-08', '2026-08-20');
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, 'shot.png'), 'old', 'utf8');

    runArtifactCleanup({ config: makeConfig(), downloadsDir, now: NOW });

    expect(fs.readFileSync(path.join(existing, 'shot.png'), 'utf8')).toBe('old');
    expect(
      fs.readFileSync(path.join(archiveDir, '2026-08', '2026-08-20-2', 'shot.png'), 'utf8'),
    ).toBe('new');
  });

  it('날짜 폴더가 아닌 것과 루트의 파일은 건드리지 않는다', () => {
    fs.writeFileSync(path.join(artifactDir, 'notes.txt'), 'keep', 'utf8');
    fs.mkdirSync(path.join(artifactDir, 'manual-backup'), { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'manual-backup', 'x.png'), 'keep', 'utf8');
    // 다운로드 폴더 루트의 파일도 대상 밖이다.
    fs.writeFileSync(path.join(downloadsDir, 'screenshot_root.png'), 'keep', 'utf8');

    const result = runArtifactCleanup({ config: makeConfig(), downloadsDir, now: NOW });

    expect(result.files).toBe(0);
    expect(fs.existsSync(path.join(artifactDir, 'notes.txt'))).toBe(true);
    expect(fs.existsSync(path.join(artifactDir, 'manual-backup', 'x.png'))).toBe(true);
    expect(fs.existsSync(path.join(downloadsDir, 'screenshot_root.png'))).toBe(true);
  });

  it('날짜 폴더 안의 하위 폴더는 옮기지 않고 남긴다', () => {
    const dir = makeDateFolder('2026-08-20', { 'shot.png': 'x' });
    fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'nested', 'inner.png'), 'inner', 'utf8');

    const result = runArtifactCleanup({ config: makeConfig(), downloadsDir, now: NOW });

    expect(result.files).toBe(1);
    expect(result.skipped.join(' ')).toContain('not a regular file');
    // 하위 폴더가 남아 있으므로 날짜 폴더도 지워지지 않는다.
    expect(fs.existsSync(path.join(dir, 'nested', 'inner.png'))).toBe(true);
  });

  it('보관 폴더를 만들 수 없어도 던지지 않고 오류로 보고한다', () => {
    makeDateFolder('2026-08-20');
    // 파일을 보관 폴더 경로에 두면 mkdir 이 실패한다.
    fs.writeFileSync(archiveDir, 'not a directory', 'utf8');

    const result = runArtifactCleanup({ config: makeConfig(), downloadsDir, now: NOW });

    expect(result.errors.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(artifactDir, '2026-08-20', 'a.png'))).toBe(true);
  });
});

describe('delete / off / dry-run', () => {
  it('delete 는 파일을 지우고 보관 폴더를 만들지 않는다', () => {
    makeDateFolder('2026-08-20', { 'a.png': 'aaa' });

    const result = runArtifactCleanup({
      config: makeConfig({ artifactCleanup: 'delete' }),
      downloadsDir,
      now: NOW,
    });

    expect(result.mode).toBe('delete');
    expect(result.files).toBe(1);
    expect(fs.existsSync(path.join(artifactDir, '2026-08-20'))).toBe(false);
    expect(fs.existsSync(archiveDir)).toBe(false);
  });

  it('off 는 아무것도 하지 않는다', () => {
    makeDateFolder('2026-08-20');

    const result = runArtifactCleanup({
      config: makeConfig({ artifactCleanup: 'off' }),
      downloadsDir,
      now: NOW,
    });

    expect(result.mode).toBe('off');
    expect(result.files).toBe(0);
    expect(result.folders).toEqual([]);
    expect(fs.existsSync(path.join(artifactDir, '2026-08-20', 'a.png'))).toBe(true);
  });

  it('dry-run 은 세기만 하고 옮기지 않는다', () => {
    makeDateFolder('2026-08-20', { 'a.png': 'aaa', 'b.png': 'bb' });

    const result = runArtifactCleanup({
      config: makeConfig(),
      downloadsDir,
      now: NOW,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.files).toBe(2);
    expect(result.bytes).toBe(5);
    expect(fs.existsSync(path.join(artifactDir, '2026-08-20', 'a.png'))).toBe(true);
    expect(fs.existsSync(archiveDir)).toBe(false);
  });

  it('산출물 폴더가 아직 없으면 조용히 끝난다', () => {
    fs.rmSync(artifactDir, { recursive: true, force: true });

    const result = runArtifactCleanup({ config: makeConfig(), downloadsDir, now: NOW });

    expect(result.files).toBe(0);
    expect(result.errors).toEqual([]);
  });
});

describe('심볼릭 링크', () => {
  // 윈도우는 개발자 모드·관리자 권한이 없으면 심볼릭 링크를 만들 수 없다. 그때는 건너뛴다.
  const canSymlink = ((): boolean => {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-symlink-probe-'));
    try {
      const target = path.join(probe, 'target.txt');
      fs.writeFileSync(target, 'x', 'utf8');
      fs.symlinkSync(target, path.join(probe, 'link.txt'));
      return true;
    } catch {
      return false;
    } finally {
      fs.rmSync(probe, { recursive: true, force: true });
    }
  })();

  const maybeIt = canSymlink ? it : it.skip;

  maybeIt('링크는 옮기지 않고 건너뛴다 (링크를 따라가면 폴더 밖 원본을 옮기게 된다)', () => {
    const outside = path.join(root, 'precious.png');
    fs.writeFileSync(outside, 'do not touch', 'utf8');
    const dir = makeDateFolder('2026-08-20', { 'real.png': 'ok' });
    fs.symlinkSync(outside, path.join(dir, 'link.png'));

    const result = runArtifactCleanup({ config: makeConfig(), downloadsDir, now: NOW });

    expect(result.files).toBe(1);
    expect(result.skipped.join(' ')).toContain('symlink');
    expect(fs.readFileSync(outside, 'utf8')).toBe('do not touch');
    expect(fs.existsSync(path.join(archiveDir, '2026-08', '2026-08-20', 'link.png'))).toBe(false);
  });

  if (!canSymlink) {
    it('심볼릭 링크 회귀는 이 환경에서 건너뛴다 (링크 생성 권한 없음)', () => {
      expect(canSymlink).toBe(false);
    });
  }
});

describe('설정 파일', () => {
  it('파일이 없으면 기본값을 쓴다', () => {
    const loaded = loadBridgeConfig(path.join(root, 'missing.json'));
    expect(loaded.fromFile).toBe(false);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.config).toEqual(defaultBridgeConfig());
    expect(loaded.config.artifactCleanup).toBe('archive');
    expect(loaded.config.artifactRetentionDays).toBe(7);
  });

  it('JSON 이 깨졌으면 경고와 함께 기본값을 쓴다', () => {
    const file = path.join(root, 'broken.json');
    fs.writeFileSync(file, '{ this is not json', 'utf8');

    const loaded = loadBridgeConfig(file);

    expect(loaded.config).toEqual(defaultBridgeConfig());
    expect(loaded.warnings.join(' ')).toContain('not valid JSON');
  });

  it('알아볼 수 있는 키만 반영하고 나머지는 경고한다', () => {
    const file = path.join(root, 'config.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        artifactArchiveDir: archiveDir,
        artifactRetentionDays: -3,
        artifactCleanup: 'burn',
        unknownKey: 1,
      }),
      'utf8',
    );

    const loaded = loadBridgeConfig(file);

    expect(loaded.config.artifactArchiveDir).toBe(path.resolve(archiveDir));
    expect(loaded.config.artifactRetentionDays).toBe(7); // 잘못된 값은 기본값
    expect(loaded.config.artifactCleanup).toBe('archive');
    expect(loaded.warnings).toHaveLength(2);
  });

  it('물결(~) 경로를 홈 디렉터리로 편다', () => {
    const file = path.join(root, 'tilde.json');
    fs.writeFileSync(file, JSON.stringify({ artifactArchiveDir: '~/keep-here' }), 'utf8');

    const loaded = loadBridgeConfig(file);

    expect(loaded.config.artifactArchiveDir).toBe(path.join(os.homedir(), 'keep-here'));
  });

  it('배열이나 스칼라는 객체가 아니라고 보고 기본값을 쓴다', () => {
    const file = path.join(root, 'array.json');
    fs.writeFileSync(file, '[1,2,3]', 'utf8');

    const loaded = loadBridgeConfig(file);

    expect(loaded.config).toEqual(defaultBridgeConfig());
    expect(loaded.warnings.join(' ')).toContain('JSON object');
  });
});

describe('다운로드 폴더 위치와 마지막 실행 기록', () => {
  it('환경 변수 지정이 최우선이다', () => {
    setEnv(DOWNLOADS_DIR_ENV, downloadsDir);
    expect(resolveDownloadsDir()).toBe(path.resolve(downloadsDir));
  });

  it('지정이 없으면 홈 아래 Downloads 를 쓴다 (윈도우는 레지스트리 우선)', () => {
    setEnv(DOWNLOADS_DIR_ENV, undefined);
    const resolved = resolveDownloadsDir();
    expect(path.isAbsolute(resolved)).toBe(true);
    if (process.platform !== 'win32') {
      expect(resolved).toBe(path.join(os.homedir(), 'Downloads'));
    } else {
      expect(resolved.toLowerCase()).toContain('downloads');
    }
  });

  it('마지막 실행 결과를 상태 디렉터리에 남긴다', () => {
    setEnv('AUTO_CHROME_MCP_HOME', stateDir);
    const result = runArtifactCleanup({ config: makeConfig(), downloadsDir, now: NOW });

    writeLastRunFile(result);

    const written = JSON.parse(
      fs.readFileSync(path.join(stateDir, LAST_RUN_FILE_NAME), 'utf8'),
    ) as Record<string, unknown>;
    expect(written.mode).toBe('archive');
    expect(written.retentionDays).toBe(7);
    expect(written.ranAt).toBe(NOW.toISOString());
  });

  it('시작 훅은 테스트 환경에서 아무것도 하지 않는다', () => {
    setEnv('AUTO_CHROME_MCP_HOME', stateDir);
    makeDateFolder('2026-08-20');

    startupArtifactCleanup();

    expect(fs.existsSync(path.join(stateDir, LAST_RUN_FILE_NAME))).toBe(false);
    expect(fs.existsSync(path.join(artifactDir, '2026-08-20', 'a.png'))).toBe(true);
  });
});

/**
 * Codex 리뷰 2번 — junction/reparse point 로 정리 경계를 벗어나는 문제.
 * `isInside()` 가 문자열 비교뿐이라, `mcp-screenshots` 자체가 바깥을 가리키는 junction 이면
 * readdir 이 바깥 폴더를 읽고 바깥 파일을 옮기거나 지웠다.
 */
describe('정리 경계 (junction / reparse point)', () => {
  // 윈도우에서 junction 은 관리자 권한 없이 만들 수 있다. 그래도 안 되는 환경이면 건너뛴다.
  const canJunction = ((): boolean => {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-junction-probe-'));
    try {
      const target = path.join(probe, 'target');
      fs.mkdirSync(target);
      fs.symlinkSync(target, path.join(probe, 'link'), 'junction');
      return true;
    } catch {
      return false;
    } finally {
      fs.rmSync(probe, { recursive: true, force: true });
    }
  })();

  const maybeIt = canJunction ? it : it.skip;

  maybeIt('산출물 루트가 바깥을 가리키는 junction 이면 통째로 건너뛴다', () => {
    fs.rmSync(artifactDir, { recursive: true, force: true });
    const outside = path.join(root, 'outside-root');
    fs.mkdirSync(path.join(outside, '2026-08-20'), { recursive: true });
    fs.writeFileSync(path.join(outside, '2026-08-20', 'precious.png'), 'do not touch', 'utf8');
    fs.symlinkSync(outside, artifactDir, 'junction');

    const result = runArtifactCleanup({ config: makeConfig(), downloadsDir, now: NOW });

    expect(result.files).toBe(0);
    expect(result.folders).toEqual([]);
    expect([...result.skipped, ...result.errors].join(' ')).toMatch(/link|junction|reparse/i);
    expect(fs.readFileSync(path.join(outside, '2026-08-20', 'precious.png'), 'utf8')).toBe(
      'do not touch',
    );
  });

  maybeIt('날짜 폴더가 junction 이면 그 폴더만 건너뛰고 나머지는 정리한다', () => {
    const outside = path.join(root, 'outside-folder');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'precious.png'), 'do not touch', 'utf8');
    fs.symlinkSync(outside, path.join(artifactDir, '2026-08-20'), 'junction');
    makeDateFolder('2026-08-21', { 'real.png': 'ok' });

    const result = runArtifactCleanup({ config: makeConfig(), downloadsDir, now: NOW });

    expect(result.folders).toEqual(['2026-08-21']);
    expect(result.files).toBe(1);
    expect(fs.readFileSync(path.join(outside, 'precious.png'), 'utf8')).toBe('do not touch');
  });

  if (!canJunction) {
    it('junction 회귀는 이 환경에서 건너뛴다 (junction 생성 권한 없음)', () => {
      expect(canJunction).toBe(false);
    });
  }
});

/**
 * Codex 리뷰 3번 — retention 0 이면 오늘 폴더까지 만료로 봐서, 지금 받는 중인 파일을
 * 정리했다. 최소 1일로 올리고 오늘 폴더와 진행 중 파일은 언제나 제외한다.
 */
describe('보관 기간 하한과 진행 중 파일', () => {
  it('retention 0 은 1 로 올리고 오늘 폴더는 건드리지 않는다', () => {
    makeDateFolder('2026-09-05', { 'today.png': 'x' });
    makeDateFolder('2026-09-04', { 'yesterday.png': 'y' });

    const result = runArtifactCleanup({
      config: makeConfig({ artifactRetentionDays: 0 }),
      downloadsDir,
      now: NOW,
    });

    expect(result.retentionDays).toBe(1);
    expect(result.folders).toEqual(['2026-09-04']);
    expect(fs.existsSync(path.join(artifactDir, '2026-09-05', 'today.png'))).toBe(true);
  });

  it('설정의 retention 0 은 경고와 함께 1 이 된다', () => {
    const file = path.join(root, 'retention-zero.json');
    fs.writeFileSync(file, JSON.stringify({ artifactRetentionDays: 0 }), 'utf8');

    const loaded = loadBridgeConfig(file);

    expect(loaded.config.artifactRetentionDays).toBe(1);
    expect(loaded.warnings.join(' ')).toContain('artifactRetentionDays');
  });

  it('진행 중인 다운로드는 옮기지 않는다 (.crdownload · .part · .tmp)', () => {
    makeDateFolder('2026-08-20', {
      'done.png': 'ok',
      'half.png.crdownload': 'downloading',
      'other.part': 'downloading',
      'trace.tmp': 'downloading',
    });

    const result = runArtifactCleanup({ config: makeConfig(), downloadsDir, now: NOW });

    expect(result.files).toBe(1);
    expect(result.skipped.join(' ')).toMatch(/in progress|in-progress/i);
    expect(fs.existsSync(path.join(artifactDir, '2026-08-20', 'half.png.crdownload'))).toBe(true);
    expect(fs.existsSync(path.join(artifactDir, '2026-08-20', 'other.part'))).toBe(true);
    expect(fs.existsSync(path.join(artifactDir, '2026-08-20', 'trace.tmp'))).toBe(true);
  });
});

/**
 * Codex 리뷰 4번 — 두 브리지가 동시에 시작하면 같은 목적지를 골라 서로 덮어썼고,
 * EXDEV 폴백은 최종 파일에 바로 복사한 뒤 fsync 없이 원본을 지웠다.
 */
describe('동시 실행 잠금과 이동', () => {
  const lockPath = (): string => path.join(stateDir, 'artifacts.lock');

  it('다른 정리가 잠금을 쥐고 있으면 아무것도 옮기지 않는다', () => {
    setEnv('AUTO_CHROME_MCP_HOME', stateDir);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      lockPath(),
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
      'utf8',
    );
    makeDateFolder('2026-08-20');

    const result = runArtifactCleanup({ config: makeConfig(), downloadsDir, now: NOW });

    expect(result.files).toBe(0);
    expect(result.skipped.join(' ')).toContain('lock');
    expect(fs.existsSync(path.join(artifactDir, '2026-08-20', 'a.png'))).toBe(true);
  });

  it('10분이 지난 잠금은 회수하고 정리한 뒤 잠금을 푼다', () => {
    setEnv('AUTO_CHROME_MCP_HOME', stateDir);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: 999999, at: '2000-01-01' }), 'utf8');
    const old = new Date(Date.now() - 11 * 60 * 1000);
    fs.utimesSync(lockPath(), old, old);
    makeDateFolder('2026-08-20', { 'a.png': 'x' });

    const result = runArtifactCleanup({ config: makeConfig(), downloadsDir, now: NOW });

    expect(result.files).toBe(1);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it('dry-run 은 잠금 파일을 만들지 않는다 (읽기 전용)', () => {
    setEnv('AUTO_CHROME_MCP_HOME', stateDir);
    makeDateFolder('2026-08-20');

    runArtifactCleanup({ config: makeConfig(), downloadsDir, now: NOW, dryRun: true });

    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it('이동은 임시 파일을 남기지 않고 내용을 그대로 옮긴다', () => {
    setEnv('AUTO_CHROME_MCP_HOME', stateDir);
    makeDateFolder('2026-08-20', { 'a.png': 'hello world' });

    const result = runArtifactCleanup({ config: makeConfig(), downloadsDir, now: NOW });

    expect(result.errors).toEqual([]);
    const moved = path.join(archiveDir, '2026-08', '2026-08-20', 'a.png');
    expect(fs.readFileSync(moved, 'utf8')).toBe('hello world');
    const leftovers = fs
      .readdirSync(path.join(archiveDir, '2026-08', '2026-08-20'))
      .filter((name) => name.startsWith('.'));
    expect(leftovers).toEqual([]);
    expect(fs.existsSync(path.join(artifactDir, '2026-08-20'))).toBe(false);
  });
});

/**
 * Codex 리뷰 7번 — archiveDir 이 상대 경로면 CWD 에 따라 위치가 달라지고, 보관 폴더가
 * 산출물 폴더 안이면 옮긴 파일이 다시 정리 대상 트리에 남는다.
 */
describe('보관 폴더 위치 검증', () => {
  it('상대 경로 archiveDir 은 경고와 함께 기본값으로 되돌린다', () => {
    const file = path.join(root, 'relative.json');
    fs.writeFileSync(file, JSON.stringify({ artifactArchiveDir: 'relative/archive' }), 'utf8');

    const loaded = loadBridgeConfig(file);

    expect(loaded.config.artifactArchiveDir).toBe(defaultBridgeConfig().artifactArchiveDir);
    expect(loaded.warnings.join(' ')).toContain('absolute');
  });

  it('보관 폴더가 산출물 폴더 안이면 옮기지 않고 오류로 보고한다', () => {
    makeDateFolder('2026-08-20');

    const result = runArtifactCleanup({
      config: makeConfig({ artifactArchiveDir: path.join(artifactDir, 'archive') }),
      downloadsDir,
      now: NOW,
    });

    expect(result.files).toBe(0);
    expect(result.errors.join(' ')).toMatch(/archive/i);
    expect(fs.existsSync(path.join(artifactDir, '2026-08-20', 'a.png'))).toBe(true);
  });

  it('보관 폴더가 산출물 폴더와 같으면 거부한다', () => {
    makeDateFolder('2026-08-20');

    const result = runArtifactCleanup({
      config: makeConfig({ artifactArchiveDir: artifactDir }),
      downloadsDir,
      now: NOW,
    });

    expect(result.files).toBe(0);
    expect(result.errors.join(' ')).toMatch(/archive/i);
    expect(fs.existsSync(path.join(artifactDir, '2026-08-20', 'a.png'))).toBe(true);
  });

  it('산출물 폴더가 보관 폴더 안이면 거부한다', () => {
    makeDateFolder('2026-08-20');

    const result = runArtifactCleanup({
      config: makeConfig({ artifactArchiveDir: downloadsDir }),
      downloadsDir,
      now: NOW,
    });

    expect(result.files).toBe(0);
    expect(result.errors.join(' ')).toMatch(/archive/i);
    expect(fs.existsSync(path.join(artifactDir, '2026-08-20', 'a.png'))).toBe(true);
  });
});

/**
 * Codex 재확인 1번 — 복사·fsync 가 끝나는 사이에 크롬이 같은 이름으로 새 산출물을 쓰면,
 * 지우는 대상은 우리가 보관한 그 파일이 아니라 방금 만들어진 새 파일이었다.
 */
describe('원본 재검증 후 삭제', () => {
  it('복사 도중 원본이 바뀌면 보관본은 두고 원본은 남긴다', () => {
    makeDateFolder('2026-08-20', { 'a.png': 'old capture' });

    // 복사가 끝난 직후 다른 프로세스가 같은 이름으로 새 파일을 쓴 상황.
    const spy = jest.spyOn(nodeFs, 'copyFileSync').mockImplementation((src, dest, mode) => {
      spy.mockRestore();
      fs.copyFileSync(src as string, dest as string, mode as number);
      fs.writeFileSync(src as string, 'brand new capture', 'utf8');
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(src as string, later, later);
    });

    let result;
    try {
      result = runArtifactCleanup({ config: makeConfig(), downloadsDir, now: NOW });
    } finally {
      spy.mockRestore();
    }

    const original = path.join(artifactDir, '2026-08-20', 'a.png');
    expect(fs.existsSync(original)).toBe(true);
    expect(fs.readFileSync(original, 'utf8')).toBe('brand new capture');

    const archived = path.join(archiveDir, '2026-08', '2026-08-20', 'a.png');
    expect(fs.readFileSync(archived, 'utf8')).toBe('old capture');

    expect(result.errors).toEqual([]);
    expect(result.skipped.join(' ')).toMatch(/changed while it was being archived/);
  });

  it('원본이 그대로면 평소처럼 지운다', () => {
    makeDateFolder('2026-08-20', { 'a.png': 'stable' });

    const result = runArtifactCleanup({ config: makeConfig(), downloadsDir, now: NOW });

    expect(result.files).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(fs.existsSync(path.join(artifactDir, '2026-08-20'))).toBe(false);
    expect(fs.readFileSync(path.join(archiveDir, '2026-08', '2026-08-20', 'a.png'), 'utf8')).toBe(
      'stable',
    );
  });
});

/**
 * Codex 재확인 2번 — 잠금 파일 이름은 고정이라 unlink 만으로는 "내 잠금" 을 구분할 수
 * 없었다. 내 잠금이 이미 회수된 뒤라면 그 사이 남이 만든 새 잠금을 지웠다.
 */
describe('잠금 소유권', () => {
  const lockPath = (): string => path.join(stateDir, 'artifacts.lock');

  it('잠금 파일에 소유자 토큰을 적고, 남의 잠금은 풀지 않는다', () => {
    makeDateFolder('2026-08-20', { 'a.png': 'x' });

    let tokenWhileHeld: unknown = null;
    // 정리가 도는 도중에 내 잠금이 회수되고 남이 새 잠금을 잡은 상황을 만든다.
    const spy = jest.spyOn(nodeFs, 'copyFileSync').mockImplementation((src, dest, mode) => {
      spy.mockRestore();
      tokenWhileHeld = (JSON.parse(fs.readFileSync(lockPath(), 'utf8')) as { token?: unknown })
        .token;
      fs.writeFileSync(
        lockPath(),
        JSON.stringify({ pid: 4242, token: 'someone-elses-token', at: new Date().toISOString() }),
        'utf8',
      );
      fs.copyFileSync(src as string, dest as string, mode as number);
    });

    try {
      runArtifactCleanup({ config: makeConfig(), downloadsDir, now: NOW });
    } finally {
      spy.mockRestore();
    }

    expect(typeof tokenWhileHeld).toBe('string');
    expect(String(tokenWhileHeld)).toContain(String(process.pid));
    // 남의 잠금이 그대로 남아 있어야 한다.
    expect(fs.existsSync(lockPath())).toBe(true);
    expect((JSON.parse(fs.readFileSync(lockPath(), 'utf8')) as { token?: unknown }).token).toBe(
      'someone-elses-token',
    );
  });

  it('죽은 잠금은 rename 으로 먼저 가져온 뒤 지운다 (바로 unlink 하지 않는다)', () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: 999999, at: '2000-01-01' }), 'utf8');
    const old = new Date(Date.now() - 11 * 60 * 1000);
    fs.utimesSync(lockPath(), old, old);
    makeDateFolder('2026-08-20', { 'a.png': 'x' });

    const renames: string[] = [];
    const realRename = fs.renameSync;
    const renameSpy = jest.spyOn(nodeFs, 'renameSync').mockImplementation((from, to) => {
      renames.push(String(from));
      realRename(from as string, to as string);
    });

    let result;
    try {
      result = runArtifactCleanup({ config: makeConfig(), downloadsDir, now: NOW });
    } finally {
      renameSpy.mockRestore();
    }

    expect(result.files).toBe(1);
    expect(renames).toContain(lockPath());
    expect(fs.existsSync(lockPath())).toBe(false);
  });
});

/**
 * Codex 재확인 3번 — 하드 링크를 못 만드는 파일 시스템에서 `existsSync` 로 보고 없으면
 * `renameSync` 했다. rename 은 POSIX 에서 기존 파일을 조용히 덮어쓰므로, 확인과 rename
 * 사이에 다른 정리가 같은 이름을 만들면 그 파일이 사라졌다.
 */
describe('하드 링크 폴백', () => {
  const eperm = (): never => {
    throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  };

  it('폴백은 rename 을 쓰지 않고 내용을 그대로 옮긴다', () => {
    makeDateFolder('2026-08-20', { 'a.png': 'hello fallback' });

    const renames: string[] = [];
    const realRename = nodeFs.renameSync;
    const linkSpy = jest.spyOn(nodeFs, 'linkSync').mockImplementation(eperm);
    // mockRestore 는 호출 기록도 지운다. 기록은 따로 모은다.
    const renameSpy = jest.spyOn(nodeFs, 'renameSync').mockImplementation((from, to) => {
      renames.push(String(from));
      realRename(from as string, to as string);
    });

    let result;
    try {
      result = runArtifactCleanup({ config: makeConfig(), downloadsDir, now: NOW });
    } finally {
      linkSpy.mockRestore();
      renameSpy.mockRestore();
    }

    expect(result.errors).toEqual([]);
    expect(result.files).toBe(1);
    expect(renames).toEqual([]);

    const destDir = path.join(archiveDir, '2026-08', '2026-08-20');
    expect(fs.readFileSync(path.join(destDir, 'a.png'), 'utf8')).toBe('hello fallback');
    expect(fs.readdirSync(destDir).filter((name) => name.startsWith('.'))).toEqual([]);
    expect(fs.existsSync(path.join(artifactDir, '2026-08-20'))).toBe(false);
  });

  it('폴백은 이미 있는 이름을 덮지 않고 접미사를 올린다', () => {
    const dir = path.join(root, 'dest');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.png'), 'do not overwrite', 'utf8');
    const temp = path.join(dir, '.acm-tmp-probe');
    fs.writeFileSync(temp, 'moved content', 'utf8');

    const placed = linkIntoPlace(temp, dir, 'a.png', eperm);

    expect(placed.finalPath).toBe(path.join(dir, 'a-2.png'));
    expect(placed.tempConsumed).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'a.png'), 'utf8')).toBe('do not overwrite');
    expect(fs.readFileSync(path.join(dir, 'a-2.png'), 'utf8')).toBe('moved content');
    expect(fs.existsSync(temp)).toBe(true);
  });

  it('폴백이 큰 파일도 전부 옮긴다 (버퍼 경계)', () => {
    const dir = path.join(root, 'dest-big');
    fs.mkdirSync(dir, { recursive: true });
    const payload = 'x'.repeat(64 * 1024 * 2 + 17);
    const temp = path.join(dir, '.acm-tmp-big');
    fs.writeFileSync(temp, payload, 'utf8');

    const placed = linkIntoPlace(temp, dir, 'big.png', eperm);

    expect(fs.readFileSync(placed.finalPath, 'utf8')).toBe(payload);
  });
});
