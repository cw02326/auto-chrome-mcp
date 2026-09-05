<template>
  <div class="dh-root">
    <div class="dh-toolbar">
      <label class="dh-filter-label" :style="mutedStyle">{{
        getMessage('sidepanel_daily_history_filter')
      }}</label>
      <select v-model="status" class="dh-select" :style="selectStyle">
        <option value="">{{ getMessage('sidepanel_daily_history_all') }}</option>
        <option v-for="key in statusKeys" :key="key" :value="key">
          {{ formatRunStatus(key) }}
        </option>
      </select>
      <button class="dh-btn" :style="ghostStyle" @click="reload">
        {{ getMessage('sidepanel_daily_refresh') }}
      </button>
      <button class="dh-btn dh-btn-primary" :style="primaryStyle" @click="$emit('rerun')">
        {{ getMessage('sidepanel_daily_rerun') }}
      </button>
    </div>

    <div v-if="error" class="dh-error" :style="dangerStyle">{{ error }}</div>

    <div v-if="loading && runs.length === 0" class="dh-empty" :style="mutedStyle">
      {{ getMessage('sidepanel_daily_history_loading') }}
    </div>
    <div v-else-if="runs.length === 0" class="dh-empty" :style="mutedStyle">
      {{ getMessage('sidepanel_daily_history_empty') }}
    </div>

    <ul v-else class="dh-list">
      <li v-for="run in runs" :key="run.runId" class="dh-item" :style="itemStyle">
        <div class="dh-item-head">
          <span class="dh-dot" :style="{ backgroundColor: runStatusColor(run.status) }"></span>
          <span class="dh-status" :style="{ color: runStatusColor(run.status) }">{{
            formatRunStatus(run.status)
          }}</span>
          <span class="dh-trigger" :style="subtleStyle">{{ triggerLabel(run.trigger) }}</span>
          <span class="dh-time" :style="subtleStyle">{{ formatRunTime(run.startedAt) }}</span>
        </div>

        <div v-if="durationText(run)" class="dh-line" :style="subtleStyle">
          {{ durationText(run) }}
        </div>

        <div v-if="run.failedStep" class="dh-line" :style="dangerStyle">
          {{
            getMessage('sidepanel_daily_history_step', [
              String((run.failedStep.index ?? 0) + 1),
              String(run.failedStep.tool || ''),
            ])
          }}
        </div>

        <div v-if="run.error" class="dh-line dh-error-text" :style="dangerStyle">
          {{ getMessage('sidepanel_daily_history_error', [String(run.error)]) }}
        </div>

        <!--
          예약 실행의 실패 화면은 다운로드 폴더의 파일이다. 이력에는 파일명만 있으므로
          여기서는 폴더를 여는 버튼만 둔다 (base64 썸네일은 흐름 탭의 수동 실행 이력에 있다).
        -->
        <button
          v-if="run.screenshot"
          class="dh-btn dh-btn-small"
          :style="ghostStyle"
          @click="openShot(String(run.screenshot))"
        >
          {{ getMessage('sidepanel_daily_open_screenshot') }}
        </button>
      </li>
    </ul>

    <button
      v-if="nextCursor"
      class="dh-more"
      :style="ghostStyle"
      :disabled="loading"
      @click="loadMore"
    >
      {{ getMessage('sidepanel_daily_history_more', [String(PAGE_SIZE)]) }}
    </button>
  </div>
</template>

<script lang="ts" setup>
/**
 * 예약 하나의 실행 이력 (2026-09-05 사이드패널 2단계 E).
 *
 * 이력은 백그라운드 저장소에 있고 여기서 조각(20건)씩 읽는다. 상태 필터가 바뀌면 처음부터
 * 다시 읽는다 - 커서는 조건과 짝이라 조건이 바뀌면 이어 읽을 수 없다.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { getMessage } from '@/utils/i18n';
import * as daily from '../../utils/daily-messages';
import type { DailyRunRecord } from '../../utils/daily-messages';
import {
  RUN_STATUS_MESSAGE_KEYS,
  formatDuration,
  formatRunStatus,
  formatRunTime,
  runStatusColor,
} from '../../utils/daily-format';

/** 한 번에 읽는 건수. */
const PAGE_SIZE = 20;

