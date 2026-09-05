<template>
  <div class="h-full flex flex-col" :style="containerStyle">
    <!-- Fixed Header: Search + Actions -->
    <div class="flex-shrink-0 px-4 py-3 border-b" :style="headerStyle">
      <div class="flex items-center gap-2">
        <!-- Search Input -->
        <div class="flex-1 relative">
          <svg
            class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4"
            :style="{ color: 'var(--ac-text-subtle)' }"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            :value="search"
            type="text"
            :placeholder="getMessage('sidepanel_search_flows_placeholder')"
            class="w-full pl-9 pr-3 py-2 text-sm"
            :style="inputStyle"
            @input="$emit('update:search', ($event.target as HTMLInputElement).value)"
          />
        </div>

        <!-- Refresh Button -->
        <button
          class="flex-shrink-0 p-2"
          :style="refreshButtonStyle"
          @click="$emit('refresh')"
          :title="getMessage('sidepanel_refresh_button')"
        >
          <svg
            class="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            stroke-width="2"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
        </button>

        <!-- 가져오기: JSON 파일을 골라 흐름을 들여온다 -->
        <button
          class="flex-shrink-0 px-3 py-2 text-xs font-medium"
          :style="refreshButtonStyle"
          @click="$emit('import')"
          :title="getMessage('sidepanel_daily_import_button')"
        >
          {{ getMessage('sidepanel_daily_import_button') }}
        </button>

        <!--
          예전 "새로 만들기" 버튼은 여기 있었다. 흐름은 녹화로만 만들고, 녹화 버튼은 이
          목록 바로 위 녹화 표시줄에 있으므로 같은 자리에 버튼을 둘로 두지 않는다.
        -->
      </div>

      <!--
        필터 바. 접이식이 아니라 늘 보이는 한 줄이다. 무엇이 걸려 있는지 보이지 않으면
        목록이 비었을 때 흐름이 없는 것으로 읽힌다.
      -->
      <div class="wf-filter-bar">
        <select
          class="wf-filter-select"
          :style="filterSelectStyle"
          :value="filter.site"
          @change="patchFilter({ site: ($event.target as HTMLSelectElement).value })"
        >
          <option value="">{{ getMessage('sidepanel_daily_filter_site_all') }}</option>
          <option v-for="site in sites" :key="site" :value="site">{{ site }}</option>
        </select>
        <button
          class="wf-chip"
          :style="filter.published ? chipOnStyle : chipStyle"
          @click="patchFilter({ published: !filter.published })"
        >
          {{ getMessage('sidepanel_daily_filter_published') }}
        </button>
        <button
          class="wf-chip"
          :style="filter.scheduled ? chipOnStyle : chipStyle"
          @click="patchFilter({ scheduled: !filter.scheduled })"
        >
          {{ getMessage('sidepanel_daily_filter_scheduled') }}
        </button>
        <button
          class="wf-chip"
          :style="filter.recentFailed ? chipOnStyle : chipStyle"
          @click="patchFilter({ recentFailed: !filter.recentFailed })"
        >
          {{ getMessage('sidepanel_daily_filter_recent_failed') }}
        </button>
        <button
          v-if="filterActive"
          class="wf-chip"
          :style="chipStyle"
          @click="$emit('update:filter', { ...EMPTY_FLOW_FILTER })"
        >
          {{ getMessage('sidepanel_daily_filter_clear') }}
        </button>
      </div>

      <!-- Filter Bar -->
      <div class="flex items-center justify-between mt-3">
        <label
          class="flex items-center gap-2 text-sm cursor-pointer"
          :style="{ color: 'var(--ac-text-muted)' }"
        >
          <input
            type="checkbox"
            :checked="onlyBound"
            @change="$emit('update:onlyBound', ($event.target as HTMLInputElement).checked)"
            class="workflow-checkbox"
          />
          <span>{{ getMessage('sidepanel_current_page_only') }}</span>
        </label>
        <span class="text-xs" :style="{ color: 'var(--ac-text-subtle)' }">
          {{ getMessage('sidepanel_flow_count', [String(flows.length)]) }}
        </span>
      </div>
    </div>

    <!-- Scrollable Content -->
    <div class="flex-1 overflow-y-auto ac-scroll">
      <!-- Empty State -->
      <div v-if="flows.length === 0" class="flex flex-col items-center justify-center py-12 px-4">
        <div
          class="w-16 h-16 rounded-full flex items-center justify-center mb-4"
          :style="{ backgroundColor: 'var(--ac-surface-muted)' }"
        >
          <svg
            class="w-8 h-8"
            :style="{ color: 'var(--ac-text-subtle)' }"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="1.5"
              d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z"
            />
          </svg>
        </div>
        <div class="text-sm font-medium mb-1" :style="{ color: 'var(--ac-text)' }">
          {{
            search
              ? getMessage('sidepanel_no_matching_flows')
              : getMessage('sidepanel_no_flows_yet')
          }}
        </div>
        <div class="text-xs text-center mb-4" :style="{ color: 'var(--ac-text-muted)' }">
          {{
            search
              ? getMessage('sidepanel_search_hides_flows', [String(totalCount)])
              : getMessage('sidepanel_record_first_flow')
          }}
        </div>
        <!--
          검색어 때문에 목록이 비면 "흐름이 하나도 없다" 로 보인다. 실제 시연에서 발행 직후
          목록이 비어 보인 원인이 이것이었다 (2026-09-05 시연 지적 4항). 전체 개수를 함께
          알리고 한 번에 되돌릴 버튼을 둔다.
        -->
        <button
          v-if="search"
          class="px-4 py-2 text-sm font-medium"
          :style="newButtonStyle"
          @click="$emit('update:search', '')"
        >
          {{ getMessage('sidepanel_clear_search_button') }}
        </button>
        <button
          v-else
          class="px-4 py-2 text-sm font-medium"
          :style="newButtonStyle"
          @click="$emit('create')"
        >
          {{ getMessage('sidepanel_create_flow_button') }}
        </button>
      </div>

      <!-- Workflow List -->
      <div v-else class="px-4 py-3 space-y-3">
        <WorkflowListItem
          v-for="flow in flows"
          :key="flow.id"
          :flow="flow"
          :status="statuses?.[flow.id] || null"
          :schedule="schedules?.[flow.id] || null"
          :last-success-at="lastSuccessAt?.[flow.id] || null"
          @run="$emit('run', $event)"
          @schedule="$emit('schedule', $event)"
          @edit="$emit('edit', $event)"
          @delete="$emit('delete', $event)"
          @export="$emit('export', $event)"
          @publish="$emit('publish', $event)"
          @unpublish="$emit('unpublish', $event)"
        />
      </div>

      <!-- Advanced Settings (Collapsible) -->
      <div class="px-4 pb-4">
        <div class="advanced-divider" :style="dividerStyle">
          <span
            :style="{
              backgroundColor: 'var(--ac-surface)',
              padding: '0 12px',
              color: 'var(--ac-text-subtle)',
            }"
          >
            {{ getMessage('sidepanel_advanced_section') }}
          </span>
        </div>

        <!-- Run History Section -->
        <div class="advanced-section" :style="sectionStyle">
          <button
            class="advanced-section-header"
            :style="sectionHeaderStyle"
            @click="toggleSection('runs')"
          >
            <div class="flex items-center gap-2">
              <svg
                class="w-4 h-4 transition-transform"
                :class="{ 'rotate-90': expandedSections.has('runs') }"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                stroke-width="2"
              >
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              <span>{{ getMessage('sidepanel_run_history_title') }}</span>
            </div>
            <span class="text-xs" :style="{ color: 'var(--ac-text-subtle)' }">{{
              runs.length
            }}</span>
          </button>

          <Transition name="section-expand">
            <div v-if="expandedSections.has('runs')" class="advanced-section-content">
              <div
                v-if="runs.length === 0"
                class="text-sm py-3"
                :style="{ color: 'var(--ac-text-muted)' }"
              >
                {{ getMessage('sidepanel_no_run_history') }}
              </div>
              <!--
                예전에는 최근 5건만 보여 줬다. 실패를 찾으려면 그 5건 밖을 봐야 하는 일이
                잦아 제한을 없앴다 (2026-09-05 사이드패널 2단계).
              -->
              <div v-else class="space-y-2 py-2">
                <div
                  v-for="run in runs"
                  :key="run.id"
                  class="run-item"
                  :style="runItemStyle"
                  @click="$emit('toggleRun', run.id)"
                >
                  <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2">
                      <span
                        class="w-2 h-2 rounded-full"
                        :class="{ 'animate-pulse': run.isInProgress }"
                        :style="{ backgroundColor: getRunStatusColor(run) }"
                      ></span>
                      <span class="text-sm" :style="{ color: 'var(--ac-text)' }">{{
                        getFlowName(run.flowId)
                      }}</span>
                      <span
                        v-if="run.status"
                        class="text-xs px-1.5 py-0.5 rounded"
                        :style="{
                          backgroundColor: run.isInProgress
                            ? 'var(--ac-primary-light, #dbeafe)'
                            : run.success
                              ? 'var(--ac-success-light, #dcfce7)'
                              : 'var(--ac-danger-light, #fee2e2)',
                          color: getRunStatusColor(run),
                        }"
                      >
                        {{ getRunStatusText(run) }}
                      </span>
                    </div>
                    <span class="text-xs" :style="{ color: 'var(--ac-text-subtle)' }">
                      {{ formatTime(run.startedAt) }}
                    </span>
                  </div>
                  <!-- Run details (if expanded) -->
                  <div
                    v-if="openRunId === run.id"
                    class="mt-2 pt-2 border-t"
                    :style="{ borderColor: 'var(--ac-border)' }"
                  >
                    <!-- V3: Show status info when no entries -->
                    <div
                      v-if="run.entries.length === 0 && run.status"
                      class="text-xs py-1"
                      :style="{ color: 'var(--ac-text-muted)' }"
                    >
                      <div class="flex items-center gap-2">
                        <span
                          >{{ getMessage('sidepanel_status_label') }}:
                          {{ getRunStatusText(run) }}</span
                        >
                        <span v-if="run.finishedAt"
                          >• {{ getMessage('sidepanel_elapsed_time_label') }}:
                          {{
                            Math.round(
                              (new Date(run.finishedAt).getTime() -
                                new Date(run.startedAt).getTime()) /
                                1000,
                            )
                          }}s</span
                        >
                      </div>
                    </div>
                    <!-- V2: Show entries -->
                    <div
                      v-for="(entry, idx) in run.entries"
                      :key="idx"
                      class="text-xs py-1"
                      :style="{
                        color:
                          entry.status === 'failed' ? 'var(--ac-danger)' : 'var(--ac-text-muted)',
                      }"
                    >
                      #{{ idx + 1 }} {{ entry.status }} ·
                      {{ getMessage('sidepanel_step_label') }}={{ entry.stepId }}
                      <span v-if="entry.tookMs" class="ml-2">{{ entry.tookMs }}ms</span>
                    </div>
                    <!--
                      수동 실행의 실패 화면은 흐름 엔진이 base64 로 남긴다(파일이 아니다).
                      그대로 썸네일로 보여 준다. 예약 실행의 파일 스크린샷은 매일 작업 탭에서
                      "스크린샷 열기" 로 연다.
                    -->
                    <img
                      v-if="failureShot(run)"
                      class="run-shot"
                      :src="failureShot(run)"
                      :alt="getMessage('sidepanel_daily_screenshot_alt')"
                    />
                  </div>
                </div>
              </div>
            </div>
          </Transition>
        </div>

        <!--
          트리거 섹션은 1단계에서 걷어 냈다 (2026-09-05 Codex 교차 리뷰 4항). 화면은 V3
          RPC 로 트리거를 읽었는데 실제로 트리거를 켜고 끄는 엔진은 V2 trigger-store 라,
          목록에 보이는 것과 실제로 도는 것이 서로 다른 저장소였다. 예약은 2단계에서
          예약 레코드가 흐름 id 를 직접 가리키는 방식으로 다시 만든다.
        -->
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, computed } from 'vue';
import { getMessage } from '@/utils/i18n';
import WorkflowListItem from './WorkflowListItem.vue';
import { EMPTY_FLOW_FILTER, isFilterActive, type FlowFilterState } from '../../utils/flow-filters';
import type { ScheduleView } from '../../utils/daily-messages';

