/**
 * auto-chrome-mcp fork — 2026-09-04 Codex 최종 리뷰(NO-GO 7건) 회귀 테스트.
 *
 * 계약: docs/plans/2026-09-04-batch-flow-design.md 4절·9절.
 * 각 describe 의 번호는 리뷰 지적 번호다. 수정 전에는 전부 실패해야 한다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { batchTool, setBatchToolInvoker } from '@/entrypoints/background/tools/browser/batch';
import {
  shortcutTool,
  setShortcutToolInvoker,
} from '@/entrypoints/background/tools/browser/shortcut';
import {
  ALWAYS_FORBIDDEN_TEMPLATE_KEYS,
  StepTemplateError,
  assertPlainArgsShape,
} from '@/utils/step-template';
import { prepareStepArgs } from '@/entrypoints/background/tools/browser/batch-runner';
import { redactedArgsForLog } from '@/utils/log-redact';

const txt = (text: string) => ({ type: 'text', text });
const ok = (text: string) => ({ content: [txt(text)], isError: false });

function summary(result: any) {
  return JSON.parse((result.content[0] as any).text);
}

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

beforeEach(() => {
  stubStorage();
  recordInvoker(() => ok('{}'));
});

/* ------------------------------------------------------------------ *
 * 1. prototype 경유 게이트 우회
 * ------------------------------------------------------------------ */

