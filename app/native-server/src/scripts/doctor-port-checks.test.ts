import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildPortChecks } from './doctor';
import type { ProbeBridgePortsResult } from './port-probe';

/**
 * auto-chrome-mcp fork — doctor 의 포트 점검 두 가지 회귀.
 *
 * 1) 탐색으로 찾은 포트에 Bearer 토큰을 붙여 /health 를 조회했다. 12300번대의 아무
 *    서비스나 200 을 돌려주면 브리지 토큰이 그쪽으로 나갔다. 토큰이 붙는 조회 대상은
 *    설정·env 포트로만 한정한다.
 * 2) "항상 돈다" 고 적어 둔 포트 탐색이 실제로는 stdio-config.json 이 있고 파싱까지
 *    성공했을 때만 돌았다. 파일이 없거나 깨지면 port.activeBridges 자체가 없었다.
 */

let root: string;

const makeProbe = (
  overrides: Partial<ProbeBridgePortsResult> = {},
): { fn: () => Promise<ProbeBridgePortsResult>; calls: () => number } => {
  let calls = 0;
  const fn = async (): Promise<ProbeBridgePortsResult> => {
    calls += 1;
    return {
      ports: [],
      responsivePorts: [],
      bridgePorts: [],
      otherPorts: [],
      identityByPort: {},
      pidByPort: {},
      ...overrides,
    };
  };
  return { fn, calls: () => calls };
};

const noConnectivity = async (): Promise<{ ok: boolean; error?: string }> => ({
  ok: false,
  error: 'connect ECONNREFUSED',
});

