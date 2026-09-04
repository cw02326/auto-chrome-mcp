/**
 * port-probe.ts
 *
 * auto-chrome-mcp fork: 크로스 플랫폼 브리지 포트 탐색.
 *
 * doctor.ts 의 옛 `probeActiveBridgePorts` 는 `ps`/`lsof` 기반이라 Windows 에서 항상 빈
 * 결과를 냈다(주석에 "Unix only" 라고 명시돼 있었다). 그래서 확장이 옛 버전이라 401 을
 * 받고 있어도, 그리고 팝업이 기본 포트(12320) 가 아닌 동적 포트를 고른 설치에서도,
 * doctor 가 그걸 못 봤다.
 *
 * 설계: 파서는 순수 함수(문자열 in, 배열 out)로 두고 플랫폼별 명령 실행만 어댑터로
 * 분리해서, 실제 OS 명령을 실행하지 않고도 테스트할 수 있게 한다.
 *
 * Windows: `Get-NetTCPConnection -State Listen` (PowerShell) 을 먼저 시도하고, 실패하면
 * `netstat -ano -p tcp` 로 폴백한다.
 * macOS/Linux: `lsof -iTCP -sTCP:LISTEN -P -n`.
 *
 * 후보 포트는 브리지 기본 포트(12320)와 런처/팝업이 제안하는 포트들
 * (mcp-server-stdio.ts 의 DEFAULT_CANDIDATE_PORTS: 12306/12315/12320/12325)을 모두
 * 포함하는 범위 12300~12399 로 한정한다. 이 범위 안에서 실제로 LISTEN 중인 127.0.0.1
 * 포트만 후보로 삼고, 그중 `/ping` 에 짧은 타임아웃으로 응답한 포트를 "응답한 포트" 로
 * 본다.
 *
 * 보안: 응답했다고 우리 브리지인 것은 아니다. 12300번대에서 200 을 돌려주는 아무 서비스나
 * 후보에 들어오므로, 이 모듈은 탐색 중 어떤 요청에도 인증 토큰을 붙이지 않는다. 브리지인지는
 * 무인증 응답에 실린 식별 필드(fork·version)로만 판정하고, 그 결과는 "다른 브리지 후보" 보고에만
 * 쓴다. 토큰이 붙는 조회는 사용자가 지정한 포트(설정·env)에만 보낸다.
 */

import { execFileSync } from 'child_process';
import * as http from 'http';

// ============================================================================
// Types
// ============================================================================

export interface PortListener {
  /** 바인딩된 host. 예: '127.0.0.1', '0.0.0.0', '::1', '::'. */
  host: string;
  port: number;
  /** 알아낼 수 없으면 null. */
  pid: number | null;
}

export interface PortRange {
  min: number;
  max: number;
}

export type CommandRunner = (cmd: string, args: string[]) => string;

type FetchFn = typeof globalThis.fetch;

export interface ProbeBridgePortsOptions {
  platform?: NodeJS.Platform;
  runner?: CommandRunner;
  /** 생략하면 전역 fetch 를 쓴다. null 을 명시하면 /ping 단계를 건너뛴다(테스트용). */
  fetchFn?: FetchFn | null;
  range?: PortRange;
  pingTimeoutMs?: number;
  /** 동시에 두드릴 포트 수. 기본 8. */
  concurrency?: number;
  /** 탐색 전체가 쓸 수 있는 시간. 기본 4초. */
  probeDeadlineMs?: number;
}

/** 무인증 응답이 밝힌 브리지 신원. 이 필드가 없으면 우리 브리지가 아니다. */
export interface BridgeIdentity {
  fork: string;
  version: string;
}

