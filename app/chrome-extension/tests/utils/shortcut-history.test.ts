/**
 * auto-chrome-mcp fork — chrome_shortcut 실행 이력 (설계 구현 순서 1단계).
 *
 * 계약: docs/plans/2026-09-05-daily-automation-design.md 4절.
 * 테스트 이름 앞의 번호는 같은 문서 10절 체크리스트 번호다 (9, 10, 11, 18).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HISTORY_STORAGE_KEY,
  MAX_HISTORY_BYTES,
  MAX_RECORDS_PER_SHORTCUT,
  MAX_RECORDS_TOTAL,
  buildHistoryResults,
  classifyRunOutcome,
  errorCodeFrom,
  finishRunRecord,
  historyByteSize,
  manualRunId,
  maskRecordSecrets,
  normalizeLimit,
  pruneHistory,
  selectHistory,
  startRunRecord,
  type HistoryMap,
  type RunRecord,
} from '@/utils/shortcut-history';
import {
  shortcutTool,
  setShortcutToolInvoker,
} from '@/entrypoints/background/tools/browser/shortcut';

const txt = (text: string) => ({ type: 'text', text });
const ok = (text: string) => ({ content: [txt(text)], isError: false });
const fail = (text: string) => ({ content: [txt(text)], isError: true });

function summary(result: any) {
  return JSON.parse(result.content[0].text);
}

function recordInvoker(handler: (call: { name: string; args: any }) => any) {
  const calls: { name: string; args: any }[] = [];
  setShortcutToolInvoker(async (call: any) => {
    calls.push({ name: call.name, args: call.args });
    return handler(call);
  });
  return calls;
}

/** chrome.storage.local 을 메모리 맵으로 대체한다. set 훅으로 quota 오류를 주입한다. */
function stubStorage(initial: Record<string, any> = {}) {
  const store: Record<string, any> = { ...initial };
  const hooks: { onSet?: (obj: Record<string, any>) => void } = {};
  const setSpy = vi.fn(async (obj: Record<string, any>) => {
    hooks.onSet?.(obj);
    // 저장은 직렬화 후 복사본으로 둔다 - 참조 공유 때문에 통과하는 테스트를 막는다.
    Object.assign(store, JSON.parse(JSON.stringify(obj)));
  });
  (chrome.storage.local as any).get = vi.fn(async (keys: any) => {
    const list = Array.isArray(keys) ? keys : [keys];
    const out: Record<string, any> = {};
    for (const key of list) {
      if (Object.prototype.hasOwnProperty.call(store, key)) {
        out[key] = JSON.parse(JSON.stringify(store[key]));
      }
    }
    return out;
  });
  (chrome.storage.local as any).set = setSpy;
  return { store, hooks, setSpy };
}

function record(over: Partial<RunRecord> & { name: string; startedAt: number }): RunRecord {
  return {
    runId: `${over.name}:${over.startedAt}`,
    trigger: 'manual',
    status: 'success',
    ...over,
  } as RunRecord;
}

async function saveShortcut(name: string, steps: any[], params?: any): Promise<void> {
  const result = await shortcutTool.execute({
    action: 'save',
    name,
    templates: true,
    steps,
    ...(params ? { params } : {}),
  } as any);
  expect(result.isError, JSON.stringify(result.content)).toBe(false);
}

let harness: ReturnType<typeof stubStorage>;

beforeEach(() => {
  harness = stubStorage();
  recordInvoker(() => ok('{}'));
});

/* ------------------------------------------------------------------ *
 * 9. 레코드 필드
 * ------------------------------------------------------------------ */

