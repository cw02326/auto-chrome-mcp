import {
  OBSERVATION_TTL_MS,
  type ObservationInput,
  type ObservationStore,
  type ScreenshotObservation,
} from './screenshot-observation';

export interface ScreenshotContext {
  screenshotWidth: number;
  screenshotHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio?: number;
  hostname?: string;
  timestamp: number;
}

const STORAGE_KEY = 'screenshotObservationsV1';
// 만료 직후에는 expired 사유를 돌려주고, 다음 복구·캡처에서 오래된 기록을 정리한다.
const RETENTION_MS = OBSERVATION_TTL_MS * 2;
const contexts = new Map<number, ScreenshotContext>();
const observations = new Map<string, ScreenshotObservation>();
const invalidatedTabs = new Set<number>();
const closedTabs = new Set<number>();
let restorePromise: Promise<void> | undefined;
let persistQueue: Promise<void> = Promise.resolve();
let lastPersisted = '';

const snapshot = () => ({
  observations: Object.fromEntries(observations),
  contexts: Object.fromEntries(contexts),
});

function prune(): void {
  const now = Date.now();
  for (const [id, item] of observations) {
    if (now - item.timestamp > RETENTION_MS) observations.delete(id);
  }
  for (const [tabId, item] of contexts) {
    if (now - item.timestamp > OBSERVATION_TTL_MS) contexts.delete(tabId);
  }
}

function persist(): Promise<void> {
  // 큐를 실행할 때 최신 상태를 읽어 연속 정리 요청을 한 번의 쓰기로 합친다.
  const operation = persistQueue.then(async () => {
    const value = snapshot();
    const serialized = JSON.stringify(value);
    if (serialized === lastPersisted) return;
    await chrome.storage.session.set({ [STORAGE_KEY]: value });
    // 쓰기가 실패하면 다음 호출이 재시도해야 하므로 성공 뒤에만 갱신한다.
    lastPersisted = serialized;
  });
  persistQueue = operation.catch(() => undefined);
  return operation;
}

async function restore(): Promise<void> {
  if (!restorePromise) {
    restorePromise = (async () => {
      const stored = await chrome.storage.session.get(STORAGE_KEY);
      const value = stored?.[STORAGE_KEY];
      const savedObservations = value?.observations ?? {};
      const savedContexts = value?.contexts ?? {};
      lastPersisted = JSON.stringify({ observations: savedObservations, contexts: savedContexts });
      for (const [id, raw] of Object.entries(savedObservations)) {
        const item = raw as ScreenshotObservation;
        if (
          item?.observationId === id &&
          Number.isInteger(item.tabId) &&
          Number.isFinite(item.timestamp) &&
          !invalidatedTabs.has(item.tabId) &&
          !closedTabs.has(item.tabId)
        )
          observations.set(id, item);
      }
      for (const [tabIdText, raw] of Object.entries(savedContexts)) {
        const tabId = Number(tabIdText);
        const item = raw as ScreenshotContext;
        // 내비게이션 후에도 hostname 차단에 필요한 기존 컨텍스트는 남긴다.
        if (
          Number.isInteger(tabId) &&
          Number.isFinite(item?.timestamp) &&
          !closedTabs.has(tabId) &&
          !contexts.has(tabId)
        )
          contexts.set(tabId, item);
      }
      prune();
      // 복구 도중 닫힌 탭이나 만료된 항목도 저장소에서 제거해 재시작 때 되살아나지 않게 한다.
      if (JSON.stringify(snapshot()) !== lastPersisted) await persist();
    })().catch((error) => {
      restorePromise = undefined;
      throw error;
    });
  }
  return restorePromise;
}

async function recordObservation(
  tabId: number,
  input: ObservationInput,
): Promise<ScreenshotObservation> {
  await restore();
  if (closedTabs.has(tabId)) throw new Error('Cannot record an observation for a closed tab');
  prune();
  const item: ScreenshotObservation = {
    ...input,
    observationId: crypto.randomUUID(),
    tabId,
    timestamp: Date.now(),
  };
  observations.set(item.observationId, item);
  await persist();
  return item;
}

function invalidate(tabId: number, closed: boolean): void {
  // 이벤트 시점에 바로 무효화한다. 복구 await 뒤 새 캡처까지 지우는 경합을 피한다.
  invalidatedTabs.add(tabId);
  if (closed) {
    closedTabs.add(tabId);
    contexts.delete(tabId);
  }
  for (const [id, item] of observations) {
    if (item.tabId === tabId) observations.delete(id);
  }
  void restore()
    .then(persist)
    .catch((error) => {
      console.warn('Failed to clean up screenshot observations:', error);
    });
}

export const screenshotContextManager: ObservationStore & {
  setContext(tabId: number, ctx: Omit<ScreenshotContext, 'timestamp'>): void;
  getContext(tabId: number): ScreenshotContext | undefined;
  clear(tabId: number): void;
} = {
  restore,
  recordObservation,
  getObservation: (id) => observations.get(id),
  // 캡처 호출은 restore → setContext → recordObservation 순서로 둘을 한 번에 저장한다.
  setContext(tabId, ctx) {
    contexts.set(tabId, { ...ctx, timestamp: Date.now() });
  },
  getContext(tabId) {
    const ctx = contexts.get(tabId);
    if (!ctx) return undefined;
    if (Date.now() - ctx.timestamp > OBSERVATION_TTL_MS) {
      contexts.delete(tabId);
      return undefined;
    }
    return ctx;
  },
  clear: (tabId) => invalidate(tabId, true),
};

chrome.tabs?.onRemoved?.addListener((tabId) => invalidate(tabId, true));
for (const event of [
  chrome.webNavigation?.onCommitted,
  chrome.webNavigation?.onHistoryStateUpdated,
  chrome.webNavigation?.onReferenceFragmentUpdated,
]) {
  event?.addListener((details) => {
    if (details.frameId === 0) invalidate(details.tabId, false);
  });
}

// ID를 생략한 기존 호출의 배율은 유지한다.
export function scaleCoordinates(
  x: number,
  y: number,
  ctx: ScreenshotContext,
): { x: number; y: number } {
  if (!ctx.screenshotWidth || !ctx.screenshotHeight || !ctx.viewportWidth || !ctx.viewportHeight)
    return { x, y };
  return {
    x: Math.round((x / ctx.screenshotWidth) * ctx.viewportWidth),
    y: Math.round((y / ctx.screenshotHeight) * ctx.viewportHeight),
  };
}
