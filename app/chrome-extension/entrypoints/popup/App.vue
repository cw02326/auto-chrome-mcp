<template>
  <div class="popup-container agent-theme" :data-agent-theme="agentTheme">
    <!-- 首页 -->
    <div v-show="currentView === 'home'" class="home-view">
      <div class="header">
        <div class="header-content">
          <h1 class="header-title">auto-chrome-mcp Chrome Mcp</h1>
        </div>
      </div>
      <div class="content">
        <!-- 服务配置卡片 -->
        <div class="section">
          <h2 class="section-title">{{ getMessage('nativeServerConfigLabel') }}</h2>
          <div class="config-card">
            <div class="status-section">
              <div class="status-header">
                <p class="status-label">{{ getMessage('runningStatusLabel') }}</p>
                <div class="status-switches">
                  <label
                    class="force-focus-switch"
                    :title="
                      forceFocusEnabled
                        ? '강제 포커스 ON — MCP 도구 실행 시 Chrome 윈도우가 OS 앞으로 튀어나옴. 탭 활성화는 이 토글과 무관하게 전용 작업 창 안에서만 일어납니다.'
                        : '강제 포커스 OFF — MCP 도구 실행 시 OS 포커스 가로채지 않음. 탭 활성화는 이 토글과 무관하게 전용 작업 창 안에서만 일어납니다.'
                    "
                  >
                    <input
                      type="checkbox"
                      class="force-focus-switch__input"
                      :checked="forceFocusEnabled"
                      :aria-label="forceFocusEnabled ? '강제 포커스 끄기' : '강제 포커스 켜기'"
                      @change="toggleForceFocus"
                    />
                    <span class="force-focus-switch__label">강제 포커스</span>
                    <span
                      class="force-focus-switch__track"
                      :class="{ 'force-focus-switch__track--on': forceFocusEnabled }"
                    >
                      <span class="force-focus-switch__thumb" />
                    </span>
                  </label>
                  <!-- auto-chrome-mcp fork: 백그라운드 작업 모드 토글 -->
                  <label
                    class="force-focus-switch"
                    title="ON: MCP 도구가 사용자의 탭·포커스를 건드리지 않고 백그라운드 작업 탭에서 작업합니다. OFF: 이전처럼 작업 탭을 앞으로 가져옵니다."
                  >
                    <input
                      type="checkbox"
                      class="force-focus-switch__input"
                      :checked="backgroundModeEnabled"
                      :aria-label="
                        backgroundModeEnabled ? '백그라운드 작업 끄기' : '백그라운드 작업 켜기'
                      "
                      @change="toggleBackgroundMode"
                    />
                    <span class="force-focus-switch__label">백그라운드 작업</span>
                    <span
                      class="force-focus-switch__track"
                      :class="{ 'force-focus-switch__track--on': backgroundModeEnabled }"
                    >
                      <span class="force-focus-switch__thumb" />
                    </span>
                  </label>
                  <!-- auto-chrome-mcp fork: 전용 MCP 작업 창 토글 -->
                  <label
                    class="force-focus-switch"
                    title="ON(v1.9.0 기본): MCP 작업 탭을 별도 'MCP 작업 창'에 모아 사용자 창과 완전히 분리합니다 — 아래 배치 설정에 따라 화면에 나타나지 않습니다. OFF: 지금 열려 있는 크롬 창에 새 탭을 백그라운드로 만들어 작업합니다."
                  >
                    <input
                      type="checkbox"
                      class="force-focus-switch__input"
                      :checked="dedicatedWindowEnabled"
                      :aria-label="
                        dedicatedWindowEnabled ? '전용 작업 창 끄기' : '전용 작업 창 켜기'
                      "
                      @change="toggleDedicatedWindow"
                    />
                    <span class="force-focus-switch__label">전용 작업 창</span>
                    <span
                      class="force-focus-switch__track"
                      :class="{ 'force-focus-switch__track--on': dedicatedWindowEnabled }"
                    >
                      <span class="force-focus-switch__thumb" />
                    </span>
                  </label>
                  <!-- auto-chrome-mcp fork: MCP 작업 탭 그룹 토글 -->
                  <label
                    class="force-focus-switch"
                    title="ON(기본): MCP 작업 탭을 초록색 탭 그룹 'MCP' 로 묶어 사용자가 직접 연 탭과 한눈에 구분되게 합니다. 탭을 활성화하거나 창 포커스를 바꾸지 않습니다. OFF: 묶지 않고 그대로 둡니다."
                  >
                    <input
                      type="checkbox"
                      class="force-focus-switch__input"
                      :checked="tabGroupEnabled"
                      :aria-label="
                        tabGroupEnabled ? '작업 탭 그룹 표시 끄기' : '작업 탭 그룹 표시 켜기'
                      "
                      @change="toggleTabGroup"
                    />
                    <span class="force-focus-switch__label">작업 탭 그룹 표시</span>
                    <span
                      class="force-focus-switch__track"
                      :class="{ 'force-focus-switch__track--on': tabGroupEnabled }"
                    >
                      <span class="force-focus-switch__thumb" />
                    </span>
                  </label>
                </div>
              </div>
              <!-- auto-chrome-mcp fork v1.9.0: 전용 작업 창 배치 + 무간섭 권장 설정 -->
              <div class="no-interference-row">
                <label class="no-interference-label" for="work-window-placement"
                  >작업 창 배치</label
                >
                <select
                  id="work-window-placement"
                  class="no-interference-select"
                  :value="workWindowPlacement"
                  :disabled="!dedicatedWindowEnabled"
                  title="전용 작업 창을 화면에서 어떻게 숨길지 정합니다. 최소화: 작업 표시줄에만 남습니다(기본). 화면 밖: 일반 창으로 만들어 화면 밖으로 밀어 둡니다. 보이게: 예전처럼 보이는 창 — 디버깅용."
                  @change="onPlacementChange"
                >
                  <option value="minimized">최소화 (권장)</option>
                  <option value="offscreen">화면 밖</option>
                  <option value="visible">보이게 (디버깅)</option>
                </select>
                <button
                  class="no-interference-reset"
                  type="button"
                  title="전용 작업 창 ON + 배치 최소화 + 백그라운드 작업 ON + 강제 포커스 OFF 로 한 번에 되돌립니다."
                  @click="applyNoInterferenceDefaults"
                >
                  무간섭 권장 설정으로 되돌리기
                </button>
              </div>
              <div v-if="noInterferenceNotice" class="no-interference-notice">
                {{ noInterferenceNotice }}
              </div>
              <div class="status-info">
                <span :class="['status-dot', getStatusClass()]"></span>
                <span class="status-text">{{ getStatusText() }}</span>
              </div>
              <div v-if="serverStatus.lastUpdated" class="status-timestamp">
                {{ getMessage('lastUpdatedLabel') }}
                {{ new Date(serverStatus.lastUpdated).toLocaleTimeString() }}
              </div>
            </div>

            <!-- auto-chrome-mcp fork v1.0.12: "MCP 서버 설정" JSON 박스 제거.
                 Claude prompt 박스가 더 직관적이고, JSON 박스는 사용자가 직접 채워야 하는
                 placeholder (<npm root -g 출력값>) 가 있어서 그냥 복사하면 안 됨 → 혼란만 가중. -->

            <!-- auto-chrome-mcp fork v1.0.10+: Claude Code 자동 등록 prompt 박스 -->
            <div v-if="showMcpConfig" class="mcp-config-section">
              <div class="mcp-config-header">
                <p class="mcp-config-label">⚡ Claude Code 자동 등록 prompt</p>
              </div>
              <p class="claude-prompt-hint">
                터미널의 <code>claude</code> 에 붙여넣으면 <code>.mcp.json</code> 자동 등록
              </p>
              <div class="mcp-config-content">
                <button
                  class="copy-config-button copy-config-button--floating"
                  @click="copyClaudePrompt"
                >
                  {{ claudePromptCopyText }}
                </button>
                <pre class="mcp-config-json">{{ claudePromptText }}</pre>
              </div>
            </div>
            <div class="port-section">
              <label for="port" class="port-label">{{ getMessage('connectionPortLabel') }}</label>
              <input
                type="text"
                id="port"
                :value="nativeServerPort"
                @input="updatePort"
                class="port-input"
              />
            </div>

            <button class="connect-button" :disabled="isConnecting" @click="testNativeConnection">
              <BoltIcon />
              <span>{{
                isConnecting
                  ? getMessage('connectingStatus')
                  : nativeConnectionStatus === 'connected'
                    ? getMessage('disconnectButton')
                    : getMessage('connectButton')
              }}</span>
            </button>

            <!-- auto-chrome-mcp fork: Force Reconnect 5단계 슈퍼버튼 -->
            <!-- reconnect 끝나면 popup 의 nativeConnectionStatus 즉시 갱신 -->
            <ForceReconnect
              :port="Number(nativeServerPort) || 12320"
              @reconnected="handleReconnected"
            />

            <!-- auto-chrome-mcp fork: Diagnostic Report + Self-Test -->
            <DiagnosticReport :port="Number(nativeServerPort) || 12320" />
          </div>
        </div>

        <!-- v1.0.31+: 사이트 권한 consent gate 토글
             ON = AI 가 묻지 않고 즉시 사용 / OFF = AI 가 consent 창으로 확인
             design: docs/plans/2026-05-29-site-permissions-design.md -->
        <div class="section">
          <h2 class="section-title">권한 설정</h2>
          <div class="config-card">
            <p class="site-perms-hint">
              AI 가 아래 권한을 사용하려 할 때, 토글이 OFF 면 사용자에게 확인합니다.
            </p>
            <div class="site-perms-list">
              <div
                v-for="item in SITE_PERMISSION_ITEMS"
                :key="item.key"
                class="site-perms-row-wrap"
              >
                <label class="site-perms-row">
                  <span class="site-perms-row__label">
                    <span class="site-perms-row__icon" aria-hidden="true">{{ item.icon }}</span>
                    <span>{{ item.label }}</span>
                  </span>
                  <span class="site-perms-row__actions">
                    <button
                      type="button"
                      class="site-perms-os-btn"
                      :title="`OS 시스템 설정에서 ${item.label} 권한 열기`"
                      :aria-label="`OS 시스템 설정에서 ${item.label} 권한 열기`"
                      @click.stop.prevent="openOSPermission(item.key)"
                    >
                      ⚙
                    </button>
                    <span class="force-focus-switch__wrap">
                      <input
                        type="checkbox"
                        class="force-focus-switch__input"
                        :checked="sitePermissionToggles[item.key]"
                        :aria-label="`${item.label} 토글`"
                        @change="toggleSitePermission(item.key)"
                      />
                      <span
                        class="force-focus-switch__track"
                        :class="{
                          'force-focus-switch__track--on': sitePermissionToggles[item.key],
                        }"
                      >
                        <span class="force-focus-switch__thumb" />
                      </span>
                    </span>
                  </span>
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 本地模型二级页面 -->
    <LocalModelPage
      v-show="currentView === 'local-model'"
      :semantic-engine-status="semanticEngineStatus"
      :is-semantic-engine-initializing="isSemanticEngineInitializing"
      :semantic-engine-init-progress="semanticEngineInitProgress"
      :semantic-engine-last-updated="semanticEngineLastUpdated"
      :available-models="availableModels"
      :current-model="currentModel"
      :is-model-switching="isModelSwitching"
      :is-model-downloading="isModelDownloading"
      :model-download-progress="modelDownloadProgress"
      :model-initialization-status="modelInitializationStatus"
      :model-error-message="modelErrorMessage"
      :model-error-type="modelErrorType"
      :storage-stats="storageStats"
      :is-clearing-data="isClearingData"
      :clear-data-progress="clearDataProgress"
      :cache-stats="cacheStats"
      :is-managing-cache="isManagingCache"
      @back="currentView = 'home'"
      @initialize-semantic-engine="initializeSemanticEngine"
      @switch-model="(preset: string) => switchModel(preset as ModelPreset)"
      @retry-model-initialization="retryModelInitialization"
      @show-clear-confirmation="showClearConfirmation = true"
      @cleanup-cache="cleanupCache"
      @clear-all-cache="clearAllCache"
    />

    <ConfirmDialog
      :visible="showClearConfirmation"
      :title="getMessage('confirmClearDataTitle')"
      :message="getMessage('clearDataWarningMessage')"
      :items="[
        getMessage('clearDataList1'),
        getMessage('clearDataList2'),
        getMessage('clearDataList3'),
      ]"
      :warning="getMessage('clearDataIrreversibleWarning')"
      icon="⚠️"
      :confirm-text="getMessage('confirmClearButton')"
      :cancel-text="getMessage('cancelButton')"
      :confirming-text="getMessage('clearingStatus')"
      :is-confirming="isClearingData"
      @confirm="confirmClearAllData"
      @cancel="hideClearDataConfirmation"
    />

    <!-- 侧边栏承担工作流管理；编辑器在独立窗口中打开 -->

    <!-- Coming Soon Toast -->
    <Transition name="toast">
      <div v-if="comingSoonToast.show" class="coming-soon-toast">
        <svg
          class="toast-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span>{{ comingSoonToast.feature }} 기능 개발 중, 출시 예정</span>
      </div>
    </Transition>
  </div>
