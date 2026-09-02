#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOL_SCHEMAS } from 'auto-chrome-mcp-shared';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as fs from 'fs';
import * as path from 'path';

let stdioMcpServer: Server | null = null;
let mcpClient: Client | null = null;
let sessionId: string | undefined = undefined;
let isCleaningUp = false;

// auto-chrome-mcp fork: 이 stdio 프로세스(=Claude Code 세션 1개당 1개)의 고유 세션 id.
// 모든 tools/call 인자에 _mcpSessionId 로 실려 extension 까지 전달되고, extension 은 이 값(+ 호출자가
// 준 lane)으로 "작업 탭" 버킷을 분리 관리한다 (버킷 상한 32). 인자는 strip 하지 않는다 —
// navigate/close_tabs 가 같은 키를 다시 계산해야 하기 때문.
const MCP_SESSION_ID = `stdio-${process.pid}-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;

// Read configuration from stdio-config.json.
// auto-chrome-mcp fork: .mcp.json 에서 전달된 env.CHROME_PORT 가 있으면 hardcoded 12320 을 override.
// 이걸 안 하면 같은 머신에서 두 Chrome profile 을 다른 port 로 띄워도 모든 Claude Code 세션이
// 12320 으로만 요청해서 한 profile 의 extension 만 잡힘 (multi-profile 라우팅 버그).
const loadConfig = () => {
  try {
    const configPath = path.join(__dirname, 'stdio-config.json');
    const configData = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configData);
    const envPort = process.env.CHROME_PORT;
    if (envPort && /^\d+$/.test(envPort)) {
      const portNum = Number(envPort);
      if (portNum > 0 && portNum < 65536) {
        config.url = `http://127.0.0.1:${portNum}/mcp`;
        console.error(`[chrome-mcp-stdio] CHROME_PORT=${portNum} → ${config.url}`);
      }
    }
    return config;
  } catch (error) {
    console.error('Failed to load stdio-config.json:', error);
    throw new Error('Configuration file stdio-config.json not found or invalid');
  }
};

// ============================================================
// auto-chrome-mcp fork: 세션 중 브라우저(프로필) 전환 — multi-browser switching
// ============================================================
// Chrome profile 1개 = bridge 1개 = port 1개 (popup 에서 확인/변경).
// 예전에는 CHROME_PORT 로 정한 url 이 프로세스 수명 내내 고정이라, 세션 도중 다른
// profile 을 쓰려면 Claude Code 를 재시작해야 했다. 이제 활성 url 을 mutable 로 두고
// chrome_list_browsers / chrome_use_browser 두 stdio-local 도구로 갈아탄다.
// (이 두 도구는 extension 으로 forward 되지 않는다 — CallTool 핸들러가 먼저 가로챔)

// 도구 이름은 shared 의 TOOL_NAMES.BROWSER.LIST_BROWSERS / USE_BROWSER 와 동일하지만,
// 여기서는 문자열 상수로 둔다 — stdio 프록시가 자체 처리하는 도구라 shared 의 빌드
// 산출물(dist) 갱신 여부와 무관하게 동작해야 한다 (TOOL_SCHEMAS 에는 절대 넣지 않음).
const LIST_BROWSERS_TOOL = 'chrome_list_browsers';
const USE_BROWSER_TOOL = 'chrome_use_browser';

/** 아무 힌트도 없을 때 훑어볼 기본 후보 port 들 (popup 이 제안하는 값들과 동일). */
const DEFAULT_CANDIDATE_PORTS = [12306, 12315, 12320, 12325];
/** /ping probe 타임아웃. 죽은 port 에서 오래 매달리지 않도록 짧게. */
const PROBE_TIMEOUT_MS = 800;
/** 세션 종료(DELETE) 타임아웃 — 기존 cleanup() 과 동일. */
const SESSION_DELETE_TIMEOUT_MS = 3000;

// 현재 활성 bridge url. loadConfig() 로 lazy 초기화되고 chrome_use_browser 로 바뀐다.
// ensureMcpClient / cleanup 은 항상 이 값을 "연결 시점에" 읽어야 한다 (config 값 캐시 금지).
let activeUrl: string | null = null;

const mcpUrlForPort = (port: number) => `http://127.0.0.1:${port}/mcp`;

