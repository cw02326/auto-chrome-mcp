<template>
  <div class="dh-root">
    <div class="dh-toolbar">
      <label class="ac-caption dh-filter-label">{{
        getMessage('sidepanel_daily_history_filter')
      }}</label>
      <select v-model="status" class="ac-field dh-select">
        <option value="">{{ getMessage('sidepanel_daily_history_all') }}</option>
        <option v-for="key in statusKeys" :key="key" :value="key">
          {{ formatRunStatus(key) }}
        </option>
      </select>
      <button class="ac-button ac-button--ghost ac-button--sm" type="button" @click="reload">
        {{ getMessage('sidepanel_daily_refresh') }}
      </button>
      <button
        class="ac-button ac-button--ghost ac-button--sm"
        type="button"
        @click="$emit('rerun')"
      >
        {{ getMessage('sidepanel_daily_rerun') }}
      </button>
    </div>

    <div v-if="error" class="ac-error-text dh-error">{{ error }}</div>

    <div v-if="loading && runs.length === 0" class="ac-sub dh-empty">
      {{ getMessage('sidepanel_daily_history_loading') }}
    </div>
    <div v-else-if="runs.length === 0" class="ac-sub dh-empty">
      {{ getMessage('sidepanel_daily_history_empty') }}
    </div>

    <ul v-else class="dh-list">
      <li v-for="run in runs" :key="run.runId" class="dh-item">
        <div class="dh-item-head">
          <span class="dh-dot" :style="{ backgroundColor: runStatusVar(run.status) }"></span>
          <span class="dh-status" :class="runStatusClass(run.status)">{{
            formatRunStatus(run.status)
          }}</span>
          <span class="ac-caption dh-trigger">{{ triggerLabel(run.trigger) }}</span>
          <span class="ac-caption ac-num dh-time">{{ formatRunTime(run.startedAt) }}</span>
        </div>

        <div v-if="durationText(run)" class="ac-caption ac-num dh-line">
          {{ durationText(run) }}
        </div>

        <div v-if="run.failedStep" class="ac-caption ac-text-danger dh-line">
          {{
            getMessage('sidepanel_daily_history_step', [
              String((run.failedStep.index ?? 0) + 1),
              String(run.failedStep.tool || ''),
            ])
          }}
        </div>

        <div v-if="run.error" class="ac-caption ac-text-danger dh-line dh-error-text">
          {{ getMessage('sidepanel_daily_history_error', [String(run.error)]) }}
        </div>

        <!--
          예약 실행의 실패 화면은 다운로드 폴더의 파일이다. 이력에는 파일명만 있으므로
          여기서는 폴더를 여는 버튼만 둔다 (base64 썸네일은 흐름 탭의 수동 실행 이력에 있다).
        -->
        <button
          v-if="run.screenshot"
          class="ac-button ac-button--ghost ac-button--sm dh-shot-btn"
          type="button"
          @click="openShot(String(run.screenshot))"
        >
          {{ getMessage('sidepanel_daily_open_screenshot') }}
        </button>
      </li>
    </ul>

    <button
      v-if="nextCursor"
      class="ac-button ac-button--ghost dh-more"
      type="button"
      :disabled="loading"
      @click="loadMore"
    >
      {{ getMessage('sidepanel_daily_history_more', [String(PAGE_SIZE)]) }}
    </button>
  </div>
</template>

<script lang="ts" setup>
/**
 * 예약 하나의 실행 이력 (2026-09-05 사이드패널 2단계 E, 2026-09-06 토스 스타일).
 *
 * 이력은 백그라운드 저장소에 있고 여기서 조각(20건)씩 읽는다. 상태 필터가 바뀌면 처음부터
 * 다시 읽는다 - 커서는 조건과 짝이라 조건이 바뀌면 이어 읽을 수 없다.
 */
import { onMounted, ref, watch } from 'vue';
import { getMessage } from '@/utils/i18n';
import * as daily from '../../utils/daily-messages';
import type { DailyRunRecord } from '../../utils/daily-messages';
import {
  RUN_STATUS_MESSAGE_KEYS,
  formatDuration,
  formatRunStatus,
  formatRunTime,
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

/** 상태 점의 색. 성공 파랑·진행 강조·로그인 필요 등은 주황·그 외는 위험 빨강. */
function runStatusVar(status: string | undefined): string {
  switch (status) {
    case 'success':
      return 'var(--ac-success)';
    case 'running':
      return 'var(--ac-accent)';
    case 'login_required':
    case 'skipped_queue':
    case 'user_took_over_tab':
    case 'stopped':
      return 'var(--ac-warning)';
    default:
      return 'var(--ac-danger-text)';
  }
}

/** 상태 글자색 클래스. 점 색과 같은 갈래를 쓴다. */
function runStatusClass(status: string | undefined): string {
  switch (status) {
    case 'success':
      return 'ac-text-success';
    case 'running':
      return 'ac-text-accent';
    case 'login_required':
    case 'skipped_queue':
    case 'user_took_over_tab':
    case 'stopped':
      return 'ac-text-warning';
    default:
      return 'ac-text-danger';
  }
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
  flex-shrink: 0;
}

.dh-select {
  width: auto;
  height: 32px;
  flex-shrink: 0;
  font-size: 13px;
  padding-left: 10px;
  padding-right: 28px;
  background-position: right 8px center;
}

.dh-empty,
.dh-error {
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
  min-height: 44px;
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  border-radius: var(--ac-radius);
  background-color: var(--ac-surface-row);
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
  border-radius: var(--ac-radius-pill);
  flex-shrink: 0;
}

.dh-status {
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
}

.dh-trigger {
  flex-shrink: 0;
}

.dh-time {
  margin-left: auto;
  flex-shrink: 0;
}

.dh-line {
  word-break: break-word;
}

.dh-error-text {
  font-family: var(--ac-font-mono);
}

.dh-shot-btn {
  align-self: flex-start;
  margin-top: 2px;
}

.dh-more {
  align-self: stretch;
}
</style>
