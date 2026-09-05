/**
 * 사이드패널 → 백그라운드 "매일 작업" 메시지 감싸개 (2026-09-05 사이드패널 2단계 D).
 *
 * `rr-messages.ts` 와 같은 이유로 있는 모듈이다. 백그라운드는 `{ success:false, error }`
 * 로 답하므로, 여기서 한 번에 예외로 바꿔 화면이 토스트로 보여 줄 수 있게 한다. 테스트도
 * `chrome.runtime.sendMessage` 하나만 대역으로 바꾸면 무엇을 보내는지 그대로 확인된다.
 *
 * 예약을 가리키는 값은 표시 이름이 아니라 `scheduleId` 다(`shortcut:<enc>`/`flow:<enc>`).
 * 이름이 같은 단축과 흐름이 서로의 알람·이력을 건드리지 않게 하려는 구분이라, 화면은
 * 목록에서 받은 `scheduleId` 를 그대로 돌려주기만 하면 된다.
 */

import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';

/** 백그라운드 공통 응답 모양. */
interface DailyResponse {
  success?: boolean;
  error?: string;
  errorCode?: string;
  [key: string]: unknown;
}

/** 예약 대상. 흐름 예약은 사이드패널에서만 만든다. */
export type ScheduleTarget =
  | { kind: 'shortcut'; name: string }
  | { kind: 'flow'; flowId: string; args?: Record<string, string> };

/** 예약 표현. `every` 와 `daily` 중 하나만 쓴다. */
export interface ScheduleExpressionView {
  every?: string;
  daily?: string[];
  days?: string[];
}

/** 목록 한 줄. `summaryText`(사람이 읽는 요약)는 화면 유틸이 만든다. */
export interface ScheduleView {
  scheduleId: string;
  /** 표시 이름 (= `label`). */
  name: string;
  label: string;
  kind: ScheduleTarget['kind'];
  target: ScheduleTarget;
  enabled: boolean;
  schedule: ScheduleExpressionView;
  nextAt: number;
  notify: boolean;
  report: boolean;
  loginCheck?: string;
  revision: number;
  failStreak: number;
  lastStatus?: string;
  lastRunId?: string;
  lastRunAt?: number;
}

/** 실행 이력 한 건. 목록 응답에는 `results` 본문이 빠져 있다 (`getRun` 으로 받는다). */
export interface DailyRunRecord {
  runId: string;
  /** 이력 저장소 키. 예약 실행은 scheduleId 와 같다. */
  name: string;
  /** 표시 이름 스냅샷. 예약을 지워도 남는다. */
  label?: string;
  trigger: 'manual' | 'scheduled';
  status: string;
  startedAt: number;
  endedAt?: number | null;
  durationMs?: number | null;
  failedStep?: { index: number; tool: string; stepId?: string } | null;
  errorCode?: string | null;
  error?: string | null;
  results?: Record<string, unknown>;
  resultsChars?: number;
  resultsTruncated?: string[];
  /** 실패 스크린샷 파일 이름 (다운로드 폴더 기준). */
  screenshot?: string | null;
  report?: string | null;
  warnings?: string[];
  superseded?: boolean;
}

/** 예약 저장 입력. */
export interface PutScheduleInput {
  target: ScheduleTarget;
  schedule: ScheduleExpressionView;
  params?: Record<string, unknown>;
  notify?: boolean;
  report?: boolean;
  loginCheck?: string;
  enabled?: boolean;
}

/** 이력 조회 조건. */
export interface HistoryQuery {
  scheduleId?: string;
  status?: string[];
  since?: string | number;
  limit?: number;
  cursor?: string;
}

/** 가져오기 미리보기 한 줄. */
export interface ImportPreviewEntry {
  id: string;
  name: string;
  stepCount: number;
  conflict: boolean;
}

/** 가져오기 결과 한 줄. `copy` 모드에서 새 id 를 받은 흐름은 두 값이 다르다. */
export interface ImportedFlowInfo {
  oldId: string;
  newId: string;
  name: string;
}

/** 백그라운드가 코드로 답한 실패. 화면이 문구를 고를 수 있게 코드를 남긴다. */
export class DailyRequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'DailyRequestError';
  }
}

async function send(message: Record<string, unknown>): Promise<DailyResponse> {
  let res: DailyResponse | undefined;
  try {
    res = (await chrome.runtime.sendMessage(message)) as DailyResponse | undefined;
  } catch (e) {
    throw new DailyRequestError(e instanceof Error ? e.message : String(e));
  }
  if (!res) throw new DailyRequestError('no response from background');
  if (res.success === false) {
    throw new DailyRequestError(String(res.error || 'request failed'), res.errorCode);
  }
  return res;
}

/* ------------------------------------------------------------------ *
 * 예약
 * ------------------------------------------------------------------ */

