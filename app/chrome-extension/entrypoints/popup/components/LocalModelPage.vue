<template>
  <div class="lm-page">
    <header class="lm-header">
      <button
        type="button"
        class="ac-button ac-button--quiet ac-button--sm"
        :title="getMessage('backToHomeTooltip')"
        @click="$emit('back')"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        <span>{{ getMessage('backButton') }}</span>
      </button>
      <h1 class="ac-title">{{ getMessage('localModelPageTitle') }}</h1>
    </header>

    <div class="lm-scroll">
      <!-- 의미 검색 엔진 -->
      <section class="ac-card lm-card">
        <h2 class="ac-heading">{{ getMessage('semanticEngineLabel') }}</h2>

        <div class="lm-status">
          <span :class="['lm-dot', getSemanticEngineStatusClass()]" aria-hidden="true"></span>
          <div class="lm-status-text">
            <p class="ac-body">{{ getSemanticEngineStatusText() }}</p>
            <p v-if="semanticEngineLastUpdated" class="ac-caption">
              {{ getMessage('lastUpdatedLabel') }}
              {{ new Date(semanticEngineLastUpdated).toLocaleTimeString() }}
            </p>
          </div>
        </div>

        <ProgressIndicator
          v-if="isSemanticEngineInitializing"
          :visible="isSemanticEngineInitializing"
          :text="semanticEngineInitProgress"
          :showSpinner="true"
        />

        <button
          type="button"
          class="ac-button ac-button--primary lm-full"
          :disabled="isSemanticEngineInitializing"
          @click="$emit('initializeSemanticEngine')"
        >
          <BoltIcon />
          <span>{{ getSemanticEngineButtonText() }}</span>
        </button>
      </section>

      <!-- 임베딩 모델 -->
      <section class="ac-card lm-card">
        <h2 class="ac-heading">{{ getMessage('embeddingModelLabel') }}</h2>

        <ProgressIndicator
          v-if="isModelSwitching || isModelDownloading"
          :visible="isModelSwitching || isModelDownloading"
          :text="progressText"
          :showSpinner="true"
        />

        <div v-if="modelInitializationStatus === 'error'" class="lm-error">
          <p class="ac-body ac-text-danger">{{ getMessage('semanticEngineInitFailedStatus') }}</p>
          <p class="ac-sub">
            {{ modelErrorMessage || getMessage('semanticEngineInitFailedStatus') }}
          </p>
          <p class="ac-caption">{{ errorTypeText }}</p>
          <button
            type="button"
            class="ac-button ac-button--ghost ac-button--sm"
            :disabled="isModelSwitching || isModelDownloading"
            @click="$emit('retryModelInitialization')"
          >
            {{ getMessage('retryButton') }}
          </button>
        </div>

        <div class="lm-models">
          <button
            v-for="model in availableModels"
            :key="model.preset"
            type="button"
            class="lm-model"
            :class="{ 'lm-model--on': currentModel === model.preset }"
            :disabled="isModelSwitching || isModelDownloading"
            @click="$emit('switchModel', model.preset)"
          >
            <span class="lm-model-head">
              <span class="ac-body ac-clip">{{ model.preset }}</span>
              <CheckIcon v-if="currentModel === model.preset" class="lm-check" />
            </span>
            <span class="ac-caption lm-model-desc">{{ getModelDescription(model) }}</span>
            <span class="lm-tags">
              <span class="ac-badge">{{ getPerformanceText(model.performance) }}</span>
              <span class="ac-badge">{{ model.size }}</span>
              <span class="ac-badge ac-num">{{ model.dimension }}D</span>
            </span>
          </button>
        </div>
      </section>

      <!-- 색인 데이터 -->
      <section class="ac-card lm-card">
        <h2 class="ac-heading">{{ getMessage('indexDataManagementLabel') }}</h2>

        <div class="lm-stats">
          <div class="lm-stat">
            <p class="ac-caption">{{ getMessage('indexedPagesLabel') }}</p>
            <p class="ac-heading ac-num">{{ storageStats?.indexedPages || 0 }}</p>
          </div>
          <div class="lm-stat">
            <p class="ac-caption">{{ getMessage('indexSizeLabel') }}</p>
            <p class="ac-heading ac-num">{{ formatIndexSize() }}</p>
          </div>
          <div class="lm-stat">
            <p class="ac-caption">{{ getMessage('activeTabsLabel') }}</p>
            <p class="ac-heading ac-num">{{ storageStats?.totalTabs || 0 }}</p>
          </div>
          <div class="lm-stat">
            <p class="ac-caption">{{ getMessage('vectorDocumentsLabel') }}</p>
            <p class="ac-heading ac-num">{{ storageStats?.totalDocuments || 0 }}</p>
          </div>
        </div>

        <ProgressIndicator
          v-if="isClearingData && clearDataProgress"
          :visible="isClearingData"
          :text="clearDataProgress"
          :showSpinner="true"
        />

        <button
          type="button"
          class="ac-button ac-button--danger lm-full"
          :disabled="isClearingData"
          @click="$emit('showClearConfirmation')"
        >
          <TrashIcon />
          <span>{{
            isClearingData ? getMessage('clearingStatus') : getMessage('clearAllDataButton')
          }}</span>
        </button>
      </section>

      <!-- 모델 캐시 -->
      <ModelCacheManagement
        :cache-stats="cacheStats"
        :is-managing-cache="isManagingCache"
        @cleanup-cache="$emit('cleanupCache')"
        @clear-all-cache="$emit('clearAllCache')"
      />
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import { getMessage } from '@/utils/i18n';
import ProgressIndicator from './ProgressIndicator.vue';
import ModelCacheManagement from './ModelCacheManagement.vue';
import { BoltIcon, TrashIcon, CheckIcon } from './icons';

