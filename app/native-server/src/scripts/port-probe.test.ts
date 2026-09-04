import { describe, expect, test } from '@jest/globals';
import * as http from 'http';
import type { AddressInfo } from 'net';

import {
  DEFAULT_PORT_RANGE,
  EXPECTED_FORK,
  createHttpGetFetch,
  readBridgeIdentity,
  filterCandidatePorts,
  filterLoopbackListeners,
  listListeningPorts,
  parseLsofListenOutput,
  parseNetstatOutput,
  parsePowerShellNetTcpJson,
  probeBridgePorts,
  COMMAND_TIMEOUT_MS,
  createCommandRunner,
  type PortListener,
} from './port-probe';

/**
 * auto-chrome-mcp fork — doctor 의 브리지 포트 탐색이 ps/lsof 기반이라 Windows 에서
 * 항상 빈 결과였던 회귀를 고치는 모듈. 파서는 순수 함수라 실제 OS 명령 없이 표본
 * 출력만으로 검증한다.
 */

describe('parseNetstatOutput', () => {
  test('영문 로케일 헤더 + LISTENING 행을 파싱한다', () => {
    const output = [
      '',
      'Active Connections',
      '',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1111',
      '  TCP    127.0.0.1:12320        0.0.0.0:0              LISTENING       5678',
      '  TCP    127.0.0.1:54321        127.0.0.1:12320        ESTABLISHED     9999',
      '',
    ].join('\r\n');

    const result = parseNetstatOutput(output);
    expect(result).toContainEqual({ host: '127.0.0.1', port: 12320, pid: 5678 });
    expect(result).toContainEqual({ host: '0.0.0.0', port: 135, pid: 1111 });
    // ESTABLISHED 행은 LISTEN 이 아니므로 제외.
    expect(result.find((r) => r.port === 54321)).toBeUndefined();
  });

  test('한국어 로케일 헤더도 데이터 행 패턴만으로 파싱한다', () => {
    const output = [
      '',
      '활성 연결',
      '',
      '  프로토콜  로컬 주소              외부 주소              상태            PID',
      '  TCP    127.0.0.1:12325        0.0.0.0:0              LISTENING       4242',
      '',
    ].join('\r\n');

    const result = parseNetstatOutput(output);
    expect(result).toEqual([{ host: '127.0.0.1', port: 12325, pid: 4242 }]);
  });

  test('IPv6 [::1]:port 행도 크래시 없이 파싱한다(호스트는 ::1)', () => {
    const output = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    [::1]:12320            [::1]:0                LISTENING       5678',
      '  TCP    [::]:135               [::]:0                 LISTENING       1111',
    ].join('\r\n');

    const result = parseNetstatOutput(output);
    expect(result).toContainEqual({ host: '::1', port: 12320, pid: 5678 });
    expect(result).toContainEqual({ host: '::', port: 135, pid: 1111 });
  });

  test('빈 출력은 빈 배열', () => {
    expect(parseNetstatOutput('')).toEqual([]);
    expect(parseNetstatOutput('\r\n\r\n')).toEqual([]);
  });

  test('PID 가 숫자로 안 읽히면 그 행은 버린다(정상 행은 유지)', () => {
    const output = [
      '  TCP    127.0.0.1:12320        0.0.0.0:0              LISTENING       -',
      '  TCP    127.0.0.1:12325        0.0.0.0:0              LISTENING       5678',
    ].join('\r\n');
    const result = parseNetstatOutput(output);
    expect(result).toEqual([{ host: '127.0.0.1', port: 12325, pid: 5678 }]);
  });
});

