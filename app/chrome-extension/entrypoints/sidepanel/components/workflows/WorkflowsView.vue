<template>
  <div class="wf-root">
    <!-- 고정 머리말: 검색 + 새로고침 + 가져오기 -->
    <div class="wf-header">
      <div class="wf-header-row">
        <div class="wf-search">
          <svg
            class="wf-search-icon"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            width="16"
            height="16"
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
            class="ac-field wf-search-input"
            :placeholder="getMessage('sidepanel_search_flows_placeholder')"
            @input="$emit('update:search', ($event.target as HTMLInputElement).value)"
          />
        </div>

        <button
          class="ac-icon-button wf-header-icon"
          type="button"
          @click="$emit('refresh')"
          :title="getMessage('sidepanel_refresh_button')"
        >
          <svg
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            stroke-width="2"
            width="20"
            height="20"
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
          class="ac-button ac-button--ghost ac-button--sm"
          type="button"
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
          class="ac-field wf-filter-select"
          :value="filter.site"
          @change="patchFilter({ site: ($event.target as HTMLSelectElement).value })"
        >
          <option value="">{{ getMessage('sidepanel_daily_filter_site_all') }}</option>
          <option v-for="site in sites" :key="site" :value="site">{{ site }}</option>
        </select>
        <button
          class="ac-chip"
          :class="{ 'ac-chip--on': filter.published }"
          type="button"
          @click="patchFilter({ published: !filter.published })"
        >
          {{ getMessage('sidepanel_daily_filter_published') }}
        </button>
        <button
          class="ac-chip"
          :class="{ 'ac-chip--on': filter.scheduled }"
          type="button"
          @click="patchFilter({ scheduled: !filter.scheduled })"
        >
          {{ getMessage('sidepanel_daily_filter_scheduled') }}
        </button>
        <button
          class="ac-chip"
          :class="{ 'ac-chip--on': filter.recentFailed }"
          type="button"
          @click="patchFilter({ recentFailed: !filter.recentFailed })"
        >
          {{ getMessage('sidepanel_daily_filter_recent_failed') }}
        </button>
        <button
          v-if="filterActive"
          class="ac-chip wf-filter-clear"
          type="button"
          :title="getMessage('sidepanel_daily_filter_clear')"
          :aria-label="getMessage('sidepanel_daily_filter_clear')"
          @click="$emit('update:filter', { ...EMPTY_FLOW_FILTER })"
        >
          &times;
        </button>
      </div>

      <!-- 범위 표시: 현재 페이지만 볼 것인가와 지금 보이는 개수 -->
      <div class="wf-scope">
        <label class="wf-scope-check ac-sub">
          <input
            type="checkbox"
            class="ac-check"
            :checked="onlyBound"
            @change="$emit('update:onlyBound', ($event.target as HTMLInputElement).checked)"
          />
          <span>{{ getMessage('sidepanel_current_page_only') }}</span>
        </label>
        <span class="ac-caption ac-num">
          {{ getMessage('sidepanel_flow_count', [String(flows.length)]) }}
        </span>
      </div>
    </div>

    <!-- 목록 -->
    <div class="wf-body ac-scroll">
      <!-- 빈 상태: 아이콘 없이 제목 + 보조 + 주 버튼 -->
      <div v-if="flows.length === 0" class="wf-empty">
        <div class="ac-heading">
          {{
            search
              ? getMessage('sidepanel_no_matching_flows')
              : getMessage('sidepanel_no_flows_yet')
          }}
        </div>
        <!--
          검색어 때문에 목록이 비면 "흐름이 하나도 없다" 로 보인다. 실제 시연에서 발행 직후
          목록이 비어 보인 원인이 이것이었다 (2026-09-05 시연 지적 4항). 전체 개수를 함께
          알리고 한 번에 되돌릴 버튼을 둔다.
        -->
        <div class="ac-sub wf-empty-hint">
          {{
            search
              ? getMessage('sidepanel_search_hides_flows', [String(totalCount)])
              : getMessage('sidepanel_record_first_flow')
          }}
        </div>
        <button
          v-if="search"
          class="ac-button ac-button--primary"
          type="button"
          @click="$emit('update:search', '')"
        >
          {{ getMessage('sidepanel_clear_search_button') }}
        </button>
        <button v-else class="ac-button ac-button--primary" type="button" @click="$emit('create')">
          {{ getMessage('sidepanel_create_flow_button') }}
        </button>
      </div>

      <!-- 흐름 카드 -->
      <div v-else class="wf-list">
        <WorkflowListItem
          v-for="flow in flows"
          :key="flow.id"
          :flow="flow"
          :status="statuses?.[flow.id] || null"
          :schedule="schedules?.[flow.id] || null"
          :last-success-at="lastSuccessAt?.[flow.id] || null"
          :last-run-at="lastRunAt?.[flow.id] || null"
          :last-run-outcome="lastRunOutcome?.[flow.id] || null"
          @run="$emit('run', $event)"
          @schedule="$emit('schedule', $event)"
          @edit="$emit('edit', $event)"
          @delete="$emit('delete', $event)"
          @export="$emit('export', $event)"
          @publish="$emit('publish', $event)"
          @unpublish="$emit('unpublish', $event)"
        />
      </div>

      <!-- 접어 둔 실행 이력 -->
      <div class="wf-advanced">
        <div class="wf-advanced-label ac-caption">
          {{ getMessage('sidepanel_advanced_section') }}
        </div>

        <div class="ac-card wf-section">
          <button class="wf-section-header" type="button" @click="toggleSection('runs')">
            <span class="wf-section-title">
              <svg
                class="wf-caret"
                :class="{ 'wf-caret-open': expandedSections.has('runs') }"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                stroke-width="2"
                width="16"
                height="16"
              >
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              <span>{{ getMessage('sidepanel_run_history_title') }}</span>
            </span>
            <span class="ac-caption ac-num">{{ runs.length }}</span>
          </button>

          <Transition name="section-expand">
            <div v-if="expandedSections.has('runs')" class="wf-section-body">
              <div v-if="runs.length === 0" class="ac-sub wf-section-empty">
                {{ getMessage('sidepanel_no_run_history') }}
              </div>
              <!--
                예전에는 최근 5건만 보여 줬다. 실패를 찾으려면 그 5건 밖을 봐야 하는 일이
                잦아 제한을 없앴다 (2026-09-05 사이드패널 2단계).
              -->
              <div v-else class="wf-runs">
                <div
                  v-for="run in runs"
                  :key="run.id"
                  class="wf-run"
                  @click="$emit('toggleRun', run.id)"
                >
                  <div class="wf-run-head">
                    <span
                      class="wf-run-dot"
                      :class="{ 'ac-pulse': run.isInProgress }"
                      :style="{ backgroundColor: getRunStatusColor(run) }"
                    ></span>
                    <span class="wf-run-name ac-body ac-clip">{{ getFlowName(run.flowId) }}</span>
                    <span
                      v-if="run.status"
                      class="wf-run-status ac-caption"
                      :style="{ color: getRunStatusColor(run) }"
                    >
                      {{ getRunStatusText(run) }}
                    </span>
                    <span class="wf-run-time ac-caption ac-num">
                      {{ formatTime(run.startedAt) }}
                    </span>
                  </div>

                  <!-- 펼친 실행의 자세한 내용 -->
                  <div v-if="openRunId === run.id" class="wf-run-detail ac-hairline-top">
                    <!-- V3: 기록이 없으면 상태만이라도 보여 준다 -->
                    <div v-if="run.entries.length === 0 && run.status" class="ac-caption">
                      <span
                        >{{ getMessage('sidepanel_status_label') }}:
                        {{ getRunStatusText(run) }}</span
                      >
                      <span v-if="run.finishedAt" class="wf-run-elapsed">
                        {{ getMessage('sidepanel_elapsed_time_label') }}:
                        {{
                          Math.round(
                            (new Date(run.finishedAt).getTime() -
                              new Date(run.startedAt).getTime()) /
                              1000,
                          )
                        }}s
                      </span>
                    </div>
                    <!-- V2: 단계 기록 -->
                    <div
                      v-for="(entry, idx) in run.entries"
                      :key="idx"
                      class="ac-caption wf-run-entry"
                      :class="{ 'ac-text-danger': entry.status === 'failed' }"
                    >
                      <span class="ac-num">#{{ idx + 1 }}</span> {{ entry.status }} ·
                      {{ getMessage('sidepanel_step_label') }}={{ entry.stepId }}
                      <span v-if="entry.tookMs" class="ac-num wf-run-took"
                        >{{ entry.tookMs }}ms</span
                      >
                    </div>
                    <!--
                      수동 실행의 실패 화면은 흐름 엔진이 base64 로 남긴다(파일이 아니다).
                      그대로 썸네일로 보여 준다. 예약 실행의 파일 스크린샷은 매일 작업 탭에서
                      "스크린샷 열기" 로 연다.
                    -->
                    <img
                      v-if="failureShot(run)"
                      class="wf-run-shot"
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
  /** 흐름 id → 마지막으로 끝난 실행의 시각(성공·실패 통틀어 가장 최근 것). */
  lastRunAt?: Record<string, number>;
  /** 흐름 id → 마지막으로 끝난 실행의 결과. */
  lastRunOutcome?: Record<string, 'success' | 'failure'>;
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
 * 실행 한 건의 상태 색. 토큰만 돌려준다.
 * - 진행 중(queued/running/paused): 강조 파랑
 * - 성공: 성공 파랑
 * - 실패·취소: 위험 빨강
 */
