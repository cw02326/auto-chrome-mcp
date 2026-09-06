import { createApp } from 'vue';
// 사이드패널·팝업과 같은 디자인 토큰(.agent-theme 의 --ac-* 와 .ac-* 프리미티브).
import '@/ui/theme.css';
import App from './App.vue';

// 탭 제목도 i18n 값으로. index.html 의 정적 제목은 스크립트가 뜨기 전 한 순간만 보인다.
try {
  const title = globalThis.chrome?.i18n?.getMessage('options_page_title');
  if (title) document.title = title;
} catch {
  // i18n 을 못 읽으면 index.html 의 제목을 그대로 둔다.
}

createApp(App).mount('#app');