export interface ProbeBridgePortsResult {
  /** 범위 안에서 127.0.0.1 로 LISTEN 중인 후보 포트(응답 여부와 무관), 오름차순. */
  ports: number[];
  /** 후보 중 `/ping` 에 응답한 포트, 오름차순. 우리 브리지라는 뜻은 아니다. */
  responsivePorts: number[];
  /** 응답한 포트 중 무인증 응답으로 브리지임을 밝힌 포트, 오름차순. */
  bridgePorts: number[];
  /** 응답은 했지만 브리지 식별 필드가 없던 포트, 오름차순 (우리 브리지가 아니다). */
  otherPorts: number[];
  /** 식별된 포트의 fork·version. */
  identityByPort: Record<number, BridgeIdentity>;
  /** 포트별 소유 PID (알 수 없으면 null). */
  pidByPort: Record<number, number | null>;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * mcp-server-stdio.ts 의 DEFAULT_CANDIDATE_PORTS(12306/12315/12320/12325, popup 이 제안하는
 * 값과 동일)를 전부 포함하는 넉넉한 범위. 그 상수는 export 되어 있지 않아 재사용할 수
 * 없어서(다른 파일 수정 금지 범위 밖), 여기서는 그 값들을 감싸는 범위로 대신한다.
 */
export const DEFAULT_PORT_RANGE: PortRange = { min: 12300, max: 12399 };

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_PING_TIMEOUT_MS = 500;
/** 동시에 두드릴 포트 수 — 100개를 순차로 500ms 씩 기다리면 doctor 가 50초 멈춘다. */
const DEFAULT_PROBE_CONCURRENCY = 8;
/** 탐색 전체 마감. 이 시간이 지나면 남은 포트는 확인하지 않는다. */
const DEFAULT_PROBE_DEADLINE_MS = 4000;

/**
 * 브리지가 무인증 응답에 싣는 fork 이름. 정확히 이 값일 때만 우리 브리지로 본다
 * (server/routes/admin.ts 의 /health 본문과 같아야 한다).
 */
export const EXPECTED_FORK = 'auto-chrome-mcp';

/** semver(major.minor.patch [-prerelease] [+build]). 이 형식이 아니면 식별하지 않는다. */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** 탐색 응답에서 읽어들일 최대 본문 크기. 12300번대의 낯선 서비스가 무한히 흘려보낼 수 있다. */
const MAX_PROBE_BODY_BYTES = 256 * 1024;

// ============================================================================
// Parsers (pure)
// ============================================================================

/** `host:port` 또는 `[ipv6]:port` 형태를 분해. 실패하면 null. */
function parseHostPort(addr: string): { host: string; port: number } | null {
  const trimmed = addr.trim();
  const bracketed = trimmed.match(/^\[(.+)\]:(\d+)$/);
  if (bracketed) {
    const port = parseInt(bracketed[2], 10);
    if (Number.isNaN(port)) return null;
    return { host: bracketed[1], port };
  }
  const idx = trimmed.lastIndexOf(':');
  if (idx <= 0 || idx === trimmed.length - 1) return null;
  const host = trimmed.slice(0, idx);
  const portStr = trimmed.slice(idx + 1);
  if (!/^\d+$/.test(portStr)) return null;
  const port = parseInt(portStr, 10);
  if (Number.isNaN(port)) return null;
  return { host, port };
}

/**
 * `netstat -ano -p tcp` 출력을 파싱. 영문·한국어 등 로케일에 따라 헤더 문구
 * ("Proto  Local Address ..." / "프로토콜  로컬 주소 ...")가 달라지므로 헤더는 아예
 * 읽지 않고, 데이터 행 패턴(Proto  LocalAddr  ForeignAddr  State  PID)만 매치한다.
 * State 값("LISTENING")은 로케일과 무관하게 영문 그대로 나온다.
 */
export function parseNetstatOutput(output: string): PortListener[] {
  const results: PortListener[] = [];
  if (!output) return results;

  const lineRe = /^\s*(TCP|TCPV6)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s*$/i;
  for (const rawLine of output.split(/\r?\n/)) {
    const m = rawLine.match(lineRe);
    if (!m) continue;
    const [, , localAddr, , state, pidStr] = m;
    if (state.toUpperCase() !== 'LISTENING') continue;
    const parsed = parseHostPort(localAddr);
    if (!parsed) continue;
    const pid = parseInt(pidStr, 10);
    results.push({ host: parsed.host, port: parsed.port, pid: Number.isNaN(pid) ? null : pid });
  }
  return results;
}

/**
 * PowerShell `Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,
 * OwningProcess | ConvertTo-Json` 출력을 파싱. 행이 1개면 ConvertTo-Json 이 배열이 아니라
 * 단일 객체를 내므로 그 경우도 처리한다. 빈 출력은 빈 배열로 본다.
 */
export function parsePowerShellNetTcpJson(output: string): PortListener[] {
  const trimmed = (output ?? '').trim();
  if (!trimmed) return [];

  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return [];
  }