describe('parsePowerShellNetTcpJson', () => {
  test('여러 행: JSON 배열', () => {
    const output = JSON.stringify([
      { LocalAddress: '127.0.0.1', LocalPort: 12320, OwningProcess: 5678 },
      { LocalAddress: '0.0.0.0', LocalPort: 135, OwningProcess: 1111 },
    ]);
    expect(parsePowerShellNetTcpJson(output)).toEqual([
      { host: '127.0.0.1', port: 12320, pid: 5678 },
      { host: '0.0.0.0', port: 135, pid: 1111 },
    ]);
  });

  test('행이 1개면 ConvertTo-Json 이 배열이 아니라 단일 객체를 낸다', () => {
    const output = JSON.stringify({
      LocalAddress: '127.0.0.1',
      LocalPort: 12320,
      OwningProcess: 5678,
    });
    expect(parsePowerShellNetTcpJson(output)).toEqual([
      { host: '127.0.0.1', port: 12320, pid: 5678 },
    ]);
  });

  test('빈 출력은 빈 배열', () => {
    expect(parsePowerShellNetTcpJson('')).toEqual([]);
    expect(parsePowerShellNetTcpJson('   ')).toEqual([]);
  });

  test('JSON 파싱 실패는 빈 배열(throw 하지 않음)', () => {
    expect(parsePowerShellNetTcpJson('not json')).toEqual([]);
  });

  test('IPv6 LocalAddress(::1)도 그대로 host 로 담긴다', () => {
    const output = JSON.stringify({ LocalAddress: '::1', LocalPort: 12320, OwningProcess: 42 });
    expect(parsePowerShellNetTcpJson(output)).toEqual([{ host: '::1', port: 12320, pid: 42 }]);
  });
});

describe('parseLsofListenOutput', () => {
  test('IPv4 LISTEN 행 파싱', () => {
    const output = [
      'COMMAND   PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
      'node    12345   user   23u  IPv4 0x1234      0t0  TCP 127.0.0.1:12320 (LISTEN)',
    ].join('\n');
    expect(parseLsofListenOutput(output)).toEqual([{ host: '127.0.0.1', port: 12320, pid: 12345 }]);
  });

  test('IPv6 LISTEN 행도 파싱된다(host 는 ::1)', () => {
    const output = 'node    12345   user   24u  IPv6 0x5678      0t0  TCP [::1]:12320 (LISTEN)';
    expect(parseLsofListenOutput(output)).toEqual([{ host: '::1', port: 12320, pid: 12345 }]);
  });

  test('빈 출력은 빈 배열', () => {
    expect(parseLsofListenOutput('')).toEqual([]);
  });
});

describe('filterLoopbackListeners / filterCandidatePorts', () => {
  const listeners: PortListener[] = [
    { host: '127.0.0.1', port: 12320, pid: 1 },
    { host: '0.0.0.0', port: 12320, pid: 1 },
    { host: '::1', port: 12320, pid: 1 },
    { host: '127.0.0.1', port: 9999, pid: 2 },
  ];

  test('127.0.0.1 만 남긴다', () => {
    expect(filterLoopbackListeners(listeners)).toEqual([
      { host: '127.0.0.1', port: 12320, pid: 1 },
      { host: '127.0.0.1', port: 9999, pid: 2 },
    ]);
  });

  test('기본 범위(12300~12399) 밖 포트는 걸러진다', () => {
    const loopbackOnly = filterLoopbackListeners(listeners);
    expect(filterCandidatePorts(loopbackOnly)).toEqual([
      { host: '127.0.0.1', port: 12320, pid: 1 },
    ]);
  });

  test('기본 범위가 popup 후보 포트(12306/12315/12320/12325) 전부를 포함한다', () => {
    for (const port of [12306, 12315, 12320, 12325]) {
      expect(port).toBeGreaterThanOrEqual(DEFAULT_PORT_RANGE.min);
      expect(port).toBeLessThanOrEqual(DEFAULT_PORT_RANGE.max);
    }
  });
});

