<template>
  <div class="wz-overlay" @click.self="$emit('close')">
    <div class="wz-panel" :style="panelStyle">
      <!-- 머리말 -->
      <div class="wz-header" :style="headerStyle">
        <span class="wz-title" :style="titleStyle">{{ getMessage('sidepanel_wizard_title') }}</span>
        <button class="wz-close" :style="mutedStyle" @click="$emit('close')">
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div v-if="loading" class="wz-body wz-center" :style="mutedStyle">
        {{ getMessage('sidepanel_wizard_loading') }}
      </div>

      <div v-else-if="loadError" class="wz-body wz-center" :style="dangerStyle">
        {{ loadError }}
      </div>

      <div v-else class="wz-body">
        <!-- 이름 -->
        <label class="wz-field">
          <span class="wz-label" :style="mutedStyle">{{
            getMessage('sidepanel_wizard_name_label')
          }}</span>
          <input v-model="name" class="wz-input" :style="inputStyle" type="text" />
        </label>

        <!-- 시작 URL -->
        <label class="wz-field">
          <span class="wz-label" :style="mutedStyle">{{
            getMessage('sidepanel_wizard_start_url_label')
          }}</span>
          <input v-model="startUrl" class="wz-input" :style="inputStyle" type="text" />
          <span class="wz-help" :style="mutedStyle">{{
            getMessage('sidepanel_wizard_start_url_hint')
          }}</span>
        </label>

        <!-- 감지된 변수 -->
        <div class="wz-section">
          <div class="wz-section-title" :style="titleStyle">
            {{ getMessage('sidepanel_wizard_variables_title') }}
          </div>
          <div v-if="variables.length === 0" class="wz-empty" :style="mutedStyle">
            {{ getMessage('sidepanel_wizard_variables_empty') }}
          </div>
          <div v-else class="wz-var-list">
            <div v-for="(v, idx) in variables" :key="idx" class="wz-var" :style="rowStyle">
              <input
                type="checkbox"
                class="wz-check"
                :checked="v.selected"
                @change="v.selected = ($event.target as HTMLInputElement).checked"
              />
              <div class="wz-var-main">
                <input
                  v-model="v.key"
                  class="wz-input wz-input-sm"
                  :style="inputStyle"
                  type="text"
                />
                <span class="wz-var-src" :style="mutedStyle">{{ v.label || '' }}</span>
              </div>
              <label class="wz-sens" :style="mutedStyle">
                <input
                  type="checkbox"
                  class="wz-check"
                  :checked="v.sensitive"
                  @change="v.sensitive = ($event.target as HTMLInputElement).checked"
                />
                <span>{{ getMessage('sidepanel_wizard_variable_sensitive') }}</span>
              </label>
            </div>
          </div>
          <div v-if="hasSensitive" class="wz-help" :style="mutedStyle">
            {{ getMessage('sidepanel_wizard_variable_sensitive_hint') }}
          </div>
        </div>

        <!-- 단계 목록 -->
        <div class="wz-section">
          <div class="wz-section-title" :style="titleStyle">
            {{ getMessage('sidepanel_wizard_steps_title', [String(visibleNodes.length)]) }}
          </div>
          <div v-if="visibleNodes.length === 0" class="wz-empty" :style="mutedStyle">
            {{ getMessage('sidepanel_wizard_no_steps') }}
          </div>
          <ol v-else class="wz-steps">
            <li
              v-for="(node, idx) in visibleNodes"
              :key="node.id"
              class="wz-step"
              :style="rowStyle"
            >
              <span class="wz-step-no" :style="mutedStyle">{{ idx + 1 }}</span>
              <span class="wz-step-type" :style="titleStyle">{{ stepTypeLabel(node.type) }}</span>
              <span class="wz-step-desc" :style="mutedStyle">{{ describeNode(node) }}</span>
              <button
                class="wz-step-del"
                :style="dangerStyle"
                :title="getMessage('sidepanel_wizard_step_delete')"
                @click="removeStep(node.id)"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </li>
          </ol>
        </div>

        <!-- 시험 실행 -->
        <div class="wz-section">
          <button
            class="wz-btn wz-btn-plain"
            :style="plainStyle"
            :disabled="busy"
            @click="onTestRun"
          >
            {{
              testing
                ? getMessage('sidepanel_wizard_test_running')
                : getMessage('sidepanel_wizard_test_run')
            }}
          </button>
          <div v-if="testMessage" class="wz-test" :style="testOk ? okStyle : dangerStyle">
            {{ testMessage }}
          </div>
          <ul v-if="testFailures.length" class="wz-test-fails">
            <li v-for="(f, i) in testFailures" :key="i" class="wz-test-fail" :style="dangerStyle">
              {{ f }}
            </li>
          </ul>
        </div>

        <div v-if="formError" class="wz-test" :style="dangerStyle">{{ formError }}</div>
      </div>

      <!-- 바닥 버튼 -->
      <div v-if="!loading && !loadError" class="wz-footer" :style="headerStyle">
        <button
          class="wz-btn wz-btn-plain"
          :style="plainStyle"
          :disabled="busy"
          @click="$emit('close')"
        >
          {{ getMessage('sidepanel_wizard_close') }}
        </button>
        <button
          class="wz-btn wz-btn-plain"
          :style="plainStyle"
          :disabled="busy"
          @click="onSave(false)"
        >
          {{ getMessage('sidepanel_wizard_save_only') }}
        </button>
        <button
          class="wz-btn wz-btn-primary"
          :style="primaryStyle"
          :disabled="busy"
          @click="onSave(true)"
        >
          {{ getMessage('sidepanel_wizard_save_publish') }}
        </button>
      </div>
    </div>

    <RunVariablesDialog
      v-if="askVariables"
      :variables="askVariables"
      @cancel="askVariables = null"
      @submit="onVariablesSubmitted"
    />
  </div>
