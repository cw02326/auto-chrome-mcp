import { describe, expect, test, jest, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * auto-chrome-mcp fork — stdio 프록시 최초 연결의 병렬 안전성 회귀 테스트 (Codex 지적 F6)
 * + 브리지 bearer 토큰 전달 (F1 클라이언트 측).
 *
 * F6: 예전 ensureMcpClient 는 `mcpClient = new Client(...)` 로 전역을 먼저 채운 뒤에
 *     connect() 를 await 했다. 그래서 세션 시작 직후 병렬 호출 둘이 오면 두 번째 호출이
 *     "아직 연결 중인" client 에 ping() 을 던져 실패하고, 그 client 를 닫아버린 뒤 새로
 *     만들었다. 결과: 첫 호출은 닫힌 client 로 실패하고, HTTP 세션 하나가 고아로 남았다.
 *
 * 검증 seam: 모듈이 export 하는 ensureMcpClient 를 직접 부르고, MCP Client / transport 를
 * mock 해 connect 를 테스트가 원하는 순간에만 완료시킨다.
 */
interface ConnectRecord {
  url: string;
  options: any;
}

const transportRecords: ConnectRecord[] = [];
const clientInstances: any[] = [];
const closeCalls: any[] = [];
const pingCalls: any[] = [];
let connectResolvers: Array<() => void> = [];

jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  __esModule: true,
  Client: function MockClient(this: any) {
    const state = { id: clientInstances.length + 1, connected: false };
    this.id = state.id;
    this.connected = false;
    this.closed = false;
    this.connect = async () => {
      // 테스트가 gate 를 열어줄 때까지 "연결 중" 상태로 머무른다.
      await new Promise<void>((resolve) => {
        connectResolvers.push(resolve);
      });
      state.connected = true;
      this.connected = true;
    };
    this.ping = async () => {
      pingCalls.push(state.id);
      // 실제 SDK 도 transport 가 붙기 전 request 를 던지면 실패한다.
      if (!state.connected) throw new Error('Not connected');
      return true;
    };
    this.close = async () => {
      this.closed = true;
      closeCalls.push(state.id);
    };
    this.callTool = async () => ({ content: [{ type: 'text', text: 'ok' }] });
    clientInstances.push(this);
  },
}));

jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  __esModule: true,
  StreamableHTTPClientTransport: function MockHttpTransport(this: any, url: URL, options: any) {
    transportRecords.push({ url: String(url), options });
    this.sessionId = `session-${transportRecords.length}`;
  },
}));

jest.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  __esModule: true,
  StdioServerTransport: function MockStdioTransport(this: any) {
    this.start = async () => undefined;
    this.close = async () => undefined;
    this.send = async () => undefined;
  },
}));

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const releaseConnects = async () => {
  const pending = connectResolvers;
  connectResolvers = [];
  for (const resolve of pending) resolve();
  await tick();
};

const loadModule = async () => {
  jest.resetModules();
  return import('./mcp-server-stdio');
};

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-stdio-auth-'));
const stateDir = path.join(tempRoot, '.auto-chrome-mcp');
const TOKEN = 'c'.repeat(64);

const originalChromePort = process.env.CHROME_PORT;
const originalStateDir = process.env.AUTO_CHROME_MCP_HOME;

describe('mcp-server-stdio — 최초 연결의 병렬 안전성 + 토큰 전달', () => {
  beforeEach(() => {
    jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${code}) during test`);
    }) as never);
    process.env.CHROME_PORT = '12320';
    process.env.AUTO_CHROME_MCP_HOME = stateDir;
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'auth-token'), `${TOKEN}\n`);
    transportRecords.length = 0;
    clientInstances.length = 0;
    closeCalls.length = 0;
    pingCalls.length = 0;
    connectResolvers = [];
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalChromePort === undefined) delete process.env.CHROME_PORT;
    else process.env.CHROME_PORT = originalChromePort;
    if (originalStateDir === undefined) delete process.env.AUTO_CHROME_MCP_HOME;
    else process.env.AUTO_CHROME_MCP_HOME = originalStateDir;
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      /* 정리 실패는 테스트 결과에 영향 없음 */
    }
  });

  test('연결 완료 전에 들어온 병렬 호출은 같은 client 하나를 공유한다', async () => {
    const { ensureMcpClient } = await loadModule();

    const first = ensureMcpClient();
    const second = ensureMcpClient();
    await tick();

    // 연결이 끝나기 전에는 client 도 transport 도 하나만 만들어져야 한다.
    expect(clientInstances).toHaveLength(1);
    expect(transportRecords).toHaveLength(1);
    // 연결 중인 client 에 ping 을 던지면 안 된다 (예전 버그의 방아쇠).
    expect(pingCalls).toEqual([]);
    expect(closeCalls).toEqual([]);

    await releaseConnects();
    const [clientA, clientB] = await Promise.all([first, second]);

    expect(clientA).toBe(clientB);
    expect((clientA as any).closed).toBe(false);
    expect(closeCalls).toEqual([]);
    expect(clientInstances).toHaveLength(1);
    expect(transportRecords).toHaveLength(1);
  });

  test('연결 중에 forceNew 로 들어온 호출도 같은 client 를 공유한다 (close 0회)', async () => {
    const { ensureMcpClient } = await loadModule();

    const first = ensureMcpClient();
    const second = ensureMcpClient(true); // 재시도 경로: handleToolCall 이 attempt>0 에 쓰는 값
    await tick();

    expect(clientInstances).toHaveLength(1);
    expect(transportRecords).toHaveLength(1);
    expect(pingCalls).toEqual([]);
    expect(closeCalls).toEqual([]);

    await releaseConnects();
    const [clientA, clientB] = await Promise.all([first, second]);

    // 예전 구현은 진행 중인 연결을 기다린 뒤 그 client 를 닫고 새로 만들었다
    // (첫 호출자는 닫힌 client 를 쥐고, 브리지에는 고아 세션이 남았다).
    expect(clientA).toBe(clientB);
    expect((clientA as any).closed).toBe(false);
    expect(closeCalls).toEqual([]);
    expect(clientInstances).toHaveLength(1);
    expect(transportRecords).toHaveLength(1);
  });

  test('연결이 끝난 뒤의 호출은 ping 으로 재사용한다', async () => {
    const { ensureMcpClient } = await loadModule();

    const first = ensureMcpClient();
    await tick();
    await releaseConnects();
    const client = await first;

    const again = await ensureMcpClient();
    expect(again).toBe(client);
    expect(clientInstances).toHaveLength(1);
    expect(pingCalls).toEqual([1]);
  });

  test('토큰 파일이 있으면 Authorization: Bearer 헤더로 붙는다', async () => {
    const { ensureMcpClient } = await loadModule();

    const pending = ensureMcpClient();
    await tick();
    await releaseConnects();
    await pending;

    expect(transportRecords[0].url).toBe('http://127.0.0.1:12320/mcp');
    expect(transportRecords[0].options?.requestInit?.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
    });
  });

  test('토큰 파일이 없으면 헤더 없이 붙는다 (옛 브리지 호환)', async () => {
    fs.rmSync(path.join(stateDir, 'auth-token'), { force: true });
    const { ensureMcpClient } = await loadModule();

    const pending = ensureMcpClient();
    await tick();
    await releaseConnects();
    await pending;

    expect(transportRecords[0].options?.requestInit).toBeUndefined();
  });
});
