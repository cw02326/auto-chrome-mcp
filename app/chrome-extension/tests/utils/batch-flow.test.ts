/**
 * auto-chrome-mcp fork — chrome_batch / chrome_shortcut 공용 실행기 + 값 전달 통합 테스트.
 *
 * 계약: docs/plans/2026-09-04-batch-flow-design.md (구현 순서 1·2단계).
 * 테스트 이름의 번호는 같은 문서 8절 체크리스트 번호다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { batchTool, setBatchToolInvoker } from '@/entrypoints/background/tools/browser/batch';
import { FlowDeadlineExceededError } from '@/utils/tool-watchdog';
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

/** invoker 를 mock 으로 갈아끼우고 호출 기록을 돌려준다. */
function recordInvoker(handler: (call: { name: string; args: any }) => any) {
  const calls: { name: string; args: any }[] = [];
  const fn = async (call: { name: string; args: any }) => {
    calls.push({ name: call.name, args: call.args });
    return handler(call);
  };
  setBatchToolInvoker(fn);
  setShortcutToolInvoker(fn);
  return calls;
}

/** chrome.storage.local 을 메모리 맵으로 대체한다 (shortcut 저장 + background mode 조회). */
function stubStorage(initial: Record<string, any> = {}) {
  const store: Record<string, any> = { ...initial };
  (chrome.storage.local as any).get = vi.fn(async (keys: any) => {
    const list = Array.isArray(keys) ? keys : [keys];
    const out: Record<string, any> = {};
    for (const key of list) {
      if (Object.prototype.hasOwnProperty.call(store, key)) out[key] = store[key];
    }
    return out;
  });
  (chrome.storage.local as any).set = vi.fn(async (obj: Record<string, any>) => {
    Object.assign(store, obj);
  });
  return store;
}

const FIND_RESULT = JSON.stringify({
  success: true,
  matches: [{ rank: 1, ref: 'REF1', frameId: 7 }],
});

beforeEach(() => {
  stubStorage();
  recordInvoker(() => ok('{}'));
});

/* ------------------------------------------------------------------ *
 * 1. 호환
 * ------------------------------------------------------------------ */

describe('공용 실행기 호환 (1)', () => {
  it('1. v1 호출의 응답은 status 필드 추가 외에 예전과 필드 단위로 같다', async () => {
    recordInvoker(({ name }) => (name === 'chrome_click_element' ? fail('boom') : ok('{"a":1}')));

    const result = await batchTool.execute({
      steps: [{ tool: 'chrome_click_element' }, { tool: 'chrome_screenshot' }],
    } as any);
    const body = summary(result);

    expect(Object.keys(body)).toEqual(['success', 'steps', 'stoppedAtStep']);
    expect(body.success).toBe(false);
    expect(body.stoppedAtStep).toBe(0);
    expect(body.steps[0]).toEqual({
      index: 0,
      tool: 'chrome_click_element',
      ok: false,
      error: 'boom',
      status: 'failed',
    });
    expect(body.steps[1]).toEqual({
      index: 1,
      tool: 'chrome_screenshot',
      ok: false,
      error: 'skipped (batch stopped at earlier failing step)',
      status: 'skipped',
    });
    expect(result.isError).toBe(false);
  });

  it('1. shortcut 도 같은 실행기를 쓰지만 응답 형식(name·이미지 없음)은 그대로다', async () => {
    stubStorage({
      mcpShortcuts: {
        legacy: { steps: [{ tool: 'chrome_screenshot' }], createdAt: 1, updatedAt: 1, runCount: 0 },
      },
    });
    recordInvoker(() => ok('done'));

    const body = summary(await shortcutTool.execute({ action: 'run', name: 'legacy' } as any));
    // 2026-09-05: 실행 이력이 붙으면서 방금 실행의 손잡이 runId 가 하나 늘었다.
    expect(Object.keys(body)).toEqual(['success', 'name', 'runId', 'steps']);
    expect(body.steps[0]).toEqual({
      index: 0,
      tool: 'chrome_screenshot',
      ok: true,
      resultText: 'done',
      status: 'completed',
    });
  });

  it('1a. v1 호출의 유효한 {{name.path}} literal 은 그대로 도구에 전달된다 (핵심 회귀)', async () => {
    const calls = recordInvoker(() => ok(FIND_RESULT));

    await batchTool.execute({
      steps: [
        { tool: 'chrome_find', args: { query: '검색 결과' } },
        { tool: 'chrome_click_element', args: { ref: '{{hit.matches[0].ref}}' } },
      ],
    } as any);

    expect(calls[1].args.ref).toBe('{{hit.matches[0].ref}}');
  });

  it('1a. templates 를 켜면 같은 인자가 치환된다', async () => {
    const calls = recordInvoker(() => ok(FIND_RESULT));

    await batchTool.execute({
      templates: true,
      steps: [
        { tool: 'chrome_find', as: 'hit', args: { query: '검색 결과' } },
        { tool: 'chrome_click_element', args: { ref: '{{hit.matches[0].ref}}' } },
      ],
    } as any);

    expect(calls[1].args.ref).toBe('REF1');
  });

  it('1b. templates 필드 없는 legacy shortcut 레코드는 치환하지 않는다', async () => {
    stubStorage({
      mcpShortcuts: {
        old: {
          steps: [
            { tool: 'chrome_find', as: 'hit' },
            { tool: 'chrome_click_element', args: { ref: '{{hit.matches[0].ref}}' } },
          ],
          createdAt: 1,
          updatedAt: 1,
          runCount: 0,
        },
      },
    });
    const calls = recordInvoker(() => ok(FIND_RESULT));

    await shortcutTool.execute({ action: 'run', name: 'old' } as any);
    expect(calls[1].args.ref).toBe('{{hit.matches[0].ref}}');
  });

  it('1b. save 로 만든 v2 레코드는 templates 가 기록되고 실행 시 치환된다', async () => {
    const store = stubStorage();
    await shortcutTool.execute({
      action: 'save',
      name: 'flow',
      steps: [
        { tool: 'chrome_find', as: 'hit' },
        { tool: 'chrome_click_element', args: { ref: '{{hit.matches[0].ref}}' } },
      ],
    } as any);

    expect(store.mcpShortcuts.flow.templates).toBe(true);

    const calls = recordInvoker(() => ok(FIND_RESULT));
    await shortcutTool.execute({ action: 'run', name: 'flow' } as any);
    expect(calls[1].args.ref).toBe('REF1');
  });
});

/* ------------------------------------------------------------------ *
 * 2. 값 전달과 캡처 상한
 * ------------------------------------------------------------------ */

