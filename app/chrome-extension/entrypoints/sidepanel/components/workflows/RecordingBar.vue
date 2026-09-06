<template>
  <div class="rec-bar">
    <div class="rec-card ac-card">
      <!-- 쉬는 중: 시작 버튼과 짧은 안내 -->
      <template v-if="!recording">
        <button class="ac-button ac-button--primary" :disabled="busy" @click="$emit('start')">
          <span class="rec-dot rec-dot-idle"></span>
          <span>{{ getMessage('sidepanel_record_start') }}</span>
        </button>
        <span class="rec-hint ac-caption">{{ getMessage('sidepanel_record_hint') }}</span>
      </template>

      <!-- 녹화 중: 빨간 점 + 경과 시간 + 잡힌 단계 수 + 중지 버튼 -->
      <template v-else>
        <span class="rec-dot rec-dot-live"></span>
        <span class="rec-state">{{ stateText }}</span>
        <span class="rec-meta ac-caption ac-num">{{ elapsedText }}</span>
        <span class="rec-meta ac-caption ac-num">{{
          getMessage('sidepanel_record_steps', [String(stepCount)])
        }}</span>
        <button class="ac-button ac-button--ghost rec-stop" :disabled="busy" @click="$emit('stop')">
          {{ getMessage('sidepanel_record_stop') }}
        </button>
      </template>
    </div>
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
</script>

<style scoped>
.rec-bar {
  flex-shrink: 0;
  padding: 8px 12px 0;
}

.rec-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
}

/* 안내 문구는 잘리지 않고 최대 두 줄로 흐른다(사용자 요구, 2026-09-06). */
.rec-hint {
  flex: 1;
  min-width: 0;
  white-space: normal;
  line-height: 18px;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}

.rec-dot {
  width: 9px;
  height: 9px;
  border-radius: var(--ac-radius-pill);
  flex-shrink: 0;
  background-color: var(--ac-danger);
}

/*
  파란 주 버튼 위의 빨간 점은 그대로 두면 흐릿하다. 흰 테두리를 얇게 둘러 어느 배경에서도
  녹화 표시로 읽히게 한다.
*/
.rec-dot-idle {
  box-shadow: 0 0 0 1.5px var(--ac-accent-contrast);
}

.rec-dot-live {
  animation: rec-pulse 1.4s ease-in-out infinite;
}

.rec-state {
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
  color: var(--ac-text);
}

.rec-meta {
  flex-shrink: 0;
}

.rec-stop {
  margin-left: auto;
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

@media (prefers-reduced-motion: reduce) {
  .rec-dot-live {
    animation: none;
  }
}
</style>
