<template>
  <div class="ac-card wf-item">
    <!-- 이름: 딴 것 없이 이름 한 줄만. 배지·상태는 아래 정보 목록으로 옮겼다. -->
    <div class="ac-heading wf-item-name" :title="flowName">{{ flowName }}</div>

    <!-- 정보 목록: 라벨 + 값. 초보자가 "이게 뭔 뜻이지" 하고 멈추지 않도록 상태 한 줄에도
         무엇을 할 수 있는지까지 적는다 (2026-09-06 사용자 피드백). 값이 없는 줄은 숨긴다. -->
    <div class="wf-info-list">
      <div class="wf-info-row">
        <span class="wf-info-label">{{ getMessage('sidepanel_card_status_label') }}</span>
        <span class="wf-info-value" :class="statusValueClass">{{ statusText }}</span>
      </div>

      <div v-if="siteDomain" class="wf-info-row">
        <span class="wf-info-label">{{ getMessage('sidepanel_card_site_label') }}</span>
        <span class="wf-info-value ac-clip" :title="siteDomain">{{ siteDomain }}</span>
      </div>

      <div class="wf-info-row">
        <span class="wf-info-label">{{ getMessage('sidepanel_card_last_run_label') }}</span>
        <span class="wf-info-value" :class="lastRunValueClass">{{ lastRunText }}</span>
      </div>

      <div v-if="showNextSchedule" class="wf-info-row">
        <span class="wf-info-label">{{ getMessage('sidepanel_card_next_schedule_label') }}</span>
        <span class="wf-info-value ac-clip">{{ nextScheduleText }}</span>
      </div>

      <div v-if="showDescription" class="wf-info-row">
        <span class="wf-info-label">{{ getMessage('sidepanel_card_description_label') }}</span>
        <span class="wf-info-value ac-clip" :title="flow.description">{{ flow.description }}</span>
      </div>
    </div>

    <!-- 실행·예약·편집·더보기: 글자 없는 아이콘만으로는 무엇을 하는 버튼인지 몰랐다는
         피드백에 따라 글자를 붙인다 (더보기는 메뉴가 펼쳐지므로 title 로만 안내). -->
    <div class="wf-actions">
      <button
        class="ac-button ac-button--primary ac-button--sm"
        type="button"
        @click.stop="$emit('run', flow.id)"
        :title="getMessage('sidepanel_card_run_action')"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M8 5v14l11-7z" />
        </svg>
        <span>{{ getMessage('sidepanel_card_run_action') }}</span>
      </button>
      <button
        class="ac-button ac-button--ghost ac-button--sm"
        type="button"
        @click.stop="$emit('schedule', flow.id)"
        :title="getMessage('sidepanel_card_schedule_action')"
      >
        {{ getMessage('sidepanel_card_schedule_action') }}
      </button>
      <button
        class="ac-button ac-button--ghost ac-button--sm"
        type="button"
        @click.stop="$emit('edit', flow.id)"
        :title="getMessage('sidepanel_card_edit_action')"
      >
        {{ getMessage('sidepanel_card_edit_action') }}
      </button>
      <div class="wf-more">
        <button
          class="ac-icon-button"
          type="button"
          @click.stop="toggleMoreMenu"
          :title="getMessage('sidepanel_card_more_action')"
          :aria-label="getMessage('sidepanel_card_more_action')"
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
</template>

<script lang="ts" setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { getMessage } from '@/utils/i18n';
import { formatCardLastRunLine, formatNextRun } from '../../utils/daily-format';
import {
  cardStatusKind,
  formatCardStatusText,
  shouldShowDescription,
  shouldShowNextSchedule,
} from '../../utils/card-format';
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
  /** 지금 실행 중인가. 실행 중일 때만 "마지막 실행" 줄을 이걸로 덮는다. */
  status?: { kind: 'running' | 'ok' | 'error'; text: string } | null;
  /** 이 흐름에 걸린 예약. 있으면 "다음 예약" 줄을 보여준다. */
  schedule?: ScheduleView | null;
  /** 마지막으로 성공한 시각(epoch ms). 지금은 "마지막 실행" 줄 계산에 안 쓰이지만
   * 다른 화면(필터 등)이 같은 요약을 함께 참조하므로 그대로 받아 둔다. */
  lastSuccessAt?: number | null;
  /** 마지막으로 끝난 실행의 시각(성공·실패 통틀어 가장 최근 것). */
  lastRunAt?: number | null;
  /** 마지막으로 끝난 실행의 결과. */
  lastRunOutcome?: 'success' | 'failure' | null;
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

const siteDomain = computed(() => props.flow.meta?.domain || '');

/** 상태 줄. "발행됨" 한 단어가 아니라 무엇을 할 수 있는지까지 말한다. */
const statusText = computed(() =>
  formatCardStatusText(!!props.flow.published, !!props.flow.needsRepublish),
);

const statusValueClass = computed(() => {
  const kind = cardStatusKind(!!props.flow.published, !!props.flow.needsRepublish);
  if (kind === 'published') return 'ac-text-accent';
  if (kind === 'needs_republish') return 'ac-text-warning';
  return '';
});

/** "마지막 실행" 줄. 지금 실행 중이면 그 진행 문구, 아니면 마지막으로 끝난 실행의 결과. */
const lastRunText = computed(() => {
  if (props.status?.kind === 'running') return props.status.text;
  return formatCardLastRunLine(props.lastRunOutcome ?? null, props.lastRunAt ?? null);
});

const lastRunValueClass = computed(() => {
  if (props.status?.kind === 'running') return '';
  if (props.lastRunOutcome === 'success') return 'ac-text-success';
  if (props.lastRunOutcome === 'failure') return 'ac-text-danger';
  return '';
});

/** "다음 예약" 줄. 꺼 둔 예약은 그렇게 적는다 - 다음 실행 시각을 보여주면 돌 것처럼 읽힌다. */
const nextScheduleText = computed(() => {
  const schedule = props.schedule;
  if (!schedule) return '';
  if (!schedule.enabled) return getMessage('sidepanel_daily_paused');
  return formatNextRun(schedule.nextAt);
});

const showNextSchedule = computed(() => shouldShowNextSchedule(props.schedule ?? null));
const showDescription = computed(() => shouldShowDescription(props.flow.description));

const showMoreMenu = ref(false);

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
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 긴 이름은 한 줄로 자른다. 전체 이름은 title 속성에 있다. */
.wf-item-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wf-info-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.wf-info-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.wf-info-label {
  flex: 0 0 64px;
  font-size: 13px;
  font-weight: 500;
  line-height: 18px;
  color: var(--ac-text-caption);
}

.wf-info-value {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 18px;
  color: var(--ac-text);
  word-break: break-word;
}

/*
  실행·예약·편집·더보기는 늘 보인다. 예전에는 마우스를 올려야 나타났는데, 좁은 패널에서는
  그 버튼이 있는 줄도 모르고 지나친다.
*/
.wf-actions {
  display: flex;
  align-items: center;
  gap: 6px;
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

.wf-menu-item-danger {
  color: var(--ac-danger-text);
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

@media (hover: hover) and (pointer: fine) {
  .wf-menu-item:hover {
    background-color: var(--ac-surface-muted);
  }

  .wf-menu-item-danger:hover {
    background-color: var(--ac-danger-soft);
  }
}
</style>