describe('listListeningPorts (platform adapter)', () => {
  test('win32: PowerShell 이 성공하면 그 결과를 쓰고 netstat 은 호출하지 않는다', () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner = (cmd: string, args: string[]): string => {
      calls.push({ cmd, args });
      if (cmd === 'powershell') {
        return JSON.stringify({ LocalAddress: '127.0.0.1', LocalPort: 12320, OwningProcess: 7 });
      }
      throw new Error('should not be called');
    };
    const result = listListeningPorts('win32', runner);
    expect(result).toEqual([{ host: '127.0.0.1', port: 12320, pid: 7 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('powershell');
  });

  test('win32: PowerShell 이 실패하면 netstat 로 폴백한다', () => {
    const calls: string[] = [];
    const runner = (cmd: string): string => {
      calls.push(cmd);
      if (cmd === 'powershell') throw new Error('powershell not found');
      if (cmd === 'netstat') {
        return '  TCP    127.0.0.1:12320        0.0.0.0:0              LISTENING       9';
      }
      throw new Error('unexpected command ' + cmd);
    };
    const result = listListeningPorts('win32', runner);
    expect(result).toEqual([{ host: '127.0.0.1', port: 12320, pid: 9 }]);
    expect(calls).toEqual(['powershell', 'netstat']);
  });

  test('win32: 둘 다 실패하면 빈 배열', () => {
    const runner = (): string => {
      throw new Error('boom');
    };
    expect(listListeningPorts('win32', runner)).toEqual([]);
  });

  test('darwin: lsof 를 호출한다', () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner = (cmd: string, args: string[]): string => {
      calls.push({ cmd, args });
      return 'node    5   user   1u  IPv4 0x1      0t0  TCP 127.0.0.1:12320 (LISTEN)';
    };
    const result = listListeningPorts('darwin', runner);
    expect(result).toEqual([{ host: '127.0.0.1', port: 12320, pid: 5 }]);
    expect(calls[0].cmd).toBe('lsof');
  });

  test('linux: lsof 실패 시 빈 배열', () => {
    const runner = (): string => {
      throw new Error('no lsof');
    };
    expect(listListeningPorts('linux', runner)).toEqual([]);
  });
});

describe('probeBridgePorts', () => {
  test('후보 포트 중 /ping 에 응답한 포트만 responsivePorts 에 들어간다', async () => {
    const runner = (): string =>
      JSON.stringify([
        { LocalAddress: '127.0.0.1', LocalPort: 12320, OwningProcess: 100 },
        { LocalAddress: '127.0.0.1', LocalPort: 12325, OwningProcess: 200 },
      ]);
    const fetchFn = (async (url: unknown) => {
      const s = String(url);
      if (s.includes(':12320/ping')) return { ok: true } as Response;
      return { ok: false } as Response;
    }) as typeof fetch;

    const result = await probeBridgePorts({ platform: 'win32', runner, fetchFn });
    expect(result.ports).toEqual([12320, 12325]);
    expect(result.responsivePorts).toEqual([12320]);
    expect(result.pidByPort).toEqual({ 12320: 100, 12325: 200 });
  });

  test('/ping 이 reject 되면 그 포트는 responsive 아님(throw 안 함)', async () => {
    const runner = (): string =>
      JSON.stringify({ LocalAddress: '127.0.0.1', LocalPort: 12320, OwningProcess: 1 });
    const fetchFn = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const result = await probeBridgePorts({ platform: 'win32', runner, fetchFn });
    expect(result.ports).toEqual([12320]);
    expect(result.responsivePorts).toEqual([]);
  });

  test('fetchFn 을 null 로 주면 /ping 단계를 건너뛰고 candidate ports 만 돌려준다', async () => {
    const runner = (): string =>
      JSON.stringify({ LocalAddress: '127.0.0.1', LocalPort: 12320, OwningProcess: 1 });
    const result = await probeBridgePorts({ platform: 'win32', runner, fetchFn: null });
    expect(result.ports).toEqual([12320]);
    expect(result.responsivePorts).toEqual([]);
  });

  test('범위 밖 포트는 애초에 /ping 대상에도 안 들어간다', async () => {
    const runner = (): string =>
      JSON.stringify({ LocalAddress: '127.0.0.1', LocalPort: 9999, OwningProcess: 1 });
    let pingCalled = false;
    const fetchFn = (async () => {
      pingCalled = true;
      return { ok: true } as Response;
    }) as typeof fetch;
    const result = await probeBridgePorts({ platform: 'win32', runner, fetchFn });
    expect(result.ports).toEqual([]);
    expect(pingCalled).toBe(false);
  });

  test('명령 실행이 통째로 실패해도 throw 하지 않고 빈 결과를 돌려준다', async () => {
    const runner = (): string => {
      throw new Error('boom');
    };
    const result = await probeBridgePorts({ platform: 'win32', runner, fetchFn: null });
    expect(result).toEqual({
      ports: [],
      responsivePorts: [],
      bridgePorts: [],
      otherPorts: [],
      identityByPort: {},
      pidByPort: {},
    });
  });
});

/**
 * 보안 회귀 (Codex 리뷰 1번) — 탐색으로 찾은 포트는 "우리 브리지" 가 아닐 수 있다.
 * 12300~12399 의 아무 서비스나 200 만 돌려주면 예전 코드는 그 포트를 살아있는 브리지로
 * 보고, doctor 가 그 뒤에 Bearer 토큰을 붙여 /health 를 조회했다. 탐색 단계에서는 어떤
 * 요청에도 토큰이 붙으면 안 되고, 우리 브리지인지는 무인증 응답의 식별 필드로만 본다.
 */
describe('probeBridgePorts - 탐색된 포트 취급', () => {
  const listenersOn =
    (...ports: number[]) =>
    (): string =>
      JSON.stringify(
        ports.map((p, i) => ({ LocalAddress: '127.0.0.1', LocalPort: p, OwningProcess: 100 + i })),
      );

  test('가짜 200 서버가 있는 포트에도 Authorization 헤더를 보내지 않는다', async () => {
    const calls: Array<{ url: string; headers: Record<string, unknown> }> = [];
    const fetchFn = (async (url: unknown, init?: unknown) => {
      const headers = (init as { headers?: Record<string, unknown> } | undefined)?.headers ?? {};
      calls.push({ url: String(url), headers: { ...headers } });
      return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
    }) as unknown as typeof fetch;

    const result = await probeBridgePorts({
      platform: 'win32',
      runner: listenersOn(12345),
      fetchFn,
    });

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const headerNames = Object.keys(call.headers).map((k) => k.toLowerCase());
      expect(headerNames).not.toContain('authorization');
    }
    // 200 은 돌려줬으니 응답은 했지만, 식별 필드가 없으니 우리 브리지가 아니다.
    expect(result.responsivePorts).toEqual([12345]);
    expect(result.bridgePorts).toEqual([]);
    expect(result.otherPorts).toEqual([12345]);
  });

  test('무인증 응답에 fork·version 이 있어야 브리지로 식별한다', async () => {
    const fetchFn = (async (url: unknown) => {
      const s = String(url);
      if (s.endsWith('/ping')) {
        return { ok: true, status: 200, json: async () => ({ status: 'ok', message: 'pong' }) };
      }
      if (s.includes(':12320/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'ok', fork: 'auto-chrome-mcp', version: '1.0.0' }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
    }) as unknown as typeof fetch;

    const result = await probeBridgePorts({
      platform: 'win32',
      runner: listenersOn(12320, 12345),
      fetchFn,
    });

    expect(result.bridgePorts).toEqual([12320]);
    expect(result.otherPorts).toEqual([12345]);
    expect(result.identityByPort[12320]).toEqual({ fork: 'auto-chrome-mcp', version: '1.0.0' });
  });
});

/**
 * 성능 회귀 (Codex 리뷰 5번) — 최대 100개 포트를 500ms 씩 순차로 ping 하면 doctor 가
 * 50초까지 멈춘다. 병렬 8개 + 전체 마감으로 묶는다.
 */
describe('probeBridgePorts - 병렬 ping 과 마감', () => {
  const listenersOn = (ports: number[]) => (): string =>
    JSON.stringify(
      ports.map((p) => ({ LocalAddress: '127.0.0.1', LocalPort: p, OwningProcess: 1 })),
    );

  test('ping 은 8개까지만 동시에 돌고 순차보다 훨씬 빨리 끝난다', async () => {
    const ports = Array.from({ length: 24 }, (_, i) => 12300 + i);
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchFn = (async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 60));
      inFlight -= 1;
      return { ok: false, status: 500 };
    }) as unknown as typeof fetch;

    const started = Date.now();
    const result = await probeBridgePorts({
      platform: 'win32',
      runner: listenersOn(ports),
      fetchFn,
    });
    const elapsed = Date.now() - started;

    expect(result.ports).toHaveLength(24);
    expect(maxInFlight).toBeLessThanOrEqual(8);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(elapsed).toBeLessThan(900); // 순차라면 24 x 60 = 1440ms 이상
  });

  test('아무 응답도 없는 포트가 많아도 전체 마감 안에 끝난다', async () => {
    const ports = Array.from({ length: 40 }, (_, i) => 12300 + i);
    const fetchFn = (async () => new Promise(() => undefined)) as unknown as typeof fetch;

    const started = Date.now();
    const result = await probeBridgePorts({
      platform: 'win32',
      runner: listenersOn(ports),
      fetchFn,
      pingTimeoutMs: 500,
      probeDeadlineMs: 300,
    });
    const elapsed = Date.now() - started;

    expect(result.responsivePorts).toEqual([]);
    expect(elapsed).toBeLessThan(1500);
  });
});

