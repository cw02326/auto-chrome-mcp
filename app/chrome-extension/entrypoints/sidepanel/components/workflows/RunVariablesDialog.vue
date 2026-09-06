<template>
  <div class="ac-dim rv-dim" @click.self="$emit('cancel')">
    <div
      ref="dialogRef"
      class="ac-dialog rv-dialog"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      tabindex="-1"
    >
      <div class="ac-title" :id="titleId">{{ getMessage('sidepanel_runvars_title') }}</div>
      <div class="ac-sub">{{ getMessage('sidepanel_runvars_hint') }}</div>

      <div class="rv-fields">
        <label v-for="v in variables" :key="v.key" class="rv-field">
          <span class="rv-label">
            <span class="ac-clip">{{ v.label || v.key }}</span>
            <span v-if="v.sensitive" class="ac-badge">{{
              getMessage('sidepanel_wizard_variable_sensitive')
            }}</span>
            <!-- 값을 넣지 않으면 실행이 그 단계에서 멈춘다. 그래서 필수라고 적는다. -->
            <span class="ac-badge ac-badge--accent">{{
              getMessage('sidepanel_daily_var_required')
            }}</span>
          </span>
          <input
            v-model="values[v.key]"
            class="ac-field"
            :type="v.sensitive ? 'password' : 'text'"
            :autocomplete="v.sensitive ? 'new-password' : 'off'"
            :placeholder="defaultHint(v)"
          />
          <span v-if="defaultHint(v)" class="ac-caption rv-default">{{
            getMessage('sidepanel_daily_var_default', [defaultHint(v)])
          }}</span>
        </label>
      </div>

      <div class="rv-actions">
        <button class="ac-button ac-button--ghost" type="button" @click="$emit('cancel')">
          {{ getMessage('sidepanel_runvars_cancel') }}
        </button>
        <button class="ac-button ac-button--primary" type="button" @click="submit">
          {{ getMessage('sidepanel_runvars_run') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { reactive, ref } from 'vue';
import { getMessage } from '@/utils/i18n';
import { useDialogA11y } from '@/ui/useDialogA11y';
import type { WizardVariableDef } from '../../utils/flow-wizard';

const props = defineProps<{
  variables: WizardVariableDef[];
}>();

const emit = defineEmits<{
  (e: 'submit', values: Record<string, string>): void;
  (e: 'cancel'): void;
}>();

const dialogRef = ref<HTMLElement | null>(null);
const titleId = 'run-variables-dialog-title';
useDialogA11y(dialogRef, titleId, () => emit('cancel'));

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

/** 흐름에 적힌 기본값. 민감 변수는 값을 저장하지 않으므로 늘 비어 있다. */
function defaultHint(variable: WizardVariableDef): string {
  if (variable.sensitive) return '';
  const fallback = variable.default;
  return fallback === undefined || fallback === null ? '' : String(fallback);
}
</script>

<style scoped>
.rv-dim {
  z-index: 60;
}

.rv-dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: calc(100vh - 48px);
}

.rv-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
}

.rv-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* 섹션 라벨 */
.rv-label {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
  color: var(--ac-text-secondary);
}

.rv-default {
  word-break: break-all;
}

.rv-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 4px;
}
</style>
