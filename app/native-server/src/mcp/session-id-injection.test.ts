import { describe, expect, test, jest, beforeEach } from '@jest/globals';

/**
 * ScaleMaker fork — stdio 프록시의 _mcpSessionId 주입 회귀 테스트 (task C1).
 *
 * mcp-server-stdio 는 이 stdio 프로세스(= Claude Code 세션 1개) 고유의
 * `stdio-<pid>-<rand6>` 세션 id 를 모든 tools/call 인자에 실어 extension 으로 보낸다.
 * extension 은 이 값으로 세션별 "작업 탭"을 분리 관리한다 (work-tab-manager).
 *
 * 검증 seam: 모듈이 export 하는 `setupTools(server)` 에 핸들러 수집용 가짜 Server 를 넘겨
 * CallToolRequest 핸들러를 뽑아내고, MCP Client 를 mock 해서 실제로 전달된 arguments 를 본다.
 * (모듈은 import 시 main() 을 실행하므로 stdio/HTTP transport 도 함께 mock 한다.)
 */

interface ToolCallPayload {
  name: string;
  arguments?: Record<string, unknown>;
}

const mockCallTool = jest.fn(async (_payload: ToolCallPayload, ..._rest: unknown[]) => ({
  content: [{ type: 'text', text: 'ok' }],
}));
const mockClientCtor = jest.fn((..._args: unknown[]) => undefined);

jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  __esModule: true,
  Client: function MockClient(this: any, ...ctorArgs: unknown[]) {
    mockClientCtor(...ctorArgs);
    this.connect = async () => undefined;
    this.ping = async () => true;
    this.close = () => undefined;
    this.callTool = mockCallTool;
  },
}));

jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  __esModule: true,
  StreamableHTTPClientTransport: function MockHttpTransport(this: any) {
    this.sessionId = 'test-http-session';
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
}) => Promise<unknown>;

/**
 * setupTools 로 등록된 CallToolRequest 핸들러를 꺼낸다.
 * (스키마 객체 동일성으로 식별 — 핸들러 등록 순서에 의존하지 않는다)
 */
const getCallToolHandler = async (): Promise<ToolCallHandler> => {
  const { CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const { setupTools } = await import('./mcp-server-stdio');

  const handlers = new Map<unknown, ToolCallHandler>();
  const fakeServer = {
    setRequestHandler: (schema: unknown, handler: ToolCallHandler) => {
      handlers.set(schema, handler);
    },
  };
  setupTools(fakeServer as any);

  const handler = handlers.get(CallToolRequestSchema);
  if (!handler) throw new Error('CallToolRequest handler was not registered');
  return handler;
};

const forwardedArgs = (call: number = 0): Record<string, unknown> =>
  mockCallTool.mock.calls[call][0].arguments as Record<string, unknown>;

describe('mcp-server-stdio — _mcpSessionId 주입 (scalemaker fork, 세션별 작업 탭)', () => {
  beforeEach(() => {
    // 모듈 import 시 main() 이 돌면서 실패하면 process.exit(1) 로 러너를 죽인다 — 무력화.
    jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${code}) during test`);
    }) as never);
    mockCallTool.mockClear();
  });

  test('모든 tools/call 에 stdio-<pid>-<rand6> 형태의 _mcpSessionId 를 실어 보낸다', async () => {
    const handler = await getCallToolHandler();

    await handler({
      params: { name: 'chrome_navigate', arguments: { url: 'https://example.com' } },
    });

    expect(mockCallTool).toHaveBeenCalledTimes(1);
    expect(mockCallTool.mock.calls[0][0].name).toBe('chrome_navigate');
    expect(forwardedArgs()).toMatchObject({ url: 'https://example.com' });
    expect(typeof forwardedArgs()._mcpSessionId).toBe('string');
    expect(forwardedArgs()._mcpSessionId as string).toMatch(/^stdio-\d+-[a-z0-9]{6}$/);
  });

  test('세션 id 는 이 프로세스의 pid 를 담고 호출 간 안정적이다', async () => {
    const handler = await getCallToolHandler();

    await handler({ params: { name: 'chrome_screenshot', arguments: {} } });
    await handler({ params: { name: 'chrome_get_web_content', arguments: { tabId: 3 } } });

    const first = forwardedArgs(0)._mcpSessionId as string;
    const second = forwardedArgs(1)._mcpSessionId as string;
    expect(first).toBe(second);
    expect(first).toBe(`stdio-${process.pid}-${first.split('-')[2]}`);
  });

  test('arguments 가 없는 호출에도 _mcpSessionId 만 담긴 인자를 만든다', async () => {
    const handler = await getCallToolHandler();

    await handler({ params: { name: 'get_windows_and_tabs' } });

    expect(Object.keys(forwardedArgs())).toEqual(['_mcpSessionId']);
    expect(forwardedArgs()._mcpSessionId as string).toMatch(/^stdio-\d+-[a-z0-9]{6}$/);
  });

  test('호출자가 명시한 _mcpSessionId 는 덮어쓰지 않는다 (spread 순서)', async () => {
    const handler = await getCallToolHandler();

    await handler({
      params: {
        name: 'chrome_navigate',
        arguments: { url: 'https://example.com', _mcpSessionId: 'caller-supplied-session' },
      },
    });

    expect(forwardedArgs()._mcpSessionId).toBe('caller-supplied-session');
  });

  test('사용자 인자를 잃지 않고 그대로 전달한다', async () => {
    const handler = await getCallToolHandler();

    await handler({
      params: {
        name: 'chrome_click_element',
        arguments: { selector: '#buy', tabId: 7, background: true },
      },
    });

    expect(forwardedArgs()).toEqual({
      selector: '#buy',
      tabId: 7,
      background: true,
      _mcpSessionId: expect.stringMatching(/^stdio-\d+-[a-z0-9]{6}$/),
    });
  });
});
