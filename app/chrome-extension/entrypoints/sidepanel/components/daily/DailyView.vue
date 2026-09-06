<template>
  <div class="dv-root">
    <div class="dv-header">
      <div class="dv-header-row">
        <span class="ac-title dv-title">{{ getMessage('sidepanel_daily_title') }}</span>
        <span class="ac-caption ac-num dv-count">{{
          getMessage('sidepanel_daily_count', [String(schedules.length)])
        }}</span>
        <button
          class="ac-button ac-button--ghost ac-button--sm"
          type="button"
          @click="$emit('refresh')"
        >
          {{ getMessage('sidepanel_daily_refresh') }}
        </button>
      </div>
      <!-- 예약이 언제 도는지에 대한 한 줄. 크롬이 꺼져 있으면 그 시간은 건너뛴다. -->
      <p class="ac-caption dv-note">{{ getMessage('sidepanel_daily_chrome_note') }}</p>
    </div>

    <div class="dv-body ac-scroll">
      <div v-if="error" class="ac-error-text dv-error">{{ error }}</div>

      <!-- 빈 상태: 어디서 시작하는지 알려 주고 그 화면으로 보낸다 -->
      <div v-if="schedules.length === 0" class="dv-empty">
        <div class="ac-heading">
          {{ getMessage('sidepanel_daily_empty_title') }}
        </div>
        <div class="ac-sub dv-empty-hint">
          {{ getMessage('sidepanel_daily_empty_hint') }}
        </div>
        <button class="ac-button ac-button--primary" type="button" @click="$emit('go-flows')">
          {{ getMessage('sidepanel_daily_empty_action') }}
        </button>
      </div>

      <ul v-else class="dv-list">
        <li v-for="schedule in schedules" :key="schedule.scheduleId" class="ac-card dv-item">
          <button
            type="button"
            class="dv-item-main"
            :aria-expanded="expanded === schedule.scheduleId"
            @click="toggleExpand(schedule.scheduleId)"
          >
            <div class="dv-item-head">
              <span class="ac-heading ac-clip dv-name" :title="schedule.label">{{
                schedule.label
              }}</span>
              <span
                class="ac-badge"
                :class="{ 'ac-badge--accent': schedule.target?.kind !== 'shortcut' }"
                >{{ kindText(schedule) }}</span
              >
            </div>
            <div class="ac-sub dv-line">
              {{ summarizeSchedule(schedule.schedule) }}
            </div>
            <div class="ac-sub dv-line">
              {{ formatScheduleEnabledLine(schedule.enabled, schedule.nextAt, now) }}
            </div>
            <div class="ac-caption dv-line">
              <template v-if="schedule.lastStatus">
                <span :class="runStatusClass(schedule.lastStatus)">{{
                  formatRunStatus(schedule.lastStatus)
                }}</span>
                <span> {{ formatRunTime(schedule.lastRunAt, now) }}</span>
              </template>
              <span v-else>{{ getMessage('sidepanel_daily_last_none') }}</span>
            </div>
          </button>

          <div class="dv-item-side">
            <label class="ac-switch" :title="getMessage('sidepanel_daily_enable_label')">
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
              <span class="ac-switch-track"></span>
            </label>
            <button
              class="ac-button ac-button--ghost ac-button--sm"
              type="button"
              :aria-expanded="expanded === schedule.scheduleId ? 'true' : 'false'"
              :aria-controls="`dv-detail-${schedule.scheduleId}`"
              @click="toggleExpand(schedule.scheduleId)"
            >
              {{
                expanded === schedule.scheduleId
                  ? getMessage('sidepanel_daily_collapse')
                  : getMessage('sidepanel_daily_expand')
              }}
            </button>
          </div>

          <div
            v-if="expanded === schedule.scheduleId"
            :id="`dv-detail-${schedule.scheduleId}`"
            class="dv-detail ac-hairline-top"
          >
            <div class="dv-detail-actions">
              <button
                class="ac-button ac-button--primary ac-button--sm"
                type="button"
                @click="$emit('run-now', schedule.scheduleId)"
              >
                {{ getMessage('sidepanel_daily_run_now') }}
              </button>
              <button
                class="ac-button ac-button--ghost ac-button--sm"
                type="button"
                @click="$emit('edit', schedule)"
              >
                {{ getMessage('sidepanel_daily_edit') }}
              </button>
              <button
                class="ac-button ac-button--danger ac-button--sm"
                type="button"
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
 * 매일 작업 목록 (2026-09-05 사이드패널 2단계 E, 2026-09-06 토스 스타일).
 *
 * 한 줄에 이름·종류·예약 요약·다음 실행·마지막 결과·켜기 스위치가 보이고, 펼치면 그 예약의
 * 실행 이력이 나온다. 데이터는 전부 상위(App.vue)가 넘겨준다.
 */
import { onMounted, onUnmounted, ref } from 'vue';
import { getMessage } from '@/utils/i18n';
import DailyRunHistory from './DailyRunHistory.vue';
import {
  formatRunStatus,
  formatRunTime,
  formatScheduleEnabledLine,
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

/** 마지막 실행 결과의 글자색. 성공 파랑·실패 빨강·로그인 필요는 주황. */
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
</script>

<style scoped>
.dv-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  background-color: var(--ac-bg);
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
  flex-shrink: 0;
}

.dv-count {
  flex: 1;
}

.dv-note {
  margin: 6px 0 0;
}

.dv-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 12px 24px;
}

.dv-error {
  margin: 0 4px 8px;
  word-break: break-word;
}

.dv-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 48px 16px;
  text-align: center;
}

.dv-empty-hint {
  margin-bottom: 8px;
}

.dv-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dv-item {
  padding: 16px;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  min-height: 52px;
}

.dv-item-main {
  min-width: 0;
  width: 100%;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: none;
  border: none;
  margin: 0;
  padding: 0;
  font: inherit;
  color: inherit;
  text-align: left;
}

.dv-item-main:focus-visible {
  outline: 2px solid var(--ac-focus-ring);
  outline-offset: 2px;
}

.dv-item-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.dv-name {
  max-width: 100%;
}

.dv-line {
  word-break: break-word;
}

.dv-item-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}

/* 스위치 시각 크기(44x24)는 그대로 두고, 히트 영역만 세로 최소 32px 로 넓힌다. */
.dv-item-side .ac-switch {
  padding: 4px 0;
}

.dv-detail {
  grid-column: 1 / -1;
  margin-top: 8px;
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dv-detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
</style>