</template>

<script lang="ts" setup>
import { ref, onMounted, onUnmounted, computed } from 'vue';
import {
  PREDEFINED_MODELS,
  type ModelPreset,
  getModelInfo,
  getCacheStats,
  clearModelCache,
  cleanupModelCache,
} from '@/utils/semantic-similarity-engine';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import { getMessage } from '@/utils/i18n';
import {
  isForceFocusEnabled,
  setForceFocusEnabled,
  FORCE_FOCUS_STORAGE_KEY,
} from '@/utils/focus-policy';
import {
  isBackgroundModeEnabled,
  setBackgroundModeEnabled,
  BACKGROUND_MODE_STORAGE_KEY,
} from '@/utils/background-mode';
import {
  getWorkWindowMode,
  setWorkWindowMode,
  DEFAULT_WORK_WINDOW_MODE,
  getWorkWindowPlacement,
  setWorkWindowPlacement,
  DEFAULT_WORK_WINDOW_PLACEMENT,
  WORK_WINDOW_MODE_STORAGE_KEY,
  WORK_WINDOW_PLACEMENT_STORAGE_KEY,
  type WorkWindowPlacement,
} from '@/utils/mcp-window-manager';
import {
  isMcpTabGroupEnabled,
  setMcpTabGroupEnabled,
  MCP_TAB_GROUP_STORAGE_KEY,
} from '@/utils/mcp-tab-group';
import {
  getToggles,
  setToggle as setSitePermissionToggleStorage,
  SENSITIVE_PERMISSIONS,
  STORAGE_KEY as SITE_PERMS_STORAGE_KEY,
  type SensitivePermission,
  type SitePermissionToggles,
} from '@/utils/consent-storage';
import { useAgentTheme, type AgentThemeId } from '../sidepanel/composables/useAgentTheme';

import ConfirmDialog from './components/ConfirmDialog.vue';
import ProgressIndicator from './components/ProgressIndicator.vue';
import ModelCacheManagement from './components/ModelCacheManagement.vue';
import LocalModelPage from './components/LocalModelPage.vue';
import ForceReconnect from './components/ForceReconnect.vue';
import DiagnosticReport from './components/DiagnosticReport.vue';
import {
  DocumentIcon,
  DatabaseIcon,
  BoltIcon,
  TrashIcon,
  CheckIcon,
  TabIcon,
  VectorIcon,
  RecordIcon,
  StopIcon,
  WorkflowIcon,
  EditIcon,
  MarkerIcon,
} from './components/icons';

// AgentChat theme - 从preload中获取，保持与sidepanel一致
const { theme: agentTheme, initTheme } = useAgentTheme();

// 当前视图状态：首页 or 本地模型页
const currentView = ref<'home' | 'local-model'>('home');

// Coming Soon Toast
const comingSoonToast = ref<{ show: boolean; feature: string }>({ show: false, feature: '' });

function showComingSoonToast(feature: string) {
  comingSoonToast.value = { show: true, feature };
  setTimeout(() => {
    comingSoonToast.value = { show: false, feature: '' };
  }, 2000);
}

// Record & Replay state
const rrRecording = ref(false);
const rrFlows = ref<
  Array<{ id: string; name: string; description?: string; meta?: any; variables?: any[] }>
>([]);
const rrOnlyBound = ref(false);
const rrSearch = ref('');
const currentTabUrl = ref<string>('');
const filteredRrFlows = computed(() => {
  const base = rrOnlyBound.value ? rrFlows.value.filter(isFlowBoundToCurrent) : rrFlows.value;
  const q = rrSearch.value.trim().toLowerCase();
  if (!q) return base;
  return base.filter((f: any) => {
    const name = String(f.name || '').toLowerCase();
    const domain = String(f?.meta?.domain || '').toLowerCase();
    const tags = ((f?.meta?.tags || []) as any[]).join(',').toLowerCase();
    return name.includes(q) || domain.includes(q) || tags.includes(q);
  });
});

// Flow editor在独立窗口中打开；在popup不再展示繁杂列表

const loadFlows = async () => {
  try {
    const res = await chrome.runtime.sendMessage({ type: BACKGROUND_MESSAGE_TYPES.RR_LIST_FLOWS });
    if (res && res.success) rrFlows.value = res.flows || [];
  } catch (e) {
    /* ignore */
  }
};

function isFlowBoundToCurrent(flow: any) {
  try {
    const bindings = flow?.meta?.bindings || [];
    if (!bindings.length) return false;
    if (!currentTabUrl.value) return true;
    const url = new URL(currentTabUrl.value);
    return bindings.some((b: any) => {
      if (b.type === 'domain') return url.hostname.includes(b.value);
      if (b.type === 'path') return url.pathname.startsWith(b.value);
      if (b.type === 'url') return (url.href || '').startsWith(b.value);
      return false;
    });
  } catch {
    return false;
  }
}

// 运行记录与覆盖项在侧边栏页面查看
const startRecording = async () => {
  // TODO: 录制回放功能开发中，暂时拦截
  showComingSoonToast('录制回放');
  return;
};

const stopRecording = async () => {
  // TODO: 录制回放功能开发中，暂时拦截
  showComingSoonToast('录制回放');
  return;
};

const runFlow = async (flowId: string) => {
  try {
    // load flow to get runOptions
    let flow: any = null;
    try {
      const getRes = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.RR_GET_FLOW,
        flowId,
      });
      if (getRes && getRes.success) flow = getRes.flow;
    } catch {}
    const runOptions = (flow && flow.meta && flow.meta.runOptions) || {};
    // No per-run overrides in popup; sidepanel/editor manage advanced options
    const ov: any = {};
    const res = await chrome.runtime.sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.RR_RUN_FLOW,
      flowId,
      options: { ...runOptions, ...ov, returnLogs: true },
    });
    if (!(res && res.success)) {
      console.warn('回放失败');
      return;
    }
    // If failed, open builder and focus the failed node
    try {
      const result = res.result;
      if (result && result.success === false) {
        const logs = result.logs || [];
        const failed = logs.find((l: any) => l.status === 'failed');
        if (failed && failed.stepId) {
          // 打开独立编辑窗口并定位失败节点
          if (flow) openBuilderWindow(flow.id, String(failed.stepId));
        }
      } else if (result && result.success === true) {
        // If run succeeded but selector fallback was used, suggest updating priorities
        const logs = result.logs || [];
        const fb = logs.find((l: any) => l.fallbackUsed && l.fallbackTo);
        if (fb && flow) openBuilderWindow(flow.id, String(fb.stepId || ''));
      }
    } catch {}
  } catch (e) {
    console.error('回放失败:', e);
  }
};

// 旧的“克隆/发布/定时/覆盖项”在侧边栏或编辑器中处理

const nativeConnectionStatus = ref<'unknown' | 'connected' | 'disconnected'>('unknown');
const isConnecting = ref(false);
const nativeServerPort = ref<number>(12320);

// auto-chrome-mcp fork: 강제포커스 정책 토글. true = MCP 도구가 OS 윈도우 포커스 가로채기 허용.
// false = Chrome 이 다른 앱 앞으로 안 튀어나옴 (탭 전환·창 생성은 여전히 동작).
const forceFocusEnabled = ref<boolean>(false);

// auto-chrome-mcp fork: 백그라운드 작업 모드 토글. true(기본) = MCP 도구가 사용자의 탭·포커스를
// 건드리지 않고 MCP 작업 탭에서 동작. false = 이전처럼 작업 탭을 앞으로 가져옴.
const backgroundModeEnabled = ref<boolean>(true);

// auto-chrome-mcp fork: 전용 작업 창 토글. true(v1.9.0 기본) = MCP 작업 탭을 별도
// "MCP 작업 창"에 모아 사용자 창과 분리. false = 사용자가 열어 둔 현재 창에 백그라운드 새 탭.
const dedicatedWindowEnabled = ref<boolean>(true);

// auto-chrome-mcp fork v1.9.0: 전용 작업 창을 화면에서 어떻게 숨길지.
const workWindowPlacement = ref<WorkWindowPlacement>(DEFAULT_WORK_WINDOW_PLACEMENT);

// auto-chrome-mcp fork: MCP 작업 탭 그룹 토글. true(기본) = 작업 탭을 초록색 탭 그룹
// "MCP" 로 묶어 사용자 탭과 구분. false = 묶지 않음.
const tabGroupEnabled = ref<boolean>(true);

// 권장 설정 적용 결과를 잠깐 보여 주는 안내 문구
const noInterferenceNotice = ref<string>('');

