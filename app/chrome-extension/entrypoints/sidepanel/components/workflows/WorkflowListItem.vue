<template>
  <div class="ac-card wf-item">
    <div class="wf-item-body">
      <!-- 이름·배지·설명 -->
      <div class="wf-item-info">
        <div class="ac-heading wf-item-name" :title="flowName">{{ flowName }}</div>

        <!-- 발행·예약 상태 배지 -->
        <div v-if="flow.published || flow.needsRepublish || schedule" class="wf-badges">
          <span v-if="flow.published" class="ac-badge ac-badge--accent">
            {{ getMessage('sidepanel_published_badge') }}
          </span>
          <span v-if="flow.needsRepublish" class="ac-badge ac-badge--warning">
            {{ getMessage('sidepanel_republish_badge') }}
          </span>
          <!-- 예약 배지: 다음 실행 시각. 꺼 둔 예약은 그렇게 적는다. -->
          <span v-if="schedule" class="ac-badge ac-badge--accent">
            {{ scheduleBadgeText }}
          </span>
        </div>

        <div class="ac-sub wf-item-desc">
          {{ flow.description || getMessage('sidepanel_no_description') }}
        </div>

        <!-- 실행 결과. 실패를 콘솔에만 남기지 않고 카드에 남긴다. -->
        <div v-if="status" class="ac-sub wf-item-line" :class="statusClass">{{ status.text }}</div>

        <!-- 마지막으로 성공한 시각. 예약이 도는 흐름인지 한눈에 보게 한다. -->
        <div v-if="lastSuccessText" class="ac-sub wf-item-line">{{ lastSuccessText }}</div>

        <!-- 사이트·꼬리표 -->
        <div v-if="hasTags" class="wf-tags">
          <span v-if="flow.meta?.domain" class="ac-badge ac-badge--accent">
            {{ flow.meta.domain }}
          </span>
          <span v-for="tag in flow.meta?.tags || []" :key="tag" class="ac-badge">
            {{ tag }}
          </span>
        </div>
      </div>

      <!-- 실행·예약·편집·더보기 -->
      <div class="wf-actions">
        <button
          class="ac-icon-button ac-icon-button--primary"
          type="button"
          @click.stop="$emit('run', flow.id)"
          :title="getMessage('sidepanel_run_flow_button')"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        </button>
        <button
          class="ac-icon-button"
          type="button"
          @click.stop="$emit('schedule', flow.id)"
          :title="getMessage('sidepanel_daily_schedule_button')"
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M8 7V3m8 4V3M4 11h16M5 5h14a1 1 0 011 1v13a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z"
            />
          </svg>
        </button>
        <button
          class="ac-icon-button"
          type="button"
          @click.stop="$emit('edit', flow.id)"
          :title="getMessage('sidepanel_edit_flow_button')"
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
            />
          </svg>
        </button>
        <div class="wf-more">
          <button
            class="ac-icon-button"
            type="button"
            @click.stop="toggleMoreMenu"
            :title="getMessage('sidepanel_more_actions_button')"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <circle cx="12" cy="5" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="12" cy="19" r="2" />
            </svg>
          </button>

          <!-- 더보기 메뉴 -->
          <Transition name="menu-fade">
            <div v-if="showMoreMenu" class="wf-menu" @click.stop>
              <button class="wf-menu-item" type="button" @click="handlePublishToggle">
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M12 20V8m0 0L8 12m4-4l4 4M4 4h16"
                  />
                </svg>
                <span>{{
                  flow.published
                    ? getMessage('sidepanel_unpublish_action')
                    : getMessage('sidepanel_publish_action')
                }}</span>
              </button>
              <button class="wf-menu-item" type="button" @click="handleExport">
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                  />
                </svg>
                <span>{{ getMessage('sidepanel_export_button') }}</span>
              </button>
              <button class="wf-menu-item wf-menu-item-danger" type="button" @click="handleDelete">
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
                <span>{{ getMessage('deleteButton') }}</span>
              </button>
            </div>
          </Transition>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { getMessage } from '@/utils/i18n';
import { formatNextRun, formatRunTime } from '../../utils/daily-format';
import type { ScheduleView } from '../../utils/daily-messages';

interface FlowLite {
  id: string;
  name: string;
  description?: string;
  /** 발행돼 있으면 그 레코드 (slug·version). 없으면 초안이다. */
  published?: { slug: string; version: number };
  /** 발행 뒤 흐름이 바뀌어 다시 발행해야 하는가. */
  needsRepublish?: boolean;
  meta?: {
    domain?: string;
    tags?: string[];
    bindings?: any[];
  };
}

