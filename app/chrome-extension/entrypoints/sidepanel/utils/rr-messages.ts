/**
 * 사이드패널 → 백그라운드 record-replay 메시지 얇은 감싸개 (2026-09-05 사이드패널 1단계 A).
 *
 * 왜 별도 모듈인가.
 *   1. 실패를 삼키지 않기 위해서다. 백그라운드는 `{ success:false, error }` 로 답하는데,
 *      예전 화면 코드는 이를 `catch {}` 로 버려 사용자에게 아무 말도 하지 않았다. 여기서
 *      한 번에 예외로 바꿔 화면이 토스트로 보여 줄 수 있게 한다.
 *   2. 테스트 때문이다. `chrome.runtime.sendMessage` 만 대역으로 바꾸면 발행·저장·실행이
 *      어떤 메시지를 보내는지 그대로 확인할 수 있다.
 *
 * 이 모듈이 부르는 메시지는 모두 **V2 저장소**(`rr_storage`)를 가리킨다. 녹화가 흐름을
 * 저장하는 곳도, `record_replay_flow_run`·`record_replay_list_published` 가 읽는 곳도
 * 그쪽이다.
 */

import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import type { PublishedInfoLite, WizardFlow } from './flow-wizard';

/** 백그라운드 공통 응답 모양. */
interface RrResponse {
  success?: boolean;
  error?: string;
  [key: string]: unknown;
}

/** 녹화 상태 스냅샷 (`RR_GET_RECORDING_SNAPSHOT`). */
export interface RecordingSnapshot {
  status: 'idle' | 'recording' | 'paused' | 'stopping';
  sessionId?: string;
  originTabId?: number | null;
  startUrl?: string;
  flowId?: string;
  flowName?: string;
  /** 녹화를 시작한 탭의 문서 제목. */
  startTitle?: string;
  stepCount: number;
  startedAt?: string;
}

/** 실행 결과 요약 (`RR_RUN_FLOW` 의 `result`). */
export interface RunSummary {
  runId?: string;
  success: boolean;
  summary?: { total: number; success: number; failed: number; tookMs: number };
  logs?: Array<{ stepId: string; status: string; message?: string; tookMs?: number }>;
}

/** 실행 이력 한 건 (`RR_LIST_RUNS`). */
export interface RunRecordLite {
  id: string;
  flowId: string;
  startedAt: string;
  finishedAt?: string;
  success?: boolean;
  entries?: Array<{ stepId: string; status: string; message?: string; tookMs?: number }>;
}

async function send(message: Record<string, unknown>): Promise<RrResponse> {
  let res: RrResponse | undefined;
  try {
    res = (await chrome.runtime.sendMessage(message)) as RrResponse | undefined;
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }
  if (!res) throw new Error('no response from background');
  if (res.success === false) throw new Error(String(res.error || 'request failed'));
  return res;
}

export async function listFlows(): Promise<WizardFlow[]> {
  const res = await send({ type: BACKGROUND_MESSAGE_TYPES.RR_LIST_FLOWS });
  return (res.flows as WizardFlow[]) || [];
}

export async function getFlow(flowId: string): Promise<WizardFlow | null> {
  const res = await send({ type: BACKGROUND_MESSAGE_TYPES.RR_GET_FLOW, flowId });
  return (res.flow as WizardFlow) || null;
}

export async function saveFlow(flow: WizardFlow): Promise<void> {
  await send({ type: BACKGROUND_MESSAGE_TYPES.RR_SAVE_FLOW, flow });
}

export async function deleteFlow(flowId: string): Promise<void> {
  await send({ type: BACKGROUND_MESSAGE_TYPES.RR_DELETE_FLOW, flowId });
}

export async function listRuns(): Promise<RunRecordLite[]> {
  const res = await send({ type: BACKGROUND_MESSAGE_TYPES.RR_LIST_RUNS });
  return (res.runs as RunRecordLite[]) || [];
}

export async function listPublished(): Promise<PublishedInfoLite[]> {
  const res = await send({ type: BACKGROUND_MESSAGE_TYPES.RR_LIST_PUBLISHED });
  return (res.published as PublishedInfoLite[]) || [];
}