const getActiveUrl = (): string => {
  if (!activeUrl) {
    activeUrl = loadConfig().url as string;
  }
  return activeUrl as string;
};

const portFromUrl = (url: string): number | null => {
  try {
    const parsed = Number(new URL(url).port);
    return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * probe 대상 port 목록: 현재 활성 port + env CHROME_PORTS(콤마 구분) + 기본 후보. 중복 제거.
 * 순서는 "가장 관련 있는 것부터" — 활성 port 가 항상 첫 번째.
 */
const getCandidatePorts = (): number[] => {
  const ports: number[] = [];
  const add = (port: number) => {
    if (Number.isInteger(port) && port > 0 && port < 65536 && !ports.includes(port)) {
      ports.push(port);
    }
  };

  const active = portFromUrl(getActiveUrl());
  if (active) add(active);

  for (const raw of (process.env.CHROME_PORTS || '').split(',')) {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) add(Number(trimmed));
  }

  for (const port of DEFAULT_CANDIDATE_PORTS) add(port);
  return ports;
};

export interface BridgeProbeResult {
  port: number;
  alive: boolean;
  version?: string;
  url: string;
}

/** GET /ping (bridge 의 health endpoint — doctor 도 같은 경로를 쓴다) */
const probeBridge = async (port: number): Promise<BridgeProbeResult> => {
  const result: BridgeProbeResult = { port, alive: false, url: mcpUrlForPort(port) };
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), PROBE_TIMEOUT_MS);
  if (typeof (timeoutId as any)?.unref === 'function') (timeoutId as any).unref();

  try {
    const res: any = await fetch(`http://127.0.0.1:${port}/ping`, {
      method: 'GET',
      signal: abortController.signal,
    });
    if (res && res.ok) {
      result.alive = true;
      // /ping 은 현재 { status, message } 만 주지만, version 이 실려오면 그대로 노출.
      try {
        if (typeof res.json === 'function') {
          const body: any = await res.json();
          const version = body?.version ?? body?.bridge?.version;
          if (typeof version === 'string') result.version = version;
        }
      } catch {
        /* 본문이 JSON 이 아니어도 alive 판정에는 영향 없음 */
      }
    }
  } catch {
    /* 연결 거부 / 타임아웃 = 그 port 에 살아있는 bridge 없음 */
  } finally {
    clearTimeout(timeoutId);
  }

  return result;
};

/** 후보 port 들을 병렬로 probe. */
const probeAllBridges = (): Promise<BridgeProbeResult[]> =>
  Promise.all(getCandidatePorts().map((port) => probeBridge(port)));

/**
 * 현재 활성 url 의 세션을 DELETE 로 종료 (cleanup() 과 동일하지만 process.exit 없음).
 * 전환 시 이전 bridge 에 좀비 세션이 남지 않게 한다.
 */
const terminateActiveSession = async (): Promise<void> => {
  if (!sessionId) return;

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), SESSION_DELETE_TIMEOUT_MS);
  if (typeof (timeoutId as any)?.unref === 'function') (timeoutId as any).unref();

  try {
    await fetch(getActiveUrl(), {
      method: 'DELETE',
      headers: { 'Mcp-Session-Id': sessionId },
      signal: abortController.signal,
    });
  } catch (e: any) {
    console.error('[chrome-mcp-stdio] Failed to terminate session:', e?.message || e);
  } finally {
    clearTimeout(timeoutId);
  }
  sessionId = undefined;
};

