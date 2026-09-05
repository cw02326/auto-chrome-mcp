<script setup lang="ts">
import { computed, ref } from 'vue';

import '@/ui/theme.css';

// Query string 파싱
const params = new URLSearchParams(window.location.search);
const requestId = params.get('id') || '';
const action = (params.get('action') || 'camera') as 'camera' | 'microphone' | 'geolocation';
const reason = params.get('reason') || '(이유 없음)';
const origin = params.get('origin') || '(unknown)';

const ICONS: Record<string, string> = {
  camera: '📷',
  microphone: '🎤',
  geolocation: '📍',
};

const LABELS: Record<string, string> = {
  camera: '카메라 사용',
  microphone: '마이크 사용',
  geolocation: '위치 정보 사용',
};

const icon = computed(() => ICONS[action] || '🔒');
const label = computed(() => LABELS[action] || action);

const rememberCheck = ref(false);
const sending = ref(false);

async function respond(approved: boolean): Promise<void> {
  if (sending.value) return;
  sending.value = true;
  try {
    await chrome.runtime.sendMessage({
      type: 'CONSENT_RESPONSE',
      id: requestId,
      approved,
      remember: approved && rememberCheck.value,
    });
  } catch (e) {
    console.error('[consent] send response failed:', e);
  } finally {
    window.close();
  }
}
</script>

<template>
  <div class="consent-root">
    <div class="consent-card">
      <header class="consent-header">
        <span class="consent-icon" aria-hidden="true">{{ icon }}</span>
        <h1 class="consent-title">{{ label }} 요청</h1>
      </header>

      <div class="consent-body">
        <div class="consent-row">
          <span class="consent-label">이유</span>
          <span class="consent-value">{{ reason }}</span>
        </div>
        <div class="consent-row">
          <span class="consent-label">사이트</span>
          <span class="consent-value consent-origin">{{ origin }}</span>
        </div>
      </div>

      <label class="consent-remember">
        <input v-model="rememberCheck" type="checkbox" />
        <span>다음부터 묻지 않기 (토글 ON)</span>
      </label>

      <footer class="consent-actions">
        <button class="consent-btn consent-btn--deny" :disabled="sending" @click="respond(false)">
          거부
        </button>
        <button class="consent-btn consent-btn--allow" :disabled="sending" @click="respond(true)">
          이번만 허용
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.consent-root {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--ac-bg, #faf7f2);
  padding: 16px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans KR', system-ui, sans-serif;
}

.consent-card {
  width: 100%;
  max-width: 380px;
  background: var(--ac-surface, #ffffff);
  border: 1px solid var(--ac-border, #e2dcd2);
  border-radius: 12px;
  padding: 20px;
  box-shadow: 0 4px 12px rgba(15, 23, 42, 0.08);
}

.consent-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.consent-icon {
  font-size: 28px;
  line-height: 1;
}

.consent-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--ac-text, #1e293b);
  margin: 0;
}

.consent-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 0;
  border-top: 1px solid var(--ac-border, #e2dcd2);
  border-bottom: 1px solid var(--ac-border, #e2dcd2);
  margin-bottom: 14px;
}

.consent-row {
  display: flex;
  gap: 10px;
  font-size: 13px;
}

.consent-label {
  flex-shrink: 0;
  width: 48px;
  color: var(--ac-text-muted, #64748b);
}

.consent-value {
  color: var(--ac-text, #1e293b);
  word-break: break-word;
}

.consent-origin {
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 12px;
}

.consent-remember {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--ac-text-muted, #64748b);
  margin-bottom: 14px;
  cursor: pointer;
  user-select: none;
}

.consent-actions {
  display: flex;
  gap: 8px;
}

.consent-btn {
  flex: 1;
  padding: 10px 0;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid var(--ac-border, #e2dcd2);
  background: var(--ac-surface, #ffffff);
  color: var(--ac-text, #1e293b);
  transition: all 0.15s ease;
}

.consent-btn:hover:not(:disabled) {
  background: var(--ac-hover-bg-subtle, #f1f5f9);
}

.consent-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.consent-btn--allow {
  background: var(--ac-accent, #d97757);
  color: var(--ac-accent-contrast, #ffffff);
  border-color: var(--ac-accent, #d97757);
}

.consent-btn--allow:hover:not(:disabled) {
  background: var(--ac-accent-hover, #c4664a);
  border-color: var(--ac-accent-hover, #c4664a);
}
</style>
