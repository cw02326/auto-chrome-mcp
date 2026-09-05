<template>
  <div class="sp-app agent-theme" :data-agent-theme="currentTheme">
    <!-- Sidepanel Navigator: sticky 탭 바. 아래 화면은 탭 바를 뺀 나머지 높이를 채우고, 그
         안에서 각 화면이 자기 스크롤 영역을 갖는다. -->
    <SidepanelNavigator :activeTab="activeTab" @change="handleTabChange" />

    <!-- Workflows Tab -->
    <div
      v-show="activeTab === 'workflows'"
      id="sp-panel-workflows"
      role="tabpanel"
      aria-labelledby="sp-tab-workflows"
      tabindex="0"
      class="flex-1 min-h-0 flex flex-col"
    >
      <!-- 녹화 표시줄: 시작·중지 버튼과 녹화 중 표시가 여기 있다 -->
      <RecordingBar
        :recording="recorder.isRecording.value"
        :status="recorder.status.value"
        :step-count="recorder.stepCount.value"
        :elapsed-ms="recorder.elapsedMs.value"
        :busy="recorder.busy.value"
        @start="startRecording"
        @stop="stopRecording"
      />
      <WorkflowsView
        class="flex-1 min-h-0"
        :flows="filtered"
        :runs="runs"
        :only-bound="onlyBound"
        :open-run-id="openRunId"
        :search="search"
        :total-count="flows.length"
        :statuses="flowStatuses"
        :schedules="schedulesByFlowId"
        :last-success-at="lastSuccessByFlowId"
        :filter="flowFilter"
        :sites="filterSites"
        @refresh="handleWorkflowRefresh"
        @create="createFlow"
        @run="run"
        @edit="edit"
        @delete="remove"
        @export="exportFlow"
        @publish="publish"
        @unpublish="unpublish"
        @schedule="openScheduleForm"
        @import="importOpen = true"
        @update:only-bound="onlyBound = $event"
        @update:search="search = $event"
        @update:filter="flowFilter = $event"
        @toggle-run="toggleRun"
      />
    </div>

    <!-- 매일 작업 탭: 예약 목록과 그 실행 이력 -->
    <div
      v-show="activeTab === 'daily'"
      id="sp-panel-daily"
      role="tabpanel"
      aria-labelledby="sp-tab-daily"
      tabindex="0"
      class="flex-1 min-h-0 flex flex-col"
    >
      <DailyView
        class="flex-1 min-h-0"
        :schedules="dailySchedules.schedules.value"
        :error="dailySchedules.error.value"
        :reload-key="historyReloadKey"
        @refresh="refreshDaily"
        @edit="editSchedule"
        @remove="removeSchedule"
        @toggle="toggleSchedule"
        @run-now="runScheduleNow"
        @go-flows="handleTabChange('workflows')"
        @toast="showToast($event.text, $event.kind)"
      />
    </div>

    <!-- 예약 폼: 흐름 카드의 예약 버튼과 매일 작업 탭의 수정이 같은 화면을 연다 -->
    <DailyScheduleForm
      v-if="scheduleForm"
      :target="scheduleForm.target"
      :label="scheduleForm.label"
      :existing="scheduleForm.existing"
      :variables="scheduleForm.variables"
      :block-reason="scheduleForm.blockReason"
      @cancel="scheduleForm = null"
      @save="saveSchedule"
      @open-wizard="openWizardFromScheduleForm"
    />

    <!-- 가져오기 -->
    <ImportFlowDialog
      v-if="importOpen"
      @close="importOpen = false"
      @imported="handleImported"
      @toast="showToast($event.text, $event.kind)"
    />

    <!-- 저장 화면(마법사): 녹화 중지 직후와 카드의 편집 버튼이 같은 화면을 연다 -->
    <SaveFlowWizard
      v-if="wizardFlowId"
      :flow-id="wizardFlowId"
      @close="wizardFlowId = null"
      @saved="handleWizardSaved"
      @toast="showToast($event.text, $event.kind)"
    />

    <!-- 카드에서 실행할 때 필요한 값 입력 -->
    <RunVariablesDialog
      v-if="runAskVariables"
      :variables="runAskVariables"
      @cancel="cancelRunVariables"
      @submit="submitRunVariables"
    />

    <!-- 토스트: 실행·발행 실패를 콘솔에만 남기지 않는다 -->
    <div v-if="toast" class="sp-toast" :class="toast.kind === 'error' ? 'sp-toast--error' : ''">
      {{ toast.text }}
    </div>

    <!-- Element Markers Tab -->
    <div
      v-show="activeTab === 'element-markers'"
      id="sp-panel-element-markers"
      role="tabpanel"
      aria-labelledby="sp-tab-element-markers"
      tabindex="0"
      class="element-markers-content ac-scroll"
    >
      <div>
        <!-- Toolbar: Search + Add Button -->
        <div class="em-toolbar">
          <div class="em-search-wrapper">
            <svg class="em-search-icon" viewBox="0 0 20 20" width="16" height="16">
              <path
                fill="currentColor"
                d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z"
              />
            </svg>
            <input
              v-model="markerSearch"
              class="em-search-input"
              :placeholder="getMessage('sidepanel_marker_search_placeholder')"
              type="text"
            />
            <button
              v-if="markerSearch"
              class="em-search-clear"
              type="button"
              @click="markerSearch = ''"
            >
              <svg viewBox="0 0 20 20" width="14" height="14">
                <path
                  fill="currentColor"
                  d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"
                />
              </svg>
            </button>
          </div>
          <button
            class="em-add-btn"
            @click="openMarkerEditor()"
            :title="getMessage('sidepanel_marker_add')"
          >
            <svg viewBox="0 0 20 20" width="18" height="18">
              <path
                fill="currentColor"
                d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z"
              />
            </svg>
          </button>
        </div>

        <!-- Modal: Add/Edit Marker -->
        <div
          v-if="markerEditorOpen"
          class="ac-dim em-modal-overlay"
          @click.self="closeMarkerEditor"
        >
          <div
            ref="markerModalRef"
            class="em-modal"
            role="dialog"
            aria-modal="true"
            :aria-labelledby="markerModalTitleId"
            tabindex="-1"
          >
            <div class="em-modal-header">
              <h3 :id="markerModalTitleId" class="em-modal-title">
                {{
                  editingMarkerId
                    ? getMessage('sidepanel_marker_edit')
                    : getMessage('sidepanel_marker_add')
                }}
              </h3>
              <button class="em-modal-close" @click="closeMarkerEditor">
                <svg viewBox="0 0 20 20" width="18" height="18">
                  <path
                    fill="currentColor"
                    d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"
                  />
                </svg>
              </button>
            </div>
            <form @submit.prevent="saveMarker" class="em-form">
              <div class="em-form-row">
                <div class="em-field">
                  <label class="em-field-label">{{ getMessage('nameLabel') }}</label>
                  <input
                    v-model="markerForm.name"
                    class="ac-field"
                    :placeholder="getMessage('sidepanel_marker_name_placeholder')"
                    required
                  />
                </div>
              </div>

              <div class="em-form-row em-form-row-multi">
                <div class="em-field">
                  <label class="em-field-label">{{
                    getMessage('sidepanel_marker_selector_type_label')
                  }}</label>
                  <div class="em-select-wrapper">
                    <select v-model="markerForm.selectorType" class="ac-field">
                      <option value="css">{{ getMessage('sidepanel_selector_type_css') }}</option>
                      <option value="xpath">XPath</option>
                    </select>
                  </div>
                </div>
                <div class="em-field">
                  <label class="em-field-label">{{
                    getMessage('sidepanel_marker_match_type_label')
                  }}</label>
                  <div class="em-select-wrapper">
                    <select v-model="markerForm.matchType" class="ac-field">
                      <option value="prefix">{{
                        getMessage('sidepanel_match_type_prefix')
                      }}</option>
                      <option value="exact">{{ getMessage('sidepanel_match_type_exact') }}</option>
                      <option value="host">{{ getMessage('domainLabel') }}</option>
                    </select>
                  </div>
                </div>
              </div>

              <div class="em-form-row">
                <div class="em-field">
                  <label class="em-field-label">{{
                    getMessage('sidepanel_marker_selector_label')
                  }}</label>
                  <textarea
                    v-model="markerForm.selector"
                    class="ac-field ac-field--mono"
                    :placeholder="getMessage('sidepanel_marker_selector_placeholder')"
                    rows="3"
                    required
                  ></textarea>
                </div>
              </div>

              <div class="em-modal-actions">
                <button
                  type="button"
                  class="ac-button ac-button--ghost ac-button--sm"
                  @click="closeMarkerEditor"
                >
                  {{ getMessage('cancelButton') }}
                </button>
                <button type="submit" class="ac-button ac-button--primary">
                  {{
                    editingMarkerId
                      ? getMessage('sidepanel_update_button')
                      : getMessage('saveButton')
                  }}
                </button>
              </div>
            </form>
          </div>
        </div>

        <!-- Markers List -->
        <div v-if="filteredMarkers.length > 0" class="em-list">
          <!-- Statistics (compact) -->
          <div class="em-stats-bar">
            <span class="em-stats-text">
              <template v-if="markerSearch">{{
                getMessage('sidepanel_marker_stats_filtered', [
                  String(filteredMarkers.length),
                  String(markers.length),
                  String(groupedMarkers.length),
                ])
              }}</template>
              <template v-else>{{
                getMessage('sidepanel_marker_stats_all', [
                  String(markers.length),
                  String(groupedMarkers.length),
                ])
              }}</template>
            </span>
          </div>

          <!-- Grouped Markers by Domain -->
          <div
            v-for="domainGroup in groupedMarkers"
            :key="domainGroup.domain"
            class="em-domain-group"
          >
            <!-- Domain Header -->
            <button
              type="button"
              class="em-domain-header"
              :aria-expanded="expandedDomains.has(domainGroup.domain)"
              @click="toggleDomain(domainGroup.domain)"
            >
              <div class="em-domain-info">
                <svg
                  class="em-domain-icon"
                  :class="{ 'em-domain-icon-expanded': expandedDomains.has(domainGroup.domain) }"
                  viewBox="0 0 20 20"
                  width="16"
                  height="16"
                >
                  <path fill="currentColor" d="M6 8l4 4 4-4" />
                </svg>
                <h3 class="em-domain-name">{{ domainGroup.domain }}</h3>
                <span class="em-domain-count">{{
                  getMessage('sidepanel_marker_domain_count', [String(domainGroup.count)])
                }}</span>
              </div>
            </button>

            <!-- URLs and Markers -->
            <div v-if="expandedDomains.has(domainGroup.domain)" class="em-domain-content">
              <div class="em-content-wrapper">
                <div v-for="urlGroup in domainGroup.urls" :key="urlGroup.url" class="em-url-group">
                  <div class="em-url-header">
                    <svg class="em-url-icon" viewBox="0 0 16 16" width="12" height="12">
                      <path
                        fill="currentColor"
                        d="M4 4a1 1 0 011-1h6a1 1 0 011 1v8a1 1 0 01-1 1H5a1 1 0 01-1-1V4zm2 1v1h4V5H6zm0 3v1h4V8H6z"
                      />
                    </svg>
                    <span class="em-url-path">{{ urlGroup.url }}</span>
                  </div>

                  <div class="em-markers-list">
                    <div v-for="marker in urlGroup.markers" :key="marker.id" class="em-marker-item">
                      <div class="em-marker-row-top">
                        <span class="em-marker-name">{{ marker.name }}</span>
                        <div class="em-marker-actions">
                          <button
                            class="em-action-btn em-action-verify"
                            @click="validateMarker(marker)"
                            :title="getMessage('sidepanel_marker_verify')"
                          >
                            <svg viewBox="0 0 24 24" width="14" height="14">
                              <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                              />
                            </svg>
                          </button>
                          <button
                            class="em-action-btn em-action-edit"
                            @click="editMarker(marker)"
                            :title="getMessage('sidepanel_edit_button')"
                          >
                            <svg viewBox="0 0 24 24" width="14" height="14">
                              <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                              />
                            </svg>
                          </button>
                          <button
                            class="em-action-btn em-action-delete"
                            @click="deleteMarker(marker)"
                            :title="getMessage('deleteButton')"
                          >
                            <svg viewBox="0 0 24 24" width="14" height="14">
                              <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                              />
                            </svg>
                          </button>
                        </div>
                      </div>
                      <div class="em-marker-row-bottom">
                        <code class="em-marker-selector" :title="marker.selector">{{
                          marker.selector
                        }}</code>
                        <div class="em-marker-tags">
                          <span class="em-tag">{{ marker.selectorType || 'css' }}</span>
                          <span class="em-tag">{{ marker.matchType }}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- No search results -->
        <div v-else-if="markers.length > 0 && filteredMarkers.length === 0" class="em-empty">
          <p>{{ getMessage('sidepanel_marker_no_match') }}</p>
          <button class="ac-button ac-button--ghost em-empty-btn" @click="markerSearch = ''">
            {{ getMessage('sidepanel_clear_search_button') }}
          </button>
        </div>

        <!-- Empty state -->
        <div v-else class="em-empty">
          <p>{{ getMessage('sidepanel_marker_empty') }}</p>
          <button class="ac-button ac-button--primary em-empty-btn" @click="openMarkerEditor()">
            {{ getMessage('sidepanel_marker_add') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed, onMounted, ref, onUnmounted, watch } from 'vue';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import type { ElementMarker, UpsertMarkerRequest } from '@/common/element-marker-types';
import { getMessage } from '@/utils/i18n';
import SidepanelNavigator from './components/SidepanelNavigator.vue';
import {
  WorkflowsView,
  RecordingBar,
  SaveFlowWizard,
  RunVariablesDialog,
  ImportFlowDialog,
} from './components/workflows';
import { DailyView, DailyScheduleForm } from './components/daily';
import { useAgentTheme } from './composables/useAgentTheme';
import { useDialogA11y } from '@/ui/useDialogA11y';
import { useWorkflowsV3, type FlowLite } from './composables/useWorkflowsV3';
import { useDailySchedules } from './composables/useDailySchedules';
import { useRecorder } from './composables/useRecorder';
import { requiredRunVariables, type WizardVariableDef } from './utils/flow-wizard';
import {
  flowScheduleBlockReason,
  runNowMessageKey,
  schedulableVariables,
  type FlowScheduleBlockReason,
} from './utils/daily-form';
import * as daily from './utils/daily-messages';
import type { PutScheduleInput, ScheduleTarget, ScheduleView } from './utils/daily-messages';
import { mergeFlowOutcomes } from './utils/flow-outcomes';
import { parseScheduleId } from '@/utils/shortcut-schedule';
import {
  EMPTY_FLOW_FILTER,
  collectSites,
  filterFlows,
  type FlowFilterState,
} from './utils/flow-filters';
import { isRecordableUrl, parsePanelDeepLink, sidepanelPath } from './utils/panel-deeplink';

// Agent theme for consistent styling
const { theme: currentTheme, initTheme } = useAgentTheme();

// Tab state - default to workflows (v1.0.36: agent-chat removed)
// 2026-09-05 2단계: 매일 작업(daily) 탭이 늘었다.
type PanelTab = 'workflows' | 'daily' | 'element-markers';
const activeTab = ref<PanelTab>('workflows');

// Handle tab change and update URL for deep linking
function handleTabChange(tab: PanelTab) {
  activeTab.value = tab;
  // Update URL params for deep link
  const url = new URL(window.location.href);
  url.searchParams.set('tab', tab);
  history.replaceState(null, '', url.toString());
  // Note: loadMarkers is already called by the watch on activeTab, no need to call here
}

// Workflows state - using V3 data layer
const workflowsV3 = useWorkflowsV3();
const { flows, runs } = workflowsV3;
const onlyBound = ref(false);
const search = ref('');
const currentUrl = ref('');
const currentTitle = ref('');
const openRunId = ref<string | null>(null);

// 녹화 상태. 진실은 백그라운드에 있고 이 컴포저블이 주기적으로 읽어 온다.
const recorder = useRecorder();

// 저장 화면(마법사)에서 열고 있는 흐름
const wizardFlowId = ref<string | null>(null);

// 카드에서 실행할 때 값을 받아야 하는 변수와, 그 값을 기다리는 흐름 id
const runAskVariables = ref<WizardVariableDef[] | null>(null);
const runAskFlowId = ref<string | null>(null);

// 흐름별 마지막 실행 결과. 카드에 그대로 표시한다.
const flowStatuses = ref<Record<string, { kind: 'running' | 'ok' | 'error'; text: string }>>({});

// ==================== 매일 작업(예약) ====================

/**
 * 예약 목록. 진실은 백그라운드에 있고 이 컴포저블이 방송·폴링으로 따라간다.
 *
 * 탭 전환은 `v-show` 라 다른 탭을 봐도 문서는 계속 보인다. 그래서 "지금 매일 작업 탭인가"
 * 를 따로 넘겨 폴링만 멈춘다 (방송 구독은 유지한다).
 */
const dailyTabActive = computed(() => activeTab.value === 'daily');
const dailySchedules = useDailySchedules({ active: dailyTabActive });

/**
 * 예약 실행 이력(전역).
 *
 * 카드의 마지막 성공·최근 실패는 수동 실행만으로는 알 수 없다. 밤새 예약이 돌았으면 그
 * 결과도 함께 봐야 한다. 예약을 지워도 이력은 남으므로 목록이 아니라 이력을 읽는다.
 */
const scheduledRuns = ref<daily.DailyRunRecord[]>([]);

/** 카드 배지가 볼 만큼만 읽는다. 상세는 매일 작업 탭이 예약별로 다시 조회한다. */
const SCHEDULED_HISTORY_PEEK = 100;

async function refreshScheduledRuns(): Promise<void> {
  try {
    const page = await daily.queryHistory({ limit: SCHEDULED_HISTORY_PEEK });
    scheduledRuns.value = page.runs;
  } catch {
    // 백그라운드가 아직 없거나 실패해도 카드는 수동 이력만으로 그려진다.
  }
}

/** 예약 이력의 저장소 키(scheduleId)를 흐름 id 로 되돌린다. 단축 예약이면 null 이다. */
function flowIdOfScheduleId(scheduleId: string): string | null {
  const target = parseScheduleId(scheduleId);
  return target && target.kind === 'flow' ? target.flowId : null;
}

/** 예약 폼에 지금 무엇을 띄우고 있는가. */
const scheduleForm = ref<{
  target: ScheduleTarget;
  label: string;
  existing: ScheduleView | null;
  variables: WizardVariableDef[];
  blockReason: FlowScheduleBlockReason | null;
  /** 시작 주소가 없어 저장 화면으로 보내야 할 때 쓸 흐름 id. */
  flowId?: string;
} | null>(null);

/** 가져오기 대화상자. */
const importOpen = ref(false);

/**
 * 값이 바뀌면 펼쳐 둔 실행 이력을 다시 읽는다.
 *
 * 화면에서 올린 값과 백그라운드 방송 번호(`changeSeq`)를 더한다. 방송은 예약 목록만
 * 갱신하므로, 이것을 함께 보지 않으면 펼쳐 둔 이력이 옛 내용 그대로 남는다.
 */
const localReloadKey = ref(0);
const historyReloadKey = computed(() => localReloadKey.value + dailySchedules.changeSeq.value);

/** 흐름 카드 필터 바 상태. */
const flowFilter = ref<FlowFilterState>({ ...EMPTY_FLOW_FILTER });

const schedulesByFlowId = computed(() => {
  const map: Record<string, ScheduleView> = {};
  for (const schedule of dailySchedules.schedules.value) {
    if (schedule.target?.kind === 'flow' && schedule.target.flowId) {
      map[schedule.target.flowId] = schedule;
    }
  }
  return map;
});

/**
 * 흐름별 마지막 결과. 수동 실행 이력과 예약 실행 이력을 시각순으로 합친다.
 *
 * 합치는 규칙은 `utils/flow-outcomes.ts` 의 순수 함수가 들고 있다.
 */
const flowOutcomes = computed(() =>
  mergeFlowOutcomes(runs.value, scheduledRuns.value, flowIdOfScheduleId),
);

/** 흐름별 마지막 성공 시각. */
const lastSuccessByFlowId = computed(() => flowOutcomes.value.lastSuccessAt);

/** 마지막 실행이 실패로 끝난 흐름. "최근 실패" 필터가 본다. */
const failedFlowIds = computed(() => flowOutcomes.value.failedFlowIds);

const filterSites = computed(() => collectSites(flows.value));

// 토스트 한 개
const toast = ref<{ text: string; kind: 'ok' | 'error' } | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(text: string, kind: 'ok' | 'error' = 'ok') {
  toast.value = { text, kind };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.value = null;
  }, 4000);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Element markers state
