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
import { registerAuthGuard } from './auth-guard';
import { ensureAuthToken, readAuthToken } from '../security/auth-token';
import { startupArtifactCleanup } from '../artifacts/cleanup';
import {
  collectExtensionOriginsFromArgv,
  isAllowedCorsOrigin,
  setTrustedExtensionOrigins,
} from '../security/origin';

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
  /**
   * 이 브리지의 bearer 토큰 (start() 에서 생성/로드). 파일에 못 써도 메모리 값으로
   * 인증은 유지한다 — 그때는 stdio 프록시가 토큰을 못 읽으니 doctor 가 알려준다.
   */
  private authToken: string | null = null;

  constructor() {
    this.fastify = Fastify({ logger: SERVER_CONFIG.LOGGER_ENABLED });
    this.setupPlugins();
    this.setupRoutes();
  }

  /**
   * 인증에 쓸 정답 토큰. 메모리 값 우선, 없으면 토큰 파일에서 읽는다
   * (테스트나 start() 이전 요청도 파일이 있으면 인증된다).
   */
  private getExpectedToken(): string | null {
    return this.authToken ?? readAuthToken();
  }

  /**
   * 이 브리지의 bearer 토큰. 네이티브 호스트가 SERVER_STARTED 로 확장에 넘겨준다
   * (확장은 파일을 읽을 수 없으므로 이 경로가 유일한 전달 수단이다).
   */
  public getAuthToken(): string | null {
    return this.getExpectedToken();
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
        // Allow requests with no origin (e.g., curl, server-to-server).
        // 부작용이 있는 경로는 auth-guard 가 토큰을 따로 검사한다.
        if (!origin) {
          return cb(null, true);
        }
        // origin 은 문자열 prefix 가 아니라 URL 로 파싱해 비교한다.
        // (예전 startsWith('http://127.0.0.1') 는 http://127.0.0.1.attacker.example 을 통과시켰다)
        cb(null, isAllowedCorsOrigin(origin));
      },
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      credentials: true,
    });
  }

  private setupRoutes(): void {
    // 인증 게이트 — 라우트 등록보다 먼저 붙인다. /ping, /health 만 공개.
    registerAuthGuard(
      this.fastify,
      () => this.getExpectedToken(),
      () => this.listeningPort,
    );

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

  /**
   * hijack 한 응답에서 에러를 마무리한다.
   *
   * hijack 이후에는 Fastify 의 reply.code().send() 를 쓸 수 없고, reply.sent 도 raw 쓰기를
   * 반영하지 않는다. 그래서 raw 소켓 상태(headersSent / writableEnded)만 보고 판단한다.
   */
  private endRawWithError(reply: FastifyReply, status: number, message: unknown): void {
    try {
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(status, { 'Content-Type': 'application/json' });
        reply.raw.end(JSON.stringify({ error: message }));
      } else if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    } catch {
      // 소켓이 이미 끊긴 경우 — 더 할 수 있는 게 없다.
    }
  }

  private setupMcpRoutes(): void {
    // SSE endpoint
    this.fastify.get('/sse', async (_, reply) => {
      // transport 가 reply.raw 에 직접 쓰므로 Fastify 의 자체 응답을 먼저 끈다.
      reply.hijack();
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
        this.endRawWithError(
          reply,
          HTTP_STATUS.INTERNAL_SERVER_ERROR,
          ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        );
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

        reply.hijack();
        await transport.handlePostMessage(req.raw, reply.raw, req.body);
      } catch (error) {
        this.endRawWithError(
          reply,
          HTTP_STATUS.INTERNAL_SERVER_ERROR,
          ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        );
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

      // transport 가 reply.raw 로 직접 응답을 쓴다. hijack 하지 않으면 핸들러가 끝난 뒤
      // Fastify 가 자체 응답을 한 번 더 보내려다 ERR_HTTP_HEADERS_SENT 가 쏟아진다.
      reply.hijack();
      try {
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch (error) {
        this.endRawWithError(
          reply,
          HTTP_STATUS.INTERNAL_SERVER_ERROR,
          ERROR_MESSAGES.MCP_REQUEST_PROCESSING_ERROR,
        );
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

      // hijack 만 하고 SSE 헤더는 transport 에 맡긴다. MCP SDK 는 내부적으로
      // @hono/node-server 로 응답 헤더를 직접 writeHead 하므로, 여기서 미리
      // flushHeaders() 하면 요청마다 ERR_HTTP_HEADERS_SENT 가 쏟아진다.
      reply.hijack();

      try {
        await transport.handleRequest(request.raw, reply.raw);
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

      reply.hijack();
      try {
        await transport.handleRequest(request.raw, reply.raw);
        // transport 가 아무것도 안 썼을 때만 204 로 마무리한다.
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(HTTP_STATUS.NO_CONTENT);
          reply.raw.end();
        } else if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      } catch (error) {
        this.endRawWithError(
          reply,
          HTTP_STATUS.INTERNAL_SERVER_ERROR,
          ERROR_MESSAGES.MCP_SESSION_DELETION_ERROR,
        );
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

    // listen 전에 토큰을 확보한다 — 포트가 열린 순간부터 인증이 가능해야 한다.
    const tokenResult = ensureAuthToken();
    this.authToken = tokenResult.token;
    if (!tokenResult.persisted) {
      console.error(
        '[auth] token file could not be written; the stdio proxy will not be able to read it. ' +
          'Run "auto-chrome-mcp-bridge doctor" for details.',
      );
    } else if (tokenResult.insecure) {
      // 잠금 실패로 서버를 멈추지는 않는다 (사용자 PC 는 대개 단일 계정 — 가용성 우선).
      // 대신 여기와 doctor 양쪽에서 분명히 알린다.
      console.error(
        '[auth] the token file or its directory could not be locked down to the current user. ' +
          'The bridge keeps running, but another local account could read the token. ' +
          'Run "auto-chrome-mcp-bridge doctor" for the fix command.',
      );
    }
    // Chrome 은 native host 를 띄울 때 호출자 origin(chrome-extension://<id>/)을 인자로 준다.
    // 이 값은 로그·doctor 정보용으로만 기록한다 — 인증은 토큰 하나로만 판정한다.
    const callerOrigins = collectExtensionOriginsFromArgv(process.argv);
    setTrustedExtensionOrigins(callerOrigins);
    console.error(
      `[bridge] caller extension origins: ${callerOrigins.length > 0 ? callerOrigins.join(', ') : '(none passed by the launcher)'}`,
    );

    try {
      await this.fastify.listen({ port, host: SERVER_CONFIG.HOST });

      // Set port environment variables after successful listen for Chrome MCP URL resolution
      process.env.CHROME_MCP_PORT = String(port);
      process.env.MCP_HTTP_PORT = String(port);

      this.isRunning = true;
      this.listeningPort = port;

      // 산출물 정리는 listen 이 끝난 뒤에 비동기로 돈다. 실패해도 서버에는 영향이 없다.
      startupArtifactCleanup();
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
