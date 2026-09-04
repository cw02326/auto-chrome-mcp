/**
 * Bridge auth token — localhost HTTP 브리지의 유일한 신원 증명.
 *
 * 왜 필요한가:
 *   브리지는 127.0.0.1 의 고정 포트에서 듣는다. CORS 는 "응답을 읽을 수 있는지"만
 *   통제하고 "요청이 실행되는지"는 통제하지 못한다. 그래서 아무 웹페이지나
 *   `fetch('http://127.0.0.1:12320/admin/kill-self', { method: 'POST' })` 한 방으로
 *   남의 브리지를 죽이거나 `/mcp` 로 새 MCP 세션을 열 수 있었다.
 *
 * 어떻게 막는가:
 *   네이티브 호스트가 listen 하기 전에 무작위 토큰을 만들어
 *   `~/.auto-chrome-mcp/auth-token` 에 (소유자만 읽기) 저장한다. 같은 패키지의 stdio
 *   프록시가 그 파일을 읽어 `Authorization: Bearer <token>` 으로 보내고, 확장은
 *   네이티브 메시지(SERVER_STARTED)로 같은 토큰을 받아 붙인다. 서버는 보호 대상 경로에서
 *   상수 시간 비교로 검증한다.
 *
 * 파일 위치·관례는 기존 CDP 포트 파일(`~/.auto-chrome-mcp/cdp-port`)과 같은 곳을 쓴다.
 *
 * 생성 규칙 (동시에 여러 브리지가 떠도 안전해야 한다):
 *   1. 상태 디렉터리를 먼저 만들고 소유자 전용으로 잠근다 (윈도우는 icacls 로 상속 제거).
 *      디렉터리부터 잠가야 파일을 만드는 순간 이미 남이 못 보는 상태다.
 *   2. 토큰은 같은 디렉터리의 임시 파일(무작위 이름 + `wx`)에 쓰고 잠근 뒤 link 로 최종
 *      경로에 건다. 반쯤 쓰인 파일이 최종 경로에 노출되지 않고, link 는 대상이 있으면
 *      EEXIST 로 실패하므로 남의 토큰을 덮어쓰지 않는다.
 *   3. 경합에서 지면(EEXIST) 기존 파일을 읽어 그대로 채택한다. 자리에 있는 게 쓸모없는
 *      파일(형식이 깨짐)이면 지운 뒤 다시 건다. 존재하는 유효 파일을 덮어쓰는 연산은
 *      어느 경로에도 없다. link 를 못 만드는 파일시스템에서는 최종 경로를 `wx` 로 직접
 *      열어 같은 방식으로 자리를 잡는다(대상이 있으면 EEXIST).
 *   4. 기존 파일은 (a) 일반 파일이고 (b) 잠그기 전 검사에서 이미 소유자 전용일 때만
 *      재사용한다. 그 밖(권한 위반·판정 불가·심볼릭 링크·비일반 파일)은 다시 잠그는 것으로
 *      끝내지 않는다. 느슨했던 동안 남이 이미 읽어 갔을 수 있어서 그 값은 못 믿는다.
 *      새 토큰을 만들어 원자적으로 갈아끼우고(회전) stderr 에 남긴다. stdio 프록시는
 *      연결할 때마다 파일을 다시 읽으므로 다음 연결에서 새 토큰을 쓴다.
 *   5. 회전은 자리를 비우는 연산이라 3번의 EEXIST 보호가 통하지 않는다. 그래서 상태
 *      디렉터리의 `auth-token.rotate.lock` 을 `wx` 로 잡은 뒤에만 하고, 락을 잡고 나서
 *      한 번 더 판정한다. 그 사이 다른 브리지가 이미 갈아끼웠으면 회전하지 않고 채택한다.
 *      락을 못 잡으면 잠깐 기다렸다가 상대가 만든 파일을 (같은 검사를 거쳐) 채택한다.
 *   6. 파일을 믿을지 판정하는 통로는 `inspectAndReadTokenFile` 하나뿐이다. lstat 으로
 *      일반 파일임을 확인하고 권한을 본 뒤에만 읽는다. 순서가 뒤집히면 남이 심어 둔
 *      FIFO 하나로 브리지 시작이 멈추고, 권한 검사를 건너뛴 채택 경로가 구멍이 된다.
 *   7. 잠금이 실패해도 브리지는 계속 뜬다 (가용성 우선). 대신 stderr 로 경고하고
 *      doctor 가 같은 사실을 보고한다.
 *
 * 주의: 이 모듈은 Native Messaging host 프로세스 안에서도 돌아간다.
 *       stdout 은 NM 프로토콜 전용이므로 로그는 반드시 stderr(console.error).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';

/** 상태 디렉터리 override (테스트·격리 실행용). 미설정이면 ~/.auto-chrome-mcp */
export const STATE_DIR_ENV = 'AUTO_CHROME_MCP_HOME';
export const TOKEN_FILE_NAME = 'auth-token';
/** 32 bytes = hex 64 자. */
export const TOKEN_BYTE_LENGTH = 32;

const TOKEN_FORMAT = /^[0-9a-f]{64}$/;

export const getStateDir = (): string =>
  process.env[STATE_DIR_ENV] || path.join(os.homedir(), '.auto-chrome-mcp');

export const getTokenFilePath = (): string => path.join(getStateDir(), TOKEN_FILE_NAME);

export const isValidTokenFormat = (value: unknown): value is string =>
  typeof value === 'string' && TOKEN_FORMAT.test(value.trim());

/** 토큰 파일 내용을 실제로 읽는 유일한 지점. 못 읽으면 null (throw 하지 않는다). */
const readTokenFileRaw = (target: string): string | null => {
  try {
    return fs.readFileSync(target, 'utf8');
  } catch {
    return null;
  }
};

/**
 * 토큰 파일 읽기. 없거나 형식이 깨졌으면 null (throw 하지 않는다).
 * 실제 read 는 __internals.readTokenFile 한 곳으로만 나간다 (검사 순서 회귀 테스트용).
 */
const readTokenAt = (target: string): string | null => {
  const raw = __internals.readTokenFile(target);
  if (raw === null) return null;
  const trimmed = raw.trim();
  return isValidTokenFormat(trimmed) ? trimmed : null;
};

export const readAuthToken = (): string | null => readTokenAt(getTokenFilePath());