const jsonResult = (payload: unknown, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

export const LIST_BROWSERS_SCHEMA: Tool = {
  name: LIST_BROWSERS_TOOL,
  description:
    'List the Chrome browsers (profiles) available to this session and show which one is active. ' +
    'Each Chrome profile runs its own bridge server on its own port — one port = one browser profile, ' +
    "and the port is shown in that profile's extension popup. Probes the candidate ports (the active port, " +
    'anything in the CHROME_PORTS env var, plus the defaults 12306/12315/12320/12325) via GET /ping and returns ' +
    '{ success, activePort, browsers: [{ port, alive, version, url }] }. Handled locally by the stdio proxy: it never ' +
    'reaches the browser and does not touch any tab. Call this before chrome_use_browser to see what you can switch to.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

export const USE_BROWSER_SCHEMA: Tool = {
  name: USE_BROWSER_TOOL,
  description:
    'Switch this session to a different Chrome browser (profile) by its bridge port — no restart needed. ' +
    'Every subsequent browser tool call (navigate, screenshot, click, ...) targets the newly selected browser until ' +
    'you switch again. Each Chrome profile runs its own bridge server on its own port; find the port in that ' +
    "profile's extension popup, or run chrome_list_browsers first. The port is validated with GET /ping before " +
    'switching: if no live bridge answers there, nothing changes and the error lists the ports that are alive. ' +
    'Handled locally by the stdio proxy — it never reaches the browser.',
  inputSchema: {
    type: 'object',
    properties: {
      port: {
        type: 'number',
        description:
          'Bridge port of the Chrome profile to switch to (e.g. 12315). Shown in the extension popup; ' +
          'chrome_list_browsers reports the live ones.',
      },
    },
    required: ['port'],
  },
};

const handleListBrowsers = async (): Promise<CallToolResult> => {
  const browsers = await probeAllBridges();
  return jsonResult({
    success: true,
    activePort: portFromUrl(getActiveUrl()),
    browsers,
  });
};

const handleUseBrowser = async (args: any): Promise<CallToolResult> => {
  const port = Number(args?.port);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
    return jsonResult(
      {
        success: false,
        error: `Invalid port: ${JSON.stringify(args?.port)}. Pass the bridge port shown in the extension popup, e.g. { "port": 12315 }.`,
      },
      true,
    );
  }

  const probe = await probeBridge(port);
  if (!probe.alive) {
    const alive = (await probeAllBridges()).filter((b) => b.alive).map((b) => b.port);
    return jsonResult(
      {
        success: false,
        error: `No live Chrome bridge on port ${port} (GET /ping failed). The active browser was NOT changed.`,
        alivePorts: alive,
        hint:
          alive.length > 0
            ? `Try one of: ${alive.join(', ')}. Each Chrome profile shows its port in the extension popup.`
            : 'No bridge answered on any candidate port. Open Chrome with the extension enabled, or check the port in the extension popup.',
      },
      true,
    );
  }

  // 이전 bridge 의 세션을 먼저 정리한 뒤 client 상태를 리셋 → 다음 ensureMcpClient 가
  // 새 url 로 새로 연결한다 (activeUrl 을 읽는 시점이 connect 시점이라 순서가 중요).
  await terminateActiveSession();
  if (mcpClient) {
    try {
      mcpClient.close();
    } catch {
      /* ignore close errors */
    }
  }
  mcpClient = null;
  sessionId = undefined;
  activeUrl = mcpUrlForPort(port);
  console.error(`[chrome-mcp-stdio] Switched active browser → ${activeUrl}`);

  return jsonResult({
    success: true,
    activePort: port,
    ...(probe.version ? { version: probe.version } : {}),
    note: 'subsequent tool calls target this browser',
  });
};

/** stdio 프록시가 직접 처리하는 도구인지 (extension 으로 forward 하지 않음). */
const handleLocalTool = async (name: string, args: any): Promise<CallToolResult | null> => {
  if (name === LIST_BROWSERS_TOOL) return handleListBrowsers();
  if (name === USE_BROWSER_TOOL) return handleUseBrowser(args);
  return null;
};

export const getStdioMcpServer = () => {
  if (stdioMcpServer) {
    return stdioMcpServer;
  }
  stdioMcpServer = new Server(
    {
      name: 'StdioChromeMcpServer',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    },
  );

  setupTools(stdioMcpServer);
  return stdioMcpServer;
};

export const ensureMcpClient = async (forceNew = false) => {
  try {
    if (mcpClient && !forceNew) {
      try {
        const pingResult = await mcpClient.ping();
        if (pingResult) {
          return mcpClient;
        }
      } catch {
        // Ping failed — old client/transport is dead, will rebuild below
        console.error('[chrome-mcp-stdio] Ping failed, rebuilding client');
      }
    }

    // Always close the old client before creating a new one
    if (mcpClient) {
      try {
        mcpClient.close();
      } catch {
        /* ignore close errors */
      }
      mcpClient = null;
    }

    // auto-chrome-mcp fork: config 의 url 이 아니라 "현재 활성 url" 을 연결 시점에 읽는다.
    // (chrome_use_browser 로 세션 도중 바뀔 수 있음 — 캐시하면 전환이 먹지 않는다)
    const url = getActiveUrl();
    mcpClient = new Client({ name: 'Mcp Chrome Proxy', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(url), {});
    await mcpClient.connect(transport);
    // Save session ID for cleanup on exit
    sessionId = transport.sessionId;
    return mcpClient;
  } catch (error) {
    if (mcpClient) {
      try {
        mcpClient.close();
      } catch {
        /* ignore close errors */
      }
    }
    mcpClient = null;
    sessionId = undefined;
    console.error('[chrome-mcp-stdio] Failed to connect to MCP server:', error);
    throw error;
  }
};

// Cleanup function to close session on exit
const cleanup = async () => {
  // Prevent concurrent cleanup calls
  if (isCleaningUp) return;
  isCleaningUp = true;

  console.error('[stdio-mcp] Closing session...');
  // auto-chrome-mcp fork: config 의 url 이 아니라 "현재" 활성 url 로 DELETE
  // (chrome_use_browser 로 전환한 뒤 종료해도 올바른 bridge 의 세션이 정리되도록)
  await terminateActiveSession();
  mcpClient?.close();
  stdioMcpServer?.close();
  process.exit(0);
};

export const setupTools = (server: Server) => {
  // List tools handler
  // auto-chrome-mcp fork: extension 도구 + stdio 프록시 전용 브라우저 전환 도구 2개
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...TOOL_SCHEMAS, LIST_BROWSERS_SCHEMA, USE_BROWSER_SCHEMA],
  }));

  // Call tool handler
  // auto-chrome-mcp fork: ① 브라우저 전환 도구는 여기서 처리하고 forward 하지 않는다
  //                  ② 나머지는 세션 id 주입 후 전달 (호출자가 명시한 _mcpSessionId 는 존중)
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const local = await handleLocalTool(request.params.name, request.params.arguments || {});
    if (local) return local;

    return handleToolCall(request.params.name, {
      _mcpSessionId: MCP_SESSION_ID,
      ...(request.params.arguments || {}),
    });
  });

  // List resources handler - REQUIRED BY MCP PROTOCOL
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));

  // List prompts handler - REQUIRED BY MCP PROTOCOL
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
};

