<template>
  <div v-if="visible" class="pi-row">
    <span v-if="showSpinner" class="pi-spinner" aria-hidden="true"></span>
    <span class="ac-sub pi-text">{{ text }}</span>
  </div>
</template>

<script lang="ts" setup>
interface Props {
  visible?: boolean;
  text: string;
  showSpinner?: boolean;
}

withDefaults(defineProps<Props>(), {
  visible: true,
  showSpinner: true,
});
</script>

<style scoped>
/* 세로 액센트 띠는 쓰지 않는다. 옅은 표면 하나로만 구분한다. */
.pi-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border-radius: var(--ac-radius);
  background-color: var(--ac-surface-muted);
}

.pi-spinner {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  border-radius: var(--ac-radius-pill);
  border: 2px solid var(--ac-divider);
  border-top-color: var(--ac-accent);
  animation: pi-spin 1s linear infinite;
}

@keyframes pi-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .pi-spinner {
    animation: none;
  }
}

.pi-text {
  min-width: 0;
  word-break: break-word;
}
</style>