describe('값 전달 (2)', () => {
  it('2. chrome_find 의 matches[0].ref 가 다음 클릭 인자로 들어간다', async () => {
    const calls = recordInvoker(({ name }) =>
      name === 'chrome_find' ? ok(FIND_RESULT) : ok('{"clicked":true}'),
    );

    const body = summary(
      await batchTool.execute({
        steps: [
          { tool: 'chrome_find', as: 'hit', args: { query: '첫 결과' } },
          {
            tool: 'chrome_click_element',
            args: { ref: '{{hit.matches[0].ref}}', frameId: '{{hit.matches[0].frameId}}' },
          },
        ],
      } as any),
    );

    expect(calls[1].args.ref).toBe('REF1');
    expect(calls[1].args.frameId).toBe(7);
    expect(body.success).toBe(true);
    expect(body.steps[0].as).toBe('hit');
  });

  it('2a. 표시용 4000자 자르기와 무관하게 원본에서 matches[19].ref 가 해석된다', async () => {
    const matches = Array.from({ length: 20 }, (_, i) => ({
      rank: i,
      ref: `REF${i}`,
      pad: 'p'.repeat(300),
    }));
    const big = JSON.stringify({ success: true, matches });
    expect(big.length).toBeGreaterThan(4000);

    const calls = recordInvoker(({ name }) => (name === 'chrome_find' ? ok(big) : ok('{}')));
    const body = summary(
      await batchTool.execute({
        steps: [
          { tool: 'chrome_find', as: 'hit' },
          { tool: 'chrome_click_element', args: { ref: '{{hit.matches[19].ref}}' } },
        ],
      } as any),
    );

    expect(calls[1].args.ref).toBe('REF19');
    expect(body.steps[0].resultText).toContain('... [truncated]');
  });

  it('2a. 65KiB 결과의 as 는 capture_too_large, as 없는 같은 결과는 성공에 prev 본문만 빈다', async () => {
    const huge = JSON.stringify({ blob: 'x'.repeat(66 * 1024) });
    recordInvoker(({ name }) => (name === 'chrome_read_page' ? ok(huge) : ok('{}')));

    const withAs = summary(
      await batchTool.execute({
        steps: [{ tool: 'chrome_read_page', as: 'page' }],
      } as any),
    );
    expect(withAs.steps[0].ok).toBe(false);
    expect(withAs.steps[0].status).toBe('failed');
    expect(withAs.steps[0].error).toContain('capture_too_large');

    const noAs = summary(
      await batchTool.execute({
        templates: true,
        continueOnError: true,
        steps: [
          { tool: 'chrome_read_page' },
          { tool: 'chrome_find', args: { query: '{{prev.$ok}}' } },
          { tool: 'chrome_find', args: { query: '{{prev.blob}}' } },
        ],
      } as any),
    );
    expect(noAs.steps[0].ok).toBe(true);
    expect(noAs.steps[1].ok).toBe(true);
    expect(noAs.steps[2].ok).toBe(false);
    expect(noAs.steps[2].error).toContain('unresolved_reference');
  });

  it('2a. as 누적이 256KiB 를 넘으면 그 step 이 capture_too_large 로 실패한다', async () => {
    const chunk = JSON.stringify({ blob: 'y'.repeat(60 * 1024 - 20) });
    recordInvoker(() => ok(chunk));

    const body = summary(
      await batchTool.execute({
        continueOnError: true,
        steps: Array.from({ length: 5 }, (_, i) => ({ tool: 'chrome_read_page', as: `s${i}` })),
      } as any),
    );

    expect(body.steps.slice(0, 4).every((s: any) => s.ok)).toBe(true);
    expect(body.steps[4].ok).toBe(false);
    expect(body.steps[4].error).toContain('capture_too_large');
  });

  it('2e. prev 는 실패한 step 의 결과도 담는다', async () => {
    const calls = recordInvoker(({ name }) =>
      name === 'chrome_click_element' ? fail('nope') : ok('{}'),
    );

    await batchTool.execute({
      templates: true,
      continueOnError: true,
      steps: [
        { tool: 'chrome_click_element' },
        { tool: 'chrome_find', args: { query: '{{prev.$ok}}', note: '{{prev.$error}}' } },
      ],
    } as any);

    expect(calls[1].args.query).toBe(false);
    expect(calls[1].args.note).toBe('nope');
  });
});

/* ------------------------------------------------------------------ *
 * 4. 해석 실패
 * ------------------------------------------------------------------ */