const props = defineProps<{
  scheduleId: string;
  /** 값이 바뀌면 이력을 처음부터 다시 읽는다(예약·실행이 바뀌었을 때 상위가 올린다). */
  reloadKey?: number;
}>();

const emit = defineEmits<{
  (e: 'rerun'): void;
  (e: 'toast', payload: { text: string; kind: 'ok' | 'error' }): void;
}>();

const runs = ref<DailyRunRecord[]>([]);
const nextCursor = ref<string | undefined>(undefined);
const status = ref('');
const loading = ref(false);
const error = ref<string | null>(null);

const statusKeys = Object.keys(RUN_STATUS_MESSAGE_KEYS);

function triggerLabel(trigger: string | undefined): string {
  return trigger === 'manual'
    ? getMessage('sidepanel_daily_history_trigger_manual')
    : getMessage('sidepanel_daily_history_trigger_scheduled');
}

function durationText(run: DailyRunRecord): string {
  return formatDuration(run.durationMs ?? null);
}

async function load(reset: boolean): Promise<void> {
  loading.value = true;
  try {
    const page = await daily.queryHistory({
      scheduleId: props.scheduleId,
      ...(status.value ? { status: [status.value] } : {}),
      limit: PAGE_SIZE,
      ...(reset || !nextCursor.value ? {} : { cursor: nextCursor.value }),
    });
    runs.value = reset ? page.runs : runs.value.concat(page.runs);
    nextCursor.value = page.nextCursor;
    error.value = null;
  } catch (e) {
    error.value = getMessage('sidepanel_daily_history_failed', [
      e instanceof Error ? e.message : String(e),
    ]);
  } finally {
    loading.value = false;
  }
}

function reload(): void {
  nextCursor.value = undefined;
  void load(true);
}

function loadMore(): void {
  void load(false);
}

async function openShot(filename: string): Promise<void> {
  try {
    await daily.openScreenshot(filename);
  } catch (e) {
    emit('toast', {
      text: getMessage('sidepanel_daily_screenshot_missing'),
      kind: 'error',
    });
    console.warn('failed to open screenshot', e);
  }
}

watch(status, () => reload());
watch(
  () => props.scheduleId,
  () => reload(),
);
watch(
  () => props.reloadKey,
  () => reload(),
);

onMounted(() => reload());

const mutedStyle = computed(() => ({ color: 'var(--ac-text-muted, #6e6e6e)' }));
const subtleStyle = computed(() => ({ color: 'var(--ac-text-subtle, #a8a29e)' }));
const dangerStyle = computed(() => ({ color: 'var(--ac-danger, #ef4444)' }));
const itemStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface-muted, #f5f5f4)',
  borderRadius: 'var(--ac-radius-inner, 8px)',
}));
const selectStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface, #ffffff)',
  color: 'var(--ac-text, #1a1a1a)',
  border: 'var(--ac-border-width, 1px) solid var(--ac-border, #e7e5e4)',
  borderRadius: 'var(--ac-radius-button, 8px)',
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
.dh-root {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dh-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.dh-filter-label {
  font-size: 12px;
}

.dh-select {
  height: 28px;
  font-size: 12px;
  padding: 0 6px;
  font-family: inherit;
  outline: none;
}

.dh-btn {
  border: none;
  padding: 5px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}

.dh-btn-small {
  align-self: flex-start;
  margin-top: 2px;
}

.dh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.dh-empty,
.dh-error {
  font-size: 12px;
  padding: 8px 0;
}

.dh-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dh-item {
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.dh-item-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.dh-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dh-status {
  font-size: 12px;
  font-weight: 600;
}

.dh-trigger,
.dh-time {
  font-size: 11px;
}

.dh-time {
  margin-left: auto;
}

.dh-line {
  font-size: 12px;
  word-break: break-word;
}

.dh-error-text {
  font-family: var(--ac-font-mono, 'Monaco', 'Menlo', 'Ubuntu Mono', monospace);
  font-size: 11px;
}

.dh-more {
  border: none;
  padding: 7px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
</style>
