/**
 * Flow Store Steps Stripping Contract Tests
 *
 * Verifies that flow-store correctly strips deprecated steps field before persistence:
 * - saveFlow() strips steps after normalization
 * - lazyNormalize() strips steps when persisting normalized flow
 * - importFlowFromJson() strips steps via saveFlow()
 *
 * These tests ensure new saves only contain the DAG model (nodes/edges).
 */

import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';

// Use vi.hoisted to ensure mocks are available before module load
const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  delete: vi.fn(),
  ensureMigratedFromLocal: vi.fn(),
  sendMessage: vi.fn(),
}));

// Mock IndexedDbStorage before importing flow-store
vi.mock('@/entrypoints/background/record-replay/storage/indexeddb-manager', () => ({
  ensureMigratedFromLocal: mocks.ensureMigratedFromLocal.mockResolvedValue(undefined),
  IndexedDbStorage: {
    flows: {
      save: mocks.save,
      get: mocks.get,
      list: mocks.list,
      delete: mocks.delete,
    },
    runs: { list: vi.fn().mockResolvedValue([]), replaceAll: vi.fn() },
    published: { list: vi.fn().mockResolvedValue([]), save: vi.fn(), delete: vi.fn() },
    schedules: { list: vi.fn().mockResolvedValue([]), save: vi.fn(), delete: vi.fn() },
  },
}));

// Mock chrome.runtime.sendMessage
vi.stubGlobal('chrome', {
  runtime: {
    sendMessage: mocks.sendMessage.mockResolvedValue(undefined),
  },
});

import {
  saveFlow,
  getFlow,
  importFlowFromJson,
  publishFlow,
} from '@/entrypoints/background/record-replay/flow-store';
import { IndexedDbStorage } from '@/entrypoints/background/record-replay/storage/indexeddb-manager';
import type { Flow } from '@/entrypoints/background/record-replay/types';

