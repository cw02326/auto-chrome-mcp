<template>
  <div
    class="workflow-item"
    :style="itemStyle"
    @mouseenter="showActions = true"
    @mouseleave="showActions = false"
  >
    <div class="workflow-content">
      <!-- Title and description -->
      <div class="workflow-info">
        <div class="workflow-name" :style="nameStyle">{{
          flow.name || getMessage('sidepanel_untitled_flow')
        }}</div>
        <!-- 발행·예약 상태 배지 -->
        <div v-if="flow.published || flow.needsRepublish || schedule" class="workflow-badges">
          <span v-if="flow.published" class="workflow-badge" :style="publishedBadgeStyle">
            {{ getMessage('sidepanel_published_badge') }}
          </span>
          <span v-if="flow.needsRepublish" class="workflow-badge" :style="staleBadgeStyle">
            {{ getMessage('sidepanel_republish_badge') }}
          </span>
          <!-- 예약 배지: 다음 실행 시각. 꺼 둔 예약은 그렇게 적는다. -->
          <span v-if="schedule" class="workflow-badge" :style="scheduleBadgeStyle">
            {{ scheduleBadgeText }}
          </span>
        </div>
        <div class="workflow-desc" :style="descStyle">{{
          flow.description || getMessage('sidepanel_no_description')
        }}</div>
        <!-- 실행 결과. 실패를 콘솔에만 남기지 않고 카드에 남긴다. -->
        <div v-if="status" class="workflow-status" :style="statusStyle">{{ status.text }}</div>
        <!-- 마지막으로 성공한 시각. 예약이 도는 흐름인지 한눈에 보게 한다. -->
        <div v-if="lastSuccessText" class="workflow-status" :style="descStyle">
          {{ lastSuccessText }}
        </div>
        <!-- Tags -->
        <div v-if="hasTags" class="workflow-tags">
          <span v-if="flow.meta?.domain" class="workflow-tag" :style="tagDomainStyle">
            {{ flow.meta.domain }}
          </span>
          <span
            v-for="tag in flow.meta?.tags || []"
            :key="tag"
            class="workflow-tag"
            :style="tagStyle"
          >
            {{ tag }}
          </span>
        </div>
      </div>

      <!-- Actions -->
      <div class="workflow-actions" :class="{ 'workflow-actions-visible': showActions }">
        <button
          class="workflow-action workflow-action-primary"
          :style="actionPrimaryStyle"
          @click.stop="$emit('run', flow.id)"
          :title="getMessage('sidepanel_run_flow_button')"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        </button>
        <button
          class="workflow-action"
          :style="actionStyle"
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
          class="workflow-action"
          :style="actionStyle"
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
        <button
          class="workflow-action workflow-action-more"
          :style="actionStyle"
          @click.stop="toggleMoreMenu"
          :title="getMessage('sidepanel_more_actions_button')"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <circle cx="12" cy="5" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="12" cy="19" r="2" />
          </svg>
        </button>

        <!-- More menu dropdown -->
        <Transition name="menu-fade">
          <div v-if="showMoreMenu" class="workflow-more-menu" :style="menuStyle" @click.stop>
            <button class="workflow-menu-item" :style="menuItemStyle" @click="handlePublishToggle">
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
            <button class="workflow-menu-item" :style="menuItemStyle" @click="handleExport">
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
            <button
              class="workflow-menu-item workflow-menu-item-danger"
              :style="menuItemDangerStyle"
              @click="handleDelete"
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

const showActions = ref(false);
const showMoreMenu = ref(false);

const hasTags = computed(() => {
  return props.flow.meta?.domain || (props.flow.meta?.tags?.length ?? 0) > 0;
});

// Close menu when clicking outside
function handleClickOutside(e: MouseEvent) {
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

// Computed styles using CSS variables
const itemStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface)',
  borderRadius: 'var(--ac-radius-card, 12px)',
  border: 'var(--ac-border-width, 1px) solid var(--ac-border, #e7e5e4)',
  transition: 'all var(--ac-motion-fast, 120ms) ease',
}));

const nameStyle = computed(() => ({
  color: 'var(--ac-text, #1a1a1a)',
}));

const descStyle = computed(() => ({
  color: 'var(--ac-text-muted, #6e6e6e)',
}));

const publishedBadgeStyle = computed(() => ({
  backgroundColor: 'var(--ac-success-light, #dcfce7)',
  color: 'var(--ac-success, #16a34a)',
}));

