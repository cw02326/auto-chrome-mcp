import { initNativeHostListener } from './native-host';
import {
  initSemanticSimilarityListener,
  initializeSemanticEngineIfCached,
} from './semantic-similarity';
import { initStorageManagerListener } from './storage-manager';
import { cleanupModelCache } from '@/utils/semantic-similarity-engine';
import { initRecordReplayListeners } from './record-replay';
import { initElementMarkerListeners } from './element-marker';
import { initWebEditorListeners } from './web-editor';
import { initQuickPanelAgentHandler } from './quick-panel/agent-handler';
import { initQuickPanelCommands } from './quick-panel/commands';
import { initQuickPanelTabsHandler } from './quick-panel/tabs-handler';
import { initializeTogglesIfMissing } from '@/utils/consent-storage';

/**
 * v1.0.32+: 비민감 4종 site-level contentSettings 를 모든 사이트 (`<all_urls>`) 에 대해
 * `allow` 로 세팅. install / update / chrome_update 매 이벤트마다 idempotent 하게 적용.
 *
 * camera / microphone / geolocation 은 모두 민감 권한 (개인정보 직접 노출 + OS 권한 의존).
 * `<all_urls>` 일괄 allow 안 함 — `user-consent.ts` 의 `chrome_request_user_consent` 가
 * consent 통과 시 현재 active tab 의 origin 단위로 동적 set (sticky 영구 저장).
 * "AI 가 방문한 사이트만 누적 자동 허용" 신뢰 모델로 camera/mic 와 통일.
 *
 * v1.0.31 → v1.0.32: location 을 비민감 5종에서 빼고 민감 3종 (consent gate) 으로 이동.
 *   사유: 위치 정보는 개인정보 직접 노출 + macOS/Windows OS 권한 의존성 + 사용자 환경마다
 *   허용 정책이 달라 "install 시 자동 일괄 allow" 가 부적합. camera/mic 와 동일하게
 *   chrome_request_user_consent 호출 시점에만 origin 단위 sticky 누적.
 *
 * design: docs/plans/2026-05-29-site-permissions-design.md §4.1, §5.1, §11 step 2
 */
const SITE_CONTENT_SETTINGS: ReadonlyArray<{
  type: 'popups' | 'notifications' | 'clipboard' | 'automaticDownloads';
  label: string;
}> = [
  { type: 'popups', label: 'Popups' },
  { type: 'notifications', label: 'Notifications' },
  { type: 'clipboard', label: 'Clipboard' },
  { type: 'automaticDownloads', label: 'Automatic Downloads' },
];

async function applySiteContentSettings(): Promise<void> {
  for (const { type, label } of SITE_CONTENT_SETTINGS) {
    try {
      // chrome.contentSettings.<type> 동적 접근
      const setting = (
        chrome.contentSettings as unknown as Record<string, chrome.contentSettings.ContentSetting>
      )[type];
      if (!setting?.set) {
        console.warn(`[site-perms] chrome.contentSettings.${type} 미지원 (Chrome 정책) — skip`);
        continue;
      }
      await setting.set({
        primaryPattern: '<all_urls>',
        setting: 'allow',
      });
      console.log(`[site-perms] ✓ ${label} → allow (<all_urls>)`);
    } catch (e: any) {
      console.error(`[site-perms] ✗ ${label} 세팅 실패:`, e?.message || e);
    }
  }
  console.log(
    '[site-perms] camera / microphone / geolocation 은 user-consent.ts 가 사용 시점에 origin 단위로 set',
  );
}

// Record-Replay V3 (feature flag)
import { bootstrapV3 } from './record-replay-v3/bootstrap';

/**
 * Feature flag for RR-V3
 * Set to true to enable the new Record-Replay V3 engine
 */
const ENABLE_RR_V3 = true;

/**
 * Background script entry point
 * Initializes all background services and listeners
 */
export default defineBackground(() => {
  // Open welcome page on first install
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
      // Open the welcome/onboarding page for new installations
      chrome.tabs.create({
        url: chrome.runtime.getURL('/welcome.html'),
      });
    }

    // v1.0.32+: 매 이벤트 (install/update/chrome_update) 마다 비민감 4종 contentSettings 재적용.
    // 토글 storage 는 install 시점에만 default 초기화 (update 시엔 사용자 OFF 보존).
    applySiteContentSettings().catch((e) =>
      console.error('[site-perms] applySiteContentSettings 실패:', e),
    );
    if (details.reason === 'install') {
      initializeTogglesIfMissing()
        .then(() => console.log('[site-perms] 토글 default (camera/mic/geo = true) 초기화'))
        .catch((e) => console.error('[site-perms] 토글 초기화 실패:', e));
    }
  });

  // Initialize core services
  initNativeHostListener();
  initSemanticSimilarityListener();
  initStorageManagerListener();
  // Record & Replay V1/V2 listeners
  initRecordReplayListeners();

  // Record & Replay V3 (new engine)
  if (ENABLE_RR_V3) {
    bootstrapV3()
      .then((runtime) => {
        console.log(`[RR-V3] Bootstrap complete, ownerId: ${runtime.ownerId}`);
      })
      .catch((error) => {
        console.error('[RR-V3] Bootstrap failed:', error);
      });
  }

  // Element marker: context menu + CRUD listeners
  initElementMarkerListeners();
  // Web editor: toggle edit-mode overlay
  initWebEditorListeners();
  // Quick Panel: send messages to AgentChat via background-stream bridge
  initQuickPanelAgentHandler();
  // Quick Panel: tabs search bridge for content script UI
  initQuickPanelTabsHandler();
  // Quick Panel: keyboard shortcut handler
  initQuickPanelCommands();

  // Conditionally initialize semantic similarity engine if model cache exists
  initializeSemanticEngineIfCached()
    .then((initialized) => {
      if (initialized) {
        console.log('Background: Semantic similarity engine initialized from cache');
      } else {
        console.log(
          'Background: Semantic similarity engine initialization skipped (no cache found)',
        );
      }
    })
    .catch((error) => {
      console.warn('Background: Failed to conditionally initialize semantic engine:', error);
    });

  // Initial cleanup on startup
  cleanupModelCache().catch((error) => {
    console.warn('Background: Initial cache cleanup failed:', error);
  });
});
