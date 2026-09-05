/**
 * flow-run-deadline.test.ts
 *
 * 2026-09-05 발행 전 검토 3: **AbortSignal 이 실행 중인 도구 안까지 가지 않았다.**
 *
 * 흐름의 마감(`timeoutMs`)은 스텝 경계와 엔진의 대기 루프만 끊었다. 도구 하나가 마감을
 * 넘겨 매달리면 그 안에서는 아무도 신호를 보지 않으므로, 1초짜리 마감을 건 실행이 5초
 * 걸리는 도구 호출 하나 때문에 5초를 그대로 썼다. 응답을 기다리는 쪽은 이미 포기한 뒤라
 * 그 시간은 통째로 좀비 실행이다.
 *
 * 이제 마감을 `_deadlineAt` 로 모든 내부 호출에 실어 보내고, 파이프라인이 그것을 워치독
 * 상한으로 쓴다. 도구가 매달려도 마감에 끊기고, 실행은 `run_aborted` 로 닫히며 자기가 연
 * 탭을 정리한다.
 *
 * import 순서 주의: 도구 레지스트리를 먼저 불러야 순환 import 중간 상태를 보지 않는다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30000 });

import '@/entrypoints/background/tools';
import { flowRunTool } from '@/entrypoints/background/tools/record-replay';
import { saveFlow, publishFlow } from '@/entrypoints/background/record-replay/flow-store';
import { IndexedDbStorage } from '@/entrypoints/background/record-replay/storage/indexeddb-manager';
import type { Flow } from '@/entrypoints/background/record-replay/types';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { installTabStub, makeTab, type TabStub } from './_chrome-tab-stub';

const WORK_TAB_ID = 99;
const PAGE_URL = 'https://example.com/';
/** 도구 하나가 매달리는 시간. 흐름 마감(1초)보다 한참 길다. */
const HANG_MS = 5_000;
const FLOW_TIMEOUT_MS = 1_000;

let stub: TabStub;

/**
 * 노드마다 `handleCallTool` 로 내부 도구를 부르는 흐름. http 노드는 `chrome_network_request`
 * 를 지나고, 그 도구는 콘텐츠 스크립트에 메시지를 보내 응답을 기다린다.
 * 엔진이 직접 부르는 chrome API 는 이 검토의 대상이 아니다 - 마감이 닿아야 하는 것은
 * **도구 파이프라인을 지나는 호출**이다.
 */
function httpFlow(id: string): Flow {
  const nodes = [1, 2].map((n) => ({
    id: `n${n}`,
    type: 'http',
    config: { url: 'https://example.com/api', method: 'GET', saveAs: `r${n}` },
  }));
  return {
    id,
    name: id,
    version: 1,
    variables: [],
    nodes,
    edges: [{ from: 'n1', to: 'n2' }],
    meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  } as unknown as Flow;
}

async function clearStore() {
  for (const f of await IndexedDbStorage.flows.list()) await IndexedDbStorage.flows.delete(f.id);
  for (const p of await IndexedDbStorage.published.list())
    await IndexedDbStorage.published.delete(p.id);
}

function parse(res: any): any {
  const text = res?.content?.[0]?.text;
  return typeof text === 'string' ? JSON.parse(text) : undefined;
}

/**
 * 요청을 보낸 콘텐츠 스크립트가 응답하지 않는 상황 (멎은 페이지에서 실제로 일어난다).
 * `chrome_network_request` 는 여기서 5초를 기다린다 - 흐름 마감이 **도구 안까지** 닿는지가
 * 이 테스트의 질문이다.
 *
 * 매다는 것은 요청 메시지 하나뿐이다. 준비 단계의 핑까지 함께 매달면 마감이 시작되기도
 * 전에 시간이 다 가버려, 무엇이 끊겼는지 알 수 없는 테스트가 된다.
 */
function hangNetworkHelper(): void {
  (chrome.tabs.sendMessage as any).mockImplementation(async (_tabId: number, message: any) => {
    if (message?.action === TOOL_MESSAGE_TYPES.NETWORK_SEND_REQUEST) {
      await new Promise((resolve) => setTimeout(resolve, HANG_MS));
      return undefined;
    }
    return { success: false };
  });
}

describe('흐름 마감은 실행 중인 도구 호출까지 끊는다 (발행 전 검토 3)', () => {
  beforeEach(async () => {
    stub = installTabStub([
      makeTab({ id: WORK_TAB_ID, url: PAGE_URL, windowId: 1, active: false }),
    ]);
    await chrome.storage.local.set({ backgroundWorkMode: true });
    await clearStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('5초 걸리는 내부 도구 호출이 1초 마감에 끊기고 run_aborted 로 닫힌다', async () => {
    const flow = httpFlow('deadline-flow');
    await saveFlow(flow, { notify: false });
    await publishFlow(flow);
    hangNetworkHelper();

    const startedAt = Date.now();
    const res = await flowRunTool.execute({
      flowId: flow.id,
      tabId: WORK_TAB_ID,
      // run 이 자기 탭을 만들게 한다 - 마감에 끊긴 뒤 그 탭이 정리되는지도 함께 본다.
      tabTarget: 'new',
      timeoutMs: FLOW_TIMEOUT_MS,
      returnLogs: true,
    });
    const elapsed = Date.now() - startedAt;

    const payload = parse(res);
    // 마감 근처(1초)에서 끝난다. 도구가 매달린 5초를 그대로 쓰지 않는다.
    // 느린 러너에서도 흔들리지 않도록 여유를 두되 5초와는 확실히 구분되는 값이다.
    expect(elapsed).toBeLessThan(3_000);
    expect(payload.success).toBe(false);
    expect(String(payload.logs || '') + String(payload.failedStep?.message || '')).toContain(
      'run_aborted',
    );
    // run 이 만든 탭(tabTarget:'new')은 끊긴 뒤에도 정리된다.
    const createdTabIds = stub
      .callsTo('tabs.create')
      .map((t) => t.tabId)
      .filter((id): id is number => typeof id === 'number');
    expect(createdTabIds.length).toBeGreaterThan(0);
    for (const id of createdTabIds) {
      expect(stub.removedTabs).toContain(id);
      expect(stub.liveTabs.has(id)).toBe(false);
    }
  });
});
