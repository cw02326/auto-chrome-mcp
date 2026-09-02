import { createApp } from 'vue';
import { NativeMessageType } from 'auto-chrome-mcp-shared';
import './style.css';
// agent-theme 디자인 토큰 시스템 (popup/sidepanel/welcome 공통). v1.0.36 에서
// chat UI 는 제거됐으나 CSS 변수 (--ac-*) 는 popup 색 시스템의 기반이라 유지.
import '../sidepanel/styles/agent-chat.css';
import { preloadAgentTheme } from '../sidepanel/composables/useAgentTheme';
import App from './App.vue';

// 테마 preload 로 mount 시 색 깜빡임 차단
preloadAgentTheme().then(() => {
  // Trigger ensure native connection (fire-and-forget, don't block UI mounting)
  void chrome.runtime.sendMessage({ type: NativeMessageType.ENSURE_NATIVE }).catch(() => {
    // Silent failure - background will handle reconnection
  });
  createApp(App).mount('#app');
});
