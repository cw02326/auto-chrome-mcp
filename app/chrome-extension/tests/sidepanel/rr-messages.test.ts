/**
 * 사이드패널이 백그라운드로 보내는 record-replay 메시지 (2026-09-05 사이드패널 1단계 A).
 *
 * 확인하려는 것.
 *   1. "저장하고 발행" 이 실제로 `RR_PUBLISH_FLOW` 를 부른다 (예전에는 부르는 코드가 없어
 *      `record_replay_list_published` 가 늘 비어 있었다).
 *   2. 시험 실행이 자기가 연 백그라운드 탭 id 를 실행에 고정해서 넘긴다.
 *   3. 백그라운드가 실패로 답하면 조용히 넘어가지 않고 예외가 된다.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import * as rr from '@/entrypoints/sidepanel/utils/rr-messages';

function mockSend(handler: (message: any) => unknown) {
  (chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (message: any) => handler(message),
  );
}

describe('rr-messages', () => {
  beforeEach(() => {
    (chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>).mockReset();
  });

  it('발행은 RR_PUBLISH_FLOW 를 흐름 id 와 함께 보낸다', async () => {
    const sent: any[] = [];
    mockSend((message) => {
      sent.push(message);
      return { success: true };
    });

    await rr.publishFlow('flow_1');

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe(BACKGROUND_MESSAGE_TYPES.RR_PUBLISH_FLOW);
    expect(sent[0].flowId).toBe('flow_1');
    // slug 를 주지 않으면 백그라운드가 흐름 이름에서 만든다.
    expect(sent[0].slug).toBeUndefined();
  });

  it('흐름 본문을 함께 주면 발행 메시지에 그대로 실린다', async () => {
    const sent: any[] = [];
    mockSend((message) => {
      sent.push(message);
      return { success: true };
    });

    const flow = { id: 'flow_1', name: 'example 링크 클릭 시연', version: 2 } as any;
    await rr.publishFlow('flow_1', { flow });

    expect(sent[0].type).toBe(BACKGROUND_MESSAGE_TYPES.RR_PUBLISH_FLOW);
    expect(sent[0].flow).toBe(flow);
    expect(sent[0].flow.name).toBe('example 링크 클릭 시연');
  });

  it('발행 해제는 RR_UNPUBLISH_FLOW 를 보낸다', async () => {
    const sent: any[] = [];
    mockSend((message) => {
      sent.push(message);
      return { success: true };
    });

    await rr.unpublishFlow('flow_1');

    expect(sent[0].type).toBe(BACKGROUND_MESSAGE_TYPES.RR_UNPUBLISH_FLOW);
    expect(sent[0].flowId).toBe('flow_1');
  });

  it('발행 목록을 읽어 온다', async () => {
    mockSend(() => ({
      success: true,
      published: [{ id: 'flow_1', slug: 'example', version: 3 }],
    }));

    const published = await rr.listPublished();

    expect(published).toEqual([{ id: 'flow_1', slug: 'example', version: 3 }]);
  });

  it('시험 실행은 탭 id 와 인자를 실어 보낸다', async () => {
    const sent: any[] = [];
    mockSend((message) => {
      sent.push(message);
      return {
        success: true,
        result: { success: true, summary: { total: 3, success: 3, failed: 0, tookMs: 1200 } },
      };
    });

    const result = await rr.runFlow('flow_1', {
      tabId: 42,
      args: { password: 'secret' },
      returnLogs: true,
    });

    expect(sent[0].type).toBe(BACKGROUND_MESSAGE_TYPES.RR_RUN_FLOW);
    expect(sent[0].tabId).toBe(42);
    expect(sent[0].options).toEqual({ args: { password: 'secret' }, returnLogs: true });
    expect(result.summary?.success).toBe(3);
  });

  it('백그라운드가 실패로 답하면 예외가 된다', async () => {
    mockSend(() => ({ success: false, error: 'flow not found' }));

    await expect(rr.publishFlow('missing')).rejects.toThrow('flow not found');
  });

  it('녹화 중지 응답에서 저장된 흐름 id 를 꺼낸다', async () => {
    mockSend(() => ({ success: true, flow: { id: 'flow_9' } }));

    await expect(rr.stopRecording()).resolves.toEqual({ flowId: 'flow_9', warning: undefined });
  });

  it('녹화 상태 스냅샷은 단계 수와 시작 시각을 함께 준다', async () => {
    mockSend(() => ({
      success: true,
      status: 'recording',
      flowId: 'flow_9',
      stepCount: 7,
      startedAt: '2026-09-05T01:00:00.000Z',
    }));

    const snapshot = await rr.getRecordingSnapshot();

    expect(snapshot.status).toBe('recording');
    expect(snapshot.stepCount).toBe(7);
    expect(snapshot.startedAt).toBe('2026-09-05T01:00:00.000Z');
  });
});
