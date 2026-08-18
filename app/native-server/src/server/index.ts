/**
 * HTTP Server - Core server implementation.
 *
 * Responsibilities:
 * - Fastify instance management
 * - Plugin registration (CORS, etc.)
 * - Route delegation to specialized modules
 * - MCP transport handling
 * - Server lifecycle management
 */
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import {
  NATIVE_SERVER_PORT,
  TIMEOUTS,
  SERVER_CONFIG,
  HTTP_STATUS,
  ERROR_MESSAGES,
} from '../constant';
import { NativeMessagingHost } from '../native-messaging-host';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../mcp/mcp-server';
import { registerAdminRoutes } from './routes';

// ============================================================
// Types
// ============================================================

interface ExtensionRequestPayload {
  data?: unknown;
}

// ============================================================
// Server Class
// ============================================================

export class Server {
  private fastify: FastifyInstance;
  public isRunning = false;
  /** v1.0.19: 현재 listen 중인 port. dynamic port 시 START 메시지의 port 와 비교용. */
  public listeningPort: number | null = null;
  private nativeHost: NativeMessagingHost | null = null;
  private transportsMap: Map<string, StreamableHTTPServerTransport | SSEServerTransport> =
    new Map();
  /** Process start timestamp (auto-chrome-mcp: admin /health uptime 보고용). */
  private readonly startedAt: number = Date.now();

  constructor() {
    this.fastify = Fastify({ logger: SERVER_CONFIG.LOGGER_ENABLED });
    this.setupPlugins();
    this.setupRoutes();
  }

  /**
   * Associate NativeMessagingHost instance.
   */
  public setNativeHost(nativeHost: NativeMessagingHost): void {
    this.nativeHost = nativeHost;
  }

  private async setupPlugins(): Promise<void> {
    await this.fastify.register(cors, {
      origin: (origin, cb) => {
        // Allow requests with no origin (e.g., curl, server-to-server)
        if (!origin) {
          return cb(null, true);
        }
        // Check if origin matches any pattern in whitelist
        const allowed = SERVER_CONFIG.CORS_ORIGIN.some((pattern) =>
          pattern instanceof RegExp ? pattern.test(origin) : origin.startsWith(pattern),
        );
        cb(null, allowed);
      },
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      credentials: true,
    });
  }

  private setupRoutes(): void {
    // Health check (legacy /ping)
    this.setupHealthRoutes();

    // Admin routes (auto-chrome-mcp: /health + /admin/drain — Force Reconnect 지원)
    registerAdminRoutes(this.fastify, {
      onDrainRequested: () => this.gracefulDrain(),
      getTransportCount: () => this.transportsMap.size,
      startedAt: this.startedAt,
    });

    // Extension communication
    this.setupExtensionRoutes();

    // MCP routes
    this.setupMcpRoutes();
  }

  // ============================================================
  // Graceful Drain (auto-chrome-mcp — Force Reconnect Stage A 자살 패턴)
  // ============================================================

  /**
   * 모든 활성 transport 를 닫고 native host 연결을 정리한 뒤 호출자에게 control 반환.
   * /admin/drain endpoint 가 받은 후 setImmediate 안에서 호출. drain 후 caller 가
   * process.exit(0) — Chrome native messaging 의 자동 respawn 에 의존해 새 bridge 시작.
   */
  private async gracefulDrain(): Promise<void> {
    const transports = Array.from(this.transportsMap.values());
    this.transportsMap.clear();
    for (const t of transports) {
      try {
        // SSE/Streamable HTTP transport 둘 다 close() 메소드 보유.
        await (t as { close?: () => Promise<void> | void }).close?.();
      } catch (e: any) {
        console.error('[drain] transport close error (ignoring):', e?.message || e);
      }
    }
    // Native host (stdin/stdout) 는 process.exit(0) 시 자동 닫힘 — 별도 cleanup 불요.
    this.isRunning = false;
  }

  // ============================================================
  // Health Routes
  // ============================================================

