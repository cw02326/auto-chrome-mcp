/**
 * auto-chrome-mcp fork — chrome_find 응답 크기 회귀 테스트.
 *
 * 계약: match 항목에는 hint 필드가 없고, hint 는 응답 최상위에 1회만 실린다
 * (이전에는 118자짜리 hint 문구가 match 마다 반복돼 maxResults=5 면 5회 중복됐다).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type FindModule = typeof import('@/entrypoints/background/tools/browser/find');

interface RawCandidate {
  ref: string;
  role: string;
  name: string;
  text: string;
  placeholder: string;
  value: string;
  title: string;
  href: string;
  inputType: string;
  cx: number;
  cy: number;
  visible: boolean;
  interactive: boolean;
}

function candidate(overrides: Partial<RawCandidate> = {}): RawCandidate {
  return {
    ref: 'ref-1',
    role: 'button',
    name: '로그인',
    text: '로그인',
    placeholder: '',
    value: '',
    title: '',
    href: '',
    inputType: '',
    cx: 10,
    cy: 20,
    visible: true,
    interactive: true,
    ...overrides,
  };
}

async function loadTool(candidates: RawCandidate[]) {
  vi.resetModules();
  (globalThis as any).chrome.tabs.get = vi.fn(async (id: number) => ({
    id,
    url: 'https://example.com/',
    title: 'Example',
    windowId: 1,
    active: true,
  }));

  const mod: FindModule = await import('@/entrypoints/background/tools/browser/find');
  const proto = Object.getPrototypeOf(mod.findTool) as any;
  proto.injectContentScript = vi.fn(async () => undefined);
  proto.sendMessageToTab = vi.fn(async () => ({ success: true, candidates }));
  return mod.findTool;
}

function payloadOf(result: any) {
  return JSON.parse(result.content[0].text);
}

describe('chrome_find — hint 중복 제거', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('여러 매치가 있어도 hint 는 응답 최상위에 1회만 실린다', async () => {
    const candidates: RawCandidate[] = Array.from({ length: 5 }, (_, i) =>
      candidate({ ref: `ref-${i}`, cx: i, cy: i }),
    );
    const tool = await loadTool(candidates);

    const payload = payloadOf(
      await tool.execute({ query: '로그인 버튼', maxResults: 5, allFrames: false, tabId: 7 }),
    );

    expect(payload.matches.length).toBe(5);
    expect(typeof payload.hint).toBe('string');
    expect(payload.hint.length).toBeGreaterThan(0);
    for (const match of payload.matches) {
      expect(match).not.toHaveProperty('hint');
    }
  });

  it('매치가 없으면 hint 대신 suggestion 만 실린다', async () => {
    const tool = await loadTool([
      candidate({ name: '전혀 다른 요소', text: '', interactive: false }),
    ]);

    const payload = payloadOf(
      await tool.execute({ query: '완전히 무관한 검색어 zzzz', allFrames: false, tabId: 7 }),
    );

    expect(payload.matches).toEqual([]);
    expect(payload.hint).toBeUndefined();
    expect(typeof payload.suggestion).toBe('string');
  });
});