const currentPageUrl = ref('');
const markers = ref<ElementMarker[]>([]);
const editingMarkerId = ref<string | null>(null);
const markerForm = ref<UpsertMarkerRequest>({
  url: '',
  name: '',
  selector: '',
  selectorType: 'css',
  matchType: 'prefix',
});
const expandedDomains = ref<Set<string>>(new Set());
const markerSearch = ref('');
const markerEditorOpen = ref(false);

// Filter markers based on search term
const filteredMarkers = computed(() => {
  const query = markerSearch.value.trim().toLowerCase();
  if (!query) return markers.value;
  return markers.value.filter((m) => {
    const name = (m.name || '').toLowerCase();
    const selector = (m.selector || '').toLowerCase();
    const url = (m.url || '').toLowerCase();
    return name.includes(query) || selector.includes(query) || url.includes(query);
  });
});

// Group markers by domain and URL
const groupedMarkers = computed(() => {
  const groups = new Map<string, Map<string, ElementMarker[]>>();

  for (const marker of filteredMarkers.value) {
    // Use pre-normalized fields from storage instead of reparsing URLs
    const domain = marker.host || getMessage('sidepanel_marker_local_file');
    const fullUrl = marker.url || getMessage('sidepanel_marker_unknown_url');

    if (!groups.has(domain)) {
      groups.set(domain, new Map());
    }

    const domainGroup = groups.get(domain)!;
    if (!domainGroup.has(fullUrl)) {
      domainGroup.set(fullUrl, []);
    }

    domainGroup.get(fullUrl)!.push(marker);
  }

  // Convert to array and sort
  return Array.from(groups.entries())
    .map(([domain, urlMap]) => ({
      domain,
      count: Array.from(urlMap.values()).reduce((sum, arr) => sum + arr.length, 0),
      urls: Array.from(urlMap.entries())
        .map(([url, markers]) => ({ url, markers }))
        .sort((a, b) => a.url.localeCompare(b.url)),
    }))
    .sort((a, b) => a.domain.localeCompare(b.domain));
});