export async function listSchedules(): Promise<ScheduleView[]> {
  const res = await send({ type: BACKGROUND_MESSAGE_TYPES.DAILY_LIST_SCHEDULES });
  return (res.schedules as ScheduleView[]) || [];
}

export async function putSchedule(input: PutScheduleInput): Promise<ScheduleView> {
  const res = await send({ type: BACKGROUND_MESSAGE_TYPES.DAILY_PUT_SCHEDULE, ...input });
  return res.schedule as ScheduleView;
}

export async function removeSchedule(scheduleId: string): Promise<void> {
  await send({ type: BACKGROUND_MESSAGE_TYPES.DAILY_REMOVE_SCHEDULE, scheduleId });
}

export async function setScheduleEnabled(
  scheduleId: string,
  enabled: boolean,
): Promise<ScheduleView> {
  const res = await send({
    type: BACKGROUND_MESSAGE_TYPES.DAILY_SET_ENABLED,
    scheduleId,
    enabled,
  });
  return res.schedule as ScheduleView;
}

/**
 * 지금 실행. 예약 큐를 그대로 타므로 다른 예약이 돌고 있으면 그 뒤에 줄을 선다
 * (동시에 두 실행이 사용자 창에서 겹치지 않게 하는 규칙이다).
 *
 * `queued: false` 는 **이미 그 예약이 큐에 있다**는 뜻이다. 실패가 아니라 "두 번 누르셨고
 * 첫 번째가 아직 돌고 있습니다" 이므로 화면이 그렇게 말할 수 있게 그대로 돌려준다.
 */
export async function runScheduleNow(
  scheduleId: string,
): Promise<{ runId: string; queued: boolean }> {
  const res = await send({ type: BACKGROUND_MESSAGE_TYPES.DAILY_RUN_NOW, scheduleId });
  return { runId: String(res.runId || ''), queued: res.queued !== false };
}

/* ------------------------------------------------------------------ *
 * 이력
 * ------------------------------------------------------------------ */

export async function queryHistory(query: HistoryQuery = {}): Promise<{
  runs: DailyRunRecord[];
  matched: number;
  nextCursor?: string;
}> {
  const res = await send({ type: BACKGROUND_MESSAGE_TYPES.DAILY_HISTORY, ...query });
  return {
    runs: (res.runs as DailyRunRecord[]) || [],
    matched: Number(res.matched || 0),
    nextCursor: typeof res.nextCursor === 'string' ? res.nextCursor : undefined,
  };
}

/** 실행 하나를 `results` 까지 통째로. 실패 상세를 펼칠 때 부른다. */
export async function getRun(runId: string): Promise<DailyRunRecord> {
  const res = await send({ type: BACKGROUND_MESSAGE_TYPES.DAILY_GET_RUN, runId });
  return res.run as DailyRunRecord;
}

/**
 * 실패 스크린샷을 파일 탐색기에서 연다. 확장은 다운로드 폴더 밖을 볼 수 없으므로
 * 이미지를 화면에 그리는 대신 폴더를 연다. 파일이 없으면
 * `sidepanel_screenshot_missing` 코드로 실패한다.
 */
export async function openScreenshot(filename: string): Promise<void> {
  await send({ type: BACKGROUND_MESSAGE_TYPES.DAILY_OPEN_SCREENSHOT, filename });
}

/* ------------------------------------------------------------------ *
 * 흐름 가져오기
 * ------------------------------------------------------------------ */

/** 저장하지 않고 무엇이 들어올지만 본다 (id 충돌 포함). */
export async function importFlowPreview(json: string): Promise<ImportPreviewEntry[]> {
  const res = await send({ type: BACKGROUND_MESSAGE_TYPES.RR_IMPORT_FLOW_PREVIEW, json });
  return (res.flows as ImportPreviewEntry[]) || [];
}

/** 실제 가져오기. `copy` 는 겹치는 흐름만 새 id 로 복사한다. */
export async function importFlow(
  json: string,
  mode: 'copy' | 'overwrite' = 'overwrite',
): Promise<ImportedFlowInfo[]> {
  const res = await send({ type: BACKGROUND_MESSAGE_TYPES.RR_IMPORT_FLOW, json, mode });
  return (res.imported as ImportedFlowInfo[]) || [];
}

/* ------------------------------------------------------------------ *
 * 변경 방송
 * ------------------------------------------------------------------ */

/**
 * 예약·이력이 바뀌면 부를 콜백을 등록한다. 해제 함수를 돌려준다.
 * 방송에는 내용이 없다 - 화면이 자기 조건으로 다시 조회한다.
 */
export function onDailyChanged(handler: () => void): () => void {
  const listener = (message: { type?: string } | undefined) => {
    if (message?.type === BACKGROUND_MESSAGE_TYPES.DAILY_CHANGED) handler();
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