function getRunStatusColor(run: RunLite): string {
  if (run.isInProgress) return 'var(--ac-accent)';
  if (run.status) {
    if (run.status === 'succeeded') return 'var(--ac-success)';
    if (run.status === 'failed' || run.status === 'canceled') return 'var(--ac-danger-text)';
    return 'var(--ac-accent)';
  }
  return run.success ? 'var(--ac-success)' : 'var(--ac-danger-text)';
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
</script>

<style scoped>
.wf-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background-color: var(--ac-bg);
}

/* 머리말은 바탕색 위에 그대로 앉는다. 카드가 아니라 배경으로 구분한다. */
.wf-header {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
}

.wf-header-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.wf-search {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
}

.wf-search-icon {
  position: absolute;
  left: 12px;
  color: var(--ac-text-tertiary);
  pointer-events: none;
}

.wf-search-input {
  padding-left: 36px;
}

.wf-header-icon {
  flex-shrink: 0;
}

/*
  필터 줄은 한 줄에 전부 보여야 한다(사용자 요구, 2026-09-06). 가로 스크롤도 줄바꿈도 없다.
  좁은 패널(360px)에서도 들어가도록 사이트 선택은 줄어들고(말줄임), 칩은 여백을 줄이며
  줄어들지 않는다. 필터 지우기는 아이콘 하나로 자리를 아낀다.
*/
.wf-filter-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  white-space: nowrap;
}