describe('해석 실패 (4)', () => {
  it('4. 닿지 않는 path 는 그 step 만 실패시키고 뒤 step 은 skipped 다', async () => {
    const calls = recordInvoker(() => ok('{"matches":[]}'));

    const body = summary(
      await batchTool.execute({
        steps: [
          { tool: 'chrome_find', as: 'hit' },
          { tool: 'chrome_click_element', args: { ref: '{{hit.matches[0].ref}}' } },
          { tool: 'chrome_screenshot' },
        ],
      } as any),
    );

    expect(body.steps[1].ok).toBe(false);
    expect(body.steps[1].error).toContain('unresolved_reference');
    expect(body.steps[2].status).toBe('skipped');
    expect(body.success).toBe(false);
    // 해석에 실패한 step 은 도구를 부르지 않는다.
    expect(calls).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * 6. 금지 키
 * ------------------------------------------------------------------ */

describe('치환 금지 키 (6)', () => {
  const scopeSteps = (tool: string, args: Record<string, unknown>) => ({
    steps: [
      { tool: 'chrome_find', as: 'hit' },
      { tool, args },
    ],
  });

  beforeEach(() => {
    recordInvoker(() => ok(JSON.stringify({ matches: [{ ref: 'REF1' }], id: 5, u: 'https://x/' })));
  });

  it('6. tabId·tabIds·windowId·lane·_mcpSessionId 에 {{...}} 를 넣으면 template_forbidden_key 다', async () => {
    for (const [key, value] of [
      ['tabId', '{{hit.id}}'],
      ['tabIds', ['{{hit.id}}']],
      ['windowId', '{{hit.id}}'],
      ['lane', '{{hit.u}}'],
      ['_mcpSessionId', '{{hit.u}}'],
    ] as [string, unknown][]) {
      const body = summary(
        await batchTool.execute(scopeSteps('chrome_click_element', { [key]: value }) as any),
      );
      expect(body.steps[1].error, key).toContain('template_forbidden_key');
    }
  });

  it('6. url 이 대상 탭을 고르는 도구의 url 치환은 template_forbidden_key 다', async () => {
    for (const tool of [
      'chrome_get_web_content',
      'chrome_console',
      'chrome_network_capture',
      'chrome_close_tabs',
    ]) {
      const body = summary(await batchTool.execute(scopeSteps(tool, { url: '{{hit.u}}' }) as any));
      expect(body.steps[1].error, tool).toContain('template_forbidden_key');
    }
  });

  it('6a. 치환으로 생성된 subtree 안의 tabId 도 실행 전에 잡힌다', async () => {
    recordInvoker(() => ok(JSON.stringify({ obj: { tabId: 123 }, plain: { q: 1 } })));

    const bad = summary(
      await batchTool.execute({
        steps: [
          { tool: 'chrome_find', as: 'hit' },
          { tool: 'chrome_userscript', args: { args: '{{hit.obj}}' } },
        ],
      } as any),
    );
    expect(bad.steps[1].error).toContain('template_forbidden_key');

    const good = summary(
      await batchTool.execute({
        steps: [
          { tool: 'chrome_find', as: 'hit' },
          { tool: 'chrome_userscript', args: { args: '{{hit.plain}}' } },
        ],
      } as any),
    );
    expect(good.steps[1].ok).toBe(true);
  });

  it('6a. literal 로 원래 있던 중첩 tabId 는 batch 에서 그대로 통과한다', async () => {
    const calls = recordInvoker(() => ok('{}'));
    const body = summary(
      await batchTool.execute({
        templates: true,
        steps: [{ tool: 'chrome_userscript', args: { args: { tabId: 9 }, tabId: 9 } }],
      } as any),
    );
    expect(body.steps[0].ok).toBe(true);
    expect(calls[0].args.tabId).toBe(9);
  });

  it('6b. DISALLOWED_STEP_TOOLS 는 여전히 거절되고 tool 값은 치환하지 않는다', async () => {
    const calls = recordInvoker(() => ok('{"x":"chrome_screenshot"}'));

    const body = summary(
      await batchTool.execute({
        continueOnError: true,
        steps: [
          { tool: 'chrome_find', as: 'hit' },
          { tool: 'chrome_batch' },
          { tool: '{{hit.x}}' },
        ],
      } as any),
    );

    expect(body.steps[1].error).toContain('is not allowed inside chrome_batch');
    expect(calls[1].name).toBe('{{hit.x}}');
  });
});

/* ------------------------------------------------------------------ *
 * 7. 컨텍스트·게이트
 * ------------------------------------------------------------------ */

describe('컨텍스트와 게이트 (7)', () => {
  it('7. chrome_navigate 의 url 치환은 허용된다', async () => {
    const calls = recordInvoker(({ name }) =>
      name === 'chrome_find' ? ok('{"id":"42"}') : ok('{}'),
    );

    const body = summary(
      await batchTool.execute({
        steps: [
          { tool: 'chrome_find', as: 'hit' },
          { tool: 'chrome_navigate', args: { url: 'https://x.test/{{hit.id}}' } },
        ],
      } as any),
    );

    expect(body.steps[1].ok).toBe(true);
    expect(calls[1].args.url).toBe('https://x.test/42');
  });

  it('7a. step 의 _mcpSessionId·lane 은 제거되고 batch 컨텍스트 값으로 재주입된다', async () => {
    const calls = recordInvoker(() => ok('{}'));

    await batchTool.execute({
      lane: 'outer',
      _mcpSessionId: 'sess-1',
      steps: [{ tool: 'chrome_screenshot', args: { lane: 'evil', _mcpSessionId: 'evil' } }],
    } as any);

    expect(calls[0].args.lane).toBe('outer');
    expect(calls[0].args._mcpSessionId).toBe('sess-1');
  });

  it('7a. 바깥 컨텍스트가 없으면 두 키가 아예 없다', async () => {
    const calls = recordInvoker(() => ok('{}'));

    await batchTool.execute({
      steps: [{ tool: 'chrome_screenshot', args: { lane: 'evil', _mcpSessionId: 'evil' } }],
    } as any);

    expect('lane' in calls[0].args).toBe(false);
    expect('_mcpSessionId' in calls[0].args).toBe(false);
  });

  it('7b. background mode ON 이면 v2 step 의 background:false 는 게이트 전에 true 로 덮인다', async () => {
    const calls = recordInvoker(({ name }) =>
      name === 'chrome_find' ? ok('{"flag":false}') : ok('{}'),
    );

    await batchTool.execute({
      steps: [
        { tool: 'chrome_find', as: 'hit' },
        { tool: 'chrome_screenshot', args: { background: false } },
        { tool: 'chrome_screenshot', args: { background: '{{hit.flag}}' } },
      ],
    } as any);

    expect(calls[1].args.background).toBe(true);
    expect(calls[2].args.background).toBe(true);
  });

  it('7b. v1 호출의 background:false 는 예전대로 그대로 간다 (게이트가 판단)', async () => {
    const calls = recordInvoker(() => ok('{}'));

    await batchTool.execute({
      steps: [{ tool: 'chrome_screenshot', args: { background: false } }],
    } as any);

    expect(calls[0].args.background).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 13a / 14
 * ------------------------------------------------------------------ */

describe('shortcut v2 저장 제한 (13a)', () => {
  it('13a. v2 저장 step args 의 literal tabId·windowId·tabIds 는 stale_target_forbidden 이다', async () => {
    for (const args of [{ tabId: 5 }, { windowId: 5 }, { tabIds: [5] }, { args: { tabId: 5 } }]) {
      stubStorage();
      const result = await shortcutTool.execute({
        action: 'save',
        name: 'v2flow',
        steps: [{ tool: 'chrome_click_element', as: 'hit', args }],
      } as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('stale_target_forbidden');
    }
  });

  it('13a. v2 의 chrome_close_tabs.url 도 거절한다', async () => {
    stubStorage();
    const result = await shortcutTool.execute({
      action: 'save',
      name: 'v2close',
      templates: true,
      steps: [{ tool: 'chrome_close_tabs', args: { url: 'https://x.test/' } }],
    } as any);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('stale_target_forbidden');
  });

  it('13a. legacy(v1) 저장은 literal tabId 를 그대로 받는다', async () => {
    const store = stubStorage();
    const result = await shortcutTool.execute({
      action: 'save',
      name: 'v1flow',
      steps: [{ tool: 'chrome_click_element', args: { tabId: 5 } }],
    } as any);
    expect(result.isError).toBe(false);
    expect(store.mcpShortcuts.v1flow.templates).toBeUndefined();
  });
});

describe('return (14)', () => {
  it('14. return 이 없으면 응답에 results 키가 없다', async () => {
    recordInvoker(() => ok('{"a":1}'));
    const body = summary(
      await batchTool.execute({ steps: [{ tool: 'chrome_extract', as: 'page' }] } as any),
    );
    expect('results' in body).toBe(false);
  });

  it('14. return 이 있으면 이름별 값을 싣는다', async () => {
    recordInvoker(() => ok('{"a":1}'));
    const body = summary(
      await batchTool.execute({
        return: ['page'],
        steps: [{ tool: 'chrome_extract', as: 'page' }],
      } as any),
    );
    expect(body.results).toEqual({ page: { a: 1 } });
  });

  it('14. 모르는 이름은 실행 전에 unknown_return_name 으로 거절한다', async () => {
    const calls = recordInvoker(() => ok('{}'));
    const result = await batchTool.execute({
      return: ['nope'],
      steps: [{ tool: 'chrome_extract', as: 'page' }],
    } as any);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('unknown_return_name');
    expect(calls).toHaveLength(0);
  });

  it('14. 8,000자를 넘는 항목은 자르지 않고 통째로 빠지고 resultsTruncated 에 이름이 남는다', async () => {
    const bigText = JSON.stringify({ blob: 'z'.repeat(8100) });
    recordInvoker(({ name }) => (name === 'chrome_read_page' ? ok(bigText) : ok('{"a":1}')));

    const body = summary(
      await batchTool.execute({
        return: ['small', 'big'],
        steps: [
          { tool: 'chrome_extract', as: 'small' },
          { tool: 'chrome_read_page', as: 'big' },
        ],
      } as any),
    );

    expect(body.results).toEqual({ small: { a: 1 } });
    expect(body.resultsTruncated).toEqual(['big']);
  });
});

/* ------------------------------------------------------------------ *
 * 8~9. 조건과 조기 종료
 * ------------------------------------------------------------------ */

describe('조건 when (8, 8a, 8b)', () => {
  it('8. when 이 거짓이면 그 step 은 skipped 이고 success 는 영향을 받지 않는다', async () => {
    const calls = recordInvoker(() => ok('{"matches":[]}'));

    const body = summary(
      await batchTool.execute({
        steps: [
          { tool: 'chrome_find', as: 'hit' },
          {
            tool: 'chrome_click_element',
            when: { path: 'hit.matches', op: 'notEmpty' },
            args: { ref: 'REF1' },
          },
          { tool: 'chrome_screenshot' },
        ],
      } as any),
    );

    expect(body.steps[1]).toEqual({
      index: 1,
      tool: 'chrome_click_element',
      ok: true,
      status: 'skipped',
    });
    expect(body.steps[2].status).toBe('completed');
    expect(body.success).toBe(true);
    expect(calls.map((c) => c.name)).toEqual(['chrome_find', 'chrome_screenshot']);
  });

  it('8a. 닿지 않는 path 에서 exists 는 건너뛰고 notExists 는 실행한다', async () => {
    const calls = recordInvoker(() => ok('{"matches":[]}'));

    const body = summary(
      await batchTool.execute({
        steps: [
          { tool: 'chrome_find', as: 'hit' },
          {
            tool: 'chrome_click_element',
            when: { path: 'hit.nope', op: 'exists' },
            args: { ref: 'a' },
          },
          {
            tool: 'chrome_screenshot',
            when: { path: 'hit.nope', op: 'notExists' },
          },
        ],
      } as any),
    );

    expect(body.steps[1].status).toBe('skipped');
    expect(body.steps[2].status).toBe('completed');
    expect(calls).toHaveLength(2);
  });

  it('8a. 닿지 않는 path 에 eq 를 걸면 condition_unresolved 로 그 step 이 실패한다', async () => {
    recordInvoker(() => ok('{"matches":[]}'));

    const body = summary(
      await batchTool.execute({
        steps: [
          { tool: 'chrome_find', as: 'hit' },
          {
            tool: 'chrome_click_element',
            when: { path: 'hit.nope', op: 'eq', value: 1 },
            args: { ref: 'a' },
          },
          { tool: 'chrome_screenshot' },
        ],
      } as any),
    );

    expect(body.steps[1].ok).toBe(false);
    expect(body.steps[1].error).toContain('condition_unresolved');
    expect(body.steps[2].status).toBe('skipped');
    expect(body.success).toBe(false);
  });

  it('8b. 조건 value 의 템플릿은 평가 전에 치환돼 두 결과를 비교한다', async () => {
    const calls = recordInvoker(({ args }) =>
      ok(JSON.stringify({ v: args?.query === 'second' ? 'same' : 'same' })),
    );

    const body = summary(
      await batchTool.execute({
        steps: [
          { tool: 'chrome_find', as: 'a', args: { query: 'first' } },
          { tool: 'chrome_find', as: 'b', args: { query: 'second' } },
          {
            tool: 'chrome_screenshot',
            when: { path: 'a.v', op: 'eq', value: '{{b.v}}' },
          },
          {
            tool: 'chrome_click_element',
            when: { path: 'a.v', op: 'ne', value: '{{b.v}}' },
            args: { ref: 'x' },
          },
        ],
      } as any),
    );

    expect(body.steps[2].status).toBe('completed');
    expect(body.steps[3].status).toBe('skipped');
    expect(calls.map((c) => c.name)).toEqual(['chrome_find', 'chrome_find', 'chrome_screenshot']);
  });

  it('8b. 빈 all 과 모르는 키는 실행 전에 condition_invalid 로 거절한다', async () => {
    for (const when of [{ all: [] }, { path: 'a.b', op: 'exists', nope: 1 }]) {
      const calls = recordInvoker(() => ok('{}'));
      const result = await batchTool.execute({
        steps: [{ tool: 'chrome_screenshot', when }],
      } as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('condition_invalid');
      expect(calls).toHaveLength(0);
    }
  });
});

describe('조기 종료 stopIf (9, 9a)', () => {
  it('9. stopIf 가 참이면 그 step 은 stopped, 뒤 step 은 skipped 다', async () => {
    const calls = recordInvoker(() => ok('{"matches":[{"ref":"REF1"}]}'));

    const body = summary(
      await batchTool.execute({
        steps: [
          { tool: 'chrome_find', as: 'logout', stopIf: { path: 'logout.matches', op: 'notEmpty' } },
          { tool: 'chrome_screenshot' },
        ],
      } as any),
    );

    expect(body.steps[0].status).toBe('stopped');
    expect(body.steps[0].ok).toBe(true);
    expect(body.steps[1].status).toBe('skipped');
    expect(body.stoppedBy).toEqual({ step: 0, reason: 'stopIf' });
    expect(body.success).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('9a. continueOnError 로 넘긴 실패가 있으면 stopIf 로 끝나도 success 는 false 다', async () => {
    recordInvoker(({ name }) =>
      name === 'chrome_click_element' ? fail('boom') : ok('{"matches":[{"ref":"REF1"}]}'),
    );

    const body = summary(
      await batchTool.execute({
        continueOnError: true,
        steps: [
          { tool: 'chrome_click_element', as: 'bad' },
          { tool: 'chrome_find', as: 'logout', stopIf: { path: 'logout.matches', op: 'notEmpty' } },
          { tool: 'chrome_screenshot' },
        ],
      } as any),
    );

    expect(body.steps[0].status).toBe('failed');
    expect(body.steps[1].status).toBe('stopped');
    expect(body.steps[2].status).toBe('skipped');
    expect(body.stoppedBy.reason).toBe('stopIf');
    expect(body.success).toBe(false);
  });

  it('2e. 건너뛴 step 은 prev 를 갱신하지 않는다', async () => {
    const calls = recordInvoker(({ name }) =>
      name === 'chrome_extract' ? ok('{"tag":"first"}') : ok('{"tag":"second"}'),
    );

    await batchTool.execute({
      steps: [
        { tool: 'chrome_extract', as: 'a' },
        { tool: 'chrome_find', when: { path: 'a.nope', op: 'exists' } },
        { tool: 'chrome_screenshot', args: { note: '{{prev.tag}}' } },
      ],
    } as any);

    expect(calls[calls.length - 1].args.note).toBe('first');
  });
});

/* ------------------------------------------------------------------ *
 * 10. 반복 묶음
 * ------------------------------------------------------------------ */

describe('반복 묶음 repeat (10, 10a, 10b)', () => {
  /** chrome_find 가 n 회차부터 빈 matches 를 돌려주는 invoker. */
  function pagingInvoker(emptyFrom: number) {
    let found = 0;
    return recordInvoker(({ name }) => {
      if (name !== 'chrome_find') return ok('{"page":true}');
      found += 1;
      return ok(JSON.stringify({ matches: found >= emptyFrom ? [] : [{ ref: `REF${found}` }] }));
    });
  }

  const pagingGroup = (repeat: Record<string, unknown>) => ({
    repeat,
    as: 'pages',
    steps: [
      { tool: 'chrome_extract', as: 'page' },
      { tool: 'chrome_find', as: 'next' },
    ],
  });

  it('10. until 이 참인 회차에서 멈추고 attempts.stoppedBy 는 until 이다', async () => {
    pagingInvoker(3);

    const body = summary(
      await batchTool.execute({
        return: ['pages'],
        steps: [pagingGroup({ max: 20, until: { path: 'next.matches', op: 'empty' } })],
      } as any),
    );

    expect(body.steps).toHaveLength(1);
    expect(body.steps[0].tool).toBe('repeat');
    expect(body.steps[0].attempts).toEqual({ count: 3, stoppedBy: 'until' });
    expect(body.steps[0].status).toBe('completed');
    expect(body.steps[0].resultText).toBe('{"matches":[]}');
    expect(body.results.pages).toHaveLength(3);
    expect(body.results.pages[0]).toEqual({
      page: { page: true },
      next: { matches: [{ ref: 'REF1' }] },
    });
    expect(body.success).toBe(true);
  });

  it('10. until 이 끝내 거짓이면 정확히 max 회에서 max 로 멈춘다', async () => {
    const calls = pagingInvoker(99);

    const body = summary(
      await batchTool.execute({
        return: ['pages'],
        steps: [pagingGroup({ max: 3, until: { path: 'next.matches', op: 'empty' } })],
      } as any),
    );

    expect(body.steps[0].attempts).toEqual({ count: 3, stoppedBy: 'max' });
    expect(body.results.pages).toHaveLength(3);
    expect(calls).toHaveLength(6);
  });

  it('10. delayMs 는 회차 사이에 그만큼 이상 기다린다', async () => {
    pagingInvoker(99);
    const started = Date.now();

    const body = summary(
      await batchTool.execute({
        steps: [pagingGroup({ max: 2, delayMs: 500 })],
      } as any),
    );

    expect(body.steps[0].attempts.count).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(490);
  });

  it('10a. loop.index 는 회차마다 0,1,2 이고 묶음 밖에서는 unresolved_reference 다', async () => {
    const calls = recordInvoker(() => ok('{"page":true}'));

    const body = summary(
      await batchTool.execute({
        continueOnError: true,
        steps: [
          {
            repeat: { max: 3 },
            steps: [{ tool: 'chrome_extract', args: { query: 'p{{loop.index}}/{{loop.count}}' } }],
          },
          { tool: 'chrome_screenshot', args: { note: '{{loop.index}}' } },
        ],
      } as any),
    );

    expect(calls.slice(0, 3).map((c) => c.args.query)).toEqual(['p0/1', 'p1/2', 'p2/3']);
    expect(body.steps[1].ok).toBe(false);
    expect(body.steps[1].error).toContain('unresolved_reference');
  });

  it('10a. 안쪽 when 으로 건너뛴 step 은 스냅샷에 키를 남기지 않고 prev 는 회차마다 비워진다', async () => {
    const calls = recordInvoker(({ name }) =>
      name === 'chrome_extract' ? ok('{"tag":"page"}') : ok('{"matches":[]}'),
    );

    const body = summary(
      await batchTool.execute({
        return: ['pages'],
        steps: [
          {
            repeat: { max: 2 },
            as: 'pages',
            steps: [
              {
                tool: 'chrome_screenshot',
                args: { note: '{{prev.$ok}}' },
                when: { path: 'prev.$ok', op: 'exists' },
              },
              { tool: 'chrome_extract', as: 'page' },
              { tool: 'chrome_find', as: 'gone', when: { path: 'page.nope', op: 'exists' } },
            ],
          },
        ],
      } as any),
    );

    // 회차 시작 시 prev 가 비어 있으므로 첫 step 은 두 회차 모두 건너뛴다.
    expect(calls.map((c) => c.name)).toEqual(['chrome_extract', 'chrome_extract']);
    expect(body.results.pages).toEqual([{ page: { tag: 'page' } }, { page: { tag: 'page' } }]);
  });

  it('10b. 안쪽 실패는 attempts.stoppedBy failure 이고 묶음은 failed 다', async () => {
    recordInvoker(({ name }) => (name === 'chrome_find' ? fail('boom') : ok('{"page":true}')));

    const body = summary(
      await batchTool.execute({
        steps: [pagingGroup({ max: 5 }), { tool: 'chrome_screenshot' }],
      } as any),
    );

    expect(body.steps[0].attempts).toEqual({ count: 1, stoppedBy: 'failure' });
    expect(body.steps[0].status).toBe('failed');
    expect(body.steps[0].error).toBe('boom');
    expect(body.steps[1].status).toBe('skipped');
    expect(body.success).toBe(false);
    expect(body.stoppedAtStep).toBe(0);
  });

  it('10b. 안쪽 stopIf 는 stoppedBy stopIf 이고 묶음은 stopped, batch 도 끝난다', async () => {
    recordInvoker(() => ok('{"matches":[{"ref":"REF1"}]}'));

    const body = summary(
      await batchTool.execute({
        steps: [
          {
            repeat: { max: 5 },
            as: 'pages',
            steps: [
              { tool: 'chrome_find', as: 'next', stopIf: { path: 'next.matches', op: 'notEmpty' } },
            ],
          },
          { tool: 'chrome_screenshot' },
        ],
      } as any),
    );

    expect(body.steps[0].attempts).toEqual({ count: 1, stoppedBy: 'stopIf' });
    expect(body.steps[0].status).toBe('stopped');
    expect(body.steps[1].status).toBe('skipped');
    expect(body.stoppedBy).toEqual({ step: 0, reason: 'stopIf' });
  });
});

describe('반복 묶음 거절 규칙 (2c, 10c, 10d)', () => {
  const screenshot = { tool: 'chrome_screenshot' };

  /** 깊이 n 의 조건 (leaf 하나가 깊이 1). */
  function deepCondition(depth: number) {
    let node: any = { path: 'a.b', op: 'exists' };
    for (let i = 1; i < depth; i++) node = { not: node };
    return node;
  }

  it('10c. max·delayMs·중첩·조건 위반은 실행 전에 각각의 코드로 거절한다', async () => {
    const cases: [string, any, string][] = [
      ['max 누락', { repeat: {}, steps: [screenshot] }, 'repeat_max_invalid'],
      ['max 0', { repeat: { max: 0 }, steps: [screenshot] }, 'repeat_max_invalid'],
      ['max 1.5', { repeat: { max: 1.5 }, steps: [screenshot] }, 'repeat_max_invalid'],
      ['max 21', { repeat: { max: 21 }, steps: [screenshot] }, 'repeat_max_invalid'],
      [
        'delayMs 5001',
        { repeat: { max: 2, delayMs: 5001 }, steps: [screenshot] },
        'delay_too_long',
      ],
      [
        '묶음 안 repeat',
        { repeat: { max: 2 }, steps: [{ repeat: { max: 2 }, steps: [screenshot] }] },
        'nested_repeat',
      ],
      ['깊이 9', { tool: 'chrome_screenshot', when: deepCondition(9) }, 'condition_too_deep'],
      [
        '노드 65',
        {
          tool: 'chrome_screenshot',
          when: { all: Array.from({ length: 64 }, () => ({ path: 'a.b', op: 'exists' })) },
        },
        'condition_too_large',
      ],
      [
        'op matches',
        { tool: 'chrome_screenshot', when: { path: 'a.b', op: 'matches', value: 'x' } },
        'condition_invalid',
      ],
    ];

    for (const [label, step, code] of cases) {
      const calls = recordInvoker(() => ok('{}'));
      const result = await batchTool.execute({ steps: [step] } as any);
      expect(result.isError, label).toBe(true);
      expect(result.content[0].text, label).toContain(code);
      expect(calls, label).toHaveLength(0);
    }
  });

  it('10c. 깊이 8 과 노드 64 는 통과한다 (경계값)', async () => {
    recordInvoker(() => ok('{}'));
    const okDepth = await batchTool.execute({
      steps: [{ tool: 'chrome_screenshot', when: deepCondition(8) }],
    } as any);
    expect(okDepth.isError).toBe(false);

    const okNodes = await batchTool.execute({
      steps: [
        {
          tool: 'chrome_screenshot',
          when: { all: Array.from({ length: 63 }, () => ({ path: 'a.b', op: 'exists' })) },
        },
      ],
    } as any);
    expect(okNodes.isError).toBe(false);
  });

  it('10d. 선언 19개 + 묶음 1개는 20 으로 통과하고, 묶음 2개 + 19개는 거절한다', async () => {
    const calls = recordInvoker(() => ok('{}'));
    const group = {
      repeat: { max: 1 },
      steps: Array.from({ length: 5 }, () => ({ tool: 'chrome_screenshot' })),
    };
    const plain = (n: number) => Array.from({ length: n }, () => ({ tool: 'chrome_screenshot' }));

    const passing = await batchTool.execute({ steps: [...plain(19), group] } as any);
    expect(passing.isError).toBe(false);
    expect(calls).toHaveLength(24);

    const rejected = await batchTool.execute({ steps: [group, group, ...plain(19)] } as any);
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toContain('steps must contain at most 20 items');
  });

  it('2c. 묶음 as 와 안쪽 as 가 충돌하면 duplicate_as 다', async () => {
    const calls = recordInvoker(() => ok('{}'));
    const result = await batchTool.execute({
      steps: [
        {
          repeat: { max: 2 },
          as: 'dup',
          steps: [{ tool: 'chrome_extract', as: 'dup' }],
        },
      ],
    } as any);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('duplicate_as');
    expect(calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * 11. 호출 수와 벽시계 상한
 * ------------------------------------------------------------------ */

describe('상한 (11)', () => {
  it('11. 100번째 호출까지 실행하고 101번째 직전에 total_runs_exceeded 로 멈춘다', async () => {
    const calls = recordInvoker(() => ok('{"a":1}'));

    const body = summary(
      await batchTool.execute({
        return: ['pages'],
        steps: [
          {
            repeat: { max: 20 },
            as: 'pages',
            steps: Array.from({ length: 6 }, () => ({ tool: 'chrome_screenshot' })),
          },
          { tool: 'chrome_extract' },
        ],
      } as any),
    );

    expect(calls).toHaveLength(100);
    expect(body.stoppedBy).toEqual({ step: 0, reason: 'total_runs_exceeded' });
    expect(body.steps[1].status).toBe('skipped');
    expect(body.results.pages).toHaveLength(17);
  });

  it('11. 벽시계 100초를 넘기면 timeout 이고 invoker 는 절대 마감을 받는다', async () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      const seen: (number | undefined)[] = [];
      const handler = async (call: any) => {
        seen.push(call.deadlineAt);
        vi.advanceTimersByTime(2000);
        return ok('{"a":1}');
      };
      setBatchToolInvoker(handler);

      const body = summary(
        await batchTool.execute({
          return: ['pages'],
          steps: [
            {
              repeat: { max: 20 },
              as: 'pages',
              steps: Array.from({ length: 3 }, () => ({ tool: 'chrome_screenshot' })),
            },
          ],
        } as any),
      );

      expect(seen).toHaveLength(50);
      // 절대 시각이므로 step 마다 같은 값이다 - 상대값은 게이트·락 대기 동안 낡는다(항목 4).
      expect(new Set(seen).size).toBe(1);
      expect(seen[0]).toBe(startedAt + 100_000);
      expect(body.stoppedBy).toEqual({ step: 0, reason: 'timeout' });
      expect(body.results.pages.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('11. 도구가 FlowDeadlineExceededError 를 올리면 stoppedBy.reason 은 timeout 이다', async () => {
    // 락 대기·게이트 지연으로 예산이 끝나면 handleCallTool 이 이 예외를 올린다.
    // 예전에는 평범한 실패로 보고돼 stoppedBy 가 아예 붙지 않았다 (항목 4).
    let call = 0;
    setBatchToolInvoker(async () => {
      call += 1;
      if (call === 2) throw new FlowDeadlineExceededError('chrome_screenshot', 'after the lock');
      return ok('{"a":1}');
    });

    const body = summary(
      await batchTool.execute({
        templates: true,
        steps: [{ tool: 'chrome_extract' }, { tool: 'chrome_screenshot' }, { tool: 'chrome_find' }],
      } as any),
    );

    expect(body.steps[1].status).toBe('stopped');
    expect(body.steps[1].error).toContain('flow_deadline_exceeded');
    expect(body.steps[2].status).toBe('skipped');
    expect(body.stoppedBy).toEqual({ step: 1, reason: 'timeout' });
  });

  it('11. 흐름 키가 없는 v1 호출에는 deadline 을 넘기지 않는다', async () => {
    const calls: any[] = [];
    setBatchToolInvoker(async (call: any) => {
      calls.push(call);
      return ok('{}');
    });

    await batchTool.execute({ steps: [{ tool: 'chrome_screenshot' }] } as any);
    expect('deadlineAt' in calls[0]).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 12. 문서 예시 (b) (c) 를 그대로 실행
 * ------------------------------------------------------------------ */

describe('문서 예시 통합 (12)', () => {
  it('12. 예시 (b): 다음 버튼이 사라질 때까지 목록을 수집한다', async () => {
    let found = 0;
    const calls = recordInvoker(({ name }) => {
      if (name === 'chrome_extract') return ok('{"values":{"titles":["a"],"links":["/1"]}}');
      if (name === 'chrome_find') {
        found += 1;
        return ok(JSON.stringify({ matches: found >= 3 ? [] : [{ ref: `NEXT${found}` }] }));
      }
      return ok('{"ok":true}');
    });

    const body = summary(
      await batchTool.execute({
        return: ['pages'],
        steps: [
          { tool: 'chrome_navigate', args: { url: 'https://list.example.com/items?page=1' } },
          {
            repeat: { max: 20, until: { path: 'next.matches', op: 'empty' }, delayMs: 0 },
            as: 'pages',
            steps: [
              {
                tool: 'chrome_extract',
                as: 'page',
                args: {
                  fields: {
                    titles: { selector: '.item h3', all: true },
                    links: { selector: '.item a', attr: 'href', all: true },
                  },
                },
              },
              {
                tool: 'chrome_find',
                as: 'next',
                args: { query: '다음 페이지 버튼', maxResults: 1 },
              },
              {
                tool: 'chrome_click_element',
                when: { path: 'next.matches', op: 'notEmpty' },
                args: { ref: '{{next.matches[0].ref}}' },
              },
              {
                tool: 'chrome_wait_for',
                when: { path: 'next.matches', op: 'notEmpty' },
                args: { selector: '.item', timeout: 5000 },
              },
            ],
          },
        ],
      } as any),
    );

    expect(body.success).toBe(true);
    expect(body.steps).toHaveLength(2);
    expect(body.steps[1].attempts).toEqual({ count: 3, stoppedBy: 'until' });
    expect(body.results.pages).toHaveLength(3);
    expect(body.results.pages[2].next).toEqual({ matches: [] });
    // 마지막 회차에서는 클릭·대기가 건너뛰어져 스냅샷에도 없다.
    expect(Object.keys(body.results.pages[2])).toEqual(['page', 'next']);
    // 클릭은 ref 를 앞 step 결과에서 받아 두 번만 일어난다.
    const clicks = calls.filter((c) => c.name === 'chrome_click_element');
    expect(clicks.map((c) => c.args.ref)).toEqual(['NEXT1', 'NEXT2']);
  });

  it('12. 예시 (c): 파라미터 받는 로그인 shortcut 이 로그아웃 버튼을 보면 멈춘다', async () => {
    const store = stubStorage();
    const saved = await shortcutTool.execute({
      action: 'save',
      name: 'site-login',
      params: {
        user: { required: true, description: '아이디' },
        pw: { required: true, secret: true },
        url: { default: 'https://example.com/login' },
      },
      steps: [
        { tool: 'chrome_navigate', args: { url: '{{params.url}}' } },
        { tool: 'chrome_find', as: 'idBox', args: { query: '아이디 입력창', maxResults: 1 } },
        {
          tool: 'chrome_fill_or_select',
          args: { ref: '{{idBox.matches[0].ref}}', value: '{{params.user}}' },
        },
        { tool: 'chrome_find', as: 'pwBox', args: { query: '비밀번호 입력창', maxResults: 1 } },
        {
          tool: 'chrome_fill_or_select',
          args: { ref: '{{pwBox.matches[0].ref}}', value: '{{params.pw}}' },
        },
        { tool: 'chrome_keyboard', args: { keys: 'Enter' } },
        {
          tool: 'chrome_find',
          as: 'logout',
          args: { query: '로그아웃 버튼', maxResults: 1 },
          stopIf: { path: 'logout.matches', op: 'notEmpty' },
        },
        { tool: 'chrome_screenshot' },
      ],
    } as any);
    expect(saved.isError).toBe(false);

    const calls = recordInvoker(({ name, args }) => {
      if (name === 'chrome_find') return ok(JSON.stringify({ matches: [{ ref: 'BOX' }] }));
      if (name === 'chrome_fill_or_select') return ok(JSON.stringify({ filled: args.value }));
      return ok('{"ok":true}');
    });

    const result = await shortcutTool.execute({
      action: 'run',
      name: 'site-login',
      params: { user: 'me@example.com', pw: 'sup3rsecret!' },
    } as any);
    const body = summary(result);

    expect(calls.map((c) => c.name)).toEqual([
      'chrome_navigate',
      'chrome_find',
      'chrome_fill_or_select',
      'chrome_find',
      'chrome_fill_or_select',
      'chrome_keyboard',
      'chrome_find',
    ]);
    expect(calls[0].args.url).toBe('https://example.com/login');
    expect(calls[2].args.value).toBe('me@example.com');
    expect(calls[4].args.value).toBe('sup3rsecret!');
    expect(body.steps[6].status).toBe('stopped');
    expect(body.steps[7].status).toBe('skipped');
    expect(body.stoppedBy.reason).toBe('stopIf');
    // 비밀번호는 응답에도 저장소에도 원문으로 남지 않는다.
    expect(result.content[0].text).not.toContain('sup3rsecret!');
    expect(result.content[0].text).toContain('***');
    expect(JSON.stringify(store)).not.toContain('sup3rsecret!');
  });
});

/* ------------------------------------------------------------------ *
 * 12·13. shortcut 파라미터
 * ------------------------------------------------------------------ */

describe('shortcut params 선언 (12)', () => {
  const oneStep = [{ tool: 'chrome_screenshot' }];

  it('12. required+default·secret+default·모르는 필드·17개 선언은 param_declaration_invalid 다', async () => {
    const cases: [string, any][] = [
      ['required+default', { a: { required: true, default: 'x' } }],
      ['secret+default', { a: { secret: true, default: 'x' } }],
      ['모르는 필드', { a: { nope: 1 } }],
      ['이름 규칙 위반', { '9bad': {} }],
      ['17개', Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`p${i}`, {}]))],
    ];

    for (const [label, params] of cases) {
      stubStorage();
      const result = await shortcutTool.execute({
        action: 'save',
        name: 'decl',
        params,
        steps: oneStep,
      } as any);
      expect(result.isError, label).toBe(true);
      expect(result.content[0].text, label).toContain('param_declaration_invalid');
    }
  });

  it('12. 16개 선언은 통과한다 (경계값)', async () => {
    stubStorage();
    const result = await shortcutTool.execute({
      action: 'save',
      name: 'decl16',
      params: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`p${i}`, {}])),
      steps: oneStep,
    } as any);
    expect(result.isError).toBe(false);
  });

  it('12. list 에 선언이 실리고 secret 에는 값이 될 만한 것이 없다', async () => {
    stubStorage();
    await shortcutTool.execute({
      action: 'save',
      name: 'login',
      params: {
        user: { required: true, description: '아이디' },
        pw: { required: true, secret: true },
        url: { default: 'https://example.com/login' },
      },
      steps: [
        { tool: 'chrome_navigate', args: { url: '{{params.url}}' } },
        { tool: 'chrome_fill_or_select', args: { value: '{{params.user}}', v2: '{{params.pw}}' } },
      ],
    } as any);

    const body = summary(await shortcutTool.execute({ action: 'list' } as any));
    expect(body.shortcuts[0].params).toEqual([
      { name: 'user', required: true, description: '아이디' },
      { name: 'pw', required: true, secret: true },
      { name: 'url', required: false, default: 'https://example.com/login' },
    ]);
  });

  it('13. {{params.x}} 를 쓰면서 선언하지 않으면 저장 시 undeclared_param 이다', async () => {
    stubStorage();
    const result = await shortcutTool.execute({
      action: 'save',
      name: 'bad',
      params: { other: {} },
      steps: [{ tool: 'chrome_navigate', args: { url: '{{params.url}}' } }],
    } as any);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('undeclared_param');
  });
});

describe('shortcut params 실행 (13)', () => {
  async function saveLogin(params: any, steps?: any[]) {
    return shortcutTool.execute({
      action: 'save',
      name: 'login',
      params,
      steps: steps ?? [
        { tool: 'chrome_navigate', args: { url: '{{params.url}}' } },
        { tool: 'chrome_fill_or_select', args: { value: '{{params.user}}' } },
      ],
    } as any);
  }

  it('13. required 누락은 missing_param, 미선언 이름은 unknown_param 으로 실행 전에 막는다', async () => {
    stubStorage();
    await saveLogin({ user: { required: true }, url: { default: 'https://x.test/' } });

    const calls = recordInvoker(() => ok('{}'));

    const missing = await shortcutTool.execute({ action: 'run', name: 'login' } as any);
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('missing_param');

    const unknown = await shortcutTool.execute({
      action: 'run',
      name: 'login',
      params: { user: 'me', nope: 1 },
    } as any);
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain('unknown_param');
    expect(calls).toHaveLength(0);
  });

  it('13. 전달값이 default 를 이기고, null 도 전달된 값으로 본다', async () => {
    stubStorage();
    await saveLogin({ user: { default: 'anon' }, url: { default: 'https://x.test/' } });
    const calls = recordInvoker(() => ok('{}'));

    await shortcutTool.execute({
      action: 'run',
      name: 'login',
      params: { user: 'me@example.com' },
    } as any);
    expect(calls[1].args.value).toBe('me@example.com');

    await shortcutTool.execute({ action: 'run', name: 'login', params: { user: null } } as any);
    expect(calls[3].args.value).toBe(null);
  });

  it('13. default 없는 optional 을 안 넘기고 참조하면 unresolved_reference 다', async () => {
    stubStorage();
    await saveLogin({ user: {}, url: { default: 'https://x.test/' } });
    recordInvoker(() => ok('{}'));

    const body = summary(await shortcutTool.execute({ action: 'run', name: 'login' } as any));
    expect(body.steps[1].ok).toBe(false);
    expect(body.steps[1].error).toContain('unresolved_reference');
  });

  it('13. secret 에 문자열이 아닌 값을 넘기면 param_type_invalid 다', async () => {
    stubStorage();
    await saveLogin({ pw: { secret: true } }, [
      { tool: 'chrome_fill_or_select', args: { value: '{{params.pw}}' } },
    ]);

    for (const pw of [123, null]) {
      const result = await shortcutTool.execute({
        action: 'run',
        name: 'login',
        params: { pw },
      } as any);
      expect(result.isError, String(pw)).toBe(true);
      expect(result.content[0].text, String(pw)).toContain('param_type_invalid');
    }
  });

  it('13. 짧은 secret 도 가려지고 warnings 가 붙는다', async () => {
    stubStorage();
    await saveLogin({ pin: { secret: true } }, [
      { tool: 'chrome_fill_or_select', args: { value: '{{params.pin}}' } },
    ]);
    const calls = recordInvoker(({ args }) => ok(JSON.stringify({ filled: args.value })));

    const result = await shortcutTool.execute({
      action: 'run',
      name: 'login',
      params: { pin: '135' },
    } as any);
    const body = summary(result);

    // 도구에는 원문이 가고, 응답에는 가려진 값만 남는다.
    expect(calls[0].args.value).toBe('135');
    expect(body.steps[0].resultText).toBe('{"filled":"***"}');
    expect(body.warnings[0]).toContain('pin');
  });

  it('13. 실행 뒤 저장소에는 전달값이 없고 runCount 만 1 오른다', async () => {
    const store = stubStorage();
    await saveLogin(
      { user: { required: true }, pw: { secret: true }, url: { default: 'https://x.test/' } },
      [
        { tool: 'chrome_navigate', args: { url: '{{params.url}}' } },
        { tool: 'chrome_fill_or_select', args: { value: '{{params.user}}', pw: '{{params.pw}}' } },
      ],
    );
    recordInvoker(() => ok('{}'));

    await shortcutTool.execute({
      action: 'run',
      name: 'login',
      params: { user: 'me@example.com', pw: 'topsecretvalue' },
    } as any);

    const record = store.mcpShortcuts.login;
    expect(record.runCount).toBe(1);
    expect(record.params).toEqual({
      user: { required: true },
      pw: { secret: true },
      url: { default: 'https://x.test/' },
    });
    const dump = JSON.stringify(store);
    expect(dump).not.toContain('topsecretvalue');
    expect(dump).not.toContain('me@example.com');
  });
});

/* ------------------------------------------------------------------ *
 * 15. 사용자에게 보이는 문구의 대시 스캔
 * ------------------------------------------------------------------ */

describe('대시 스캔 (15)', () => {
  const DASHES = ['—', '–', 'ㅡ', '―', '‒', '－', '−'];
  const scan = (text: string, label: string) => {
    for (const dash of DASHES) {
      expect(text.includes(dash), `${label} contains ${JSON.stringify(dash)}`).toBe(false);
    }
  };

  it('15. chrome_batch·chrome_shortcut 스키마 설명에 대시가 없다', async () => {
    const { TOOL_SCHEMAS } = await import('auto-chrome-mcp-shared');
    const targets = (TOOL_SCHEMAS as any[]).filter((tool) =>
      ['chrome_batch', 'chrome_shortcut'].includes(tool.name),
    );
    expect(targets).toHaveLength(2);
    scan(JSON.stringify(targets), 'schema');
  });

  it('15. 흐름 제어 오류 문구에 대시가 없다', async () => {
    stubStorage();
    recordInvoker(() => ok('{"matches":[]}'));

    const texts: string[] = [];
    const batchCases: any[] = [
      { steps: [{ tool: 'chrome_screenshot', when: { all: [] } }] },
      { steps: [{ repeat: { max: 0 }, steps: [{ tool: 'chrome_screenshot' }] }] },
      { steps: [{ repeat: { max: 2, delayMs: 5001 }, steps: [{ tool: 'chrome_screenshot' }] }] },
      { steps: [{ repeat: { max: 2 }, as: 'x', steps: [{ tool: 'chrome_extract', as: 'x' }] }] },
      { return: ['nope'], steps: [{ tool: 'chrome_extract', as: 'page' }] },
      {
        continueOnError: true,
        steps: [
          { tool: 'chrome_find', as: 'hit' },
          { tool: 'chrome_click_element', args: { ref: '{{hit.matches[0].ref}}' } },
          { tool: 'chrome_click_element', args: { tabId: '{{hit.id}}' } },
          { tool: 'chrome_screenshot', when: { path: 'hit.nope', op: 'eq', value: 1 } },
        ],
      },
    ];
    for (const args of batchCases) {
      texts.push((await batchTool.execute(args)).content[0].text);
    }

    const shortcutCases: any[] = [
      {
        action: 'save',
        name: 'p',
        params: { a: { required: true, default: 1 } },
        steps: [{ tool: 'chrome_screenshot' }],
      },
      {
        action: 'save',
        name: 'p',
        params: { b: {} },
        steps: [{ tool: 'chrome_navigate', args: { url: '{{params.zz}}' } }],
      },
      { action: 'run', name: 'nope' },
    ];
    for (const args of shortcutCases) {
      texts.push((await shortcutTool.execute(args)).content[0].text);
    }

    const joined = texts.join('\n');
    scan(joined, 'errors');
    expect(joined).toContain('condition_invalid');
    expect(joined).toContain('unresolved_reference');
    expect(joined).toContain('template_forbidden_key');
    expect(joined).toContain('undeclared_param');
  });
});
