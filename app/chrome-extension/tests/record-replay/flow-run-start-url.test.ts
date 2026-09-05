/**
 * record_replay_flow_run 의 시작 URL 폴백과 작업 탭 자동 생성
 * (2026-09-05 사이드패널 1단계 B, 3항).
 *
 * 예전에는 작업 탭이 없으면 게이트가 무조건 `no_work_tab` 으로 거절했다. 그래서 모델은
 * 흐름을 실행하기 전에 반드시 `chrome_navigate` 를 한 번 불러야 했고, 어느 주소로 가야
 * 하는지도 스스로 알아내야 했다. 녹화된 흐름은 자기가 녹화된 페이지를 알고 있으므로
 * (`flow.startUrl`) 그 값으로 백그라운드 작업 탭을 열 수 있다.
 *
 * 이 파일이 못박는 것:
 *   (c) `startUrl` 인자가 없으면 흐름의 `startUrl` 을 쓴다.
 *   (d) 작업 탭이 없고 시작 URL 이 있으면 백그라운드 작업 탭을 만들고 거기서 돈다.
 *       탭을 만드는 주체는 chrome_navigate 다 - 엔진이 탭을 고르지 않는다.
 *   (e) 작업 탭도 시작 URL 도 없을 때만 `no_work_tab` 으로 거절한다.
 *   (j) 만든 탭은 이 세션의 **작업 탭으로 등록**된다 (다음 호출부터 게이트가 주입한다).
 *   (k) 방금 연 시작 페이지로 다시 가는 첫 navigate 단계는 건너뛴다 (같은 페이지 두 번 로드
 *       방지, 2026-09-05 Codex 교차 리뷰 6).
 *   (l) key 단계의 `after.waitForNavigation` 을 재생기가 실제로 소비한다 (교차 리뷰 5).
 *
 * import 순서 주의: 도구 레지스트리(`tools/index.ts`)를 먼저 불러야 한다. 흐름 도구 →
 * 스케줄러 → 레지스트리 순으로 들어가면 순환 import 중간 상태를 보고 레지스트리가 깨진다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 도구 레지스트리 전체를 불러오는 스위트라 캐시가 식었을 때 기본 상한을 넘는다.
vi.setConfig({ testTimeout: 30000 });

import '@/entrypoints/background/tools';
import * as browserTools from '@/entrypoints/background/tools/browser';
import { flowRunTool } from '@/entrypoints/background/tools/record-replay';
import { getWorkTabId } from '@/utils/work-tab-manager';
import { saveFlow, publishFlow } from '@/entrypoints/background/record-replay/flow-store';
import { IndexedDbStorage } from '@/entrypoints/background/record-replay/storage/indexeddb-manager';
import type { Flow } from '@/entrypoints/background/record-replay/types';
import { installTabStub, makeTab, type TabStub } from './_chrome-tab-stub';

const WORK_TAB_ID = 99;
const FLOW_START_URL = 'https://example.com/flow-start';
const STEP_URL = 'https://example.com/step';

let stub: TabStub;

/** navigate 노드 하나짜리 흐름. `startUrl` 은 호출자가 정한다. */
function makeFlow(id: string, startUrl?: string): Flow {
  return {
    id,
    name: id,
    version: 1,
    variables: [],
    ...(startUrl ? { startUrl } : {}),
    nodes: [{ id: 'n1', type: 'navigate', config: { url: STEP_URL } }],
    edges: [],
    meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  } as unknown as Flow;
}

/** 녹화된 흐름의 모습: 첫 단계가 시작 페이지로 가는 navigate 다. */
function makeRecordedFlow(id: string, startUrl: string): Flow {
  return {
    id,
    name: id,
    version: 1,
    variables: [],
    startUrl,
    nodes: [
      { id: 'n1', type: 'navigate', config: { url: startUrl } },
      { id: 'n2', type: 'navigate', config: { url: STEP_URL } },
    ],
    edges: [{ id: 'e1', from: 'n1', to: 'n2', label: 'default' }],
    meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  } as unknown as Flow;
}

async function seed(flow: Flow): Promise<void> {
  await saveFlow(flow, { notify: false });
  await publishFlow(flow);
}

async function clearStore(): Promise<void> {
  for (const f of await IndexedDbStorage.flows.list()) await IndexedDbStorage.flows.delete(f.id);
  for (const p of await IndexedDbStorage.published.list())
    await IndexedDbStorage.published.delete(p.id);
}

/** chrome.tabs.update 로 지나간 URL 들 (실행 전 시작 페이지 맞추기가 여기 남는다). */
function updatedUrls(): string[] {
  const calls = (chrome.tabs.update as unknown as { mock: { calls: unknown[][] } }).mock.calls as
    | Array<[number, Record<string, unknown>]>
    | undefined;
  return (calls ?? [])
    .map(([, props]) => props?.url)
    .filter((u): u is string => typeof u === 'string');
}

