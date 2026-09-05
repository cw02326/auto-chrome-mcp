/**
 * @fileoverview 사이드패널 워크플로우(흐름) 데이터 계층
 *
 * ## 어느 저장소를 보는가 (2026-09-05 사이드패널 1단계 A 에서 바꿈)
 *
 * 흐름 목록·실행 이력·실행·삭제·발행은 **V2 저장소(`rr_storage`)** 를 본다. 이유는 하나다.
 * 녹화가 흐름을 저장하는 곳(`recording/recorder-manager.ts` → `flow-store.saveFlow`), 발행이
 * 쌓이는 곳(`RR_PUBLISH_FLOW`), 그리고 Claude Code 가 부르는 `record_replay_flow_run`·
 * `record_replay_list_published` 가 읽는 곳이 전부 거기다. V3 저장소(`rr_v3`)는 별도
 * IndexedDB 이고 V2 를 읽어 오는 경로(`storage/import/v2-reader.ts`)가 아직 구현돼 있지
 * 않아서, 목록을 V3 로 조회하면 방금 녹화한 흐름이 화면에 아예 나타나지 않았다.
 *
 * 트리거는 아예 다루지 않는다 (2026-09-05 Codex 교차 리뷰 4항). 화면은 V3 RPC 로 트리거를
 * 읽었는데 실제로 트리거를 켜고 끄는 엔진은 V2 `trigger-store` 라, 목록에 보이는 것과
 * 실제로 도는 것이 서로 다른 저장소였다. 1단계에서는 트리거 화면을 걷어 내고, 예약은
 * 2단계에서 예약 레코드가 흐름 id 를 직접 가리키는 방식으로 다시 만든다.
 *
 * ## 바깥에서 일어난 변화 (Codex 교차 리뷰 5항)
 *
 * 실행은 사이드패널만 시작하지 않는다. Claude Code 의 `record_replay_flow_run`, URL·DOM
 * 트리거, 알람 예약도 실행을 만든다. 그래서
 *   - 흐름 목록은 백그라운드의 `RR_FLOWS_CHANGED` 방송을 듣고 다시 읽고,
 *   - 실행 이력은 **패널이 보이는 동안만** 낮은 주기로 다시 읽는다.
 * 실행 이력에는 방송이 없어(`appendRun` 은 알리지 않는다) 폴링이 필요하다. 패널이 가려져
 * 있으면 멈추므로 서비스 워커를 계속 깨워 두지 않는다.
 */

import { onMounted, onUnmounted, ref, type Ref } from 'vue';

import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import * as rr from '../utils/rr-messages';
import { needsRepublish, type PublishedInfoLite, type WizardFlow } from '../utils/flow-wizard';

/** 실행 이력 다시 읽기 주기. 패널이 보이는 동안에만 돈다. */
const RUNS_POLL_MS = 5000;

// ==================== UI Types ====================

/** 목록 카드가 그리는 흐름 한 건. */
export interface FlowLite {
  id: string;
  name: string;
  description?: string;
  version: number;
  startUrl?: string;
  updatedAt?: string;
  /** 발행돼 있으면 그 레코드. 카드의 "발행됨" 배지가 이 값을 본다. */
  published?: PublishedInfoLite;
  /** 발행 후 흐름이 바뀌었는가. */
  needsRepublish: boolean;
  meta?: {
    domain?: string;
    tags?: string[];
    bindings?: Array<{
      kind?: string;
      type?: string;
      value: string;
    }>;
  };
}

/** 실행 이력 한 건. */
export interface RunLite {
  id: string;
  flowId: string;
  startedAt: string;
  finishedAt?: string;
  /** 끝난 실행의 성패. 아직 도는 중이면 undefined. */
  success?: boolean;
  isInProgress: boolean;
  status: 'running' | 'succeeded' | 'failed';
  entries: unknown[];
}

// ==================== Mappers ====================

function domainOf(flow: WizardFlow): string | undefined {
  const fromMeta = flow.meta?.domain;
  if (typeof fromMeta === 'string' && fromMeta) return fromMeta;
  try {
    return flow.startUrl ? new URL(flow.startUrl).hostname : undefined;
  } catch {
    return undefined;
  }
}

function mapFlowToLite(flow: WizardFlow, published?: PublishedInfoLite): FlowLite {
  const bindings = (flow.meta as { bindings?: Array<{ type?: string; value: string }> } | undefined)
    ?.bindings;
  return {
    id: flow.id,
    name: flow.name,
    description: flow.description,
    version: Number(flow.version || 0),
    startUrl: flow.startUrl,
    updatedAt: flow.meta?.updatedAt ? String(flow.meta.updatedAt) : undefined,
    published,
    needsRepublish: needsRepublish(flow, published),
    meta: {
      domain: domainOf(flow),
      tags: (flow.meta as { tags?: string[] } | undefined)?.tags,
      bindings: (bindings || []).map((b) => ({ kind: b.type, type: b.type, value: b.value })),
    },
  };
}

function mapRunToLite(run: rr.RunRecordLite): RunLite {
  const isInProgress = !run.finishedAt;
  return {
    id: run.id,
    flowId: run.flowId,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    success: isInProgress ? undefined : run.success === true,
    isInProgress,
    status: isInProgress ? 'running' : run.success === true ? 'succeeded' : 'failed',
    entries: Array.isArray(run.entries) ? run.entries : [],
  };
}