const okConnectivity = async (): Promise<{ ok: boolean; status?: number }> => ({
  ok: true,
  status: 200,
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-doctor-ports-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const ids = (checks: Array<{ id: string }>): string[] => checks.map((c) => c.id);

describe('buildPortChecks - 포트 탐색은 언제나 한 번 돈다', () => {
  test('stdio-config.json 이 없어도 port.activeBridges 를 만든다', async () => {
    const probe = makeProbe({ ports: [12320], responsivePorts: [12320], bridgePorts: [12320] });

    const result = await buildPortChecks({
      stdioConfigPath: path.join(root, 'missing', 'stdio-config.json'),
      probe: probe.fn,
      connectivity: noConnectivity,
    });

    expect(probe.calls()).toBe(1);
    expect(ids(result.checks)).toContain('port.activeBridges');
  });

  test('stdio-config.json 이 깨져도 port.activeBridges 를 만든다', async () => {
    const file = path.join(root, 'stdio-config.json');
    fs.writeFileSync(file, '{ not json', 'utf8');
    const probe = makeProbe({ ports: [12320], responsivePorts: [12320], bridgePorts: [12320] });

    const result = await buildPortChecks({
      stdioConfigPath: file,
      probe: probe.fn,
      connectivity: noConnectivity,
    });

    expect(probe.calls()).toBe(1);
    expect(ids(result.checks)).toContain('port.config');
    expect(ids(result.checks)).toContain('port.activeBridges');
  });

  test('정상 설정에서도 정확히 한 번만 돈다', async () => {
    const file = path.join(root, 'stdio-config.json');
    fs.writeFileSync(file, JSON.stringify({ url: 'http://127.0.0.1:12320/mcp' }), 'utf8');
    const probe = makeProbe({ ports: [12320], responsivePorts: [12320], bridgePorts: [12320] });

    const result = await buildPortChecks({
      stdioConfigPath: file,
      probe: probe.fn,
      connectivity: noConnectivity,
    });

    expect(probe.calls()).toBe(1);
    expect(result.configuredPort).toBe(12320);
    expect(ids(result.checks)).toContain('port.activeBridges');
  });
});

describe('buildPortChecks - 탐색된 포트에는 토큰을 보내지 않는다', () => {
  test('탐색으로 찾은 브리지 포트는 토큰 조회 대상에 들어가지 않는다', async () => {
    const file = path.join(root, 'stdio-config.json');
    fs.writeFileSync(file, JSON.stringify({ url: 'http://127.0.0.1:12320/mcp' }), 'utf8');
    const probe = makeProbe({
      ports: [12320, 12399],
      responsivePorts: [12320, 12399],
      bridgePorts: [12320, 12399],
    });

    const result = await buildPortChecks({
      stdioConfigPath: file,
      probe: probe.fn,
      connectivity: noConnectivity,
    });

    expect(result.tokenPorts).toEqual([12320]);
    expect(result.tokenPorts).not.toContain(12399);
  });

  test('식별되지 않은 응답 포트도 토큰 조회 대상이 아니며 따로 보고된다', async () => {
    const file = path.join(root, 'stdio-config.json');
    fs.writeFileSync(file, JSON.stringify({ url: 'http://127.0.0.1:12320/mcp' }), 'utf8');
    const probe = makeProbe({
      ports: [12320, 12345],
      responsivePorts: [12320, 12345],
      bridgePorts: [12320],
      otherPorts: [12345],
    });

    const result = await buildPortChecks({
      stdioConfigPath: file,
      envPort: undefined,
      probe: probe.fn,
      connectivity: noConnectivity,
    });

    expect(result.tokenPorts).not.toContain(12345);
    const active = result.checks.find((c) => c.id === 'port.activeBridges');
    expect(active).toBeDefined();
    const details = active?.details as Record<string, unknown>;
    expect(details.unidentifiedPorts).toEqual([12345]);
  });

  test('env CHROME_PORT 는 토큰 조회 대상에 남는다 (사용자가 지정한 포트)', async () => {
    const probe = makeProbe();

    const result = await buildPortChecks({
      stdioConfigPath: path.join(root, 'missing.json'),
      envPort: '12345',
      probe: probe.fn,
      connectivity: noConnectivity,
    });

    expect(result.tokenPorts).toEqual([12345, 12320]);
  });
});

/**
 * Codex 재확인 4번 — 설정 파일이 없거나 깨졌을 때도 기본 포트를 "설정 포트" 로 쳐서
 * 집계에서 빼 버렸다. 그래서 이 PC 에서 브리지를 2개 찾고도 ok 로 보고했다.
 */
describe('buildPortChecks - 살아 있는 브리지 개수 집계', () => {
  const activeCheck = (
    checks: Array<{ id: string; status: string; details?: unknown }>,
  ): { status: string; details: Record<string, unknown> } => {
    const found = checks.find((c) => c.id === 'port.activeBridges');
    if (!found) throw new Error('port.activeBridges check is missing');
    return { status: found.status, details: (found.details ?? {}) as Record<string, unknown> };
  };

  test('설정이 없으면 탐색으로 찾은 브리지를 전부 센다 (2개면 warn)', async () => {
    const probe = makeProbe({
      ports: [12320, 12321],
      responsivePorts: [12320, 12321],
      bridgePorts: [12320, 12321],
    });

    const result = await buildPortChecks({
      stdioConfigPath: path.join(root, 'missing', 'stdio-config.json'),
      probe: probe.fn,
      connectivity: noConnectivity,
    });

    const active = activeCheck(result.checks);
    expect(active.status).toBe('warn');
    expect(active.details.liveBridgeCount).toBe(2);
    expect(active.details.liveBridgePorts).toEqual([12320, 12321]);
  });

  test('설정이 깨져도 탐색으로 찾은 브리지를 전부 센다 (2개면 warn)', async () => {
    const file = path.join(root, 'stdio-config.json');
    fs.writeFileSync(file, '{ not json', 'utf8');
    const probe = makeProbe({
      ports: [12320, 12399],
      responsivePorts: [12320, 12399],
      bridgePorts: [12320, 12399],
    });

    const result = await buildPortChecks({
      stdioConfigPath: file,
      probe: probe.fn,
      connectivity: noConnectivity,
    });

    const active = activeCheck(result.checks);
    expect(active.status).toBe('warn');
    expect(active.details.liveBridgeCount).toBe(2);
  });

  test('설정을 읽어 냈고 브리지가 하나면 ok', async () => {
    const file = path.join(root, 'stdio-config.json');
    fs.writeFileSync(file, JSON.stringify({ url: 'http://127.0.0.1:12320/mcp' }), 'utf8');
    const probe = makeProbe({
      ports: [12320],
      responsivePorts: [12320],
      bridgePorts: [12320],
    });

    const result = await buildPortChecks({
      stdioConfigPath: file,
      probe: probe.fn,
      connectivity: okConnectivity,
      identify: async () => ({ fork: 'auto-chrome-mcp', version: '1.11.1' }),
    });

    const active = activeCheck(result.checks);
    expect(active.status).toBe('ok');
    expect(active.details.liveBridgeCount).toBe(1);
  });

  test('설정 포트가 /ping 만 되고 브리지로 식별되지 않으면 세지 않는다', async () => {
    const file = path.join(root, 'stdio-config.json');
    fs.writeFileSync(file, JSON.stringify({ url: 'http://127.0.0.1:12320/mcp' }), 'utf8');
    const probe = makeProbe();

    const result = await buildPortChecks({
      stdioConfigPath: file,
      probe: probe.fn,
      connectivity: okConnectivity,
      identify: async () => null,
    });

    const active = activeCheck(result.checks);
    expect(active.status).toBe('ok');
    expect(active.details.liveBridgeCount).toBe(0);
  });

  test('설정 포트가 살아 있는데 탐색이 못 보면 무인증 /health 식별로 1개로 센다', async () => {
    const file = path.join(root, 'stdio-config.json');
    fs.writeFileSync(file, JSON.stringify({ url: 'http://127.0.0.1:12320/mcp' }), 'utf8');
    const probe = makeProbe();

    const result = await buildPortChecks({
      stdioConfigPath: file,
      probe: probe.fn,
      connectivity: okConnectivity,
      identify: async () => ({ fork: 'auto-chrome-mcp', version: '1.11.1' }),
    });

    const active = activeCheck(result.checks);
    expect(active.status).toBe('ok');
    expect(active.details.liveBridgeCount).toBe(1);
    expect(active.details.liveBridgePorts).toEqual([12320]);
  });

  test('설정 포트 + 다른 포트가 둘 다 살아 있으면 warn', async () => {
    const file = path.join(root, 'stdio-config.json');
    fs.writeFileSync(file, JSON.stringify({ url: 'http://127.0.0.1:12320/mcp' }), 'utf8');
    const probe = makeProbe({
      ports: [12399],
      responsivePorts: [12399],
      bridgePorts: [12399],
    });

    const result = await buildPortChecks({
      stdioConfigPath: file,
      probe: probe.fn,
      connectivity: okConnectivity,
      identify: async () => ({ fork: 'auto-chrome-mcp', version: '1.11.1' }),
    });

    const active = activeCheck(result.checks);
    expect(active.status).toBe('warn');
    expect(active.details.liveBridgeCount).toBe(2);
  });
});
