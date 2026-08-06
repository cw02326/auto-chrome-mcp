#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOL_SCHEMAS } from 'chrome-mcp-scalemaker-shared';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as fs from 'fs';
import * as path from 'path';

let stdioMcpServer: Server | null = null;
let mcpClient: Client | null = null;
let sessionId: string | undefined = undefined;
let isCleaningUp = false;

// Read configuration from stdio-config.json.
// scalemaker fork: .mcp.json 에서 전달된 env.CHROME_PORT 가 있으면 hardcoded 12320 을 override.
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

    const config = loadConfig();
    mcpClient = new Client({ name: 'Mcp Chrome Proxy', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {});
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
  if (sessionId) {
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, 3000);

    try {
      const config = loadConfig();
      await fetch(config.url, {
        method: 'DELETE',
        headers: { 'Mcp-Session-Id': sessionId },
        signal: abortController.signal,
      });
      console.error('[stdio-mcp] Session terminated');
    } catch (e: any) {
      console.error('[stdio-mcp] Failed to terminate session:', e.message);
    } finally {
      clearTimeout(timeoutId);
    }
    sessionId = undefined;
  }
  mcpClient?.close();
  stdioMcpServer?.close();
  process.exit(0);
};

export const setupTools = (server: Server) => {
  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_SCHEMAS }));

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    handleToolCall(request.params.name, request.params.arguments || {}),
  );

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