export interface PermissionLockResult {
  ok: boolean;
  method: 'chmod' | 'icacls' | 'none';
  error?: string;
}

const isExistingDirectory = (target: string): boolean => {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
};

/**
 * 넓은 신원의 SID — 이름은 OS 언어에 따라 달라지므로 SID 로 지운다.
 * Users / Everyone / Authenticated Users / Administrators.
 *
 * `/inheritance:r` 는 "상속된" ACE 만 없앤다. 누군가 명시적으로 추가한 ACE
 * (`icacls file /grant "BUILTIN\Users:(R)"`) 는 그대로 남기 때문에, 재잠금이
 * 실제로 효과를 내려면 이 SID 들을 함께 제거해야 한다. 여기 없는 신원은
 * icaclsLockDown 의 2단계가 ACL 을 다시 읽어 하나씩 지운다.
 */
const BROAD_SIDS = ['*S-1-5-32-545', '*S-1-1-0', '*S-1-5-11', '*S-1-5-32-544'];

/**
 * SYSTEM (S-1-5-18) 만 예외로 허용한다.
 *
 * 근거: SYSTEM 은 운영체제 자신이다. 백업·복원 특권(SeBackupPrivilege / SeRestorePrivilege)과
 * 소유권 탈취 특권을 이미 갖고 있어 DACL 과 무관하게 어떤 파일이든 읽는다. 그래서 SYSTEM ACE 가
 * 남아 있다고 노출이 늘지 않는다. 반대로 이걸 위반으로 치면 윈도우가 SYSTEM ACE 를 되돌려 놓는
 * 환경에서 매 시작마다 헛된 재잠금과 경고만 반복된다. 이름은 로캘마다 다르므로 SID 형태와
 * 잘 알려진 이름 형태만 인정한다.
 */
const SYSTEM_SID = 'S-1-5-18';
const SYSTEM_NAME_PATTERN =
  /^(?:NT[ -]?AUTHORITY|NT[ -]?AUTORIT\S*|AUTORITE NT|AUTORIDAD NT)\\SYSTEM$/i;

/** ACL 판정에 쓰는 "우리" 신원. 이름은 로캘·표기 차이가 있어 SID 도 같이 본다. */
export interface AclIdentity {
  names: readonly string[];
  sids: readonly string[];
}

/** icacls 인자 형식 — 이름은 그대로, 원시 SID 는 `*` 접두어가 필요하다. */
const toIcaclsTrustee = (trustee: string): string => {
  const value = trustee.trim();
  return /^S-1-[\d-]+$/i.test(value) ? `*${value}` : value;
};

/** icacls `/grant:r` 에 넣어 볼 신원 후보 (첫 성공을 채택). */
const grantIdentityCandidates = (): string[] => {
  const user = process.env.USERNAME;
  const domain = process.env.USERDOMAIN;
  return [domain && user ? `${domain}\\${user}` : null, user || null, '%USERNAME%'].filter(
    (v): v is string => Boolean(v),
  );
};

/** 현재 사용자의 SID. icacls 가 이름을 못 풀어 원시 SID 로 출력할 때 필요하다. */
let cachedUserSid: string | null | undefined;
const currentUserSid = (): string | null => {
  if (cachedUserSid !== undefined) return cachedUserSid;
  cachedUserSid = null;
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }).toString();
      const matched = /S-1-[0-9-]+/.exec(out);
      if (matched) cachedUserSid = matched[0];
    } catch {
      /* SID 를 못 구하면 이름으로만 판정한다 (판정이 느슨해지지는 않는다). */
    }
  }
  return cachedUserSid;
};

/** ACL 판정 기준이 되는 현재 사용자 신원. */
export const currentAclIdentity = (): AclIdentity => {
  const user = process.env.USERNAME;
  const domain = process.env.USERDOMAIN;
  const sid = currentUserSid();
  return {
    names: [domain && user ? `${domain}\\${user}` : null, user || null].filter((v): v is string =>
      Boolean(v),
    ),
    sids: sid ? [sid] : [],
  };
};

/**
 * icacls 로 상속을 끊고 현재 사용자만 남긴다. 두 단계로 나눈다.
 *
 * ① 상속 제거 + 광역 SID 제거 + 현재 사용자에게만 grant. 광역 SID 는 well-known 이라
 *    어느 머신에서나 해석되므로 한 명령에 묶어도 안전하다.
 * ② `/inheritance:r` 은 상속된 ACE 만 없앤다. 누군가 명시적으로 넣은 ACE
 *    (`icacls file /grant "MACHINE\Other:(R)"`) 는 살아남으므로, ① 뒤에 다시 읽어
 *    남은 위반 신원을 하나씩 지운다.
 *
 * ②를 한 명령에 몰지 않는 이유: icacls 는 인자 중 하나라도 이름을 못 풀면(예: 삭제된
 * 계정의 원시 SID) 그 명령 전체를 적용하지 않고 실패한다. 그러면 잠금이 통째로 날아간다.
 * 실측으로 확인한 동작이라 신원마다 따로 실행하고, 실패한 신원만 경고로 남긴다.
 */
const icaclsLockDown = (target: string, grantFlags: string): PermissionLockResult => {
  const baseRemoveArgs = BROAD_SIDS.flatMap((sid) => ['/remove:g', sid, '/remove:d', sid]);

  let lastError = 'no candidate identity';
  let locked = false;
  for (const identity of grantIdentityCandidates()) {
    try {
      execFileSync(
        'icacls',
        [target, '/inheritance:r', ...baseRemoveArgs, '/grant:r', `${identity}:${grantFlags}`],
        { stdio: 'pipe', windowsHide: true },
      );
      locked = true;
      break;
    } catch (e: any) {
      lastError = (e?.stderr?.toString?.() || e?.message || String(e)).trim();
    }
  }
  if (!locked) {
    return { ok: false, method: 'icacls', error: lastError };
  }

  const remaining = inspectWindowsAcl(target).offenders;
  const failed: string[] = [];
  for (const trustee of remaining) {
    const spec = toIcaclsTrustee(trustee);
    try {
      execFileSync('icacls', [target, '/remove:g', spec, '/remove:d', spec], {
        stdio: 'pipe',
        windowsHide: true,
      });
    } catch {
      failed.push(trustee);
    }
  }
  if (failed.length > 0) {
    return {
      ok: false,
      method: 'icacls',
      error: `could not remove explicit ACE for: ${failed.join(', ')}`,
    };
  }
  return { ok: true, method: 'icacls' };
};