/**
 * 발행. slug 는 백그라운드가 흐름 이름에서 자동으로 만든다 (`toSlug`).
 *
 * `flow` 를 주면 백그라운드가 저장소를 다시 읽지 않고 **그 내용을 그대로** 발행한다
 * (2026-09-05 시연 지적 3항). 저장 직후 발행하는 마법사가 이 경로를 쓴다 - 저장과 발행
 * 사이에 저장소를 한 번 더 오가면, 그 사이에 무엇이 어긋나든 옛 내용이 발행될 수 있다.
 */
export async function publishFlow(
  flowId: string,
  options: { slug?: string; flow?: WizardFlow } = {},
): Promise<void> {
  await send({
    type: BACKGROUND_MESSAGE_TYPES.RR_PUBLISH_FLOW,
    flowId,
    ...(options.slug ? { slug: options.slug } : {}),
    ...(options.flow ? { flow: options.flow } : {}),
  });
}

export async function unpublishFlow(flowId: string): Promise<void> {
  await send({ type: BACKGROUND_MESSAGE_TYPES.RR_UNPUBLISH_FLOW, flowId });
}

/**
 * 흐름 실행.
 *
 * `tabId` 를 주면 그 탭에 고정해 돈다. 시험 실행은 사용자가 보던 화면을 빼앗지 않으려고
 * 백그라운드 탭을 직접 만들어 그 id 를 넘긴다.
 */
export async function runFlow(
  flowId: string,
  options: { tabId?: number; args?: Record<string, unknown>; returnLogs?: boolean } = {},
): Promise<RunSummary> {
  const res = await send({
    type: BACKGROUND_MESSAGE_TYPES.RR_RUN_FLOW,
    flowId,
    ...(typeof options.tabId === 'number' ? { tabId: options.tabId } : {}),
    options: {
      ...(options.args ? { args: options.args } : {}),
      returnLogs: options.returnLogs === true,
    },
  });
  return (res.result as RunSummary) || { success: false };
}

export async function exportFlowJson(flowId: string): Promise<string> {
  const res = await send({ type: BACKGROUND_MESSAGE_TYPES.RR_EXPORT_FLOW, flowId });
  return String(res.json || '');
}

/**
 * 녹화 시작.
 *
 * `tabId` 를 주면 그 탭에서 녹화한다. 팝업에서 시작한 경우 팝업이 눌린 순간의 탭이므로,
 * 패널이 뜨는 사이에 활성 탭이 바뀌어도 처음 보던 탭이 녹화된다. 없으면 백그라운드가
 * 활성 탭을 찾는다(예전 동작).
 */
export async function startRecording(tabId?: number): Promise<void> {
  await send({
    type: BACKGROUND_MESSAGE_TYPES.RR_START_RECORDING,
    ...(typeof tabId === 'number' ? { tabId } : {}),
  });
}

/** 녹화 중지. 흐름은 백그라운드가 이미 저장했고, 그 id 를 돌려준다. */
export async function stopRecording(): Promise<{ flowId?: string; warning?: string }> {
  const res = await send({ type: BACKGROUND_MESSAGE_TYPES.RR_STOP_RECORDING });
  const flow = res.flow as { id?: string } | undefined;
  return {
    flowId: flow?.id,
    warning: typeof res.error === 'string' ? res.error : undefined,
  };
}

export async function getRecordingSnapshot(): Promise<RecordingSnapshot> {
  const res = await send({ type: BACKGROUND_MESSAGE_TYPES.RR_GET_RECORDING_SNAPSHOT });
  return {
    status: (res.status as RecordingSnapshot['status']) || 'idle',
    sessionId: res.sessionId as string | undefined,
    originTabId: (res.originTabId as number | null | undefined) ?? null,
    startUrl: res.startUrl as string | undefined,
    flowId: res.flowId as string | undefined,
    flowName: res.flowName as string | undefined,
    startTitle: res.startTitle as string | undefined,
    stepCount: Number(res.stepCount || 0),
    startedAt: res.startedAt as string | undefined,
  };
}
