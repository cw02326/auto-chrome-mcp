<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    :class="[className, { 'record-icon--on': recording }]"
  >
    <circle cx="12" cy="12" r="8" fill="currentColor" />
  </svg>
</template>

<script lang="ts" setup>
interface Props {
  className?: string;
  recording?: boolean;
}

withDefaults(defineProps<Props>(), {
  className: 'icon-default',
  recording: false,
});
</script>

<style scoped>
/* 녹화 중일 때만 빨간 점. 색은 토큰에서 받는다. */
.record-icon--on {
  color: var(--ac-danger);
}
</style>