// v1.0.31+: site permissions consent gate (camera / microphone / geolocation)
const sitePermissionToggles = ref<SitePermissionToggles>({
  camera: true,
  microphone: true,
  geolocation: true,
});

const SITE_PERMISSION_ITEMS: ReadonlyArray<{
  key: SensitivePermission;
  label: string;
  icon: string;
}> = [
  { key: 'camera', label: '카메라', icon: '📷' },
  { key: 'microphone', label: '마이크', icon: '🎤' },
  { key: 'geolocation', label: '위치 정보', icon: '📍' },
];

// v1.0.33+: OS 시스템 설정 deep link.
// Chrome 확장 토글 ON 이어도 macOS/Windows 의 위치/카메라/마이크 권한이 OFF 면
// 실제 디바이스 접근 차단됨 → 사용자가 이 ⚙ 버튼으로 OS 설정 한 번에 점프.
//   - macOS: x-apple.systempreferences:com.apple.preference.security?Privacy_X
//   - Windows: ms-settings:privacy-X
//   - 기타 (Linux/cros/openbsd): 표준 deep link 없음 → 안내 alert 로 fallback
const OS_PERMISSION_URLS: Partial<Record<string, Record<SensitivePermission, string>>> = {
  mac: {
    camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
    microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    geolocation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices',
  },
  win: {
    camera: 'ms-settings:privacy-webcam',
    microphone: 'ms-settings:privacy-microphone',
    geolocation: 'ms-settings:privacy-location',
  },
};

const serverStatus = ref<{
  isRunning: boolean;
  port?: number;
  lastUpdated: number;
}>({
  isRunning: false,
  lastUpdated: Date.now(),
});

const showMcpConfig = computed(() => {
  return nativeConnectionStatus.value === 'connected' && serverStatus.value.isRunning;
});

// auto-chrome-mcp fork v1.0.12: "MCP 서버 설정" JSON 박스 제거됨. Claude prompt 박스만 표시.
// mcpConfigJson / copyMcpConfig / copyButtonText 도 함께 제거.

// auto-chrome-mcp fork v1.0.10: Claude Code 자동 등록 prompt. 사용자가 npm root -g 출력값
// 직접 채우기 귀찮으니 prompt 한 번 복사 → 터미널의 claude 에 붙여넣기.
const claudePromptText = computed(() => {
  const port = serverStatus.value.port || nativeServerPort.value;
  return (
    '지금 working dir (이 프로젝트 폴더) 의 .mcp.json 에 우리 chrome MCP ' +
    '(auto-chrome-mcp) 를 등록해줘. ~/.claude.json 같은 전역 설정에는 ' +
    '손대지 마.\n\n' +
    '규칙:\n' +
    '- 이름: "chrome-mcp-stdio"\n' +
    '- transport: stdio (HTTP 안 씀)\n' +
    '- command: "node"\n' +
    '- args: ["<npm root -g 출력값>/auto-chrome-mcp-bridge/dist/mcp/mcp-server-stdio.js"]\n' +
    `- env: { "CHROME_PORT": "${port}" }\n\n` +
    '먼저 `npm root -g` 를 bash 로 실행해서 실제 경로 얻고, 그 다음에 working dir 의 .mcp.json ' +
    '(없으면 신설) 의 mcpServers.chrome-mcp-stdio 만 추가/갱신해줘. 기존 다른 server 항목은 ' +
    '보존.\n\n' +
    '등록이 끝나면 아래 절차도 함께 안내해줘:\n' +
    '1. Claude Code 를 Ctrl+C 두 번으로 종료 후 다시 실행 (mcp 서버 재로드)\n' +
    '2. `/mcp` 입력해서 chrome-mcp-stdio 가 connected 상태인지 확인\n' +
    '3. 확인 후 Esc 로 빠져나오기'
  );
});

const claudePromptCopyText = ref('복사하기');
const copyClaudePrompt = async (): Promise<void> => {
  try {
    await navigator.clipboard.writeText(claudePromptText.value);
    claudePromptCopyText.value = '✅ 복사됨';
    setTimeout(() => {
      claudePromptCopyText.value = '복사하기';
    }, 2000);
  } catch (e) {
    console.error('Failed to copy claude prompt:', e);
  }
};

const currentModel = ref<ModelPreset | null>(null);
const isModelSwitching = ref(false);
const modelSwitchProgress = ref('');

const modelDownloadProgress = ref<number>(0);
const isModelDownloading = ref(false);
const modelInitializationStatus = ref<'idle' | 'downloading' | 'initializing' | 'ready' | 'error'>(
  'idle',
);
const modelErrorMessage = ref<string>('');
const modelErrorType = ref<'network' | 'file' | 'unknown' | ''>('');

const selectedVersion = ref<'quantized'>('quantized');

const storageStats = ref<{
  indexedPages: number;
  totalDocuments: number;
  totalTabs: number;
  indexSize: number;
  isInitialized: boolean;
} | null>(null);
const isRefreshingStats = ref(false);
const isClearingData = ref(false);
const showClearConfirmation = ref(false);
const clearDataProgress = ref('');

const semanticEngineStatus = ref<'idle' | 'initializing' | 'ready' | 'error'>('idle');
const isSemanticEngineInitializing = ref(false);
const semanticEngineInitProgress = ref('');
const semanticEngineLastUpdated = ref<number | null>(null);

// Cache management
const isManagingCache = ref(false);
const cacheStats = ref<{
  totalSize: number;
  totalSizeMB: number;
  entryCount: number;
  entries: Array<{
    url: string;
    size: number;
    sizeMB: number;
    timestamp: number;
    age: string;
    expired: boolean;
  }>;
} | null>(null);

const availableModels = computed(() => {
  return Object.entries(PREDEFINED_MODELS).map(([key, value]) => ({
    preset: key as ModelPreset,
    ...value,
  }));
});

const getStatusClass = () => {
  if (nativeConnectionStatus.value === 'connected') {
    if (serverStatus.value.isRunning) {
      return 'bg-emerald-500';
    } else {
      return 'bg-yellow-500';
    }
  } else if (nativeConnectionStatus.value === 'disconnected') {
    return 'bg-red-500';
  } else {
    return 'bg-gray-500';
  }
};

// Open sidepanel and close popup
async function openSidepanelAndClose(tab: string) {
  try {
    const current = await chrome.windows.getCurrent();
    if ((chrome.sidePanel as any)?.setOptions) {
      await (chrome.sidePanel as any).setOptions({
        path: `sidepanel.html?tab=${tab}`,
        enabled: true,
      });
    }
    if (chrome.sidePanel && (chrome.sidePanel as any).open) {
      await (chrome.sidePanel as any).open({ windowId: current.id! });
    }
    // Close popup after opening sidepanel
    window.close();
  } catch (e) {
    console.warn(`Failed to open sidepanel (${tab}):`, e);
  }
}

// Open sidepanel from popup for workflow management
function openWorkflowSidepanel() {
  // TODO: 工作流功能开发中，暂时拦截
  showComingSoonToast('工作流管理');
  // openSidepanelAndClose('workflows');
}

// Open sidepanel for element marker management
function openElementMarkerSidepanel() {
  openSidepanelAndClose('element-markers');
}

async function toggleWebEditor() {
  try {
    await chrome.runtime.sendMessage({ type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_TOGGLE });
  } catch (error) {
    console.warn('切换网页编辑模式失败:', error);
  }
}

async function toggleElementMarker() {
  try {
    // 获取当前活动tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      console.warn('无法获取当前tab');
      return;
    }

    // 向background发送消息，启动元素标注
    await chrome.runtime.sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_START,
      tabId: tab.id,
    });
  } catch (error) {
    console.warn('开启元素标注失败:', error);
  }
}

async function openWelcomePage() {
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  } catch {
    // ignore
  }
}

function openBuilderWindow(flowId?: string, focusNodeId?: string) {
  const url = new URL(chrome.runtime.getURL('builder.html'));
  if (flowId) url.searchParams.set('flowId', flowId);
  if (focusNodeId) url.searchParams.set('focus', focusNodeId);
  chrome.windows.create({ url: url.toString(), type: 'popup', width: 1280, height: 800 });
}

const getStatusText = () => {
  if (nativeConnectionStatus.value === 'connected') {
    if (serverStatus.value.isRunning) {
      return getMessage('serviceRunningStatus', [
        (serverStatus.value.port || 'Unknown').toString(),
      ]);
    } else {
      return getMessage('connectedServiceNotStartedStatus');
    }
  } else if (nativeConnectionStatus.value === 'disconnected') {
    return getMessage('serviceNotConnectedStatus');
  } else {
    return getMessage('detectingStatus');
  }
};

const formatIndexSize = () => {
  if (!storageStats.value?.indexSize) return '0 MB';
  const sizeInMB = Math.round(storageStats.value.indexSize / (1024 * 1024));
  return `${sizeInMB} MB`;
};

const getModelDescription = (model: any) => {
  switch (model.preset) {
    case 'multilingual-e5-small':
      return getMessage('lightweightModelDescription');
    case 'multilingual-e5-base':
      return getMessage('betterThanSmallDescription');
    default:
      return getMessage('multilingualModelDescription');
  }
};

const getPerformanceText = (performance: string) => {
  switch (performance) {
    case 'fast':
      return getMessage('fastPerformance');
    case 'balanced':
      return getMessage('balancedPerformance');
    case 'accurate':
      return getMessage('accuratePerformance');
    default:
      return performance;
  }
};

const getSemanticEngineStatusText = () => {
  switch (semanticEngineStatus.value) {
    case 'ready':
      return getMessage('semanticEngineReadyStatus');
    case 'initializing':
      return getMessage('semanticEngineInitializingStatus');
    case 'error':
      return getMessage('semanticEngineInitFailedStatus');
    case 'idle':
    default:
      return getMessage('semanticEngineNotInitStatus');
  }
};

const getSemanticEngineStatusClass = () => {
  switch (semanticEngineStatus.value) {
    case 'ready':
      return 'bg-emerald-500';
    case 'initializing':
      return 'bg-yellow-500';
    case 'error':
      return 'bg-red-500';
    case 'idle':
    default:
      return 'bg-gray-500';
  }
};

const getActiveTabsCount = () => {
  return storageStats.value?.totalTabs || 0;
};

const getProgressText = () => {
  if (isModelDownloading.value) {
    return getMessage('downloadingModelStatus', [modelDownloadProgress.value.toString()]);
  } else if (isModelSwitching.value) {
    return modelSwitchProgress.value || getMessage('switchingModelStatus');
  }
  return '';
};

const getErrorTypeText = () => {
  switch (modelErrorType.value) {
    case 'network':
      return getMessage('networkErrorMessage');
    case 'file':
      return getMessage('modelCorruptedErrorMessage');
    case 'unknown':
    default:
      return getMessage('unknownErrorMessage');
  }
};

