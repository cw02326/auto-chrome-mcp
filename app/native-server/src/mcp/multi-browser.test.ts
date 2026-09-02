import { describe, expect, test, jest, beforeEach, afterEach } from '@jest/globals';

/**
 * auto-chrome-mcp fork — stdio 프록시의 세션 중 브라우저(프로필) 전환 회귀 테스트.
 *
 * Chrome profile 1개 = bridge 1개 = port 1개. 예전에는 CHROME_PORT 로 정한 url 이
 * 프로세스 수명 내내 고정이라 다른 profile 을 쓰려면 Claude Code 재시작이 필요했다.
 * 이제 stdio-local 도구 2개로 갈아탄다:
 *   - chrome_list_browsers : 후보 port 들에 GET /ping → 살아있는 bridge 목록
 *   - chrome_use_browser   : 검증 후 활성 url 교체 (다음 연결부터 새 브라우저)
 * 두 도구는 extension 으로 forward 되지 않아야 하고, 나머지 도구의 _mcpSessionId
 * 주입은 그대로 유지되어야 한다.
 *
 * 검증 seam: session-id-injection.test.ts 와 동일하게 setupTools(server) 로 핸들러를
 * 뽑아내고, MCP Client / transport / global fetch 를 mock 한다.
 */

interface ToolCallPayload {
  name: string;
  arguments?: Record<string, unknown>;
}

const mockCallTool = jest.fn(async (_payload: ToolCallPayload, ..._rest: unknown[]) => ({
  content: [{ type: 'text', text: 'ok' }],
}));
const mockClientClose = jest.fn(() => undefined);
/** 연결 시점에 transport 가 받은 url — 전환이 실제로 반영됐는지 확인용 */
const mockTransportUrls: string[] = [];

jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  __esModule: true,
  Client: function MockClient(this: any) {
    this.connect = async () => undefined;
    this.ping = async () => true;
    this.close = mockClientClose;
    this.callTool = mockCallTool;
  },
}));

jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  __esModule: true,
  StreamableHTTPClientTransport: function MockHttpTransport(this: any, url: URL) {
    mockTransportUrls.push(String(url));
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
}) => Promise<any>;
type ListToolsHandler = () => Promise<{ tools: Array<{ name: string }> }>;

interface FetchCall {
  url: string;
  init: any;
}
const fetchCalls: FetchCall[] = [];
/** 살아있다고 볼 port 들 — 테스트마다 바꿔가며 /ping 응답을 흉내낸다. */
let alivePorts: number[] = [];
/** /ping 응답 본문 (version 노출 확인용) */
let pingBody: Record<string, unknown> = { status: 'ok', message: 'pong' };

const installFetchMock = () => {
  (globalThis as any).fetch = jest.fn(async (url: any, init: any) => {
    const href = String(url);
    fetchCalls.push({ url: href, init });

    if (href.endsWith('/ping')) {
      const port = Number(new URL(href).port);
      if (!alivePorts.includes(port)) {
        throw new Error('connect ECONNREFUSED');
      }
      return { ok: true, status: 200, json: async () => pingBody };
    }
    // 세션 DELETE 등
    return { ok: true, status: 200, json: async () => ({}) };
  });
};

/**
 * 모듈을 새로 로드해 (활성 url 등 모듈 상태 리셋) 필요한 핸들러를 뽑아온다.
 */
const loadHandlers = async (): Promise<{
  callTool: ToolCallHandler;
  listTools: ListToolsHandler;
}> => {
  jest.resetModules();
  const { CallToolRequestSchema, ListToolsRequestSchema } =
    await import('@modelcontextprotocol/sdk/types.js');
  const { setupTools } = await import('./mcp-server-stdio');

  const handlers = new Map<unknown, any>();
  const fakeServer = {
    setRequestHandler: (schema: unknown, handler: any) => {
      handlers.set(schema, handler);
    },
  };
  setupTools(fakeServer as any);

  const callTool = handlers.get(CallToolRequestSchema);
  const listTools = handlers.get(ListToolsRequestSchema);
  if (!callTool || !listTools) throw new Error('handlers were not registered');
  return { callTool, listTools };
};

