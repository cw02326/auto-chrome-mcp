/**
 * auto-chrome-mcp fork — click/fill 의 "일시적 실패 1회 자동 재시도".
 *
 * 계약:
 *  - **전송 전 실패**(가림, zero_size, 뷰포트 밖, detach)만 한 번 더 시도한다.
 *    응답만 잃은 실패(포트 끊김, 컨텍스트 소실)는 이미 클릭이 먹었을 수 있으므로 재시도하지 않는다.
 *  - 재시도는 최초 실패 시점에 고정한 요소(ref)·프레임으로만 간다. selector 를 다시 해석하거나
 *    프레임을 다시 검색하지 않는다.
 *  - 재시도 후에도 실패하면 원래 오류 문구를 그대로 두고 접미사만 덧붙인다.
 *  - 재조회·재시도는 항상 같은 tabId 로만 한다 (사용자 탭 게이트 우회 금지).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolResult } from '@/common/tool-handler';
import {
  classifyInteractionFailure,
  clickTool,
  fillTool,
} from '@/entrypoints/background/tools/browser/interaction';

interface SendCall {
  tabId: number;
  action: string;
  frameId?: number;
  message: any;
}

type Responder = (message: any, call: number) => any;

interface InstallOptions {
  action: string;
  responders: Responder[];
  probe?: any;
  /** probe 메시지가 아예 실패하는 경우(측정 불가) */
  probeThrows?: boolean;
  /** ensureRefForSelector 응답 (요소 고정) */
  ensureRef?: any;
  tabs?: Array<{ id: number; url: string; status: string }>;
  /** webNavigation.getFrame 이 돌려줄 documentId 목록(호출 순서대로) */
  documentIds?: string[];
  /** webNavigation.getAllFrames 가 돌려줄 프레임 목록(iframe 폴백 경로용) */
  frames?: Array<{ frameId: number; url: string }>;
  /** frameId 별 고정 documentId — 프레임마다 다른 문서라는 사실을 재현한다 */
  frameDocumentIds?: Record<number, { documentId: string; url: string }>;
}

function installChrome(options: InstallOptions): {
  calls: SendCall[];
  actionCalls: () => number;
  getAllFramesCalls: () => number;
} {
  const calls: SendCall[] = [];
  let actionCalls = 0;
  let tabIndex = 0;
  let documentIndex = 0;
  let getAllFramesCalls = 0;
  const tabStates = options.tabs ?? [{ id: 1, url: 'https://example.com/', status: 'complete' }];

  const webNavigation: Record<string, unknown> = {
    getAllFrames: vi.fn(async () => {
      getAllFramesCalls++;
      return options.frames ?? [];
    }),
  };
  if (options.frameDocumentIds) {
    webNavigation.getFrame = vi.fn(async (details: { frameId?: number }) => {
      const map = options.frameDocumentIds!;
      const key = typeof details?.frameId === 'number' ? details.frameId : 0;
      return map[key] ?? null;
    });
  } else if (options.documentIds) {
    webNavigation.getFrame = vi.fn(async () => {
      const ids = options.documentIds!;
      const id = ids[Math.min(documentIndex, ids.length - 1)];
      documentIndex++;
      return { documentId: id, url: 'https://example.com/' };
    });
  }

  (globalThis as any).chrome = {
    tabs: {
      get: vi.fn(async (id: number) => {
        const state = tabStates[Math.min(tabIndex, tabStates.length - 1)];
        tabIndex++;
        return { id, url: state.url, status: state.status, windowId: 1 };
      }),
      query: vi.fn(async () => []),
      sendMessage: vi.fn(async (tabId: number, message: any, opts?: { frameId?: number }) => {
        calls.push({ tabId, action: message.action, frameId: opts?.frameId, message });
        if (String(message.action).endsWith('_ping')) return { status: 'pong' };
        if (String(message.action).endsWith('_probe_selector')) {
          if (options.probeThrows) throw new Error('Receiving end does not exist.');
          return options.probe ?? { success: true, found: true, visible: true, tagName: 'BUTTON' };
        }
        if (message.action === 'ensureRefForSelector') {
          return options.ensureRef ?? { success: true, ref: 'e-pinned' };
        }
        if (message.action === options.action) {
          const index = actionCalls;
          actionCalls++;
          const responder = options.responders[Math.min(index, options.responders.length - 1)];
          return responder(message, index);
        }
        return {};
      }),
    },
    scripting: { executeScript: vi.fn(async () => [{ result: undefined }]) },
    webNavigation,
  };

  return { calls, actionCalls: () => actionCalls, getAllFramesCalls: () => getAllFramesCalls };
}

