/**
 * Sidepanel Composables (auto-chrome-mcp v1.0.36, agent chat 제거 후 남은 항목)
 */

// Theme system (sidepanel + popup + welcome 의 공통 디자인 토큰)
export { useAgentTheme, preloadAgentTheme, THEME_LABELS } from './useAgentTheme';
export type { AgentThemeId, UseAgentTheme } from './useAgentTheme';

// RR V3 (record-replay) Composables
export { useRRV3Rpc } from './useRRV3Rpc';
export { useRRV3Debugger } from './useRRV3Debugger';
export type { UseRRV3Rpc, UseRRV3RpcOptions, RpcRequestOptions } from './useRRV3Rpc';
export type { UseRRV3Debugger, UseRRV3DebuggerOptions } from './useRRV3Debugger';

// Workflows V3 (사용처: sidepanel/App.vue 의 workflows 탭)
export { useWorkflowsV3 } from './useWorkflowsV3';
export type { FlowLite } from './useWorkflowsV3';

// 녹화 버튼 상태 (2026-09-05 사이드패널 1단계 A)
export { useRecorder, formatElapsed } from './useRecorder';