const totalMarkersCount = computed(() => filteredMarkers.value.length);

const filtered = computed(() => {
  const bound = onlyBound.value ? flows.value.filter(isBoundToCurrent) : flows.value;
  // 필터 바(사이트·발행됨·예약 있음·최근 실패)를 먼저 적용하고 검색어로 다시 좁힌다.
  const list = filterFlows(bound, flowFilter.value, {
    scheduledFlowIds: dailySchedules.scheduledFlowIds.value,
    failedFlowIds: failedFlowIds.value,
  });
  const q = search.value.trim().toLowerCase();
  if (!q) return list;
  return list.filter((f) => {
    const name = String(f.name || '').toLowerCase();
    const domain = String(f?.meta?.domain || '').toLowerCase();
    const tags = ((f?.meta?.tags || []) as any[]).join(',').toLowerCase();
    return name.includes(q) || domain.includes(q) || tags.includes(q);
  });
});

function isBoundToCurrent(f: FlowLite) {
  try {
    const bindings = f?.meta?.bindings || [];
    if (!bindings.length) return false;
    if (!currentUrl.value) return true;
    const u = new URL(currentUrl.value);
    return bindings.some((b: any) => {
      // Support both V3 'kind' and V2 'type' field names
      const bindingType = b.kind || b.type;
      if (bindingType === 'domain') return u.hostname.includes(b.value);
      if (bindingType === 'path') return u.pathname.startsWith(b.value);
      if (bindingType === 'url') return (u.href || '').startsWith(b.value);
      return false;
    });
  } catch {
    return false;
  }
}