/**
 * 파일을 소유자 전용으로 잠근다.
 *
 * 윈도우에서는 chmod 가 무력하다 (NTFS ACL 을 안 건드리고, Git Bash 는 C 드라이브를
 * noacl 로 마운트해 mode 가 늘 644 로 보인다). 그래서 icacls 로 상속을 끊고
 * 현재 사용자만 남긴다.
 */
export const lockDownFile = (filePath: string): PermissionLockResult => {
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(filePath, 0o600);
      return { ok: true, method: 'chmod' };
    } catch (e: any) {
      return { ok: false, method: 'chmod', error: e?.message || String(e) };
    }
  }
  return icaclsLockDown(filePath, 'F');
};

/**
 * 디렉터리를 소유자 전용으로 잠근다.
 * (OI)(CI) — 이 안에 새로 만들어지는 파일·폴더도 같은 권한을 물려받는다.
 */
export const lockDownDir = (dirPath: string): PermissionLockResult => {
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(dirPath, 0o700);
      return { ok: true, method: 'chmod' };
    } catch (e: any) {
      return { ok: false, method: 'chmod', error: e?.message || String(e) };
    }
  }
  return icaclsLockDown(dirPath, '(OI)(CI)F');
};

export interface EnsureStateDirResult {
  dir: string;
  ok: boolean;
  permissions: PermissionLockResult;
  /** 잠근 뒤 다시 본 권한. true = 소유자 전용, false = 위반 신원 남음, null = 판정 불가. */
  ownerOnly: boolean | null;
  error?: string;
}

/**
 * icacls 출력에서 ACE 의 신원(trustee)만 뽑는다. 순수 함수라 표본으로 검증한다.
 *
 * 출력 형태 (첫 줄에만 대상 경로가 붙고, 이어지는 줄은 들여쓴 ACE 다):
 *
 *   C:\path\auth-token MACHINE\user:(F)
 *                      NT AUTHORITY\SYSTEM:(I)(F)
 *
 *   1개의 파일을 처리했습니다...   <- 요약 줄. `:(권한)` 꼬리가 없어 걸러진다.
 *
 * 신원에도 공백이 있으므로(`NT AUTHORITY\SYSTEM`) 마지막 공백으로 자르지 않는다. 첫 줄에서
 * 대상 경로를 떼어내지 못하면 신원에 경로가 섞인 채 남고, 그 값은 허용 목록에 없으므로
 * 위반으로 잡힌다 (모르면 안전한 쪽으로 판정한다).
 *
 * @returns ACE 신원 목록. 하나도 못 읽으면 null (= 판정 불가).
 */
const ACE_TAIL = /:((?:\([A-Za-z_,]{1,20}\))+)\s*$/;

const normalizeAclPath = (value: string): string => value.replace(/\//g, '\\').toUpperCase();

export const parseIcaclsAces = (output: string, target?: string): string[] | null => {
  const targetPath = typeof target === 'string' ? target : '';
  const normalizedTarget = targetPath ? normalizeAclPath(targetPath) : '';
  const base = targetPath ? targetPath.split(/[\\/]/).pop() || '' : '';
  const trustees: string[] = [];
  let firstAce = true;

  for (const line of String(output || '')
    .replace(/\r/g, '')
    .split('\n')) {
    if (!line.trim()) continue;
    const matched = ACE_TAIL.exec(line);
    if (!matched) continue;

    let head = line.slice(0, matched.index);
    if (firstAce) {
      if (normalizedTarget && normalizeAclPath(head).startsWith(normalizedTarget)) {
        head = head.slice(targetPath.length);
      } else if (base) {
        const at = normalizeAclPath(head).indexOf(`${normalizeAclPath(base)} `);
        if (at >= 0) head = head.slice(at + base.length);
      }
      firstAce = false;
    }

    const trustee = head.trim();
    if (trustee) trustees.push(trustee);
  }

  return trustees.length > 0 ? trustees : null;
};

/** 이 신원이 파일을 갖고 있어도 되는가. 허용 목록 방식 — 모르는 이름은 전부 위반이다. */
export const isAllowedAclTrustee = (trustee: string, identity: AclIdentity): boolean => {
  const value = String(trustee || '').trim();
  if (!value) return false;
  const upper = value.toUpperCase();
  if (upper === SYSTEM_SID) return true;
  if (SYSTEM_NAME_PATTERN.test(value)) return true;
  if (identity.sids.some((sid) => sid.trim().toUpperCase() === upper)) return true;
  return identity.names.some((name) => name.trim().toUpperCase() === upper);
};

export interface AclEvaluation {
  /** true = 허용 신원만 남음, false = 위반 신원 있음, null = 판정 불가. */
  ownerOnly: boolean | null;
  /** 허용 목록 밖의 신원. 재잠금 때 그대로 제거 대상이 된다. */
  offenders: string[];
  detail: string;
}

/** icacls 출력 한 덩어리를 판정한다. 순수 함수라 표본으로 검증한다. */
export const evaluateIcaclsOutput = (
  output: string,
  target: string,
  identity: AclIdentity,
): AclEvaluation => {
  const trustees = parseIcaclsAces(output, target);
  if (trustees === null) {
    return { ownerOnly: null, offenders: [], detail: 'icacls output could not be parsed' };
  }
  const offenders = Array.from(
    new Set(trustees.filter((trustee) => !isAllowedAclTrustee(trustee, identity))),
  );
  return {
    ownerOnly: offenders.length === 0,
    offenders,
    detail:
      offenders.length === 0
        ? 'ACL grants the current user only'
        : `ACL still grants: ${offenders.join(', ')}`,
  };
};

/** 실제 icacls 를 돌려 판정한다. 조회 실패는 null(판정 불가) — 호출자는 insecure 로 다룬다. */
const inspectWindowsAcl = (target: string): AclEvaluation => {
  try {
    const output = execFileSync('icacls', [target], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }).toString();
    return evaluateIcaclsOutput(output, target, currentAclIdentity());
  } catch (e: any) {
    return {
      ownerOnly: null,
      offenders: [],
      detail: `icacls query failed: ${(e?.message || String(e)).trim()}`,
    };
  }
};