describe('createCommandRunner', () => {
  test('OS 명령에 timeout 과 maxBuffer 를 건다 (netstat 이 멈춰도 doctor 는 안 멈춘다)', () => {
    const seen: Array<Record<string, unknown>> = [];
    const runner = createCommandRunner((_cmd, _args, options) => {
      seen.push(options);
      return '[]';
    });

    runner('powershell', ['-NoProfile']);

    expect(seen).toHaveLength(1);
    expect(seen[0].timeout).toBe(COMMAND_TIMEOUT_MS);
    expect(COMMAND_TIMEOUT_MS).toBeLessThanOrEqual(3000);
    expect(typeof seen[0].maxBuffer).toBe('number');
  });
});

/**
 * Codex 재확인 5번 — 식별 기준이 "fork·version 이 비어 있지만 않으면" 이었다.
 * 12300번대에서 아무 JSON 이나 돌려주는 서비스가 브리지로 집계됐다.
 */
describe('readBridgeIdentity - 식별 기준', () => {
  test('fork 가 정확히 일치하고 version 이 semver 일 때만 인정한다', () => {
    expect(readBridgeIdentity({ fork: EXPECTED_FORK, version: '1.11.0' })).toEqual({
      fork: EXPECTED_FORK,
      version: '1.11.0',
    });
    expect(readBridgeIdentity({ fork: `  ${EXPECTED_FORK}  `, version: ' 1.0.0 ' })).toEqual({
      fork: EXPECTED_FORK,
      version: '1.0.0',
    });
    expect(readBridgeIdentity({ fork: EXPECTED_FORK, version: '1.11.0-beta.1' })).not.toBeNull();
    expect(readBridgeIdentity({ fork: EXPECTED_FORK, version: '1.11.0+build.7' })).not.toBeNull();
  });

  test('fork 가 다르면 브리지가 아니다 (부분 일치도 거부)', () => {
    expect(readBridgeIdentity({ fork: 'mcp-chrome', version: '1.0.0' })).toBeNull();
    expect(readBridgeIdentity({ fork: 'auto-chrome-mcp-proxy', version: '1.0.0' })).toBeNull();
    expect(readBridgeIdentity({ fork: 'x', version: 'y' })).toBeNull();
    expect(readBridgeIdentity({ version: '1.0.0' })).toBeNull();
  });

  test('version 이 semver 가 아니면 브리지가 아니다', () => {
    for (const version of ['dev', '1.0', '1', 'v1.0.0', '2026-09-05', '01.0.0', '']) {
      expect(readBridgeIdentity({ fork: EXPECTED_FORK, version })).toBeNull();
    }
  });

  test('객체가 아니면 null', () => {
    expect(readBridgeIdentity(null)).toBeNull();
    expect(readBridgeIdentity('ok')).toBeNull();
    expect(readBridgeIdentity([{ fork: EXPECTED_FORK, version: '1.0.0' }])).toBeNull();
  });
});