</template>

<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue';
import { getMessage } from '@/utils/i18n';
import RunVariablesDialog from './RunVariablesDialog.vue';
import * as rr from '../../utils/rr-messages';
import { runFlowInTemporaryTab } from '../../utils/test-run';
import { saveAndMaybePublish } from '../../utils/wizard-save';
import {
  applyWizardEdits,
  defaultFlowNameForFlow,
  describeNode,
  detectVariables,
  isPlaceholderFlowName,
  requiredRunVariables,
  validateVariables,
  type WizardFlow,
  type WizardNode,
  type WizardVariable,
  type WizardVariableDef,
} from '../../utils/flow-wizard';

const props = defineProps<{
  /** 편집할 흐름. 녹화 중지 직후에는 방금 저장된 흐름의 id 가 온다. */
  flowId: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'saved', flowId: string): void;
  (e: 'toast', payload: { text: string; kind: 'ok' | 'error' }): void;
}>();

const loading = ref(true);
const loadError = ref('');
const formError = ref('');
const saving = ref(false);
const testing = ref(false);

const source = ref<WizardFlow | null>(null);
const name = ref('');
const startUrl = ref('');
const variables = ref<WizardVariable[]>([]);
const removedNodeIds = ref<string[]>([]);

const testMessage = ref('');
const testOk = ref(false);
const testFailures = ref<string[]>([]);

/** 실행 전에 값을 받아야 할 때 띄우는 작은 폼. 값은 여기서만 살고 저장되지 않는다. */
const askVariables = ref<WizardVariableDef[] | null>(null);

const busy = computed(() => saving.value || testing.value);
const hasSensitive = computed(() => variables.value.some((v) => v.selected && v.sensitive));

const visibleNodes = computed<WizardNode[]>(() => {
  const nodes = source.value?.nodes || [];
  const removed = new Set(removedNodeIds.value);
  return nodes.filter((n) => !removed.has(n.id));
});

/** 녹화가 만드는 단계 유형의 한국어 이름. 목록에 없는 유형은 원래 이름을 그대로 보여 준다. */
const STEP_TYPE_KEYS: Record<string, string> = {
  navigate: 'sidepanel_step_type_navigate',
  click: 'sidepanel_step_type_click',
  dblclick: 'sidepanel_step_type_dblclick',
  fill: 'sidepanel_step_type_fill',
  key: 'sidepanel_step_type_key',
  scroll: 'sidepanel_step_type_scroll',
  wait: 'sidepanel_step_type_wait',
  assert: 'sidepanel_step_type_assert',
  extract: 'sidepanel_step_type_extract',
  screenshot: 'sidepanel_step_type_screenshot',
};

function stepTypeLabel(type: string): string {
  const key = STEP_TYPE_KEYS[type];
  if (!key) return type;
  const text = getMessage(key);
  return text && text !== key ? text : type;
}

function removeStep(nodeId: string) {
  if (!removedNodeIds.value.includes(nodeId))
    removedNodeIds.value = [...removedNodeIds.value, nodeId];
  // 같은 변수를 여러 단계가 쓸 수 있다. 그 중 하나만 지운 것이면 변수는 남긴다.
  const next: WizardVariable[] = [];
  for (const v of variables.value) {
    if (!v.nodeIds.includes(nodeId)) {
      next.push(v);
      continue;
    }
    const remaining = v.nodeIds.filter((id) => id !== nodeId);
    if (remaining.length === 0) continue; // 이 단계에서만 오던 값은 함께 사라진다
    next.push({ ...v, nodeIds: remaining });
  }
  variables.value = next;
}