/** 경로가 소유자 전용인가. true / false / null(판정 불가) + 위반 신원 + 사람이 읽을 설명. */
const inspectPermissions = (target: string): AclEvaluation => {
  if (process.platform !== 'win32') {
    try {
      const mode = fs.statSync(target).mode & 0o777;
      return {
        ownerOnly: (mode & 0o077) === 0,
        offenders: [],
        detail: `mode ${mode.toString(8).padStart(3, '0')}`,
      };
    } catch (e: any) {
      return { ownerOnly: null, offenders: [], detail: `stat failed: ${e?.message || String(e)}` };
    }
  }
  return inspectWindowsAcl(target);
};

/**
 * 상태 디렉터리를 만들고 소유자 전용으로 잠근다. 이미 있으면 권한만 다시 적용한다.
 * 절대 throw 하지 않는다.
 */
export const ensureStateDir = (): EnsureStateDirResult => {
  const dir = getStateDir();
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e: any) {
    if (!isExistingDirectory(dir)) {
      const error = e?.message || String(e);
      return {
        dir,
        ok: false,
        permissions: { ok: false, method: 'none', error },
        ownerOnly: null,
        error,
      };
    }
  }
  if (!isExistingDirectory(dir)) {
    const error = `${dir} exists but is not a directory`;
    return {
      dir,
      ok: false,
      permissions: { ok: false, method: 'none', error },
      ownerOnly: null,
      error,
    };
  }
  const permissions = lockDownDir(dir);
  if (!permissions.ok) {
    console.error('[auth] state directory permission lockdown failed:', permissions.error);
  }
  const after = inspectPermissions(dir);
  if (after.ownerOnly !== true) {
    console.error(`[auth] state directory ${dir} is not owner-only (${after.detail}).`);
  }
  return { dir, ok: true, permissions, ownerOnly: after.ownerOnly };
};

export interface TokenFileInspection {
  path: string;
  exists: boolean;
  valid: boolean;
  /** true = 소유자 전용 확인, false = 넓게 열림, null = 판정 불가 */
  ownerOnly: boolean | null;
  detail: string;
  /** 상태 디렉터리 (`~/.auto-chrome-mcp`). */
  stateDir: string;
  /** 상태 디렉터리 권한. true = 소유자 전용, false = 넓게 열림, null = 판정 불가 */
  stateDirOwnerOnly: boolean | null;
  stateDirDetail: string;
}

/**
 * doctor 용 점검 — 파일 존재·형식·권한 + 상태 디렉터리 권한.
 */
export const inspectTokenFile = (): TokenFileInspection => {
  const filePath = getTokenFilePath();
  const stateDir = getStateDir();
  const dirPerms = isExistingDirectory(stateDir)
    ? inspectPermissions(stateDir)
    : { ownerOnly: null as boolean | null, detail: 'state directory not found' };

  if (!fs.existsSync(filePath)) {
    return {
      path: filePath,
      exists: false,
      valid: false,
      ownerOnly: null,
      detail: 'token file not found (bridge has not started yet?)',
      stateDir,
      stateDirOwnerOnly: dirPerms.ownerOnly,
      stateDirDetail: dirPerms.detail,
    };
  }

  const valid = readAuthToken() !== null;
  const filePerms = inspectPermissions(filePath);

  return {
    path: filePath,
    exists: true,
    valid,
    ownerOnly: filePerms.ownerOnly,
    detail: filePerms.detail,
    stateDir,
    stateDirOwnerOnly: dirPerms.ownerOnly,
    stateDirDetail: dirPerms.detail,
  };
};

/**
 * lstat 결과만으로 "그대로 재사용해도 되는 모양"인지 본다. 순수 함수라 표본으로 검증한다.
 *
 * 심볼릭 링크는 남이 심어 둘 수 있고, 링크의 권한은 대상 파일의 권한과 다르다. 링크를
 * 따라가 읽은 값은 우리가 만든 토큰이라는 보장이 없으므로 재사용 대상이 아니다.
 */
export const isReusableTokenStat = (
  stats: Pick<fs.Stats, 'isSymbolicLink' | 'isFile'>,
): { ok: boolean; reason: string } => {
  if (stats.isSymbolicLink()) {
    return { ok: false, reason: 'the path is a symbolic link, not a regular file' };
  }
  if (!stats.isFile()) {
    return { ok: false, reason: 'the path is not a regular file' };
  }
  return { ok: true, reason: 'regular file' };
};

export interface TokenFileReading {
  /** 채택해도 되는 토큰. 일반 파일 + 소유자 전용 + 형식 유효, 셋 다 맞을 때만 값이 있다. */
  token: string | null;
  /** lstat 이 성공했다 = 자리에 무언가 있다. */
  present: boolean;
  /** 일반 파일이다. false 면 읽지 않았다. */
  regularFile: boolean;
  /** true = 소유자 전용, false = 넓게 열림, null = 판정 불가이거나 그 전에 거부됨. */
  ownerOnly: boolean | null;
  /**
   * 일반 파일이라 안전하게 읽었을 때 나온 형식 유효한 값. 권한이 느슨해도 채운다.
   * 채택에는 절대 쓰지 않는다 (그건 token 하나뿐). 회전이 자기가 버린 값을 도로 줍지
   * 않도록 거부 목록(rejectToken)에만 쓴다.
   */
  raw: string | null;
  /** 거부 사유 또는 권한 설명 (회전 사유 로그에 그대로 실린다). */
  reason: string;
}

/**
 * 토큰 파일을 "검사한 뒤에만" 읽는 단일 통로. 순서가 곧 안전이다.
 *
 *   1. lstat  — 심볼릭 링크·디렉터리·FIFO 를 여기서 걸러낸다. read 를 먼저 하면 남이
 *      심어 둔 FIFO 하나로 브리지 시작이 통째로 멈춘다 (열기만 해도 블록된다).
 *   2. 권한   — 잠그기 전 상태가 이미 소유자 전용이어야 한다. 판정 불가(null)도 거부다.
 *   3. 읽기·형식 검증 — 여기까지 통과한 값만 채택 대상이다.
 *
 * 재사용·채택 경로(시작 시 기존 파일, EEXIST 채택, 회전 락 대기 후 채택, reconcile)는
 * 전부 이 함수만 쓴다. 한 군데라도 직접 read 하면 그 경로가 검사 없는 구멍이 된다.
 */
