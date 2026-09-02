/**
 * Admin routes — Force Reconnect 지원.
 *
 * auto-chrome-mcp fork 가 신설한 admin endpoints. Force Reconnect Stage A 의
 * 자살 패턴을 안전하게 지원하기 위한 backend.
 *
 * - GET  /health        — extension 측 readiness probe 용 (process info, uptime, transports)
 * - POST /admin/drain   — graceful drain + process.exit. Chrome 의 native messaging 이
 *                          끊김을 감지하면 우리 bridge 를 자동 respawn 한다 (extension 의
 *                          chrome.runtime.connectNative 호출 시).
 *
 * 보안: 두 엔드포인트 모두 localhost (127.0.0.1) 만 접근 가능해야 함.
 * 현재는 CORS_ORIGIN 화이트리스트 (chrome-extension://, moz-extension://,
 * http://127.0.0.1) 로 1차 차단. 향후 추가 토큰 검증 가능.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { HTTP_STATUS } from '../../constant';

export interface AdminRoutesOptions {
  /** Server class 의 graceful drain 콜백. transport 모두 닫고 process.exit(0). */
  onDrainRequested: () => Promise<void>;
  /** 현재 활성 MCP transport 수 (health probe 응답에 포함). */
  getTransportCount: () => number;
  /** Process start time (uptime 계산용). */
  startedAt: number;
}

export function registerAdminRoutes(fastify: FastifyInstance, options: AdminRoutesOptions): void {
  // ---------- GET /health ----------
  fastify.get('/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    const uptimeMs = Date.now() - options.startedAt;
    reply.status(HTTP_STATUS.OK).send({
      status: 'ok',
      fork: 'auto-chrome-mcp',
      version: '1.0.0',
      bridge: {
        pid: process.pid,
        uptime_ms: uptimeMs,
        node: process.version,
        memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      transports: {
        active_count: options.getTransportCount(),
      },
    });
  });

  // ---------- POST /admin/drain ----------
  // Force Reconnect Stage A ① — extension 이 우리에게 자살 명령.
  // 200 OK 즉시 응답 후 다음 tick 에서 drain + exit.
  // (즉시 exit 하면 응답 전송이 중단됨)
  fastify.post('/admin/drain', async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.status(HTTP_STATUS.OK).send({
      status: 'draining',
      message: 'graceful drain initiated, process will exit shortly',
      pid: process.pid,
    });

    // Schedule drain on next tick — 현재 응답이 socket 으로 flush 된 후 실행.
    setImmediate(async () => {
      try {
        console.error('[admin] /admin/drain received — graceful drain start');
        await options.onDrainRequested();
        console.error('[admin] drain complete, exiting');
      } catch (e: any) {
        console.error('[admin] drain error (still exiting):', e?.message || e);
      } finally {
        // 0 = clean exit. Chrome native messaging 이 끊김 감지 시,
        // 다음 chrome.runtime.connectNative() 호출에 자동 respawn 한다.
        process.exit(0);
      }
    });
  });

  // ---------- POST /admin/kill-self ----------
  // v1.0.6: graceful drain 보다 더 공격적. transport 정리 시도 없이 즉시 process.exit(0).
  // 좀비 bridge (drain 응답 못 함 / transport hang) 강제 청산용. nuclear option.
  fastify.post('/admin/kill-self', async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.status(HTTP_STATUS.OK).send({
      status: 'killing',
      message: 'process.exit(0) on next tick — no graceful drain',
      pid: process.pid,
    });
    setImmediate(() => {
      console.error('[admin] /admin/kill-self received — immediate exit');
      process.exit(0);
    });
  });
}