const getSemanticEngineButtonText = () => {
  switch (semanticEngineStatus.value) {
    case 'ready':
      return getMessage('reinitializeButton');
    case 'initializing':
      return getMessage('initializingStatus');
    case 'error':
      return getMessage('reinitializeButton');
    case 'idle':
    default:
      return getMessage('initSemanticEngineButton');
  }
};

const loadCacheStats = async () => {
  try {
    cacheStats.value = await getCacheStats();
  } catch (error) {
    console.error('Failed to get cache stats:', error);
    cacheStats.value = null;
  }
};

const cleanupCache = async () => {
  if (isManagingCache.value) return;

  isManagingCache.value = true;
  try {
    await cleanupModelCache();
    // Refresh cache stats
    await loadCacheStats();
  } catch (error) {
    console.error('Failed to cleanup cache:', error);
  } finally {
    isManagingCache.value = false;
  }
};

const clearAllCache = async () => {
  if (isManagingCache.value) return;

  isManagingCache.value = true;
  try {
    await clearModelCache();
    // Refresh cache stats
    await loadCacheStats();
  } catch (error) {
    console.error('Failed to clear cache:', error);
  } finally {
    isManagingCache.value = false;
  }
};

const saveSemanticEngineState = async () => {
  try {
    const semanticEngineState = {
      status: semanticEngineStatus.value,
      lastUpdated: semanticEngineLastUpdated.value,
    };
    // eslint-disable-next-line no-undef
    await chrome.storage.local.set({ semanticEngineState });
  } catch (error) {
    console.error('保存语义引擎状态失败:', error);
  }
};

const initializeSemanticEngine = async () => {
  if (isSemanticEngineInitializing.value) return;

  const isReinitialization = semanticEngineStatus.value === 'ready';
  console.log(
    `🚀 User triggered semantic engine ${isReinitialization ? 'reinitialization' : 'initialization'}`,
  );

  isSemanticEngineInitializing.value = true;
  semanticEngineStatus.value = 'initializing';
  semanticEngineInitProgress.value = isReinitialization
    ? getMessage('semanticEngineInitializingStatus')
    : getMessage('semanticEngineInitializingStatus');
  semanticEngineLastUpdated.value = Date.now();

  await saveSemanticEngineState();

  try {
    // eslint-disable-next-line no-undef
    chrome.runtime
      .sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.INITIALIZE_SEMANTIC_ENGINE,
      })
      .catch((error) => {
        console.error('❌ Error sending semantic engine initialization request:', error);
      });

    startSemanticEngineStatusPolling();

    semanticEngineInitProgress.value = isReinitialization
      ? getMessage('processingStatus')
      : getMessage('processingStatus');
  } catch (error: any) {
    console.error('❌ Failed to send initialization request:', error);
    semanticEngineStatus.value = 'error';
    semanticEngineInitProgress.value = `Failed to send initialization request: ${error?.message || 'Unknown error'}`;

    await saveSemanticEngineState();

    setTimeout(() => {
      semanticEngineInitProgress.value = '';
    }, 5000);

    isSemanticEngineInitializing.value = false;
    semanticEngineLastUpdated.value = Date.now();
    await saveSemanticEngineState();
  }
};

const checkSemanticEngineStatus = async () => {
  try {
    // eslint-disable-next-line no-undef
    const response = await chrome.runtime.sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.GET_MODEL_STATUS,
    });

    if (response && response.success && response.status) {
      const status = response.status;

      if (status.initializationStatus === 'ready') {
        semanticEngineStatus.value = 'ready';
        semanticEngineLastUpdated.value = Date.now();
        isSemanticEngineInitializing.value = false;
        semanticEngineInitProgress.value = getMessage('semanticEngineReadyStatus');
        await saveSemanticEngineState();
        stopSemanticEngineStatusPolling();
        setTimeout(() => {
          semanticEngineInitProgress.value = '';
        }, 2000);
      } else if (
        status.initializationStatus === 'downloading' ||
        status.initializationStatus === 'initializing'
      ) {
        semanticEngineStatus.value = 'initializing';
        isSemanticEngineInitializing.value = true;
        semanticEngineInitProgress.value = getMessage('semanticEngineInitializingStatus');
        semanticEngineLastUpdated.value = Date.now();
        await saveSemanticEngineState();
      } else if (status.initializationStatus === 'error') {
        semanticEngineStatus.value = 'error';
        semanticEngineLastUpdated.value = Date.now();
        isSemanticEngineInitializing.value = false;
        semanticEngineInitProgress.value = getMessage('semanticEngineInitFailedStatus');
        await saveSemanticEngineState();
        stopSemanticEngineStatusPolling();
        setTimeout(() => {
          semanticEngineInitProgress.value = '';
        }, 5000);
      } else {
        semanticEngineStatus.value = 'idle';
        isSemanticEngineInitializing.value = false;
        await saveSemanticEngineState();
      }
    } else {
      semanticEngineStatus.value = 'idle';
      isSemanticEngineInitializing.value = false;
      await saveSemanticEngineState();
    }
  } catch (error) {
    console.error('Popup: Failed to check semantic engine status:', error);
    semanticEngineStatus.value = 'idle';
    isSemanticEngineInitializing.value = false;
    await saveSemanticEngineState();
  }
};

const retryModelInitialization = async () => {
  if (!currentModel.value) return;

  console.log('🔄 Retrying model initialization...');

  modelErrorMessage.value = '';
  modelErrorType.value = '';
  modelInitializationStatus.value = 'downloading';
  modelDownloadProgress.value = 0;
  isModelDownloading.value = true;
  await switchModel(currentModel.value);
};

const updatePort = async (event: Event) => {
  const target = event.target as HTMLInputElement;
  const newPort = Number(target.value);
  nativeServerPort.value = newPort;

  await savePortPreference(newPort);
};

const checkNativeConnection = async () => {
  try {
    // eslint-disable-next-line no-undef
    const response = await chrome.runtime.sendMessage({ type: 'ping_native' });
    nativeConnectionStatus.value = response?.connected ? 'connected' : 'disconnected';
  } catch (error) {
    console.error('检测 Native 连接状态失败:', error);
    nativeConnectionStatus.value = 'disconnected';
  }
};

const checkServerStatus = async () => {
  try {
    // eslint-disable-next-line no-undef
    const response = await chrome.runtime.sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.GET_SERVER_STATUS,
    });
    if (response?.success && response.serverStatus) {
      serverStatus.value = response.serverStatus;
    }

    if (response?.connected !== undefined) {
      nativeConnectionStatus.value = response.connected ? 'connected' : 'disconnected';
    }
  } catch (error) {
    console.error('检测服务器状态失败:', error);
  }
};

// auto-chrome-mcp fork v1.0.16: Force Reconnect 5단계 모두 success = 실제 연결됨.
// 이전에는 background polling 에 status 의존했는데 background 의 currentServerStatus 가
// stale 한 케이스에서 popup 이 "연결되지 않음" stuck. force-reconnect 의 진짜 결과를
// 신뢰해서 popup status 를 직접 강제 set. (background 도 별도로 sync 시도)
const handleReconnected = async (payload: {
  ok: boolean;
  finalBridgePid?: number;
}): Promise<void> => {
  if (!payload.ok) return;

  // 1) popup status 직접 강제 갱신 — 5단계 success 한 시점에 이미 실제 연결됨.
  nativeConnectionStatus.value = 'connected';
  serverStatus.value = {
    ...serverStatus.value,
    isRunning: true,
    port: Number(nativeServerPort.value) || 12320,
    lastUpdated: Date.now(),
  };

  // 2) background 도 sync — connectNative 트리거 + 자체 polling 으로 stale 정리
  try {
    await chrome.runtime.sendMessage({ type: 'connectNative' });
  } catch {
    // silent
  }
  // 3) background polling 도 한 번 호출 (없으면 다음 popup open 시 갱신)
  await Promise.all([checkNativeConnection(), checkServerStatus()]).catch(() => {});

  // 4) 강제 set 한 값이 background polling 에 의해 잠시 후 덮어쓰이면 다시 강제 — 1초 후 한 번 더
  setTimeout(() => {
    if (payload.ok) {
      nativeConnectionStatus.value = 'connected';
      serverStatus.value = {
        ...serverStatus.value,
        isRunning: true,
        port: Number(nativeServerPort.value) || 12320,
        lastUpdated: Date.now(),
      };
    }
  }, 1000);
};

const testNativeConnection = async () => {
  if (isConnecting.value) return;
  isConnecting.value = true;
  try {
    if (nativeConnectionStatus.value === 'connected') {
      // eslint-disable-next-line no-undef
      await chrome.runtime.sendMessage({ type: 'disconnect_native' });
      nativeConnectionStatus.value = 'disconnected';
    } else {
      console.log(`尝试连接到端口: ${nativeServerPort.value}`);
      // eslint-disable-next-line no-undef
      const response = await chrome.runtime.sendMessage({
        type: 'connectNative',
        port: nativeServerPort.value,
      });
      if (response && response.success) {
        nativeConnectionStatus.value = 'connected';
        console.log('连接成功:', response);
        await savePortPreference(nativeServerPort.value);
      } else {
        nativeConnectionStatus.value = 'disconnected';
        console.error('连接失败:', response);
      }
    }
  } catch (error) {
    console.error('测试连接失败:', error);
    nativeConnectionStatus.value = 'disconnected';
  } finally {
    isConnecting.value = false;
  }
};

const loadModelPreference = async () => {
  try {
    // eslint-disable-next-line no-undef
    const result = await chrome.storage.local.get([
      'selectedModel',
      'selectedVersion',
      'modelState',
      'semanticEngineState',
    ]);

    if (result.selectedModel) {
      const storedModel = result.selectedModel as string;
      console.log('📋 Stored model from storage:', storedModel);

      if (PREDEFINED_MODELS[storedModel as ModelPreset]) {
        currentModel.value = storedModel as ModelPreset;
        console.log(`✅ Loaded valid model: ${currentModel.value}`);
      } else {
        console.warn(
          `⚠️ Stored model "${storedModel}" not found in PREDEFINED_MODELS, using default`,
        );
        currentModel.value = 'multilingual-e5-small';
        await saveModelPreference(currentModel.value);
      }
    } else {
      console.log('⚠️ No model found in storage, using default');
      currentModel.value = 'multilingual-e5-small';
      await saveModelPreference(currentModel.value);
    }

    selectedVersion.value = 'quantized';
    console.log('✅ Using quantized version (fixed)');

    await saveVersionPreference('quantized');

    if (result.modelState) {
      const modelState = result.modelState;

      if (modelState.status === 'ready') {
        modelInitializationStatus.value = 'ready';
        modelDownloadProgress.value = modelState.downloadProgress || 100;
        isModelDownloading.value = false;
      } else {
        modelInitializationStatus.value = 'idle';
        modelDownloadProgress.value = 0;
        isModelDownloading.value = false;

        await saveModelState();
      }
    } else {
      modelInitializationStatus.value = 'idle';
      modelDownloadProgress.value = 0;
      isModelDownloading.value = false;
    }

    if (result.semanticEngineState) {
      const semanticState = result.semanticEngineState;
      if (semanticState.status === 'ready') {
        semanticEngineStatus.value = 'ready';
        semanticEngineLastUpdated.value = semanticState.lastUpdated || Date.now();
      } else if (semanticState.status === 'error') {
        semanticEngineStatus.value = 'error';
        semanticEngineLastUpdated.value = semanticState.lastUpdated || Date.now();
      } else {
        semanticEngineStatus.value = 'idle';
      }
    } else {
      semanticEngineStatus.value = 'idle';
    }
  } catch (error) {
    console.error('❌ 加载模型偏好失败:', error);
  }
};

