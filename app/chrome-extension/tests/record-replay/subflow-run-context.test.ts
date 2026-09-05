/**
 * subflow-run-context.test.ts
 *
 * 2026-09-05 Codex 최종 확인 3: **하위 흐름이 부모의 마감·취소 신호를 버렸다.**
 *
 * `executeFlow` 노드의 `inline: false` 는 참조한 흐름을 별도 run 으로 돌린다. 그때 넘기던
 * 것은 탭·창·세션·레인뿐이었다. 마감(`deadlineAt`)도, 취소 신호(`signal`)도, 실행 컨텍스트
 * 모드도, 리스 토큰도 넘어가지 않았다.
 *
 * 결과: 부모가 1초 마감으로 끊겨도 하위 run 안의 대기는 아무것도 모른 채 끝까지 돌았다.
 * 응답을 기다리는 쪽은 이미 포기한 뒤라 그 시간은 통째로 좀비 실행이고, 그 사이 하위 run 은
 * 전역 토글만 보고 사용자 화면을 건드릴 수도 있었다.
 *
 * import 순서 주의: 도구 레지스트리를 먼저 불러야 순환 import 중간 상태를 보지 않는다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 40000 });

import '@/entrypoints/background/tools';
import { flowRunTool } from '@/entrypoints/background/tools/record-replay';
import { saveFlow, publishFlow } from '@/entrypoints/background/record-replay/flow-store';
import { IndexedDbStorage } from '@/entrypoints/background/record-replay/storage/indexeddb-manager';
import type { Flow } from '@/entrypoints/background/record-replay/types';
import { installTabStub, makeTab, type TabStub } from './_chrome-tab-stub';

const WORK_TAB_ID = 99;
const PAGE_URL = 'https://example.com/';
/** 부모가 준 예산. */
const PARENT_TIMEOUT_MS = 1_000;
/** 하위 흐름 안의 대기. 부모 예산보다 한참 길다. */
const CHILD_SLEEP_MS = 20_000;

let stub: TabStub;

function flowOf(id: string, nodes: unknown[]): Flow {
  return {
    id,
    name: id,
    version: 1,
    variables: [],
    nodes,
    edges: [],
    meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  } as unknown as Flow;
}

/** 20초를 그냥 기다리는 흐름 (`delay` 노드는 wait.sleep 스텝이 된다). */
function sleepingChild(id: string): Flow {
  return flowOf(id, [{ id: 'c1', type: 'delay', config: { sleep: CHILD_SLEEP_MS } }]);
}

/** 그 흐름을 **별도 run** 으로 부르는 부모 (inline:false). */
function parentCalling(id: string, childId: string): Flow {
  return flowOf(id, [
    { id: 'p1', type: 'executeFlow', config: { flowId: childId, inline: false, args: {} } },
  ]);
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

describe('하위 흐름은 부모의 마감·취소를 물려받는다 (최종 확인 3)', () => {
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

  it('부모 마감이 1초면 20초 대기하는 하위 흐름도 약 1초에 run_aborted 로 끝난다', async () => {
    const child = sleepingChild('sub-sleeper');
    await saveFlow(child, { notify: false });
    const parent = parentCalling('sub-parent', child.id);
    await saveFlow(parent, { notify: false });
    await publishFlow(parent);

    const startedAt = Date.now();
    const res = await flowRunTool.execute({
      flowId: parent.id,
      tabId: WORK_TAB_ID,
      timeoutMs: PARENT_TIMEOUT_MS,
      returnLogs: true,
    });
    const elapsed = Date.now() - startedAt;

    const payload = parse(res);
    // 예전에는 하위 run 의 20초 대기를 그대로 다 쓰고 나서야 부모가 멈췄다.
    // 느린 러너에서도 흔들리지 않도록 여유를 두되 20초와는 확실히 구분되는 값이다.
    expect(elapsed).toBeLessThan(8_000);
    expect(payload.success).toBe(false);
    expect(String(payload.logs || '') + String(payload.failedStep?.message || '')).toContain(
      'run_aborted',
    );
  });
});
