export enum NATIVE_MESSAGE_TYPE {
  START = 'start',
  STARTED = 'started',
  STOP = 'stop',
  STOPPED = 'stopped',
  PING = 'ping',
  PONG = 'pong',
  ERROR = 'error',
}

// v1.0.2 부터 fork 전용 포트 — upstream (12306) 과 분리.
export const NATIVE_SERVER_PORT = 12320;

// Timeout constants (in milliseconds)
export const TIMEOUTS = {
  DEFAULT_REQUEST_TIMEOUT: 15000,
  EXTENSION_REQUEST_TIMEOUT: 20000,
  PROCESS_DATA_TIMEOUT: 20000,
} as const;

// Server configuration
export const SERVER_CONFIG = {
  HOST: '127.0.0.1',
  /**
   * CORS origin whitelist - only allow Chrome/Firefox extensions and local debugging.
   * Use RegExp patterns for extension origins, string for exact match.
   *
   * 실제 판정은 src/security/origin.ts 가 한다 (URL 파싱). 이 목록은 문서·호환용으로만
   * 남겨 둔다. 문자열 prefix 비교는 http://127.0.0.1.attacker.example 을 통과시켰다.
   */
  CORS_ORIGIN: [/^chrome-extension:\/\//, /^moz-extension:\/\//, 'http://127.0.0.1'] as const,
  LOGGER_ENABLED: false,
} as const;

// HTTP Status codes
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INTERNAL_SERVER_ERROR: 500,
  GATEWAY_TIMEOUT: 504,
} as const;

// Error messages
export const ERROR_MESSAGES = {
  NATIVE_HOST_NOT_AVAILABLE: 'Native host connection not established.',
  SERVER_NOT_RUNNING: 'Server is not actively running.',
  REQUEST_TIMEOUT: 'Request to extension timed out.',
  INVALID_MCP_REQUEST: 'Invalid MCP request or session.',
  INVALID_SESSION_ID: 'Invalid or missing MCP session ID.',
  INTERNAL_SERVER_ERROR: 'Internal Server Error',
  MCP_SESSION_DELETION_ERROR: 'Internal server error during MCP session deletion.',
  MCP_REQUEST_PROCESSING_ERROR: 'Internal server error during MCP request processing.',
  INVALID_SSE_SESSION: 'Invalid or missing MCP session ID for SSE.',
  UNAUTHORIZED: 'Missing or invalid bridge auth token.',
  FORBIDDEN_ORIGIN: 'Origin is not allowed to reach the local bridge.',
  FORBIDDEN_HOST: 'Host header must address the local bridge (127.0.0.1, localhost or [::1]).',
} as const;

// ============================================================
// Chrome MCP Server Configuration
// ============================================================

/**
 * Environment variables for dynamically resolving the local MCP HTTP endpoint.
 * CHROME_MCP_PORT is the preferred source; MCP_HTTP_PORT is kept for backward compatibility.
 */
export const CHROME_MCP_PORT_ENV = 'CHROME_MCP_PORT';
export const MCP_HTTP_PORT_ENV = 'MCP_HTTP_PORT';

/**
 * Environment variable for the MCP server host.
 */
export const CHROME_MCP_HOST_ENV = 'CHROME_MCP_HOST';

/**
 * Get the actual host the Chrome MCP server is listening on.
 * Uses CHROME_MCP_HOST env, falls back to default HOST.
 */
export function getChromeMcpHost(): string {
  return process.env[CHROME_MCP_HOST_ENV] || SERVER_CONFIG.HOST;
}

/**
 * Get the actual port the Chrome MCP server is listening on.
 * Priority: CHROME_MCP_PORT env > MCP_HTTP_PORT env > NATIVE_SERVER_PORT default
 */
export function getChromeMcpPort(): number {
  const raw = process.env[CHROME_MCP_PORT_ENV] || process.env[MCP_HTTP_PORT_ENV];
  const port = raw ? Number.parseInt(String(raw), 10) : NaN;
  return Number.isFinite(port) && port > 0 && port <= 65535 ? port : NATIVE_SERVER_PORT;
}

/**
 * Get the full URL to the local Chrome MCP HTTP endpoint.
 * This URL is used by Claude/Codex agents to connect to the MCP server.
 */
export function getChromeMcpUrl(): string {
  return `http://${getChromeMcpHost()}:${getChromeMcpPort()}/mcp`;
}
