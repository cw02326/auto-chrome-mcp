// npm 에 발행된 우리 패키지의 primary bin 이름. doctor 가 안내하는 모든 복구 명령
// (npm install -g ... / ... doctor --fix) 에 쓰이므로 실제 패키지명과 반드시 일치해야 한다.
// 이전 패키지 이름은 npm 에서 타 계정 소유라 안내하면 안 된다.
export const COMMAND_NAME = 'auto-chrome-mcp-bridge';
/**
 * auto-chrome-mcp fork extension ID (deterministic — derived from manifest.key in wxt.config.ts).
 * 모든 사용자가 같은 ID 받음 → register 한 번이면 끝.
 */
export const EXTENSION_ID = 'aogfhfajjknomcnmlkbjmihjbknlhbbi';
/**
 * v1.0.2 부터 fork 전용 host name. upstream (`com.chromemcp.nativehost`) 과
 * 완전 분리되어 manifest 파일이 겹치지 않음.
 */
export const HOST_NAME = 'com.autochromemcp.nativehost';
export const DESCRIPTION = 'Node.js Host for Browser Bridge Extension (auto-chrome-mcp)';
