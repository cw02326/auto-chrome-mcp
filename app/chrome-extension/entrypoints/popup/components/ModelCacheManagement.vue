<template>
  <section class="ac-card mc-card">
    <h2 class="ac-heading">{{ getMessage('modelCacheManagementLabel') }}</h2>

    <!-- 캐시 통계 -->
    <div class="mc-stats">
      <div class="mc-stat">
        <p class="ac-caption">{{ getMessage('cacheSizeLabel') }}</p>
        <p class="ac-heading ac-num">{{ cacheStats?.totalSizeMB || 0 }} MB</p>
      </div>
      <div class="mc-stat">
        <p class="ac-caption">{{ getMessage('cacheEntriesLabel') }}</p>
        <p class="ac-heading ac-num">{{ cacheStats?.entryCount || 0 }}</p>
      </div>
    </div>

    <!-- 캐시 항목 -->
    <div v-if="cacheStats && cacheStats.entries.length > 0" class="mc-details">
      <h3 class="mc-section-title">{{ getMessage('cacheDetailsLabel') }}</h3>
      <div class="mc-entries">
        <div v-for="entry in cacheStats.entries" :key="entry.url" class="mc-entry">
          <span class="ac-body ac-clip" :title="entry.url">{{
            getModelNameFromUrl(entry.url)
          }}</span>
          <span class="ac-caption ac-num">{{ entry.sizeMB }} MB</span>
          <span class="ac-caption">{{ entry.age }}</span>
          <span v-if="entry.expired" class="ac-badge ac-badge--warning">{{
            getMessage('expiredLabel')
          }}</span>
        </div>
      </div>
    </div>

    <p v-else-if="cacheStats && cacheStats.entries.length === 0" class="ac-sub">
      {{ getMessage('noCacheDataMessage') }}
    </p>

    <p v-else-if="!cacheStats" class="ac-sub">{{ getMessage('loadingCacheInfoStatus') }}</p>

    <ProgressIndicator
      v-if="isManagingCache"
      :visible="isManagingCache"
      :text="isManagingCache ? getMessage('processingCacheStatus') : ''"
      :showSpinner="true"
    />

    <div class="mc-actions">
      <button
        type="button"
        class="ac-button ac-button--ghost mc-grow"
        :disabled="isManagingCache"
        @click="$emit('cleanup-cache')"
      >
        {{ isManagingCache ? getMessage('cleaningStatus') : getMessage('cleanExpiredCacheButton') }}
      </button>

      <button
        type="button"
        class="ac-button ac-button--danger mc-grow"
        :disabled="isManagingCache"
        @click="$emit('clear-all-cache')"
      >
        {{ isManagingCache ? getMessage('clearingStatus') : getMessage('clearAllCacheButton') }}
      </button>
    </div>
  </section>
</template>

<script lang="ts" setup>
import ProgressIndicator from './ProgressIndicator.vue';
import { getMessage } from '@/utils/i18n';

interface CacheEntry {
  url: string;
  size: number;
  sizeMB: number;
  timestamp: number;
  age: string;
  expired: boolean;
}

interface CacheStats {
  totalSize: number;
  totalSizeMB: number;
  entryCount: number;
  entries: CacheEntry[];
}

interface Props {
  cacheStats: CacheStats | null;
  isManagingCache: boolean;
}

interface Emits {
  (e: 'cleanup-cache'): void;
  (e: 'clear-all-cache'): void;
}

defineProps<Props>();
defineEmits<Emits>();

const getModelNameFromUrl = (url: string) => {
  // Extract model name from HuggingFace URL
  const match = url.match(/huggingface\.co\/([^/]+\/[^/]+)/);
  if (match) {
    return match[1];
  }
  return url.split('/').pop() || url;
};
</script>

<style scoped>
/* 레이아웃만. 색·글꼴은 ui/theme.css 의 .ac-* 가 그린다. */
.mc-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
}

.mc-stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.mc-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px;
  border-radius: var(--ac-radius);
  background-color: var(--ac-surface-muted);
}

.mc-details {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* 섹션 라벨 */
.mc-section-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
  color: var(--ac-text-secondary);
}

.mc-entries {
  display: flex;
  flex-direction: column;
  max-height: 200px;
  overflow-y: auto;
}

.mc-entry {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 0 4px;
}

.mc-entry + .mc-entry {
  box-shadow: inset 0 0.75px 0 0 var(--ac-divider);
}

.mc-entry .ac-clip {
  flex: 1;
}

.mc-actions {
  display: flex;
  gap: 8px;
}

.mc-grow {
  flex: 1;
  min-width: 0;
}
</style>
