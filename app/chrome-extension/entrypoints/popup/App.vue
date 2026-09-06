<template>
  <div class="popup-root agent-theme" :data-agent-theme="agentTheme">
    <!-- 홈 -->
    <div v-show="currentView === 'home'" class="pv-home">
      <header class="pv-header">
        <div class="pv-header-text">
          <h1 class="ac-title pv-clip">{{ getMessage('popup_title') }}</h1>
          <p class="ac-caption">{{ getMessage('nativeServerConfigLabel') }}</p>
        </div>
        <button
          type="button"
          class="ac-button ac-button--ghost ac-button--sm"
          @click="openDailySidepanel"
        >
          {{ getMessage('sidepanel_daily_tab_title') }}
        </button>
      </header>

      <div class="pv-scroll">
        <!-- 연결 상태 -->
        <section class="ac-card pv-card">
          <div class="pv-status">
            <span :class="['pv-dot', getStatusClass()]" aria-hidden="true"></span>
            <div class="pv-status-text">
              <p class="ac-heading pv-clip">{{ getStatusText() }}</p>
              <p class="ac-caption pv-clip">{{ connectionMeta }}</p>
            </div>
          </div>
          <div class="pv-port-row">
            <label class="pv-sr-only" for="port">{{ getMessage('connectionPortLabel') }}</label>
            <input
              id="port"
              type="text"
              inputmode="numeric"
              class="ac-field pv-port-input"
              :value="nativeServerPort"
              @input="updatePort"
            />
            <button
              type="button"
              class="ac-button ac-button--primary"
              :disabled="isConnecting"
              @click="testNativeConnection"
            >
              <BoltIcon />
              <span>{{ connectButtonText }}</span>
            </button>
          </div>
        </section>

        <!-- Claude Code 자동 등록 prompt. 기본은 접힌 상태로 두고 복사만 노출한다. -->
        <section v-if="showMcpConfig" class="ac-card pv-card">
          <div class="pv-card-head">
            <h2 class="ac-heading">{{ getMessage('popup_prompt_title') }}</h2>
            <p class="ac-caption">{{ getMessage('popup_prompt_hint') }}</p>
          </div>
          <div class="pv-row">
            <button
              type="button"
              class="ac-button ac-button--primary pv-grow"
              @click="copyClaudePrompt"
            >
              {{ claudePromptCopyText }}
            </button>
            <button
              type="button"
              class="ac-button ac-button--quiet"
              :aria-expanded="showPromptText"
              @click="showPromptText = !showPromptText"
            >
              {{
                showPromptText ? getMessage('popup_prompt_hide') : getMessage('popup_prompt_show')
              }}
            </button>
          </div>
          <pre v-if="showPromptText" class="pv-prompt">{{ claudePromptText }}</pre>
        </section>

        <!-- 동작 설정: 토글 한 줄에 하나 -->
        <section class="ac-card pv-card">
          <h2 class="ac-heading">{{ getMessage('popup_settings_title') }}</h2>

          <div class="pv-rows">
            <label class="pv-toggle-row">
              <span class="pv-toggle-text">
                <span class="ac-body">{{ getMessage('popup_toggle_force_focus_label') }}</span>
                <span class="ac-caption">{{ getMessage('popup_toggle_force_focus_desc') }}</span>
              </span>
              <span class="ac-switch">
                <input
                  type="checkbox"
                  :checked="forceFocusEnabled"
                  :aria-label="getMessage('popup_toggle_force_focus_label')"
                  @change="toggleForceFocus"
                />
                <span class="ac-switch-track"></span>
              </span>
            </label>

            <label class="pv-toggle-row">
              <span class="pv-toggle-text">
                <span class="ac-body">{{ getMessage('popup_toggle_background_label') }}</span>
                <span class="ac-caption">{{ getMessage('popup_toggle_background_desc') }}</span>
              </span>
              <span class="ac-switch">
                <input
                  type="checkbox"
                  :checked="backgroundModeEnabled"
                  :aria-label="getMessage('popup_toggle_background_label')"
                  @change="toggleBackgroundMode"
                />
                <span class="ac-switch-track"></span>
              </span>
            </label>

            <label class="pv-toggle-row">
              <span class="pv-toggle-text">
                <span class="ac-body">{{ getMessage('popup_toggle_dedicated_label') }}</span>
                <span class="ac-caption">{{ getMessage('popup_toggle_dedicated_desc') }}</span>
              </span>
              <span class="ac-switch">
                <input
                  type="checkbox"
                  :checked="dedicatedWindowEnabled"
                  :aria-label="getMessage('popup_toggle_dedicated_label')"
                  @change="toggleDedicatedWindow"
                />
                <span class="ac-switch-track"></span>
              </span>
            </label>

            <label class="pv-toggle-row">
              <span class="pv-toggle-text">
                <span class="ac-body">{{ getMessage('popup_toggle_tabgroup_label') }}</span>
                <span class="ac-caption">{{ getMessage('popup_toggle_tabgroup_desc') }}</span>
              </span>
              <span class="ac-switch">
                <input
                  type="checkbox"
                  :checked="tabGroupEnabled"
                  :aria-label="getMessage('popup_toggle_tabgroup_label')"
                  @change="toggleTabGroup"
                />
                <span class="ac-switch-track"></span>
              </span>
            </label>
          </div>

          <div class="pv-field-block">
            <label class="pv-field-label" for="work-window-placement">
              <span class="ac-body">{{ getMessage('popup_placement_label') }}</span>
              <span class="ac-caption">{{ getMessage('popup_placement_desc') }}</span>
            </label>
            <select
              id="work-window-placement"
              class="ac-field"
              :value="workWindowPlacement"
              :disabled="!dedicatedWindowEnabled"
              @change="onPlacementChange"
            >
              <option value="minimized">{{ getMessage('popup_placement_minimized') }}</option>
              <option value="offscreen">{{ getMessage('popup_placement_offscreen') }}</option>
              <option value="visible">{{ getMessage('popup_placement_visible') }}</option>
            </select>
          </div>

          <button
            type="button"
            class="ac-button ac-button--quiet pv-reset"
            :title="getMessage('popup_reset_defaults_hint')"
            @click="applyNoInterferenceDefaults"
          >
            {{ getMessage('popup_reset_defaults') }}
          </button>
          <p v-if="noInterferenceNotice" class="ac-caption pv-notice" role="status">
            {{ noInterferenceNotice }}
          </p>
        </section>

        <!-- 사이트 권한 consent gate -->
        <section class="ac-card pv-card">
          <div class="pv-card-head">
            <h2 class="ac-heading">{{ getMessage('popup_perms_title') }}</h2>
            <p class="ac-caption">{{ getMessage('popup_perms_hint') }}</p>
          </div>
          <div class="pv-rows">
            <div v-for="item in SITE_PERMISSION_ITEMS" :key="item.key" class="pv-perm-row">
              <span class="ac-body pv-clip pv-grow">{{ item.label }}</span>
              <button
                type="button"
                class="ac-icon-button"
                :title="getMessage('popup_perm_os_open', [item.label])"
                :aria-label="getMessage('popup_perm_os_open', [item.label])"
                @click="openOSPermission(item.key)"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <circle cx="8" cy="8" r="2.4" stroke="currentColor" stroke-width="1.5" />
                  <path
                    d="M8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3M12.6 12.6l-1.3-1.3M4.7 4.7L3.4 3.4"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                  />
                </svg>
              </button>
              <label class="ac-switch">
                <input
                  type="checkbox"
                  :checked="sitePermissionToggles[item.key]"
                  :aria-label="item.label"
                  @change="toggleSitePermission(item.key)"
                />
                <span class="ac-switch-track"></span>
              </label>
            </div>
          </div>
        </section>

        <!-- 복구와 진단 -->
        <section class="ac-card pv-card">
          <h2 class="ac-heading">{{ getMessage('popup_tools_title') }}</h2>
          <div class="pv-row">
            <button
              type="button"
              class="ac-button pv-grow"
              :class="showReconnect ? 'ac-button--quiet' : 'ac-button--ghost'"
              :aria-expanded="showReconnect"
              @click="showReconnect = !showReconnect"
            >
              {{ getMessage('popup_fr_button') }}
            </button>
            <button
              type="button"
              class="ac-button pv-grow"
              :class="showDiagnostic ? 'ac-button--quiet' : 'ac-button--ghost'"
              :aria-expanded="showDiagnostic"
              @click="showDiagnostic = !showDiagnostic"
            >
              {{ getMessage('popup_diag_button') }}
            </button>
          </div>

          <button
            type="button"
            class="ac-button ac-button--ghost pv-reset"
            @click="currentView = 'local-model'"
          >
            {{ getMessage('popup_local_model_button') }}
          </button>

          <ForceReconnect
            :port="Number(nativeServerPort) || 12320"
            :open="showReconnect"
            @reconnected="handleReconnected"
          />

          <DiagnosticReport :port="Number(nativeServerPort) || 12320" :open="showDiagnostic" />
        </section>
      </div>
    </div>

    <!-- 로컬 모델 2차 화면 -->
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
      :confirm-text="getMessage('confirmClearButton')"
      :cancel-text="getMessage('cancelButton')"
      :confirming-text="getMessage('clearingStatus')"
      :is-confirming="isClearingData"
      @confirm="confirmClearAllData"
      @cancel="hideClearDataConfirmation"
    />
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
import LocalModelPage from './components/LocalModelPage.vue';
import ForceReconnect from './components/ForceReconnect.vue';
import DiagnosticReport from './components/DiagnosticReport.vue';
// 홈 화면이 직접 쓰는 아이콘은 연결 버튼의 번개 하나뿐이다. 나머지 아이콘은
// 2차 화면(LocalModelPage)이 자기 파일에서 따로 불러 쓴다.
import { BoltIcon } from './components/icons';

