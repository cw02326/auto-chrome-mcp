import { createApp } from 'vue';
import { NativeMessageType } from 'auto-chrome-mcp-shared';
import './style.css';
// 사이드패널·팝업·옵션이 함께 쓰는 디자인 토큰과 .ac-* 프리미티브.
import '@/ui/theme.css';
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