  private setupHealthRoutes(): void {
    this.fastify.get('/ping', async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.status(HTTP_STATUS.OK).send({
        status: 'ok',
        message: 'pong',
      });
    });
  }

  // ============================================================
  // Extension Routes
  // ============================================================

  private setupExtensionRoutes(): void {
    this.fastify.get(
      '/ask-extension',
      async (request: FastifyRequest<{ Body: ExtensionRequestPayload }>, reply: FastifyReply) => {
        if (!this.nativeHost) {
          return reply
            .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.NATIVE_HOST_NOT_AVAILABLE });
        }
        if (!this.isRunning) {
          return reply
            .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.SERVER_NOT_RUNNING });
        }

        try {
          const extensionResponse = await this.nativeHost.sendRequestToExtensionAndWait(
            request.query,
            'process_data',
            TIMEOUTS.EXTENSION_REQUEST_TIMEOUT,
          );
          return reply.status(HTTP_STATUS.OK).send({ status: 'success', data: extensionResponse });
        } catch (error: unknown) {
          const err = error as Error;
          if (err.message.includes('timed out')) {
            return reply
              .status(HTTP_STATUS.GATEWAY_TIMEOUT)
              .send({ status: 'error', message: ERROR_MESSAGES.REQUEST_TIMEOUT });
          } else {
            return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
              status: 'error',
              message: `Failed to get response from extension: ${err.message}`,
            });
          }
        }
      },
    );
  }

  // ============================================================
  // MCP Routes
  // ============================================================

  private setupMcpRoutes(): void {
    // SSE endpoint
    this.fastify.get('/sse', async (_, reply) => {
      try {
        reply.raw.writeHead(HTTP_STATUS.OK, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        const transport = new SSEServerTransport('/messages', reply.raw);
        const server = createMcpServer();
        this.transportsMap.set(transport.sessionId, transport);

        reply.raw.on('close', () => {
          this.transportsMap.delete(transport.sessionId);
          void server.close().catch(() => {});
        });

        await server.connect(transport);

        reply.raw.write(':\n\n');
      } catch (error) {
        if (!reply.sent) {
          reply.code(HTTP_STATUS.INTERNAL_SERVER_ERROR).send(ERROR_MESSAGES.INTERNAL_SERVER_ERROR);
        }
      }
    });

    // SSE messages endpoint
    this.fastify.post('/messages', async (req, reply) => {
      try {
        const { sessionId } = req.query as { sessionId?: string };
        const transport = this.transportsMap.get(sessionId || '') as SSEServerTransport;
        if (!sessionId || !transport) {
          reply.code(HTTP_STATUS.BAD_REQUEST).send('No transport found for sessionId');
          return;
        }

        await transport.handlePostMessage(req.raw, reply.raw, req.body);
      } catch (error) {
        if (!reply.sent) {
          reply.code(HTTP_STATUS.INTERNAL_SERVER_ERROR).send(ERROR_MESSAGES.INTERNAL_SERVER_ERROR);
        }
      }
    });

    // MCP POST endpoint
    this.fastify.post('/mcp', async (request, reply) => {
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport | undefined = this.transportsMap.get(
        sessionId || '',
      ) as StreamableHTTPServerTransport;

      if (transport) {
        // Transport found, proceed
      } else if (!sessionId && isInitializeRequest(request.body)) {
        const newSessionId = randomUUID();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
          onsessioninitialized: (initializedSessionId) => {
            if (transport && initializedSessionId === newSessionId) {
              this.transportsMap.set(initializedSessionId, transport);
            }
          },
        });

        const server = createMcpServer();
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
          reply
            .code(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.MCP_REQUEST_PROCESSING_ERROR });
        }
      }
    });

    // MCP GET endpoint (SSE stream)
    this.fastify.get('/mcp', async (request, reply) => {
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      const transport = sessionId
        ? (this.transportsMap.get(sessionId) as StreamableHTTPServerTransport)
        : undefined;

      if (!transport) {
        reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: ERROR_MESSAGES.INVALID_SSE_SESSION });
        return;
      }

      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.flushHeaders();

      try {
        await transport.handleRequest(request.raw, reply.raw);
        if (!reply.sent) {
          reply.hijack();
        }
      } catch (error) {
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      }

      request.socket.on('close', () => {
        request.log.info(`SSE client disconnected for session: ${sessionId}`);
      });
    });

    // MCP DELETE endpoint
    this.fastify.delete('/mcp', async (request, reply) => {
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      const transport = sessionId
        ? (this.transportsMap.get(sessionId) as StreamableHTTPServerTransport)
        : undefined;

      if (!transport) {
        reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: ERROR_MESSAGES.INVALID_SESSION_ID });
        return;
      }

      try {
        await transport.handleRequest(request.raw, reply.raw);
        if (!reply.sent) {
          reply.code(HTTP_STATUS.NO_CONTENT).send();
        }
      } catch (error) {
        if (!reply.sent) {
          reply
            .code(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.MCP_SESSION_DELETION_ERROR });
        }
      }
    });
  }

  // ============================================================
  // Server Lifecycle
  // ============================================================

  public async start(port = NATIVE_SERVER_PORT, nativeHost: NativeMessagingHost): Promise<void> {
    if (!this.nativeHost) {
      this.nativeHost = nativeHost;
    } else if (this.nativeHost !== nativeHost) {
      this.nativeHost = nativeHost;
    }

    if (this.isRunning) {
      return;
    }

    try {
      await this.fastify.listen({ port, host: SERVER_CONFIG.HOST });

      // Set port environment variables after successful listen for Chrome MCP URL resolution
      process.env.CHROME_MCP_PORT = String(port);
      process.env.MCP_HTTP_PORT = String(port);

      this.isRunning = true;
      this.listeningPort = port;
    } catch (err) {
      this.isRunning = false;
      this.listeningPort = null;
      throw err;
    }
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      await this.fastify.close();
      this.isRunning = false;
      this.listeningPort = null;
    } catch (err) {
      this.isRunning = false;
      this.listeningPort = null;
      throw err;
    }
  }

  public getInstance(): FastifyInstance {
    return this.fastify;
  }
}

const serverInstance = new Server();
export default serverInstance;
