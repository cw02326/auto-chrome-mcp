export const COMMAND_NAME = 'mcp-chrome-scalemaker-bridge';
/**
 * auto-chrome-mcp fork extension ID (deterministic — derived from manifest.key in wxt.config.ts).
 * 모든 사용자가 같은 ID 받음 → register 한 번이면 끝.
 */
export const EXTENSION_ID = 'aogfhfajjknomcnmlkbjmihjbknlhbbi';
/**
 * v1.0.2 부터 fork 전용 host name. upstream (`com.chromemcp.nativehost`) 과
 * 완전 분리되어 manifest 파일이 겹치지 않음.
 */
export const HOST_NAME = 'com.chromemcpscalemaker.nativehost';
export const DESCRIPTION = 'Node.js Host for Browser Bridge Extension (auto-chrome-mcp)';