const saveModelPreference = async (model: ModelPreset) => {
  try {
    // eslint-disable-next-line no-undef
    await chrome.storage.local.set({ selectedModel: model });
  } catch (error) {
    console.error('保存模型偏好失败:', error);
  }
};

const saveVersionPreference = async (version: 'full' | 'quantized' | 'compressed') => {
  try {
    // eslint-disable-next-line no-undef
    await chrome.storage.local.set({ selectedVersion: version });
  } catch (error) {
    console.error('保存版本偏好失败:', error);
  }
};

const savePortPreference = async (port: number) => {
  try {
    // eslint-disable-next-line no-undef
    await chrome.storage.local.set({ nativeServerPort: port });
    console.log(`端口偏好已保存: ${port}`);
  } catch (error) {
    console.error('保存端口偏好失败:', error);
  }
};

const loadPortPreference = async () => {
  try {
    // eslint-disable-next-line no-undef
    const result = await chrome.storage.local.get(['nativeServerPort']);
    if (result.nativeServerPort) {
      nativeServerPort.value = result.nativeServerPort;
      console.log(`端口偏好已加载: ${result.nativeServerPort}`);
    }
  } catch (error) {
    console.error('加载端口偏好失败:', error);
  }
};

// auto-chrome-mcp fork: 강제포커스 토글 — load + toggle handler.
const loadForceFocusPreference = async () => {
  try {
    forceFocusEnabled.value = await isForceFocusEnabled();
  } catch (error) {
    console.error('강제포커스 설정 로드 실패:', error);
  }
};

const toggleForceFocus = async () => {
  const next = !forceFocusEnabled.value;
  forceFocusEnabled.value = next; // optimistic
  try {
    await setForceFocusEnabled(next);
  } catch (error) {
    console.error('강제포커스 설정 저장 실패:', error);
    forceFocusEnabled.value = !next; // revert
  }
};

// auto-chrome-mcp fork: 백그라운드 작업 모드 토글 — load + toggle handler.
const loadBackgroundModePreference = async () => {
  try {
    backgroundModeEnabled.value = await isBackgroundModeEnabled();
  } catch (error) {
    console.error('백그라운드 작업 모드 설정 로드 실패:', error);
  }
};

const toggleBackgroundMode = async () => {
  const next = !backgroundModeEnabled.value;
  backgroundModeEnabled.value = next; // optimistic
  try {
    await setBackgroundModeEnabled(next);
  } catch (error) {
    console.error('백그라운드 작업 모드 설정 저장 실패:', error);
    backgroundModeEnabled.value = !next; // revert
  }
};

// auto-chrome-mcp fork: 전용 작업 창 토글 — load + toggle handler.
const loadDedicatedWindowPreference = async () => {
  try {
    dedicatedWindowEnabled.value = (await getWorkWindowMode()) === 'dedicated';
  } catch (error) {
    console.error('전용 작업 창 설정 로드 실패:', error);
  }
};

const toggleDedicatedWindow = async () => {
  const next = !dedicatedWindowEnabled.value;
  dedicatedWindowEnabled.value = next; // optimistic
  try {
    await setWorkWindowMode(next ? 'dedicated' : 'current');
  } catch (error) {
    console.error('전용 작업 창 설정 저장 실패:', error);
    dedicatedWindowEnabled.value = !next; // revert
  }
};

// auto-chrome-mcp fork: MCP 작업 탭 그룹 토글 — load + toggle handler.
const loadTabGroupPreference = async () => {
  try {
    tabGroupEnabled.value = await isMcpTabGroupEnabled();
  } catch (error) {
    console.error('작업 탭 그룹 설정 로드 실패:', error);
  }
};

const toggleTabGroup = async () => {
  const next = !tabGroupEnabled.value;
  tabGroupEnabled.value = next; // optimistic
  try {
    await setMcpTabGroupEnabled(next);
  } catch (error) {
    console.error('작업 탭 그룹 설정 저장 실패:', error);
    tabGroupEnabled.value = !next; // revert
  }
};

// auto-chrome-mcp fork v1.9.0: 전용 작업 창 배치 — load + change handler.
const loadWorkWindowPlacement = async () => {
  try {
    workWindowPlacement.value = await getWorkWindowPlacement();
  } catch (error) {
    console.error('작업 창 배치 설정 로드 실패:', error);
  }
};

const onPlacementChange = async (event: Event) => {
  const value = (event.target as HTMLSelectElement | null)?.value;
  if (value !== 'minimized' && value !== 'offscreen' && value !== 'visible') return;
  const previous = workWindowPlacement.value;
  workWindowPlacement.value = value; // optimistic
  try {
    await setWorkWindowPlacement(value);
  } catch (error) {
    console.error('작업 창 배치 설정 저장 실패:', error);
    workWindowPlacement.value = previous; // revert
  }
};

/**
 * auto-chrome-mcp fork v1.9.0: 무간섭 권장 설정으로 한 번에 되돌린다.
 * 예전 버전에서 토글을 껐던 사용자는 저장값이 존중되므로 새 기본값이 저절로 적용되지 않는다.
 * 이 버튼이 그 유일한 통로다.
 */
const applyNoInterferenceDefaults = async () => {
  try {
    await setWorkWindowMode(DEFAULT_WORK_WINDOW_MODE);
    await setWorkWindowPlacement(DEFAULT_WORK_WINDOW_PLACEMENT);
    await setBackgroundModeEnabled(true);
    await setForceFocusEnabled(false);
    dedicatedWindowEnabled.value = DEFAULT_WORK_WINDOW_MODE === 'dedicated';
    workWindowPlacement.value = DEFAULT_WORK_WINDOW_PLACEMENT;
    backgroundModeEnabled.value = true;
    forceFocusEnabled.value = false;
    noInterferenceNotice.value = '무간섭 권장 설정을 적용했습니다.';
  } catch (error) {
    console.error('무간섭 권장 설정 적용 실패:', error);
    noInterferenceNotice.value = '설정을 저장하지 못했습니다.';
  }
  setTimeout(() => {
    noInterferenceNotice.value = '';
  }, 4000);
};

// v1.0.31+: site permissions consent gate
const loadSitePermissionToggles = async () => {
  try {
    sitePermissionToggles.value = await getToggles();
  } catch (error) {
    console.error('사이트 권한 토글 로드 실패:', error);
  }
};

const toggleSitePermission = async (key: SensitivePermission) => {
  const next = !sitePermissionToggles.value[key];
  sitePermissionToggles.value = { ...sitePermissionToggles.value, [key]: next }; // optimistic
  try {
    await setSitePermissionToggleStorage(key, next);
  } catch (error) {
    console.error('사이트 권한 토글 저장 실패:', error);
    sitePermissionToggles.value = { ...sitePermissionToggles.value, [key]: !next }; // revert
  }
};

// v1.0.33+: ⚙ 버튼 클릭 → OS 시스템 설정 deep link.
// Chrome 이 처음 한 번 "외부 앱을 열려고 합니다" confirm 띄움 (사용자 OK 시 기억).
// Linux/cros/openbsd 는 표준 deep link 없으니 안내 alert.
const openOSPermission = async (key: SensitivePermission) => {
  const label = SITE_PERMISSION_ITEMS.find((i) => i.key === key)?.label || key;
  try {
    const info = await chrome.runtime.getPlatformInfo();
    const url = OS_PERMISSION_URLS[info.os]?.[key];
    if (url) {
      window.location.href = url;
    } else {
      alert(
        `이 OS (${info.os}) 에서는 자동 열기 미지원.\n` +
          `${label} 권한을 시스템 설정에서 직접 켜주세요.`,
      );
    }
  } catch (e) {
    console.error('openOSPermission 실패:', e);
    alert(`OS 설정 열기 실패. ${label} 권한을 시스템 설정에서 직접 켜주세요.`);
  }
};

const saveModelState = async () => {
  try {
    const modelState = {
      status: modelInitializationStatus.value,
      downloadProgress: modelDownloadProgress.value,
      isDownloading: isModelDownloading.value,
      lastUpdated: Date.now(),
    };
    // eslint-disable-next-line no-undef
    await chrome.storage.local.set({ modelState });
  } catch (error) {
    console.error('保存模型状态失败:', error);
  }
};

let statusMonitoringInterval: ReturnType<typeof setInterval> | null = null;
let semanticEngineStatusPollingInterval: ReturnType<typeof setInterval> | null = null;

const startModelStatusMonitoring = () => {
  if (statusMonitoringInterval) {
    clearInterval(statusMonitoringInterval);
  }

  statusMonitoringInterval = setInterval(async () => {
    try {
      // eslint-disable-next-line no-undef
      const response = await chrome.runtime.sendMessage({
        type: 'get_model_status',
      });

      if (response && response.success) {
        const status = response.status;
        modelInitializationStatus.value = status.initializationStatus || 'idle';
        modelDownloadProgress.value = status.downloadProgress || 0;
        isModelDownloading.value = status.isDownloading || false;

        if (status.initializationStatus === 'error') {
          modelErrorMessage.value = status.errorMessage || getMessage('modelFailedStatus');
          modelErrorType.value = status.errorType || 'unknown';
        } else {
          modelErrorMessage.value = '';
          modelErrorType.value = '';
        }

        await saveModelState();

        if (status.initializationStatus === 'ready' || status.initializationStatus === 'error') {
          stopModelStatusMonitoring();
        }
      }
    } catch (error) {
      console.error('获取模型状态失败:', error);
    }
  }, 1000);
};

const stopModelStatusMonitoring = () => {
  if (statusMonitoringInterval) {
    clearInterval(statusMonitoringInterval);
    statusMonitoringInterval = null;
  }
};

const startSemanticEngineStatusPolling = () => {
  if (semanticEngineStatusPollingInterval) {
    clearInterval(semanticEngineStatusPollingInterval);
  }

  semanticEngineStatusPollingInterval = setInterval(async () => {
    try {
      await checkSemanticEngineStatus();
    } catch (error) {
      console.error('Semantic engine status polling failed:', error);
    }
  }, 2000);
};

const stopSemanticEngineStatusPolling = () => {
  if (semanticEngineStatusPollingInterval) {
    clearInterval(semanticEngineStatusPollingInterval);
    semanticEngineStatusPollingInterval = null;
  }
};