/** 첫 content 블록의 text 를 좁혀서 꺼낸다 (ImageContent 에는 text 가 없다). */
function textOf(result: ToolResult): string {
  const first = result.content[0];
  return first && first.type === 'text' ? first.text : '';
}

function payloadOf(result: ToolResult): any {
  const text = textOf(result);
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

const OBSTRUCTED = {
  error: 'Element with selector "#buy" is not visible',
  elementInfo: { tagName: 'BUTTON' },
  obstruction: { reason: 'covered_by_other_element', likelyModal: true },
};

const CLICK_OK = {
  success: true,
  message: 'Element clicked successfully',
  elementInfo: { tagName: 'BUTTON' },
  navigationOccurred: false,
};

describe('classifyInteractionFailure', () => {
  it('스크롤·애니메이션으로 풀릴 수 있는 가림은 전송 전 실패다', () => {
    const error = Object.assign(new Error(OBSTRUCTED.error), { response: OBSTRUCTED });
    expect(classifyInteractionFailure(error)).toEqual({ retryable: true, reason: 'obstructed' });
  });

  it('가림 진단 자체가 실패한 경우는 근거가 없으므로 재시도하지 않는다', () => {
    const error = Object.assign(new Error('Element with selector "#a" is not visible'), {
      response: { obstruction: { reason: 'obstruction_check_failed' } },
    });
    expect(classifyInteractionFailure(error).retryable).toBe(false);
  });

  it('응답만 잃은 실패(포트 끊김·컨텍스트 소실)는 재시도하지 않는다 (항목 1)', () => {
    expect(
      classifyInteractionFailure(new Error('The message port closed before a response')),
    ).toEqual({ retryable: false, reason: 'post_dispatch_ambiguous' });
    expect(
      classifyInteractionFailure(
        new Error('Could not establish connection. Receiving end does not exist.'),
      ),
    ).toEqual({ retryable: false, reason: 'post_dispatch_ambiguous' });
    expect(classifyInteractionFailure(new Error('Extension context invalidated.'))).toEqual({
      retryable: false,
      reason: 'post_dispatch_ambiguous',
    });
  });

  it('요소를 못 찾은 실패는 영구 실패다', () => {
    expect(classifyInteractionFailure(new Error('Element with selector "#a" not found'))).toEqual({
      retryable: false,
      reason: 'permanent',
    });
    expect(
      classifyInteractionFailure(new Error('Element ref "e12" not found. Please call ...'))
        .retryable,
    ).toBe(false);
  });

  it('채울 수 없는 요소·잘못된 값은 영구 실패다', () => {
    expect(
      classifyInteractionFailure(new Error('#a is not fillable (<div>). chrome_fill_or_select ...'))
        .retryable,
    ).toBe(false);
    expect(
      classifyInteractionFailure(new Error('Range input requires a numeric value')).retryable,
    ).toBe(false);
  });

  it('응답 상한 초과는 재시도하지 않는다(또 상한만큼 기다릴 뿐)', () => {
    expect(
      classifyInteractionFailure(
        new Error("Content script in tab 3 did not respond to 'clickElement' within 60s."),
      ).retryable,
    ).toBe(false);
  });

  it('obstruction 정보가 없는 "is not visible"(fill)은 전송 전 실패로 본다', () => {
    expect(classifyInteractionFailure(new Error('#input is not visible'))).toEqual({
      retryable: true,
      reason: 'obstructed',
    });
  });

  it('"message channel closed" 도 응답만 잃은 실패로 본다 (항목 5)', () => {
    // 크롬이 실제로 내는 문구는 port 가 아니라 channel 이다.
    expect(
      classifyInteractionFailure(
        new Error(
          'A listener indicated an asynchronous response by returning true, ' +
            'but the message channel closed before a response was received',
        ),
      ),
    ).toEqual({ retryable: false, reason: 'post_dispatch_ambiguous' });
  });

  it('detach 된 요소는 전송 전 실패다', () => {
    expect(
      classifyInteractionFailure(new Error('Target element is no longer attached to the document')),
    ).toEqual({ retryable: true, reason: 'detached' });
  });
});

describe('chrome_click_element 자동 재시도', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('일시적으로 가려졌다가 풀리면 한 번 더 시도해 성공한다', async () => {
    const mock = installChrome({
      action: 'clickElement',
      responders: [() => OBSTRUCTED, () => CLICK_OK],
    });

    const result = await clickTool.execute({ tabId: 1, selector: '#buy' });
    const payload = payloadOf(result);

    expect(result.isError).toBe(false);
    expect(payload.success).toBe(true);
    expect(payload.retried).toBe(true);
    expect(payload.retryReason).toBe('obstructed');
    expect(mock.actionCalls()).toBe(2);
    // 재조회·재시도는 같은 탭으로만 간다 (사용자 탭 게이트 우회 금지)
    expect(mock.calls.every((call) => call.tabId === 1)).toBe(true);
  });

  it('재시도는 최초 실패 시점에 고정한 요소(ref)로만 간다 (항목 2)', async () => {
    const mock = installChrome({
      action: 'clickElement',
      responders: [() => OBSTRUCTED, () => CLICK_OK],
    });

    await clickTool.execute({ tabId: 1, selector: '#buy' });

    const clicks = mock.calls.filter((c) => c.action === 'clickElement');
    expect(clicks).toHaveLength(2);
    // 첫 시도는 원래대로 selector, 재시도는 고정된 ref 로 간다.
    expect(clicks[0].message.selector).toBe('#buy');
    expect(clicks[1].message.ref).toBe('e-pinned');
    expect(clicks[1].message.selector).toBeUndefined();
    // 재시도 판정 probe 도 selector 가 아니라 고정된 ref 를 본다.
    const probes = mock.calls.filter((c) => c.action.endsWith('_probe_selector'));
    expect(probes.length).toBeGreaterThan(0);
    expect(probes[probes.length - 1].message.ref).toBe('e-pinned');
  });

  it('요소를 고정할 수 없으면(사라졌으면) 재시도하지 않는다 (항목 2)', async () => {
    const mock = installChrome({
      action: 'clickElement',
      responders: [() => OBSTRUCTED, () => CLICK_OK],
      ensureRef: { success: false, error: 'not found' },
    });

    const result = await clickTool.execute({ tabId: 1, selector: '#buy' });

    expect(result.isError).toBe(true);
    expect(mock.actionCalls()).toBe(1);
  });

  it('재시도 중에는 프레임을 다시 검색하지 않는다 (항목 2)', async () => {
    const mock = installChrome({
      action: 'clickElement',
      responders: [() => OBSTRUCTED, () => ({ error: 'Element with ref "e-pinned" not found' })],
    });

    const result = await clickTool.execute({ tabId: 1, selector: '#buy' });

    expect(result.isError).toBe(true);
    expect(mock.actionCalls()).toBe(2);
    expect(mock.getAllFramesCalls()).toBe(0);
  });

  it('probe 를 할 수 없으면(측정 불가) 재시도하지 않는다 (항목 2)', async () => {
    const mock = installChrome({
      action: 'clickElement',
      responders: [() => OBSTRUCTED, () => CLICK_OK],
      probeThrows: true,
    });

    const result = await clickTool.execute({ tabId: 1, selector: '#buy' });

    expect(result.isError).toBe(true);
    expect(mock.actionCalls()).toBe(1);
  });

  it('영구 실패(요소 없음)는 재시도하지 않는다', async () => {
    const mock = installChrome({
      action: 'clickElement',
      responders: [() => ({ error: 'Element with selector "#gone" not found' })],
    });

    const result = await clickTool.execute({ tabId: 1, selector: '#gone' });

    expect(result.isError).toBe(true);
    expect(mock.actionCalls()).toBe(1);
    expect(textOf(result)).toContain('not found');
    expect(textOf(result)).not.toContain('retried');
  });

  it('재시도 후에도 실패하면 원래 오류 문구에 접미사만 붙는다 (항목 7)', async () => {
    const mock = installChrome({
      action: 'clickElement',
      responders: [() => OBSTRUCTED, () => OBSTRUCTED],
    });

    const result = await clickTool.execute({ tabId: 1, selector: '#buy' });
    const payload = payloadOf(result);

    expect(result.isError).toBe(true);
    // 가림 진단이 있는 기존 경로는 JSON 을 유지하되 문구에만 접미사가 붙는다.
    expect(payload.error).toBe(
      'Error performing click: Element with selector "#buy" is not visible (retried once: obstructed)',
    );
    expect(payload.obstruction.reason).toBe('covered_by_other_element');
    expect(mock.actionCalls()).toBe(2);
  });

  it('가림이 안 풀리면(요소가 여전히 안 보이면) 재시도하지 않는다', async () => {
    const mock = installChrome({
      action: 'clickElement',
      responders: [() => OBSTRUCTED],
      probe: { success: true, found: true, visible: false, tagName: 'BUTTON' },
    });

    const result = await clickTool.execute({ tabId: 1, selector: '#buy' });

    expect(result.isError).toBe(true);
    expect(mock.actionCalls()).toBe(1);
  });

  it('응답만 잃은 실패는 재시도하지 않고 이유를 알린다 (항목 1)', async () => {
    const mock = installChrome({
      action: 'clickElement',
      responders: [
        () => {
          throw new Error('The message port closed before a response was received.');
        },
        () => CLICK_OK,
      ],
    });

    const result = await clickTool.execute({ tabId: 1, selector: '#buy' });

    expect(result.isError).toBe(true);
    expect(mock.actionCalls()).toBe(1);
    expect(textOf(result)).toContain('post_dispatch_ambiguous');
  });

  it('클릭 뒤 페이지가 이동했으면 재시도하지 않는다 (두 번 누르기 방지)', async () => {
    const mock = installChrome({
      action: 'clickElement',
      responders: [() => OBSTRUCTED, () => CLICK_OK],
      tabs: [
        { id: 1, url: 'https://example.com/', status: 'complete' },
        { id: 1, url: 'https://example.com/checkout', status: 'complete' },
      ],
    });

    const result = await clickTool.execute({ tabId: 1, selector: '#buy' });

    expect(result.isError).toBe(true);
    expect(mock.actionCalls()).toBe(1);
  });

  it('URL 이 같아도 문서가 바뀌었으면 재시도하지 않는다 (항목 1: documentId 비교)', async () => {
    const mock = installChrome({
      action: 'clickElement',
      responders: [() => OBSTRUCTED, () => CLICK_OK],
      documentIds: ['doc-before', 'doc-after'],
    });

    const result = await clickTool.execute({ tabId: 1, selector: '#buy' });

    expect(result.isError).toBe(true);
    expect(mock.actionCalls()).toBe(1);
  });

  it('문서가 그대로면 재시도한다 (documentId 비교가 정상 통과)', async () => {
    const mock = installChrome({
      action: 'clickElement',
      responders: [() => OBSTRUCTED, () => CLICK_OK],
      documentIds: ['doc-same'],
    });

    const payload = payloadOf(await clickTool.execute({ tabId: 1, selector: '#buy' }));

    expect(payload.success).toBe(true);
    expect(mock.actionCalls()).toBe(2);
  });

  it('재시도 응답까지 잃으면 "이미 먹었을 수 있다"를 반드시 알린다 (항목 1)', async () => {
    // 재시도를 보낸 뒤 포트가 끊기면 그 클릭이 먹었는지 알 수 없다. 원래 오류만 돌려주면
    // 모델이 "아무 일도 안 일어났다"고 읽고 다시 눌러 주문이 두 번 들어간다.
    const mock = installChrome({
      action: 'clickElement',
      responders: [
        () => OBSTRUCTED,
        () => {
          throw new Error('The message port closed before a response was received.');
        },
      ],
    });

    const result = await clickTool.execute({ tabId: 1, selector: '#buy' });
    const payload = payloadOf(result);

    expect(result.isError).toBe(true);
    expect(mock.actionCalls()).toBe(2);
    expect(payload.error).toBe(
      'Error performing click: Element with selector "#buy" is not visible ' +
        '(retried once: obstructed; retry response lost: the action may have already taken ' +
        'effect, verify page state before retrying)',
    );
  });

  it('재시도가 전송 전에 막힌 경우에는 "응답 유실" 경고를 붙이지 않는다 (항목 1)', async () => {
    const mock = installChrome({
      action: 'clickElement',
      responders: [() => OBSTRUCTED, () => ({ error: 'Element with ref "e-pinned" not found' })],
    });

    const payload = payloadOf(await clickTool.execute({ tabId: 1, selector: '#buy' }));

    expect(mock.actionCalls()).toBe(2);
    expect(payload.error).toContain('(retried once: obstructed)');
    expect(payload.error).not.toContain('response lost');
  });

  it('frameId 를 안 주면 top frame(0)으로 고정해 보낸다 (항목 2)', async () => {
    // frameId 를 비우면 tabs.sendMessage 가 모든 프레임으로 퍼져, 첫 시도에 응답한 프레임과
    // pin/probe/재시도가 향하는 프레임이 달라질 수 있다.
    const mock = installChrome({
      action: 'clickElement',
      responders: [() => OBSTRUCTED, () => CLICK_OK],
    });

    const payload = payloadOf(await clickTool.execute({ tabId: 1, selector: '#buy' }));

    expect(payload.success).toBe(true);
    expect(mock.calls.length).toBeGreaterThan(0);
    expect(mock.calls.every((call) => call.frameId === 0)).toBe(true);
    // top frame 응답 형식은 그대로 — frameId 를 싣지 않는다.
    expect(payload.frameId).toBeUndefined();
  });

  it('iframe 폴백 뒤에는 그 프레임의 문서를 기준으로 비교한다 (항목 3)', async () => {
    // top frame 에서 못 찾아 iframe 으로 넘어갔는데 기준값이 top frame 의 documentId 로 남으면,
    // 프레임이 다르다는 이유만으로 "이동했다"고 오판해 재시도가 항상 막힌다.
    const mock = installChrome({
      action: 'clickElement',
      responders: [
        () => ({ error: 'Element with selector "#buy" not found' }),
        () => OBSTRUCTED,
        () => CLICK_OK,
      ],
      frames: [
        { frameId: 0, url: 'https://example.com/' },
        { frameId: 5, url: 'https://pay.example.com/widget' },
      ],
      frameDocumentIds: {
        0: { documentId: 'doc-top', url: 'https://example.com/' },
        5: { documentId: 'doc-iframe', url: 'https://pay.example.com/widget' },
      },
    });

    const payload = payloadOf(await clickTool.execute({ tabId: 1, selector: '#buy' }));

    expect(payload.success).toBe(true);
    expect(payload.retried).toBe(true);
    expect(payload.frameId).toBe(5);
    expect(mock.actionCalls()).toBe(3);
    // 재시도는 폴백으로 확정된 프레임으로만 간다.
    const clicks = mock.calls.filter((c) => c.action === 'clickElement');
    expect(clicks[clicks.length - 1].frameId).toBe(5);
  });

  it('성공한 첫 시도에는 retried 를 붙이지 않는다(기존 응답 유지)', async () => {
    const mock = installChrome({ action: 'clickElement', responders: [() => CLICK_OK] });

    const payload = payloadOf(await clickTool.execute({ tabId: 1, selector: '#buy' }));

    expect(payload.success).toBe(true);
    expect(payload.retried).toBeUndefined();
    expect(mock.actionCalls()).toBe(1);
  });
});

