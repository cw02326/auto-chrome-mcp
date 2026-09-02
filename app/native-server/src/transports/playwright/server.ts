/**
 * Playwright fallback transport HTTP server (port 12307).
 *
 * design 문서 §1: native (12306) 와 별도로 12307 에 listen. 클라이언트가 native 에
 * 못 붙으면 12307 로 attach (Playwright 가 backend).
 *
 * 동일 MCP protocol (Streamable HTTP) — 같은 TOOL_SCHEMAS, 다른 handler.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { HTTP_STATUS, ERROR_MESSAGES, SERVER_CONFIG } from '../../constant/index.js';
import { setupPlaywrightTools, playwrightFallbackStatus } from './setup-playwright-tools.js';
import { detachCdp } from './cdp-client.js';

export const PLAYWRIGHT_FALLBACK_PORT = 12307;

export class PlaywrightFallbackServer {
  private fastify: FastifyInstance;
  private transportsMap: Map<string, StreamableHTTPServerTransport> = new Map();
  private port: number;

  constructor(port: number = PLAYWRIGHT_FALLBACK_PORT) {
    this.port = port;
    this.fastify = Fastify({ logger: false });
  }

  public async start(host: string = SERVER_CONFIG.HOST): Promise<void> {
    await this.fastify.register(cors, {
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        const allowed = SERVER_CONFIG.CORS_ORIGIN.some((pattern) =>
          pattern instanceof RegExp ? pattern.test(origin) : pattern === origin,
        );
        return cb(null, allowed);
      },
      credentials: true,
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    });

    this.setupRoutes();
    await this.fastify.listen({ port: this.port, host });
    console.error(
      `[playwright-fallback] listening on http://${host}:${this.port}/mcp — tools: ${
        Object.keys(playwrightFallbackStatus()).length
      }`,
    );
  }

  public async stop(): Promise<void> {
    await this.fastify.close().catch(() => {});
    await detachCdp();
  }

  private setupRoutes(): void {
    // Health/diagnostic
    this.fastify.get('/health', async (_req, reply) => {
      reply.send({
        transport: 'playwright-fallback',
        port: this.port,
        status: playwrightFallbackStatus(),
      });
    });

    // MCP Streamable HTTP endpoint
    this.fastify.post('/mcp', async (request, reply) => {
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      let transport = this.transportsMap.get(sessionId || '');

      if (transport) {
        // existing session
      } else if (!sessionId && isInitializeRequest(request.body)) {
        const newSessionId = randomUUID();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
          onsessioninitialized: (id) => {
            if (transport && id === newSessionId) this.transportsMap.set(id, transport);
          },
        });

        const server = new McpServer(
          {
            name: 'AutoChromeMcpPlaywrightFallback',
            version: '1.0.0',
          },
          { capabilities: { tools: {} } },
        );
        setupPlaywrightTools(server);

        transport.onclose = () => {
          if (transport?.sessionId && this.transportsMap.get(transport.sessionId)) {
            this.transportsMap.delete(transport.sessionId);
          }
          void server.close().catch(() => {});
        };
        await server.connect(transport);
      } else {
        reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: ERROR_MESSAGES.INVALID_MCP_REQUEST });
        return;
      }

      try {
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch (error) {
        if (!reply.sent) {
          reply.code(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
            error: ERROR_MESSAGES.MCP_REQUEST_PROCESSING_ERROR,
          });
        }
      }
    });

    // session termination
    this.fastify.delete('/mcp', async (request, reply) => {
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      const transport = this.transportsMap.get(sessionId || '');
      if (!sessionId || !transport) {
        reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: ERROR_MESSAGES.INVALID_SESSION_ID });
        return;
      }
      this.transportsMap.delete(sessionId);
      await transport.close().catch(() => {});
      reply.code(HTTP_STATUS.NO_CONTENT).send();
    });
  }
}
