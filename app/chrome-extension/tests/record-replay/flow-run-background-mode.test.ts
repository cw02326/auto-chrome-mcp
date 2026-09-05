/**
 * flow-run-background-mode.test.ts
 *
 * 2026-09-05 발행 전 검토 2: **흐름 실행에 실행 컨텍스트 모드가 없었다.**
 *
 * `record_replay_flow_run` 과 자동 트리거 실행은 사용자가 보고 있지 않은 실행이다. 그런데
 * 전역 무간섭 토글이 꺼져 있으면 게이트가 인자를 보정하지 않아, 흐름의 `navigate` 노드가
 * 예전 동작 그대로 `tabs.update({active:true})` 와 `windows.update({focused:true})` 를 불렀다.
 * 모델이 부른 흐름 하나가 사용자가 보던 화면을 통째로 가져갔다.
 *
 * 여기서는 도구를 흉내 내지 않는다. 진짜 `handleCallTool` 파이프라인(게이트·활성화 가드·
 * navigate 구현)을 그대로 지나게 하고, 화면을 바꾸는 크롬 호출이 **0회**인지 본다.
 *
 * import 순서 주의: 도구 레지스트리(`tools/index.ts`)를 먼저 불러야 한다. 흐름 도구 →
 * 스케줄러 → 레지스트리 순으로 들어가면 순환 import 중간 상태를 보고 레지스트리가 깨진다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 도구 레지스트리 전체를 불러오는 스위트라 캐시가 식었을 때 기본 상한을 넘는다.
vi.setConfig({ testTimeout: 20000 });

import '@/entrypoints/background/tools';
import { flowRunTool } from '@/entrypoints/background/tools/record-replay';
import { saveFlow, publishFlow } from '@/entrypoints/background/record-replay/flow-store';
import { IndexedDbStorage } from '@/entrypoints/background/record-replay/storage/indexeddb-manager';
import type { Flow } from '@/entrypoints/background/record-replay/types';
import { installTabStub, makeTab, type TabStub } from './_chrome-tab-stub';

const WORK_TAB_ID = 99;
const PAGE_URL = 'https://example.com/';

let stub: TabStub;

function navigateFlow(id: string): Flow {
  return {
    id,
    name: id,
    version: 1,
    variables: [],
    nodes: [{ id: 'n1', type: 'navigate', config: { url: PAGE_URL } }],
    edges: [],
    meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  } as unknown as Flow;
}

async function clearStore() {
  for (const f of await IndexedDbStorage.flows.list()) await IndexedDbStorage.flows.delete(f.id);
  for (const p of await IndexedDbStorage.published.list())
    await IndexedDbStorage.published.delete(p.id);
}

/** 화면을 바꾸는 호출만 골라 센다. */
function screenChangingCalls() {
  const tabCalls = (chrome.tabs.update as unknown as { mock: { calls: unknown[][] } }).mock
    .calls as Array<[number, Record<string, unknown>]> | undefined;
  const windowCalls = (chrome.windows.update as unknown as { mock: { calls: unknown[][] } }).mock
    .calls as Array<[number, Record<string, unknown>]> | undefined;
  return {
    activated: (tabCalls ?? []).filter(([, props]) => props?.active === true).map(([id]) => id),
    focused: (windowCalls ?? []).filter(([, props]) => props?.focused === true).map(([id]) => id),
  };
}

describe('흐름 실행은 전역 토글과 무관하게 무간섭이다 (발행 전 검토 2)', () => {
  beforeEach(async () => {
    stub = installTabStub([
      makeTab({ id: WORK_TAB_ID, url: PAGE_URL, windowId: 1, active: false }),
    ]);
    // 전역 무간섭 토글 OFF + 강제 포커스 ON: 예전 코드가 화면을 가장 많이 건드리던 조합이다.
    await chrome.storage.local.set({ backgroundWorkMode: false, forceFocusOnToolCall: true });
    await clearStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('전역 OFF 여도 flow_run 의 navigate 는 탭 활성화·창 포커스를 한 번도 하지 않는다', async () => {
    const flow = navigateFlow('bg-mode-flow');
    await saveFlow(flow, { notify: false });
    await publishFlow(flow);

    const res = await flowRunTool.execute({ flowId: flow.id, tabId: WORK_TAB_ID });
    expect((res as any).isError).toBeFalsy();

    const { activated, focused } = screenChangingCalls();
    expect(activated).toEqual([]);
    expect(focused).toEqual([]);
    // 실행 자체는 그 탭에서 돌았다 (아무 일도 안 한 것이 아니다).
    expect(stub.touchedTabIds()).toContain(WORK_TAB_ID);
  });
});
