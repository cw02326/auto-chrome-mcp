/**
 * 사이드패널 → 백그라운드 매일 작업 메시지 (2026-09-05 사이드패널 2단계).
 *
 * 감싸개 자체는 D 가 만들었고, 이 시험은 화면(E)이 기대는 계약이 그대로인지를 본다.
 *
 * 확인하려는 것.
 *   1. 계약 표대로 메시지 타입과 필드(`scheduleId`)를 보낸다.
 *   2. 백그라운드가 실패로 답하면 조용히 넘어가지 않고 예외가 된다.
 *   3. 답이 없으면(아직 핸들러가 없을 때) 그것도 예외다.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as daily from '@/entrypoints/sidepanel/utils/daily-messages';

function mockSend(handler: (message: any) => unknown) {
  (chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (message: any) => handler(message),
  );
}

describe('daily-messages', () => {
  beforeEach(() => {
    (chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>).mockReset();
  });

  it('예약 목록을 읽는다', async () => {
    const sent: any[] = [];
    mockSend((message) => {
      sent.push(message);
      return { success: true, schedules: [{ scheduleId: 'flow:f1' }] };
    });

    const schedules = await daily.listSchedules();

    expect(sent[0].type).toBe('daily_list_schedules');
    expect(schedules).toHaveLength(1);
  });

  it('켜고 끄기는 scheduleId 와 enabled 를 보낸다', async () => {
    const sent: any[] = [];
    mockSend((message) => {
      sent.push(message);
      return { success: true, schedule: { scheduleId: 'flow:f1', enabled: false } };
    });

    await daily.setScheduleEnabled('flow:f1', false);

    expect(sent[0]).toMatchObject({
      type: 'daily_set_enabled',
      scheduleId: 'flow:f1',
      enabled: false,
    });
  });

  it('지금 실행은 runId 와 큐 진입 여부를 돌려준다', async () => {
    mockSend(() => ({ success: true, runId: 'flow:f1:2026-09-05T00:00:00.000Z' }));
    await expect(daily.runScheduleNow('flow:f1')).resolves.toEqual({
      runId: 'flow:f1:2026-09-05T00:00:00.000Z',
      queued: true,
    });
  });

  it('이미 큐에 있으면 queued:false 를 그대로 전한다 (실패가 아니다)', async () => {
    mockSend(() => ({ success: true, runId: 'flow:f1:x', queued: false }));
    await expect(daily.runScheduleNow('flow:f1')).resolves.toEqual({
      runId: 'flow:f1:x',
      queued: false,
    });
  });

  it('이력 조회는 조건을 그대로 싣고 커서를 돌려준다', async () => {
    const sent: any[] = [];
    mockSend((message) => {
      sent.push(message);
      return { success: true, runs: [], matched: 40, nextCursor: 'c1' };
    });

    const page = await daily.queryHistory({
      scheduleId: 'flow:f1',
      status: ['failed'],
      limit: 20,
    });

    expect(sent[0]).toMatchObject({
      type: 'daily_history',
      scheduleId: 'flow:f1',
      status: ['failed'],
      limit: 20,
    });
    expect(page.nextCursor).toBe('c1');
    expect(page.matched).toBe(40);
  });

  it('가져오기는 미리보기와 실제 넣기를 서로 다른 메시지로 보낸다', async () => {
    const sent: any[] = [];
    mockSend((message) => {
      sent.push(message);
      return message.type === 'rr_import_flow_preview'
        ? { success: true, flows: [{ id: 'f1', name: 'a', stepCount: 2, conflict: true }] }
        : { success: true, imported: [{ oldId: 'f1', newId: 'f9', name: 'a (복사)' }] };
    });

    await daily.importFlowPreview('{}');
    await daily.importFlow('{}', 'copy');

    expect(sent[0].type).toBe('rr_import_flow_preview');
    expect(sent[1]).toMatchObject({ type: 'rr_import_flow', mode: 'copy' });
  });

  it('백그라운드가 실패로 답하면 예외가 된다', async () => {
    mockSend(() => ({ success: false, error: 'schedule limit reached' }));
    await expect(daily.removeSchedule('flow:f1')).rejects.toThrow('schedule limit reached');
  });

  it('답이 없으면 조용히 성공으로 보지 않는다', async () => {
    mockSend(() => undefined);
    await expect(daily.listSchedules()).rejects.toThrow('no response from background');
  });
});
