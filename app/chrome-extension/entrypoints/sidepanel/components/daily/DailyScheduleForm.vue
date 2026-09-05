<template>
  <div class="ac-dim df-dim" @click.self="$emit('cancel')">
    <div
      ref="dialogRef"
      class="ac-dialog df-dialog"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      tabindex="-1"
    >
      <div class="ac-title" :id="titleId">
        {{ getMessage('sidepanel_daily_form_title', [label]) }}
      </div>
      <div class="ac-sub df-hint">{{ getMessage('sidepanel_daily_chrome_note') }}</div>

      <!-- 예약할 수 없는 흐름이면 이유를 먼저 말하고 저장을 잠근다 -->
      <div v-if="blockMessage" class="df-block">
        <div class="ac-sub">{{ blockMessage }}</div>
        <button
          v-if="blockReason === 'flow_start_url_required'"
          class="ac-button ac-button--ghost ac-button--sm df-block-btn"
          type="button"
          @click="$emit('open-wizard')"
        >
          {{ getMessage('sidepanel_daily_block_open_wizard') }}
        </button>
      </div>

      <div class="df-body">
        <!-- 반복 방식 -->
        <div class="df-field">
          <span class="ac-caption df-label">{{ getMessage('sidepanel_daily_form_mode') }}</span>
          <div class="df-modes">
            <button
              v-for="option in modeOptions"
              :key="option.value"
              type="button"
              class="ac-chip"
              :class="{ 'ac-chip--on': state.mode === option.value }"
              @click="state.mode = option.value"
            >
              {{ option.text }}
            </button>
          </div>
        </div>

        <!-- 요일 (요일 선택일 때만) -->
        <div v-if="state.mode === 'weekdays'" class="df-field">
          <span class="ac-caption df-label">{{ getMessage('sidepanel_daily_form_days') }}</span>
          <div class="df-days">
            <button
              v-for="day in dayOrder"
              :key="day"
              type="button"
              class="ac-chip df-day"
              :class="{ 'ac-chip--on': state.days.includes(day) }"
              @click="toggleDay(day)"
            >
              {{ dayLabel(day) }}
            </button>
          </div>
        </div>

        <!-- 시각 (매일·요일 선택) -->
        <div v-if="state.mode !== 'every'" class="df-field">
          <span class="ac-caption df-label">{{ getMessage('sidepanel_daily_form_times') }}</span>
          <div v-for="(time, index) in state.times" :key="index" class="df-time-row">
            <input
              v-model="state.times[index]"
              type="time"
              class="ac-field df-time-input"
              step="60"
            />
            <button
              v-if="state.times.length > 1"
              type="button"
              class="ac-button ac-button--ghost ac-button--sm"
              @click="removeTime(index)"
            >
              {{ getMessage('sidepanel_daily_form_remove_time') }}
            </button>
          </div>
          <button
            v-if="state.times.length < maxTimes"
            type="button"
            class="ac-button ac-button--ghost ac-button--sm df-add-time"
            @click="addTime"
          >
            {{ getMessage('sidepanel_daily_form_add_time') }}
          </button>
        </div>

        <!-- 간격 -->
        <div v-else class="df-field">
          <span class="ac-caption df-label">{{ getMessage('sidepanel_daily_form_every') }}</span>
          <div class="df-modes">
            <button
              v-for="key in everyKeys"
              :key="key"
              type="button"
              class="ac-chip"
              :class="{ 'ac-chip--on': state.every === key }"
              @click="state.every = key"
            >
              {{ getMessage(`sidepanel_daily_every_${key}`) }}
            </button>
          </div>
        </div>

        <!-- 옵션 -->
        <label class="df-check ac-sub">
          <input type="checkbox" class="ac-check" v-model="state.notify" />
          <span>{{ getMessage('sidepanel_daily_form_notify') }}</span>
        </label>
        <label class="df-check ac-sub">
          <input type="checkbox" class="ac-check" v-model="state.report" />
          <span>{{ getMessage('sidepanel_daily_form_report') }}</span>
        </label>
        <label class="df-check ac-sub">
          <input type="checkbox" class="ac-check" v-model="state.enabled" />
          <span>{{ getMessage('sidepanel_daily_form_enabled') }}</span>
        </label>

        <!-- 변수 값 -->
        <div v-if="variables.length > 0" class="df-field">
          <span class="ac-caption df-label">{{
            getMessage('sidepanel_daily_form_variables')
          }}</span>
          <label v-for="variable in variables" :key="variable.key" class="df-var">
            <span class="ac-caption">{{ variable.label || variable.key }}</span>
            <input
              v-model="state.args[variable.key]"
              type="text"
              class="ac-field"
              :class="{ 'ac-field--error': variableError?.key === variable.key }"
            />
            <!-- 예약은 값을 물어볼 수 없다. 빈 값·규칙 위반은 저장 전에 여기서 말한다. -->
            <span v-if="variableError?.key === variable.key" class="ac-error-text">{{
              variableErrorMessage(variableError, variable.label || variable.key)
            }}</span>
          </label>
        </div>
      </div>

      <div v-if="formError" class="ac-error-text">{{ formError }}</div>

      <div class="df-actions ac-hairline-top">
        <button class="ac-button ac-button--ghost" type="button" @click="$emit('cancel')">
          {{ getMessage('sidepanel_daily_form_cancel') }}
        </button>
        <button
          class="ac-button ac-button--primary"
          type="button"
          :disabled="!!blockReason"
          @click="submit"
        >
          {{ getMessage('sidepanel_daily_form_save') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
/**
 * 예약 폼 (2026-09-05 사이드패널 2단계 E, 2026-09-06 토스 스타일).
 *
 * 흐름 카드의 예약 버튼과 매일 작업 탭의 예약 수정이 같은 화면을 연다. 값 검증은
 * `utils/daily-form.ts` 의 순수 함수가 하고, 여기서는 그 결과를 문구로 보여주기만 한다.
 *
 * 민감 변수가 있는 흐름·발행되지 않은 흐름·시작 주소가 없는 흐름은 저장 버튼이 잠긴다.
 * 눌러 본 뒤 백그라운드가 거절하면 사용자는 이유를 모른 채 저장이 안 되는 것만 본다.
 */
import { computed, reactive, ref } from 'vue';
import { getMessage } from '@/utils/i18n';
import { useDialogA11y } from '../../composables/useDialogA11y';
import { DAY_DISPLAY_ORDER, EVERY_KEYS, dayLabel } from '../../utils/daily-format';
import {
  flowScheduleBlockMessage,
  initialFormState,
  scheduleFormErrorMessage,
  validateScheduleForm,
  validateScheduleVariables,
  variableErrorMessage,
  type FlowScheduleBlockReason,
  type VariableError,
} from '../../utils/daily-form';
import type { PutScheduleInput, ScheduleTarget, ScheduleView } from '../../utils/daily-messages';
import type { WizardVariableDef } from '../../utils/flow-wizard';
import { MAX_DAILY_TIMES } from '@/utils/shortcut-schedule';

const props = withDefaults(
  defineProps<{
    /** 무엇을 예약하는가. */
    target: ScheduleTarget;
    /** 화면에 보여줄 이름. */
    label: string;
    /** 고치는 중인 예약(있으면 그 값으로 폼을 채운다). */
    existing?: ScheduleView | null;
    /** 값을 물어볼 흐름 변수(민감하지 않은 것만). */
    variables?: WizardVariableDef[];
    /** 예약할 수 없는 이유. 있으면 저장이 잠긴다. */
    blockReason?: FlowScheduleBlockReason | null;
  }>(),
  { existing: null, variables: () => [], blockReason: null },
);

const emit = defineEmits<{
  (e: 'save', payload: PutScheduleInput): void;
  (e: 'cancel'): void;
  (e: 'open-wizard'): void;
}>();

const maxTimes = MAX_DAILY_TIMES;
const dayOrder = DAY_DISPLAY_ORDER;
const everyKeys = EVERY_KEYS;

const dialogRef = ref<HTMLElement | null>(null);
const titleId = 'daily-schedule-form-title';
useDialogA11y(dialogRef, titleId, () => emit('cancel'));

const state = reactive(initialFormState(props.existing));

// 흐름 변수 기본값을 먼저 채운다. 예약은 사람이 없을 때 도므로 빈 값을 남기면 안 된다.
for (const variable of props.variables) {
  if (state.args[variable.key] === undefined) {
    state.args[variable.key] = String(variable.default ?? '');
  }
}

const formError = ref<string | null>(null);
/** 값이 비었거나 규칙에 어긋난 변수 하나. 그 칸 아래에 이유를 적는다. */
const variableError = ref<VariableError | null>(null);

const modeOptions = computed(() => [
  { value: 'daily' as const, text: getMessage('sidepanel_daily_form_mode_daily') },
  { value: 'weekdays' as const, text: getMessage('sidepanel_daily_form_mode_weekdays') },
  { value: 'every' as const, text: getMessage('sidepanel_daily_form_mode_every') },
]);

const blockMessage = computed(() =>
  props.blockReason ? flowScheduleBlockMessage(props.blockReason) : '',
);

function toggleDay(day: string): void {
  const index = state.days.indexOf(day);
  if (index >= 0) state.days.splice(index, 1);
  else state.days.push(day);
}

function addTime(): void {
  if (state.times.length >= maxTimes) return;
  state.times.push('09:00');
}

function removeTime(index: number): void {
  state.times.splice(index, 1);
}

function submit(): void {
  if (props.blockReason) return;

  // 변수 값을 먼저 본다. 예약 실행은 사람이 없을 때 도니 빈 값을 저장하면 안 된다.
  const badVariable = validateScheduleVariables(props.variables, state.args);
  variableError.value = badVariable;
  if (badVariable) {
    const def = props.variables.find((v) => v.key === badVariable.key);
    formError.value = variableErrorMessage(badVariable, def?.label || badVariable.key);
    return;
  }

  const result = validateScheduleForm(state);
  if (!result.ok) {
    formError.value = scheduleFormErrorMessage(result.error);
    return;
  }
  formError.value = null;

  const target: ScheduleTarget =
    props.target.kind === 'flow'
      ? { kind: 'flow', flowId: props.target.flowId, args: { ...state.args } }
      : { kind: 'shortcut', name: props.target.name };

  // 같은 대상으로 다시 저장하면 백그라운드가 같은 예약을 덮어쓴다. 별도 id 는 싣지 않는다.
  emit('save', {
    target,
    schedule: result.schedule,
    notify: state.notify,
    report: state.report,
    enabled: state.enabled,
    ...(props.existing?.loginCheck ? { loginCheck: props.existing.loginCheck } : {}),
  });
}
</script>

<style scoped>
.df-dim {
  z-index: 80;
}

.df-dialog {
  width: min(340px, 100% - 24px);
  max-height: calc(100vh - 40px);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.df-hint {
  margin: 0;
}

.df-block {
  background-color: var(--ac-surface-muted);
  border-radius: var(--ac-radius);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.df-block-btn {
  align-self: flex-start;
}

.df-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
  padding-right: 2px;
}

.df-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.df-modes,
.df-days {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.df-day {
  width: 36px;
  padding: 0;
  text-align: center;
}

.df-time-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.df-time-input {
  flex: 1;
  min-width: 0;
}

.df-add-time {
  align-self: flex-start;
}

.df-check {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.df-var {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.df-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding-top: 12px;
}
</style>