export const inspectAndReadTokenFile = (filePath: string): TokenFileReading => {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch (e: any) {
    return {
      token: null,
      present: false,
      regularFile: false,
      ownerOnly: null,
      raw: null,
      reason: `lstat failed: ${(e?.message || String(e)).trim()}`,
    };
  }

  const shape = isReusableTokenStat(stats);
  if (!shape.ok) {
    return {
      token: null,
      present: true,
      regularFile: false,
      ownerOnly: null,
      raw: null,
      reason: shape.reason,
    };
  }

  const perms = __internals.inspectPermissions(filePath);
  // 일반 파일인 걸 lstat 으로 확인한 뒤라 이 read 는 멈추지 않는다.
  const raw = readTokenAt(filePath);
  if (perms.ownerOnly !== true) {
    return {
      token: null,
      present: true,
      regularFile: true,
      ownerOnly: perms.ownerOnly,
      raw,
      reason: perms.detail,
    };
  }
  if (!raw) {
    return {
      token: null,
      present: true,
      regularFile: true,
      ownerOnly: true,
      raw: null,
      reason: 'the file content is not a valid token',
    };
  }
  return {
    token: raw,
    present: true,
    regularFile: true,
    ownerOnly: true,
    raw,
    reason: perms.detail,
  };
};

export interface EnsureTokenResult {
  token: string;
  /** 파일에 실제로 저장됐는가. false 면 메모리에만 있는 토큰 (stdio 프록시가 못 읽는다). */
  persisted: boolean;
  created: boolean;
  error?: string;
  permissions?: PermissionLockResult;
  dirPermissions?: PermissionLockResult;
  /** 권한 잠금 또는 저장이 실패했다 — 브리지는 계속 뜨지만 경고 대상. */
  insecure?: boolean;
  /** 기존 파일을 믿을 수 없어 새 토큰으로 갈아끼웠다 (권한이 느슨했거나 일반 파일이 아니었다). */
  rotated?: boolean;
  /** 교체 직후 파일에 다른 토큰이 있어 그쪽을 채택했다 (split-brain 수렴). */
  adopted?: boolean;
}

/**
 * 교체 후 파일을 다시 읽어 메모리 토큰과 다르면 파일 쪽을 채택한다.
 *
 * 둘이 동시에 파일이 없다/깨졌다를 발견하면 각자 새 토큰을 rename 한다. rename 은
 * 마지막 하나만 남으므로, 두 프로세스가 모두 파일을 다시 읽어 같은 값으로 수렴해야
 * stdio 프록시·확장이 쥔 토큰과 서버가 검증하는 토큰이 어긋나지 않는다.
 */
export const reconcilePersistedToken = (
  writtenToken: string,
): { token: string; adopted: boolean } => {
  const onDisk = inspectAndReadTokenFile(getTokenFilePath()).token;
  if (onDisk && onDisk !== writtenToken) {
    return { token: onDisk, adopted: true };
  }
  return { token: writtenToken, adopted: false };
};

/**
 * 최종 경로에 거는 두 지점만 따로 빼 둔다.
 *
 * 동시 시작 경합(둘이 같은 순간에 publish)은 그 한 순간을 주입해야 재현된다. 테스트가
 * 그 지점을 가로챌 수 있도록 여기만 교체 가능하게 남긴다. 실행 경로는 fs 그대로다.
 */
export const __internals = {
  linkSync: (from: string, to: string): void => fs.linkSync(from, to),
  /** 최종 경로를 "없을 때만" 만든다. 대상이 있으면 EEXIST — link 와 같은 성질이다. */
  openExclusiveSync: (target: string): number => fs.openSync(target, 'wx', 0o600),
  /** 회전 락도 같은 성질로 잡는다 (있으면 EEXIST). */
  openLockSync: (target: string): number => fs.openSync(target, 'wx', 0o600),
  /**
   * 새 토큰을 만드는 지점. 회전을 결심한 직후이자 자리를 잡기 직전이라, 두 프로세스의
   * 회전을 인터리브해 보려면 여기서 상대를 끼워 넣어야 한다.
   */
  mintToken: (): string => crypto.randomBytes(TOKEN_BYTE_LENGTH).toString('hex'),
  /**
   * 토큰 파일을 실제로 읽는 지점. "검사 전에 read 했는가"는 이 지점을 세어 검증한다
   * (남이 심어 둔 FIFO 는 read 하는 순간 브리지가 멈춘다).
   */
  readTokenFile: (target: string): string | null => readTokenFileRaw(target),
  /**
   * 권한 판정. 실제 ACL 을 심고 지우는 건 환경(권한·파일시스템)에 따라 막히므로,
   * "느슨한 파일을 만나면 어떻게 하는가" 는 이 지점을 가로채 검증한다.
   */
  inspectPermissions: (target: string): AclEvaluation => inspectPermissions(target),
};

/** claim 재시도 상한. 상대가 만들고 우리가 지우는 걸 무한히 반복하지 않는다. */
const CLAIM_ATTEMPTS = 3;

export interface TokenPublishOptions {
  /** 자리에 유효한 파일이 있어도 먼저 지우고 우리 것으로 건다 (회전). */
  displace?: boolean;
  /** 이 값이 디스크에 남아 있으면 채택하지 않는다 (회전 대상이던 토큰). */
  rejectToken?: string;
}

const tryUnlink = (target: string): void => {
  try {
    fs.unlinkSync(target);
  } catch {
    /* 이미 없거나 상대가 치웠다 — 다음 시도에서 다시 확인한다. */
  }
};

/**
 * 자리에 있는 파일을 그대로 채택해도 되는가.
 *
 * 판정은 통합 helper 하나로만 한다: 일반 파일 + (잠그기 전부터) 소유자 전용 + 형식 유효.
 * 권한 검사가 여기 없으면 "경합에서 졌다"는 이유만으로 아무나 읽을 수 있는 파일을
 * 그대로 믿게 된다. 마지막으로 회전 대상이던 값이면 거부한다 (자기가 버린 토큰 회수 방지).
 */
const adoptableToken = (filePath: string, rejectToken?: string): string | null => {
  const reading = inspectAndReadTokenFile(filePath);
  if (!reading.token) return null;
  if (rejectToken && reading.token === rejectToken) return null;
  return reading.token;
};

