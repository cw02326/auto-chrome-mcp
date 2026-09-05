<template>
  <!--
    상단 고정 탭 바 (2026-09-06 토스 스타일 개편).

    예전에는 화면 위를 떠다니는 햄버거 버튼이 오버레이 메뉴를 열었다. 좁은 패널에서 그
    버튼이 내용 위를 가렸고, 지금 어느 화면인지도 열어 봐야 알 수 있었다. 세 화면뿐이라
    탭 세 개를 늘 보이게 두는 편이 짧다. 드래그 이동·더블클릭 초기화는 함께 없앴다.
  -->
  <nav class="sp-tabs" role="tablist">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      :ref="(el) => setTabRef(tab.id, el)"
      :id="`sp-tab-${tab.id}`"
      class="sp-tab"
      :class="{ 'sp-tab-active': activeTab === tab.id }"
      type="button"
      role="tab"
      :aria-selected="activeTab === tab.id"
      :aria-controls="`sp-panel-${tab.id}`"
      :tabindex="activeTab === tab.id ? 0 : -1"
      @click="selectTab(tab.id)"
      @keydown="onKeydown($event, tab.id)"
    >
      <span class="sp-tab-text">{{ tab.text }}</span>
    </button>
  </nav>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import { getMessage } from '@/utils/i18n';

type TabType = 'workflows' | 'daily' | 'element-markers';

defineProps<{
  activeTab: TabType;
}>();

const emit = defineEmits<{
  (e: 'change', tab: TabType): void;
}>();

/** 탭 세 개. 문구 키는 예전 메뉴가 쓰던 것을 그대로 쓴다. */
const tabs = computed<Array<{ id: TabType; text: string }>>(() => [
  { id: 'workflows', text: getMessage('sidepanel_nav_workflows_title') },
  { id: 'daily', text: getMessage('sidepanel_daily_tab_title') },
  { id: 'element-markers', text: getMessage('sidepanel_nav_markers_title') },
]);

function selectTab(tab: TabType) {
  emit('change', tab);
}

/** v-for 항목별 DOM ref. roving tabindex 이동 시 실제 버튼에 포커스를 옮기는 데 쓴다. */
const tabRefs = new Map<TabType, HTMLButtonElement>();

function setTabRef(id: TabType, el: Element | null) {
  if (el) {
    tabRefs.set(id, el as HTMLButtonElement);
  } else {
    tabRefs.delete(id);
  }
}

function focusTab(id: TabType) {
  tabRefs.get(id)?.focus();
}

/**
 * 화살표/Home/End 키로 탭 사이를 이동한다. 탭이 곧 패널이라 별도의 "활성화" 단계 없이
 * 포커스 이동과 동시에 선택도 바뀐다(클릭과 동일한 동작). 스크롤 등 기본 동작은 막는다.
 */
function onKeydown(event: KeyboardEvent, currentId: TabType) {
  const list = tabs.value;
  const index = list.findIndex((tab) => tab.id === currentId);
  if (index === -1) return;

  let targetIndex: number;
  switch (event.key) {
    case 'ArrowRight':
      targetIndex = (index + 1) % list.length;
      break;
    case 'ArrowLeft':
      targetIndex = (index - 1 + list.length) % list.length;
      break;
    case 'Home':
      targetIndex = 0;
      break;
    case 'End':
      targetIndex = list.length - 1;
      break;
    default:
      return;
  }

  event.preventDefault();
  const targetTab = list[targetIndex];
  selectTab(targetTab.id);
  focusTab(targetTab.id);
}
</script>

<style scoped>
.sp-tabs {
  position: sticky;
  top: 0;
  z-index: 20;
  flex-shrink: 0;
  display: flex;
  align-items: stretch;
  gap: 4px;
  padding: 0 8px;
  background-color: var(--ac-bg);
  box-shadow: inset 0 -0.75px 0 0 var(--ac-divider);
}

.sp-tab {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 40px;
  padding: 0 8px;
  border: none;
  background: transparent;
  color: var(--ac-text-caption);
  font-family: inherit;
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
  cursor: pointer;
  transition: color var(--ac-motion-fast) ease;
}

.sp-tab:hover {
  color: var(--ac-text-secondary);
}

/* 인접 버튼이 flush 로 붙어 있어 양수 offset 은 옆 버튼에 가려질 수 있다. inset 으로 그린다. */
.sp-tab:focus-visible {
  outline: 2px solid var(--ac-focus-ring);
  outline-offset: -2px;
}

/* 활성 탭: 글자만 진해지고 아래 2px 밑줄이 붙는다. 배경은 바뀌지 않는다. */
.sp-tab-active,
.sp-tab-active:hover {
  color: var(--ac-text);
}

.sp-tab-active::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 0;
  height: 2px;
  border-radius: 10px;
  background-color: var(--ac-tab-underline);
}

.sp-tab-text {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
