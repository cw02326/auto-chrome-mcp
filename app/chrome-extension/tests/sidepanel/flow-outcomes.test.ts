/**
 * 흐름별 마지막 결과 합치기 (2026-09-05 사이드패널 2단계 E, Codex 리뷰 1항).
 *
 * 확인하려는 것.
 *   1. 예약 실행 결과가 카드의 "마지막 성공" 과 "최근 실패" 에 반영된다 (수동 실행만 보면
 *      밤새 돈 예약 결과가 카드에 아예 안 보였다).
 *   2. 두 이력을 시각순으로 합친다 - 나중 것이 이긴다.
 *   3. 예약을 지워도 이력이 남아 있으면 결과도 남는다 (예약 목록이 아니라 이력을 본다).
 *   4. 진행 중·대기 중 건너뜀·정상 조기 종료는 성패로 세지 않는다.
 */

import { describe, expect, it } from 'vitest';
import {
  manualRunOutcomes,
  mergeFlowOutcomes,
  scheduledRunOutcomes,
  summarizeFlowOutcomes,
} from '@/entrypoints/sidepanel/utils/flow-outcomes';

/** 예약 이력 키(scheduleId)를 흐름 id 로 되돌리는 가짜. */
function flowIdOf(scheduleId: string): string | null {
  return scheduleId.startsWith('flow:') ? scheduleId.slice('flow:'.length) : null;
}

const T9 = Date.parse('2026-09-05T09:00:00.000Z');
const T10 = Date.parse('2026-09-05T10:00:00.000Z');
const T11 = Date.parse('2026-09-05T11:00:00.000Z');

describe('flow-outcomes', () => {
  it('예약 실행의 성공이 마지막 성공 시각이 된다', () => {
    const summary = mergeFlowOutcomes(
      [],
      [{ name: 'flow:f1', status: 'success', startedAt: T10, endedAt: T10 }],
      flowIdOf,
    );
    expect(summary.lastSuccessAt.f1).toBe(T10);
    expect(summary.failedFlowIds.has('f1')).toBe(false);
  });

  it('예약 실행의 실패가 최근 실패 필터에 잡힌다', () => {
    const summary = mergeFlowOutcomes(
      [],
      [{ name: 'flow:f1', status: 'login_required', startedAt: T10, endedAt: T10 }],
      flowIdOf,
    );
    expect(summary.failedFlowIds.has('f1')).toBe(true);
    expect(summary.lastSuccessAt.f1).toBeUndefined();
  });

  it('나중 결과가 이긴다 (수동 성공 뒤 예약 실패)', () => {
    const summary = mergeFlowOutcomes(
      [
        {
          flowId: 'f1',
          startedAt: '2026-09-05T09:00:00.000Z',
          finishedAt: '2026-09-05T09:00:00.000Z',
          status: 'succeeded',
        },
      ],
      [{ name: 'flow:f1', status: 'failed', startedAt: T11, endedAt: T11 }],
      flowIdOf,
    );
    expect(summary.failedFlowIds.has('f1')).toBe(true);
    // 실패했어도 "마지막으로 성공한 시각" 은 남는다.
    expect(summary.lastSuccessAt.f1).toBe(T9);
  });

  it('예약 실패 뒤 수동 성공이면 최근 실패가 풀린다', () => {
    const summary = mergeFlowOutcomes(
      [
        {
          flowId: 'f1',
          startedAt: '2026-09-05T11:00:00.000Z',
          finishedAt: '2026-09-05T11:00:00.000Z',
          status: 'succeeded',
        },
      ],
      [{ name: 'flow:f1', status: 'failed', startedAt: T10, endedAt: T10 }],
      flowIdOf,
    );
    expect(summary.failedFlowIds.has('f1')).toBe(false);
    expect(summary.lastSuccessAt.f1).toBe(T11);
  });

  it('단축 예약 이력은 흐름 카드에 섞이지 않는다', () => {
    const outcomes = scheduledRunOutcomes(
      [{ name: 'shortcut:daily_report', status: 'failed', startedAt: T10, endedAt: T10 }],
      flowIdOf,
    );
    expect(outcomes).toEqual([]);
  });

  it('진행 중·건너뜀·정상 조기 종료는 성패로 세지 않는다', () => {
    const summary = summarizeFlowOutcomes([
      { flowId: 'f1', at: T9, outcome: 'success' },
      ...scheduledRunOutcomes(
        [
          { name: 'flow:f1', status: 'running', startedAt: T10 },
          { name: 'flow:f1', status: 'skipped_queue', startedAt: T11, endedAt: T11 },
          { name: 'flow:f1', status: 'stopped', startedAt: T11, endedAt: T11 },
        ],
        flowIdOf,
      ),
    ]);
    expect(summary.failedFlowIds.has('f1')).toBe(false);
    expect(summary.lastSuccessAt.f1).toBe(T9);
  });

  it('진행 중인 수동 실행은 결과를 덮어쓰지 않는다', () => {
    const outcomes = manualRunOutcomes([
      { flowId: 'f1', startedAt: '2026-09-05T11:00:00.000Z', isInProgress: true },
    ]);
    expect(outcomes[0].outcome).toBe('neutral');
  });

  it('시각이 없는 기록은 버린다 (0 으로 세면 순서가 뒤집힌다)', () => {
    expect(manualRunOutcomes([{ flowId: 'f1' }])).toEqual([]);
    expect(scheduledRunOutcomes([{ name: 'flow:f1', status: 'success' }], flowIdOf)).toEqual([]);
  });
});