interface Props {
  // 语义引擎
  semanticEngineStatus: 'idle' | 'initializing' | 'ready' | 'error';
  isSemanticEngineInitializing: boolean;
  semanticEngineInitProgress: string;
  semanticEngineLastUpdated: number | null;
  // 模型
  availableModels: Array<{
    preset: string;
    performance: string;
    size: string;
    dimension: number;
  }>;
  currentModel: string | null;
  isModelSwitching: boolean;
  isModelDownloading: boolean;
  modelDownloadProgress: number;
  modelInitializationStatus: string;
  modelErrorMessage: string;
  modelErrorType: string;
  // 存储统计
  storageStats: {
    indexedPages: number;
    totalDocuments: number;
    totalTabs: number;
    indexSize: number;
    isInitialized: boolean;
  } | null;
  isClearingData: boolean;
  clearDataProgress: string;
  // 缓存
  cacheStats: any;
  isManagingCache: boolean;
}

const props = defineProps<Props>();

defineEmits<{
  (e: 'back'): void;
  (e: 'initializeSemanticEngine'): void;
  (e: 'switchModel', preset: string): void;
  (e: 'retryModelInitialization'): void;
  (e: 'showClearConfirmation'): void;
  (e: 'cleanupCache'): void;
  (e: 'clearAllCache'): void;
}>();

// 计算属性
const getSemanticEngineStatusClass = () => {
  switch (props.semanticEngineStatus) {
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

const getSemanticEngineStatusText = () => {
  switch (props.semanticEngineStatus) {
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

const getSemanticEngineButtonText = () => {
  switch (props.semanticEngineStatus) {
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

const progressText = computed(() => {
  if (props.isModelDownloading) {
    return getMessage('downloadingModelStatus', [props.modelDownloadProgress.toString()]);
  } else if (props.isModelSwitching) {
    return getMessage('switchingModelStatus');
  }
  return '';
});

const errorTypeText = computed(() => {
  switch (props.modelErrorType) {
    case 'network':
      return getMessage('networkErrorMessage');
    case 'file':
      return getMessage('modelCorruptedErrorMessage');
    case 'unknown':
    default:
      return getMessage('unknownErrorMessage');
  }
});

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

const formatIndexSize = () => {
  if (!props.storageStats?.indexSize) return '0 MB';
  const sizeInMB = Math.round(props.storageStats.indexSize / (1024 * 1024));
  return `${sizeInMB} MB`;
};
</script>

<style scoped>
/* 레이아웃만. 색·글꼴·버튼 모양은 ui/theme.css 의 .ac-* 가 그린다. */
.lm-page {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
}

.lm-header {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  flex-shrink: 0;
  padding: 16px 16px 12px;
}

.lm-scroll {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 16px 24px;
}

.lm-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
}

.lm-full {
  width: 100%;
}

.lm-status {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.lm-status-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.lm-dot {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border-radius: var(--ac-radius-pill);
  background-color: var(--ac-text-tertiary);
}

/* 상태 점의 색. 클래스 이름은 스크립트가 돌려주는 값을 그대로 쓴다. */
.lm-dot.bg-emerald-500 {
  background-color: var(--ac-success);
}

.lm-dot.bg-yellow-500 {
  background-color: var(--ac-warning);
}

.lm-dot.bg-red-500 {
  background-color: var(--ac-danger);
}

.lm-dot.bg-gray-500 {
  background-color: var(--ac-text-tertiary);
}

.lm-error {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 12px;
  border-radius: var(--ac-radius);
  background-color: var(--ac-danger-soft);
}

.lm-models {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.lm-model {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  text-align: left;
  border: none;
  border-radius: var(--ac-radius);
  background-color: var(--ac-surface-muted);
  cursor: pointer;
  transition: background-color var(--ac-motion-fast) ease;
}

.lm-model:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.lm-model:focus-visible {
  outline: 2px solid var(--ac-focus-ring);
  outline-offset: 2px;
}

@media (hover: hover) and (pointer: fine) {
  .lm-model:hover:not(:disabled) {
    background-color: var(--ac-surface-hover);
  }
}

.lm-model--on,
.lm-model--on:hover {
  background-color: var(--ac-accent-soft);
}

.lm-model-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.lm-check {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--ac-accent-text);
}

.lm-model-desc {
  display: block;
}

.lm-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.lm-stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.lm-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px;
  border-radius: var(--ac-radius);
  background-color: var(--ac-surface-muted);
}

/* 아이콘 컴포넌트는 viewBox 만 갖고 있어 크기를 여기서 정한다. */
.ac-button svg {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}
</style>