interface FlowLite {
  id: string;
  name: string;
  description?: string;
  published?: { slug: string; version: number };
  needsRepublish?: boolean;
  meta?: {
    domain?: string;
    tags?: string[];
    bindings?: any[];
  };
}

interface RunLite {
  id: string;
  flowId: string;
  startedAt: string;
  finishedAt?: string;
  success?: boolean;
  /** Whether the run is still in progress (queued/running/paused) */
  isInProgress?: boolean;
  /** V3 run status */
  status?: 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'canceled';
  entries: any[];
}

const props = defineProps<{
  /** 이미 검색·필터가 적용된 목록. 거르는 일은 상위(App.vue)가 한 곳에서 한다. */
  flows: FlowLite[];
  runs: RunLite[];
  onlyBound: boolean;
  openRunId: string | null;
  /**
   * 검색어. 이 컴포넌트가 따로 들고 있지 않고 상위 상태를 그대로 비춘다
   * (2026-09-05 시연 지적 4항). 저장·발행 뒤 상위가 검색을 지워 새 카드가 곧바로 보인다.
   */
  search: string;
  /** 검색·필터 이전의 전체 흐름 수. 검색 때문에 비었을 때 안내에 쓴다. */
  totalCount: number;
  /** 흐름별 마지막 실행 결과. 카드에 그대로 보여 준다. */
  statuses?: Record<string, { kind: 'running' | 'ok' | 'error'; text: string }>;
  /** 흐름 id → 그 흐름에 걸린 예약. 카드 배지에 쓴다. */
  schedules?: Record<string, ScheduleView>;
  /** 흐름 id → 마지막으로 성공한 시각(epoch ms). */
  lastSuccessAt?: Record<string, number>;
  /** 필터 바 상태. 실제로 거르는 일은 상위가 한다. */
  filter: FlowFilterState;
  /** 필터 바의 사이트 선택지. */
  sites: string[];
}>();