// V3 Workflows methods - delegating to composable
async function handleWorkflowRefresh() {
  // 카드 배지가 예약 실행 결과까지 보여 주려면 두 이력을 함께 다시 읽어야 한다.
  await Promise.all([workflowsV3.refresh(), refreshScheduledRuns()]);
}

/**
 * 저장 화면이 저장·발행을 마쳤다.
 *
 * 검색어를 먼저 비운다 (2026-09-05 시연 지적 4항). 시연에서 발행 직후 목록이 "흐름 0개" 로
 * 보였는데, 목록이 비어서가 아니라 검색어가 걸려 있어 새 카드가 걸러진 것이었다. 방금 만든
 * 흐름은 무조건 보여야 한다.
 */
async function handleWizardSaved() {
  search.value = '';
  await handleWorkflowRefresh();
}

async function exportFlow(id: string) {
  try {
    const flowData = await workflowsV3.exportFlow(id);
    if (flowData) {
      const blob = new Blob([JSON.stringify(flowData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `workflow-${id}.json`;
      a.click();
      URL.revokeObjectURL(url);
    }
  } catch (e) {
    showToast(getMessage('sidepanel_flow_export_failed', [errorText(e)]), 'error');
  }
}

function toggleRun(id: string) {
  openRunId.value = openRunId.value === id ? null : id;
}

/**
 * 카드의 실행 버튼.
 *
 * 필요한 값(민감 변수, 기본값이 빈 변수)이 있으면 작은 폼을 먼저 띄운다. 값은 그 폼에서만
 * 살고 흐름에 저장되지 않는다.
 */
async function run(id: string) {
  try {
    const flow = await workflowsV3.getFlowById(id);
    const needed = flow ? requiredRunVariables(flow) : [];
    if (needed.length > 0) {
      runAskFlowId.value = id;
      runAskVariables.value = needed;
      return;
    }
    await executeFlow(id, {});
  } catch (e) {
    flowStatuses.value = {
      ...flowStatuses.value,
      [id]: { kind: 'error', text: getMessage('sidepanel_run_failed', [errorText(e)]) },
    };
    showToast(getMessage('sidepanel_run_failed', [errorText(e)]), 'error');
  }
}

function cancelRunVariables() {
  runAskVariables.value = null;
  runAskFlowId.value = null;
}

function submitRunVariables(values: Record<string, string>) {
  const id = runAskFlowId.value;
  runAskVariables.value = null;
  runAskFlowId.value = null;
  if (id) void executeFlow(id, values);
}

/** 실행 한 건. 성패를 카드 상태와 토스트로 남긴다 (조용한 실패 금지). */
async function executeFlow(id: string, args: Record<string, string>) {
  flowStatuses.value = {
    ...flowStatuses.value,
    [id]: { kind: 'running', text: getMessage('sidepanel_run_running') },
  };
  try {
    const result = await workflowsV3.runFlow(id, { args });
    const summary = result.summary || { total: 0, success: 0, failed: 0, tookMs: 0 };
    if (result.success) {
      const text = getMessage('sidepanel_run_succeeded', [
        String(summary.success),
        (summary.tookMs / 1000).toFixed(1),
      ]);
      flowStatuses.value = { ...flowStatuses.value, [id]: { kind: 'ok', text } };
      showToast(text, 'ok');
    } else {
      const failed = (result.logs || []).find((entry) => entry.status === 'failed');
      const detail = failed ? `${failed.stepId}: ${failed.message || ''}`.trim() : '';
      const text = getMessage('sidepanel_run_failed', [
        detail || String(summary.failed) + '/' + String(summary.total),
      ]);
      flowStatuses.value = { ...flowStatuses.value, [id]: { kind: 'error', text } };
      showToast(text, 'error');
    }
  } catch (e) {
    const text = getMessage('sidepanel_run_failed', [errorText(e)]);
    flowStatuses.value = { ...flowStatuses.value, [id]: { kind: 'error', text } };
    showToast(text, 'error');
  }
}

/** 카드의 편집 버튼. 저장 화면(마법사)을 그 흐름으로 연다. */
function edit(id: string) {
  wizardFlowId.value = id;
}

// ==================== 예약 ====================

/**
 * 흐름 카드의 예약 버튼.
 *
 * 폼을 열기 전에 예약할 수 있는 흐름인지 먼저 본다(발행됨·시작 주소·민감 변수). 저장을
 * 눌러 본 뒤 백그라운드가 거절하면 사용자는 이유를 모른 채 저장이 안 되는 것만 본다.
 */
async function openScheduleForm(flowId: string) {
  try {
    const lite = flows.value.find((f) => f.id === flowId) || null;
    const flow = await workflowsV3.getFlowById(flowId);
    const blockReason = flowScheduleBlockReason(flow, !!lite?.published);
    scheduleForm.value = {
      target: { kind: 'flow', flowId },
      label: flow?.name || lite?.name || flowId,
      existing: schedulesByFlowId.value[flowId] || null,
      variables: schedulableVariables(flow),
      blockReason,
      flowId,
    };
  } catch (e) {
    showToast(getMessage('sidepanel_daily_save_failed', [errorText(e)]), 'error');
  }
}

/** 매일 작업 목록에서 예약 수정. 흐름이면 그 흐름의 변수도 함께 읽는다. */
async function editSchedule(schedule: ScheduleView) {
  if (schedule.target?.kind === 'flow') {
    await openScheduleForm(schedule.target.flowId);
    if (scheduleForm.value) scheduleForm.value.existing = schedule;
    return;
  }
  scheduleForm.value = {
    target: schedule.target,
    label: schedule.label,
    existing: schedule,
    variables: [],
    blockReason: null,
  };
}

/** 시작 주소가 없어 예약할 수 없을 때, 저장 화면을 열어 바로 고치게 한다. */
function openWizardFromScheduleForm() {
  const flowId = scheduleForm.value?.flowId;
  scheduleForm.value = null;
  if (flowId) wizardFlowId.value = flowId;
}

async function saveSchedule(payload: PutScheduleInput) {
  try {
    await dailySchedules.save(payload);
    scheduleForm.value = null;
    localReloadKey.value += 1;
    showToast(getMessage('sidepanel_daily_saved'), 'ok');
  } catch (e) {
    showToast(getMessage('sidepanel_daily_save_failed', [errorText(e)]), 'error');
  }
}

async function removeSchedule(scheduleId: string) {
  const ok = confirm(getMessage('sidepanel_daily_remove_confirm'));
  if (!ok) return;
  try {
    await dailySchedules.remove(scheduleId);
    showToast(getMessage('sidepanel_daily_removed'), 'ok');
  } catch (e) {
    showToast(getMessage('sidepanel_daily_save_failed', [errorText(e)]), 'error');
  }
}

async function toggleSchedule(payload: { scheduleId: string; enabled: boolean }) {
  try {
    await dailySchedules.setEnabled(payload.scheduleId, payload.enabled);
  } catch (e) {
    showToast(getMessage('sidepanel_daily_toggle_failed', [errorText(e)]), 'error');
    await dailySchedules.refresh();
  }
}

/** 지금 실행. 예약 큐를 그대로 타므로 다른 실행과 겹치지 않는다. */
async function runScheduleNow(scheduleId: string) {
  try {
    const result = await dailySchedules.runNow(scheduleId);
    localReloadKey.value += 1;
    void refreshScheduledRuns();
    // 같은 예약이 이미 줄을 서 있으면 새로 넣지 않는다. 그때 "시작했다" 고 말하면 안 된다.
    showToast(getMessage(runNowMessageKey(result.queued)), 'ok');
  } catch (e) {
    showToast(getMessage('sidepanel_daily_run_failed', [errorText(e)]), 'error');
  }
}

async function refreshDaily() {
  await Promise.all([dailySchedules.refresh(), refreshScheduledRuns()]);
  localReloadKey.value += 1;
}

/** 가져오기가 끝났다. 검색어를 비워 새 카드가 곧바로 보이게 한다. */
async function handleImported() {
  importOpen.value = false;
  search.value = '';
  await handleWorkflowRefresh();
}

/** 흐름은 녹화로 만든다. 빈 목록의 버튼도 녹화를 시작한다. */
function createFlow() {
  void startRecording();
}

async function publish(id: string) {
  try {
    await workflowsV3.publishFlow(id);
    showToast(getMessage('sidepanel_wizard_published'), 'ok');
  } catch (e) {
    showToast(getMessage('sidepanel_publish_failed', [errorText(e)]), 'error');
  }
}

async function unpublish(id: string) {
  try {
    await workflowsV3.unpublishFlow(id);
    showToast(getMessage('sidepanel_unpublished'), 'ok');
  } catch (e) {
    showToast(getMessage('sidepanel_unpublish_failed', [errorText(e)]), 'error');
  }
}

async function remove(id: string) {
  const ok = confirm(getMessage('sidepanel_flow_delete_confirm'));
  if (!ok) return;
  try {
    await workflowsV3.deleteFlow(id);
  } catch (e) {
    showToast(getMessage('sidepanel_flow_delete_failed', [errorText(e)]), 'error');
  }
}

// ==================== 녹화 ====================

/**
 * 녹화 시작.
 *
 * `tabId` 는 팝업에서 넘어온 "그때 보고 있던 탭" 이다. 없으면 백그라운드가 활성 탭을 잡는다.
 * 어느 쪽이든 시작 전에 그 탭의 주소를 확인한다 - chrome:// 나 확장 페이지에는 녹화기를
 * 넣을 수 없어 시작해 봐야 단계가 하나도 잡히지 않는다.
 */
async function startRecording(tabId?: number) {
  try {
    const target = await resolveRecordingTab(tabId);
    if (!target) {
      showToast(getMessage('sidepanel_record_no_tab'), 'error');
      return;
    }
    if (!isRecordableUrl(target.url)) {
      showToast(getMessage('sidepanel_record_restricted_url'), 'error');
      return;
    }
    await recorder.start(target.id);
    currentUrl.value = target.url ?? currentUrl.value;
    currentTitle.value = target.title ?? currentTitle.value;
  } catch (e) {
    showToast(getMessage('sidepanel_record_start_failed', [errorText(e)]), 'error');
  }
}

/**
 * 녹화할 탭을 정한다.
 *
 * **id 가 주어졌으면 그 탭만 쓴다.** 예전에는 그 탭이 이미 닫혔을 때 활성 탭으로 되돌아갔는데,
 * 실제 시연에서 그 폴백이 사용자가 보고 있던 전혀 다른 탭을 녹화해 버렸다(2026-09-05 시연
 * 지적 1항). 지목된 탭이 없으면 아무것도 녹화하지 않고 그대로 거절한다.
 *
 * id 가 없을 때(패널의 녹화 시작 버튼)만 활성 탭을 찾는다. 사용자가 그 순간 보고 있는
 * 화면을 녹화하겠다는 뜻이라 이 경로에서는 활성 탭이 정답이다.
 */
async function resolveRecordingTab(
  tabId?: number,
): Promise<{ id: number; url?: string; title?: string } | null> {
  if (typeof tabId === 'number') {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (typeof tab?.id === 'number') return { id: tab.id, url: tab.url, title: tab.title };
    } catch {
      // 지목된 탭이 사라졌다. 다른 탭으로 대신하지 않는다.
    }
    return null;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (typeof tab?.id === 'number') return { id: tab.id, url: tab.url, title: tab.title };
  } catch {
    // 아래에서 null 을 돌려준다.
  }
  return null;
}

/**
 * 녹화 중지.
 *
 * 흐름은 백그라운드가 이미 저장했다(`recording/recorder-manager.ts`). 여기서는 그 id 를
 * 받아 저장 화면을 열기만 한다. 새로 저장하지 않으니 저장 실패 경로가 하나 줄어든다.
 */
async function stopRecording() {
  try {
    const result = await recorder.stop();
    await handleWorkflowRefresh();
    if (result.warning) showToast(result.warning, 'error');
    if (result.flowId) {
      wizardFlowId.value = result.flowId;
    } else {
      showToast(getMessage('sidepanel_record_nothing_captured'), 'error');
    }
  } catch (e) {
    showToast(getMessage('sidepanel_record_stop_failed', [errorText(e)]), 'error');
  }
}

// Element markers functions
function openMarkerEditor(marker?: ElementMarker) {
  if (marker) {
    editingMarkerId.value = marker.id;
    markerForm.value = {
      url: marker.url,
      name: marker.name,
      selector: marker.selector,
      selectorType: marker.selectorType || 'css',
      listMode: marker.listMode,
      matchType: marker.matchType || 'prefix',
      action: marker.action,
    };
  } else {
    resetForm();
  }
  markerEditorOpen.value = true;
}

function closeMarkerEditor() {
  markerEditorOpen.value = false;
  resetForm();
}

/** 요소 마킹 추가·수정 모달 접근성(포커스 이동·트랩·Escape). */
const markerModalRef = ref<HTMLElement | null>(null);
const markerModalTitleId = 'em-modal-title';
useDialogA11y(markerModalRef, markerModalTitleId, closeMarkerEditor);

function resetForm() {
  markerForm.value = {
    url: currentPageUrl.value,
    name: '',
    selector: '',
    selectorType: 'css',
    matchType: 'prefix',
  };
  editingMarkerId.value = null;
}

async function loadMarkers() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    currentPageUrl.value = String(tab?.url || '');

    // Only update form URL when not editing - prevents polluting edited marker's URL
    if (!editingMarkerId.value) {
      markerForm.value.url = currentPageUrl.value;
    }

    // Load all markers from all pages
    const res: any = await chrome.runtime.sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_LIST_ALL,
    });

    if (res?.success) {
      markers.value = res.markers || [];
    }
  } catch (e) {
    console.error('Failed to load markers:', e);
  }
}