function payloadOf(res: unknown): any {
  const text = (res as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
  return typeof text === 'string' ? JSON.parse(text) : undefined;
}

describe('flow_run 은 흐름의 시작 URL 로 작업 탭을 얻는다 (설계 B 3항)', () => {
  beforeEach(async () => {
    await clearStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('(c) startUrl 인자가 없으면 흐름의 startUrl 을 쓴다', async () => {
    stub = installTabStub([
      makeTab({ id: WORK_TAB_ID, url: 'https://example.com/elsewhere', windowId: 1 }),
    ]);
    await chrome.storage.local.set({ backgroundWorkMode: true });
    const flow = makeFlow('start-url-fallback', FLOW_START_URL);
    await seed(flow);

    // 게이트가 주입하는 것과 같은 형태로 작업 탭 id 를 넘긴다.
    const res = await flowRunTool.execute({ flowId: flow.id, tabId: WORK_TAB_ID });

    expect((res as any).isError).toBeFalsy();
    const payload = payloadOf(res);
    expect(payload.tabId).toBe(WORK_TAB_ID);
    // 첫 이동이 흐름의 시작 페이지다 (그 뒤에 흐름의 navigate 노드가 이어진다).
    expect(updatedUrls()[0]).toBe(FLOW_START_URL);
    // 새 탭을 만들지는 않았다 - 이미 작업 탭이 있었다.
    expect(stub.createdTabs).toEqual([]);
  });

  it('(d) 작업 탭이 없고 시작 URL 이 있으면 백그라운드 작업 탭을 만들어 거기서 돈다', async () => {
    stub = installTabStub([
      makeTab({ id: 11, url: 'https://private.test/inbox', windowId: 1, active: true }),
    ]);
    await chrome.storage.local.set({ backgroundWorkMode: true });
    const flow = makeFlow('start-url-creates-tab', FLOW_START_URL);
    await seed(flow);

    // tabId 없이 부른다 = 게이트가 주입할 작업 탭이 없었던 상황.
    const res = await flowRunTool.execute({ flowId: flow.id });

    expect((res as any).isError).toBeFalsy();
    const payload = payloadOf(res);
    expect(payload.tabSource).toBe('created_from_start_url');

    // 새 탭은 흐름의 시작 URL 로, 사용자 화면을 빼앗지 않는 백그라운드로 열렸다.
    expect(stub.createdTabs).toHaveLength(1);
    expect(stub.createdTabs[0].url).toBe(FLOW_START_URL);
    expect(stub.createdTabs[0].active).toBe(false);

    // 실행은 그 새 탭에서만 일어났다 - 사용자가 보고 있던 탭 11 은 건드리지 않았다.
    const createdId = payload.tabId as number;
    expect(createdId).not.toBe(11);
    expect(stub.touchedTabIds()).toContain(createdId);
    const activated = (
      (chrome.tabs.update as unknown as { mock: { calls: unknown[][] } }).mock.calls as Array<
        [number, Record<string, unknown>]
      >
    ).filter(([, props]) => props?.active === true);
    expect(activated).toEqual([]);
  });

  it('(j) 만든 탭은 이 세션의 작업 탭으로 등록된다', async () => {
    stub = installTabStub([
      makeTab({ id: 11, url: 'https://private.test/inbox', windowId: 1, active: true }),
    ]);
    await chrome.storage.local.set({ backgroundWorkMode: true });
    const flow = makeFlow('start-url-registers-work-tab', FLOW_START_URL);
    await seed(flow);

    expect(await getWorkTabId('default')).toBeNull();

    const res = await flowRunTool.execute({ flowId: flow.id });
    expect((res as any).isError).toBeFalsy();
    const createdId = payloadOf(res).tabId as number;

    // 탭을 만든 주체가 chrome_navigate 이므로 작업 탭 등록도 그쪽 규칙으로 끝났다.
    // 다음 호출부터는 게이트가 이 탭을 주입한다 (탭이 매번 새로 생기지 않는다).
    expect(await getWorkTabId('default')).toBe(createdId);
  });

  it('(k) 방금 연 시작 페이지로 다시 가는 첫 navigate 단계는 건너뛴다', async () => {
    stub = installTabStub([
      makeTab({ id: 11, url: 'https://private.test/inbox', windowId: 1, active: true }),
    ]);
    await chrome.storage.local.set({ backgroundWorkMode: true });
    const flow = makeRecordedFlow('start-url-skips-first-navigate', FLOW_START_URL);
    await seed(flow);

    const res = await flowRunTool.execute({ flowId: flow.id });
    expect((res as any).isError).toBeFalsy();

    // 시작 페이지는 탭을 만들 때 한 번만 읽는다. 준비 단계도, 첫 navigate 단계도
    // 같은 주소로 다시 이동시키지 않는다.
    expect(stub.createdTabs.map((t) => t.url)).toEqual([FLOW_START_URL]);
    expect(updatedUrls()).not.toContain(FLOW_START_URL);
    // 두 번째 단계는 그대로 돈다 (통째로 건너뛴 것이 아니다).
    expect(updatedUrls()).toContain(STEP_URL);
  });

  it('(e) 작업 탭도 시작 URL 도 없으면 no_work_tab 으로 거절한다', async () => {
    stub = installTabStub([
      makeTab({ id: 11, url: 'https://private.test/inbox', windowId: 1, active: true }),
    ]);
    await chrome.storage.local.set({ backgroundWorkMode: true });
    const flow = makeFlow('no-start-url');
    await seed(flow);

    const res = await flowRunTool.execute({ flowId: flow.id });

    expect((res as any).isError).toBe(true);
    const payload = payloadOf(res);
    expect(payload.error).toBe('no_work_tab');
    expect(payload.tool).toBe('record_replay_flow_run');
    // 거절이므로 탭을 만들지도, 사용자 탭을 찾아보지도 않았다.
    expect(stub.createdTabs).toEqual([]);
    expect(stub.callsTo('tabs.query')).toEqual([]);
  });
});

/**
 * (l) key 단계의 이동 대기 (2026-09-05 Codex 교차 리뷰 5).
 *
 * 녹화기는 엔터로 폼을 제출해 이동이 일어난 것을 관측하면 key 단계에
 * `after: { waitForNavigation: true }` 를 남긴다. 예전에는 재생기가 click/dblclick 에서만
 * 그 값을 읽어서 표시가 아무 일도 하지 않았고, 다음 단계가 이전 문서에서 대상을 찾다
 * 실패했다. 여기서는 **이동 대기가 실제로 걸렸는지**를 본다: 대기 구현이
 * `chrome.webNavigation.onCompleted` 에 리스너를 다는 유일한 코드다.
 */
describe('key 단계의 after.waitForNavigation 을 재생기가 소비한다 (교차 리뷰 5)', () => {
  const WORK_TAB = 99;

  /** 브라우저 도구를 전부 성공 스텁으로 바꾼다 (키 입력 자체는 이 테스트의 관심사가 아니다). */
  function stubBrowserTools(): void {
    for (const value of Object.values(browserTools) as any[]) {
      if (!value || typeof value !== 'object') continue;
      if (typeof value.name !== 'string' || typeof value.execute !== 'function') continue;
      vi.spyOn(value, 'execute').mockImplementation(async () => ({
        content: [{ type: 'text', text: '{}' }],
        isError: false,
      }));
    }
  }

  /** onCompleted 에 리스너가 붙었는지 세는 감시자. 붙는 즉시 원래 스텁으로 넘긴다. */
  function watchNavigationWait(): { calls: () => number } {
    const target = (chrome.webNavigation as any).onCompleted;
    const original = target.addListener.bind(target);
    const spy = vi.fn((fn: unknown) => original(fn));
    target.addListener = spy;
    return { calls: () => spy.mock.calls.length };
  }

  function keyFlow(id: string, withAfter: boolean): Flow {
    return {
      id,
      name: id,
      version: 1,
      variables: [],
      nodes: [
        {
          id: 'k1',
          type: 'key',
          config: {
            keys: 'Enter',
            ...(withAfter ? { expectsNavigation: true, after: { waitForNavigation: true } } : {}),
          },
        },
      ],
      edges: [],
      meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    } as unknown as Flow;
  }

  beforeEach(async () => {
    await clearStore();
    stub = installTabStub([makeTab({ id: WORK_TAB, url: STEP_URL, windowId: 1 })]);
    await chrome.storage.local.set({ backgroundWorkMode: true });
    stubBrowserTools();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('(l) key 단계에 after.waitForNavigation 이 있으면 이동이 끝날 때까지 기다린다', async () => {
    const withAfter = keyFlow('key-waits', true);
    await seed(withAfter);
    const watcher = watchNavigationWait();

    const res = await flowRunTool.execute({ flowId: withAfter.id, tabId: WORK_TAB });
    expect((res as any).isError).toBeFalsy();
    expect(payloadOf(res).success).toBe(true);
    expect(watcher.calls()).toBeGreaterThan(0);
  });

  it('after 표시가 없는 key 단계는 이동을 기다리지 않는다 (대조군)', async () => {
    const plain = keyFlow('key-plain', false);
    await seed(plain);
    const watcher = watchNavigationWait();

    const res = await flowRunTool.execute({ flowId: plain.id, tabId: WORK_TAB });
    expect((res as any).isError).toBeFalsy();
    expect(watcher.calls()).toBe(0);
  });
});
