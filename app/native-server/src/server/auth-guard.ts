/**
 * 로컬 HTTP 브리지 인증 게이트.
 *
 * CORS 는 "응답을 읽을 수 있는지"만 통제한다. 요청 자체는 실행된다. 그래서 인증 없이는
 * 아무 웹페이지나 한 방으로 `/admin/kill-self` 를 눌러 브리지를 죽이고 `/mcp` 로 새 MCP
 * 세션을 열 수 있었다. 이 훅이 그걸 막는다.
 *
 * 판정 순서:
 *   ① Host 가 loopback 이름(`127.0.0.1` / `localhost` / `[::1]`)이고 listen 포트와 맞는가.
 *      아니면 403. 공개 경로도 예외가 아니다 — Origin 만 보면 DNS rebinding
 *      (attacker.example → 127.0.0.1) 을 막을 수 없다. 그때 브라우저는 same-origin 이라
 *      판단해 Origin 헤더를 붙이지 않는다.
 *   ② CORS preflight(OPTIONS) 는 헤더를 실을 수 없으니 통과. 실제 요청이 다시 이 게이트를 지난다.
 *   ③ 공개 경로(`/ping`, `/health`)는 토큰 없이 통과. 부작용 없는 상태 조회 둘뿐이다.
 *      단 토큰 판정은 공개 경로에서도 해 둔다. `/health` 가 상세(pid·node·메모리·세션 수)를
 *      줄지 말지 그 결과로 정한다.
 *   ④ Origin 헤더가 있으면 허용 목록(확장 origin / loopback) 안이어야 한다. 밖이면 403.
 *   ⑤ 나머지는 전부 `Authorization: Bearer <token>` 이 `~/.auto-chrome-mcp/auth-token` 과
 *      일치해야 한다 (상수 시간 비교). 예외는 없다.
 *
 * 예전에는 확장 origin 을 신원으로 인정해 토큰 없이 통과시켰다. 그 예외는 제거했다:
 * Origin 헤더는 브라우저가 붙일 때만 의미가 있고, 같은 머신의 다른 프로세스는 아무 값이나
 * 붙일 수 있다. 확장은 이제 네이티브 호스트가 SERVER_STARTED 로 넘겨준 토큰을 쓴다.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HTTP_STATUS, ERROR_MESSAGES } from '../constant';
import { extractBearerToken, tokensMatch, getTokenFilePath } from '../security/auth-token';
import { isAllowedCorsOrigin, isAllowedHostHeader, isExtensionOrigin } from '../security/origin';

/** 인증 없이 열어두는 경로 (부작용 없는 상태 조회만). */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/ping', '/health']);

/** 대체 헤더 — Authorization 을 쓰기 어려운 클라이언트용. */
export const TOKEN_HEADER = 'x-auto-chrome-mcp-token';

export const normalizeRoutePath = (url: unknown): string => {
  const raw = typeof url === 'string' ? url : '';
  const withoutQuery = raw.split('?')[0].split('#')[0];
  if (withoutQuery.length > 1 && withoutQuery.endsWith('/')) {
    return withoutQuery.replace(/\/+$/, '') || '/';
  }
  return withoutQuery || '/';
};

export const isPublicPath = (url: unknown): boolean => PUBLIC_PATHS.has(normalizeRoutePath(url));

export interface AuthDecisionInput {
  method: string;
  url: string;
  headers: Record<string, unknown>;
  /** 브리지가 들고 있는 정답 토큰. null 이면 토큰 인증 자체가 불가(= 보호 경로 전부 401). */
  expectedToken: string | null;
  /** listen 중인 포트. null 이면 Host 의 포트는 검사하지 않는다(listen 전 / 테스트). */
  expectedPort?: number | null;
}

export interface AuthDecision {
  allowed: boolean;
  /** 통과 근거 / 거절 사유 코드. */
  reason: 'public' | 'preflight' | 'token' | 'bad_host' | 'bad_origin' | 'unauthorized';
  /** 올바른 토큰을 제시했는가. 공개 경로에서도 계산한다 (/health 의 상세 노출 여부). */
  tokenValid: boolean;
  status?: number;
  body?: { error: string; reason: string; hint?: string };
}

/** 요청에 실린 토큰만 뽑는다 (Authorization 우선, 대체 헤더 허용). */
export const presentedToken = (headers: Record<string, unknown>): string | null =>
  extractBearerToken(headers['authorization']) ??
  (typeof headers[TOKEN_HEADER] === 'string' ? (headers[TOKEN_HEADER] as string) : null);