const refreshStorageStats = async () => {
  if (isRefreshingStats.value) return;

  isRefreshingStats.value = true;
  try {
    console.log('🔄 Refreshing storage statistics...');

    // eslint-disable-next-line no-undef
    const response = await chrome.runtime.sendMessage({
      type: 'get_storage_stats',
    });

    if (response && response.success) {
      storageStats.value = {
        indexedPages: response.stats.indexedPages || 0,
        totalDocuments: response.stats.totalDocuments || 0,
        totalTabs: response.stats.totalTabs || 0,
        indexSize: response.stats.indexSize || 0,
        isInitialized: response.stats.isInitialized || false,
      };
      console.log('✅ Storage stats refreshed:', storageStats.value);
    } else {
      console.error('❌ Failed to get storage stats:', response?.error);
      storageStats.value = {
        indexedPages: 0,
        totalDocuments: 0,
        totalTabs: 0,
        indexSize: 0,
        isInitialized: false,
      };
    }
  } catch (error) {
    console.error('❌ Error refreshing storage stats:', error);
    storageStats.value = {
      indexedPages: 0,
      totalDocuments: 0,
      totalTabs: 0,
      indexSize: 0,
      isInitialized: false,
    };
  } finally {
    isRefreshingStats.value = false;
  }
};

const hideClearDataConfirmation = () => {
  showClearConfirmation.value = false;
};

const confirmClearAllData = async () => {
  if (isClearingData.value) return;

  isClearingData.value = true;
  clearDataProgress.value = getMessage('clearingStatus');

  try {
    console.log('🗑️ Starting to clear all data...');

    // eslint-disable-next-line no-undef
    const response = await chrome.runtime.sendMessage({
      type: 'clear_all_data',
    });

    if (response && response.success) {
      clearDataProgress.value = getMessage('dataClearedNotification');
      console.log('✅ All data cleared successfully');

      await refreshStorageStats();

      setTimeout(() => {
        clearDataProgress.value = '';
        hideClearDataConfirmation();
      }, 2000);
    } else {
      throw new Error(response?.error || 'Failed to clear data');
    }
  } catch (error: any) {
    console.error('❌ Failed to clear all data:', error);
    clearDataProgress.value = `Failed to clear data: ${error?.message || 'Unknown error'}`;

    setTimeout(() => {
      clearDataProgress.value = '';
    }, 5000);
  } finally {
    isClearingData.value = false;
  }
};

const switchModel = async (newModel: ModelPreset) => {
  console.log(`🔄 switchModel called with newModel: ${newModel}`);

  if (isModelSwitching.value) {
    console.log('⏸️ Model switch already in progress, skipping');
    return;
  }

  const isSameModel = newModel === currentModel.value;
  const currentModelInfo = currentModel.value
    ? getModelInfo(currentModel.value)
    : getModelInfo('multilingual-e5-small');
  const newModelInfo = getModelInfo(newModel);
  const isDifferentDimension = currentModelInfo.dimension !== newModelInfo.dimension;

  console.log(`📊 Switch analysis:`);
  console.log(`   - Same model: ${isSameModel} (${currentModel.value} -> ${newModel})`);
  console.log(
    `   - Current dimension: ${currentModelInfo.dimension}, New dimension: ${newModelInfo.dimension}`,
  );
  console.log(`   - Different dimension: ${isDifferentDimension}`);

  if (isSameModel && !isDifferentDimension) {
    console.log('✅ Same model and dimension - no need to switch');
    return;
  }

  const switchReasons = [];
  if (!isSameModel) switchReasons.push('different model');
  if (isDifferentDimension) switchReasons.push('different dimension');

  console.log(`🚀 Switching model due to: ${switchReasons.join(', ')}`);
  console.log(
    `📋 Model: ${currentModel.value} (${currentModelInfo.dimension}D) -> ${newModel} (${newModelInfo.dimension}D)`,
  );

  isModelSwitching.value = true;
  modelSwitchProgress.value = getMessage('switchingModelStatus');

  modelInitializationStatus.value = 'downloading';
  modelDownloadProgress.value = 0;
  isModelDownloading.value = true;

  try {
    await saveModelPreference(newModel);
    await saveVersionPreference('quantized');
    await saveModelState();

    modelSwitchProgress.value = getMessage('semanticEngineInitializingStatus');

    startModelStatusMonitoring();

    // eslint-disable-next-line no-undef
    const response = await chrome.runtime.sendMessage({
      type: 'switch_semantic_model',
      modelPreset: newModel,
      modelVersion: 'quantized',
      modelDimension: newModelInfo.dimension,
      previousDimension: currentModelInfo.dimension,
    });

    if (response && response.success) {
      currentModel.value = newModel;
      modelSwitchProgress.value = getMessage('successNotification');
      console.log(
        '模型切换成功:',
        newModel,
        'version: quantized',
        'dimension:',
        newModelInfo.dimension,
      );

      modelInitializationStatus.value = 'ready';
      isModelDownloading.value = false;
      await saveModelState();

      setTimeout(() => {
        modelSwitchProgress.value = '';
      }, 2000);
    } else {
      throw new Error(response?.error || 'Model switch failed');
    }
  } catch (error: any) {
    console.error('模型切换失败:', error);
    modelSwitchProgress.value = `Model switch failed: ${error?.message || 'Unknown error'}`;

    modelInitializationStatus.value = 'error';
    isModelDownloading.value = false;

    const errorMessage = error?.message || '未知错误';
    if (
      errorMessage.includes('network') ||
      errorMessage.includes('fetch') ||
      errorMessage.includes('timeout')
    ) {
      modelErrorType.value = 'network';
      modelErrorMessage.value = getMessage('networkErrorMessage');
    } else if (
      errorMessage.includes('corrupt') ||
      errorMessage.includes('invalid') ||
      errorMessage.includes('format')
    ) {
      modelErrorType.value = 'file';
      modelErrorMessage.value = getMessage('modelCorruptedErrorMessage');
    } else {
      modelErrorType.value = 'unknown';
      modelErrorMessage.value = errorMessage;
    }

    await saveModelState();

    setTimeout(() => {
      modelSwitchProgress.value = '';
    }, 8000);
  } finally {
    isModelSwitching.value = false;
  }
};

const setupServerStatusListener = () => {
  // eslint-disable-next-line no-undef
  const onMessage = (message: { type?: string; payload?: any }) => {
    // Server status changes
    if (message.type === BACKGROUND_MESSAGE_TYPES.SERVER_STATUS_CHANGED && message.payload) {
      serverStatus.value = message.payload;
      // v1.0.20: payload 에 nativeConnected 가 함께 와서 polling 기다리지 않고
      // 즉시 connection status 반영. PORT_CONFLICT 후 "connected && !isRunning"
      // 노란색 깜빡임 차단 — 강제 takeover 면 곧장 빨간색 'disconnected' 로.
      if (message.payload.nativeConnected === false) {
        nativeConnectionStatus.value = 'disconnected';
      } else if (message.payload.nativeConnected === true) {
        nativeConnectionStatus.value = 'connected';
      }
      console.log('Server status updated:', message.payload);
    }
    // Flows changed - refresh list (IndexedDB-based notification)
    if (message.type === BACKGROUND_MESSAGE_TYPES.RR_FLOWS_CHANGED) {
      loadFlows();
    }
  };
  chrome.runtime.onMessage.addListener(onMessage);
  // Store reference for cleanup
  (window as any).__rr_popup_onMessage = onMessage;
};

onMounted(async () => {
  // 初始化主题
  await initTheme();
  await loadPortPreference();
  await loadForceFocusPreference();
  await loadBackgroundModePreference();
  await loadDedicatedWindowPreference();
  await loadWorkWindowPlacement();
  await loadTabGroupPreference();
  await loadSitePermissionToggles();
  await loadModelPreference();
  await checkNativeConnection();
  await checkServerStatus();
  await refreshStorageStats();
  await loadCacheStats();
  await loadFlows();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabUrl.value = tab?.url || '';
  } catch {}

  await checkSemanticEngineStatus();
  setupServerStatusListener();
  // Auto-refresh workflows list when storage rr_flows changes
  try {
    const onChanged = (changes: any, area: string) => {
      try {
        if (area !== 'local') return;
        if (Object.prototype.hasOwnProperty.call(changes || {}, 'rr_flows')) loadFlows();
        // auto-chrome-mcp fork: 다른 popup/탭이 force-focus 토글 바꿔도 즉시 반영.
        if (Object.prototype.hasOwnProperty.call(changes || {}, FORCE_FOCUS_STORAGE_KEY)) {
          forceFocusEnabled.value = changes[FORCE_FOCUS_STORAGE_KEY]?.newValue === true;
        }
        // auto-chrome-mcp fork: 백그라운드 작업 모드도 동일하게 동기화 (기본값 true — false 만 OFF).
        if (Object.prototype.hasOwnProperty.call(changes || {}, BACKGROUND_MODE_STORAGE_KEY)) {
          backgroundModeEnabled.value = changes[BACKGROUND_MODE_STORAGE_KEY]?.newValue !== false;
        }
        // auto-chrome-mcp fork: 작업 창 모드도 동일하게 동기화 (기본값 'current' — 'dedicated' 만 ON).
        if (Object.prototype.hasOwnProperty.call(changes || {}, WORK_WINDOW_MODE_STORAGE_KEY)) {
          dedicatedWindowEnabled.value =
            changes[WORK_WINDOW_MODE_STORAGE_KEY]?.newValue === 'dedicated';
        }
        // auto-chrome-mcp fork v1.9.0: 작업 창 배치.
        if (
          Object.prototype.hasOwnProperty.call(changes || {}, WORK_WINDOW_PLACEMENT_STORAGE_KEY)
        ) {
          const next = changes[WORK_WINDOW_PLACEMENT_STORAGE_KEY]?.newValue;
          if (next === 'minimized' || next === 'offscreen' || next === 'visible') {
            workWindowPlacement.value = next;
          }
        }
        // auto-chrome-mcp fork: MCP 작업 탭 그룹 토글 (기본값 true — false 만 OFF).
        if (Object.prototype.hasOwnProperty.call(changes || {}, MCP_TAB_GROUP_STORAGE_KEY)) {
          tabGroupEnabled.value = changes[MCP_TAB_GROUP_STORAGE_KEY]?.newValue !== false;
        }
        // v1.0.31+: 사이트 권한 토글 동기화 (background 가 consent 후 ON 으로 바꿀 때도)
        if (Object.prototype.hasOwnProperty.call(changes || {}, SITE_PERMS_STORAGE_KEY)) {
          loadSitePermissionToggles();
        }
      } catch {}
    };
    chrome.storage.onChanged.addListener(onChanged);
    (window as any).__rr_popup_onChanged = onChanged;
  } catch {}
});