async function saveMarker() {
  try {
    if (!markerForm.value.selector) return;

    const isEditing = !!editingMarkerId.value;

    // Only set URL for new markers, not when editing existing ones
    if (!isEditing) {
      markerForm.value.url = currentPageUrl.value;
    }

    let res: any;

    if (isEditing) {
      // Use UPDATE for editing to preserve createdAt
      const existingMarker = markers.value.find((m) => m.id === editingMarkerId.value);
      if (existingMarker) {
        const updatedMarker: ElementMarker = {
          ...existingMarker,
          ...markerForm.value,
          id: editingMarkerId.value!,
        };
        res = await chrome.runtime.sendMessage({
          type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_UPDATE,
          marker: updatedMarker,
        });
      } else {
        // Fallback to SAVE if existing marker not found in local state
        console.warn('Editing marker not found in local state, falling back to SAVE');
        res = await chrome.runtime.sendMessage({
          type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_SAVE,
          marker: { ...markerForm.value, id: editingMarkerId.value },
        });
      }
    } else {
      // Use SAVE for new markers
      res = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_SAVE,
        marker: { ...markerForm.value },
      });
    }

    if (res?.success) {
      closeMarkerEditor();
      await loadMarkers();
    }
  } catch (e) {
    console.error('Failed to save marker:', e);
  }
}