const parsePayload = (result: any) => JSON.parse(result.content[0].text);

const originalFetch = (globalThis as any).fetch;
const originalChromePort = process.env.CHROME_PORT;
const originalChromePorts = process.env.CHROME_PORTS;

describe('mcp-server-stdio — 세션 중 브라우저 전환 (auto-chrome-mcp fork, multi-profile)', () => {
  beforeEach(() => {
    // 모듈 import 시 main() 이 돌면서 실패하면 process.exit(1) 로 러너를 죽인다 — 무력화.
    jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${code}) during test`);
    }) as never);
    // 활성 port 를 고정해 테스트를 결정론적으로 (loadConfig 가 CHROME_PORT 를 읽는다)
    process.env.CHROME_PORT = '12320';
    delete process.env.CHROME_PORTS;
    mockCallTool.mockClear();
    mockClientClose.mockClear();
    mockTransportUrls.length = 0;
    fetchCalls.length = 0;
    alivePorts = [];
    pingBody = { status: 'ok', message: 'pong' };
    installFetchMock();
  });

  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
    if (originalChromePort === undefined) delete process.env.CHROME_PORT;
    else process.env.CHROME_PORT = originalChromePort;
    if (originalChromePorts === undefined) delete process.env.CHROME_PORTS;
    else process.env.CHROME_PORTS = originalChromePorts;
  });

  test('tools/list 에 chrome_list_browsers / chrome_use_browser 가 추가된다', async () => {
    const { listTools } = await loadHandlers();
    const { TOOL_SCHEMAS } = await import('auto-chrome-mcp-shared');

    const { tools } = await listTools();
    const names = tools.map((t) => t.name);

    expect(tools).toHaveLength(TOOL_SCHEMAS.length + 2);
    expect(names).toContain('chrome_list_browsers');
    expect(names).toContain('chrome_use_browser');
    // 두 도구는 stdio 전용 — 공유 TOOL_SCHEMAS 에는 들어가면 안 된다 (extension forward 방지)
    expect(TOOL_SCHEMAS.map((t) => t.name)).not.toContain('chrome_list_browsers');
    expect(TOOL_SCHEMAS.map((t) => t.name)).not.toContain('chrome_use_browser');
  });

  test('chrome_list_browsers 는 /ping 에 응답한 port 만 alive 로 보고한다', async () => {
    alivePorts = [12315];
    const { callTool } = await loadHandlers();

    const payload = parsePayload(
      await callTool({ params: { name: 'chrome_list_browsers', arguments: {} } }),
    );

    expect(payload.success).toBe(true);
    expect(payload.activePort).toBe(12320);
    expect(payload.browsers.filter((b: any) => b.alive).map((b: any) => b.port)).toEqual([12315]);
    // 기본 후보 port 들은 모두 probe 대상
    expect(payload.browsers.map((b: any) => b.port).sort()).toEqual([12306, 12315, 12320, 12325]);
    expect(payload.browsers.find((b: any) => b.port === 12315).url).toBe(
      'http://127.0.0.1:12315/mcp',
    );
    // probe 는 GET /ping (bridge health endpoint)
    expect(fetchCalls.every((c) => c.url.endsWith('/ping') && c.init.method === 'GET')).toBe(true);
  });

  test('chrome_list_browsers 는 CHROME_PORTS env 의 port 도 후보에 넣고 version 을 노출한다', async () => {
    process.env.CHROME_PORTS = '12400, 12401';
    alivePorts = [12400];
    pingBody = { status: 'ok', message: 'pong', version: '1.2.3' };
    const { callTool } = await loadHandlers();

    const payload = parsePayload(
      await callTool({ params: { name: 'chrome_list_browsers', arguments: {} } }),
    );

    const ports = payload.browsers.map((b: any) => b.port);
    expect(ports).toContain(12400);
    expect(ports).toContain(12401);
    // 중복 없음 (활성 port 12320 은 기본 후보에도 있다)
    expect(new Set(ports).size).toBe(ports.length);
    expect(payload.browsers.find((b: any) => b.port === 12400)).toMatchObject({
      alive: true,
      version: '1.2.3',
    });
  });

  test('chrome_use_browser 는 다음 연결부터 새 port 를 쓰게 한다', async () => {
    alivePorts = [12320, 12315];
    const { callTool } = await loadHandlers();

    // ① 전환 전 호출 → 기본 port 로 연결
    await callTool({ params: { name: 'chrome_navigate', arguments: { url: 'https://a.test' } } });
    expect(mockTransportUrls).toEqual(['http://127.0.0.1:12320/mcp']);

    // ② 전환
    const payload = parsePayload(
      await callTool({ params: { name: 'chrome_use_browser', arguments: { port: 12315 } } }),
    );
    expect(payload).toMatchObject({
      success: true,
      activePort: 12315,
      note: 'subsequent tool calls target this browser',
    });

    // ③ 이전 client 를 닫고 이전 bridge 의 세션을 DELETE 로 종료 (process.exit 없이)
    expect(mockClientClose).toHaveBeenCalled();
    const del = fetchCalls.find((c) => c.init?.method === 'DELETE');
    expect(del).toBeDefined();
    expect(del!.url).toBe('http://127.0.0.1:12320/mcp');
    expect(del!.init.headers['Mcp-Session-Id']).toBe('test-http-session');

    // ④ 전환 후 호출 → 새 port 로 새로 연결
    await callTool({ params: { name: 'chrome_navigate', arguments: { url: 'https://b.test' } } });
    expect(mockTransportUrls).toEqual(['http://127.0.0.1:12320/mcp', 'http://127.0.0.1:12315/mcp']);
  });

  test('죽은 port 로 전환하면 isError + 살아있는 port 목록, 활성 브라우저는 그대로', async () => {
    alivePorts = [12320];
    const { callTool } = await loadHandlers();

    await callTool({ params: { name: 'chrome_navigate', arguments: { url: 'https://a.test' } } });

    const result = await callTool({
      params: { name: 'chrome_use_browser', arguments: { port: 12399 } },
    });
    expect(result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.success).toBe(false);
    expect(payload.alivePorts).toEqual([12320]);
    // 세션 종료 요청도 없어야 한다 (전환 자체가 일어나지 않음)
    expect(fetchCalls.some((c) => c.init?.method === 'DELETE')).toBe(false);

    // 다음 호출은 여전히 기존 port
    await callTool({ params: { name: 'chrome_navigate', arguments: { url: 'https://b.test' } } });
    expect(new Set(mockTransportUrls)).toEqual(new Set(['http://127.0.0.1:12320/mcp']));
  });

  test('port 인자가 없거나 잘못되면 검증 단계에서 거부한다', async () => {
    const { callTool } = await loadHandlers();

    const result = await callTool({ params: { name: 'chrome_use_browser', arguments: {} } });
    expect(result.isError).toBe(true);
    expect(parsePayload(result).success).toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });

  test('두 도구는 extension 으로 forward 되지 않고, 다른 도구는 _mcpSessionId 를 그대로 받는다', async () => {
    alivePorts = [12320, 12315];
    const { callTool } = await loadHandlers();

    await callTool({ params: { name: 'chrome_list_browsers', arguments: {} } });
    await callTool({ params: { name: 'chrome_use_browser', arguments: { port: 12315 } } });
    expect(mockCallTool).not.toHaveBeenCalled();

    await callTool({ params: { name: 'chrome_screenshot', arguments: { tabId: 5 } } });
    expect(mockCallTool).toHaveBeenCalledTimes(1);
    expect(mockCallTool.mock.calls[0][0].name).toBe('chrome_screenshot');
    expect(mockCallTool.mock.calls[0][0].arguments).toEqual({
      tabId: 5,
      _mcpSessionId: expect.stringMatching(/^stdio-\d+-[a-z0-9]{6}$/),
    });
  });
});