describe('9. 이력 레코드 필드', () => {
  it('9. 수동 run 은 trigger:"manual" 로 기록되고 runId·status·시각·기간이 채워진다', async () => {
    await saveShortcut('daily', [{ tool: 'chrome_extract', args: {}, as: 'kpi' }]);
    recordInvoker(() => ok('{"a":1}'));

    const body = summary(await shortcutTool.execute({ action: 'run', name: 'daily' } as any));
    expect(typeof body.runId).toBe('string');

    const map = harness.store[HISTORY_STORAGE_KEY] as HistoryMap;
    expect(Object.keys(map)).toEqual(['daily']);
    const run = map.daily[0];
    expect(run.runId).toBe(body.runId);
    expect(run.name).toBe('daily');
    expect(run.trigger).toBe('manual');
    expect(run.status).toBe('success');
    expect(typeof run.startedAt).toBe('number');
    expect(typeof run.endedAt).toBe('number');
    expect(run.durationMs).toBe((run.endedAt as number) - run.startedAt);
  });

  it('9. 실패한 실행은 failedStep {index, tool} 과 errorCode 를 남긴다', async () => {
    await saveShortcut('daily', [
      { tool: 'chrome_navigate', args: { url: 'https://x.example/' }, as: 'nav' },
      { tool: 'chrome_extract', args: {}, as: 'kpi' },
    ]);
    recordInvoker(({ name }) =>
      name === 'chrome_extract' ? fail('unresolved_reference: kpi.values.total') : ok('{}'),
    );

    await shortcutTool.execute({ action: 'run', name: 'daily' } as any);

    const run = (harness.store[HISTORY_STORAGE_KEY] as HistoryMap).daily[0];
    expect(run.status).toBe('failed');
    expect(run.failedStep).toEqual({ index: 1, tool: 'chrome_extract' });
    expect(run.errorCode).toBe('unresolved_reference');
    expect(run.error).toContain('unresolved_reference');
  });

  it('9. 100초 초과는 timeout, 101회째 호출은 failed + total_runs_exceeded 다', () => {
    const timedOut = classifyRunOutcome({
      success: true,
      results: [{ index: 0, tool: 'chrome_navigate', ok: true, status: 'stopped' }],
      stoppedBy: { step: 0, reason: 'timeout' },
    });
    expect(timedOut.status).toBe('timeout');
    expect(timedOut.errorCode).toBe('timeout');

    const overRuns = classifyRunOutcome({
      success: true,
      results: [{ index: 0, tool: 'chrome_navigate', ok: true, status: 'stopped' }],
      stoppedBy: { step: 0, reason: 'total_runs_exceeded' },
    });
    expect(overRuns.status).toBe('failed');
    expect(overRuns.errorCode).toBe('total_runs_exceeded');
  });

  it('9. stopIf 정상 종료는 stopped, loginCheck 이름의 stopIf 만 login_required 다', () => {
    const outcome = {
      success: true,
      results: [{ index: 0, tool: 'chrome_find', ok: true, status: 'stopped', as: 'loginForm' }],
      stoppedBy: { step: 0, reason: 'stopIf' },
    };
    expect(classifyRunOutcome(outcome).status).toBe('stopped');
    expect(classifyRunOutcome(outcome, { loginCheckAs: 'loginForm' }).status).toBe(
      'login_required',
    );
    expect(classifyRunOutcome(outcome, { loginCheckAs: 'other' }).status).toBe('stopped');
  });

  it('9. beforeStep 훅이 끊은 실행은 그 사유가 곧 status 다 (user_took_over_tab)', () => {
    const classified = classifyRunOutcome({
      success: true,
      results: [{ index: 1, tool: 'chrome_extract', ok: true, status: 'stopped' }],
      stoppedBy: { step: 1, reason: 'aborted' },
      aborted: { reason: 'user_took_over_tab', message: 'user activated the work tab' },
    });
    expect(classified.status).toBe('user_took_over_tab');
    expect(classified.errorCode).toBe('user_took_over_tab');
  });

  it('9. errorCode 는 코드형 접두만 쓰고 없으면 tool_error 다', () => {
    expect(errorCodeFrom('no_work_tab: chrome_click_element needs a work tab')).toBe('no_work_tab');
    expect(errorCodeFrom('Something went wrong')).toBe('tool_error');
    expect(errorCodeFrom(null)).toBeNull();
  });

  it('9. manualRunId 는 같은 밀리초에 불러도 겹치지 않는다', () => {
    const now = 1_788_570_012_000;
    const ids = new Set(Array.from({ length: 50 }, () => manualRunId('daily', now)));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id.startsWith('daily:manual:')).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 10. results 상한과 보관 상한
 * ------------------------------------------------------------------ */

describe('10. results 상한과 보관 상한', () => {
  it('10. results 는 return 이름만 담고 8,001자 항목은 빠져 resultsTruncated 에 남는다', async () => {
    const big = 'x'.repeat(8_001);
    await saveShortcut('daily', [
      { tool: 'chrome_extract', args: {}, as: 'small' },
      { tool: 'chrome_extract', args: { marker: 'huge' }, as: 'huge' },
      { tool: 'chrome_extract', args: {}, as: 'ignored' },
    ]);
    recordInvoker(({ args }) => ok(JSON.stringify({ v: args?.marker === 'huge' ? big : 'ok' })));

    await shortcutTool.execute({
      action: 'run',
      name: 'daily',
      return: ['small', 'huge'],
    } as any);

    const run = (harness.store[HISTORY_STORAGE_KEY] as HistoryMap).daily[0];
    // 선언하지 않은 'ignored' 는 애초에 없고, 8,001자 'huge' 는 상한에 걸려 빠진다.
    expect(Object.keys(run.results ?? {})).toEqual(['small']);
    expect(run.resultsTruncated).toEqual(['huge']);
  });

  it('10. buildHistoryResults 는 전체 24,000자를 넘는 항목을 통째로 뺀다', () => {
    const item = 'y'.repeat(7_000);
    const built = buildHistoryResults({ a: item, b: item, c: item, d: item, e: item });
    // 7,002자(따옴표 포함) x 3 = 21,006 까지만 들어가고 나머지는 빠진다.
    expect(Object.keys(built.results).length).toBe(3);
    expect(built.truncated.length).toBe(2);
    expect(built.chars).toBeLessThanOrEqual(24_000);
  });

  it('10. shortcut 당 101번째 기록에서 가장 오래된 것이 지워진다', () => {
    const list = Array.from({ length: MAX_RECORDS_PER_SHORTCUT + 1 }, (_, i) =>
      record({ name: 'daily', startedAt: 1_000 + i }),
    );
    const pruned = pruneHistory({ daily: list });
    expect(pruned.daily.length).toBe(MAX_RECORDS_PER_SHORTCUT);
    // 최신이 앞이고, 가장 오래된 startedAt: 1000 이 빠졌다.
    expect(pruned.daily[0].startedAt).toBe(1_000 + MAX_RECORDS_PER_SHORTCUT);
    expect(pruned.daily.some((r) => r.startedAt === 1_000)).toBe(false);
  });

  it('10. 전체 1,001건째는 모든 shortcut 을 통틀어 최고령부터 지운다', () => {
    const map: HistoryMap = {};
    let stamp = 1_000;
    for (let s = 0; s < 11; s++) {
      map[`s${s}`] = Array.from({ length: 91 }, () =>
        record({ name: `s${s}`, startedAt: stamp++ }),
      );
    }
    const before = Object.values(map).reduce((n, l) => n + l.length, 0);
    expect(before).toBe(1_001);

    const pruned = pruneHistory(map);
    const after = Object.values(pruned).reduce((n, l) => n + l.length, 0);
    expect(after).toBe(MAX_RECORDS_TOTAL);
    // 최고령(startedAt: 1000) 이 빠졌다.
    expect(pruned.s0.some((r) => r.startedAt === 1_000)).toBe(false);
  });

  it('10. TextEncoder 기준 3MiB 를 넘으면 최고령부터 지운다', () => {
    const blob = 'z'.repeat(40_000);
    const map: HistoryMap = {
      daily: Array.from({ length: 90 }, (_, i) =>
        record({ name: 'daily', startedAt: 1_000 + i, results: { blob } }),
      ),
    };
    expect(historyByteSize(map)).toBeGreaterThan(MAX_HISTORY_BYTES);

    const pruned = pruneHistory(map);
    expect(historyByteSize(pruned)).toBeLessThanOrEqual(MAX_HISTORY_BYTES);
    expect(pruned.daily.some((r) => r.startedAt === 1_000)).toBe(false);
    // 최신 기록은 살아 있다.
    expect(pruned.daily[0].startedAt).toBe(1_089);
  });

  it('10. quota 오류가 나면 더 지우고 1회만 재시도해 저장에 성공한다', async () => {
    let thrown = 0;
    harness.hooks.onSet = () => {
      if (thrown === 0) {
        thrown += 1;
        throw new Error('QUOTA_BYTES quota exceeded');
      }
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await startRunRecord({ runId: 'r1', name: 'daily', trigger: 'manual', startedAt: 1 });

    expect(harness.setSpy).toHaveBeenCalledTimes(2);
    expect((harness.store[HISTORY_STORAGE_KEY] as HistoryMap).daily[0].runId).toBe('r1');
    warn.mockRestore();
  });

  it('10. writer queue: 동시에 끝난 두 실행이 모두 남는다', async () => {
    // 읽기와 쓰기 사이에 틈을 만들어, 큐가 없으면 한쪽이 사라지는 조건을 실제로 만든다.
    const originalGet = (chrome.storage.local as any).get;
    (chrome.storage.local as any).get = vi.fn(async (keys: any) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return await originalGet(keys);
    });

    await Promise.all([
      finishRunRecord('daily', 'a', { status: 'success', startedAt: 1, endedAt: 2 }),
      finishRunRecord('nightly', 'b', { status: 'failed', startedAt: 1, endedAt: 3 }),
    ]);

    const map = harness.store[HISTORY_STORAGE_KEY] as HistoryMap;
    expect(map.daily?.[0]?.runId).toBe('a');
    expect(map.nightly?.[0]?.runId).toBe('b');
  });
});

/* ------------------------------------------------------------------ *
 * 11. 조회
 * ------------------------------------------------------------------ */

describe('11. history 조회', () => {
  async function seed(): Promise<void> {
    const map: HistoryMap = {
      daily: [
        record({
          name: 'daily',
          startedAt: 3_000,
          runId: 'daily:3',
          status: 'failed',
          results: { kpi: { total: 12 } },
          errorCode: 'unresolved_reference',
        }),
        record({ name: 'daily', startedAt: 1_000, runId: 'daily:1' }),
      ],
      nightly: [record({ name: 'nightly', startedAt: 2_000, runId: 'nightly:2' })],
    };
    harness.store[HISTORY_STORAGE_KEY] = map;
  }

  it('11. 목록 응답에는 results 본문이 없고 resultsChars 만 있다', async () => {
    await seed();
    const body = summary(await shortcutTool.execute({ action: 'history' } as any));

    expect(body.runs.map((r: any) => r.runId)).toEqual(['daily:3', 'nightly:2', 'daily:1']);
    for (const run of body.runs) {
      expect(run.results).toBeUndefined();
      expect(typeof run.resultsChars).toBe('number');
    }
    expect(body.runs[0].resultsChars).toBeGreaterThan(0);
    expect(body.runs[0].errorCode).toBe('unresolved_reference');
  });

  it('11. runId 조회는 results 를 포함한 레코드 전체를 돌려준다', async () => {
    await seed();
    const body = summary(
      await shortcutTool.execute({ action: 'history', runId: 'daily:3' } as any),
    );
    expect(body.run.results).toEqual({ kpi: { total: 12 } });
    expect(body.run.status).toBe('failed');
  });

  it('11. 없는 runId 는 run_not_found 다', async () => {
    await seed();
    const result = await shortcutTool.execute({ action: 'history', runId: 'nope' } as any);
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain('run_not_found');
  });

  it('11. limit 101 은 100 으로 잘리고 0 이하는 1 이 된다', () => {
    expect(normalizeLimit(101)).toBe(100);
    expect(normalizeLimit(0)).toBe(1);
    expect(normalizeLimit(undefined)).toBe(20);
  });

  it('11. since 이전 기록과 status 가 다른 기록은 빠지고, name 은 그 shortcut 만 본다', async () => {
    await seed();
    const map = harness.store[HISTORY_STORAGE_KEY] as HistoryMap;

    expect(selectHistory(map, { since: 2_000 }).summaries.map((s) => s.runId)).toEqual([
      'daily:3',
      'nightly:2',
    ]);
    expect(selectHistory(map, { status: 'failed' }).summaries.map((s) => s.runId)).toEqual([
      'daily:3',
    ]);
    expect(selectHistory(map, { name: 'nightly' }).summaries.map((s) => s.runId)).toEqual([
      'nightly:2',
    ]);
    expect(selectHistory(map, { limit: 1 }).matched).toBe(3);
  });
});

/* ------------------------------------------------------------------ *
 * 18. secret 마스킹
 * ------------------------------------------------------------------ */

describe('18. secret 은 이력에 남지 않는다', () => {
  const SECRET = 'pa"ss\\word';
  const ESCAPED = JSON.stringify(SECRET).slice(1, -1);

  it('18. secret 을 넘긴 manual run 의 레코드와 저장소 덤프에 원문·escaped 형태가 없다', async () => {
    await saveShortcut(
      'login',
      [{ tool: 'chrome_fill_or_select', args: { value: '{{params.pw}}' }, as: 'fill' }],
      { pw: { secret: true } },
    );
    // 오류 문구에 비밀값이 그대로 섞여 나오는 최악의 경우를 만든다.
    recordInvoker(({ args }) => fail(`login_failed: rejected ${args.value} / ${ESCAPED}`));

    await shortcutTool.execute({
      action: 'run',
      name: 'login',
      params: { pw: SECRET },
    } as any);

    const dump = JSON.stringify(harness.store[HISTORY_STORAGE_KEY]);
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain(ESCAPED);
    expect(dump).toContain('***');

    const run = (harness.store[HISTORY_STORAGE_KEY] as HistoryMap).login[0];
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('login_failed');
  });

  it('18. maskRecordSecrets 는 중첩된 값과 키 이름까지 가린다', () => {
    const masked = maskRecordSecrets(
      { results: { [SECRET]: [`prefix ${SECRET}`, { deep: ESCAPED }] } },
      [SECRET],
    );
    const dump = JSON.stringify(masked);
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain(ESCAPED);
  });
});