function editMarker(marker: ElementMarker) {
  openMarkerEditor(marker);
}

function cancelEdit() {
  closeMarkerEditor();
}

async function deleteMarker(marker: ElementMarker) {
  try {
    const confirmed = confirm(getMessage('sidepanel_marker_delete_confirm', [marker.name]));
    if (!confirmed) return;

    const res: any = await chrome.runtime.sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_DELETE,
      id: marker.id,
    });

    if (res?.success) {
      await loadMarkers();
    }
  } catch (e) {
    console.error('Failed to delete marker:', e);
  }
}

async function validateMarker(marker: ElementMarker) {
  try {
    const res: any = await chrome.runtime.sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_VALIDATE,
      selector: marker.selector,
      selectorType: marker.selectorType || 'css',
      action: 'hover',
      listMode: !!marker.listMode,
    } as any);

    // Trigger highlight in the page
    if (res?.tool?.ok !== false) {
      await highlightInTab(marker);
    }
  } catch (e) {
    console.error('Failed to validate marker:', e);
  }
}

/**
 * Check if element-marker.js is already injected in the tab
 * Uses a short timeout to avoid hanging on unresponsive tabs
 */
async function isMarkerInjected(tabId: number): Promise<boolean> {
  try {
    const response = await Promise.race([
      chrome.tabs.sendMessage(tabId, { action: 'element_marker_ping' }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 300)),
    ]);
    return response?.status === 'pong';
  } catch {
    return false;
  }
}