export const decideAuthorization = (input: AuthDecisionInput): AuthDecision => {
  // 토큰 판정은 경로와 무관하게 먼저 해 둔다. 공개 경로도 "토큰을 들고 왔는지"를 알아야
  // 상세 정보를 줄지 말지 결정할 수 있다.
  const tokenValid = Boolean(
    input.expectedToken && tokensMatch(presentedToken(input.headers), input.expectedToken),
  );

  // ① Host — 전 경로 공통. DNS rebinding 은 Origin 을 남기지 않는다.
  if (!isAllowedHostHeader(input.headers['host'], input.expectedPort ?? null)) {
    return {
      allowed: false,
      reason: 'bad_host',
      tokenValid,
      status: HTTP_STATUS.FORBIDDEN,
      body: {
        error: ERROR_MESSAGES.FORBIDDEN_HOST,
        reason: 'bad_host',
      },
    };
  }

  // ② CORS preflight 는 헤더를 실을 수 없다. 실제 요청이 다시 이 게이트를 지난다.
  if ((input.method || '').toUpperCase() === 'OPTIONS') {
    return { allowed: true, reason: 'preflight', tokenValid };
  }

  // ③ 공개 경로 — 부작용 없는 상태 조회.
  if (isPublicPath(input.url)) {
    return { allowed: true, reason: 'public', tokenValid };
  }

  // ④ Origin 헤더가 있으면 허용 목록 안이어야 한다 (브라우저가 붙인 값이면 위조 불가).
  const origin = input.headers['origin'];
  if (typeof origin === 'string' && origin.length > 0 && !isAllowedCorsOrigin(origin)) {
    return {
      allowed: false,
      reason: 'bad_origin',
      tokenValid,
      status: HTTP_STATUS.FORBIDDEN,
      body: {
        error: ERROR_MESSAGES.FORBIDDEN_ORIGIN,
        reason: 'bad_origin',
      },
    };
  }

  // ⑤ 토큰 — 유일한 신원 증명. 확장도 예외가 아니다.
  if (tokenValid) {
    return { allowed: true, reason: 'token', tokenValid };
  }

  return {
    allowed: false,
    reason: 'unauthorized',
    tokenValid,
    status: HTTP_STATUS.UNAUTHORIZED,
    body: {
      error: ERROR_MESSAGES.UNAUTHORIZED,
      reason: 'unauthorized',
      hint: `Send "Authorization: Bearer <token>" with the token in ${getTokenFilePath()}. The extension gets the same token in the SERVER_STARTED message; update the extension if its Force Reconnect returns 401. Run "auto-chrome-mcp-bridge doctor" if the token file is missing.`,
    },
  };
};

/** 요청 객체에 인증 결과를 적어 두는 자리. 라우트가 상세 응답 여부를 여기서 읽는다. */
const AUTH_STATE_KEY = 'acmTokenAuthenticated';

/** 이 요청이 올바른 토큰을 들고 왔는가. 훅을 안 거친 요청은 false. */
export const isRequestAuthenticated = (request: FastifyRequest): boolean =>
  (request as unknown as Record<string, unknown>)[AUTH_STATE_KEY] === true;

/**
 * 옛 확장 감지 (Codex 2차 지적 6).
 *
 * 브리지는 SERVER_STARTED 로 토큰을 넘기지만, 확장이 보내는 START 메시지에는 auth 지원
 * 여부가 없다. 그래서 "토큰을 받고도 안 쓰는 옛 확장"과 "그냥 아직 안 붙은 확장"을
 * 핸드셰이크만으로는 구분할 수 없다. 대신 확장 origin 이 붙은 요청이 토큰 없이 들어와
 * 401 을 받는 것을 세어 둔다. 브라우저가 붙인 확장 origin 은 위조할 수 없으므로,
 * 이 신호는 사실상 "우리 확장이 토큰 없이 말을 걸었다"는 뜻이다.
 */
export interface StaleExtensionReport {
  /** 토큰 없이 들어와 거절된 확장 origin 요청 수. */
  rejections: number;
  /** 마지막 발생 시각 (epoch ms). 0 이면 없었다. */
  lastAt: number;
  /** 마지막으로 거절된 확장 origin. */
  lastOrigin?: string;
}

let staleExtension: StaleExtensionReport = { rejections: 0, lastAt: 0 };
let staleExtensionWarned = false;

export const getStaleExtensionReport = (): StaleExtensionReport => ({ ...staleExtension });

export const resetStaleExtensionReport = (): void => {
  staleExtension = { rejections: 0, lastAt: 0 };
  staleExtensionWarned = false;
};

const noteStaleExtension = (origin: string): void => {
  staleExtension = {
    rejections: staleExtension.rejections + 1,
    lastAt: Date.now(),
    lastOrigin: origin,
  };
  if (!staleExtensionWarned) {
    staleExtensionWarned = true;
    console.error(
      `[auth] extension origin ${origin} called without a token. ` +
        'The bridge hands the token to the extension in SERVER_STARTED, so this means the ' +
        'installed extension is older than the bridge. Reload the extension after rebuilding it.',
    );
  }
};

/**
 * Fastify 인스턴스에 인증 훅을 붙인다.
 *
 * @param getExpectedToken 요청 시점에 정답 토큰을 돌려주는 함수 (메모리 토큰 우선, 없으면 파일).
 * @param getExpectedPort  요청 시점의 listen 포트 (아직 listen 전이면 null).
 */
export const registerAuthGuard = (
  fastify: FastifyInstance,
  getExpectedToken: () => string | null,
  getExpectedPort: () => number | null = () => null,
): void => {
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const headers = request.headers as Record<string, unknown>;
    const decision = decideAuthorization({
      method: request.method,
      url: request.url,
      headers,
      expectedToken: getExpectedToken(),
      expectedPort: getExpectedPort(),
    });

    (request as unknown as Record<string, unknown>)[AUTH_STATE_KEY] = decision.tokenValid;

    if (decision.allowed) return;

    const origin = headers['origin'];
    if (
      decision.reason === 'unauthorized' &&
      presentedToken(headers) === null &&
      typeof origin === 'string' &&
      isExtensionOrigin(origin)
    ) {
      noteStaleExtension(origin);
    }

    console.error(
      `[auth] rejected ${request.method} ${normalizeRoutePath(request.url)} (${decision.reason})`,
    );
    await reply
      .status(decision.status ?? HTTP_STATUS.UNAUTHORIZED)
      .send(decision.body ?? { error: ERROR_MESSAGES.UNAUTHORIZED, reason: decision.reason });
  });
};