  const rows = Array.isArray(data) ? data : [data];
  const results: PortListener[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const host = typeof r.LocalAddress === 'string' ? r.LocalAddress : null;
    if (!host) continue;
    const portNum =
      typeof r.LocalPort === 'number' ? r.LocalPort : parseInt(String(r.LocalPort ?? ''), 10);
    if (Number.isNaN(portNum)) continue;
    const pidRaw = r.OwningProcess;
    const pidNum = typeof pidRaw === 'number' ? pidRaw : parseInt(String(pidRaw ?? ''), 10);
    results.push({ host, port: portNum, pid: Number.isNaN(pidNum) ? null : pidNum });
  }
  return results;
}

/**
 * `lsof -iTCP -sTCP:LISTEN -P -n` 출력을 파싱. 예:
 *   node    12345 user   23u  IPv4 0x1234      0t0  TCP 127.0.0.1:12320 (LISTEN)
 *   node    12345 user   24u  IPv6 0x5678      0t0  TCP [::1]:12320 (LISTEN)
 */
export function parseLsofListenOutput(output: string): PortListener[] {
  const results: PortListener[] = [];
  if (!output) return results;

  const lineRe = /^(\S+)\s+(\d+)\s+.*?(\S+:\d+)\s+\(LISTEN\)\s*$/;
  for (const rawLine of output.split(/\r?\n/)) {
    const m = rawLine.match(lineRe);
    if (!m) continue;
    const pid = parseInt(m[2], 10);
    const parsed = parseHostPort(m[3]);
    if (!parsed) continue;
    results.push({ host: parsed.host, port: parsed.port, pid: Number.isNaN(pid) ? null : pid });
  }
  return results;
}

// ============================================================================
// Filters (pure)
// ============================================================================

/** 브리지는 항상 127.0.0.1 에만 bind 한다(SERVER_CONFIG.HOST). 그 외 host 는 버린다. */
export function filterLoopbackListeners(listeners: PortListener[]): PortListener[] {
  return listeners.filter((l) => l.host === LOOPBACK_HOST);
}

/** 후보 포트 범위로 좁힌다. */
export function filterCandidatePorts(
  listeners: PortListener[],
  range: PortRange = DEFAULT_PORT_RANGE,
): PortListener[] {
  return listeners.filter((l) => l.port >= range.min && l.port <= range.max);
}

// ============================================================================
// Platform adapter
// ============================================================================

/** OS 명령 하나가 붙잡을 수 있는 최대 시간. 넘으면 죽인다 (doctor 가 멈추지 않게). */
export const COMMAND_TIMEOUT_MS = 3000;
/** 명령 출력 상한. 리스닝 소켓이 아주 많은 서버에서도 넉넉하다. */
export const COMMAND_MAX_BUFFER = 4 * 1024 * 1024;

export type ExecFileSyncLike = (
  command: string,
  args: string[],
  options: Record<string, unknown>,
) => string | Buffer;

/**
 * 명령 실행 어댑터. `execFileSync` 에 timeout·maxBuffer 를 반드시 건다.
 *
 * 예전에는 옵션이 encoding·stdio 뿐이라, `netstat` 이나 `Get-NetTCPConnection` 이 매달리면
 * doctor 가 그 자리에서 무한정 멈췄다 (execFileSync 의 기본 timeout 은 무제한이다).
 */
export const createCommandRunner =
  (exec: ExecFileSyncLike = execFileSync as unknown as ExecFileSyncLike): CommandRunner =>
  (cmd, args) =>
    String(
      exec(cmd, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: COMMAND_MAX_BUFFER,
        windowsHide: true,
      }),
    );

const defaultRunner: CommandRunner = createCommandRunner();

