/**
 * flow-run-tool-limits.test.ts
 *
 * 2026-09-05 Codex 검토 항목 3(리스 보유)·4(타임아웃 abort)·7(바이너리 누출)·9(미발행 흐름).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';

const WORK_TAB_ID = 99;

const mocks = vi.hoisted(() => ({
  handleCallTool: vi.fn(),
}));

vi.mock('@/entrypoints/background/tools', () => ({
  handleCallTool: mocks.handleCallTool,
}));

import {
  flowRunTool,
  summarizeRunResult,
  MAX_OUTPUTS_JSON_CHARS,
  MAX_FAILED_STEP_MESSAGE_CHARS,
} from '@/entrypoints/background/tools/record-replay';
import { MAX_FLOW_RUN_TIMEOUT_MS } from '@/utils/tool-watchdog';
import { hasTabLease } from '@/utils/tab-lock';
import { saveFlow, publishFlow } from '@/entrypoints/background/record-replay/flow-store';
import { IndexedDbStorage } from '@/entrypoints/background/record-replay/storage/indexeddb-manager';
import type { Flow } from '@/entrypoints/background/record-replay/types';
import { installTabStub, makeTab, type TabStub } from './_chrome-tab-stub';

let stub: TabStub;

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

function slowFlow(id: string): Flow {
  const nodes = [1, 2, 3, 4].map((n) => ({
    id: `n${n}`,
    type: 'extract',
    config: { selector: '#r', attr: 'text', saveAs: `r${n}` },
  }));
  return {
    id,
    name: id,
    version: 1,
    variables: [],
    nodes,
    edges: nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id })),
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

describe('record_replay_flow_run 의 실행 경계', () => {
  beforeEach(async () => {
    stub = installTabStub([makeTab({ id: WORK_TAB_ID, url: 'https://example.com/', windowId: 1 })]);
    mocks.handleCallTool.mockReset();
    mocks.handleCallTool.mockResolvedValue({ content: [], isError: false });
    await clearStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ---------------------------------------------------------------- 항목 9
  it('항목9: 발행되지 않은 흐름은 flow_not_published 로 거절한다', async () => {
    const flow = shotFlow('unpublished-flow');
    await saveFlow(flow, { notify: false });

    const res = await flowRunTool.execute({ flowId: flow.id, tabId: WORK_TAB_ID });

    expect((res as any).isError).toBe(true);
    expect(String((res as any).content?.[0]?.text)).toContain('flow_not_published');
    // 엔진이 아예 돌지 않는다.
    expect(mocks.handleCallTool).not.toHaveBeenCalled();
  });

  it('항목9: 발행 slug 로도 실행할 수 있다', async () => {
    const flow = shotFlow('published-flow');
    await saveFlow(flow, { notify: false });
    await publishFlow(flow, 'my-slug');

    const res = await flowRunTool.execute({ flowId: 'my-slug', tabId: WORK_TAB_ID });
    expect((res as any).isError).toBeFalsy();
    expect(parse(res).flowId).toBe('my-slug');
  });

  // ---------------------------------------------------------------- 항목 3
  it('항목3: run 이 도는 동안 작업 탭 리스를 쥐고 있다', async () => {
    const flow = shotFlow('lease-flow');
    await saveFlow(flow, { notify: false });
    await publishFlow(flow);

    let leaseSeen = false;
    mocks.handleCallTool.mockImplementation(async () => {
      if (hasTabLease(WORK_TAB_ID)) leaseSeen = true;
      return { content: [], isError: false };
    });

    await flowRunTool.execute({ flowId: flow.id, tabId: WORK_TAB_ID });

    expect(leaseSeen).toBe(true);
    // run 이 끝나면 리스도 풀린다.
    expect(hasTabLease(WORK_TAB_ID)).toBe(false);
  });

  // ---------------------------------------------------------------- 항목 4
  it('항목4: timeoutMs 를 넘기면 abort 해서 run_aborted 로 끝낸다', async () => {
    const flow = slowFlow('timeout-flow');
    await saveFlow(flow, { notify: false });
    await publishFlow(flow);

    mocks.handleCallTool.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { content: [], isError: false };
    });

    const res = await flowRunTool.execute({
      flowId: flow.id,
      tabId: WORK_TAB_ID,
      timeoutMs: 20,
      returnLogs: true,
    });

    const payload = parse(res);
    expect(payload.success).toBe(false);
    expect(String(payload.logs || '') + String(payload.failedStep?.message || '')).toContain(
      'run_aborted',
    );
    expect(payload.summary.total).toBeLessThan(4);
    // 리스는 정리가 끝난 뒤 풀린다.
    expect(hasTabLease(WORK_TAB_ID)).toBe(false);
  });

  it('항목4: run 타임아웃 상한은 10분이다', () => {
    expect(MAX_FLOW_RUN_TIMEOUT_MS).toBe(600_000);
  });

  // ---------------------------------------------------------------- 항목 7
  it('항목7: 스크린샷 변수는 base64 가 아니라 artifact 참조로 남는다', async () => {
    const flow = shotFlow('shot-flow');
    await saveFlow(flow, { notify: false });
    await publishFlow(flow);

    const base64 = 'A'.repeat(120_000);
    mocks.handleCallTool.mockImplementation(async (param: any) => {
      if (param?.name === TOOL_NAMES.BROWSER.SCREENSHOT) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                base64Data: base64,
                filename: 'mcp-screenshots/2026-09-05/workflow.png',
                fullPath: 'C:/Users/u/Downloads/mcp-screenshots/2026-09-05/workflow.png',
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

    expect(JSON.stringify(payload)).not.toContain('AAAAAAAAAA');
    expect(payload.outputs.shot).toMatchObject({
      kind: 'screenshot',
      filename: 'mcp-screenshots/2026-09-05/workflow.png',
    });
    expect(payload.outputs.shot.bytes).toBeGreaterThan(0);
  });
});

describe('summarizeRunResult 의 응답 크기 상한 (항목 7)', () => {
  const base: any = {
    runId: 'run_1',
    success: false,
    summary: { total: 3, success: 2, failed: 1, tookMs: 12 },
    url: null,
    outputs: { a: 1 },
    screenshots: { onFailure: null },
    paused: false,
    logs: [{ stepId: 'n2', status: 'failed', message: 'boom' }],
  };

  it('outputs 가 상한을 넘으면 통째로 싣지 않고 outputsTruncated 를 붙인다', () => {
    const out: any = summarizeRunResult(
      { ...base, outputs: { big: 'x'.repeat(MAX_OUTPUTS_JSON_CHARS + 10), small: 1 } },
      { tabId: 99, flowId: 'f' },
    );
    expect(out.outputsTruncated).toBe(true);
    expect(JSON.stringify(out).length).toBeLessThan(MAX_OUTPUTS_JSON_CHARS * 2);
    expect(out.outputs.big).toBeUndefined();
    expect(out.outputs.small).toBe(1);
  });

  it('상한 안이면 그대로 싣고 표시도 붙지 않는다', () => {
    const out: any = summarizeRunResult(base, { tabId: 99, flowId: 'f' });
    expect(out.outputs).toEqual({ a: 1 });
    expect(out.outputsTruncated).toBeFalsy();
  });

  it('failedStep.message 는 2000자에서 자른다', () => {
    const out: any = summarizeRunResult(
      { ...base, logs: [{ stepId: 'n2', status: 'failed', message: 'e'.repeat(9000) }] },
      { tabId: 99, flowId: 'f' },
    );
    expect(out.failedStep.message.length).toBeLessThanOrEqual(MAX_FAILED_STEP_MESSAGE_CHARS);
    expect(MAX_FAILED_STEP_MESSAGE_CHARS).toBe(2000);
  });
});
