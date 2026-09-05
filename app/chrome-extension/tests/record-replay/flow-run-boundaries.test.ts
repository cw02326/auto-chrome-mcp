/**
 * flow-run-boundaries.test.ts
 *
 * 2026-09-05 Codex 재확인 항목 2·4·6·7 의 회귀 테스트.
 *
 * 2. 리스가 탭 이동을 따라가지 않았다 — 흐름이 자기가 연 탭으로 옮겨가면 그 탭에는
 *    아무 잠금도 없어 다른 세션이 끼어들 수 있었다.
 * 4. 발행 경계 우회 — slug 와 다른 흐름의 draft id 가 겹치면 draft 가 실행됐고,
 *    발행 후 수정한 draft 가 발행본 대신 실행됐다.
 * 6. `tabTarget:'new'` 로 도구가 만든 탭이 run 소유로 등록되지 않아 abort 정리에서 빠졌다.
 * 7. 스크린샷 노드가 크기 계산만을 위해 base64 를 텍스트로 돌려받았다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';

const WORK_TAB_ID = 4401;
const FIRST_NEW_TAB_ID = 620;

const mocks = vi.hoisted(() => ({
  handleCallTool: vi.fn(),
}));

vi.mock('@/entrypoints/background/tools', () => ({
  handleCallTool: mocks.handleCallTool,
}));

import { flowRunTool } from '@/entrypoints/background/tools/record-replay';
import { saveFlow, publishFlow } from '@/entrypoints/background/record-replay/flow-store';
import { IndexedDbStorage } from '@/entrypoints/background/record-replay/storage/indexeddb-manager';
import { getTabLeaseOwner, hasTabLease } from '@/utils/tab-lock';
import type { Flow } from '@/entrypoints/background/record-replay/types';
import { installTabStub, makeTab, type TabStub } from './_chrome-tab-stub';

let stub: TabStub;

function navFlow(id: string, url: string): Flow {
  return {
    id,
    name: id,
    version: 1,
    variables: [],
    nodes: [{ id: 'n1', type: 'navigate', config: { url } }],
    edges: [],
    meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  } as unknown as Flow;
}

function openTabFlow(id: string): Flow {
  return {
    id,
    name: id,
    version: 1,
    variables: [],
    nodes: [
      { id: 'n1', type: 'openTab', config: { url: 'https://example.com/work' } },
      { id: 'n2', type: 'extract', config: { selector: '#r', attr: 'text', saveAs: 'r' } },
    ],
    edges: [{ from: 'n1', to: 'n2' }],
    meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  } as unknown as Flow;
}

/**
 * 첫 노드에서 오래 자는 흐름. timeoutMs 를 짧게 주면 그 sleep 한가운데서 abort 가 걸린다.
 * (sleep 은 signal 을 보므로 즉시 풀린다 — 재확인 항목 3.)
 */
function slowFlow(id: string): Flow {
  return {
    id,
    name: id,
    version: 1,
    variables: [],
    nodes: [
      { id: 'n1', type: 'wait', config: { condition: { sleep: 60_000 } } },
      { id: 'n2', type: 'extract', config: { selector: '#r', attr: 'text', saveAs: 'r' } },
    ],
    edges: [{ from: 'n1', to: 'n2' }],
    meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  } as unknown as Flow;
}

