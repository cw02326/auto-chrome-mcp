<template>
  <div class="if-overlay" @click.self="$emit('close')">
    <div class="if-dialog" :style="dialogStyle">
      <div class="if-title" :style="textStyle">
        {{ getMessage('sidepanel_daily_import_title') }}
      </div>

      <!-- 1단계: 파일 고르기 -->
      <label class="if-file">
        <span class="if-file-btn" :style="ghostStyle">{{
          getMessage('sidepanel_daily_import_pick')
        }}</span>
        <input type="file" accept=".json" class="if-file-input" @change="onPick" />
        <span v-if="fileName" class="if-file-name" :style="subtleStyle">{{ fileName }}</span>
      </label>

      <div v-if="error" class="if-error" :style="dangerStyle">{{ error }}</div>

      <!-- 2단계: 미리보기 -->
      <div v-if="preview.length > 0" class="if-preview">
        <div class="if-summary" :style="mutedStyle">
          {{ getMessage('sidepanel_daily_import_preview_count', [String(summary.total)]) }}
        </div>
        <ul class="if-list">
          <li v-for="flow in preview" :key="flow.id" class="if-item" :style="itemStyle">
            <span class="if-item-name" :style="textStyle">{{ flow.name || flow.id }}</span>
            <span class="if-item-desc" :style="flow.conflict ? warnStyle : subtleStyle">{{
              describePreviewFlow(flow)
            }}</span>
          </li>
        </ul>

        <!-- 충돌이면 어떻게 넣을지 고른다. 기본은 복사(되돌릴 수 있는 쪽)다. -->
        <div v-if="summary.hasConflict" class="if-modes">
          <label class="if-radio" :style="mutedStyle">
            <input type="radio" value="copy" v-model="mode" />
            <span>{{ getMessage('sidepanel_daily_import_mode_copy') }}</span>
          </label>
          <label class="if-radio" :style="mutedStyle">
            <input type="radio" value="overwrite" v-model="mode" />
            <span>{{ getMessage('sidepanel_daily_import_mode_overwrite') }}</span>
          </label>
        </div>
      </div>

      <div class="if-actions">
        <button class="if-btn" :style="ghostStyle" @click="$emit('close')">
          {{ getMessage('sidepanel_daily_import_cancel') }}
        </button>
        <button
          class="if-btn if-btn-primary"
          :style="primaryStyle"
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
 * 흐름 가져오기 (2026-09-05 사이드패널 2단계 E).
 *
 * JSON 파일을 고르면 백그라운드가 미리보기를 만들어 준다. 이름·단계 수·id 충돌 여부를 먼저
 * 보여주고, 충돌이면 새 id 로 복사할지 덮어쓸지 사용자가 고른 뒤에야 실제로 넣는다.
 * 덮어쓰기는 되돌릴 수 없으므로 기본값이 되지 않는다.
 */
import { computed, ref } from 'vue';
import { getMessage } from '@/utils/i18n';
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

const dialogStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface, #ffffff)',
  borderRadius: 'var(--ac-radius-card, 12px)',
  border: 'var(--ac-border-width, 1px) solid var(--ac-border, #e7e5e4)',
}));
const textStyle = computed(() => ({ color: 'var(--ac-text, #1a1a1a)' }));
const mutedStyle = computed(() => ({ color: 'var(--ac-text-muted, #6e6e6e)' }));
const subtleStyle = computed(() => ({ color: 'var(--ac-text-subtle, #a8a29e)' }));
const warnStyle = computed(() => ({ color: 'var(--ac-warning, #b45309)' }));
const dangerStyle = computed(() => ({ color: 'var(--ac-danger, #ef4444)' }));
const itemStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface-muted, #f5f5f4)',
  borderRadius: 'var(--ac-radius-inner, 8px)',
}));
const ghostStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface-muted, #f2f0eb)',
  color: 'var(--ac-text, #1a1a1a)',
  borderRadius: 'var(--ac-radius-button, 8px)',
}));
const primaryStyle = computed(() => ({
  backgroundColor: 'var(--ac-accent, #d97757)',
  color: 'var(--ac-accent-contrast, #ffffff)',
  borderRadius: 'var(--ac-radius-button, 8px)',
}));
</script>

<style scoped>
.if-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  z-index: 80;
}

.if-dialog {
  width: 100%;
  max-width: 340px;
  max-height: calc(100vh - 40px);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.if-title {
  font-size: 14px;
  font-weight: 600;
}

.if-file {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.if-file-btn {
  display: inline-block;
  padding: 7px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.if-file-input {
  display: none;
}

.if-file-name {
  font-size: 11px;
  word-break: break-all;
}

.if-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
}

.if-summary {
  font-size: 12px;
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
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.if-item-name {
  font-size: 13px;
  font-weight: 600;
  word-break: break-word;
}

.if-item-desc {
  font-size: 11px;
}

.if-modes {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.if-radio {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  cursor: pointer;
}

.if-error {
  font-size: 12px;
  word-break: break-word;
}

.if-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.if-btn {
  border: none;
  padding: 7px 14px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}

.if-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
