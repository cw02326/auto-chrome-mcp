import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOL_SCHEMAS } from 'auto-chrome-mcp-shared';
import { attachCdp, isCdpAttached } from './cdp-client.js';
import { TOOL_REGISTRY } from './tool-registry.js';

/**
 * Playwright fallback transport — MCP Server 에 tools 를 등록.
 *
 * 동일 TOOL_SCHEMAS (auto-chrome-mcp-shared) 노출 (클라이언트 입장에서는 transport 무관 동일 API).
 * 실제 dispatch 는 TOOL_REGISTRY 의 handler — stub 인 경우 isError + 안내 메시지.
 */
export const setupPlaywrightTools = (server: Server): void => {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_SCHEMAS,
  }));

  // Resources / Prompts 는 비어있음 (extension 의 인덱싱 자원은 native-only).
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return dispatchTool(name, (args ?? {}) as Record<string, unknown>);
  });
};

const dispatchTool = async (
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> => {
  const handler = TOOL_REGISTRY[name];
  if (!handler) {
    return {
      content: [{ type: 'text', text: `Unknown tool in Playwright transport: ${name}` }],
      isError: true,
    };
  }

  // Stub: 명확한 안내 반환 (isError true).
  if (handler.status === 'stub' || !handler.call) {
    return {
      content: [
        {
          type: 'text',
          text:
            `Tool "${name}" is not yet implemented in the Playwright CDP fallback transport.\n` +
            `Reason: ${handler.stubReason ?? '(no reason given)'}\n` +
            `Switch to Primary (native messaging) mode to use this tool.`,
        },
      ],
      isError: true,
    };
  }

  // CDP attach (first call lazy, subsequent reuse cached).
  let cdp;
  try {
    cdp = await attachCdp();
  } catch (e: any) {
    return {
      content: [
        {
          type: 'text',
          text:
            `Playwright CDP attach failed: ${e?.message || e}\n` +
            `Hint: run \`scalemaker-chrome\` first to launch Chrome with --remote-debugging-port=9222.`,
        },
      ],
      isError: true,
    };
  }

  // Tool 실행.
  try {
    const result = await handler.call(cdp, args);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  } catch (e: any) {
    return {
      content: [
        {
          type: 'text',
          text: `Tool "${name}" threw: ${e?.message || e}`,
        },
      ],
      isError: true,
    };
  }
};

/**
 * Diagnostic helper — UI 표시용.
 */
export const playwrightFallbackStatus = () => ({
  attached: isCdpAttached(),
  tool_count: Object.keys(TOOL_REGISTRY).length,
  implemented: Object.values(TOOL_REGISTRY).filter((h) => h.call).length,
});
