<template>
  <div v-if="visible" class="ac-dim cd-dim" @click.self="$emit('cancel')">
    <div
      ref="dialogRef"
      class="ac-dialog cd-dialog"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      tabindex="-1"
    >
      <h2 :id="titleId" class="ac-title">{{ title }}</h2>

      <p class="ac-sub cd-message">{{ message }}</p>

      <ul v-if="items && items.length > 0" class="cd-list">
        <li v-for="item in items" :key="item" class="ac-caption">{{ item }}</li>
      </ul>

      <p v-if="warning" class="ac-caption ac-text-danger cd-warning">{{ warning }}</p>

      <div class="cd-actions">
        <button type="button" class="ac-button ac-button--ghost" @click="$emit('cancel')">
          {{ cancelText }}
        </button>
        <button
          type="button"
          class="ac-button ac-button--primary"
          :disabled="isConfirming"
          @click="$emit('confirm')"
        >
          {{ isConfirming ? confirmingText : confirmText }}
        </button>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref } from 'vue';
import { getMessage } from '@/utils/i18n';
import { useDialogA11y } from '@/ui/useDialogA11y';

interface Props {
  visible: boolean;
  title: string;
  message: string;
  items?: string[];
  warning?: string;
  confirmText?: string;
  cancelText?: string;
  confirmingText?: string;
  isConfirming?: boolean;
}

interface Emits {
  (e: 'confirm'): void;
  (e: 'cancel'): void;
}

withDefaults(defineProps<Props>(), {
  confirmText: getMessage('confirmButton'),
  cancelText: getMessage('cancelButton'),
  confirmingText: getMessage('processingStatus'),
  isConfirming: false,
});

const emit = defineEmits<Emits>();

// v-if 가 다이얼로그 엘리먼트만 켜고 끄므로 ref 를 watch 하는 useDialogA11y 로 충분하다.
const dialogRef = ref<HTMLElement | null>(null);
const titleId = 'popup-confirm-dialog-title';
useDialogA11y(dialogRef, titleId, () => emit('cancel'));
</script>

<style scoped>
/* 레이아웃만. 대화상자 껍데기는 ui/theme.css 의 .ac-dim / .ac-dialog 가 그린다. */
.cd-dim {
  z-index: 60;
}

.cd-dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: calc(100vh - 48px);
  overflow-y: auto;
}

.cd-message {
  margin: 0;
}

.cd-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 12px;
  list-style: none;
  border-radius: var(--ac-radius);
  background-color: var(--ac-surface-muted);
}

.cd-warning {
  margin: 0;
}

.cd-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 4px;
}
</style>
