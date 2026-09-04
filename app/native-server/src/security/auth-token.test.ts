import { describe, expect, test, beforeEach, afterAll, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  STATE_DIR_ENV,
  currentAclIdentity,
  ensureAuthToken,
  evaluateIcaclsOutput,
  extractBearerToken,
  getStateDir,
  getTokenFilePath,
  inspectAndReadTokenFile,
  inspectTokenFile,
  isAllowedAclTrustee,
  isReusableTokenStat,
  isValidTokenFormat,
  lockDownFile,
  parseIcaclsAces,
  readAuthToken,
  reconcilePersistedToken,
  ROTATE_LOCK_FILE_NAME,
  __internals,
  tokensMatch,
} from './auth-token';

/** 권한 검사를 "느슨하다"로 강제한다 — 실제 ACL 조작은 환경에 따라 막히기 때문. */
const LOOSE = {
  ownerOnly: false as boolean | null,
  offenders: ['TEST\\Loose'],
  detail: 'test: loosened on purpose',
};

/**
 * 토큰 파일의 현재 내용이 `value` 일 때만 "느슨하다"고 답하는 권한 검사 mock.
 * 다른 내용·다른 경로는 진짜 판정을 그대로 쓴다.
 */
const mockLoosePermissionsFor = (value: string) => {
  const real = __internals.inspectPermissions;
  return jest.spyOn(__internals, 'inspectPermissions').mockImplementation((target: string) => {
    if (target === getTokenFilePath() && readAuthToken() === value) return { ...LOOSE };
    return real(target);
  });
};

/**
 * auto-chrome-mcp fork — 브리지 bearer 토큰 파일 회귀 테스트.
 *
 * 브리지는 listen 전에 무작위 토큰을 만들어 소유자만 읽을 수 있는 파일로 남기고,
 * 같은 패키지의 stdio 프록시가 그걸 읽어 Authorization 헤더로 보낸다.
 */
const tempRoots: string[] = [];

const freshStateDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-token-test-'));
  tempRoots.push(dir);
  process.env[STATE_DIR_ENV] = path.join(dir, '.auto-chrome-mcp');
  return process.env[STATE_DIR_ENV] as string;
};

const originalStateDir = process.env[STATE_DIR_ENV];

afterAll(() => {
  if (originalStateDir === undefined) delete process.env[STATE_DIR_ENV];
  else process.env[STATE_DIR_ENV] = originalStateDir;
  for (const dir of tempRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 정리 실패는 테스트 결과에 영향 없음 */
    }
  }
});