async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    const flow = await rr.getFlow(props.flowId);
    if (!flow) {
      loadError.value = getMessage('sidepanel_wizard_load_failed');
      return;
    }
    source.value = flow;
    // 이름 기본값은 흐름이 들고 있는 재료(녹화 시작 탭 제목 → 시작 주소)로만 짓는다.
    name.value = isPlaceholderFlowName(flow.name) ? defaultFlowNameForFlow(flow) : flow.name;
    startUrl.value = flow.startUrl ?? '';
    variables.value = detectVariables(flow);
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

/** 지금 화면의 값으로 흐름을 만든다. 형식 오류가 있으면 문구를 남기고 null 을 돌려준다. */
function buildEditedFlow(): WizardFlow | null {
  formError.value = '';
  if (!source.value) return null;
  if (!name.value.trim()) {
    formError.value = getMessage('sidepanel_wizard_name_required');
    return null;
  }
  const check = validateVariables(variables.value);
  if (!check.ok) {
    formError.value =
      check.reason === 'duplicate_key'
        ? getMessage('sidepanel_wizard_duplicate_variable', [check.key])
        : getMessage('sidepanel_wizard_invalid_variable');
    return null;
  }
  const { flow } = applyWizardEdits(source.value, {
    name: name.value,
    startUrl: startUrl.value,
    variables: variables.value,
    removedNodeIds: removedNodeIds.value,
  });
  return flow;
}

/** 화면 상태를 저장한 흐름으로 다시 맞춘다 (연속 저장에서 version 이 한 번만 오르게). */
function adoptSaved(saved: WizardFlow): void {
  source.value = saved;
  name.value = saved.name;
  startUrl.value = saved.startUrl ?? '';
  removedNodeIds.value = [];
  variables.value = detectVariables(saved);
}

async function persist(): Promise<WizardFlow | null> {
  const edited = buildEditedFlow();
  if (!edited) return null;
  await rr.saveFlow(edited);
  adoptSaved(edited);
  return edited;
}

async function onSave(publish: boolean) {
  if (busy.value) return;
  const edited = buildEditedFlow();
  if (!edited) return;
  saving.value = true;
  try {
    // 저장과 발행이 **같은 객체**를 본다 (2026-09-05 시연 지적 3항).
    const { flow: saved } = await saveAndMaybePublish(
      {
        saveFlow: (f) => rr.saveFlow(f),
        publishFlow: (flowId, options) => rr.publishFlow(flowId, options),
      },
      edited,
      { publish },
    );
    adoptSaved(saved);
    emit('toast', {
      text: publish
        ? getMessage('sidepanel_wizard_published')
        : getMessage('sidepanel_wizard_saved'),
      kind: 'ok',
    });
    emit('saved', saved.id);
    emit('close');
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    formError.value = publish
      ? getMessage('sidepanel_wizard_publish_failed', [detail])
      : getMessage('sidepanel_wizard_save_failed', [detail]);
  } finally {
    saving.value = false;
  }
}

// ==================== 시험 실행 ====================