async function highlightInTab(marker: ElementMarker) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    if (!tabId) return;

    // Check if already injected via ping to avoid duplicate injection
    const alreadyInjected = await isMarkerInjected(tabId);

    if (!alreadyInjected) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          files: ['inject-scripts/element-marker.js'],
          world: 'ISOLATED',
        });
      } catch {
        // Script injection may fail on some pages
      }
    }

    // Send highlight message to content script
    await chrome.tabs.sendMessage(tabId, {
      action: 'element_marker_highlight',
      selector: marker.selector,
      selectorType: marker.selectorType || 'css',
      listMode: !!marker.listMode,
    });
  } catch (e) {
    // Ignore errors (tab might not support content scripts)
    console.error('Failed to highlight in tab:', e);
  }
}

function toggleDomain(domain: string) {
  if (expandedDomains.value.has(domain)) {
    expandedDomains.value.delete(domain);
  } else {
    expandedDomains.value.add(domain);
  }
  // Trigger reactivity
  expandedDomains.value = new Set(expandedDomains.value);
}

// Watch tab changes to load data
watch(activeTab, async (newTab, oldTab) => {
  // Only load if tab actually changed (avoid double-loading on mount)
  if (newTab === 'element-markers' && oldTab !== undefined) {
    await loadMarkers();
  }
});

// Auto-expand domains when search matches
watch(markerSearch, (query) => {
  if (!query.trim()) return;
  // Expand all domains that have matching markers
  const domainsToExpand = new Set<string>();
  for (const group of groupedMarkers.value) {
    domainsToExpand.add(group.domain);
  }
  expandedDomains.value = domainsToExpand;
});

// 예약·이력이 바뀌었다는 방송이 오면 카드 배지 재료도 다시 읽는다.
watch(
  () => dailySchedules.changeSeq.value,
  () => {
    void refreshScheduledRuns();
  },
);

onMounted(async () => {
  // Initialize theme
  await initTheme();

  // 카드의 마지막 성공·최근 실패는 예약 이력도 함께 본다.
  void refreshScheduledRuns();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentUrl.value = String(tab?.url || '');
    currentTitle.value = String(tab?.title || '');
  } catch {}

  // 주소의 지시를 읽는다. 팝업이 넘긴 ?record 와 ?tabId 는 한 번짜리다.
  const deepLink = parsePanelDeepLink(window.location.search);
  if (deepLink.tab === 'element-markers') {
    activeTab.value = 'element-markers';
    await loadMarkers();
  } else if (deepLink.tab === 'daily') {
    // 예약 실패 알림을 눌렀을 때와 팝업의 "매일 작업" 버튼이 이 길로 들어온다.
    activeTab.value = 'daily';
  } else if (deepLink.tab === 'workflows') {
    activeTab.value = 'workflows';
  }
  // v1.0.36: agent-chat 진입 차단, workflows 로 fallback

  // 흐름 목록·실행 이력은 useWorkflowsV3 가 마운트될 때 한 번 읽는다.

  // 지시를 **읽는 즉시** 소비한다. 두 곳을 모두 지워야 한 번만 실행된다.
  //   1) 이 문서의 주소 - 새로고침으로 다시 실행되는 것을 막는다.
  //   2) 패널의 영구 path - setOptions 로 저장된 주소라, 지우지 않으면 패널을 다시 열
  //      때마다 녹화가 또 시작된다.
  if (deepLink.record) {
    try {
      history.replaceState(null, '', `${window.location.pathname}${deepLink.cleanedSearch}`);
    } catch {
      // 주소를 못 고쳐도 아래 setOptions 가 다음 열기를 막는다.
    }
    try {
      const sidePanel = (
        chrome as unknown as { sidePanel?: { setOptions?: (o: unknown) => Promise<void> } }
      ).sidePanel;
      if (sidePanel?.setOptions) {
        await sidePanel.setOptions({ path: sidepanelPath(deepLink.tab), enabled: true });
      }
    } catch {
      // 패널 옵션을 못 되돌려도 위 replaceState 가 이 세션을 지킨다.
    }
  }

  if (deepLink.record === 'start') {
    await startRecording(deepLink.recordTabId);
  } else if (deepLink.record === 'stop') {
    await stopRecording();
  }
});

onUnmounted(() => {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
});
</script>

<style scoped>
/* 전체 패널: 위에 sticky 탭 바, 아래는 그 탭 바를 뺀 나머지 높이를 채우는 세로 flex. */
.sp-app {
  position: relative;
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  background-color: var(--ac-bg);
}

/* 토스트: 실행·발행 결과를 사용자에게 보여 준다. 하단 중앙, 어두운 바탕에 흰 글자. */
.sp-toast {
  position: fixed;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  max-width: calc(100% - 32px);
  padding: 12px 16px;
  border-radius: var(--ac-radius);
  background-color: var(--ac-toast-bg);
  color: var(--ac-text-inverse);
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
  z-index: 70;
  box-shadow: var(--ac-shadow-float);
  word-break: break-word;
  text-align: center;
}

.sp-toast--error {
  background-color: var(--ac-danger);
}

/* Element Markers Styles - Using agent-theme tokens */
.element-markers-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 16px 24px;
  color: var(--ac-text);
}

.em-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.em-form-row {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.em-form-row-multi {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.em-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.em-field-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--ac-text-caption);
}

.em-select-wrapper {
  position: relative;
}

.em-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.em-empty {
  text-align: center;
  padding: 48px 20px;
  color: var(--ac-text-caption);
  font-size: 14px;
}

/* Toolbar */
.em-toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  align-items: center;
}

.em-search-wrapper {
  flex: 1;
  position: relative;
  display: flex;
  align-items: center;
}

.em-search-icon {
  position: absolute;
  left: 12px;
  color: var(--ac-text-muted);
  pointer-events: none;
}