/**
 * 현재 LISTEN 중인 TCP 소켓 전부(범위 필터링 전)를 돌려준다. 명령 실행이 실패하면
 * (권한 부족, 명령 없음 등) 빈 배열을 돌려준다 — 못 찾은 걸 "없다" 고 하지 않기 위해
 * 호출부에서 이 함수의 실패와 "정말 listener 없음" 을 구분할 필요는 없다(doctor 는
 * probe 실패를 warn 으로 올리지 않고 그냥 0건으로 다룬다. 원래도 Unix-only 라 Windows
 * 에서는 항상 0건이었다).
 */
export function listListeningPorts(
  platform: NodeJS.Platform = process.platform,
  runner: CommandRunner = defaultRunner,
): PortListener[] {
  if (platform === 'win32') {
    try {
      const psOut = runner('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress',
      ]);
      return parsePowerShellNetTcpJson(psOut);
    } catch {
      // PowerShell 실패(구버전 Windows, 실행 정책 등) — netstat 으로 폴백.
    }
    try {
      const netstatOut = runner('netstat', ['-ano', '-p', 'tcp']);
      return parseNetstatOutput(netstatOut);
    } catch {
      return [];
    }
  }

  try {
    const lsofOut = runner('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n']);
    return parseLsofListenOutput(lsofOut);
  } catch {
    return [];
  }
}

/**
 * 전역 fetch 가 없는 런타임(Node 18 미만)용 최소 구현.
 *
 * package.json 의 engines 는 아직 `node >=14.0.0` 이다. 루트 README 는 20+ 를 권하지만
 * 선언된 하한이 14 인 이상, 전역 fetch 가 없는 런타임에서도 포트 탐색은 돌아야 한다.
 * 이 구현은 이 파일이 실제로 쓰는 것(로컬 GET, res.ok, res.status, res.json)만 흉내 낸다.
 */
export function createHttpGetFetch(): FetchFn {
  const impl = (input: unknown, init?: { signal?: AbortSignal }): Promise<unknown> =>
    new Promise((resolve, reject) => {
      let settled = false;
      const request = http.get(String(input), (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_PROBE_BODY_BYTES) {
            request.destroy();
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          const status = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            ok: status >= 200 && status < 300,
            status,
            json: async (): Promise<unknown> => JSON.parse(text),
          });
        });
        res.on('error', (error: Error) => {
          if (settled) return;
          settled = true;
          reject(error);
        });
      });
      request.on('error', (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      const signal = init?.signal;
      if (signal) {
        const abort = (): void => {
          request.destroy();
          if (settled) return;
          settled = true;
          reject(new Error('aborted'));
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }
    });
  return impl as unknown as FetchFn;
}

function resolveDefaultFetch(): FetchFn | null {
  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch.bind(globalThis) as FetchFn;
  }
  return createHttpGetFetch();
}

/**
 * 약속이 늦어도 정해진 시간에는 반드시 값을 돌려준다. AbortController 를 무시하는
 * 구현(테스트 대역, 일부 폴리필)이 있어도 전체 마감을 지키기 위한 안전망이다.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(fallback), Math.max(0, ms));
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }
    promise.then(
      (value) => finish(value),
      () => finish(fallback),
    );
  });
}

/**
 * 토큰 없이 GET 한다. 탐색 단계에서는 어떤 요청에도 Authorization 을 붙이지 않는다 —
 * 12300번대에서 LISTEN 중인 것이 우리 브리지라는 보장이 전혀 없기 때문이다.
 */
async function fetchWithoutAuth(
  fetchFn: FetchFn,
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; body: unknown } | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof (timeoutId as unknown as { unref?: () => void }).unref === 'function') {
    (timeoutId as unknown as { unref: () => void }).unref();
  }
  try {
    const request = (async () => {
      const res = await fetchFn(url, { method: 'GET', signal: controller.signal });
      if (!res) return null;
      let body: unknown = null;
      if (typeof (res as { json?: unknown }).json === 'function') {
        body = await (res as Response).json().catch(() => null);
      }
      return { ok: Boolean(res.ok), body };
    })();
    return await withDeadline(request, timeoutMs, null);
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 응답 본문에서 브리지 식별 필드를 읽는다. 우리 브리지가 아니면 null.
 *
 * 예전에는 fork·version 이 비어 있지만 않으면 브리지로 인정했다. 12300번대에서
 * `{ fork: 'x', version: 'y' }` 를 돌려주기만 하면 doctor 가 "브리지가 하나 더 있다" 고
 * 보고했다는 뜻이다. 이제는 fork 가 정확히 일치하고 version 이 semver 일 때만 인정한다.
 */
export function readBridgeIdentity(body: unknown): BridgeIdentity | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const fork = typeof record.fork === 'string' ? record.fork.trim() : '';
  const version = typeof record.version === 'string' ? record.version.trim() : '';
  if (fork !== EXPECTED_FORK) return null;
  if (!SEMVER_RE.test(version)) return null;
  return { fork, version };
}