function createTestFlow(overrides: Partial<Flow> = {}): Flow {
  return {
    id: `test_flow_${Date.now()}`,
    name: 'Test Flow',
    version: 1,
    meta: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

describe('Flow Store steps stripping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.save.mockResolvedValue(undefined);
    mocks.get.mockResolvedValue(undefined);
    mocks.list.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('saveFlow strips steps', () => {
    it('saves flow without steps field when steps is present', async () => {
      const flow = createTestFlow({
        steps: [{ id: 's1', type: 'click' } as any],
        nodes: [{ id: 's1', type: 'click', config: {} }],
        edges: [],
      });

      await saveFlow(flow);

      expect(mocks.save).toHaveBeenCalledTimes(1);
      const savedFlow = mocks.save.mock.calls[0][0];
      expect(savedFlow).not.toHaveProperty('steps');
      expect(savedFlow.nodes).toHaveLength(1);
    });

    it('preserves flow without steps when no steps present', async () => {
      const flow = createTestFlow({
        nodes: [{ id: 's1', type: 'click', config: {} }],
        edges: [],
      });

      await saveFlow(flow);

      expect(mocks.save).toHaveBeenCalledTimes(1);
      const savedFlow = mocks.save.mock.calls[0][0];
      expect(savedFlow).not.toHaveProperty('steps');
      expect(savedFlow.nodes).toHaveLength(1);
    });

    it('normalizes and strips: generates nodes from steps then removes steps', async () => {
      // Flow with only steps (no nodes) - should normalize to nodes then strip steps
      const flow = createTestFlow({
        steps: [
          { id: 's1', type: 'click' } as any,
          { id: 's2', type: 'fill', value: 'test' } as any,
        ],
      });

      await saveFlow(flow);

      expect(mocks.save).toHaveBeenCalledTimes(1);
      const savedFlow = mocks.save.mock.calls[0][0];
      expect(savedFlow).not.toHaveProperty('steps');
      expect(savedFlow.nodes).toHaveLength(2);
      expect(savedFlow.edges).toHaveLength(1);
    });
  });

  describe('getFlow lazy normalize strips steps', () => {
    it('strips steps when lazy normalizing legacy flow', async () => {
      // Mock a legacy flow with only steps (no nodes)
      const legacyFlow = createTestFlow({
        id: 'legacy_flow',
        steps: [{ id: 's1', type: 'click' } as any],
        nodes: undefined,
      });
      mocks.get.mockResolvedValue(legacyFlow);

      const result = await getFlow('legacy_flow');

      // Flow returned to caller has nodes but NOT steps
      expect(result).toBeDefined();
      expect(result!.nodes).toHaveLength(1);
      expect(result).not.toHaveProperty('steps');

      // Saved flow should also not have steps
      expect(mocks.save).toHaveBeenCalledTimes(1);
      const savedFlow = mocks.save.mock.calls[0][0];
      expect(savedFlow).not.toHaveProperty('steps');
      expect(savedFlow.nodes).toHaveLength(1);
    });

    it('does not save but still strips steps when flow already has nodes', async () => {
      // Flow with nodes and steps - should not save but should strip steps on return
      const normalFlow = createTestFlow({
        id: 'normal_flow',
        steps: [{ id: 's1', type: 'click' } as any], // legacy steps still in storage
        nodes: [{ id: 's1', type: 'click', config: {} }],
        edges: [],
      });
      mocks.get.mockResolvedValue(normalFlow);

      const result = await getFlow('normal_flow');

      expect(result).toBeDefined();
      expect(result).not.toHaveProperty('steps'); // returned flow should NOT have steps
      expect(result!.nodes).toHaveLength(1);
      expect(mocks.save).not.toHaveBeenCalled(); // no re-save needed
    });
  });

  describe('importFlowFromJson strips steps', () => {
    it('imports flow with steps, saves without steps', async () => {
      const json = JSON.stringify({
        id: 'imported_flow',
        name: 'Imported Flow',
        version: 1,
        steps: [
          { id: 's1', type: 'click' },
          { id: 's2', type: 'fill', value: 'hello' },
        ],
      });

      await importFlowFromJson(json);

      expect(mocks.save).toHaveBeenCalledTimes(1);
      const savedFlow = mocks.save.mock.calls[0][0];
      expect(savedFlow).not.toHaveProperty('steps');
      expect(savedFlow.nodes).toHaveLength(2);
      expect(savedFlow.edges).toHaveLength(1);
    });

    it('imports flow with nodes, saves without steps', async () => {
      const json = JSON.stringify({
        id: 'imported_flow',
        name: 'Imported Flow',
        version: 1,
        nodes: [
          { id: 'n1', type: 'click', config: {} },
          { id: 'n2', type: 'fill', config: { value: 'hello' } },
        ],
        edges: [{ id: 'e1', from: 'n1', to: 'n2' }],
      });

      await importFlowFromJson(json);

      expect(mocks.save).toHaveBeenCalledTimes(1);
      const savedFlow = mocks.save.mock.calls[0][0];
      expect(savedFlow).not.toHaveProperty('steps');
      expect(savedFlow.nodes).toHaveLength(2);
    });

    it('handles flow array import', async () => {
      const json = JSON.stringify([
        { id: 'f1', name: 'Flow 1', steps: [{ id: 's1', type: 'click' }] },
        { id: 'f2', name: 'Flow 2', nodes: [{ id: 'n1', type: 'fill', config: {} }], edges: [] },
      ]);

      await importFlowFromJson(json);

      expect(mocks.save).toHaveBeenCalledTimes(2);

      // First flow: steps normalized and stripped
      const savedFlow1 = mocks.save.mock.calls[0][0];
      expect(savedFlow1.id).toBe('f1');
      expect(savedFlow1).not.toHaveProperty('steps');
      expect(savedFlow1.nodes).toHaveLength(1);

      // Second flow: already has nodes, no steps
      const savedFlow2 = mocks.save.mock.calls[1][0];
      expect(savedFlow2.id).toBe('f2');
      expect(savedFlow2).not.toHaveProperty('steps');
      expect(savedFlow2.nodes).toHaveLength(1);
    });
  });

  describe('edge cases', () => {
    it('handles empty steps array', async () => {
      const flow = createTestFlow({
        steps: [],
        nodes: [{ id: 'n1', type: 'click', config: {} }],
        edges: [],
      });

      await saveFlow(flow);

      const savedFlow = mocks.save.mock.calls[0][0];
      expect(savedFlow).not.toHaveProperty('steps');
    });

    it('preserves all other flow properties', async () => {
      const flow = createTestFlow({
        id: 'preserve_test',
        name: 'Preserve Test',
        description: 'Test description',
        version: 5,
        steps: [{ id: 's1', type: 'click' } as any],
        nodes: [{ id: 's1', type: 'click', config: {} }],
        edges: [],
        variables: [{ key: 'var1', type: 'string' }],
        meta: {
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
          domain: 'example.com',
          tags: ['test', 'example'],
        },
      });

      await saveFlow(flow);

      const savedFlow = mocks.save.mock.calls[0][0];
      expect(savedFlow.id).toBe('preserve_test');
      expect(savedFlow.name).toBe('Preserve Test');
      expect(savedFlow.description).toBe('Test description');
      expect(savedFlow.version).toBe(5);
      expect(savedFlow.variables).toHaveLength(1);
      expect(savedFlow.meta.domain).toBe('example.com');
      expect(savedFlow.meta.tags).toEqual(['test', 'example']);
    });
  });
});

/**
 * 2026-09-05 발행 전 검토 6: 발행 스냅샷은 도구 표면이 실제로 실행하는 내용이라 그대로
 * 영속된다. sensitive 변수의 기본값이 거기 실리면 비밀번호가 IndexedDB 에 평문으로 남는다.
 */
describe('publishFlow drops sensitive variable defaults from the snapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (IndexedDbStorage.published.save as any).mockResolvedValue(undefined);
    // publishFlow 는 slug 유일성 검사를 위해 발행 목록도 읽는다 (2026-09-05 교차 리뷰 3항).
    // restoreMocks 가 모듈 수준 구현을 지우므로 여기서 다시 깔아 준다.
    (IndexedDbStorage.published.list as any).mockResolvedValue([]);
  });

  it('sensitive 변수의 default 는 스냅샷에 저장되지 않는다', async () => {
    const flow = createTestFlow({
      id: 'pub_secret',
      name: 'Publish Secret',
      nodes: [{ id: 's1', type: 'click', config: {} }],
      edges: [],
      variables: [
        { key: 'pw', type: 'string', sensitive: true, default: 'hunter2' },
        { key: 'site', type: 'string', default: 'https://example.com' },
      ],
    });

    await publishFlow(flow);

    const saved = (IndexedDbStorage.published.save as any).mock.calls[0][0];
    const vars = saved.snapshot.variables as Array<Record<string, unknown>>;
    const pw = vars.find((v) => v.key === 'pw')!;
    expect(pw.sensitive).toBe(true);
    // 값 자체가 없어야 한다 (빈 문자열로 남겨도 스냅샷에 흔적이 남는다).
    expect('default' in pw).toBe(false);
    expect(JSON.stringify(saved)).not.toContain('hunter2');
    // sensitive 가 아닌 변수의 기본값은 흐름 설정이므로 그대로 둔다.
    expect(vars.find((v) => v.key === 'site')!.default).toBe('https://example.com');
  });

  it('원본 흐름 객체는 건드리지 않는다 (편집 중인 값이 사라지면 안 된다)', async () => {
    const flow = createTestFlow({
      id: 'pub_secret2',
      nodes: [{ id: 's1', type: 'click', config: {} }],
      edges: [],
      variables: [{ key: 'pw', type: 'string', sensitive: true, default: 'hunter2' }],
    });

    await publishFlow(flow);

    expect(flow.variables![0].default).toBe('hunter2');
  });
});
