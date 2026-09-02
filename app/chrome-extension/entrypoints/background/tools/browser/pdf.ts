import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

/**
 * auto-chrome-mcp fork(B2): chrome_save_pdf — 현재 페이지를 PDF 로 저장한다.
 *
 * CDP `Page.printToPDF` 로 인쇄본을 만들어 다운로드 폴더에 저장한다. 스크린샷과 달리
 * 텍스트가 살아 있고 여러 페이지를 온전히 담으므로 공고문·계약서·리포트 아카이빙에 맞다.
 *
 * base64 는 결과로 돌려주지 않는다 — PDF 한 장이 수십만 토큰이 될 수 있어서,
 * 저장 경로만 반환한다.
 */

interface SavePdfParams {
  tabId?: number;
  windowId?: number;
  filename?: string;
  landscape?: boolean;
  printBackground?: boolean;
  scale?: number;
  paperFormat?: 'a4' | 'letter' | 'legal' | 'a3';
  /** 예: "1-3", "2" — 생략하면 전체 */
  pageRanges?: string;
  /** 머리글/바닥글(URL·페이지 번호) 표시 여부. 기본 false */
  displayHeaderFooter?: boolean;
  /** 인치 단위 여백. 기본 0.4 */
  marginInches?: number;
}

// inch 단위 (CDP printToPDF 규격)
const PAPER_SIZES: Record<string, { width: number; height: number }> = {
  a4: { width: 8.27, height: 11.69 },
  a3: { width: 11.69, height: 16.54 },
  letter: { width: 8.5, height: 11 },
  legal: { width: 8.5, height: 14 },
};

const DOWNLOAD_SUBDIR = 'mcp-pdf';
const MAX_SCALE = 2;
const MIN_SCALE = 0.1;

function isRestrictedUrl(url?: string): boolean {
  if (!url) return true;
  return (
    url.startsWith('chrome://') ||
    url.startsWith('edge://') ||
    url.startsWith('devtools://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('https://chromewebstore.google.com')
  );
}

/** 파일명 정리 — 경로 탈출·금지문자 제거, .pdf 보장 */
function sanitizePdfFilename(raw: string | undefined, fallbackTitle?: string): string {
  let base =
    typeof raw === 'string' && raw.trim()
      ? raw.trim()
      : `${(fallbackTitle || 'page').slice(0, 60)}-${Date.now()}`;
  base = base.replace(/[\\/]+/g, '-'); // 경로 구분자 제거 (디렉터리 탈출 방지)
  // Windows 금지문자 제거 (공백/하이픈은 유지)
  base = base.replace(/[<>:"|?*]/g, '');
  // 제어문자 제거 — 정규식 대신 코드포인트로 거른다 (eslint no-control-regex)
  base = Array.from(base)
    .filter((ch) => ch.charCodeAt(0) >= 32)
    .join('')
    .trim();
  base = base.replace(/^\.+/, '') || 'page';
  if (!/\.pdf$/i.test(base)) base += '.pdf';
  return `${DOWNLOAD_SUBDIR}/${base}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

class SavePdfTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SAVE_PDF;

  async execute(args: SavePdfParams): Promise<ToolResult> {
    const params = args || ({} as SavePdfParams);

    let tab: chrome.tabs.Tab;
    try {
      tab =
        (await this.tryGetTab(params.tabId)) ||
        (await this.getActiveTabOrThrowInWindow(params.windowId));
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error));
    }
    const tabId = tab.id;
    if (typeof tabId !== 'number') return createErrorResponse('Target tab has no id');
    if (isRestrictedUrl(tab.url)) {
      return createErrorResponse(
        'Cannot print browser-internal pages to PDF. Navigate to a regular http(s) page first.',
      );
    }

    const paper = PAPER_SIZES[params.paperFormat || 'a4'] ?? PAPER_SIZES.a4;
    const margin =
      typeof params.marginInches === 'number' && Number.isFinite(params.marginInches)
        ? clamp(params.marginInches, 0, 3)
        : 0.4;
    const scale =
      typeof params.scale === 'number' && Number.isFinite(params.scale)
        ? clamp(params.scale, MIN_SCALE, MAX_SCALE)
        : 1;

    const printParams: Record<string, unknown> = {
      landscape: params.landscape === true,
      printBackground: params.printBackground !== false, // 기본 true — 배경/색이 빠지면 원본과 달라 보인다
      scale,
      paperWidth: paper.width,
      paperHeight: paper.height,
      marginTop: margin,
      marginBottom: margin,
      marginLeft: margin,
      marginRight: margin,
      displayHeaderFooter: params.displayHeaderFooter === true,
      preferCSSPageSize: false,
      transferMode: 'ReturnAsBase64',
    };
    if (typeof params.pageRanges === 'string' && params.pageRanges.trim()) {
      printParams.pageRanges = params.pageRanges.trim();
    }

    try {
      const pdf = await cdpSessionManager.withSession(tabId, 'save-pdf', async () => {
        await cdpSessionManager.sendCommand(tabId, 'Page.enable');
        return await cdpSessionManager.sendCommand<{ data?: string }>(
          tabId,
          'Page.printToPDF',
          printParams,
        );
      });

      const base64 = pdf?.data;
      if (!base64) {
        return createErrorResponse('Page.printToPDF returned no data');
      }

      const filename = sanitizePdfFilename(params.filename, tab.title);
      let downloadId: number;
      try {
        downloadId = await chrome.downloads.download({
          url: `data:application/pdf;base64,${base64}`,
          filename,
          saveAs: false,
        });
      } catch (error) {
        return createErrorResponse(
          `PDF was generated but saving failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // base64 는 반환하지 않는다 (토큰 폭증 방지) — 대략적인 크기만 알려준다.
      const approxBytes = Math.floor((base64.length * 3) / 4);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              tabId,
              url: tab.url,
              title: tab.title,
              downloadId,
              savedAs: filename,
              note: 'Saved under your Downloads folder. Use chrome_handle_download for the absolute path once the download completes.',
              approxBytes,
              settings: {
                paperFormat: params.paperFormat || 'a4',
                landscape: params.landscape === true,
                scale,
                marginInches: margin,
                pageRanges: printParams.pageRanges ?? 'all',
              },
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return createErrorResponse(
        `chrome_save_pdf failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const savePdfTool = new SavePdfTool();