.wf-filter-bar > .ac-chip {
  flex-shrink: 0;
  padding: 0 8px;
  white-space: nowrap;
}

.wf-filter-clear {
  width: 32px;
  padding: 0;
  font-size: 18px;
  line-height: 1;
}

.wf-filter-select {
  width: auto;
  height: 32px;
  flex: 0 1 auto;
  min-width: 0;
  max-width: 34%;
  font-size: 13px;
  font-weight: 600;
  padding-left: 10px;
  padding-right: 24px;
  background-position: right 6px center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wf-scope {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.wf-scope-check {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.wf-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 12px 24px;
}

.wf-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 48px 16px;
  text-align: center;
}

.wf-empty-hint {
  margin-bottom: 8px;
}

.wf-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.wf-advanced {
  margin-top: 24px;
}

.wf-advanced-label {
  padding: 0 4px 8px;
}

.wf-section {
  overflow: hidden;
}

.wf-section-header {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 44px;
  padding: 12px 16px;
  background: transparent;
  border: none;
  cursor: pointer;
  font-family: inherit;
  font-size: 15px;
  font-weight: 600;
  line-height: 22px;
  color: var(--ac-text);
  text-align: left;
  transition: background-color var(--ac-motion-fast) ease;
}

.wf-section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.wf-caret {
  flex-shrink: 0;
  color: var(--ac-icon);
  transition: transform var(--ac-motion-fast) ease;
}

.wf-caret-open {
  transform: rotate(90deg);
}

.wf-section-body {
  padding: 0 16px 16px;
}

.wf-section-empty {
  padding: 4px 0 8px;
}

.wf-runs {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.wf-run {
  padding: 8px 12px;
  border-radius: var(--ac-radius);
  background-color: var(--ac-surface-row);
  cursor: pointer;
  transition: background-color var(--ac-motion-fast) ease;
}

.wf-run-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.wf-run-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--ac-radius-pill);
  flex-shrink: 0;
}

.wf-run-name {
  flex: 1;
}

.wf-run-status,
.wf-run-time {
  flex-shrink: 0;
}

.wf-run-detail {
  margin-top: 8px;
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.wf-run-elapsed {
  margin-left: 8px;
}

.wf-run-entry {
  word-break: break-word;
}

.wf-run-took {
  margin-left: 8px;
}

/* 실패 화면 썸네일 */
.wf-run-shot {
  margin-top: 6px;
  max-width: 100%;
  max-height: 160px;
  border-radius: var(--ac-radius);
}

/* Section expand transition */
.section-expand-enter-active,
.section-expand-leave-active {
  transition: all var(--ac-motion-normal) ease;
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

@media (hover: hover) and (pointer: fine) {
  .wf-section-header:hover {
    background-color: var(--ac-surface-hover);
  }

  .wf-run:hover {
    background-color: var(--ac-surface-hover);
  }
}
</style>