function shotFlow(id: string): Flow {
  return {
    id,
    name: id,
    version: 1,
    variables: [],
    nodes: [{ id: 'n1', type: 'screenshot', config: { saveAs: 'shot' } }],
    edges: [],
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

describe('flow_run 의 실행 경계 (재확인 항목 2·4·6·7)', () => {
  beforeEach(async () => {
    stub = installTabStub(
      [makeTab({ id: WORK_TAB_ID, url: 'https://example.com/', windowId: 1 })],
      FIRST_NEW_TAB_ID,
    );
    mocks.handleCallTool.mockReset();
    mocks.handleCallTool.mockResolvedValue({ content: [], isError: false });
    await clearStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ------------------------------------------------------------------ 항목 2
  it('항목2: 흐름이 옮겨간 탭에도 같은 토큰의 리스가 걸린다', async () => {
    const flow = openTabFlow('lease-follow-flow');
    await saveFlow(flow, { notify: false });
    await publishFlow(flow);

    const owners: Array<{ tabId: number; owner: string | undefined; token: unknown }> = [];
    mocks.handleCallTool.mockImplementation(async (param: any) => {
      const tabId = param?.args?.tabId;
      if (typeof tabId === 'number') {
        owners.push({ tabId, owner: getTabLeaseOwner(tabId), token: param?.args?._leaseToken });
      }
      return { content: [], isError: false };
    });

    await flowRunTool.execute({ flowId: flow.id, tabId: WORK_TAB_ID });

    const onNewTab = owners.filter((o) => o.tabId === FIRST_NEW_TAB_ID);
    expect(onNewTab.length).toBeGreaterThan(0);
    for (const call of onNewTab) {
      // 새 탭에도 run 의 토큰으로 리스가 걸려 있어야 한다.
      expect(call.owner).toBeTruthy();
      expect(call.owner).toBe(call.token);
    }
    // run 이 끝나면 두 탭 모두 풀린다.
    expect(hasTabLease(FIRST_NEW_TAB_ID)).toBe(false);
    expect(hasTabLease(WORK_TAB_ID)).toBe(false);
  });

  // ------------------------------------------------------------------ 항목 4
  it('항목4: slug 와 다른 흐름의 draft id 가 겹쳐도 발행본이 실행된다', async () => {
    const published = navFlow('published-source', 'https://published.test/');
    await saveFlow(published, { notify: false });
    await publishFlow(published, 'shared-name');

    // 발행되지 않은 draft 가 공교롭게 그 slug 를 id 로 가진다.
    const draft = navFlow('shared-name', 'https://draft.test/');
    await saveFlow(draft, { notify: false });

    const urls: string[] = [];
    mocks.handleCallTool.mockImplementation(async (param: any) => {
      if (param?.name === TOOL_NAMES.BROWSER.NAVIGATE && typeof param?.args?.url === 'string') {
        urls.push(param.args.url);
      }
      return { content: [], isError: false };
    });

    await flowRunTool.execute({ flowId: 'shared-name', tabId: WORK_TAB_ID });

    expect(urls).toContain('https://published.test/');
    expect(urls).not.toContain('https://draft.test/');
  });

  it('항목4: 발행 후 수정된 draft 가 아니라 발행 시점 스냅샷이 실행된다', async () => {
    const flow = navFlow('edited-flow', 'https://published.test/');
    await saveFlow(flow, { notify: false });
    await publishFlow(flow);

    // 발행한 뒤 draft 를 고친다 (버전은 그대로 — 편집이 버전을 올리지 않는다).
    await saveFlow(navFlow('edited-flow', 'https://edited.test/'), { notify: false });

    const urls: string[] = [];
    mocks.handleCallTool.mockImplementation(async (param: any) => {
      if (param?.name === TOOL_NAMES.BROWSER.NAVIGATE && typeof param?.args?.url === 'string') {
        urls.push(param.args.url);
      }
      return { content: [], isError: false };
    });

    await flowRunTool.execute({ flowId: 'edited-flow', tabId: WORK_TAB_ID });

    expect(urls).toContain('https://published.test/');
    expect(urls).not.toContain('https://edited.test/');
  });

  it('항목4: record_replay_list_published 는 흐름 본문을 싣지 않는다', async () => {
    const flow = navFlow('listed-flow', 'https://published.test/');
    await saveFlow(flow, { notify: false });
    await publishFlow(flow);

    const { listPublishedFlowsTool } = await import('@/entrypoints/background/tools/record-replay');
    const payload = parse(await listPublishedFlowsTool.execute());
    expect(payload.published).toHaveLength(1);
    expect(JSON.stringify(payload)).not.toContain('https://published.test/');
  });

  // ------------------------------------------------------------------ 항목 6
  it("항목6: tabTarget:'new' 로 만든 탭도 abort 정리 대상이다", async () => {
    const flow = slowFlow('new-tab-abort-flow');
    await saveFlow(flow, { notify: false });
    await publishFlow(flow);

    await flowRunTool.execute({
      flowId: flow.id,
      tabId: WORK_TAB_ID,
      tabTarget: 'new',
      timeoutMs: 20,
    });

    expect(stub.removedTabs).toContain(FIRST_NEW_TAB_ID);
    // 게이트가 준 작업 탭은 건드리지 않는다.
    expect(stub.removedTabs).not.toContain(WORK_TAB_ID);
  });

  // ------------------------------------------------------------------ 항목 7
  it('항목7: 스크린샷 노드는 base64 를 받지 않고 응답의 bytes 를 쓴다', async () => {
    const flow = shotFlow('shot-bytes-flow');
    await saveFlow(flow, { notify: false });
    await publishFlow(flow);

    let shotArgs: any;
    mocks.handleCallTool.mockImplementation(async (param: any) => {
      if (param?.name === TOOL_NAMES.BROWSER.SCREENSHOT) {
        shotArgs = param.args;
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                savedFilename: 'mcp-screenshots/2026-09-05/workflow.png',
                fullPath: 'C:/Users/u/Downloads/mcp-screenshots/2026-09-05/workflow.png',
                bytes: 82_341,
              }),
            },
          ],
          isError: false,
        };
      }
      return { content: [], isError: false };
    });

    const res = await flowRunTool.execute({ flowId: flow.id, tabId: WORK_TAB_ID });
    const payload = parse(res);

    // base64 를 텍스트로 달라고 요청하지 않는다.
    expect(shotArgs.includeBase64InText).toBeUndefined();
    expect(payload.outputs.shot).toMatchObject({
      kind: 'screenshot',
      filename: 'mcp-screenshots/2026-09-05/workflow.png',
      bytes: 82_341,
    });
  });

  it('항목7: 응답에 bytes 가 없으면 chrome.downloads 로 파일 크기를 조회한다', async () => {
    const flow = shotFlow('shot-fallback-flow');
    await saveFlow(flow, { notify: false });
    await publishFlow(flow);

    const search = vi.fn(async () => [{ id: 7, fileSize: 4242, totalBytes: 4242 }]);
    (globalThis as any).chrome.downloads = { search };

    mocks.handleCallTool.mockImplementation(async (param: any) => {
      if (param?.name === TOOL_NAMES.BROWSER.SCREENSHOT) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                savedFilename: 'shot.png',
                downloadId: 7,
              }),
            },
          ],
          isError: false,
        };
      }
      return { content: [], isError: false };
    });

    const payload = parse(await flowRunTool.execute({ flowId: flow.id, tabId: WORK_TAB_ID }));
    expect(search).toHaveBeenCalled();
    expect(payload.outputs.shot.bytes).toBe(4242);
  });
});
