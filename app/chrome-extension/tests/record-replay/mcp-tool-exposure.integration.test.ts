/**
 * auto-chrome-mcp fork(B): record_replay_flow_run / record_replay_list_published 의 노출 정책.
 *
 * 배경 — 두 도구는 확장의 tools/index.ts 에 디스패치로 등록돼 있지만, packages/shared 의
 * TOOL_SCHEMAS 에서 스키마가 주석 처리돼 tools/list 에 나오지 않는다.
 *
 * 2026-09-04 Codex 3차 검토(항목 3)로 **노출을 되돌렸다**. replay 엔진이 대상 탭을 스스로
 * 고르기 때문이다: rr-utils 의 ensureTab() 이 tabTarget 미지정·'current' 에서 사용자의 활성
 * 탭을 잡고, legacy step executor 와 대부분의 노드(click·fill·extract·assert·script·wait·
 * drag 등)가 ctx.tabId 를 무시하고 `chrome.tabs.query({active:true,currentWindow:true})` 를
 * 다시 한다(엔진·노드 전체 28곳/16파일). 그래서 백그라운드 작업 게이트가 작업 탭 id 를
 * 주입해도 소비하는 지점이 없다.
 *
 * 이 파일이 못박는 것:
 *   (1) 두 스키마가 tools/list 에 **없다** (발견 불가 = MCP 표면에서 사라짐)
 *   (2) 디스패치는 그대로 등록돼 있다 (사이드패널·내부 호출 경로 유지)
 *   (3) 백그라운드 작업 모드에서 flow_run 을 부르면 **작업 탭 유무와 무관하게** 거절하고,
 *       사용자 탭을 한 번도 조회하지 않는다 (사용자 탭 접근 0)
 *   (4) 모드를 끄면 예전처럼 엔진까지 실행된다 (기능 자체는 살아 있다)
 *   (5) 없는 flow 는 여전히 구조화된 "Flow not found" 오류다
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { TOOL_NAMES, TOOL_SCHEMAS } from 'auto-chrome-mcp-shared';
import { handleCallTool, REGISTERED_TOOL_NAMES } from '@/entrypoints/background/tools';
import { flowRunTool } from '@/entrypoints/background/tools/record-replay';
import { saveFlow, publishFlow } from '@/entrypoints/background/record-replay/flow-store';
import { IndexedDbStorage } from '@/entrypoints/background/record-replay/storage/indexeddb-manager';
import type { Flow } from '@/entrypoints/background/record-replay/types';

const FLOW_RUN = TOOL_NAMES.RECORD_REPLAY.FLOW_RUN;
const LIST_PUBLISHED = TOOL_NAMES.RECORD_REPLAY.LIST_PUBLISHED;

const USER_TAB = { id: 1, active: true, windowId: 1, url: 'https://user-page.test/' };

function parseResult(res: any): any {
  const text = res?.content?.[0]?.text;
  return typeof text === 'string' ? JSON.parse(text) : undefined;
}

/** 사용자 탭을 조회하는 모든 경로를 세는 목. 0 이어야 "사용자 탭 접근 0" 이다. */
function installTabSpies(options: { backgroundMode: boolean; workTabId?: number }) {
  const queries: any[] = [];
  const localStore: Record<string, unknown> = { rr_idb_migrated: true };
  if (options.backgroundMode === false) localStore.backgroundWorkMode = false;

  const sessionStore: Record<string, unknown> = {};
  if (typeof options.workTabId === 'number') {
    sessionStore.mcpWorkTabs = {
      default: { tabId: options.workTabId, lastUsedAt: Date.now(), owned: true },
    };
  }

  const toKeys = (keys: unknown): string[] =>
    Array.isArray(keys) ? (keys as string[]) : typeof keys === 'string' ? [keys] : [];
  const makeArea = (store: Record<string, unknown>) => ({
    get: vi.fn(async (keys: unknown) => {
      const out: Record<string, unknown> = {};
      for (const key of toKeys(keys)) if (key in store) out[key] = store[key];
      return out;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(store, items);
    }),
    remove: vi.fn(async () => undefined),
  });

  const chrome = (globalThis as any).chrome;
  chrome.storage.local = makeArea(localStore);
  chrome.storage.session = makeArea(sessionStore);
  chrome.tabs.query = vi.fn(async (q: any) => {
    queries.push(q);
    return [USER_TAB];
  });
  chrome.tabs.get = vi.fn(async (id: number) => ({ ...USER_TAB, id }));
  chrome.tabs.create = vi.fn(async (info: any) => ({ ...USER_TAB, ...info, id: 2 }));
  chrome.tabs.update = vi.fn(async () => USER_TAB);

  return { queries };
}

describe('record_replay 도구는 MCP 에 노출하지 않는다 (항목 3, 옵션 B)', () => {
  it('두 도구가 TOOL_SCHEMAS(=tools/list) 에 실려 있지 않다', () => {
    const names = TOOL_SCHEMAS.map((t) => t.name);
    expect(names).not.toContain(FLOW_RUN);
    expect(names).not.toContain(LIST_PUBLISHED);
  });

  it('디스패치 등록은 그대로다 (내부 호출 경로 유지)', () => {
    expect(REGISTERED_TOOL_NAMES).toContain(FLOW_RUN);
    expect(REGISTERED_TOOL_NAMES).toContain(LIST_PUBLISHED);
  });
});

