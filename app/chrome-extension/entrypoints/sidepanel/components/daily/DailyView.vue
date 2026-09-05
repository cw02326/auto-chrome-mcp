<template>
  <div class="dv-root" :style="rootStyle">
    <div class="dv-header" :style="headerStyle">
      <div class="dv-header-row">
        <span class="dv-title" :style="textStyle">{{ getMessage('sidepanel_daily_title') }}</span>
        <span class="dv-count" :style="subtleStyle">{{
          getMessage('sidepanel_daily_count', [String(schedules.length)])
        }}</span>
        <button class="dv-btn" :style="ghostStyle" @click="$emit('refresh')">
          {{ getMessage('sidepanel_daily_refresh') }}
        </button>
      </div>
      <!-- 예약이 언제 도는지에 대한 한 줄. 크롬이 꺼져 있으면 그 시간은 건너뛴다. -->
      <p class="dv-note" :style="subtleStyle">{{ getMessage('sidepanel_daily_chrome_note') }}</p>
    </div>

    <div class="dv-body ac-scroll">
      <div v-if="error" class="dv-error" :style="dangerStyle">{{ error }}</div>

      <!-- 빈 상태: 어디서 시작하는지 알려 주고 그 화면으로 보낸다 -->
      <div v-if="schedules.length === 0" class="dv-empty">
        <div class="dv-empty-title" :style="textStyle">
          {{ getMessage('sidepanel_daily_empty_title') }}
        </div>
        <div class="dv-empty-hint" :style="subtleStyle">
          {{ getMessage('sidepanel_daily_empty_hint') }}
        </div>
        <button class="dv-btn dv-btn-primary" :style="primaryStyle" @click="$emit('go-flows')">
          {{ getMessage('sidepanel_daily_empty_action') }}
        </button>
      </div>

      <ul v-else class="dv-list">
        <li
          v-for="schedule in schedules"
          :key="schedule.scheduleId"
          class="dv-item"
          :style="itemStyle"
        >
          <div class="dv-item-main" @click="toggleExpand(schedule.scheduleId)">
            <div class="dv-item-head">
              <span class="dv-name" :style="textStyle">{{ schedule.label }}</span>
              <span class="dv-kind" :style="kindStyle(schedule)">{{ kindText(schedule) }}</span>
            </div>
            <div class="dv-line" :style="mutedStyle">
              {{ summarizeSchedule(schedule.schedule) }}
            </div>
            <div class="dv-line" :style="subtleStyle">
              <template v-if="schedule.enabled">{{
                getMessage('sidepanel_daily_next_run', [formatNextRun(schedule.nextAt, now)])
              }}</template>
              <template v-else>{{ getMessage('sidepanel_daily_paused') }}</template>
            </div>
            <div class="dv-line">
              <template v-if="schedule.lastStatus">
                <span :style="{ color: runStatusColor(schedule.lastStatus) }">{{
                  formatRunStatus(schedule.lastStatus)
                }}</span>
                <span :style="subtleStyle"> {{ formatRunTime(schedule.lastRunAt, now) }}</span>
              </template>
              <span v-else :style="subtleStyle">{{ getMessage('sidepanel_daily_last_none') }}</span>
            </div>
          </div>

          <div class="dv-item-side">
            <label class="dv-switch" :title="getMessage('sidepanel_daily_enable_label')">
              <input
                type="checkbox"
                :checked="schedule.enabled"
                @change="
                  $emit('toggle', {
                    scheduleId: schedule.scheduleId,
                    enabled: ($event.target as HTMLInputElement).checked,
                  })
                "
              />
              <span class="dv-switch-text" :style="subtleStyle">{{
                getMessage('sidepanel_daily_enable_label')
              }}</span>
            </label>
            <button
              class="dv-btn dv-btn-small"
              :style="ghostStyle"
              @click="toggleExpand(schedule.scheduleId)"
            >
              {{
                expanded === schedule.scheduleId
                  ? getMessage('sidepanel_daily_collapse')
                  : getMessage('sidepanel_daily_expand')
              }}
            </button>
          </div>

          <div v-if="expanded === schedule.scheduleId" class="dv-detail">
            <div class="dv-detail-actions">
              <button
                class="dv-btn dv-btn-small dv-btn-primary"
                :style="primaryStyle"
                @click="$emit('run-now', schedule.scheduleId)"
              >
                {{ getMessage('sidepanel_daily_run_now') }}
              </button>
              <button
                class="dv-btn dv-btn-small"
                :style="ghostStyle"
                @click="$emit('edit', schedule)"
              >
                {{ getMessage('sidepanel_daily_edit') }}
              </button>
              <button
                class="dv-btn dv-btn-small"
                :style="dangerButtonStyle"
                @click="$emit('remove', schedule.scheduleId)"
              >
                {{ getMessage('sidepanel_daily_remove') }}
              </button>
            </div>
            <DailyRunHistory
              :schedule-id="schedule.scheduleId"
              :reload-key="reloadKey"
              @rerun="$emit('run-now', schedule.scheduleId)"
              @toast="$emit('toast', $event)"
            />
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