onUnmounted(() => {
  stopModelStatusMonitoring();
  stopSemanticEngineStatusPolling();
  // Clean up runtime message listener
  try {
    const msgFn = (window as any).__rr_popup_onMessage;
    if (msgFn && chrome?.runtime?.onMessage?.removeListener) {
      chrome.runtime.onMessage.removeListener(msgFn);
    }
  } catch {}
  // Clean up storage change listener (legacy fallback)
  try {
    const fn = (window as any).__rr_popup_onChanged;
    if (fn && chrome?.storage?.onChanged?.removeListener) {
      chrome.storage.onChanged.removeListener(fn);
    }
  } catch {}
});
</script>

<style scoped>
/* auto-chrome-mcp fork v1.9.0: 무간섭 모드 설정 줄 */
.no-interference-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;
}

.no-interference-label {
  font-size: 12px;
  opacity: 0.85;
}

.no-interference-select {
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 6px;
}

.no-interference-reset {
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 6px;
  cursor: pointer;
}

.no-interference-notice {
  font-size: 12px;
  margin-top: 4px;
  opacity: 0.85;
}

.popup-container {
  background: #f1f5f9;
  border-radius: 24px;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.header {
  flex-shrink: 0;
  padding-left: 20px;
  padding-right: 12px;
}

/* auto-chrome-mcp fork: 강제 포커스 토글 — iOS 스타일 슬라이딩 스위치 */
.force-focus-switch,
.force-focus-switch__wrap {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
  position: relative;
}

/* v1.0.31+: site permissions consent gate UI */
.site-perms-hint {
  font-size: 12px;
  color: #64748b;
  margin: 0 0 10px 0;
}

.site-perms-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.site-perms-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 4px;
  cursor: pointer;
}

.site-perms-row__label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #1e293b;
}

.site-perms-row__icon {
  font-size: 16px;
  line-height: 1;
}

