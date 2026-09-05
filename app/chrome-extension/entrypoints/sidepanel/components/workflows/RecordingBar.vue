<template>
  <div class="rec-bar" :style="barStyle">
    <!-- 쉬는 중: 시작 버튼과 짧은 안내 -->
    <template v-if="!recording">
      <button
        class="rec-btn rec-btn-start"
        :style="startStyle"
        :disabled="busy"
        @click="$emit('start')"
      >
        <span class="rec-dot rec-dot-idle"></span>
        <span>{{ getMessage('sidepanel_record_start') }}</span>
      </button>
      <span class="rec-hint" :style="hintStyle">{{ getMessage('sidepanel_record_hint') }}</span>
    </template>

    <!-- 녹화 중: 빨간 점 + 경과 시간 + 잡힌 단계 수 + 중지 버튼 -->
    <template v-else>
      <span class="rec-dot rec-dot-live"></span>
      <span class="rec-state" :style="stateStyle">{{ stateText }}</span>
      <span class="rec-meta" :style="hintStyle">{{ elapsedText }}</span>
      <span class="rec-meta" :style="hintStyle">{{
        getMessage('sidepanel_record_steps', [String(stepCount)])
      }}</span>
      <button
        class="rec-btn rec-btn-stop"
        :style="stopStyle"
        :disabled="busy"
        @click="$emit('stop')"
      >
        {{ getMessage('sidepanel_record_stop') }}
      </button>
    </template>
  </div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import { getMessage } from '@/utils/i18n';
import { formatElapsed } from '../../composables/useRecorder';

const props = defineProps<{
  /** 녹화 중인가 (일시정지·중지 진행 중 포함). */
  recording: boolean;
  /** 백그라운드가 알려 준 현재 상태. */
  status: 'idle' | 'recording' | 'paused' | 'stopping';
  /** 지금까지 잡힌 단계 수. */
  stepCount: number;
  /** 녹화 시작 후 흐른 시간(ms). */
  elapsedMs: number;
  /** 시작·중지 요청을 보내는 중인가. */
  busy: boolean;
}>();

defineEmits<{
  (e: 'start'): void;
  (e: 'stop'): void;
}>();

const elapsedText = computed(() => formatElapsed(props.elapsedMs));

const stateText = computed(() => {
  if (props.status === 'paused') return getMessage('sidepanel_record_paused');
  if (props.status === 'stopping') return getMessage('sidepanel_record_stopping');
  return getMessage('sidepanel_record_recording');
});

const barStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface)',
  borderBottom: 'var(--ac-border-width, 1px) solid var(--ac-border, #e7e5e4)',
}));

const hintStyle = computed(() => ({ color: 'var(--ac-text-subtle)' }));
const stateStyle = computed(() => ({ color: 'var(--ac-text)' }));

const startStyle = computed(() => ({
  backgroundColor: 'var(--ac-accent)',
  color: 'var(--ac-accent-contrast)',
  borderRadius: 'var(--ac-radius-button)',
}));

const stopStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface-muted)',
  color: 'var(--ac-text)',
  borderRadius: 'var(--ac-radius-button)',
}));
</script>

<style scoped>
.rec-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  flex-shrink: 0;
}

.rec-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  padding: 6px 12px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}

.rec-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.rec-btn-stop {
  margin-left: auto;
}

.rec-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
}

.rec-dot-idle {
  background-color: currentColor;
  opacity: 0.85;
}

.rec-dot-live {
  background-color: var(--ac-danger, #ef4444);
  animation: rec-pulse 1.4s ease-in-out infinite;
}

.rec-state {
  font-size: 13px;
  font-weight: 600;
}

.rec-meta,
.rec-hint {
  font-size: 12px;
}

.rec-hint {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@keyframes rec-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}
</style>
