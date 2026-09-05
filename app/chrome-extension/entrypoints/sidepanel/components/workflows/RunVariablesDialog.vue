<template>
  <div class="rv-overlay" @click.self="$emit('cancel')">
    <div class="rv-dialog" :style="dialogStyle">
      <div class="rv-title" :style="titleStyle">{{ getMessage('sidepanel_runvars_title') }}</div>
      <div class="rv-hint" :style="hintStyle">{{ getMessage('sidepanel_runvars_hint') }}</div>

      <div class="rv-fields">
        <label v-for="v in variables" :key="v.key" class="rv-field">
          <span class="rv-label" :style="labelStyle">
            {{ v.label || v.key }}
            <span v-if="v.sensitive" class="rv-tag" :style="tagStyle">{{
              getMessage('sidepanel_wizard_variable_sensitive')
            }}</span>
          </span>
          <input
            v-model="values[v.key]"
            class="rv-input"
            :style="inputStyle"
            :type="v.sensitive ? 'password' : 'text'"
            :autocomplete="v.sensitive ? 'new-password' : 'off'"
          />
        </label>
      </div>

      <div class="rv-actions">
        <button class="rv-btn" :style="cancelStyle" @click="$emit('cancel')">
          {{ getMessage('sidepanel_runvars_cancel') }}
        </button>
        <button class="rv-btn rv-btn-primary" :style="primaryStyle" @click="submit">
          {{ getMessage('sidepanel_runvars_run') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed, reactive } from 'vue';
import { getMessage } from '@/utils/i18n';
import type { WizardVariableDef } from '../../utils/flow-wizard';

const props = defineProps<{
  variables: WizardVariableDef[];
}>();

const emit = defineEmits<{
  (e: 'submit', values: Record<string, string>): void;
  (e: 'cancel'): void;
}>();

/**
 * 입력값은 이 다이얼로그가 사라지면 함께 사라진다. 민감값은 흐름에도, 저장소에도 쓰지
 * 않고 실행 인자로만 넘긴다.
 */
const values = reactive<Record<string, string>>(
  Object.fromEntries(
    props.variables.map((v) => [v.key, v.sensitive ? '' : String(v.default ?? '')]),
  ),
);

function submit() {
  emit('submit', { ...values });
}

const dialogStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface, #ffffff)',
  borderRadius: 'var(--ac-radius-card, 12px)',
  border: 'var(--ac-border-width, 1px) solid var(--ac-border, #e7e5e4)',
}));
const titleStyle = computed(() => ({ color: 'var(--ac-text)' }));
const hintStyle = computed(() => ({ color: 'var(--ac-text-subtle)' }));
const labelStyle = computed(() => ({ color: 'var(--ac-text-muted)' }));
const tagStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface-muted)',
  color: 'var(--ac-text-muted)',
}));
const inputStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface-muted)',
  color: 'var(--ac-text)',
  borderRadius: 'var(--ac-radius-inner, 8px)',
}));
const cancelStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface-muted)',
  color: 'var(--ac-text)',
  borderRadius: 'var(--ac-radius-button)',
}));
const primaryStyle = computed(() => ({
  backgroundColor: 'var(--ac-accent)',
  color: 'var(--ac-accent-contrast)',
  borderRadius: 'var(--ac-radius-button)',
}));
</script>

<style scoped>
.rv-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  z-index: 60;
}

.rv-dialog {
  width: 100%;
  max-width: 340px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.rv-title {
  font-size: 14px;
  font-weight: 600;
}

.rv-hint {
  font-size: 12px;
}

.rv-fields {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 240px;
  overflow-y: auto;
}

.rv-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.rv-label {
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.rv-tag {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
}

.rv-input {
  height: 34px;
  padding: 0 10px;
  border: none;
  outline: none;
  font-size: 13px;
  font-family: inherit;
  width: 100%;
}

.rv-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 4px;
}

.rv-btn {
  border: none;
  padding: 7px 14px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
</style>