const emit = defineEmits<{
  (e: 'refresh'): void;
  (e: 'create'): void;
  (e: 'run', id: string): void;
  (e: 'edit', id: string): void;
  (e: 'delete', id: string): void;
  (e: 'export', id: string): void;
  (e: 'publish', id: string): void;
  (e: 'unpublish', id: string): void;
  (e: 'update:onlyBound', value: boolean): void;
  (e: 'update:search', value: string): void;
  (e: 'update:filter', value: FlowFilterState): void;
  (e: 'toggleRun', id: string): void;
  (e: 'schedule', id: string): void;
  (e: 'import'): void;
}>();

// Local state
const expandedSections = ref<Set<string>>(new Set());

const filterActive = computed(() => isFilterActive(props.filter));

function patchFilter(patch: Partial<FlowFilterState>): void {
  emit('update:filter', { ...props.filter, ...patch });
}

/**
 * 실패한 수동 실행의 화면(base64).
 *
 * 흐름 엔진은 마지막 단계 기록에 `screenshotBase64` 를 남긴다. 데이터 URL 접두가 붙어 있지
 * 않은 형태도 있어 여기서 맞춘다.
 */
function failureShot(run: RunLite): string {
  const entries = Array.isArray(run.entries) ? (run.entries as Array<Record<string, unknown>>) : [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const raw = entries[i]?.screenshotBase64;
    if (typeof raw === 'string' && raw) {
      return raw.startsWith('data:') ? raw : `data:image/png;base64,${raw}`;
    }
  }
  return '';
}