const scheduleBadgeStyle = computed(() => ({
  backgroundColor: 'var(--ac-accent-subtle, rgba(217, 119, 87, 0.12))',
  color: 'var(--ac-accent, #d97757)',
}));

const staleBadgeStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface-muted, #f2f0eb)',
  color: 'var(--ac-text-muted, #6e6e6e)',
}));

const statusStyle = computed(() => ({
  color:
    props.status?.kind === 'error'
      ? 'var(--ac-danger, #ef4444)'
      : props.status?.kind === 'ok'
        ? 'var(--ac-success, #16a34a)'
        : 'var(--ac-text-muted, #6e6e6e)',
}));

const tagDomainStyle = computed(() => ({
  backgroundColor: 'var(--ac-accent-subtle, rgba(217, 119, 87, 0.12))',
  color: 'var(--ac-accent, #d97757)',
}));

const tagStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface-muted, #f2f0eb)',
  color: 'var(--ac-text-muted, #6e6e6e)',
}));

const actionStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface-muted, #f2f0eb)',
  color: 'var(--ac-text-muted, #6e6e6e)',
  borderRadius: 'var(--ac-radius-button, 8px)',
}));

const actionPrimaryStyle = computed(() => ({
  backgroundColor: 'var(--ac-accent, #d97757)',
  color: 'var(--ac-accent-contrast, #ffffff)',
  borderRadius: 'var(--ac-radius-button, 8px)',
}));

const menuStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface, #ffffff)',
  border: 'var(--ac-border-width, 1px) solid var(--ac-border, #e7e5e4)',
  borderRadius: 'var(--ac-radius-inner, 8px)',
  boxShadow: 'var(--ac-shadow-float, 0 4px 20px -2px rgba(0, 0, 0, 0.1))',
}));

const menuItemStyle = computed(() => ({
  color: 'var(--ac-text, #1a1a1a)',
}));

const menuItemDangerStyle = computed(() => ({
  color: 'var(--ac-danger, #ef4444)',
}));
</script>

<style scoped>
.workflow-item {
  padding: 16px;
  cursor: pointer;
}

.workflow-item:hover {
  background-color: var(--ac-hover-bg, #f5f5f4) !important;
  box-shadow: var(--ac-shadow-card, 0 1px 3px rgba(0, 0, 0, 0.08));
}

.workflow-content {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.workflow-info {
  flex: 1;
  min-width: 0;
}

.workflow-name {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
  margin-bottom: 2px;
  word-break: break-word;
}

.workflow-desc {
  font-size: 13px;
  line-height: 1.4;
  margin-bottom: 8px;
  word-break: break-word;
}

.workflow-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}

.workflow-badge {
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  border-radius: 999px;
  white-space: nowrap;
}

.workflow-status {
  font-size: 12px;
  margin-bottom: 8px;
  word-break: break-word;
}

.workflow-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.workflow-tag {
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 500;
  border-radius: 4px;
  white-space: nowrap;
}

.workflow-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  opacity: 0;
  transition: opacity var(--ac-motion-fast, 120ms) ease;
  position: relative;
}

.workflow-actions-visible {
  opacity: 1;
}

.workflow-action {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  cursor: pointer;
  transition: all var(--ac-motion-fast, 120ms) ease;
}

.workflow-action:hover {
  transform: translateY(-1px);
  box-shadow: var(--ac-shadow-float, 0 4px 20px -2px rgba(0, 0, 0, 0.05));
}

.workflow-action-primary:hover {
  background-color: var(--ac-accent-hover, #c4664a) !important;
}

.workflow-more-menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  min-width: 140px;
  padding: 4px;
  z-index: 100;
}

.workflow-menu-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 13px;
  background: transparent;
  border: none;
  border-radius: var(--ac-radius-button, 8px);
  cursor: pointer;
  transition: background-color var(--ac-motion-fast, 120ms) ease;
  text-align: left;
}

.workflow-menu-item:hover {
  background-color: var(--ac-hover-bg, #f5f5f4);
}

.workflow-menu-item-danger:hover {
  background-color: rgba(239, 68, 68, 0.1);
}

/* Menu fade transition */
.menu-fade-enter-active,
.menu-fade-leave-active {
  transition:
    opacity var(--ac-motion-fast, 120ms) ease,
    transform var(--ac-motion-fast, 120ms) ease;
}

.menu-fade-enter-from,
.menu-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