export interface TokenPublishResult {
  permissions: PermissionLockResult;
  /** 최종적으로 유효한 토큰. 경합에서 졌으면 디스크에 있던 남의 토큰이다. */
  token: string;
  /** 경합에서 져서 기존 파일을 그대로 받아들였다. */
  adopted: boolean;
}

/**
 * 하드 링크를 못 만드는 파일시스템용 claim.
 *
 * `wx` 는 대상이 있으면 EEXIST 로 실패하므로 link 와 같은 "덮어쓰지 않는" 성질을 갖는다.
 * 예전에는 여기서 rename 으로 물러났는데, rename 은 조용히 덮어쓴다. 두 브리지가 동시에
 * 뜨면 마지막 rename 이 앞 프로세스의 재읽기 뒤에 떨어져 서버 메모리와 디스크가 갈라졌다
 * (split-brain). 이제 어느 경로에도 덮어쓰기 rename 이 없다.
 *
 * link 와 다른 점은 최종 경로에 빈 파일이 아주 잠깐 존재한다는 것뿐이고, 그 사이에도
 * 부모 디렉터리가 이미 소유자 전용이라 남이 열지 못한다.
 */
const claimByExclusiveCreate = (
  filePath: string,
  token: string,
  fallbackPermissions: PermissionLockResult,
  options: TokenPublishOptions,
): TokenPublishResult => {
  let displace = options.displace === true;

  for (let attempt = 1; attempt <= CLAIM_ATTEMPTS; attempt += 1) {
    if (displace) {
      tryUnlink(filePath);
      displace = false;
    }

    let fd: number;
    try {
      fd = __internals.openExclusiveSync(filePath);
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      const adopted = adoptableToken(filePath, options.rejectToken);
      if (adopted) {
        return { permissions: fallbackPermissions, token: adopted, adopted: true };
      }
      // 쓸모없는 파일(형식이 깨짐·일반 파일 아님·회전 대상)만 치우고 다시 만든다.
      tryUnlink(filePath);
      continue;
    }

    try {
      fs.writeSync(fd, `${token}\n`, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return { permissions: lockDownFile(filePath), token, adopted: false };
  }

  throw new Error(
    `could not claim ${filePath} after ${CLAIM_ATTEMPTS} attempts (exclusive create)`,
  );
};

/**
 * 임시 파일에 쓰고 잠근 뒤 "덮어쓰지 않는" 방식으로 최종 경로에 건다.
 *
 * rename 은 조용히 덮어쓴다. A 가 rename 하고 파일을 다시 읽어 자기 토큰을 확인한 직후
 * B 가 rename 하면, A 의 서버 메모리는 A 토큰인데 디스크는 B 토큰이 된다. A 에 붙는 stdio
 * 프록시는 디스크(B)를 읽으므로 401 이 난다. 이걸 없애려면 publish 자체가 경합에서
 * 한 명만 이기는 연산이어야 한다.
 *
 * link 는 대상이 있으면 EEXIST 로 실패한다 (POSIX·NTFS 공통). 그래서 진 쪽은 절대
 * 덮어쓰지 않고 기존 파일을 읽어 그대로 채택한다. 자리에 있는 게 쓸모없는 파일이면
 * 지운 뒤 다시 건다(remove-and-link). 지우고 거는 사이에 상대가 먼저 자리를 잡으면
 * 다시 EEXIST 가 나고, 그때는 상대 값을 채택한다.
 */
const publishTokenFile = (
  filePath: string,
  token: string,
  options: TokenPublishOptions = {},
): TokenPublishResult => {
  const dir = path.dirname(filePath);
  const suffix = crypto.randomBytes(8).toString('hex');
  const tempPath = path.join(dir, `.${TOKEN_FILE_NAME}.${suffix}.tmp`);

  // 'wx' — 같은 이름이 이미 있으면 실패한다 (미리 심어 둔 파일·symlink 를 따라가지 않는다).
  const fd = fs.openSync(tempPath, 'wx', 0o600);
  try {
    fs.writeSync(fd, `${token}\n`, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  // 잠근 뒤에 건다 — 최종 경로에 느슨한 권한의 파일이 잠깐이라도 존재하지 않게.
  const permissions = lockDownFile(tempPath);
  const discardTemp = () => tryUnlink(tempPath);

  let displace = options.displace === true;
  for (let attempt = 1; attempt <= CLAIM_ATTEMPTS; attempt += 1) {
    if (displace) {
      tryUnlink(filePath);
      displace = false;
    }

    try {
      __internals.linkSync(tempPath, filePath);
      discardTemp();
      return { permissions, token, adopted: false };
    } catch (e: any) {
      if (e?.code !== 'EEXIST') {
        // 링크를 못 만드는 파일시스템(EPERM / EXDEV / ENOSYS / EACCES ...).
        // displace 는 위에서 이미 소비했을 수 있다. 그대로 넘기면 그 사이 상대가 새로 만든
        // 유효한 파일을 한 번 더 지우게 되므로, 남은 값을 그대로 물려준다.
        discardTemp();
        return claimByExclusiveCreate(filePath, token, permissions, { ...options, displace });
      }
      const adopted = adoptableToken(filePath, options.rejectToken);
      if (adopted) {
        discardTemp();
        return { permissions, token: adopted, adopted: true };
      }
      // 쓸모없는 파일(형식이 깨짐·일반 파일 아님·회전 대상)만 치우고 다시 건다.
      tryUnlink(filePath);
    }
  }

  discardTemp();
  throw new Error(`could not claim ${filePath} after ${CLAIM_ATTEMPTS} attempts (link)`);
};

/**
 * 토큰을 보장한다. 이미 유효한 파일이 있으면 그대로 재사용(= 같은 머신의 여러 브리지가
 * 한 토큰을 공유하고, 이미 붙어 있는 stdio 프록시의 토큰을 무효화하지 않는다).
 *
 * 절대 throw 하지 않는다 — 파일을 못 써도 브리지는 떠야 하고, 그때는 메모리 토큰으로
 * 인증만 유지한다(doctor 가 파일 없음을 보고).
 */
/**
 * 회전 전용 배타 락.
 *
 * 회전은 "자리를 비우고(unlink) 새로 건다"라 publish 의 EEXIST 보호가 통하지 않는다.
 * 두 프로세스가 같은 못 믿을 파일을 동시에 회전하면 늦은 쪽의 unlink 가 먼저 올라간
 * 새 토큰을 지운다 (A unlink/link/return -> B unlink(A)/link/return). 그러면 A 의
 * 서버 메모리와 디스크가 갈라져 A 에 붙는 stdio 프록시가 401 을 받는다.
 *
 * 그래서 회전은 이 락 안에서만 하고, 락을 잡은 뒤 반드시 다시 판정한다.
 */
export const ROTATE_LOCK_FILE_NAME = 'auth-token.rotate.lock';
/** 주인이 죽어 남은 락은 이만큼 지나면 버려진 것으로 보고 회수한다. */
const ROTATE_LOCK_STALE_MS = 30_000;
/** 상대의 회전을 기다리는 상한. 넘으면 가용성을 택해 락 없이 진행한다. */
const ROTATE_LOCK_WAIT_MS = 2_000;
const ROTATE_LOCK_POLL_MS = 20;

const getRotateLockPath = (filePath: string): string =>
  path.join(path.dirname(filePath), ROTATE_LOCK_FILE_NAME);

/** 동기 경로에서 잠깐 쉰다 (폴링이 CPU 를 태우지 않게). */
const sleepSync = (ms: number): void => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* SharedArrayBuffer 가 막힌 환경용 폴백 */
    }
  }
};

/** 주인이 죽어 남은 락만 회수한다. 살아 있는 락은 건드리지 않는다. */
const reclaimStaleRotateLock = (lockPath: string): void => {
  try {
    const stats = fs.lstatSync(lockPath);
    if (!stats.isFile()) return;
    if (Date.now() - stats.mtimeMs > ROTATE_LOCK_STALE_MS) tryUnlink(lockPath);
  } catch {
    /* 그 사이에 상대가 풀었다 — 다음 시도에서 우리가 잡는다. */
  }
};

interface RotationStart {
  /** 락을 잡았으면 fd. null 이면 못 잡았다 (가용성 우선 — 락 없이 진행한다). */
  fd: number | null;
  /** 기다리는 동안 상대가 올린, 검사를 통과한 토큰. 있으면 회전하지 않는다. */
  adopted: string | null;
}

/**
 * 회전 락을 잡는다. 이미 상대가 쥐고 있으면 최대 ROTATE_LOCK_WAIT_MS 동안 폴링하면서
 * 상대가 올린 새 토큰이 보이는지 본다 (검사는 통합 helper 로만 한다). 끝내 못 잡으면
 * 락 없이 진행한다 — 브리지가 안 뜨는 것보다 낫다.
 */
const startRotation = (
  lockPath: string,
  filePath: string,
  previous: string | null,
): RotationStart => {
  const deadline = Date.now() + ROTATE_LOCK_WAIT_MS;
  for (;;) {
    try {
      return { fd: __internals.openLockSync(lockPath), adopted: null };
    } catch (e: any) {
      if (e?.code !== 'EEXIST') {
        // 락 파일 자체를 만들 수 없는 환경(디렉터리 없음·권한 없음). 회전을 포기하지는
        // 않는다. 락이 없던 예전과 같은 동작이고, 아래 재판정이 최소한의 방어는 한다.
        return { fd: null, adopted: null };
      }
    }
    const adopted = adoptableToken(filePath, previous ?? undefined);
    if (adopted) return { fd: null, adopted };
    reclaimStaleRotateLock(lockPath);
    if (Date.now() >= deadline) return { fd: null, adopted: null };
    sleepSync(ROTATE_LOCK_POLL_MS);
  }
};

/** 우리가 잡은 락만 푼다. 남의 락(fd === null)은 건드리지 않는다. */
const endRotation = (lockPath: string, fd: number | null): void => {
  if (fd === null) return;
  try {
    fs.closeSync(fd);
  } catch {
    /* 이미 닫혔다 */
  }
  tryUnlink(lockPath);
};

/**
 * 믿을 수 없는 토큰 파일을 새 토큰으로 갈아끼운다 (회전).
 *
 * 부모 디렉터리는 호출 전에 이미 잠겨 있다. 그래야 새로 건 파일이 만들어지는 순간부터
 * 남이 못 본다. 실행 중인 stdio 프록시는 연결할 때마다 토큰 파일을 다시 읽어 붙이므로
 * (mcp-server-stdio 의 authHeaders), 회전해도 다음 재연결에서 새 값을 쓴다.
 */
const rotateAuthToken = (
  filePath: string,
  previous: string | null,
  reason: string,
  dirResult: EnsureStateDirResult,
  dirInsecure: boolean,
): EnsureTokenResult => {
  // 새 토큰은 락을 잡기 전에 만든다 — 락을 쥔 시간을 짧게 하고, 채택으로 끝나면 버린다.
  const token = __internals.mintToken();
  const lockPath = getRotateLockPath(filePath);
  const start = startRotation(lockPath, filePath, previous);

  try {
    // 락을 잡았든(다른 회전이 방금 끝났을 수 있다) 기다리다 말았든, 자리를 비우기 전에
    // 반드시 다시 판정한다. 이미 믿을 수 있는 새 토큰이 있으면 우리 회전은 그걸 지우는
    // 짓이 된다. 재판정도 통합 helper 로만 한다.
    const adopted = start.adopted ?? adoptableToken(filePath, previous ?? undefined);
    if (adopted) {
      console.error(
        `[auth] another bridge already replaced ${filePath} while it was being rotated ` +
          `(${reason}), so this bridge adopts that token instead of rotating again.`,
      );
      return {
        token: adopted,
        persisted: true,
        created: false,
        rotated: true,
        adopted: true,
        dirPermissions: dirResult.permissions,
        ...(dirInsecure ? { insecure: true } : {}),
      };
    }
    return rotateUnderLock(filePath, token, previous, reason, dirResult, dirInsecure);
  } finally {
    endRotation(lockPath, start.fd);
  }
};

/** 회전 락을 쥔 상태에서의 본체. 락 관리와 섞이지 않게 따로 둔다. */
const rotateUnderLock = (
  filePath: string,
  token: string,
  previous: string | null,
  reason: string,
  dirResult: EnsureStateDirResult,
  dirInsecure: boolean,
): EnsureTokenResult => {
  let published: TokenPublishResult;
  try {
    published = publishTokenFile(filePath, token, {
      displace: true,
      ...(previous ? { rejectToken: previous } : {}),
    });
  } catch (e: any) {
    console.error(
      `[auth] the existing token file ${filePath} could not be trusted (${reason}) ` +
        `and could not be replaced: ${(e?.message || String(e)).trim()}. ` +
        'The bridge keeps running with an in-memory token, but the stdio proxy cannot read it. ' +
        'Run "auto-chrome-mcp-bridge doctor" for the fix command.',
    );
    return {
      token,
      persisted: false,
      created: true,
      rotated: true,
      insecure: true,
      error: e?.message || String(e),
      dirPermissions: dirResult.permissions,
    };
  }

  console.error(
    `[auth] rotated the bridge auth token: the previous ${filePath} could not be trusted ` +
      `(${reason}), so another local account could already have read it. ` +
      'The stdio proxy re-reads the file on every connection, so it picks up the new token.',
  );

  const permissions = published.permissions;
  if (!permissions.ok) {
    console.error('[auth] token file permission lockdown failed:', permissions.error);
  }
  const after = inspectPermissions(filePath);
  const insecure = !permissions.ok || dirInsecure || after.ownerOnly !== true;
  if (insecure) {
    console.error(
      `[auth] token file ${filePath} is not owner-only (${after.detail}). ` +
        'The bridge keeps running; run "auto-chrome-mcp-bridge doctor" for the fix command.',
    );
  }

  return {
    token: published.token,
    persisted: true,
    created: !published.adopted,
    rotated: true,
    permissions,
    dirPermissions: dirResult.permissions,
    ...(published.adopted ? { adopted: true } : {}),
    ...(insecure ? { insecure: true } : {}),
  };
};

export const ensureAuthToken = (): EnsureTokenResult => {
  const dirResult = ensureStateDir();
  const filePath = getTokenFilePath();
  const dirInsecure = !dirResult.ok || !dirResult.permissions.ok || dirResult.ownerOnly !== true;

  // ① 기존 파일은 통합 helper 로만 본다 (lstat -> 일반 파일 -> 권한 -> 그 뒤에 read).
  //    셋 다 통과할 때만 그대로 쓴다. 느슨했던 토큰은 다시 잠근다고 되살아나지 않는다.
  const existing = inspectAndReadTokenFile(filePath);
  if (existing.token) {
    if (dirInsecure) {
      console.error(
        `[auth] the state directory ${dirResult.dir} is not confirmed owner-only ` +
          `(${dirResult.error || 'see doctor'}). The bridge keeps running; ` +
          'run "auto-chrome-mcp-bridge doctor" for the fix command.',
      );
    }
    return {
      token: existing.token,
      persisted: true,
      created: false,
      dirPermissions: dirResult.permissions,
      ...(dirInsecure ? { insecure: true } : {}),
    };
  }

  // ①-b 자리에 뭔가 있는데 못 믿는다 = 회전 대상.
  //     (가) 일반 파일이 아니다: 읽지도 않았다 (심볼릭 링크·디렉터리·FIFO).
  //     (나) 일반 파일인데 잠금 전 권한이 느슨했다: 그 값은 이미 새 나갔을 수 있다.
  //     내용만 깨진 파일은 회전이 아니라 아래 생성 경로가 치운다 (덮어쓰기 없이
  //     remove-and-link). 자리를 비우는 연산이 아니라 자리를 잡는 연산이라 락이 필요 없다.
  if (existing.present && (!existing.regularFile || existing.raw !== null)) {
    return rotateAuthToken(filePath, existing.raw, existing.reason, dirResult, dirInsecure);
  }

  // ② 새로 만든다.
  const token = __internals.mintToken();

  if (!dirResult.ok) {
    console.error('[auth] failed to prepare state directory:', dirResult.error);
    return {
      token,
      persisted: false,
      created: true,
      insecure: true,
      error: dirResult.error,
      dirPermissions: dirResult.permissions,
    };
  }

  let published: TokenPublishResult;
  try {
    published = publishTokenFile(filePath, token);
  } catch (e: any) {
    // 우리가 쓰는 데 실패한 사이 다른 브리지가 유효한 파일을 남겼을 수 있다.
    // 이 채택도 검사를 건너뛰지 않는다 (통합 helper).
    const raced = adoptableToken(filePath);
    if (raced) {
      return {
        token: raced,
        persisted: true,
        created: false,
        adopted: true,
        dirPermissions: dirResult.permissions,
      };
    }
    console.error('[auth] failed to write token file:', e?.message || e);
    return {
      token,
      persisted: false,
      created: true,
      insecure: true,
      error: e?.message || String(e),
      dirPermissions: dirResult.permissions,
    };
  }

  const permissions = published.permissions;
  if (!permissions.ok) {
    console.error(
      '[auth] token file permission lockdown failed:',
      permissions.error,
      '- the bridge keeps running; run "auto-chrome-mcp-bridge doctor" for the fix command.',
    );
  }

  // ③ 경합에서 이미 진 게 확인됐으면 그 값을 쓰고, 아니면 다시 읽어 수렴시킨다
  //    (링크를 못 써 rename 으로 물러난 경우가 여기서 수렴한다).
  const reconciled = published.adopted
    ? { token: published.token, adopted: true }
    : reconcilePersistedToken(published.token);
  const finalPerms = inspectPermissions(filePath);
  const insecure = !permissions.ok || dirInsecure || finalPerms.ownerOnly !== true;

  return {
    token: reconciled.token,
    persisted: true,
    created: !reconciled.adopted,
    permissions,
    dirPermissions: dirResult.permissions,
    ...(reconciled.adopted ? { adopted: true } : {}),
    ...(insecure ? { insecure: true } : {}),
  };
};

/**
 * 상수 시간 비교. 길이까지 숨기려고 양쪽을 sha256 으로 고정 길이화한 뒤 비교한다.
 */
export const tokensMatch = (a: unknown, b: unknown): boolean => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) {
    return false;
  }
  const da = crypto.createHash('sha256').update(a, 'utf8').digest();
  const db = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(da, db);
};

/**
 * `Authorization: Bearer <token>` 에서 토큰만 뽑는다. 스킴은 대소문자 무시.
 */
export const extractBearerToken = (headerValue: unknown): string | null => {
  if (typeof headerValue !== 'string') return null;
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(headerValue);
  return match ? match[1] : null;
};