describe('flow_run 은 백그라운드 작업 모드에서 사용자 탭을 건드리지 않는다 (항목 3)', () => {
  // 실제로 존재하는 flow 를 심어 둔다. 없는 flowId 로 부르면 flow 조회 단계에서 끝나
  // "게이트가 없어도 탭을 안 건드린다" 는 착시가 생긴다 — 엔진이 진짜로 돌 수 있는 상태에서
  // 거절되는지를 봐야 한다.
  const REAL_FLOW_ID = 'gate-proof-flow-1';

  beforeEach(async () => {
    installTabSpies({ backgroundMode: false });
    const flow: Flow = {
      id: REAL_FLOW_ID,
      name: 'gate-proof',
      version: 1,
      nodes: [{ id: 'n1', type: 'click', config: { selector: '#go' } } as any],
      edges: [],
    };
    await saveFlow(flow, { notify: false });
    await publishFlow(flow, 'gate-proof');
  });

  it('회귀(핵심): 작업 탭이 없으면 거절하고 탭 조회를 한 번도 하지 않는다', async () => {
    const spies = installTabSpies({ backgroundMode: true });

    const res = await handleCallTool({ name: FLOW_RUN, args: { flowId: REAL_FLOW_ID } });

    expect((res as any).isError).toBe(true);
    const payload = JSON.parse((res as any).content[0].text);
    expect(payload.error).toBe('background_mode_unsupported');
    expect(payload.tool).toBe(FLOW_RUN);
    // 사용자 탭 접근 0 — 활성 탭 조회가 한 번도 없어야 한다.
    expect(spies.queries.filter((q) => q && q.active === true)).toHaveLength(0);
  });

  it('회귀(핵심): 작업 탭이 있어도 거절한다 (엔진이 주입 tabId 를 소비하지 않으므로)', async () => {
    const spies = installTabSpies({ backgroundMode: true, workTabId: 777 });

    const res = await handleCallTool({ name: FLOW_RUN, args: { flowId: REAL_FLOW_ID } });

    expect((res as any).isError).toBe(true);
    expect(JSON.parse((res as any).content[0].text).error).toBe('background_mode_unsupported');
    expect(spies.queries.filter((q) => q && q.active === true)).toHaveLength(0);
  });

  it("tabTarget:'current' 로 명시해도 마찬가지로 거절한다", async () => {
    const spies = installTabSpies({ backgroundMode: true, workTabId: 777 });

    const res = await handleCallTool({
      name: FLOW_RUN,
      args: { flowId: REAL_FLOW_ID, tabTarget: 'current' },
    });

    expect((res as any).isError).toBe(true);
    expect(spies.queries.filter((q) => q && q.active === true)).toHaveLength(0);
  });

  it('list_published 는 탭을 쓰지 않으므로 모드 ON 에서도 그대로 동작한다', async () => {
    const spies = installTabSpies({ backgroundMode: true });

    const res = await handleCallTool({ name: LIST_PUBLISHED, args: {} });

    expect((res as any).isError).toBeFalsy();
    const payload = parseResult(res);
    expect(payload.success).toBe(true);
    expect(Array.isArray(payload.published)).toBe(true);
    expect(spies.queries.filter((q) => q && q.active === true)).toHaveLength(0);
  });
});

describe('record_replay 도구 디스패치·실행 (B)', () => {
  beforeEach(async () => {
    // 백그라운드 모드를 끈 상태 — 예전 동작(엔진 실행)이 살아 있는지 본다.
    installTabSpies({ backgroundMode: false });
    // 각 테스트가 깨끗한 flows/published 스토어에서 시작하도록 비운다.
    const flows = await IndexedDbStorage.flows.list();
    for (const f of flows) await IndexedDbStorage.flows.delete(f.id);
    const pub = await IndexedDbStorage.published.list();
    for (const p of pub) await IndexedDbStorage.published.delete(p.id);
  });

  it('없는 flowId 로 flow_run 하면 구조화된 "Flow not found" 오류를 준다', async () => {
    const res = await handleCallTool({ name: FLOW_RUN, args: { flowId: 'no-such-flow' } });
    expect((res as any).isError).toBe(true);
    const text = (res as any).content?.[0]?.text ?? '';
    expect(text).toContain('Flow not found');
  });

  it('storage 에 심은 최소 flow(navigate 1스텝)를 조회·실행 경로 끝까지 태운다', async () => {
    const flow: Flow = {
      id: 'test-flow-navigate-1',
      name: 'test-navigate',
      version: 1,
      nodes: [{ id: 'n1', type: 'navigate', config: { url: 'https://example.com' } } as any],
      edges: [],
    };
    await saveFlow(flow, { notify: false });
    await publishFlow(flow, 'test-navigate');

    // list_published 가 심은 flow 를 반영한다(스토리지→디스패치→목록 경로).
    const listRes = await handleCallTool({ name: LIST_PUBLISHED, args: {} });
    const listed = parseResult(listRes);
    expect(listed.success).toBe(true);
    expect(listed.published.map((p: any) => p.id)).toContain('test-flow-navigate-1');

    // flow_run 이 getFlow 로 flow 를 찾아 runFlow(=실행 엔진)까지 태운다. mocked chrome 이라 개별
    // 스텝은 실패할 수 있으나, 핵심은 "Flow not found" 가 아니라 엔진을 끝까지 돌려 RunResult 를 낸다는 것.
    let run: any;
    let threw: unknown;
    try {
      const runRes = await flowRunTool.execute({
        flowId: 'test-flow-navigate-1',
        tabTarget: 'current',
        timeoutMs: 2000,
      });
      run = parseResult(runRes);
    } catch (e) {
      threw = e;
    }
    // 어느 경로든 flow 조회는 통과해 엔진에 진입했어야 한다(발견 실패가 아니어야 한다).
    expect(String((threw as any)?.message ?? JSON.stringify(run))).not.toContain('Flow not found');
    if (!threw) {
      expect(run).toHaveProperty('summary'); // 엔진이 끝까지 돌아 RunResult 를 냈다
    }
  });
});