/** 탭이 문서를 다 읽을 때까지 잠깐 기다린다. 못 기다려도 실행은 진행한다. */
async function waitForTabReady(tabId: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return;
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function onTestRun() {
  if (busy.value) return;
  const edited = buildEditedFlow();
  if (!edited) return;
  if (!startUrl.value.trim()) {
    testOk.value = false;
    testMessage.value = getMessage('sidepanel_wizard_test_needs_url');
    return;
  }
  const needed = requiredRunVariables(edited);
  if (needed.length > 0) {
    askVariables.value = needed;
    return;
  }
  await doTestRun({});
}

function onVariablesSubmitted(values: Record<string, string>) {
  askVariables.value = null;
  void doTestRun(values);
}

async function doTestRun(args: Record<string, string>) {
  testing.value = true;
  testMessage.value = '';
  testFailures.value = [];
  try {
    const saved = await persist();
    if (!saved) return;

    const outcome = await runFlowInTemporaryTab(
      {
        // tab-create-ok: 시험 실행은 사용자가 보고 있는 화면을 빼앗으면 안 된다. 백그라운드
        // 탭을 직접 열고 그 id 를 실행에 고정한 뒤, 어떤 경로로 끝나든 닫는다.
        createTab: (url) => chrome.tabs.create({ url, active: false }),
        waitForTab: waitForTabReady,
        runFlow: (tabId) => rr.runFlow(saved.id, { tabId, args, returnLogs: true }),
        removeTab: (tabId) => chrome.tabs.remove(tabId),
      },
      startUrl.value.trim(),
    );

    if (!outcome.result) {
      testOk.value = false;
      testMessage.value = outcome.error || getMessage('sidepanel_wizard_test_needs_url');
      return;
    }

    const result = outcome.result;
    const summary = result.summary || { total: 0, success: 0, failed: 0, tookMs: 0 };
    testOk.value = outcome.ok;
    testMessage.value = getMessage('sidepanel_wizard_test_result', [
      String(summary.success),
      String(summary.failed),
      (summary.tookMs / 1000).toFixed(1),
    ]);
    testFailures.value = (result.logs || [])
      .filter((entry) => entry.status === 'failed')
      .slice(0, 5)
      .map((entry) => `${entry.stepId}: ${entry.message || ''}`.trim());
  } catch (e) {
    testOk.value = false;
    testMessage.value = e instanceof Error ? e.message : String(e);
  } finally {
    testing.value = false;
  }
}

onMounted(load);

// ==================== 스타일 ====================

const panelStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface, #ffffff)',
  borderRadius: 'var(--ac-radius-card, 12px)',
  border: 'var(--ac-border-width, 1px) solid var(--ac-border, #e7e5e4)',
}));
const headerStyle = computed(() => ({ borderColor: 'var(--ac-border, #e7e5e4)' }));
const titleStyle = computed(() => ({ color: 'var(--ac-text)' }));
const mutedStyle = computed(() => ({ color: 'var(--ac-text-subtle)' }));
const dangerStyle = computed(() => ({ color: 'var(--ac-danger, #ef4444)' }));
const okStyle = computed(() => ({ color: 'var(--ac-success, #16a34a)' }));
const rowStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface-muted)',
  borderRadius: 'var(--ac-radius-inner, 8px)',
}));
const inputStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface-muted)',
  color: 'var(--ac-text)',
  borderRadius: 'var(--ac-radius-inner, 8px)',
}));
const plainStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface-muted)',
  color: 'var(--ac-text)',
  borderRadius: 'var(--ac-radius-button)',
}));
const primaryStyle = computed(() => ({
  backgroundColor: 'var(--ac-accent)',
  color: 'var(--ac-accent-contrast)',
  borderRadius: 'var(--ac-radius-button)',
}));
</script>

<style scoped>
.wz-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  z-index: 50;
}

.wz-panel {
  width: 100%;
  max-width: 420px;
  max-height: 92%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.wz-header,
.wz-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  flex-shrink: 0;
}

.wz-header {
  justify-content: space-between;
  border-bottom: var(--ac-border-width, 1px) solid var(--ac-border, #e7e5e4);
}

.wz-footer {
  justify-content: flex-end;
  border-top: var(--ac-border-width, 1px) solid var(--ac-border, #e7e5e4);
}

.wz-title {
  font-size: 14px;
  font-weight: 600;
}

.wz-close {
  background: transparent;
  border: none;
  cursor: pointer;
  display: flex;
  padding: 2px;
}

.wz-body {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.wz-center {
  align-items: center;
  justify-content: center;
  font-size: 13px;
}

.wz-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.wz-label,
.wz-help {
  font-size: 12px;
}

.wz-input {
  height: 36px;
  padding: 0 10px;
  border: none;
  outline: none;
  font-size: 13px;
  font-family: inherit;
  width: 100%;
}

.wz-input-sm {
  height: 30px;
  font-size: 12px;
}

.wz-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.wz-section-title {
  font-size: 13px;
  font-weight: 600;
}

.wz-empty {
  font-size: 12px;
}

.wz-var-list,
.wz-steps {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.wz-var,
.wz-step {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
}

.wz-var-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.wz-var-src,
.wz-step-desc {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wz-sens {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  cursor: pointer;
  flex-shrink: 0;
}

.wz-check {
  width: 14px;
  height: 14px;
  cursor: pointer;
  flex-shrink: 0;
}

.wz-step-no {
  font-size: 11px;
  width: 18px;
  flex-shrink: 0;
}

.wz-step-type {
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}

.wz-step-desc {
  flex: 1;
  min-width: 0;
}

.wz-step-del {
  background: transparent;
  border: none;
  cursor: pointer;
  display: flex;
  padding: 2px;
  flex-shrink: 0;
}

.wz-btn {
  border: none;
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}

.wz-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.wz-test {
  font-size: 12px;
}

.wz-test-fails {
  margin: 0;
  padding: 0 0 0 14px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.wz-test-fail {
  font-size: 11px;
}
</style>