describe('security/auth-token', () => {
  beforeEach(() => {
    freshStateDir();
  });

  test('토큰 파일이 없으면 만들고, 두 번째 호출은 같은 토큰을 재사용한다', () => {
    expect(readAuthToken()).toBeNull();

    const first = ensureAuthToken();
    expect(first.created).toBe(true);
    expect(first.persisted).toBe(true);
    expect(isValidTokenFormat(first.token)).toBe(true);
    expect(fs.existsSync(getTokenFilePath())).toBe(true);
    expect(getTokenFilePath().startsWith(getStateDir())).toBe(true);

    const second = ensureAuthToken();
    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);
    expect(readAuthToken()).toBe(first.token);
  });

  test('내용이 깨진 토큰 파일은 새 토큰으로 대체된다', () => {
    fs.mkdirSync(getStateDir(), { recursive: true });
    fs.writeFileSync(getTokenFilePath(), 'not-a-token\n');
    expect(readAuthToken()).toBeNull();

    const result = ensureAuthToken();
    expect(isValidTokenFormat(result.token)).toBe(true);
    expect(readAuthToken()).toBe(result.token);
  });

  test('토큰 파일은 소유자 전용 권한으로 잠긴다', () => {
    const result = ensureAuthToken();
    expect(result.persisted).toBe(true);

    const inspection = inspectTokenFile();
    expect(inspection.exists).toBe(true);
    expect(inspection.valid).toBe(true);
    // 윈도우는 icacls, POSIX 는 mode 로 판정한다. 판정 불가(null)면 환경 제약이므로 통과.
    if (inspection.ownerOnly !== null) {
      expect(inspection.ownerOnly).toBe(true);
    }
  });

  test('inspectTokenFile 은 파일이 없을 때 그렇게 보고한다 (doctor 용)', () => {
    const inspection = inspectTokenFile();
    expect(inspection.exists).toBe(false);
    expect(inspection.valid).toBe(false);
    expect(inspection.path).toBe(getTokenFilePath());
  });

  // ============================================================
  // 생성 경합 · 권한 (독립 검증 지적 3)
  // ============================================================

  test('상태 디렉터리를 먼저 만들고 소유자 전용으로 잠근다', () => {
    const result = ensureAuthToken();
    expect(fs.existsSync(getStateDir())).toBe(true);
    expect(result.dirPermissions?.method).not.toBe('none');

    const inspection = inspectTokenFile();
    expect(inspection.stateDir).toBe(getStateDir());
    // 판정 불가(null)면 환경 제약이므로 통과시킨다.
    if (inspection.stateDirOwnerOnly !== null) {
      expect(inspection.stateDirOwnerOnly).toBe(true);
    }
  });

  test('원자 교체라 임시 파일이 남지 않는다', () => {
    ensureAuthToken();
    expect(fs.readdirSync(getStateDir())).toEqual(['auth-token']);
  });

  test('기존 파일 권한이 느슨했으면 재사용하지 않고 새 토큰으로 회전한다', () => {
    const first = ensureAuthToken();
    expect(first.created).toBe(true);

    // 파일을 일부러 느슨하게 만든다. 실패하면(환경 제약) 회전 단정은 건너뛴다.
    let loosened = false;
    if (process.platform !== 'win32') {
      fs.chmodSync(getTokenFilePath(), 0o644);
      loosened = inspectTokenFile().ownerOnly === false;
    } else {
      try {
        execFileSync('icacls', [getTokenFilePath(), '/grant', 'BUILTIN\\Users:(R)'], {
          stdio: 'pipe',
          windowsHide: true,
        });
        loosened = inspectTokenFile().ownerOnly === false;
      } catch {
        loosened = false;
      }
    }

    const second = ensureAuthToken();
    if (!loosened) {
      // 권한을 느슨하게 만들지 못한 환경이라 검사할 대상이 없다 (재사용이 맞다).
      expect(second.token).toBe(first.token);
      return;
    }
    // 느슨했던 동안 남이 이미 읽어 갔을 수 있다. 다시 잠가도 그 값은 못 믿는다.
    expect(second.rotated).toBe(true);
    expect(second.token).not.toBe(first.token);
    expect(isValidTokenFormat(second.token)).toBe(true);
    expect(readAuthToken()).toBe(second.token);
    const inspection = inspectTokenFile();
    if (inspection.ownerOnly !== null) {
      expect(inspection.ownerOnly).toBe(true);
    }
  });

  test('일반 파일이고 소유자 전용이면 그대로 재사용한다 (회전하지 않는다)', () => {
    const first = ensureAuthToken();
    const second = ensureAuthToken();
    expect(second.token).toBe(first.token);
    expect(second.rotated).toBeUndefined();
    expect(second.created).toBe(false);
  });

  test('토큰 파일이 symlink 면 재사용하지 않고 회전한다', () => {
    fs.mkdirSync(getStateDir(), { recursive: true });
    const decoy = path.join(getStateDir(), 'decoy-token');
    const planted = 'c'.repeat(64);
    fs.writeFileSync(decoy, `${planted}\n`);
    try {
      fs.symlinkSync(decoy, getTokenFilePath());
    } catch {
      // 윈도우는 개발자 모드·관리자 권한이 없으면 symlinkSync 가 EPERM 이다. 그 환경은 생략.
      return;
    }
    expect(readAuthToken()).toBe(planted);

    const result = ensureAuthToken();
    expect(result.rotated).toBe(true);
    expect(result.token).not.toBe(planted);
    expect(readAuthToken()).toBe(result.token);
    expect(fs.lstatSync(getTokenFilePath()).isSymbolicLink()).toBe(false);
    // 링크가 가리키던 파일은 우리가 건드리지 않는다 (남의 파일을 덮어쓰지 않는다).
    expect(fs.readFileSync(decoy, 'utf8').trim()).toBe(planted);
  });

  // 윈도우는 개발자 모드가 아니면 symlinkSync 가 EPERM 이라 위 검사가 통째로 생략된다.
  // 그래서 "어떤 모양이면 재사용해도 되는가" 판정은 순수 함수로 따로 못 박는다.
  test('isReusableTokenStat 은 일반 파일만 재사용 대상으로 본다', () => {
    const stat = (symlink: boolean, file: boolean) => ({
      isSymbolicLink: () => symlink,
      isFile: () => file,
    });
    expect(isReusableTokenStat(stat(false, true)).ok).toBe(true);
    expect(isReusableTokenStat(stat(true, false)).ok).toBe(false);
    // lstat 은 링크 자신을 보므로 isFile 이 참일 수 없지만, 순서상 링크가 먼저 걸린다.
    expect(isReusableTokenStat(stat(true, true)).ok).toBe(false);
    expect(isReusableTokenStat(stat(false, false)).ok).toBe(false);
    expect(isReusableTokenStat(stat(false, false)).reason.length).toBeGreaterThan(0);
  });

  // ============================================================
  // 동시 시작 경합 — publish 는 덮어쓰지 않는다 (Codex 2차 지적 2)
  // ============================================================

  test('두 브리지를 인터리브해도 둘 다 같은 토큰으로 끝난다 (split-brain 없음)', () => {
    // A 가 publish 하려는 순간 B 가 통째로 끼어들어 먼저 완주한다.
    const tokens: string[] = [];
    const spy = jest.spyOn(__internals, 'linkSync');
    spy.mockImplementationOnce((from, to) => {
      spy.mockRestore(); // B 는 정상 경로로 돈다
      tokens.push(ensureAuthToken().token); // B 완주 — 파일이 생긴다
      fs.linkSync(from, to); // A 의 link 는 이제 EEXIST 로 실패한다
    });

    try {
      const a = ensureAuthToken();
      tokens.push(a.token);

      expect(a.adopted).toBe(true);
      expect(a.created).toBe(false);
      // 진 쪽(A)의 메모리 토큰 = 이긴 쪽(B)의 토큰 = 디스크. 셋이 어긋나지 않는다.
      expect(tokens[0]).toBe(tokens[1]);
      expect(readAuthToken()).toBe(tokens[0]);
    } finally {
      spy.mockRestore();
    }
  });

  test('link 를 못 쓰는 환경에서도 기존 유효 토큰을 덮어쓰지 않는다', () => {
    const competitor = 'd'.repeat(64);
    const spy = jest.spyOn(__internals, 'linkSync').mockImplementation(() => {
      // 다른 브리지가 먼저 publish 를 끝냈고, 이 파일시스템은 link 를 못 만든다.
      fs.writeFileSync(getTokenFilePath(), `${competitor}\n`);
      lockDownFile(getTokenFilePath()); // 상대도 소유자 전용으로 잠근다 (채택 조건)
      const err: NodeJS.ErrnoException = new Error('operation not permitted');
      err.code = 'EPERM';
      throw err;
    });

    try {
      const result = ensureAuthToken();
      expect(result.token).toBe(competitor);
      expect(result.adopted).toBe(true);
      expect(readAuthToken()).toBe(competitor);
    } finally {
      spy.mockRestore();
    }
  });

  test('자리에 깨진 파일이 있어도 덮어쓰지 않고 지운 뒤 다시 건다 (remove-and-link)', () => {
    fs.mkdirSync(getStateDir(), { recursive: true });
    fs.writeFileSync(getTokenFilePath(), 'not-a-token\n');
    // 통과 호출만 세는 spy — 덮어쓰기 rename 이 남아 있으면 link 는 한 번만 불린다.
    const spy = jest.spyOn(__internals, 'linkSync');
    try {
      const result = ensureAuthToken();
      // 1회: EEXIST (깨진 파일). 지운 뒤 2회: 성공. 덮어쓰기 없이 자리를 잡는다.
      expect(spy).toHaveBeenCalledTimes(2);
      expect(isValidTokenFormat(result.token)).toBe(true);
      expect(readAuthToken()).toBe(result.token);
      expect(fs.lstatSync(getTokenFilePath()).isFile()).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test('깨진 파일을 치우는 사이 상대가 자리를 잡으면 그 토큰을 채택한다 (link 경로)', () => {
    fs.mkdirSync(getStateDir(), { recursive: true });
    fs.writeFileSync(getTokenFilePath(), 'not-a-token\n');
    const competitor = 'a'.repeat(64);
    let calls = 0;
    const spy = jest.spyOn(__internals, 'linkSync').mockImplementation((from, to) => {
      calls += 1;
      // 우리가 깨진 파일을 치운 뒤 두 번째로 걸기 직전, 상대가 유효한 토큰을 남긴다.
      if (calls === 2) {
        fs.writeFileSync(to, `${competitor}\n`);
        lockDownFile(to); // 상대도 소유자 전용으로 잠근다 (채택 조건)
      }
      fs.linkSync(from, to);
    });

    try {
      const result = ensureAuthToken();
      expect(calls).toBe(2);
      expect(result.token).toBe(competitor);
      expect(result.adopted).toBe(true);
      expect(readAuthToken()).toBe(competitor);
    } finally {
      spy.mockRestore();
    }
  });

  test('링크 미지원 환경도 rename 없이 배타 생성으로 자리를 잡는다 (wx 경로)', () => {
    fs.mkdirSync(getStateDir(), { recursive: true });
    fs.writeFileSync(getTokenFilePath(), 'not-a-token\n');
    const linkSpy = jest.spyOn(__internals, 'linkSync').mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error('operation not permitted');
      err.code = 'EPERM';
      throw err;
    });
    const openSpy = jest.spyOn(__internals, 'openExclusiveSync');

    try {
      const result = ensureAuthToken();
      // 1회: EEXIST (깨진 파일). 지운 뒤 2회: 성공. rename 으로 덮어쓰지 않는다.
      expect(openSpy).toHaveBeenCalledTimes(2);
      expect(isValidTokenFormat(result.token)).toBe(true);
      expect(readAuthToken()).toBe(result.token);
    } finally {
      openSpy.mockRestore();
      linkSpy.mockRestore();
    }
  });

  test('링크 미지원 환경에서 상대가 먼저 자리를 잡으면 그 토큰을 채택한다 (wx 경로)', () => {
    fs.mkdirSync(getStateDir(), { recursive: true });
    fs.writeFileSync(getTokenFilePath(), 'not-a-token\n');
    const competitor = 'b'.repeat(64);
    const linkSpy = jest.spyOn(__internals, 'linkSync').mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error('cross-device link');
      err.code = 'EXDEV';
      throw err;
    });
    let opens = 0;
    const openSpy = jest.spyOn(__internals, 'openExclusiveSync').mockImplementation((target) => {
      opens += 1;
      // 우리가 wx 로 열기 직전에 상대가 유효한 토큰을 남긴다.
      if (opens === 1) {
        fs.writeFileSync(target, `${competitor}\n`);
        lockDownFile(target); // 상대도 소유자 전용으로 잠근다 (채택 조건)
      }
      return fs.openSync(target, 'wx', 0o600);
    });

    try {
      const result = ensureAuthToken();
      expect(opens).toBe(1);
      expect(result.token).toBe(competitor);
      expect(result.adopted).toBe(true);
      expect(readAuthToken()).toBe(competitor);
    } finally {
      openSpy.mockRestore();
      linkSpy.mockRestore();
    }
  });

  // ============================================================
  // 동시 회전 · 채택 조건 (Codex 최종 검토 지적 1·2)
  //
  // 회전은 자리에 있는 파일을 지우고(displace) 새 토큰을 건다. 두 프로세스가 같은
  // 못 믿을 파일을 동시에 회전하면, 늦은 쪽의 unlink 가 먼저 publish 된 새 토큰을
  // 지워 버린다(A unlink/link/return -> B unlink(A)/link/return). 그래서 회전은
  // 배타 락 안에서만 하고, 락을 잡은 뒤 다시 판정한다.
  //
  // 채택(adopt)은 남이 만든 파일을 그대로 믿는 연산이라 권한 검사가 반드시 앞에 와야
  // 하고, 읽기는 lstat 로 "일반 파일"을 확인한 뒤에만 한다(FIFO 는 read 가 멈춘다).
  // ============================================================

  test('동시 회전이 인터리브돼도 두 프로세스와 파일이 같은 토큰으로 끝난다', () => {
    fs.mkdirSync(getStateDir(), { recursive: true });
    const stale = '9'.repeat(64);
    fs.writeFileSync(getTokenFilePath(), `${stale}\n`);
    lockDownFile(getTokenFilePath());

    // 자리에 있는 게 아직 stale 이면 "느슨하다" = 둘 다 회전 대상이다.
    const permSpy = mockLoosePermissionsFor(stale);

    // B 가 회전을 결심한 직후(새 토큰을 만드는 순간) A 가 통째로 끼어들어 회전을 끝낸다.
    const realMint = __internals.mintToken;
    let interleaved = false;
    let aToken: string | null = null;
    const mintSpy = jest.spyOn(__internals, 'mintToken').mockImplementation(() => {
      if (!interleaved) {
        interleaved = true;
        aToken = ensureAuthToken().token; // A: 회전 완주 (파일에 A 토큰이 올라간다)
      }
      return realMint();
    });

    try {
      const b = ensureAuthToken();
      expect(aToken).not.toBeNull();
      expect(isValidTokenFormat(aToken as unknown as string)).toBe(true);
      expect(aToken).not.toBe(stale);
      // B 는 A 가 올린 토큰을 지우지 않고 채택한다. 셋(A 메모리·B 메모리·파일)이 같다.
      expect(b.token).toBe(aToken);
      expect(readAuthToken()).toBe(aToken);
      expect(b.adopted).toBe(true);
      // 락 파일은 회전이 끝나면 남지 않는다.
      expect(fs.readdirSync(getStateDir())).toEqual(['auth-token']);
    } finally {
      mintSpy.mockRestore();
      permSpy.mockRestore();
    }
  });

  test('EEXIST 로 만난 상대 파일이 소유자 전용이 아니면 채택하지 않는다', () => {
    fs.mkdirSync(getStateDir(), { recursive: true });
    fs.writeFileSync(getTokenFilePath(), 'not-a-token\n'); // 깨진 파일 -> 생성 경로
    const loose = 'a'.repeat(64);
    const permSpy = mockLoosePermissionsFor(loose);

    let calls = 0;
    const linkSpy = jest.spyOn(__internals, 'linkSync').mockImplementation((from, to) => {
      calls += 1;
      // 깨진 파일을 치운 뒤 다시 걸기 직전, 상대가 "느슨한" 파일을 남긴다.
      if (calls === 2) fs.writeFileSync(to, `${loose}\n`);
      fs.linkSync(from, to);
    });

    try {
      const result = ensureAuthToken();
      // 느슨한 파일은 채택하지 않고 치운 뒤 우리 것을 건다 (3회차에 성공).
      expect(calls).toBe(3);
      expect(result.token).not.toBe(loose);
      expect(result.adopted).toBeUndefined();
      expect(isValidTokenFormat(result.token)).toBe(true);
      expect(readAuthToken()).toBe(result.token);
    } finally {
      linkSpy.mockRestore();
      permSpy.mockRestore();
    }
  });

  test('토큰 자리에 일반 파일이 아닌 게 있으면 읽지 않고 거부하고 회전한다', () => {
    fs.mkdirSync(getStateDir(), { recursive: true });
    // FIFO 는 윈도우에 없다. "일반 파일이 아니다"를 디렉터리로 대신 만든다.
    // (FIFO 였다면 lstat 없이 read 한 쪽이 그대로 멈춘다.)
    fs.mkdirSync(getTokenFilePath());
    const readSpy = jest.spyOn(__internals, 'readTokenFile');

    try {
      const result = ensureAuthToken();
      expect(result.rotated).toBe(true);
      expect(isValidTokenFormat(result.token)).toBe(true);
      // lstat 이 먼저라 read 는 한 번도 나가지 않는다.
      const reads = readSpy.mock.calls.filter((call) => call[0] === getTokenFilePath());
      expect(reads).toEqual([]);
    } finally {
      readSpy.mockRestore();
    }
  });

  test('상대가 회전 락을 쥐고 있으면 기다렸다가 그 토큰을 채택한다', () => {
    fs.mkdirSync(getStateDir(), { recursive: true });
    const stale = '7'.repeat(64);
    fs.writeFileSync(
      getTokenFilePath(),
      `${stale}
`,
    );
    lockDownFile(getTokenFilePath());
    const lockPath = path.join(getStateDir(), ROTATE_LOCK_FILE_NAME);
    fs.writeFileSync(lockPath, ''); // 상대가 방금 회전을 시작했다 (막 잡은 락)

    const peer = '8'.repeat(64);
    const real = __internals.inspectPermissions;
    let looks = 0;
    const permSpy = jest
      .spyOn(__internals, 'inspectPermissions')
      .mockImplementation((target: string) => {
        if (target !== getTokenFilePath()) return real(target);
        looks += 1;
        if (looks < 3) return { ...LOOSE };
        // 세 번째로 볼 때, 상대가 회전을 끝내 새 토큰을 올린 상태가 된다.
        fs.writeFileSync(
          target,
          `${peer}
`,
        );
        lockDownFile(target);
        return real(target);
      });

    try {
      const result = ensureAuthToken();
      expect(result.token).toBe(peer);
      expect(result.adopted).toBe(true);
      expect(readAuthToken()).toBe(peer);
      // 남의 락은 풀지 않는다.
      expect(fs.existsSync(lockPath)).toBe(true);
    } finally {
      permSpy.mockRestore();
    }
  });

  test('주인이 죽어 남은 회전 락은 회수하고 회전한다', () => {
    fs.mkdirSync(getStateDir(), { recursive: true });
    const stale = '6'.repeat(64);
    fs.writeFileSync(
      getTokenFilePath(),
      `${stale}
`,
    );
    lockDownFile(getTokenFilePath());
    const lockPath = path.join(getStateDir(), ROTATE_LOCK_FILE_NAME);
    fs.writeFileSync(lockPath, '');
    const longAgo = new Date(Date.now() - 120_000);
    fs.utimesSync(lockPath, longAgo, longAgo); // 주인이 죽고 남은 락

    const permSpy = mockLoosePermissionsFor(stale);
    try {
      const result = ensureAuthToken();
      expect(result.rotated).toBe(true);
      expect(result.token).not.toBe(stale);
      expect(isValidTokenFormat(result.token)).toBe(true);
      expect(readAuthToken()).toBe(result.token);
      // 회수한 락은 우리가 쓰고 지운다.
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(fs.readdirSync(getStateDir())).toEqual(['auth-token']);
    } finally {
      permSpy.mockRestore();
    }
  });

  test('inspectAndReadTokenFile 은 검사를 통과한 값만 채택 대상으로 준다', () => {
    fs.mkdirSync(getStateDir(), { recursive: true });
    expect(inspectAndReadTokenFile(getTokenFilePath()).present).toBe(false);

    const value = '5'.repeat(64);
    fs.writeFileSync(
      getTokenFilePath(),
      `${value}
`,
    );
    lockDownFile(getTokenFilePath());
    const ok = inspectAndReadTokenFile(getTokenFilePath());
    expect(ok.token).toBe(value);
    expect(ok.regularFile).toBe(true);
    expect(ok.ownerOnly).toBe(true);

    // 권한이 느슨하면 채택 대상이 아니다. 값은 회전 거부 목록용으로만 남는다.
    const permSpy = mockLoosePermissionsFor(value);
    try {
      const loose = inspectAndReadTokenFile(getTokenFilePath());
      expect(loose.token).toBeNull();
      expect(loose.raw).toBe(value);
      expect(loose.ownerOnly).toBe(false);
    } finally {
      permSpy.mockRestore();
    }
  });

  test('reconcilePersistedToken 은 디스크 값을 우선한다', () => {
    fs.mkdirSync(getStateDir(), { recursive: true });
    const onDisk = 'e'.repeat(64);
    fs.writeFileSync(getTokenFilePath(), `${onDisk}\n`);
    lockDownFile(getTokenFilePath()); // 채택 조건 — 소유자 전용이어야 읽어 쓴다
    expect(reconcilePersistedToken('f'.repeat(64))).toEqual({ token: onDisk, adopted: true });
    expect(reconcilePersistedToken(onDisk)).toEqual({ token: onDisk, adopted: false });
  });

  test('파일을 못 써도 throw 하지 않고 메모리 토큰으로 계속 뜬다', () => {
    // 상태 디렉터리 위치에 파일을 놓아 mkdir 를 실패시킨다.
    const blockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-token-block-'));
    tempRoots.push(blockRoot);
    const blocker = path.join(blockRoot, 'blocked');
    fs.writeFileSync(blocker, 'not a directory');
    process.env[STATE_DIR_ENV] = blocker;

    const result = ensureAuthToken();
    expect(isValidTokenFormat(result.token)).toBe(true);
    expect(result.persisted).toBe(false);
    expect(result.insecure).toBe(true);
    expect(typeof result.error).toBe('string');
  });

  test('tokensMatch 는 길이가 달라도 안전하게 false 를 낸다', () => {
    const token = 'a'.repeat(64);
    expect(tokensMatch(token, token)).toBe(true);
    expect(tokensMatch(token, 'b'.repeat(64))).toBe(false);
    expect(tokensMatch(token, token.slice(0, 32))).toBe(false);
    expect(tokensMatch(token, '')).toBe(false);
    expect(tokensMatch(undefined, token)).toBe(false);
    expect(tokensMatch(null, null)).toBe(false);
  });

  // ============================================================
  // 윈도우 ACL 판정 (Codex 2차 지적 1)
  //
  // 예전에는 영문 광역 그룹 4개의 "이름"만 찾았다. 그래서 `MACHINE\OtherUser:(R)` 같은
  // 명시 ACE 나 현지화된 그룹명이 남아 있어도 소유자 전용이라고 답했고, icacls 조회가
  // 실패해도(판정 불가) 안전하다고 봤다. 이제는 모든 ACE 를 파싱해 허용 목록
  // (현재 사용자 + SYSTEM) 밖이 하나라도 있으면 위반이고, 판정 불가도 위반이다.
  // ============================================================

  const ME = { names: ['MACHINE\\user', 'user'], sids: ['S-1-5-21-1-2-3-1001'] };

  test('parseIcaclsAces 는 첫 줄의 대상 경로를 떼고 신원만 뽑는다', () => {
    const output = [
      'C:\\Users\\me\\.auto-chrome-mcp\\auth-token MACHINE\\user:(F)',
      '                                           NT AUTHORITY\\SYSTEM:(I)(F)',
      '',
      '1개의 파일을 처리했습니다. 0개의 파일을 처리하지 못했습니다.',
      '',
    ].join('\n');

    expect(parseIcaclsAces(output, 'C:\\Users\\me\\.auto-chrome-mcp\\auth-token')).toEqual([
      'MACHINE\\user',
      'NT AUTHORITY\\SYSTEM',
    ]);
  });

  test('parseIcaclsAces 는 경로에 공백이 있어도 신원을 잘라먹지 않는다', () => {
    const target = 'C:\\Program Files\\acm\\auth-token';
    const output = `${target} MACHINE\\user:(F)\n\n1 file processed\n`;
    expect(parseIcaclsAces(output, target)).toEqual(['MACHINE\\user']);
  });

  test('parseIcaclsAces 는 ACE 가 하나도 없으면 null 이다 (판정 불가)', () => {
    expect(parseIcaclsAces('', 'C:\\x')).toBeNull();
    expect(parseIcaclsAces('1개의 파일을 처리했습니다.', 'C:\\x')).toBeNull();
  });

  test('현재 사용자만 남은 ACL 은 소유자 전용이다', () => {
    const target = 'C:\\x\\auth-token';
    const result = evaluateIcaclsOutput(`${target} MACHINE\\user:(F)\n`, target, ME);
    expect(result.ownerOnly).toBe(true);
    expect(result.offenders).toEqual([]);
  });

  test('SYSTEM 은 허용한다 (OS 자신이라 DACL 과 무관하게 읽는다)', () => {
    const target = 'C:\\x\\auth-token';
    const output = `${target} MACHINE\\user:(F)\n      NT AUTHORITY\\SYSTEM:(I)(F)\n`;
    expect(evaluateIcaclsOutput(output, target, ME).ownerOnly).toBe(true);
    expect(isAllowedAclTrustee('S-1-5-18', ME)).toBe(true);
  });

  test('영문 광역 그룹은 위반으로 잡힌다', () => {
    const target = 'C:\\x\\auth-token';
    const output = `${target} MACHINE\\user:(F)\n      BUILTIN\\Users:(RX)\n      Everyone:(R)\n`;
    const result = evaluateIcaclsOutput(output, target, ME);
    expect(result.ownerOnly).toBe(false);
    expect(result.offenders).toEqual(['BUILTIN\\Users', 'Everyone']);
  });

  test('현지화된 그룹명도 위반으로 잡힌다 (이름 목록에 없어도)', () => {
    const target = 'C:\\x\\auth-token';
    // 한국어·독일어 윈도우에서 나올 수 있는 표기. 예전 블록리스트는 이 둘을 다 놓쳤다.
    const output = [
      `${target} MACHINE\\user:(F)`,
      '      BUILTIN\\Administrators:(F)',
      '      NT-AUTORITÄT\\Authentifizierte Benutzer:(M)',
      '',
    ].join('\n');
    const result = evaluateIcaclsOutput(output, target, ME);
    expect(result.ownerOnly).toBe(false);
    expect(result.offenders).toContain('NT-AUTORITÄT\\Authentifizierte Benutzer');
  });

  test('명시적으로 추가된 다른 사용자 ACE 가 위반으로 잡힌다 (예전에 통과하던 표본)', () => {
    const target = 'C:\\x\\auth-token';
    const output = `${target} MACHINE\\user:(F)\n      MACHINE\\OtherUser:(R)\n`;
    const result = evaluateIcaclsOutput(output, target, ME);
    expect(result.ownerOnly).toBe(false);
    expect(result.offenders).toEqual(['MACHINE\\OtherUser']);
  });

  test('이름을 못 푼 원시 SID 는 현재 사용자 SID 일 때만 통과한다', () => {
    const target = 'C:\\x\\auth-token';
    expect(evaluateIcaclsOutput(`${target} S-1-5-21-1-2-3-1001:(F)\n`, target, ME).ownerOnly).toBe(
      true,
    );
    expect(evaluateIcaclsOutput(`${target} S-1-5-21-9-9-9-1005:(F)\n`, target, ME).ownerOnly).toBe(
      false,
    );
  });

  test('출력을 못 읽으면 판정 불가(null)다 — 안전하다고 답하지 않는다', () => {
    const result = evaluateIcaclsOutput('', 'C:\\x\\auth-token', ME);
    expect(result.ownerOnly).toBeNull();
  });

  test('실제 icacls 로 남의 ACE 를 심으면 토큰을 회전한다', () => {
    if (process.platform !== 'win32') return;
    const first = ensureAuthToken();
    expect(first.persisted).toBe(true);

    // S-1-5-4 = NT AUTHORITY\INTERACTIVE. 이 머신에 대화형으로 로그인한 누구나 읽는다.
    // 예전 블록리스트(광역 그룹 4개 이름)에는 없어서 그대로 통과하던 값이다.
    try {
      execFileSync('icacls', [getTokenFilePath(), '/grant', '*S-1-5-4:(R)'], {
        stdio: 'pipe',
        windowsHide: true,
      });
    } catch {
      return; // 환경 제약으로 심지 못하면 이 검사는 생략
    }
    expect(inspectTokenFile().ownerOnly).toBe(false);

    const second = ensureAuthToken();
    expect(second.rotated).toBe(true);
    expect(second.token).not.toBe(first.token);
    expect(readAuthToken()).toBe(second.token);
    expect(inspectTokenFile().ownerOnly).toBe(true);
  });

  test('currentAclIdentity 는 최소한 사용자 이름 하나를 담는다', () => {
    const identity = currentAclIdentity();
    expect(Array.isArray(identity.names)).toBe(true);
    expect(Array.isArray(identity.sids)).toBe(true);
  });

  test('extractBearerToken 은 Bearer 스킴만 받아들인다', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
    expect(extractBearerToken('bearer abc123')).toBe('abc123');
    expect(extractBearerToken('  Bearer   abc123  ')).toBe('abc123');
    expect(extractBearerToken('Basic abc123')).toBeNull();
    expect(extractBearerToken('abc123')).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
  });
});
