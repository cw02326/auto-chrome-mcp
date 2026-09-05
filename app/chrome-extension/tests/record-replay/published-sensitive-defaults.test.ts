/**
 * published-sensitive-defaults.test.ts
 *
 * 2026-09-05 Codex 최종 확인 5 (발행 전 검토 6 잔여): **이미 저장된 스냅샷은 그대로였다.**
 *
 * `publishFlow` 는 이제 발행 스냅샷에서 `sensitive` 변수의 `default` 를 뺀다. 그러나 그 전에
 * 발행된 레코드는 IndexedDB 에 비밀번호·토큰 기본값을 평문으로 그대로 들고 있고, 사용자가
 * 그 흐름을 다시 발행할 이유가 없으므로 영영 남는다. 워커가 뜰 때 한 번 걷어 내야 한다.
 *
 * 여기서는 마이그레이션의 계약을 고정한다: sensitive 기본값만 지우고, 흐름의 설정값
 * (sensitive 표시가 없는 변수의 기본값)과 나머지 스냅샷은 그대로 둔다.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensurePublishedSensitiveDefaultsMigrated,
  migratePublishedSensitiveDefaults,
} from '@/entrypoints/background/record-replay/flow-store';
import { IndexedDbStorage } from '@/entrypoints/background/record-replay/storage/indexeddb-manager';
import type { Flow } from '@/entrypoints/background/record-replay/types';

const FLOW_ID = 'legacy-published';

/** 마이그레이션 이전 형태의 스냅샷: sensitive 변수에 기본값이 그대로 실려 있다. */
function legacySnapshot(): Flow {
  return {
    id: FLOW_ID,
    name: 'legacy',
    version: 3,
    variables: [
      { key: 'password', sensitive: true, default: 'hunter2' },
      { key: 'token', sensitive: true, default: 'tok_live_1' },
      { key: 'boardUrl', default: 'https://board.example.com/' },
    ],
    nodes: [{ id: 'n1', type: 'navigate', config: { url: '{boardUrl}' } }],
    edges: [],
    meta: { createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
  } as unknown as Flow;
}

async function seedLegacyRecord(): Promise<void> {
  for (const p of await IndexedDbStorage.published.list())
    await IndexedDbStorage.published.delete(p.id);
  await IndexedDbStorage.published.save({
    id: FLOW_ID,
    slug: 'legacy',
    version: 3,
    name: 'legacy',
    snapshot: legacySnapshot(),
  } as any);
}

async function storedSnapshot(): Promise<any> {
  const records = (await IndexedDbStorage.published.list()) as any[];
  return records.find((r) => r.id === FLOW_ID)?.snapshot;
}

/**
 * `ensureMigratedFromLocal` 이 `chrome.storage.local` 을 실제로 읽으므로, 기본 stub 대신
 * 값을 들고 있는 저장소를 깔아 준다 (기본 stub 은 호출마다 같은 객체를 돌려주지 않는다).
 */
function installLocalStorage(): void {
  const store: Record<string, unknown> = {};
  (chrome.storage.local as any).get = vi.fn(async (keys: unknown) => {
    const list = Array.isArray(keys) ? keys : keys == null ? Object.keys(store) : [String(keys)];
    const out: Record<string, unknown> = {};
    for (const key of list) if (key in store) out[key] = store[key];
    return out;
  });
  (chrome.storage.local as any).set = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(store, items);
  });
}

describe('저장된 발행 스냅샷의 sensitive 기본값을 한 번 걷어 낸다 (최종 확인 5)', () => {
  beforeEach(async () => {
    installLocalStorage();
    await seedLegacyRecord();
  });

  it('sensitive 변수의 default 만 지우고 나머지는 그대로 둔다', async () => {
    // 재현: 마이그레이션 전에는 평문 기본값이 저장소에 그대로 있다.
    const before = await storedSnapshot();
    expect(before.variables[0].default).toBe('hunter2');

    const fixed = await migratePublishedSensitiveDefaults();
    expect(fixed).toBe(1);

    const after = await storedSnapshot();
    expect('default' in after.variables[0]).toBe(false);
    expect('default' in after.variables[1]).toBe(false);
    // sensitive 표시가 없는 변수의 기본값은 흐름의 설정값이다 - 건드리지 않는다.
    expect(after.variables[2].default).toBe('https://board.example.com/');
    // 스냅샷의 나머지도 그대로다.
    expect(after.nodes).toEqual(before.nodes);
    expect(after.version).toBe(3);
    // 어느 변수도 사라지지 않는다.
    expect(after.variables.map((v: any) => v.key)).toEqual(['password', 'token', 'boardUrl']);
  });

  it('지울 것이 없으면 아무 레코드도 다시 쓰지 않는다', async () => {
    await migratePublishedSensitiveDefaults();
    expect(await migratePublishedSensitiveDefaults()).toBe(0);
  });

  it('워커 초기화용 진입점은 한 번만 돈다', async () => {
    const first = await ensurePublishedSensitiveDefaultsMigrated();
    // 두 번째 호출은 같은 promise 를 돌려주므로 저장소를 다시 훑지 않는다.
    expect(await ensurePublishedSensitiveDefaultsMigrated()).toBe(first);
    expect((await storedSnapshot()).variables[0].default).toBeUndefined();
  });
});