const isConnectionError = (error: any): boolean => {
  const msg = error?.message || '';
  return (
    msg.includes('EOF') ||
    msg.includes('closed') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('fetch failed') ||
    msg.includes('client is closing')
  );
};

const handleToolCall = async (name: string, args: any): Promise<CallToolResult> => {
  const DEFAULT_CALL_TIMEOUT_MS = 2 * 60 * 1000;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const client = await ensureMcpClient(attempt > 0);
      if (!client) {
        throw new Error('Failed to connect to MCP server');
      }
      const result = await client.callTool({ name, arguments: args }, undefined, {
        timeout: DEFAULT_CALL_TIMEOUT_MS,
      });
      return result as CallToolResult;
    } catch (error: any) {
      if (attempt === 0 && isConnectionError(error)) {
        console.error(
          '[chrome-mcp-stdio] Connection error, retrying with fresh client:',
          error.message,
        );
        continue;
      }
      return {
        content: [
          {
            type: 'text',
            text: `Error calling tool: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  // Should never reach here, but satisfy TypeScript
  return {
    content: [{ type: 'text', text: 'Unexpected error: retry loop exhausted' }],
    isError: true,
  };
};

async function main() {
  const transport = new StdioServerTransport();
  await getStdioMcpServer().connect(transport);

  // Setup stdin handlers to cleanup session on exit
  process.stdin.on('end', cleanup);
  process.stdin.on('close', cleanup);

  // Watchdog for parent PID (backup mechanism)
  const parentPid = process.ppid;
  const parentCheck = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch (error: any) {
      // Only treat ESRCH ("No such process") as a terminated parent.
      // Other errors like EPERM mean the process may still exist.
      if (error && error.code === 'ESRCH') {
        clearInterval(parentCheck);
        cleanup();
      }
    }
  }, 10000);
  parentCheck.unref();
}

main().catch((error) => {
  console.error('Fatal error Chrome MCP Server main():', error);
  process.exit(1);
});