const props = defineProps<{
  flow: FlowLite;
  /** 마지막 실행 결과. 실패를 조용히 넘기지 않으려고 카드에 남긴다. */
  status?: { kind: 'running' | 'ok' | 'error'; text: string } | null;
  /** 이 흐름에 걸린 예약. 있으면 다음 실행 시각을 배지로 보여준다. */
  schedule?: ScheduleView | null;
  /** 마지막으로 성공한 시각(epoch ms). */
  lastSuccessAt?: number | null;
}>();

const emit = defineEmits<{
  (e: 'run', id: string): void;
  (e: 'edit', id: string): void;
  (e: 'delete', id: string): void;
  (e: 'export', id: string): void;
  (e: 'publish', id: string): void;
  (e: 'unpublish', id: string): void;
  (e: 'schedule', id: string): void;
}>();

const flowName = computed(() => props.flow.name || getMessage('sidepanel_untitled_flow'));

/** 예약 배지 문구. 꺼 둔 예약은 "꺼짐" 이다 - 다음 실행 시각을 보여주면 돌 것처럼 읽힌다. */
const scheduleBadgeText = computed(() => {
  const schedule = props.schedule;
  if (!schedule) return '';
  if (!schedule.enabled) return getMessage('sidepanel_daily_paused');
  return getMessage('sidepanel_daily_badge_next', [formatNextRun(schedule.nextAt)]);
});

const lastSuccessText = computed(() => {
  const at = props.lastSuccessAt;
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return '';
  return getMessage('sidepanel_daily_last_success', [formatRunTime(at)]);
});

/** 마지막 실행 결과의 색. 색만으로 구분하지 않도록 문구는 그대로 함께 보인다. */
const statusClass = computed(() => {
  if (props.status?.kind === 'error') return 'ac-text-danger';
  if (props.status?.kind === 'ok') return 'ac-text-success';
  return '';
});

const showMoreMenu = ref(false);

const hasTags = computed(() => {
  return props.flow.meta?.domain || (props.flow.meta?.tags?.length ?? 0) > 0;
});

// Close menu when clicking outside
function handleClickOutside() {
  if (showMoreMenu.value) {
    showMoreMenu.value = false;
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside);
});

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside);
});

function toggleMoreMenu() {
  showMoreMenu.value = !showMoreMenu.value;
}

function handleDelete() {
  showMoreMenu.value = false;
  emit('delete', props.flow.id);
}

function handleExport() {
  showMoreMenu.value = false;
  emit('export', props.flow.id);
}

function handlePublishToggle() {
  showMoreMenu.value = false;
  // 이벤트 이름을 삼항으로 넘기면 오버로드가 좁혀지지 않는다. 갈래로 나눠 부른다.
  if (props.flow.published) emit('unpublish', props.flow.id);
  else emit('publish', props.flow.id);
}
</script>

<style scoped>
.wf-item {
  padding: 16px;
}

.wf-item-body {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.wf-item-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* 긴 이름은 한 줄로 자른다. 전체 이름은 title 속성에 있다. */
.wf-item-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wf-item-desc,
.wf-item-line {
  word-break: break-word;
}

.wf-badges,
.wf-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/*
  실행·예약·편집·더보기는 늘 보인다. 예전에는 마우스를 올려야 나타났는데, 좁은 패널에서는
  그 버튼이 있는 줄도 모르고 지나친다.
*/
.wf-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.wf-more {
  position: relative;
  display: flex;
}

.wf-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  min-width: 152px;
  padding: 4px;
  z-index: 100;
  background-color: var(--ac-surface);
  border-radius: var(--ac-radius);
  box-shadow: var(--ac-shadow-float);
}

.wf-menu-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 8px 12px;
  background: transparent;
  border: none;
  border-radius: var(--ac-radius-chip);
  font-family: inherit;
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
  color: var(--ac-text);
  cursor: pointer;
  text-align: left;
  transition: background-color var(--ac-motion-fast) ease;
}

.wf-menu-item:hover {
  background-color: var(--ac-surface-muted);
}

.wf-menu-item-danger {
  color: var(--ac-danger-text);
}

.wf-menu-item-danger:hover {
  background-color: var(--ac-danger-soft);
}

/* Menu fade transition */
.menu-fade-enter-active,
.menu-fade-leave-active {
  transition:
    opacity var(--ac-motion-fast) ease,
    transform var(--ac-motion-fast) ease;
}

.menu-fade-enter-from,
.menu-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