describe('probeBridgePorts - 낯선 서비스는 브리지로 세지 않는다', () => {
  const runner = (): string =>
    [
      'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME',
      'node 1 me 20u IPv4 1 0t0 TCP 127.0.0.1:12321 (LISTEN)',
    ].join('\n');

  test('fork 이름이 다르면 otherPorts 로만 보고한다', async () => {
    const fetchFn = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok', fork: 'some-other-tool', version: '3.2.1' }),
    })) as unknown as typeof globalThis.fetch;

    const result = await probeBridgePorts({ platform: 'darwin', runner, fetchFn });

    expect(result.responsivePorts).toEqual([12321]);
    expect(result.bridgePorts).toEqual([]);
    expect(result.otherPorts).toEqual([12321]);
    expect(result.identityByPort).toEqual({});
  });

  test('version 이 semver 가 아니면 otherPorts 로만 보고한다', async () => {
    const fetchFn = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok', fork: EXPECTED_FORK, version: 'dev' }),
    })) as unknown as typeof globalThis.fetch;

    const result = await probeBridgePorts({ platform: 'darwin', runner, fetchFn });

    expect(result.bridgePorts).toEqual([]);
    expect(result.otherPorts).toEqual([12321]);
  });
});

/**
 * package.json 의 engines 는 `node >=14.0.0` 이라 전역 fetch 가 없는 런타임도 선언상
 * 지원 대상이다. 그런 런타임에서도 탐색이 돌아야 한다.
 */
