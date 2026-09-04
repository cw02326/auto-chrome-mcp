/**
 * auto-chrome-mcp fork: 저장 도구가 산출물을 어디에 쓰는지 못 박는 회귀.
 *
 * 2026-09-02 사용자 지시 — 확장이 만드는 파일은 다운로드 폴더 **루트** 가 아니라
 * `mcp-screenshots/YYYY-MM-DD/` 안에만 쌓여야 한다(그 전까지 250여 개가 루트에 쌓였다).
 *
 * 세 겹으로 지킨다.
 *  1. 헬퍼가 실제로 그 경로와 `conflictAction: 'uniquify'` 로 chrome.downloads 를 부르는지.
 *  2. 배경 도구 소스 어디에도 `chrome.downloads.download` 직접 호출이 남아 있지 않은지
 *     (새 도구가 옛 방식으로 다시 루트에 저장하는 것을 막는 그물).
 *  3. 실제 도구 하나(chrome_save_pdf)를 끝까지 돌려 배선이 살아 있는지.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { saveArtifactToDownloads } from '../../utils/artifact-path';

const DATE_PATH_RE = /^mcp-screenshots\/\d{4}-\d{2}-\d{2}\//;

interface DownloadCall {
  url: string;
  filename: string;
  saveAs?: boolean;
  conflictAction?: string;
}

function installDownloads(overrides?: {
  download?: (options: DownloadCall) => Promise<number>;
  search?: () => Promise<Array<{ filename?: string }>>;
}): { calls: DownloadCall[] } {
  const calls: DownloadCall[] = [];
  const chromeAny = globalThis.chrome as unknown as Record<string, unknown>;
  chromeAny.downloads = {
    download: vi.fn(async (options: DownloadCall) => {
      calls.push(options);
      return overrides?.download ? overrides.download(options) : 4242;
    }),
    search: vi.fn(async () =>
      overrides?.search
        ? overrides.search()
        : [
            {
              filename: `C:\\Users\\tester\\Downloads\\${calls[calls.length - 1]?.filename ?? ''}`,
            },
          ],
    ),
    onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  };
  return { calls };
}

describe('saveArtifactToDownloads', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('날짜 폴더 경로와 uniquify 로 다운로드를 건다', async () => {
    const { calls } = installDownloads();
    const result = await saveArtifactToDownloads({
      url: 'data:image/png;base64,AAAA',
      kind: 'screenshot',
      name: 'login',
      ext: 'png',
      resolvePathDelayMs: 0,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].filename).toMatch(DATE_PATH_RE);
    expect(calls[0].filename).toMatch(/\/screenshot_login_\d{6}\.png$/);
    expect(calls[0].saveAs).toBe(false);
    expect(calls[0].conflictAction).toBe('uniquify');
    expect(result.downloadId).toBe(4242);
    expect(result.filename).toBe(calls[0].filename);
    // 지연 조회를 끄면 절대 경로는 붙지 않는다
    expect(result.fullPath).toBeUndefined();
  });

  it('절대 경로를 조회해 fullPath 로 돌려준다', async () => {
    installDownloads();
    const result = await saveArtifactToDownloads({
      url: 'data:image/gif;base64,AAAA',
      kind: 'gif',
      ext: 'gif',
      resolvePathDelayMs: 1,
    });
    expect(result.fullPath).toContain('Downloads');
    expect(result.fullPath).toContain('mcp-screenshots');
  });

  it('경로 조회가 실패해도 저장 결과는 유지된다', async () => {
    installDownloads({
      search: async () => {
        throw new Error('search blew up');
      },
    });
    const result = await saveArtifactToDownloads({
      url: 'data:application/pdf;base64,AAAA',
      kind: 'pdf',
      ext: 'pdf',
      resolvePathDelayMs: 1,
    });
    expect(result.downloadId).toBe(4242);
    expect(result.fullPath).toBeUndefined();
  });

  it('다운로드 자체가 실패하면 그대로 던진다 (호출부가 판단한다)', async () => {
    installDownloads({
      download: async () => {
        throw new Error('user cancelled');
      },
    });
    await expect(
      saveArtifactToDownloads({ url: 'data:,x', kind: 'trace', ext: 'json' }),
    ).rejects.toThrow('user cancelled');
  });
});

describe('배경 도구 소스 그물', () => {
  // jsdom 환경에서는 import.meta.url 이 파일 URL 이 아니다 — vitest 의 작업 디렉터리를 쓴다.
  const toolsDir = join(process.cwd(), 'entrypoints', 'background', 'tools');

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (full.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('테스트가 실제 소스 디렉터리를 본다', () => {
    expect(existsSync(join(toolsDir, 'browser', 'screenshot.ts'))).toBe(true);
  });

  it('도구는 chrome.downloads.download 를 직접 부르지 않는다', () => {
    const offenders = walk(toolsDir).filter((file) =>
      readFileSync(file, 'utf8').includes('chrome.downloads.download('),
    );
    expect(
      offenders,
      `산출물은 utils/artifact-path.ts 의 saveArtifactToDownloads 로만 저장한다: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('산출물을 만드는 도구는 모두 헬퍼를 쓴다', () => {
    const savers = [
      'browser/screenshot.ts',
      'browser/gif-recorder.ts',
      'browser/pdf.ts',
      'browser/performance.ts',
    ];
    for (const rel of savers) {
      const source = readFileSync(join(toolsDir, rel), 'utf8');
      expect(source, `${rel} 이 헬퍼를 import 하지 않는다`).toContain('saveArtifactToDownloads');
    }
  });
});

describe('chrome_save_pdf 배선', () => {
  it('PDF 도 날짜 폴더 아래로 저장된다', async () => {
    vi.resetModules();
    vi.doMock('@/utils/cdp-session-manager', () => ({
      cdpSessionManager: {
        withSession: async (_tabId: number, _key: string, fn: () => Promise<unknown>) => fn(),
        sendCommand: async (_tabId: number, method: string) =>
          method === 'Page.printToPDF' ? { data: 'JVBERi0xLjQK' } : {},
        detach: async () => undefined,
      },
    }));

    const { calls } = installDownloads();
    const chromeAny = globalThis.chrome as unknown as {
      tabs: { get: (id: number) => Promise<unknown> };
    };
    const originalGet = chromeAny.tabs.get;
    chromeAny.tabs.get = vi.fn(async (id: number) => ({
      id,
      windowId: 1,
      url: 'https://notice.example/page',
      title: '공고문 2026',
      active: true,
    })) as never;

    try {
      const { savePdfTool } = await import('@/entrypoints/background/tools/browser/pdf');
      const result = await savePdfTool.execute({ tabId: 7 });

      expect(result.isError).toBe(false);
      expect(calls).toHaveLength(1);
      expect(calls[0].filename).toMatch(DATE_PATH_RE);
      expect(calls[0].filename).toMatch(/\/pdf_.*_\d{6}\.pdf$/);

      const payload = JSON.parse((result.content[0] as { text: string }).text);
      expect(payload.savedAs).toBe(calls[0].filename);
    } finally {
      chromeAny.tabs.get = originalGet;
      vi.doUnmock('@/utils/cdp-session-manager');
    }
  });
});