/** 최대 limit 개를 동시에 굴린다. */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  });
  await Promise.all(lanes);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * 이 PC 에서 실제로 응답하는 브리지 포트를 찾는다. 항상 호출해도 되게 설계됐다(설정
 * 포트의 /ping 성공 여부와 무관) — "기본 포트에도 브리지가 있고 팝업이 고른 동적
 * 포트에 옛 확장이 붙은" 것처럼, 설정 포트가 살아 있어도 이 PC 에 다른 브리지가 더
 * 있을 수 있기 때문이다.
 *
 * 이 함수는 **읽기 전용 탐색**이다. 토큰을 붙이지 않고, 결과는 보고용으로만 쓴다.
 * 토큰이 붙는 조회(/health 상세)는 사용자가 지정한 포트에만 보내야 한다 — doctor 의
 * resolveExtensionAuthPorts 참고.
 */
export async function probeBridgePorts(
  options: ProbeBridgePortsOptions = {},
): Promise<ProbeBridgePortsResult> {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? defaultRunner;
  const range = options.range ?? DEFAULT_PORT_RANGE;
  const pingTimeoutMs = options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
  const concurrency = options.concurrency ?? DEFAULT_PROBE_CONCURRENCY;
  const deadlineMs = options.probeDeadlineMs ?? DEFAULT_PROBE_DEADLINE_MS;
  const fetchFn = options.fetchFn === undefined ? resolveDefaultFetch() : options.fetchFn;

  let listeners: PortListener[];
  try {
    listeners = listListeningPorts(platform, runner);
  } catch {
    listeners = [];
  }

  const candidates = filterCandidatePorts(filterLoopbackListeners(listeners), range);

  const pidByPort: Record<number, number | null> = {};
  const ports: number[] = [];
  for (const l of candidates) {
    if (!ports.includes(l.port)) ports.push(l.port);
    pidByPort[l.port] = l.pid;
  }
  ports.sort((a, b) => a - b);

  const responsivePorts: number[] = [];
  const bridgePorts: number[] = [];
  const otherPorts: number[] = [];
  const identityByPort: Record<number, BridgeIdentity> = {};

  if (fetchFn && ports.length > 0) {
    const deadline = Date.now() + deadlineMs;
    const remaining = (): number => deadline - Date.now();
    const budget = (): number => Math.min(pingTimeoutMs, Math.max(0, remaining()));

    await runWithConcurrency(ports, concurrency, async (port) => {
      if (remaining() <= 0) return;

      const ping = await fetchWithoutAuth(fetchFn, `http://127.0.0.1:${port}/ping`, budget());
      if (!ping || !ping.ok) return;
      responsivePorts.push(port);

      // 살아 있는 것과 "우리 브리지" 는 다른 문제다. 식별은 무인증 응답의 fork·version
      // 으로만 한다. /ping 은 그 필드를 싣지 않으므로 무인증 /health 도 한 번 본다.
      let identity = readBridgeIdentity(ping.body);
      if (!identity && remaining() > 0) {
        const health = await fetchWithoutAuth(fetchFn, `http://127.0.0.1:${port}/health`, budget());
        if (health && health.ok) identity = readBridgeIdentity(health.body);
      }

      if (identity) {
        identityByPort[port] = identity;
        bridgePorts.push(port);
      } else {
        otherPorts.push(port);
      }
    });
  }

  const ascending = (a: number, b: number): number => a - b;
  responsivePorts.sort(ascending);
  bridgePorts.sort(ascending);
  otherPorts.sort(ascending);

  return { ports, responsivePorts, bridgePorts, otherPorts, identityByPort, pidByPort };
}
