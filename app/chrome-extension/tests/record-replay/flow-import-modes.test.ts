/**
 * 흐름 가져오기: 미리보기와 id 충돌 처리 (2026-09-05 사이드패널 2단계 D).
 *
 * 예전 `importFlowFromJson` 은 같은 id 가 있으면 아무 말 없이 덮어썼다. 내보낸 JSON 을
 * 다시 들여오는 것은 흔한 일이고, 그때 사라지는 것이 사용자가 그 사이에 고친 흐름이다.
 * 그래서 저장 전에 무엇이 들어오는지·무엇을 덮어쓰게 되는지 먼저 보여 주고, 덮어쓰기와
 * 복사 중 하나를 고르게 한다.
 *
 * 이 파일이 못박는 것:
 *   - 미리보기는 저장하지 않는다. 이름·단계 수·충돌 여부만 돌려준다.
 *   - `copy` 는 **겹치는 것만** 새 id 로 들여오고 이름 뒤에 " (복사)" 를 붙인다.
 *   - `overwrite` 는 예전 그대로 같은 id 를 덮어쓴다.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

// vitest 설정의 clearMocks 가 전역 chrome 스텁의 구현까지 지운다. 이 스위트는 flow-store 를
// 통해 chrome.storage 를 건드리므로 매 테스트마다 필요한 것만 다시 세운다.
function stubChromeStorage(): void {
  const local: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    runtime: { id: 'test', sendMessage: vi.fn().mockResolvedValue(undefined) },
    storage: {
      local: {
        get: vi.fn(async () => ({ ...local })),
        set: vi.fn(async (obj: Record<string, unknown>) => Object.assign(local, obj)),
        remove: vi.fn(async () => undefined),
      },
    },
  });
}

import {
  importFlowsFromJson,
  previewImportFlows,
  saveFlow,
  uniqueFlowId,
} from '@/entrypoints/background/record-replay/flow-store';
import { IndexedDbStorage } from '@/entrypoints/background/record-replay/storage/indexeddb-manager';
import type { Flow } from '@/entrypoints/background/record-replay/types';

function makeFlow(id: string, name: string, nodeCount = 2): Flow {
  return {
    id,
    name,
    version: 1,
    variables: [],
    nodes: Array.from({ length: nodeCount }, (_, i) => ({
      id: `n${i + 1}`,
      type: 'navigate',
      config: { url: `https://example.com/${i + 1}` },
    })),
    edges: [],
    meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  } as unknown as Flow;
}

async function clearFlows(): Promise<void> {
  for (const f of await IndexedDbStorage.flows.list()) await IndexedDbStorage.flows.delete(f.id);
}

describe('가져오기 미리보기 (저장하지 않는다)', () => {
  beforeEach(async () => {
    stubChromeStorage();
    await clearFlows();
  });

  it('이름·단계 수·충돌 여부를 돌려주고 저장소는 그대로다', async () => {
    await saveFlow(makeFlow('dup', '이미 있는 흐름'), { notify: false });
    const json = JSON.stringify({
      flows: [makeFlow('dup', '가져온 흐름', 3), makeFlow('fresh', '새 흐름', 1)],
    });

    const preview = await previewImportFlows(json);

    expect(preview).toEqual([
      { id: 'dup', name: '가져온 흐름', stepCount: 3, conflict: true },
      { id: 'fresh', name: '새 흐름', stepCount: 1, conflict: false },
    ]);
    // 미리보기는 아무것도 저장하지 않는다.
    const stored = await IndexedDbStorage.flows.list();
    expect(stored.map((f) => f.id)).toEqual(['dup']);
    expect(stored[0].name).toBe('이미 있는 흐름');
  });

  it('흐름이 없는 JSON 은 오류로 알린다', async () => {
    await expect(previewImportFlows(JSON.stringify({ nope: 1 }))).rejects.toThrow(/no flows found/);
  });
});

describe('가져오기 실행 모드', () => {
  beforeEach(async () => {
    stubChromeStorage();
    await clearFlows();
  });

  it('copy 는 겹치는 흐름만 새 id 로 들여온다', async () => {
    await saveFlow(makeFlow('dup', '원래 흐름'), { notify: false });
    const json = JSON.stringify({
      flows: [makeFlow('dup', '가져온 흐름'), makeFlow('fresh', '새 흐름')],
    });

    const imported = await importFlowsFromJson(json, 'copy');

    expect(imported).toHaveLength(2);
    const copied = imported.find((i) => i.oldId === 'dup');
    expect(copied?.newId).not.toBe('dup');
    expect(copied?.name).toBe('가져온 흐름 (복사)');
    // 겹치지 않은 흐름은 id 가 그대로다.
    expect(imported.find((i) => i.oldId === 'fresh')?.newId).toBe('fresh');

    const stored = await IndexedDbStorage.flows.list();
    expect(stored).toHaveLength(3);
    // 원래 흐름은 그대로 남는다.
    expect(stored.find((f) => f.id === 'dup')?.name).toBe('원래 흐름');
  });

  it('overwrite 는 같은 id 를 덮어쓴다 (예전 동작)', async () => {
    await saveFlow(makeFlow('dup', '원래 흐름'), { notify: false });
    const json = JSON.stringify([makeFlow('dup', '가져온 흐름')]);

    const imported = await importFlowsFromJson(json, 'overwrite');

    expect(imported).toEqual([{ oldId: 'dup', newId: 'dup', name: '가져온 흐름' }]);
    const stored = await IndexedDbStorage.flows.list();
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe('가져온 흐름');
  });
});

describe('copy 모드의 새 id 고르기', () => {
  beforeEach(async () => {
    stubChromeStorage();
    await clearFlows();
  });

  it('한 JSON 에 같은 id 가 두 번 있어도 서로 덮어쓰지 않는다', async () => {
    await saveFlow(makeFlow('dup', '원래 흐름'), { notify: false });
    const json = JSON.stringify({
      flows: [makeFlow('dup', '첫 번째'), makeFlow('dup', '두 번째')],
    });

    const imported = await importFlowsFromJson(json, 'copy');

    expect(imported).toHaveLength(2);
    expect(imported[0].newId).not.toBe(imported[1].newId);
    const stored = await IndexedDbStorage.flows.list();
    // 원래 흐름 + 복사본 둘.
    expect(stored).toHaveLength(3);
    expect(stored.find((f) => f.id === 'dup')?.name).toBe('원래 흐름');
  });

  it('순번 후보가 다 차도 겹치지 않는 id 를 돌려준다', () => {
    const taken = new Set<string>(['base-copy']);
    for (let n = 3; n <= 1000; n += 1) taken.add(`base-copy${n}`);

    const id = uniqueFlowId('base', taken);

    expect(taken.has(id)).toBe(false);
    expect(id.startsWith('base-copy')).toBe(true);
  });
});