<script lang="ts" setup>
/**
 * 매일 작업 목록 (2026-09-05 사이드패널 2단계 E).
 *
 * 한 줄에 이름·종류·예약 요약·다음 실행·마지막 결과·켜기 스위치가 보이고, 펼치면 그 예약의
 * 실행 이력이 나온다. 데이터는 전부 상위(App.vue)가 넘겨준다.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { getMessage } from '@/utils/i18n';
import DailyRunHistory from './DailyRunHistory.vue';
import {
  formatNextRun,
  formatRunStatus,
  formatRunTime,
  runStatusColor,
  summarizeSchedule,
} from '../../utils/daily-format';
import type { ScheduleView } from '../../utils/daily-messages';

const props = withDefaults(
  defineProps<{
    schedules: ScheduleView[];
    error?: string | null;
    /** 값이 바뀌면 펼쳐 둔 이력을 다시 읽는다. */
    reloadKey?: number;
  }>(),
  { error: null, reloadKey: 0 },
);

defineEmits<{
  (e: 'refresh'): void;
  (e: 'edit', schedule: ScheduleView): void;
  (e: 'remove', scheduleId: string): void;
  (e: 'toggle', payload: { scheduleId: string; enabled: boolean }): void;
  (e: 'run-now', scheduleId: string): void;
  (e: 'go-flows'): void;
  (e: 'toast', payload: { text: string; kind: 'ok' | 'error' }): void;
}>();

const expanded = ref<string | null>(null);

/** "다음 실행 12분 뒤" 가 멈춰 있지 않도록 1분마다 기준 시각을 새로 잡는다. */
const now = ref(Date.now());
let tick: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  tick = setInterval(() => {
    now.value = Date.now();
  }, 60000);
});

onUnmounted(() => {
  if (tick) clearInterval(tick);
  tick = null;
});

function toggleExpand(scheduleId: string): void {
  expanded.value = expanded.value === scheduleId ? null : scheduleId;
}

function kindText(schedule: ScheduleView): string {
  return schedule.target?.kind === 'shortcut'
    ? getMessage('sidepanel_daily_kind_shortcut')
    : getMessage('sidepanel_daily_kind_flow');
}

function kindStyle(schedule: ScheduleView) {
  return schedule.target?.kind === 'shortcut'
    ? {
        backgroundColor: 'var(--ac-surface-muted, #f2f0eb)',
        color: 'var(--ac-text-muted, #6e6e6e)',
      }
    : {
        backgroundColor: 'var(--ac-accent-subtle, rgba(217, 119, 87, 0.12))',
        color: 'var(--ac-accent, #d97757)',
      };
}

const rootStyle = computed(() => ({ backgroundColor: 'var(--ac-surface, #ffffff)' }));
const headerStyle = computed(() => ({
  borderBottom: 'var(--ac-border-width, 1px) solid var(--ac-border, #e7e5e4)',
  backgroundColor: 'var(--ac-surface, #ffffff)',
}));
const textStyle = computed(() => ({ color: 'var(--ac-text, #1a1a1a)' }));
const mutedStyle = computed(() => ({ color: 'var(--ac-text-muted, #6e6e6e)' }));
const subtleStyle = computed(() => ({ color: 'var(--ac-text-subtle, #a8a29e)' }));
const dangerStyle = computed(() => ({ color: 'var(--ac-danger, #ef4444)' }));
const itemStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface, #ffffff)',
  border: 'var(--ac-border-width, 1px) solid var(--ac-border, #e7e5e4)',
  borderRadius: 'var(--ac-radius-card, 12px)',
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
const dangerButtonStyle = computed(() => ({
  backgroundColor: 'var(--ac-danger-subtle, rgba(239, 68, 68, 0.08))',
  color: 'var(--ac-danger, #ef4444)',
  borderRadius: 'var(--ac-radius-button, 8px)',
}));
</script>

<style scoped>
.dv-root {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.dv-header {
  flex-shrink: 0;
  padding: 12px 16px;
}

.dv-header-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dv-title {
  font-size: 14px;
  font-weight: 600;
}

.dv-count {
  font-size: 12px;
  flex: 1;
}

.dv-note {
  margin: 6px 0 0;
  font-size: 11px;
  line-height: 1.4;
}

.dv-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 16px 24px;
}

.dv-error {
  font-size: 12px;
  margin-bottom: 8px;
  word-break: break-word;
}

.dv-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 40px 12px;
  text-align: center;
}

.dv-empty-title {
  font-size: 14px;
  font-weight: 600;
}

.dv-empty-hint {
  font-size: 12px;
  line-height: 1.5;
}

.dv-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.dv-item {
  padding: 12px;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
}

.dv-item-main {
  min-width: 0;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.dv-item-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.dv-name {
  font-size: 13px;
  font-weight: 600;
  word-break: break-word;
}

.dv-kind {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 8px;
  border-radius: 999px;
  white-space: nowrap;
}

.dv-line {
  font-size: 12px;
  word-break: break-word;
}

.dv-item-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}

.dv-switch {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}

.dv-switch-text {
  font-size: 11px;
}

.dv-detail {
  grid-column: 1 / -1;
  margin-top: 8px;
  padding-top: 10px;
  border-top: var(--ac-border-width, 1px) solid var(--ac-border, #e7e5e4);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dv-detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.dv-btn {
  border: none;
  padding: 7px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}

.dv-btn-small {
  padding: 5px 10px;
  font-size: 12px;
}
</style>