// AgentChat theme - 从preload中获取，保持与sidepanel一致
const { theme: agentTheme, initTheme } = useAgentTheme();

// 当前视图状态：首页 or 本地模型页
const currentView = ref<'home' | 'local-model'>('home');

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
}> = [
  { key: 'camera', label: getMessage('popup_perm_camera') },
  { key: 'microphone', label: getMessage('popup_perm_microphone') },
  { key: 'geolocation', label: getMessage('popup_perm_geolocation') },
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

// auto-chrome-mcp fork v1.0.10: Claude Code 자동 등록 prompt. 사용자가 npm root -g 출력값을
// 직접 채우기 귀찮으니 prompt 한 번 복사해서 터미널의 claude 에 붙여넣게 한다.
// 본문은 i18n 키 popup_prompt_body 에 있고 포트만 치환한다.
const claudePromptText = computed(() => {
  const port = serverStatus.value.port || nativeServerPort.value;
  return getMessage('popup_prompt_body', [String(port)]);
});

// 큰 코드 블록은 기본으로 접어 둔다. 복사만 하고 지나가는 사람이 대부분이다.
const showPromptText = ref(false);

const claudePromptCopyText = ref(getMessage('popup_prompt_copy'));
const copyClaudePrompt = async (): Promise<void> => {
  try {
    await navigator.clipboard.writeText(claudePromptText.value);
    claudePromptCopyText.value = getMessage('popup_prompt_copied');
    setTimeout(() => {
      claudePromptCopyText.value = getMessage('popup_prompt_copy');
    }, 2000);
  } catch (e) {
    console.error('Failed to copy claude prompt:', e);
  }
};

// 복구·진단 패널은 각각 보조 버튼으로 열고 닫는다.
const showReconnect = ref(false);
const showDiagnostic = ref(false);

/** 연결 카드의 캡션. 포트와 마지막 확인 시각을 한 줄로 보여 준다. */
const connectionMeta = computed(() => {
  const port = String(serverStatus.value.port || nativeServerPort.value);
  if (!serverStatus.value.lastUpdated) return getMessage('popup_conn_meta_port', [port]);
  const time = new Date(serverStatus.value.lastUpdated).toLocaleTimeString();
  return getMessage('popup_conn_meta', [port, time]);
});

/** 연결 버튼 문구. 상태에 따라 연결·해제·연결 중이 바뀐다. */
const connectButtonText = computed(() => {
  if (isConnecting.value) return getMessage('connectingStatus');
  return nativeConnectionStatus.value === 'connected'
    ? getMessage('disconnectButton')
    : getMessage('connectButton');
});

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
async function openSidepanelAndClose(tab: string, extra?: Record<string, string>) {
  try {
    const current = await chrome.windows.getCurrent();
    const params = new URLSearchParams({ tab, ...(extra || {}) });
    if ((chrome.sidePanel as any)?.setOptions) {
      await (chrome.sidePanel as any).setOptions({
        path: `sidepanel.html?${params.toString()}`,
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

/** 사이드패널의 매일 작업 탭 (2026-09-05 사이드패널 2단계 E). */
function openDailySidepanel() {
  void openSidepanelAndClose('daily');
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
    semanticEngineInitProgress.value = getMessage('popup_semantic_engine_init_failed', [
      String(error?.message || getMessage('popup_unknown_error')),
    ]);

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

  // 1) popup status 직접 강제 갱신. 5단계 success 한 시점에 이미 실제 연결됨.
  nativeConnectionStatus.value = 'connected';
  serverStatus.value = {
    ...serverStatus.value,
    isRunning: true,
    port: Number(nativeServerPort.value) || 12320,
    lastUpdated: Date.now(),
  };

  // 2) background 도 sync. connectNative 트리거 + 자체 polling 으로 stale 정리
  try {
    await chrome.runtime.sendMessage({ type: 'connectNative' });
  } catch {
    // silent
  }
  // 3) background polling 도 한 번 호출 (없으면 다음 popup open 시 갱신)
  await Promise.all([checkNativeConnection(), checkServerStatus()]).catch(() => {});

  // 4) 강제 set 한 값이 background polling 에 잠시 후 덮어쓰이면 1초 뒤 한 번 더 강제한다
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

// auto-chrome-mcp fork: 강제포커스 토글의 load + toggle handler.
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

// auto-chrome-mcp fork: 백그라운드 작업 모드 토글의 load + toggle handler.
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

// auto-chrome-mcp fork: 전용 작업 창 토글의 load + toggle handler.
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

// auto-chrome-mcp fork: MCP 작업 탭 그룹 토글의 load + toggle handler.
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

// auto-chrome-mcp fork v1.9.0: 전용 작업 창 배치의 load + change handler.
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
    noInterferenceNotice.value = getMessage('popup_reset_done');
  } catch (error) {
    console.error('무간섭 권장 설정 적용 실패:', error);
    noInterferenceNotice.value = getMessage('popup_reset_failed');
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
      alert(getMessage('popup_perm_os_unsupported', [info.os, label]));
    }
  } catch (e) {
    console.error('openOSPermission 실패:', e);
    alert(getMessage('popup_perm_os_failed', [label]));
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
      throw new Error(response?.error || getMessage('popup_clear_data_generic_error'));
    }
  } catch (error: any) {
    console.error('❌ Failed to clear all data:', error);
    clearDataProgress.value = getMessage('popup_clear_data_failed', [
      String(error?.message || getMessage('popup_unknown_error')),
    ]);

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
      throw new Error(response?.error || getMessage('popup_model_switch_generic_error'));
    }
  } catch (error: any) {
    console.error('模型切换失败:', error);
    modelSwitchProgress.value = getMessage('popup_model_switch_failed', [
      String(error?.message || getMessage('popup_unknown_error')),
    ]);

    modelInitializationStatus.value = 'error';
    isModelDownloading.value = false;

    const errorMessage = error?.message || getMessage('unknownErrorMessage');
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
      // 노란색 깜빡임을 막는다. 강제 takeover 면 곧장 빨간색 'disconnected' 로 간다.
      if (message.payload.nativeConnected === false) {
        nativeConnectionStatus.value = 'disconnected';
      } else if (message.payload.nativeConnected === true) {
        nativeConnectionStatus.value = 'connected';
      }
      console.log('Server status updated:', message.payload);
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

  await checkSemanticEngineStatus();
  setupServerStatusListener();
  try {
    const onChanged = (changes: any, area: string) => {
      try {
        if (area !== 'local') return;
        // auto-chrome-mcp fork: 다른 popup/탭이 force-focus 토글 바꿔도 즉시 반영.
        if (Object.prototype.hasOwnProperty.call(changes || {}, FORCE_FOCUS_STORAGE_KEY)) {
          forceFocusEnabled.value = changes[FORCE_FOCUS_STORAGE_KEY]?.newValue === true;
        }
        // auto-chrome-mcp fork: 백그라운드 작업 모드도 동일하게 동기화 (기본값 true, false 만 OFF).
        if (Object.prototype.hasOwnProperty.call(changes || {}, BACKGROUND_MODE_STORAGE_KEY)) {
          backgroundModeEnabled.value = changes[BACKGROUND_MODE_STORAGE_KEY]?.newValue !== false;
        }
        // auto-chrome-mcp fork: 작업 창 모드도 동일하게 동기화 (기본값 'current', 'dedicated' 만 ON).
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
        // auto-chrome-mcp fork: MCP 작업 탭 그룹 토글 (기본값 true, false 만 OFF).
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
/*
 * 팝업 레이아웃만 여기에 둔다. 색·글꼴·모서리·버튼·입력·스위치는 전부
 * `ui/theme.css` 의 `.ac-*` 프리미티브가 그린다. 이 파일에 색을 직접 쓰지 않는다.
 */

.popup-root {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.pv-home {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

/* 헤더 한 줄: 제목·캡션 왼쪽, 매일 작업 버튼 오른쪽 */
.pv-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-shrink: 0;
  padding: 16px 16px 12px;
}

.pv-header-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.pv-scroll {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 16px 24px;
}

.pv-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
}

.pv-card-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.pv-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pv-rows {
  display: flex;
  flex-direction: column;
}

.pv-grow {
  flex: 1;
  min-width: 0;
}

.pv-clip {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* 연결 상태 */
.pv-status {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.pv-status-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.pv-dot {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border-radius: var(--ac-radius-pill);
  background-color: var(--ac-text-tertiary);
}

/*
 * 상태 점의 색. 클래스 이름은 `getStatusClass()` 가 그대로 돌려주는 값이라
 * 건드리지 않고, 색만 토큰으로 바꿔 받는다.
 */
.pv-dot.bg-emerald-500 {
  background-color: var(--ac-success);
}

.pv-dot.bg-yellow-500 {
  background-color: var(--ac-warning);
}

.pv-dot.bg-red-500 {
  background-color: var(--ac-danger);
}

.pv-dot.bg-gray-500 {
  background-color: var(--ac-text-tertiary);
}

.pv-port-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pv-port-input {
  flex: 1;
  min-width: 0;
  font-variant-numeric: tabular-nums;
}

.pv-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* Claude Code 등록 prompt */
.pv-prompt {
  max-height: 160px;
  margin: 0;
  padding: 12px;
  overflow: auto;
  border-radius: var(--ac-radius);
  background-color: var(--ac-surface-muted);
  color: var(--ac-text-secondary);
  font-family: var(--ac-font-mono);
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 설정 토글: 한 줄에 하나, 행 높이 48 */
.pv-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 48px;
  padding: 6px 0;
  cursor: pointer;
}

.pv-toggle-row + .pv-toggle-row {
  box-shadow: inset 0 0.75px 0 0 var(--ac-divider);
}

.pv-toggle-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.pv-field-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pv-field-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.pv-reset {
  align-self: flex-start;
}

.pv-notice {
  margin: 0;
}

/* 권한 행 */
.pv-perm-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
}

.pv-perm-row + .pv-perm-row {
  box-shadow: inset 0 0.75px 0 0 var(--ac-divider);
}

/*
 * 아이콘 컴포넌트는 viewBox 만 갖고 있어 크기를 여기서 정한다.
 * 버튼 안 20, 행 안 16 (가독성 규칙의 아이콘 크기).
 */
.ac-button svg {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}

.ac-icon-button svg {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
</style>
