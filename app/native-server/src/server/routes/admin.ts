/**
 * Admin routes — Force Reconnect 지원.
 *
 * auto-chrome-mcp fork 가 신설한 admin endpoints. Force Reconnect Stage A 의
 * 자살 패턴을 안전하게 지원하기 위한 backend.
 *
 * - GET  /health        — readiness probe. 토큰 없이도 살아 있는지는 답하지만, 상세는
 *                          토큰이 있을 때만 준다.
 * - POST /admin/drain   — graceful drain + process.exit. Chrome 의 native messaging 이
 *                          끊김을 감지하면 우리 bridge 를 자동 respawn 한다 (extension 의
 *                          chrome.runtime.connectNative 호출 시).
 *
 * 보안: /admin/* 은 auth-guard 가 토큰을 요구한다. /health 는 공개지만, 인증 없이는
 * pid·node 버전·메모리·transport 수를 주지 않는다. 아무 웹페이지나 로컬 브리지에 GET 을
 * 날려 그 값들을 읽어갈 수 있었기 때문이다 (프로세스 지문·핑거프린팅). 확장 팝업의
 * 진단·강제 재연결은 토큰을 붙이므로 상세를 계속 받는다.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { HTTP_STATUS } from '../../constant';
import { getStaleExtensionReport, isRequestAuthenticated } from '../auth-guard';

export interface AdminRoutesOptions {
  /** Server class 의 graceful drain 콜백. transport 모두 닫고 process.exit(0). */
  onDrainRequested: () => Promise<void>;
  /** 현재 활성 MCP transport 수 (health probe 응답에 포함). */
  getTransportCount: () => number;
  /** Process start time (uptime 계산용). */
  startedAt: number;
  /** 이 요청이 토큰 인증을 통과했는가. 기본값은 auth-guard 가 남긴 표시를 읽는다. */
  isAuthenticated?: (request: FastifyRequest) => boolean;
}

export function registerAdminRoutes(fastify: FastifyInstance, options: AdminRoutesOptions): void {
  const authenticated = options.isAuthenticated ?? isRequestAuthenticated;

  // ---------- GET /health ----------
  fastify.get('/health', async (request: FastifyRequest, reply: FastifyReply) => {
    const body: Record<string, unknown> = {
      status: 'ok',
      fork: 'auto-chrome-mcp',
      version: '1.0.0',
    };

    if (authenticated(request)) {
      const stale = getStaleExtensionReport();
      body.bridge = {
        pid: process.pid,
        uptime_ms: Date.now() - options.startedAt,
        node: process.version,
        memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      };
      body.transports = { active_count: options.getTransportCount() };
      // 확장이 토큰을 안 쓰고 있으면 여기에 남는다 (doctor 가 읽어 "확장 버전 낮음"으로 보고).
      body.extension_auth = {
        stale_client_rejections: stale.rejections,
        last_at: stale.lastAt,
        ...(stale.lastOrigin ? { last_origin: stale.lastOrigin } : {}),
      };
    }

    reply.status(HTTP_STATUS.OK).send(body);
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