describe('chrome_fill_or_select 자동 재시도', () => {
  it('입력칸이 잠깐 안 보였다가 나타나면 한 번 더 시도해 성공한다', async () => {
    const mock = installChrome({
      action: 'fillElement',
      responders: [
        () => ({ error: 'Element with selector "#email" is not visible' }),
        () => ({ success: true, message: 'Fill operation successful', elementInfo: {} }),
      ],
    });

    const payload = payloadOf(
      await fillTool.execute({ tabId: 1, selector: '#email', value: 'a@b.c' }),
    );

    expect(payload.success).toBe(true);
    expect(payload.retried).toBe(true);
    expect(payload.retryReason).toBe('obstructed');
    expect(mock.actionCalls()).toBe(2);
  });

  it('재시도 후에도 실패하면 기존 plain text 오류에 접미사만 붙는다 (항목 7)', async () => {
    const mock = installChrome({
      action: 'fillElement',
      responders: [() => ({ error: '#email is not visible' })],
    });

    const result = await fillTool.execute({ tabId: 1, selector: '#email', value: 'a@b.c' });

    expect(result.isError).toBe(true);
    expect(mock.actionCalls()).toBe(2);
    expect(textOf(result)).toBe(
      'Error filling element: #email is not visible (retried once: obstructed)',
    );
  });

  it('iframe 폴백 뒤에는 그 프레임의 문서를 기준으로 비교한다 (항목 3)', async () => {
    const mock = installChrome({
      action: 'fillElement',
      responders: [
        () => ({ error: 'Element with selector "#card" not found' }),
        () => ({ error: 'Element with selector "#card" is not visible' }),
        () => ({ success: true, message: 'Fill operation successful', elementInfo: {} }),
      ],
      frames: [
        { frameId: 0, url: 'https://example.com/' },
        { frameId: 5, url: 'https://pay.example.com/widget' },
      ],
      frameDocumentIds: {
        0: { documentId: 'doc-top', url: 'https://example.com/' },
        5: { documentId: 'doc-iframe', url: 'https://pay.example.com/widget' },
      },
    });

    const payload = payloadOf(
      await fillTool.execute({ tabId: 1, selector: '#card', value: '4242' }),
    );

    expect(payload.success).toBe(true);
    expect(payload.retried).toBe(true);
    expect(payload.frameId).toBe(5);
    expect(mock.actionCalls()).toBe(3);
  });

  it('채울 수 없는 요소는 재시도하지 않는다', async () => {
    const mock = installChrome({
      action: 'fillElement',
      responders: [
        () => ({
          error: '#box is not fillable (<div>). chrome_fill_or_select supports INPUT, TEXTAREA...',
        }),
      ],
    });

    const result = await fillTool.execute({ tabId: 1, selector: '#box', value: 'x' });

    expect(result.isError).toBe(true);
    expect(mock.actionCalls()).toBe(1);
  });
});