describe('prototype 경유 게이트 우회 (1)', () => {
  it('1. args 의 __proto__ 키로 tabId 를 상속시켜 게이트를 우회할 수 없다', async () => {
    const calls = recordInvoker(({ name }) =>
      name === 'chrome_extract' ? ok(JSON.stringify({ tabId: 123 })) : ok('{}'),
    );

    // JS 리터럴로 쓰면 prototype 설정으로 흡수되므로 JSON 으로 실제 own key 를 만든다.
    const steps = JSON.parse(
      '[{"tool":"chrome_extract","as":"t"},' +
        '{"tool":"chrome_click_element","args":{"__proto__":"{{t}}"}}]',
    );

    const body = summary(await batchTool.execute({ templates: true, steps } as any));

    // 클릭은 아예 실행되지 않아야 한다.
    expect(calls.map((c) => c.name)).toEqual(['chrome_extract']);
    expect(body.steps[1].status).toBe('failed');
    expect(body.steps[1].error).toMatch(/forbidden_path_segment|template_forbidden_key/);
  });

  it('1. constructor·prototype 키도 입력 단계에서 forbidden_path_segment 로 거절한다', async () => {
    for (const key of ['constructor', 'prototype']) {
      const calls = recordInvoker(() => ok('{"a":1}'));
      const steps = JSON.parse(
        `[{"tool":"chrome_extract","as":"t"},` +
          `{"tool":"chrome_click_element","args":{"${key}":"{{t}}"}}]`,
      );
      const body = summary(await batchTool.execute({ templates: true, steps } as any));
      expect(
        calls.map((c) => c.name),
        key,
      ).toEqual(['chrome_extract']);
      expect(body.steps[1].error, key).toContain('forbidden_path_segment');
    }
  });

  it('1. 중첩 args 안의 __proto__ 키도 잡는다 (chrome_userscript 의 args.args)', async () => {
    const calls = recordInvoker(() => ok('{"a":1}'));
    const steps = JSON.parse(
      '[{"tool":"chrome_extract","as":"t"},' +
        '{"tool":"chrome_find","args":{"nested":{"__proto__":"{{t}}"}}}]',
    );
    const body = summary(await batchTool.execute({ templates: true, steps } as any));
    expect(calls.map((c) => c.name)).toEqual(['chrome_extract']);
    expect(body.steps[1].error).toContain('forbidden_path_segment');
  });

  it('1. 치환이 만든 객체에 대입해도 args 의 prototype 은 바뀌지 않는다', () => {
    const rawArgs = JSON.parse('{"__proto__":{"tabId":123}}');
    // 치환이 꺼진 v1 경로에서도 상속된 tabId 가 생기면 안 된다.
    const out = prepareStepArgs({
      rawArgs,
      toolName: 'chrome_click_element',
      scope: { named: new Map() },
      templatesEnabled: false,
      backgroundModeOn: false,
    });
    expect(out.tabId).toBeUndefined();
  });

  it('1. invocation 직전 검사: prototype 이 오염된 args 는 template_forbidden_key 다', () => {
    const polluted = Object.create({ tabId: 123 });
    polluted.selector = '#a';
    expect(() => assertPlainArgsShape(polluted, ALWAYS_FORBIDDEN_TEMPLATE_KEYS)).toThrow(
      StepTemplateError,
    );
    try {
      assertPlainArgsShape(polluted, ALWAYS_FORBIDDEN_TEMPLATE_KEYS);
    } catch (error) {
      expect((error as StepTemplateError).code).toBe('template_forbidden_key');
    }
    // 평범한 객체와 prototype 없는 객체는 통과한다.
    expect(() =>
      assertPlainArgsShape({ a: [1, { b: Object.create(null) }] }, ALWAYS_FORBIDDEN_TEMPLATE_KEYS),
    ).not.toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * 2. secret 평문 로그
 * ------------------------------------------------------------------ */

describe('로그 마스킹 (2)', () => {
  it('2. redactedArgsForLog 는 비민감 필드만 남기고 나머지는 가린다', () => {
    const redacted = redactedArgsForLog({
      tabId: 7,
      selector: '#pw',
      value: 'sup3rsecret!',
      keys: 'Enter',
      body: { token: 'abc' },
      headers: { Authorization: 'Bearer x' },
      code: 'document.cookie',
    });
    const text = JSON.stringify(redacted);
    expect(redacted).toMatchObject({ tabId: 7, selector: '#pw' });
    expect(text).not.toContain('sup3rsecret!');
    expect(text).not.toContain('Bearer x');
    expect(text).not.toContain('document.cookie');
    expect(text).not.toContain('Enter');
  });

  it('2. url 은 origin+경로만 남고 쿼리·해시는 지운다', () => {
    const redacted = redactedArgsForLog({ url: 'https://x.example/a?token=SECRET#frag' });
    expect(redacted!.url).toBe('https://x.example/a');
    expect(JSON.stringify(redacted)).not.toContain('SECRET');
  });

  it('2. fill·keyboard·network_request 는 raw args 를 콘솔에 찍지 않는다', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const [{ fillTool }, { keyboardTool }, { networkRequestTool }] = await Promise.all([
        import('@/entrypoints/background/tools/browser/interaction'),
        import('@/entrypoints/background/tools/browser/keyboard'),
        import('@/entrypoints/background/tools/browser/network-request'),
      ]);
      await fillTool.execute({ selector: '#pw', value: 'sup3rsecret!' } as any).catch(() => {});
      await keyboardTool.execute({ keys: 'sup3rsecret!' } as any).catch(() => {});
      await networkRequestTool
        .execute({
          url: 'https://x.example/a',
          method: 'POST',
          headers: { Authorization: 'Bearer sup3rsecret!' },
          body: 'sup3rsecret!',
        } as any)
        .catch(() => {});

      const logged = spy.mock.calls.map((call) => JSON.stringify(call)).join('\n');
      expect(logged).not.toContain('sup3rsecret!');
    } finally {
      spy.mockRestore();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 3. flow 안 userscript 영속
 * ------------------------------------------------------------------ */

describe('flow 안 stateful 도구 (3)', () => {
  it('3. 치환이 켜진 batch 의 chrome_userscript create 는 flow_stateful_tool_forbidden 이다', async () => {
    const calls = recordInvoker(() => ok('{"a":1}'));

    const body = summary(
      await batchTool.execute({
        templates: true,
        steps: [
          {
            tool: 'chrome_userscript',
            args: { action: 'create', args: { script: 'console.log(1)' } },
          },
        ],
      } as any),
    );

    expect(calls).toHaveLength(0);
    expect(body.steps[0].status).toBe('failed');
    expect(body.steps[0].error).toContain('flow_stateful_tool_forbidden');
  });

  it('3. update·enable 도 같은 코드로 거절하고 list·get 은 통과한다', async () => {
    for (const action of ['update', 'enable']) {
      const calls = recordInvoker(() => ok('{"a":1}'));
      const body = summary(
        await batchTool.execute({
          templates: true,
          steps: [{ tool: 'chrome_userscript', args: { action } }],
        } as any),
      );
      expect(calls, action).toHaveLength(0);
      expect(body.steps[0].error, action).toContain('flow_stateful_tool_forbidden');
    }

    const calls = recordInvoker(() => ok('{"a":1}'));
    const body = summary(
      await batchTool.execute({
        templates: true,
        steps: [{ tool: 'chrome_userscript', args: { action: 'list' } }],
      } as any),
    );
    expect(calls).toHaveLength(1);
    expect(body.steps[0].status).toBe('completed');
  });

  it('3. 치환된 action 도 실행 직전에 잡는다', async () => {
    const calls = recordInvoker(({ name }) =>
      name === 'chrome_extract' ? ok(JSON.stringify({ a: 'create' })) : ok('{"a":1}'),
    );
    const body = summary(
      await batchTool.execute({
        templates: true,
        steps: [
          { tool: 'chrome_extract', as: 't' },
          { tool: 'chrome_userscript', args: { action: '{{t.a}}' } },
        ],
      } as any),
    );
    expect(calls.map((c) => c.name)).toEqual(['chrome_extract']);
    expect(body.steps[1].error).toContain('flow_stateful_tool_forbidden');
  });

  it('3. v1 batch 는 예전대로 chrome_userscript create 를 통과시킨다', async () => {
    const calls = recordInvoker(() => ok('{"a":1}'));
    const body = summary(
      await batchTool.execute({
        steps: [{ tool: 'chrome_userscript', args: { action: 'create', args: { script: 'x' } } }],
      } as any),
    );
    expect(calls).toHaveLength(1);
    expect(body.steps[0].status).toBe('completed');
  });
});

/* ------------------------------------------------------------------ *
 * 5. shortcut 에 repeat 묶음 저장
 * ------------------------------------------------------------------ */

describe('shortcut repeat 저장 (5)', () => {
  it('5. 문서 예시 (b) 의 묶음을 shortcut 으로 저장하고 실행할 수 있다', async () => {
    stubStorage();

    const saved = await shortcutTool.execute({
      action: 'save',
      name: 'collect-pages',
      templates: true,
      steps: [
        { tool: 'chrome_navigate', args: { url: 'https://list.example.com/items?page=1' } },
        {
          repeat: { max: 20, until: { path: 'next.matches', op: 'empty' }, delayMs: 0 },
          as: 'pages',
          steps: [
            {
              tool: 'chrome_extract',
              as: 'page',
              args: { fields: { titles: { selector: '.item h3', all: true } } },
            },
            { tool: 'chrome_find', as: 'next', args: { query: '다음 페이지 버튼' } },
            {
              tool: 'chrome_click_element',
              when: { path: 'next.matches', op: 'notEmpty' },
              args: { ref: '{{next.matches[0].ref}}' },
            },
          ],
        },
      ],
    } as any);
    expect(saved.isError, (saved.content[0] as any).text).toBe(false);

    let found = 0;
    recordInvoker(({ name }) => {
      if (name === 'chrome_extract') return ok('{"values":{"titles":["a"]}}');
      if (name === 'chrome_find') {
        found += 1;
        return ok(JSON.stringify({ matches: found >= 2 ? [] : [{ ref: `NEXT${found}` }] }));
      }
      return ok('{"ok":true}');
    });

    const body = summary(
      await shortcutTool.execute({
        action: 'run',
        name: 'collect-pages',
        return: ['pages'],
      } as any),
    );

    expect(body.success).toBe(true);
    expect(body.steps).toHaveLength(2);
    expect(body.steps[1].attempts).toEqual({ count: 2, stoppedBy: 'until' });
    expect(body.results.pages).toHaveLength(2);
  });

  it('5. 묶음 안 step 에도 stale_target_forbidden 과 중첩 금지가 그대로 적용된다', async () => {
    stubStorage();
    const stale = await shortcutTool.execute({
      action: 'save',
      name: 'bad-repeat',
      templates: true,
      steps: [{ repeat: { max: 2 }, steps: [{ tool: 'chrome_find', args: { tabId: 5 } }] }],
    } as any);
    expect(stale.isError).toBe(true);
    expect((stale.content[0] as any).text).toContain('stale_target_forbidden');

    const nested = await shortcutTool.execute({
      action: 'save',
      name: 'bad-repeat2',
      templates: true,
      steps: [{ repeat: { max: 2 }, steps: [{ tool: 'chrome_batch' }] }],
    } as any);
    expect(nested.isError).toBe(true);
    expect((nested.content[0] as any).text).toContain('not allowed inside a chrome_shortcut');
  });

  it('5. 묶음이 아닌 항목은 여전히 tool 을 요구한다', async () => {
    stubStorage();
    const result = await shortcutTool.execute({
      action: 'save',
      name: 'no-tool',
      templates: true,
      steps: [{ as: 'x' }],
    } as any);
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      'each step must have a non-empty "tool" string',
    );
  });
});

/* ------------------------------------------------------------------ *
 * 6. post-capture 실패 뒤 prev.$ok
 * ------------------------------------------------------------------ */

describe('실패 확정 후 캡처 동기화 (6)', () => {
  it('6. capture_too_large 로 실패한 step 뒤의 prev.$ok 는 false 다', async () => {
    const big = JSON.stringify({ blob: 'x'.repeat(65 * 1024) });
    const calls = recordInvoker(({ name }) =>
      name === 'chrome_extract' ? ok(big) : ok('{"a":1}'),
    );

    const body = summary(
      await batchTool.execute({
        templates: true,
        continueOnError: true,
        steps: [
          { tool: 'chrome_extract', as: 'big' },
          { tool: 'chrome_javascript', args: { note: '{{prev.$ok}}' } },
        ],
      } as any),
    );

    expect(body.steps[0].status).toBe('failed');
    expect(body.steps[0].error).toContain('capture_too_large');
    expect(calls[1].args.note).toBe(false);
  });

  it('6. stopIf 평가 오류로 실패한 step 의 named capture 도 $ok 가 false 다', async () => {
    const calls = recordInvoker(() => ok('{"a":1}'));

    const body = summary(
      await batchTool.execute({
        templates: true,
        continueOnError: true,
        steps: [
          {
            tool: 'chrome_extract',
            as: 'hit',
            // 닿지 않는 path 에 eq 를 걸면 condition_unresolved 로 실패한다.
            stopIf: { path: 'hit.missing.deep', op: 'eq', value: 1 },
          },
          { tool: 'chrome_javascript', args: { a: '{{hit.$ok}}', b: '{{prev.$ok}}' } },
        ],
      } as any),
    );

    expect(body.steps[0].status).toBe('failed');
    expect(calls[1].args.a).toBe(false);
    expect(calls[1].args.b).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 7. repeat 의 stopped step text
 * ------------------------------------------------------------------ */

describe('repeat 묶음 resultText (7)', () => {
  it('7. stopIf 로 멈춘 안쪽 step 의 resultText 가 묶음 resultText 가 된다', async () => {
    const hit = JSON.stringify({ matches: [{ ref: 'R1' }] });
    recordInvoker(() => ok(hit));

    const body = summary(
      await batchTool.execute({
        templates: true,
        steps: [
          {
            repeat: { max: 3 },
            steps: [
              {
                tool: 'chrome_find',
                as: 'f',
                stopIf: { path: 'f.matches', op: 'notEmpty' },
              },
            ],
          },
        ],
      } as any),
    );

    expect(body.steps[0].status).toBe('stopped');
    expect(body.steps[0].resultText).toBe(hit);
  });
});

/* ------------------------------------------------------------------ *
 * 재확인 1. 후속 로그가 URL 원문을 찍는다
 * ------------------------------------------------------------------ */

describe('후속 로그 URL 마스킹 (재확인 1)', () => {
  it('재1. redactUrlForLog 는 origin+경로만 남긴다', async () => {
    const { redactUrlForLog } = await import('@/utils/log-redact');
    expect(redactUrlForLog('https://x.example/a/b?token=SECRET#frag')).toBe(
      'https://x.example/a/b',
    );
    expect(redactUrlForLog('https://x.example')).toBe('https://x.example/');
    expect(redactUrlForLog('not a url')).toBe('[redacted:url]');
    expect(redactUrlForLog(undefined)).toBe('[redacted:url]');
  });

  it('재1. navigate·close_tabs·web_fetcher·network_request 후속 로그에 쿼리 비밀이 없다', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const [{ navigateTool, closeTabsTool }, { webFetcherTool }, { networkRequestTool }] =
        await Promise.all([
          import('@/entrypoints/background/tools/browser/common'),
          import('@/entrypoints/background/tools/browser/web-fetcher'),
          import('@/entrypoints/background/tools/browser/network-request'),
        ]);

      const url = 'https://x.example/a?token=sup3rsecret!';
      await navigateTool.execute({ url } as any).catch(() => {});
      await closeTabsTool.execute({ url } as any).catch(() => {});
      await webFetcherTool.execute({ url } as any).catch(() => {});
      await networkRequestTool.execute({ url, method: 'GET' } as any).catch(() => {});

      expect(spy.mock.calls.length).toBeGreaterThan(0);
      const logged = spy.mock.calls.map((call) => JSON.stringify(call)).join('\n');
      expect(logged).not.toContain('sup3rsecret!');
      expect(logged).not.toContain('token=');
    } finally {
      spy.mockRestore();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 재확인 2. flow 안 userscript 는 읽기 전용만
 * ------------------------------------------------------------------ */

describe('flow 안 userscript 읽기 전용 허용목록 (재확인 2)', () => {
  const blocked = ['create', 'update', 'enable', 'disable', 'remove', 'send_command', 'export'];

  it('재2. 저장소를 바꾸거나 상태를 내보내는 action 은 전부 거절한다', async () => {
    for (const action of blocked) {
      const calls = recordInvoker(() => ok('{"a":1}'));
      const body = summary(
        await batchTool.execute({
          templates: true,
          steps: [{ tool: 'chrome_userscript', args: { action } }],
        } as any),
      );
      expect(calls, action).toHaveLength(0);
      expect(body.steps[0].status, action).toBe('failed');
      expect(body.steps[0].error, action).toContain('flow_stateful_tool_forbidden');
    }
  });

  it('재2. 읽기 전용 list·get 만 통과한다', async () => {
    for (const action of ['list', 'get']) {
      const calls = recordInvoker(() => ok('{"a":1}'));
      const body = summary(
        await batchTool.execute({
          templates: true,
          steps: [{ tool: 'chrome_userscript', args: { action } }],
        } as any),
      );
      expect(calls, action).toHaveLength(1);
      expect(body.steps[0].status, action).toBe('completed');
    }
  });

  it('재2. shortcut 안에서도 remove·disable 을 거절한다', async () => {
    for (const action of ['remove', 'disable']) {
      stubStorage();
      const calls = recordInvoker(() => ok('{"a":1}'));
      await shortcutTool.execute({
        action: 'save',
        name: `us-${action}`,
        steps: [
          { tool: 'chrome_extract', as: 'hit' },
          { tool: 'chrome_userscript', args: { action } },
        ],
      } as any);
      const body = summary(
        await shortcutTool.execute({ action: 'run', name: `us-${action}` } as any),
      );
      expect(
        calls.map((c) => c.name),
        action,
      ).toEqual(['chrome_extract']);
      expect(JSON.stringify(body), action).toContain('flow_stateful_tool_forbidden');
    }
  });

  it('재2. v1 batch 는 예전대로 remove 를 통과시킨다', async () => {
    const calls = recordInvoker(() => ok('{"a":1}'));
    const body = summary(
      await batchTool.execute({
        steps: [{ tool: 'chrome_userscript', args: { action: 'remove', args: { id: 'x' } } }],
      } as any),
    );
    expect(calls).toHaveLength(1);
    expect(body.steps[0].status).toBe('completed');
  });
});

/* ------------------------------------------------------------------ *
 * 재확인 3. repeat 안에서 상한에 걸린 묶음의 status
 * ------------------------------------------------------------------ */

describe('상한으로 멈춘 repeat 묶음 (재확인 3)', () => {
  it('재3. total_runs 상한이면 묶음은 stopped·attempts.stoppedBy total_runs 다', async () => {
    const calls = recordInvoker(() => ok('{"a":1}'));

    const body = summary(
      await batchTool.execute({
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
    expect(body.steps[0].status).toBe('stopped');
    expect(body.steps[0].attempts.stoppedBy).toBe('total_runs');
  });

  it('재3. 벽시계 상한이면 묶음은 stopped·attempts.stoppedBy timeout 이다', async () => {
    vi.useFakeTimers();
    try {
      setBatchToolInvoker(async () => {
        vi.advanceTimersByTime(2000);
        return ok('{"a":1}');
      });

      const body = summary(
        await batchTool.execute({
          steps: [
            {
              repeat: { max: 20 },
              as: 'pages',
              steps: Array.from({ length: 3 }, () => ({ tool: 'chrome_screenshot' })),
            },
          ],
        } as any),
      );

      expect(body.stoppedBy).toEqual({ step: 0, reason: 'timeout' });
      expect(body.steps[0].status).toBe('stopped');
      expect(body.steps[0].attempts.stoppedBy).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });
});
