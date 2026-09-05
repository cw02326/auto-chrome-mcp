<template>
  <div class="ac-dim if-dim" @click.self="$emit('close')">
    <div
      ref="dialogRef"
      class="ac-dialog if-dialog"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      tabindex="-1"
    >
      <div class="ac-title" :id="titleId">
        {{ getMessage('sidepanel_daily_import_title') }}
      </div>

      <!-- 1단계: 파일 고르기 -->
      <label class="if-file">
        <span class="ac-button ac-button--ghost ac-button--sm">{{
          getMessage('sidepanel_daily_import_pick')
        }}</span>
        <input type="file" accept=".json" class="if-file-input" @change="onPick" />
        <span v-if="fileName" class="ac-caption if-file-name">{{ fileName }}</span>
      </label>

      <div v-if="error" class="ac-error-text">{{ error }}</div>

      <!-- 2단계: 미리보기 -->
      <div v-if="preview.length > 0" class="if-preview">
        <div class="ac-sub if-summary">
          {{ getMessage('sidepanel_daily_import_preview_count', [String(summary.total)]) }}
        </div>
        <ul class="if-list">
          <li v-for="flow in preview" :key="flow.id" class="if-item">
            <span class="ac-heading if-item-name">{{ flow.name || flow.id }}</span>
            <span class="ac-caption" :class="flow.conflict ? 'ac-text-warning' : ''">{{
              describePreviewFlow(flow)
            }}</span>
          </li>
        </ul>

        <!-- 충돌이면 어떻게 넣을지 고른다. 기본은 복사(되돌릴 수 있는 쪽)다. 칩 두 개로 고른다. -->
        <div v-if="summary.hasConflict" class="if-modes">
          <button
            type="button"
            class="ac-chip"
            :class="{ 'ac-chip--on': mode === 'copy' }"
            @click="mode = 'copy'"
          >
            {{ getMessage('sidepanel_daily_import_mode_copy') }}
          </button>
          <button
            type="button"
            class="ac-chip"
            :class="{ 'ac-chip--on': mode === 'overwrite' }"
            @click="mode = 'overwrite'"
          >
            {{ getMessage('sidepanel_daily_import_mode_overwrite') }}
          </button>
        </div>
      </div>

      <div class="if-actions ac-hairline-top">
        <button class="ac-button ac-button--ghost" type="button" @click="$emit('close')">
          {{ getMessage('sidepanel_daily_import_cancel') }}
        </button>
        <button
          class="ac-button ac-button--primary"
          type="button"
          :disabled="preview.length === 0 || busy"
          @click="confirm"
        >
          {{ getMessage('sidepanel_daily_import_confirm') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
/**
 * 흐름 가져오기 (2026-09-05 사이드패널 2단계 E, 2026-09-06 토스 스타일).
 *
 * JSON 파일을 고르면 백그라운드가 미리보기를 만들어 준다. 이름·단계 수·id 충돌 여부를 먼저
 * 보여주고, 충돌이면 새 id 로 복사할지 덮어쓸지 사용자가 고른 뒤에야 실제로 넣는다.
 * 덮어쓰기는 되돌릴 수 없으므로 기본값이 되지 않는다.
 */
import { computed, ref } from 'vue';
import { getMessage } from '@/utils/i18n';
import { useDialogA11y } from '@/ui/useDialogA11y';
import * as daily from '../../utils/daily-messages';
import type { ImportPreviewFlow } from '../../utils/import-flow';
import {
  defaultImportMode,
  describePreviewFlow,
  isTooLarge,
  maxImportSizeLabel,
  summarizeImportPreview,
  type ImportMode,
} from '../../utils/import-flow';

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'imported', count: number): void;
  (e: 'toast', payload: { text: string; kind: 'ok' | 'error' }): void;
}>();

const preview = ref<ImportPreviewFlow[]>([]);
const json = ref('');
const fileName = ref('');
const mode = ref<ImportMode>('copy');
const error = ref<string | null>(null);
const busy = ref(false);

const dialogRef = ref<HTMLElement | null>(null);
const titleId = 'import-flow-dialog-title';
useDialogA11y(dialogRef, titleId, () => emit('close'));

const summary = computed(() => summarizeImportPreview(preview.value));

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function onPick(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files && input.files[0];
  preview.value = [];
  json.value = '';
  error.value = null;
  if (!file) return;
  fileName.value = file.name;

  // 큰 파일은 읽기 전에 막는다. 흐름 하나는 보통 수십 KB 다.
  if (isTooLarge(file.size)) {
    error.value = getMessage('sidepanel_daily_import_too_large', [maxImportSizeLabel()]);
    return;
  }

  let text = '';
  try {
    text = await file.text();
  } catch {
    error.value = getMessage('sidepanel_daily_import_read_failed');
    return;
  }

  try {
    const flows = await daily.importFlowPreview(text);
    if (flows.length === 0) {
      error.value = getMessage('sidepanel_daily_import_empty');
      return;
    }
    json.value = text;
    preview.value = flows;
    mode.value = defaultImportMode(flows);
  } catch (e) {
    error.value = getMessage('sidepanel_daily_import_failed', [errorText(e)]);
  }
}

async function confirm(): Promise<void> {
  if (preview.value.length === 0 || busy.value) return;
  busy.value = true;
  try {
    const imported = await daily.importFlow(json.value, mode.value);
    const count = imported.length || preview.value.length;
    emit('toast', {
      text: getMessage('sidepanel_daily_import_done', [String(count)]),
      kind: 'ok',
    });
    emit('imported', count);
  } catch (e) {
    error.value = getMessage('sidepanel_daily_import_failed', [errorText(e)]);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.if-dim {
  z-index: 80;
}

.if-dialog {
  width: min(340px, 100% - 24px);
  max-height: calc(100vh - 40px);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.if-file {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.if-file-input {
  display: none;
}

.if-file-name {
  word-break: break-all;
}

.if-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
}

.if-summary {
  font-weight: 600;
}

.if-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.if-item {
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-radius: var(--ac-radius);
  background-color: var(--ac-surface-row);
}

.if-item-name {
  word-break: break-word;
}

.if-modes {
  display: flex;
  gap: 6px;
}

.if-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding-top: 12px;
}
</style>
