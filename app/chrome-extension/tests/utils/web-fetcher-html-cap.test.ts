/**
 * auto-chrome-mcp fork — chrome_get_web_content HTML 경로 상한/diff 회귀 테스트.
 *
 * 재현하려는 실패: 텍스트 경로에는 상한(100k) + reader + diff 가 다 있었는데 HTML 경로만
 * 무방비였다. `htmlContent:true` 로 무거운 페이지를 한 번 읽으면 document.documentElement
 * .outerHTML 이 통째로(수 MB) 모델 컨텍스트에 들어갔다.
 *
 * 계약:
 *   - 호출자가 준 maxChars 가 helper 로 전달된다 (전송량 자체를 줄인다)
 *   - 잘렸으면 truncated / fullHtmlChars / returnedChars 로 알린다 — 모델이 좁히거나 늘릴 수 있게
 *   - 같은 탭을 다시 읽으면 HTML 도 텍스트처럼 {unchanged:true} 로 끝난다
 *   - 텍스트 diff 와 HTML diff 는 서로 다른 키를 쓴다 (한쪽이 다른 쪽을 unchanged 로 오판 금지)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Fetcher = typeof import('@/entrypoints/background/tools/browser/web-fetcher');

async function loadTool(sendMock: (tabId: number, message: any) => Promise<any>) {
  vi.resetModules();
  (globalThis as any).chrome.tabs.get = vi.fn(async (id: number) => ({
    id,
    url: 'https://example.com/',
    title: 'Example',
    windowId: 1,
    active: false,
  }));

  const mod: Fetcher = await import('@/entrypoints/background/tools/browser/web-fetcher');
  const proto = Object.getPrototypeOf(mod.webFetcherTool) as any;
  proto.injectContentScript = vi.fn(async () => undefined);
  proto.sendMessageToTab = vi.fn(sendMock);
  return mod.webFetcherTool;
}

function payloadOf(result: any) {
  return JSON.parse(result.content[0].text);
}

describe('chrome_get_web_content — HTML 상한', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('maxChars 를 helper 로 넘긴다', async () => {
    const seen: any[] = [];
    const tool = await loadTool(async (_tabId, message) => {
      seen.push(message);
      return { success: true, htmlContent: '<p>hi</p>', fullHtmlChars: 9, returnedChars: 9 };
    });

    await tool.execute({ tabId: 7, htmlContent: true, maxChars: 5000 });
    expect(seen[0].maxChars).toBe(5000);
  });

  it('helper 가 잘랐다고 하면 그대로 알리고 좁히는 법을 안내한다 (핵심 회귀)', async () => {
    const tool = await loadTool(async () => ({
      success: true,
      htmlContent: '<p>tru',
      fullHtmlChars: 2_400_000,
      returnedChars: 6,
      truncated: true,
    }));

    const payload = payloadOf(await tool.execute({ tabId: 7, htmlContent: true }));
    expect(payload.truncated).toBe(true);
    expect(payload.fullHtmlChars).toBe(2_400_000);
    expect(payload.returnedChars).toBe(6);
    expect(payload.truncatedHint).toContain('chrome_extract');
  });

  it('안 잘렸으면 truncated 를 붙이지 않는다', async () => {
    const tool = await loadTool(async () => ({
      success: true,
      htmlContent: '<p>hi</p>',
      fullHtmlChars: 9,
      returnedChars: 9,
      truncated: false,
    }));
    const payload = payloadOf(await tool.execute({ tabId: 7, htmlContent: true }));
    expect(payload.truncated).toBeUndefined();
    expect(payload.htmlContent).toBe('<p>hi</p>');
  });

  it('같은 HTML 을 다시 읽으면 본문 대신 unchanged 로 끝낸다', async () => {
    const tool = await loadTool(async () => ({
      success: true,
      htmlContent: '<p>same</p>',
      fullHtmlChars: 11,
      returnedChars: 11,
    }));

    const first = payloadOf(await tool.execute({ tabId: 7, htmlContent: true }));
    expect(first.htmlContent).toBe('<p>same</p>');

    const second = payloadOf(await tool.execute({ tabId: 7, htmlContent: true }));
    expect(second.unchanged).toBe(true);
    expect(second.htmlContent).toBeUndefined();
  });

  it('diff:false 면 항상 본문을 다시 보낸다', async () => {
    const tool = await loadTool(async () => ({
      success: true,
      htmlContent: '<p>same</p>',
      fullHtmlChars: 11,
      returnedChars: 11,
    }));

    await tool.execute({ tabId: 7, htmlContent: true });
    const second = payloadOf(await tool.execute({ tabId: 7, htmlContent: true, diff: false }));
    expect(second.unchanged).toBeUndefined();
    expect(second.htmlContent).toBe('<p>same</p>');
  });

  it('텍스트 diff 와 HTML diff 는 서로를 오염시키지 않는다', async () => {
    const body = 'same body';
    const tool = await loadTool(async (_tabId, message) =>
      message.action === 'getHtmlContent'
        ? {
            success: true,
            htmlContent: body,
            fullHtmlChars: body.length,
            returnedChars: body.length,
          }
        : { success: true, textContent: body, mode: 'raw', fullTextChars: body.length },
    );

    const text = payloadOf(await tool.execute({ tabId: 7, raw: true }));
    expect(text.textContent).toBe(body);

    // 본문 문자열이 같아도 HTML 은 처음 읽는 것이므로 unchanged 가 되면 안 된다.
    const html = payloadOf(await tool.execute({ tabId: 7, htmlContent: true }));
    expect(html.unchanged).toBeUndefined();
    expect(html.htmlContent).toBe(body);
  });
});