.site-perms-row-wrap {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* v1.0.33+: 토글 + ⚙ OS deep-link 버튼을 한 줄로 정렬 */
.site-perms-row__actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.site-perms-os-btn {
  appearance: none;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 6px;
  font-size: 14px;
  line-height: 1;
  color: #64748b;
  opacity: 0.7;
  transition:
    opacity 0.15s ease,
    background 0.15s ease,
    color 0.15s ease;
}

.site-perms-os-btn:hover {
  opacity: 1;
  background: rgba(15, 23, 42, 0.06);
  color: var(--ac-accent, #d97757);
}

.site-perms-os-btn:focus-visible {
  outline: 2px solid var(--ac-accent, #d97757);
  outline-offset: 1px;
}

.site-perms-warn {
  font-size: 11px;
  color: #b45309;
  line-height: 1.45;
  margin: 0 0 4px 28px;
  word-break: keep-all;
}

.site-perms-link {
  font-family: 'Monaco', 'Menlo', monospace;
  font-size: 10.5px;
  color: #92400e;
  text-decoration: underline;
  cursor: pointer;
  word-break: break-all;
}

.site-perms-link:hover {
  color: var(--ac-accent, #d97757);
}

.force-focus-switch__label {
  font-size: 12px;
  font-weight: 500;
  color: #64748b;
  white-space: nowrap;
}

.force-focus-switch__track {
  position: relative;
  display: inline-block;
  width: 34px;
  height: 20px;
  background: #cbd5e1;
  border-radius: 999px;
  transition: background 0.18s ease;
  flex-shrink: 0;
}

.force-focus-switch__track--on {
  background: var(--ac-accent, #d97757);
}

.force-focus-switch__thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  background: #ffffff;
  border-radius: 50%;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.25);
  transition: transform 0.18s ease;
}

.force-focus-switch__track--on .force-focus-switch__thumb {
  transform: translateX(14px);
}

/* keyboard focus ring on the hidden checkbox */
.force-focus-switch__input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

.force-focus-switch__input:focus-visible ~ .force-focus-switch__track {
  outline: 2px solid var(--ac-accent, #d97757);
  outline-offset: 2px;
}

.header-content {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header-title {
  font-size: 24px;
  font-weight: 700;
  color: #1e293b;
  margin: 0;
}

.settings-button {
  padding: 8px;
  border-radius: 50%;
  color: #64748b;
  background: none;
  border: none;
  cursor: pointer;
  transition: all 0.2s ease;
}

.settings-button:hover {
  background: #e2e8f0;
  color: #1e293b;
}

.content {
  flex-grow: 1;
  padding: 8px 24px;
  overflow-y: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.content::-webkit-scrollbar {
  display: none;
}
.status-card {
  background: white;
  border-radius: 16px;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
  padding: 20px;
  margin-bottom: 20px;
}

.status-label {
  font-size: 14px;
  font-weight: 500;
  color: #64748b;
  margin-bottom: 8px;
}

.status-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-dot {
  height: 8px;
  width: 8px;
  border-radius: 50%;
}

.status-dot.bg-emerald-500 {
  background-color: #10b981;
}

.status-dot.bg-red-500 {
  background-color: #ef4444;
}

.status-dot.bg-yellow-500 {
  background-color: #eab308;
}

.status-dot.bg-gray-500 {
  background-color: #6b7280;
}

.status-text {
  font-size: 16px;
  font-weight: 600;
  color: #1e293b;
}

.model-label {
  font-size: 14px;
  font-weight: 500;
  color: #64748b;
  margin-bottom: 4px;
}

.model-name {
  font-weight: 600;
  color: #7c3aed;
}

.stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.stats-card {
  background: white;
  border-radius: 12px;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
  padding: 16px;
}

.stats-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.stats-label {
  font-size: 14px;
  font-weight: 500;
  color: #64748b;
}

.stats-icon {
  padding: 8px;
  border-radius: 8px;
}

.stats-icon.violet {
  background: #ede9fe;
  color: #7c3aed;
}

.stats-icon.teal {
  background: #ccfbf1;
  color: #0d9488;
}

.stats-icon.blue {
  background: #dbeafe;
  color: #2563eb;
}

.stats-icon.green {
  background: #dcfce7;
  color: #16a34a;
}

.stats-value {
  font-size: 30px;
  font-weight: 700;
  color: #0f172a;
  margin: 0;
}

.section {
  margin-bottom: 24px;
}

.secondary-button {
  background: #f1f5f9;
  color: #475569;
  border: 1px solid #cbd5e1;
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 8px;
}

.secondary-button:hover:not(:disabled) {
  background: #e2e8f0;
  border-color: #94a3b8;
}

.secondary-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.primary-button {
  background: #3b82f6;
  color: white;
  border: none;
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.primary-button:hover {
  background: #2563eb;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: #374151;
  margin-bottom: 12px;
}
.current-model-card {
  background: linear-gradient(135deg, #faf5ff, #f3e8ff);
  border: 1px solid #e9d5ff;
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 16px;
}

.current-model-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.current-model-label {
  font-size: 14px;
  font-weight: 500;
  color: #64748b;
  margin: 0;
}

.current-model-badge {
  background: #8b5cf6;
  color: white;
  font-size: 12px;
  font-weight: 600;
  padding: 4px 8px;
  border-radius: 6px;
}

.current-model-name {
  font-size: 16px;
  font-weight: 700;
  color: #7c3aed;
  margin: 0;
}

.model-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.model-card {
  background: white;
  border-radius: 12px;
  padding: 16px;
  cursor: pointer;
  border: 1px solid #e5e7eb;
  transition: all 0.2s ease;
}

.model-card:hover {
  border-color: #8b5cf6;
}

.model-card.selected {
  border: 2px solid #8b5cf6;
  background: #faf5ff;
}

.model-card.disabled {
  opacity: 0.5;
  cursor: not-allowed;
  pointer-events: none;
}

.model-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

.model-info {
  flex: 1;
}

.model-name {
  font-weight: 600;
  color: #1e293b;
  margin: 0 0 4px 0;
}

.model-name.selected-text {
  color: #7c3aed;
}

.model-description {
  font-size: 14px;
  color: #64748b;
  margin: 0;
}

.check-icon {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  background: #8b5cf6;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.model-tags {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
}
.model-tag {
  display: inline-flex;
  align-items: center;
  border-radius: 9999px;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 500;
}

.model-tag.performance {
  background: #d1fae5;
  color: #065f46;
}

.model-tag.size {
  background: #ddd6fe;
  color: #5b21b6;
}

.model-tag.dimension {
  background: #e5e7eb;
  color: #4b5563;
}

.config-card {
  background: var(--ac-surface, white);
  border-radius: var(--ac-radius-card, 12px);
  box-shadow: var(--ac-shadow-card, 0 1px 3px rgba(0, 0, 0, 0.08));
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.semantic-engine-card {
  background: white;
  border-radius: 16px;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.semantic-engine-status {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.semantic-engine-button {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: #8b5cf6;
  color: white;
  font-weight: 600;
  padding: 12px 16px;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  transition: all 0.2s ease;
  box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
}

.semantic-engine-button:hover:not(:disabled) {
  background: #7c3aed;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
}

.semantic-engine-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.status-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  gap: 8px;
}

/* auto-chrome-mcp fork: 강제 포커스 + 백그라운드 작업 + 전용 작업 창 토글 묶음
   (3개라 좁으면 flex-wrap 으로 줄바꿈) */
.status-switches {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.status-timestamp {
  font-size: 12px;
  color: #9ca3af;
  margin-top: 4px;
}

.mcp-config-section {
  border-top: 1px solid #f1f5f9;
}

.mcp-config-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.mcp-config-label {
  font-size: 14px;
  font-weight: 500;
  color: #64748b;
  margin: 0;
}

.copy-config-button {
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 14px;
  color: #64748b;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 4px;
}

.copy-config-button:hover {
  background: #f1f5f9;
  color: #374151;
}

.mcp-config-content {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 12px;
  overflow-x: auto;
  position: relative;
}

/* auto-chrome-mcp fork v1.0.28: 복사 버튼이 prompt 박스 우상단에 떠 있는 형태 */
.copy-config-button--floating {
  position: absolute;
  top: 6px;
  right: 6px;
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid #e2e8f0;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
  padding: 4px 10px;
  font-size: 12px;
  color: #475569;
  z-index: 2;
  backdrop-filter: blur(4px);
}

.copy-config-button--floating:hover {
  background: #ffffff;
  color: var(--ac-accent, #d97757);
  border-color: var(--ac-accent, #d97757);
}

/* auto-chrome-mcp fork v1.0.10: Claude prompt 박스 부가 hint */
.claude-prompt-hint {
  font-size: 11px;
  color: #64748b;
  margin: 2px 0 6px 0;
}

.claude-prompt-hint code {
  background: #f1f5f9;
  padding: 1px 4px;
  border-radius: 4px;
  font-family: 'Monaco', 'Menlo', monospace;
  font-size: 10px;
}

.mcp-config-json {
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 12px;
  line-height: 1.4;
  color: #374151;
  margin: 0;
  white-space: pre;
  overflow-x: auto;
}

.port-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.port-label {
  font-size: 14px;
  font-weight: 500;
  color: #64748b;
}

.port-input {
  display: block;
  width: 100%;
  border-radius: 8px;
  border: 1px solid #d1d5db;
  box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  padding: 12px;
  font-size: 14px;
  background: #f8fafc;
}

.port-input:focus {
  outline: none;
  border-color: var(--ac-accent, #d97757);
  box-shadow: 0 0 0 3px var(--ac-accent-subtle, rgba(217, 119, 87, 0.12));
}

.connect-button {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--ac-accent, #d97757);
  color: var(--ac-accent-contrast, white);
  font-weight: 600;
  padding: 12px 16px;
  border-radius: var(--ac-radius-button, 8px);
  border: none;
  cursor: pointer;
  transition: all var(--ac-motion-fast, 120ms) ease;
  box-shadow: var(--ac-shadow-card, 0 1px 3px rgba(0, 0, 0, 0.08));
}

.connect-button:hover:not(:disabled) {
  background: var(--ac-accent-hover, #c4664a);
  box-shadow: var(--ac-shadow-float, 0 4px 20px -2px rgba(0, 0, 0, 0.05));
}

.connect-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.error-card {
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 16px;
  display: flex;
  align-items: flex-start;
  gap: 16px;
}

.error-content {
  flex: 1;
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.error-icon {
  font-size: 20px;
  flex-shrink: 0;
  margin-top: 2px;
}

.error-details {
  flex: 1;
}

.error-title {
  font-size: 14px;
  font-weight: 600;
  color: #dc2626;
  margin: 0 0 4px 0;
}

.error-message {
  font-size: 14px;
  color: #991b1b;
  margin: 0 0 8px 0;
  font-weight: 500;
}

.error-suggestion {
  font-size: 13px;
  color: #7f1d1d;
  margin: 0;
  line-height: 1.4;
}

.retry-button {
  display: flex;
  align-items: center;
  gap: 6px;
  background: #dc2626;
  color: white;
  font-weight: 600;
  padding: 8px 16px;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 14px;
  flex-shrink: 0;
}

.retry-button:hover:not(:disabled) {
  background: #b91c1c;
}

.retry-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.danger-button {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: white;
  border: 1px solid #d1d5db;
  color: #374151;
  font-weight: 600;
  padding: 12px 16px;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
  margin-top: 16px;
}

.danger-button:hover:not(:disabled) {
  border-color: #ef4444;
  color: #dc2626;
}

.danger-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* Icon sizes - use :deep to apply to child components */
:deep(.icon-small) {
  width: 16px;
  height: 16px;
}

:deep(.icon-default) {
  width: 20px;
  height: 20px;
}

:deep(.icon-medium) {
  width: 24px;
  height: 24px;
}
.footer {
  padding: 16px;
  margin-top: auto;
}

.footer-links {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 16px;
  margin-bottom: 8px;
}

.footer-link {
  display: flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  color: #64748b;
  font-size: 12px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
  transition: all 0.2s ease;
}

.footer-link:hover {
  color: #8b5cf6;
  background: #e2e8f0;
}

.footer-link svg {
  width: 14px;
  height: 14px;
}

.footer-text {
  text-align: center;
  font-size: 12px;
  color: #94a3b8;
  margin: 0;
}

@media (max-width: 320px) {
  .popup-container {
    width: 100%;
    height: 100vh;
    border-radius: 0;
  }

  .footer-links {
    gap: 8px;
  }

  .rr-grid {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .rr-controls {
    display: flex;
    gap: 8px;
  }
  .rr-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .rr-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px;
    border: 1px solid #eee;
    border-radius: 6px;
  }
  .rr-runoverrides {
    margin-top: 6px;
    border: 1px dashed #e5e7eb;
    border-radius: 8px;
    padding: 8px;
    background: #f9fafb;
  }
  .rr-meta {
    display: flex;
    flex-direction: column;
  }
  .rr-name {
    font-weight: 600;
  }
  .rr-desc {
    font-size: 12px;
    color: #666;
  }
  .empty {
    color: #888;
    font-size: 13px;
  }

  .header {
    padding: 24px 20px 12px;
  }

  .content {
    padding: 8px 20px;
  }

  .stats-grid {
    grid-template-columns: 1fr;
    gap: 8px;
  }

  .config-card {
    padding: 16px;
    gap: 12px;
  }

  .current-model-card {
    padding: 12px;
    margin-bottom: 12px;
  }

  .stats-card {
    padding: 12px;
  }

  .stats-value {
    font-size: 24px;
  }
}

/* 快捷工具icon按钮样式 */
.rr-icon-buttons {
  display: flex;
  gap: 12px;
  justify-content: flex-start;
  padding: 16px;
  background: var(--ac-surface, white);
  border-radius: var(--ac-radius-card, 12px);
  box-shadow: var(--ac-shadow-card, 0 1px 3px rgba(0, 0, 0, 0.08));
}

.rr-icon-btn {
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--ac-surface-muted, #f2f0eb);
  border: none;
  border-radius: var(--ac-radius-button, 8px);
  color: var(--ac-text-muted, #6e6e6e);
  cursor: pointer;
  transition: all var(--ac-motion-fast, 120ms) ease;
}

.rr-icon-btn:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: var(--ac-shadow-float, 0 4px 20px -2px rgba(0, 0, 0, 0.05));
}

.rr-icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.rr-icon-btn svg {
  width: 24px;
  height: 24px;
}

/* 录制按钮 - 红色 */
.rr-icon-btn-record {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

.rr-icon-btn-record:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.2);
  color: #dc2626;
}

/* 录制中状态 - 脉冲动画 */
.rr-icon-btn-recording {
  animation: pulse-recording 1.5s ease-in-out infinite;
}

@keyframes pulse-recording {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4);
  }
  50% {
    box-shadow: 0 0 0 8px rgba(239, 68, 68, 0);
  }
}

/* 停止按钮 - 深红色 */
.rr-icon-btn-stop {
  background: rgba(185, 28, 28, 0.1);
  color: #b91c1c;
}

.rr-icon-btn-stop:hover:not(:disabled) {
  background: rgba(185, 28, 28, 0.2);
  color: #991b1b;
}

/* 编辑按钮 - 蓝色 */
.rr-icon-btn-edit {
  background: rgba(37, 99, 235, 0.1);
  color: #2563eb;
}

.rr-icon-btn-edit:hover:not(:disabled) {
  background: rgba(37, 99, 235, 0.2);
  color: #1d4ed8;
}

/* 标注按钮 - 绿色 */
.rr-icon-btn-marker {
  background: rgba(16, 185, 129, 0.1);
  color: #10b981;
}

.rr-icon-btn-marker:hover:not(:disabled) {
  background: rgba(16, 185, 129, 0.2);
  color: #059669;
}

/* Coming Soon 按钮样式 */
.rr-icon-btn-coming-soon {
  opacity: 0.5;
  cursor: default !important;
}

.rr-icon-btn-coming-soon:hover {
  transform: none !important;
  box-shadow: none !important;
  opacity: 0.6;
}

/* CSS Tooltip - instant display */
.has-tooltip {
  position: relative;
}

.has-tooltip::after {
  content: attr(data-tooltip);
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.3;
  white-space: nowrap;
  color: var(--ac-text-inverse, #ffffff);
  background-color: var(--ac-text, #1a1a1a);
  border-radius: var(--ac-radius-button, 8px);
  opacity: 0;
  visibility: hidden;
  transition:
    opacity 80ms ease,
    visibility 80ms ease;
  pointer-events: none;
  z-index: 100;
}

.has-tooltip::before {
  content: '';
  position: absolute;
  bottom: calc(100% + 2px);
  left: 50%;
  transform: translateX(-50%);
  border: 4px solid transparent;
  border-top-color: var(--ac-text, #1a1a1a);
  opacity: 0;
  visibility: hidden;
  transition:
    opacity 80ms ease,
    visibility 80ms ease;
  pointer-events: none;
  z-index: 100;
}

.has-tooltip:hover::after,
.has-tooltip:hover::before {
  opacity: 1;
  visibility: visible;
}

/* 首页视图 */
.home-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* 管理入口卡片样式 */
.entry-card {
  background: var(--ac-surface, white);
  border-radius: var(--ac-radius-card, 12px);
  box-shadow: var(--ac-shadow-card, 0 1px 3px rgba(0, 0, 0, 0.08));
  overflow: hidden;
}

.entry-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--ac-border, #e7e5e4);
  cursor: pointer;
  transition: all var(--ac-motion-fast, 120ms) ease;
  text-align: left;
}

.entry-item:last-child {
  border-bottom: none;
}

.entry-item:hover {
  background: var(--ac-hover-bg, #f5f5f4);
}

.entry-icon {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--ac-radius-button, 8px);
  flex-shrink: 0;
}

.entry-icon.agent {
  background: rgba(217, 119, 87, 0.12);
  color: var(--ac-accent, #d97757);
}

.entry-icon.workflow {
  background: rgba(37, 99, 235, 0.12);
  color: #2563eb;
}

.entry-icon.marker {
  background: rgba(16, 185, 129, 0.12);
  color: #10b981;
}

.entry-icon.model {
  background: rgba(139, 92, 246, 0.12);
  color: #8b5cf6;
}

.entry-content {
  flex: 1;
  min-width: 0;
}

.entry-title {
  display: block;
  font-size: 14px;
  font-weight: 600;
  color: var(--ac-text, #1a1a1a);
  line-height: 1.3;
}

.entry-desc {
  display: block;
  font-size: 12px;
  color: var(--ac-text-subtle, #a8a29e);
  line-height: 1.3;
  margin-top: 2px;
}

.entry-arrow {
  color: var(--ac-text-subtle, #a8a29e);
  flex-shrink: 0;
}

/* Coming Soon Badge */
.coming-soon-badge {
  display: inline-flex;
  align-items: center;
  margin-left: 6px;
  padding: 2px 6px;
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--ac-accent, #d97757);
  background: rgba(217, 119, 87, 0.12);
  border-radius: 4px;
  vertical-align: middle;
}

.entry-item-coming-soon {
  opacity: 0.7;
}

.entry-item-coming-soon:hover {
  opacity: 0.85;
}

/* Coming Soon Toast */
.coming-soon-toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 20px;
  background: var(--ac-text, #1a1a1a);
  color: var(--ac-text-inverse, #ffffff);
  font-size: 13px;
  font-weight: 500;
  border-radius: var(--ac-radius-card, 12px);
  box-shadow: var(--ac-shadow-float, 0 4px 20px -2px rgba(0, 0, 0, 0.15));
  z-index: 1000;
  white-space: nowrap;
}

.toast-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  color: var(--ac-accent, #d97757);
}

/* Toast transition */
.toast-enter-active,
.toast-leave-active {
  transition: all 0.25s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(12px);
}
</style>