// Helper functions
function getFlowName(flowId: string): string {
  const flow = props.flows.find((f) => f.id === flowId);
  return flow?.name || flowId;
}

/**
 * Get the status color for a run
 * - In progress (queued/running/paused): blue/primary
 * - Succeeded: green/success
 * - Failed/canceled: red/danger
 */
function getRunStatusColor(run: RunLite): string {
  // V3 style: check isInProgress first
  if (run.isInProgress) {
    return 'var(--ac-primary, #3b82f6)';
  }
  // V3 style: check status
  if (run.status) {
    if (run.status === 'succeeded') return 'var(--ac-success, #22c55e)';
    if (run.status === 'failed' || run.status === 'canceled') return 'var(--ac-danger, #ef4444)';
    // queued/running/paused - should be caught by isInProgress but just in case
    return 'var(--ac-primary, #3b82f6)';
  }
  // V2 fallback: use success boolean
  return run.success ? 'var(--ac-success, #22c55e)' : 'var(--ac-danger, #ef4444)';
}

/**
 * Get the status text for a run
 */
function getRunStatusText(run: RunLite): string {
  if (run.status) {
    const statusMap: Record<string, string> = {
      queued: getMessage('sidepanel_run_status_queued'),
      running: getMessage('sidepanel_run_status_running'),
      paused: getMessage('sidepanel_run_status_paused'),
      succeeded: getMessage('sidepanel_run_status_succeeded'),
      failed: getMessage('sidepanel_run_status_failed'),
      canceled: getMessage('sidepanel_run_status_canceled'),
    };
    return statusMap[run.status] || run.status;
  }
  // V2 fallback
  return run.success
    ? getMessage('sidepanel_run_status_succeeded')
    : getMessage('sidepanel_run_status_failed');
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString();
}

function toggleSection(section: string) {
  if (expandedSections.value.has(section)) {
    expandedSections.value.delete(section);
  } else {
    expandedSections.value.add(section);
  }
  expandedSections.value = new Set(expandedSections.value);
}

// Computed styles
const containerStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface)',
}));

const headerStyle = computed(() => ({
  borderColor: 'var(--ac-border)',
  backgroundColor: 'var(--ac-surface)',
}));

const inputStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface-muted)',
  border: 'var(--ac-border-width) solid var(--ac-border)',
  borderRadius: 'var(--ac-radius-button)',
  color: 'var(--ac-text)',
  outline: 'none',
}));

const refreshButtonStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface-muted)',
  color: 'var(--ac-text-muted)',
  borderRadius: 'var(--ac-radius-button)',
  border: 'none',
}));

const newButtonStyle = computed(() => ({
  backgroundColor: 'var(--ac-accent)',
  color: 'var(--ac-accent-contrast)',
  borderRadius: 'var(--ac-radius-button)',
}));

const dividerStyle = computed(() => ({
  borderColor: 'var(--ac-border)',
}));

const sectionStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface)',
  border: 'var(--ac-border-width) solid var(--ac-border)',
  borderRadius: 'var(--ac-radius-inner)',
}));

const sectionHeaderStyle = computed(() => ({
  color: 'var(--ac-text)',
}));

const runItemStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface-muted)',
  borderRadius: 'var(--ac-radius-button)',
}));

const filterSelectStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface-muted)',
  color: 'var(--ac-text)',
  border: 'var(--ac-border-width) solid var(--ac-border)',
  borderRadius: 'var(--ac-radius-button)',
}));

const chipStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface-muted)',
  color: 'var(--ac-text-muted)',
  borderRadius: 'var(--ac-radius-button, 999px)',
}));

const chipOnStyle = computed(() => ({
  backgroundColor: 'var(--ac-accent)',
  color: 'var(--ac-accent-contrast)',
  borderRadius: 'var(--ac-radius-button, 999px)',
}));
</script>

<style scoped>
/* 필터 바: 늘 보이는 한 줄 */
.wf-filter-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  overflow-x: auto;
  padding-bottom: 2px;
}

.wf-filter-select {
  height: 28px;
  font-size: 12px;
  padding: 0 6px;
  font-family: inherit;
  outline: none;
  flex-shrink: 0;
  max-width: 40%;
}

.wf-chip {
  border: none;
  padding: 5px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  white-space: nowrap;
  flex-shrink: 0;
}

/* 실패 화면 썸네일 */
.run-shot {
  margin-top: 6px;
  max-width: 100%;
  max-height: 160px;
  border-radius: var(--ac-radius-inner, 8px);
  border: var(--ac-border-width, 1px) solid var(--ac-border, #e7e5e4);
}

.workflow-checkbox {
  width: 16px;
  height: 16px;
  border-radius: 4px;
  border: var(--ac-border-width, 1px) solid var(--ac-border, #e7e5e4);
  appearance: none;
  cursor: pointer;
  transition: all var(--ac-motion-fast, 120ms) ease;
}

.workflow-checkbox:checked {
  background-color: var(--ac-accent, #d97757);
  border-color: var(--ac-accent, #d97757);
  background-image: url("data:image/svg+xml,%3csvg viewBox='0 0 16 16' fill='white' xmlns='http://www.w3.org/2000/svg'%3e%3cpath d='M12.207 4.793a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0l-2-2a1 1 0 011.414-1.414L6.5 9.086l4.293-4.293a1 1 0 011.414 0z'/%3e%3c/svg%3e");
}

.advanced-divider {
  display: flex;
  align-items: center;
  text-align: center;
  margin: 20px 0 16px;
  font-size: 12px;
  font-weight: 500;
}

.advanced-divider::before,
.advanced-divider::after {
  content: '';
  flex: 1;
  border-bottom: var(--ac-border-width, 1px) solid var(--ac-border, #e7e5e4);
}

.advanced-section {
  margin-bottom: 8px;
  overflow: hidden;
}

.advanced-section-header {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  font-size: 13px;
  font-weight: 500;
  background: transparent;
  border: none;
  cursor: pointer;
  transition: background-color var(--ac-motion-fast, 120ms) ease;
}

.advanced-section-header:hover {
  background-color: var(--ac-hover-bg, #f5f5f4);
}

.advanced-section-content {
  padding: 0 12px 12px;
}

.run-item {
  padding: 10px 12px;
  cursor: pointer;
  transition: background-color var(--ac-motion-fast, 120ms) ease;
}

.run-item:hover {
  background-color: var(--ac-hover-bg, #f5f5f4) !important;
}

/* Section expand transition */
.section-expand-enter-active,
.section-expand-leave-active {
  transition: all var(--ac-motion-normal, 180ms) ease;
  overflow: hidden;
}

.section-expand-enter-from,
.section-expand-leave-to {
  opacity: 0;
  max-height: 0;
}

.section-expand-enter-to,
.section-expand-leave-from {
  opacity: 1;
  max-height: 500px;
}
</style>
