import { describe, expect, test, jest, beforeEach, afterEach } from '@jest/globals';

/**
 * auto-chrome-mcp fork — 회귀 케이스 #6: "bridge SIGTERM 후 재시작 → EOF 없이 재핸드셰이크".
 *
 * bridge 가 죽었다 살아나면 stdio 프록시가 들고 있던 MCP 세션은 서버 쪽에서 사라진다.
 * 그 상태로 도구를 호출하면 SDK 가 연결 오류(EOF / fetch failed / ECONNREFUSED …)를 던지는데,
 * 여기서 그대로 실패를 돌려주면 사용자는 Claude Code 를 재시작해야 했다.
 * `handleToolCall` 은 연결성 오류에 한해 **새 클라이언트로 한 번 다시 붙어** 호출을 이어간다.
 *
 * 검증 seam 은 multi-browser.test.ts 와 같다 — setupTools 로 핸들러를 뽑고 SDK 를 mock 한다.
 * 여기서 고정하는 것:
 *   1. 연결성 오류면 새 클라이언트로 재시도해 사용자에게는 성공이 보인다
 *   2. 재시도 때 낡은 클라이언트를 닫고 **새 transport 를 만든다**(재핸드셰이크)
 *   3. 연결성 오류가 아닌 실패(도구 자체의 오류)는 재시도하지 않고 그대로 보고한다
 *   4. 두 번째 시도까지 실패하면 무한 재시도하지 않고 오류로 끝낸다
 */

interface ToolCallPayload {
  name: string;
  arguments?: Record<string, unknown>;
}

/** 호출마다 다른 결과를 주도록 테스트에서 갈아끼운다. */
let callToolImpl: (payload: ToolCallPayload) => Promise<any> = async () => ({
  content: [{ type: 'text', text: 'ok' }],
});

const mockCallTool = jest.fn(async (payload: ToolCallPayload, ..._rest: unknown[]) =>
  callToolImpl(payload),
);
const mockClientClose = jest.fn(() => undefined);
/** 새 클라이언트를 만들 때마다 1씩 는다 — 재핸드셰이크 증거 */
let clientConstructions = 0;
let transportConstructions = 0;

jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  __esModule: true,
  Client: function MockClient(this: any) {
    clientConstructions++;
    this.connect = async () => undefined;
    this.ping = async () => true;
    this.close = mockClientClose;
    this.callTool = mockCallTool;
  },
}));

jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  __esModule: true,
  StreamableHTTPClientTransport: function MockHttpTransport(this: any, _url: URL) {
    transportConstructions++;
    this.sessionId = `session-${transportConstructions}`;
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

type ToolCallHandler = (request: {
  params: { name: string; arguments?: Record<string, unknown> };
}) => Promise<any>;

const loadCallTool = async (): Promise<ToolCallHandler> => {
  jest.resetModules();
  const { CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const { setupTools } = await import('./mcp-server-stdio');

  const handlers = new Map<unknown, any>();
  setupTools({ setRequestHandler: (schema: unknown, h: any) => handlers.set(schema, h) } as any);
  const callTool = handlers.get(CallToolRequestSchema);
  if (!callTool) throw new Error('CallTool handler was not registered');
  return callTool;
};

const originalFetch = (globalThis as any).fetch;
const originalChromePort = process.env.CHROME_PORT;

describe('mcp-server-stdio — bridge 재시작 후 재핸드셰이크 (회귀 #6)', () => {
  beforeEach(() => {
    jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${code}) during test`);
    }) as never);
    process.env.CHROME_PORT = '12320';
    (globalThis as any).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok' }),
    }));
    mockCallTool.mockClear();
    mockClientClose.mockClear();
    clientConstructions = 0;
    transportConstructions = 0;
    callToolImpl = async () => ({ content: [{ type: 'text', text: 'ok' }] });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    (globalThis as any).fetch = originalFetch;
    if (originalChromePort === undefined) delete process.env.CHROME_PORT;
    else process.env.CHROME_PORT = originalChromePort;
  });

  // bridge 가 재시작되면 첫 호출은 죽은 세션에 부딪힌다.
  test.each([
    ['EOF', 'SSE stream disconnected: EOF'],
    ['fetch failed', 'fetch failed'],
    ['ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:12320'],
    ['closed', 'Transport closed unexpectedly'],
  ])('연결성 오류(%s)는 새 클라이언트로 재시도해 성공한다', async (_label, message) => {
    let attempts = 0;
    callToolImpl = async () => {
      attempts++;
      if (attempts === 1) throw new Error(message);
      return { content: [{ type: 'text', text: 'second attempt ok' }] };
    };

    const callTool = await loadCallTool();
    const result = await callTool({ params: { name: 'chrome_navigate', arguments: { url: 'x' } } });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('second attempt ok');
    expect(attempts).toBe(2);
  });

  test('재시도는 낡은 클라이언트를 닫고 새 transport 로 다시 붙는다', async () => {
    let attempts = 0;
    callToolImpl = async () => {
      attempts++;
      if (attempts === 1) throw new Error('SSE stream disconnected: EOF');
      return { content: [{ type: 'text', text: 'ok' }] };
    };

    const callTool = await loadCallTool();
    await callTool({ params: { name: 'chrome_navigate', arguments: {} } });

    // 세션이 사라졌으므로 같은 클라이언트를 재사용하면 안 된다.
    expect(clientConstructions).toBeGreaterThanOrEqual(2);
    expect(transportConstructions).toBeGreaterThanOrEqual(2);
    expect(mockClientClose).toHaveBeenCalled();
  });

  test('연결성 오류가 아니면 재시도하지 않고 그대로 보고한다', async () => {
    let attempts = 0;
    callToolImpl = async () => {
      attempts++;
      throw new Error('Element with selector "#none" not found');
    };

    const callTool = await loadCallTool();
    const result = await callTool({ params: { name: 'chrome_click_element', arguments: {} } });

    expect(attempts).toBe(1);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('#none');
  });

  test('재시도까지 실패하면 무한 재시도하지 않고 오류로 끝낸다', async () => {
    let attempts = 0;
    callToolImpl = async () => {
      attempts++;
      throw new Error('fetch failed');
    };

    const callTool = await loadCallTool();
    const result = await callTool({ params: { name: 'chrome_navigate', arguments: {} } });

    expect(attempts).toBe(2);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('fetch failed');
  });
});