// ==================== Composable ====================

export interface UseWorkflowsV3Options {
  /** 실행 이력 폴링 주기(ms). 0 이면 끈다. 기본 5초. */
  runsPollMs?: number;
}

export interface UseWorkflowsV3Return {
  loading: Ref<boolean>;
  error: Ref<string | null>;

  flows: Ref<FlowLite[]>;
  runs: Ref<RunLite[]>;

  refresh: () => Promise<void>;
  refreshFlows: () => Promise<void>;
  refreshRuns: () => Promise<void>;
  /** 흐름 실행. 실패는 예외로 올린다 (호출한 화면이 토스트로 보여 준다). */
  runFlow: (
    flowId: string,
    options?: { tabId?: number; args?: Record<string, unknown> },
  ) => Promise<rr.RunSummary>;
  deleteFlow: (flowId: string) => Promise<void>;
  exportFlow: (flowId: string) => Promise<WizardFlow | null>;

  publishFlow: (flowId: string) => Promise<void>;
  unpublishFlow: (flowId: string) => Promise<void>;

  getFlowById: (flowId: string) => Promise<WizardFlow | null>;
}

export function useWorkflowsV3(options: UseWorkflowsV3Options = {}): UseWorkflowsV3Return {
  const { runsPollMs = RUNS_POLL_MS } = options;

  const loading = ref(false);
  const error = ref<string | null>(null);
  const flows = ref<FlowLite[]>([]);
  const runs = ref<RunLite[]>([]);

  let runsTimer: ReturnType<typeof setInterval> | null = null;

  function noteError(e: unknown): void {
    error.value = e instanceof Error ? e.message : String(e);
  }

  async function refreshFlows(): Promise<void> {
    try {
      // 발행 목록을 함께 읽어 카드에 배지를 그린다. 한 쪽이 실패해도 목록은 나와야 하므로
      // 발행 조회 실패는 "발행 정보 없음" 으로 떨어뜨린다.
      const [list, published] = await Promise.all([
        rr.listFlows(),
        rr.listPublished().catch(() => [] as PublishedInfoLite[]),
      ]);
      const byId = new Map(published.map((p) => [p.id, p]));
      flows.value = list.map((flow) => mapFlowToLite(flow, byId.get(flow.id)));
    } catch (e) {
      noteError(e);
    }
  }

  async function refreshRuns(): Promise<void> {
    try {
      const list = await rr.listRuns();
      const sorted = list
        .slice()
        .sort((a, b) => Date.parse(b.startedAt || '') - Date.parse(a.startedAt || ''));
      runs.value = sorted.map(mapRunToLite);
    } catch (e) {
      noteError(e);
    }
  }

  async function refresh(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      await Promise.all([refreshFlows(), refreshRuns()]);
    } finally {
      loading.value = false;
    }
  }

  async function runFlow(
    flowId: string,
    runOptions: { tabId?: number; args?: Record<string, unknown> } = {},
  ): Promise<rr.RunSummary> {
    const result = await rr.runFlow(flowId, { ...runOptions, returnLogs: true });
    void refreshRuns();
    return result;
  }

  async function deleteFlow(flowId: string): Promise<void> {
    await rr.deleteFlow(flowId);
    await refreshFlows();
  }

  async function exportFlow(flowId: string): Promise<WizardFlow | null> {
    return await rr.getFlow(flowId);
  }

  async function publishFlow(flowId: string): Promise<void> {
    await rr.publishFlow(flowId);
    await refreshFlows();
  }

  async function unpublishFlow(flowId: string): Promise<void> {
    await rr.unpublishFlow(flowId);
    await refreshFlows();
  }

  async function getFlowById(flowId: string): Promise<WizardFlow | null> {
    return await rr.getFlow(flowId);
  }

  // ==================== Lifecycle ====================

  /** 백그라운드가 흐름 저장·삭제·발행을 알릴 때 목록을 다시 읽는다. */
  function onBackgroundMessage(message: unknown): void {
    const type = (message as { type?: string } | null)?.type;
    if (type === BACKGROUND_MESSAGE_TYPES.RR_FLOWS_CHANGED) void refreshFlows();
  }

  /** 패널이 화면에 보일 때만 실행 이력을 다시 읽는다. */
  function pollRuns(): void {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    void refreshRuns();
  }

  onMounted(async () => {
    await refresh();

    try {
      chrome.runtime.onMessage.addListener(onBackgroundMessage);
    } catch {
      // 방송을 못 들어도 아래 폴링과 사용자의 새로고침 버튼이 남는다.
    }

    if (runsPollMs > 0) {
      runsTimer = setInterval(pollRuns, runsPollMs);
    }
  });

  onUnmounted(() => {
    if (runsTimer) {
      clearInterval(runsTimer);
      runsTimer = null;
    }
    try {
      chrome.runtime.onMessage.removeListener(onBackgroundMessage);
    } catch {
      // 이미 정리됐다.
    }
  });

  return {
    loading,
    error,
    flows,
    runs,
    refresh,
    refreshFlows,
    refreshRuns,
    runFlow,
    deleteFlow,
    exportFlow,
    publishFlow,
    unpublishFlow,
    getFlowById,
  };
}