.em-search-input {
  width: 100%;
  height: 40px;
  padding: 0 36px;
  background: var(--ac-surface-muted);
  border: none;
  border-radius: var(--ac-radius-inner);
  font-size: 14px;
  color: var(--ac-text);
  outline: none;
  transition: background var(--ac-motion-fast) ease;
}

.em-search-input:focus {
  background: var(--ac-hover-bg);
}

.em-search-input::placeholder {
  color: var(--ac-text-muted);
}

.em-search-clear {
  position: absolute;
  right: 4px;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: 50%;
  color: var(--ac-text-muted);
  cursor: pointer;
  transition: all var(--ac-motion-fast) ease;
}

.em-search-clear:hover {
  background: var(--ac-hover-bg);
  color: var(--ac-text);
}

.em-add-btn {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--ac-accent);
  border: none;
  border-radius: var(--ac-radius-button);
  color: var(--ac-accent-contrast);
  cursor: pointer;
  transition: all var(--ac-motion-fast) ease;
  flex-shrink: 0;
}

.em-add-btn:hover {
  background: var(--ac-accent-hover);
}

/* Modal. 딤 배경·중앙 정렬은 ac-dim 이 준다. 여기서는 진입 애니메이션과 z-index 만. */
.em-modal-overlay {
  z-index: 1000;
  animation: fadeIn 150ms ease-out;
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.em-modal {
  width: calc(100% - 32px);
  max-width: 480px;
  max-height: calc(100vh - 64px);
  background: var(--ac-surface);
  border-radius: var(--ac-radius-card);
  box-shadow: var(--ac-shadow-float);
  overflow: hidden;
  animation: slideUp 200ms ease-out;
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.em-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  box-shadow: inset 0 -0.75px 0 0 var(--ac-divider);
}

.em-modal-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--ac-text);
  margin: 0;
}

.em-modal-close {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: var(--ac-radius-button);
  color: var(--ac-text-muted);
  cursor: pointer;
  transition: all var(--ac-motion-fast) ease;
}

.em-modal-close:hover {
  background: var(--ac-hover-bg);
  color: var(--ac-text);
}

.em-modal .em-form {
  padding: 20px;
}

.em-modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 16px;
}

.em-modal-actions .ac-button {
  flex: none;
  min-width: 80px;
}

/* Statistics Bar (compact) */
.em-stats-bar {
  padding: 10px 16px;
  background: var(--ac-surface-muted);
  border-radius: var(--ac-radius-inner);
}

.em-stats-text {
  font-size: 13px;
  color: var(--ac-text-muted);
}

.em-stats-text strong {
  color: var(--ac-text);
  font-weight: 600;
}

.em-domain-header {
  /* 카드는 테두리·그림자 없이 바탕색 위 흰 표면으로만 구분한다. */
  display: block;
  width: 100%;
  border: none;
  margin: 0;
  font: inherit;
  color: inherit;
  text-align: left;
  background: var(--ac-surface);
  border-radius: var(--ac-radius-card);
  padding: 12px 16px;
  cursor: pointer;
  transition: background-color var(--ac-motion-fast) ease;
  user-select: none;
}

.em-domain-header:focus-visible {
  outline: 2px solid var(--ac-focus-ring);
  outline-offset: 2px;
}

.em-domain-header:hover {
  background: var(--ac-surface-hover);
}

.em-domain-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.em-domain-icon {
  flex-shrink: 0;
  color: var(--ac-text-muted);
  transition: transform var(--ac-motion-fast) ease;
}

.em-domain-icon-expanded {
  transform: rotate(0deg);
}

.em-domain-icon:not(.em-domain-icon-expanded) {
  transform: rotate(-90deg);
}

.em-domain-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--ac-text);
  margin: 0;
  flex: 1;
}

.em-domain-count {
  font-size: 13px;
  color: var(--ac-text-muted);
  background: var(--ac-surface-muted);
  padding: 4px 12px;
  border-radius: var(--ac-radius-button);
  font-weight: 500;
}

/* Domain Content */
.em-domain-content {
  animation: slideDown 200ms ease-out;
}

@keyframes slideDown {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Content wrapper with subtle background for visual hierarchy */
.em-content-wrapper {
  margin-left: 8px;
  margin-top: 8px;
  padding: 4px 0 4px 12px;
  border-radius: var(--ac-radius-inner);
  background: var(--ac-surface-muted);
}

/* URL Group */
.em-url-group {
  margin-bottom: 12px;
}

.em-url-group:last-child {
  margin-bottom: 0;
}

.em-url-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 0;
}

.em-url-icon {
  color: var(--ac-text-muted);
  flex-shrink: 0;
}

.em-url-path {
  font-size: 12px;
  color: var(--ac-text-muted);
  font-family: var(--ac-font-mono);
  word-break: break-all;
  line-height: 1.4;
}

/* Markers List */
.em-markers-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* Marker Item - Two row layout */
.em-marker-item {
  padding: 8px 10px;
  border-radius: var(--ac-radius-inner);
  background: var(--ac-hover-bg);
  margin-bottom: 4px;
}

.em-marker-item:last-child {
  margin-bottom: 0;
}

.em-marker-item:hover {
  background: var(--ac-hover-bg);
}

/* Top row: name + actions */
.em-marker-row-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}

.em-marker-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--ac-text);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.em-marker-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.em-action-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--ac-radius-button);
  cursor: pointer;
  transition: all var(--ac-motion-fast) ease;
}

.em-action-btn svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
}

.em-action-btn.em-action-verify {
  background: var(--ac-accent-subtle);
  color: var(--ac-accent);
}

.em-action-btn.em-action-verify:hover {
  background: var(--ac-accent-subtle);
}

.em-action-btn.em-action-edit {
  background: var(--ac-surface-muted);
  color: var(--ac-text-muted);
}

.em-action-btn.em-action-edit:hover {
  background: var(--ac-hover-bg);
  color: var(--ac-text);
}

.em-action-btn.em-action-delete {
  background: var(--ac-danger-subtle);
  color: var(--ac-danger);
}

.em-action-btn.em-action-delete:hover {
  background: var(--ac-danger-subtle);
}

/* Bottom row: selector + tags */
.em-marker-row-bottom {
  display: flex;
  align-items: center;
  gap: 8px;
}

.em-marker-selector {
  font-size: 12px;
  line-height: 16px;
  font-family: var(--ac-font-mono);
  color: var(--ac-text-secondary);
  background: var(--ac-surface-muted);
  padding: 2px 6px;
  border-radius: 4px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: help;
}

.em-marker-tags {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.em-tag {
  font-size: 12px;
  line-height: 16px;
  padding: 2px 8px;
  background: var(--ac-surface-muted);
  color: var(--ac-text-secondary);
  border-radius: var(--ac-radius-pill);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

/* Empty state button */
.em-empty-btn {
  margin-top: 16px;
  width: auto;
  padding: 0 24px;
}
</style>