describe('createHttpGetFetch - 전역 fetch 가 없는 런타임 폴백', () => {
  const listen = (
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  ): Promise<{ server: http.Server; port: number }> =>
    new Promise((resolve) => {
      const server = http.createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, port: (server.address() as AddressInfo).port });
      });
    });

  const close = (server: http.Server): Promise<void> =>
    new Promise((resolve) => server.close(() => resolve()));

  test('실제 로컬 서버의 JSON 응답을 ok·status·json 으로 돌려준다', async () => {
    const { server, port } = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', fork: EXPECTED_FORK, version: '1.11.0' }));
    });
    try {
      const fetchFn = createHttpGetFetch();
      const res = (await fetchFn(`http://127.0.0.1:${port}/ping`)) as unknown as {
        ok: boolean;
        status: number;
        json: () => Promise<unknown>;
      };
      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: 'ok',
        fork: EXPECTED_FORK,
        version: '1.11.0',
      });
    } finally {
      await close(server);
    }
  });

  test('404 는 ok=false', async () => {
    const { server, port } = await listen((_req, res) => {
      res.writeHead(404);
      res.end('nope');
    });
    try {
      const res = (await createHttpGetFetch()(`http://127.0.0.1:${port}/ping`)) as unknown as {
        ok: boolean;
        status: number;
      };
      expect(res.ok).toBe(false);
      expect(res.status).toBe(404);
    } finally {
      await close(server);
    }
  });

  test('폴백만으로도 실제 브리지 응답을 식별한다', async () => {
    const { server, port } = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', fork: EXPECTED_FORK, version: '1.11.0' }));
    });
    try {
      const localRunner = (): string =>
        [
          'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME',
          `node 1 me 20u IPv4 1 0t0 TCP 127.0.0.1:${port} (LISTEN)`,
        ].join('\n');

      const result = await probeBridgePorts({
        platform: 'darwin',
        runner: localRunner,
        fetchFn: createHttpGetFetch(),
        range: { min: port, max: port },
      });

      expect(result.bridgePorts).toEqual([port]);
      expect(result.identityByPort[port]).toEqual({ fork: EXPECTED_FORK, version: '1.11.0' });
    } finally {
      await close(server);
    }
  });

  test('연결이 거절되면 reject 되고 탐색은 그 포트를 응답으로 세지 않는다', async () => {
    const { server, port } = await listen((_req, res) => res.end('x'));
    await close(server);

    const localRunner = (): string =>
      [
        'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME',
        `node 1 me 20u IPv4 1 0t0 TCP 127.0.0.1:${port} (LISTEN)`,
      ].join('\n');

    const result = await probeBridgePorts({
      platform: 'darwin',
      runner: localRunner,
      fetchFn: createHttpGetFetch(),
      range: { min: port, max: port },
      pingTimeoutMs: 300,
    });

    expect(result.ports).toEqual([port]);
    expect(result.responsivePorts).toEqual([]);
  });
});
