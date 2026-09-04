import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import {
  canvasToDataURL,
  createImageBitmapFromUrl,
  cropAndResizeImage,
  stitchImages,
  prepareImageForModelInput,
  MODEL_INPUT_MAX_LONG_EDGE,
  type ModelInputImage,
} from '../../../../utils/image-utils';
import { screenshotContextManager } from '@/utils/screenshot-context';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { activateTab } from '@/utils/activation-guard';
import { isMcpWindow } from '@/utils/mcp-window-manager';
import { waitForFramePaint, waitForHelperReady } from '@/utils/adaptive-wait';
import { redactedArgsForLog } from '@/utils/log-redact';
import { saveArtifactToDownloads } from '@/utils/artifact-path';

/**
 * auto-chrome-mcp fork v1.9.0: 전용 작업 창(기본 배치 minimized) 안의 비활성 탭은 캡처할 수
 * 없다. 대상이 그 창의 탭이면 캡처 직전에 활성화한다 — 사용자 창은 건드리지 않는다.
 */
async function ensureActiveInWorkWindow(tab: chrome.tabs.Tab): Promise<void> {
  try {
    if (tab.active === true || typeof tab.id !== 'number') return;
    if (!(await isMcpWindow(tab.windowId))) return;
    await activateTab(tab.id, { reason: 'screenshot:work-window' });
    // 활성화 직후 첫 프레임이 나올 때까지 기다린다.
    // auto-chrome-mcp fork: rAF 두 번은 "한 번 그렸다"만 보장하므로 예전 고정 대기(150ms)를
    // 하한으로 남기고, rAF 를 확인할 수 없는 탭(최소화된 창 등)에서는 300ms 까지만 기다린다.
    await waitForFramePaint(tab.id, {
      minWaitMs: WORK_WINDOW_ACTIVATION_PAINT_MIN_MS,
      maxWaitMs: WORK_WINDOW_ACTIVATION_PAINT_MAX_MS,
    });
  } catch {
    // 실패해도 아래 캡처 경로가 자기 에러를 낸다.
  }
}

/** auto-chrome-mcp fork: 작업 창 탭 활성화 후 최소 대기(예전 고정 대기와 같은 값) */
const WORK_WINDOW_ACTIVATION_PAINT_MIN_MS = 150;
/** auto-chrome-mcp fork: 페인트를 확인할 수 없을 때의 상한 */
const WORK_WINDOW_ACTIVATION_PAINT_MAX_MS = 300;

// Screenshot-specific constants
const SCREENSHOT_CONSTANTS = {
  SCROLL_DELAY_MS: 350, // Time to wait after scroll for rendering and lazy loading
  CAPTURE_STITCH_DELAY_MS: 50, // Small delay between captures in a scroll sequence
  MAX_CAPTURE_PARTS: 50, // Maximum number of parts to capture (for infinite scroll pages)
  MAX_CAPTURE_HEIGHT_PX: 50000, // Maximum height in pixels to capture
  PIXEL_TOLERANCE: 1,
  SCRIPT_INIT_DELAY: 100, // Delay for script initialization
} as {
  readonly SCROLL_DELAY_MS: number;
  CAPTURE_STITCH_DELAY_MS: number; // This one is mutable
  readonly MAX_CAPTURE_PARTS: number;
  readonly MAX_CAPTURE_HEIGHT_PX: number;
  readonly PIXEL_TOLERANCE: number;
  readonly SCRIPT_INIT_DELAY: number;
};

// Adjust CAPTURE_STITCH_DELAY_MS to respect Chrome's capture rate if available in runtime
// Some TS typings don't expose MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND; use a safe cast with a sane fallback.
const __MAX_CAP_RATE: number | undefined = (chrome.tabs as any)
  ?.MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND;
if (typeof __MAX_CAP_RATE === 'number' && __MAX_CAP_RATE > 0) {
  // Minimum interval between consecutive captureVisibleTab calls (ms)
  const minIntervalMs = Math.ceil(1000 / __MAX_CAP_RATE);
  // Our capture loop already waits SCROLL_DELAY_MS between scroll and capture; add any extra delay needed
  const requiredExtraDelay = Math.max(0, minIntervalMs - SCREENSHOT_CONSTANTS.SCROLL_DELAY_MS);
  SCREENSHOT_CONSTANTS.CAPTURE_STITCH_DELAY_MS = Math.max(
    requiredExtraDelay,
    SCREENSHOT_CONSTANTS.CAPTURE_STITCH_DELAY_MS,
  );
}

/**
 * auto-chrome-mcp fork: 백그라운드(비활성) 탭 캡처 지원.
 *
 * chrome.tabs.captureVisibleTab 은 "윈도우에서 지금 보이는 탭"만 캡처하므로, MCP 도구가
 * 백그라운드 작업 탭을 대상으로 동작할 때 조용히 엉뚱한 탭을 찍는다.
 * 따라서 모든 캡처 경로에서 CDP(Page.captureScreenshot)를 1순위로 쓰고,
 * captureVisibleTab 은 CDP 가 불가능할 때(예: DevTools 가 이미 붙어 있어 attach 실패)의 폴백으로만 쓴다.
 */
const CDP_CAPTURE_TIMEOUT_MS = 20000; // 비활성 탭 합성 지연 시 무한 대기 방지
const MAX_CDP_FULLPAGE_HEIGHT_PX = 16000; // Chrome 텍스처 한계(~16384) 안쪽 안전값

// auto-chrome-mcp fork: captureVisibleTab 호출 최소 간격 (폴백 경로에만 적용)
const MIN_CAPTURE_VISIBLE_TAB_INTERVAL_MS =
  typeof __MAX_CAP_RATE === 'number' && __MAX_CAP_RATE > 0 ? Math.ceil(1000 / __MAX_CAP_RATE) : 0;
let lastCaptureVisibleTabAtMs = 0;

/**
 * auto-chrome-mcp fork: captureVisibleTab 폴백 전용 래퍼.
 * - 대상 탭이 자기 윈도우의 활성 탭이 아니면 다른 탭이 찍히므로, 캡처하지 않고 명확한 에러를 던진다.
 * - Chrome 의 captureVisibleTab 호출 빈도 제한을 이 지점에서만 적용한다.
 */
async function captureVisibleTabFallback(tabId: number, windowId?: number): Promise<string> {
  let isActive = false;
  let targetWindowId = windowId;
  try {
    const fresh = await chrome.tabs.get(tabId);
    isActive = fresh.active === true;
    if (typeof fresh.windowId === 'number') targetWindowId = fresh.windowId;
  } catch {
    isActive = false;
  }

  if (!isActive) {
    throw new Error(
      'Cannot capture background tab: CDP unavailable (another debugger attached?) and tab is not visible. ' +
        'Close DevTools/other debugger for this tab or activate the tab, then retry.',
    );
  }

  if (MIN_CAPTURE_VISIBLE_TAB_INTERVAL_MS > 0) {
    const waitMs = MIN_CAPTURE_VISIBLE_TAB_INTERVAL_MS - (Date.now() - lastCaptureVisibleTabAtMs);
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastCaptureVisibleTabAtMs = Date.now();

  const dataUrl =
    typeof targetWindowId === 'number'
      ? await chrome.tabs.captureVisibleTab(targetWindowId, { format: 'png' })
      : await chrome.tabs.captureVisibleTab({ format: 'png' });
  if (!dataUrl) throw new Error('captureVisibleTab returned empty image data');
  return dataUrl;
}

/**
 * auto-chrome-mcp fork: 사용자 지정 filename 에서 확장자만 골라낸다.
 * 경로·금지문자 처리는 utils/artifact-path.ts 가 맡는다(항상 날짜 폴더 안으로 들어간다).
 */
function screenshotExtension(userFilename?: string): 'jpg' | 'png' {
  return typeof userFilename === 'string' && /\.jpe?g\s*$/i.test(userFilename) ? 'jpg' : 'png';
}

/**
 * auto-chrome-mcp fork: 캡처된 이미지를 chrome.downloads 로 저장한다.
 * saveToDownloads 요청 시 모든 캡처 경로(CDP viewport/fullPage/element, captureVisibleTab 폴백) 이후
 * 공통으로 호출되며, 실패해도 스크린샷 자체는 성공으로 유지한다(호출부에서 saveError 만 첨부).
 * 저장 위치는 `mcp-screenshots/YYYY-MM-DD/` 하나로 통일된다.
 */
async function saveScreenshotToDownloads(
  dataUrl: string,
  filename?: string,
): Promise<
  | { saved: true; downloadId: number; savedFilename: string; fullPath?: string }
  | { saved: false; saveError: string }
> {
  try {
    const saved = await saveArtifactToDownloads({
      url: dataUrl,
      kind: 'screenshot',
      name: filename,
      ext: screenshotExtension(filename),
    });
    return {
      saved: true,
      downloadId: saved.downloadId,
      savedFilename: saved.filename,
      ...(saved.fullPath ? { fullPath: saved.fullPath } : {}),
    };
  } catch (error) {
    return {
      saved: false,
      saveError: String(error instanceof Error ? error.message : error),
    };
  }
}

interface NormalizedLayoutMetrics {
  viewportWidthCss: number;
  viewportHeightCss: number;
  pageXCss: number;
  pageYCss: number;
  contentWidthCss: number;
  contentHeightCss: number;
}

/**
 * auto-chrome-mcp fork: Page.getLayoutMetrics 결과를 CSS 픽셀 기준으로 정규화한다.
 * css* 필드(cssLayoutViewport/cssContentSize)를 우선 사용하고, 없으면 구 필드로 폴백.
 * CDP clip 좌표계도 CSS 픽셀이므로 여기서 나온 값을 그대로 clip 에 쓸 수 있다.
 */
function normalizeLayoutMetrics(metrics: any): NormalizedLayoutMetrics {
  const num = (value: any, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

  const viewport =
    metrics?.cssLayoutViewport ||
    metrics?.layoutViewport ||
    metrics?.cssVisualViewport ||
    metrics?.visualViewport ||
    {};
  const content = metrics?.cssContentSize || metrics?.contentSize || {};

  const viewportWidthCss = Math.round(num(viewport.clientWidth, 800));
  const viewportHeightCss = Math.round(num(viewport.clientHeight, 600));

  return {
    viewportWidthCss,
    viewportHeightCss,
    pageXCss: num(viewport.pageX, 0),
    pageYCss: num(viewport.pageY, 0),
    contentWidthCss: Math.round(num(content.width, viewportWidthCss)),
    contentHeightCss: Math.round(num(content.height, viewportHeightCss)),
  };
}

/** auto-chrome-mcp fork: CDP 호출이 비활성 탭에서 매달리는 경우를 대비한 타임아웃 래퍼 */
async function withCdpTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  // 타임아웃이 이겨도 원본 promise 의 rejection 이 unhandled 로 남지 않게 한다
  void promise.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${CDP_CAPTURE_TIMEOUT_MS}ms`)),
          CDP_CAPTURE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * auto-chrome-mcp fork: 스티칭 경로와 동일한 규칙으로 options.width/height 를 적용한다.
 * (한쪽만 지정하면 비율 유지, 둘 다 지정하면 그대로 늘림. 출력은 물리 픽셀 = CSS * dpr)
 */
async function resizeToRequestedSize(
  dataUrl: string,
  dpr: number,
  targetWidthCss?: number,
  targetHeightCss?: number,
): Promise<string> {
  if (!targetWidthCss && !targetHeightCss) return dataUrl;

  const img = await createImageBitmapFromUrl(dataUrl);
  let targetWidthPx: number;
  let targetHeightPx: number;
  if (targetWidthCss && targetHeightCss) {
    targetWidthPx = targetWidthCss * dpr;
    targetHeightPx = targetHeightCss * dpr;
  } else if (targetWidthCss) {
    targetWidthPx = targetWidthCss * dpr;
    targetHeightPx = targetWidthPx * (img.height / img.width);
  } else {
    targetHeightPx = (targetHeightCss as number) * dpr;
    targetWidthPx = targetHeightPx * (img.width / img.height);
  }

  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(targetWidthPx)),
    Math.max(1, Math.round(targetHeightPx)),
  );
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Unable to get canvas context');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvasToDataURL(canvas);
}

interface ScreenshotToolParams {
  name: string;
  selector?: string;
  tabId?: number;
  background?: boolean;
  windowId?: number;
  width?: number;
  height?: number;
  storeBase64?: boolean;
  fullPage?: boolean;
  savePng?: boolean;
  maxHeight?: number; // Maximum height to capture in pixels (for infinite scroll pages)
  // auto-chrome-mcp fork: 캡처 결과를 chrome.downloads 로 자동 저장하기 위한 옵션
  saveToDownloads?: boolean;
  filename?: string;
  /**
   * auto-chrome-mcp fork: true 면 모델 입력용 축소(긴 변 1568px)를 건너뛴다.
   * 이미지는 여전히 MCP image 블록으로 반환된다. 화질이 꼭 필요할 때의 탈출구.
   */
  fullResolution?: boolean;
  /**
   * auto-chrome-mcp fork(internal): true 면 텍스트 JSON 에도 base64Data 를 넣는다.
   * MCP 스키마에는 노출하지 않는다 — 모델에게 base64 를 텍스트로 주는 것이 바로
   * 이 수정이 없애려는 토큰 낭비이기 때문. 확장 내부에서 이미지 바이트가 필요한
   * 호출자(record-replay 워크플로 등)만 사용한다.
   */
  includeBase64InText?: boolean;
}

/** Page details returned by screenshot-helper content script */
interface ScreenshotPageDetails {
  totalWidth: number;
  totalHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  currentScrollX: number;
  currentScrollY: number;
}

const PAGE_DETAILS_REQUIRED_FIELDS: Array<keyof ScreenshotPageDetails> = [
  'totalWidth',
  'totalHeight',
  'viewportWidth',
  'viewportHeight',
  'devicePixelRatio',
  'currentScrollX',
  'currentScrollY',
];

/**
 * Validates and asserts that the response from content script contains valid page details
 */
function assertValidPageDetails(details: unknown): ScreenshotPageDetails {
  if (!details || typeof details !== 'object') {
    throw new Error(
      'Screenshot helper did not respond. The content script may not be injected or cannot run on this page.',
    );
  }

  const candidate = details as Partial<ScreenshotPageDetails>;
  const invalidFields = PAGE_DETAILS_REQUIRED_FIELDS.filter(
    (field) => typeof candidate[field] !== 'number' || !Number.isFinite(candidate[field]),
  );

  if (invalidFields.length > 0) {
    throw new Error(
      `Screenshot helper returned invalid page details (missing/invalid: ${invalidFields.join(', ')}).`,
    );
  }

  return candidate as ScreenshotPageDetails;
}

/**
 * Tool for capturing screenshots of web pages
 */
class ScreenshotTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SCREENSHOT;

  /**
   * auto-chrome-mcp fork: 주입한 screenshot-helper 가 메시지를 받을 준비가 됐는지 확인한다.
   * pong 이 오면 즉시, 응답이 없으면 예전 고정 대기와 같은 상한까지만 기다린다.
   */
  private async waitForScreenshotHelperReady(tabId: number): Promise<void> {
    await waitForHelperReady({
      timeoutMs: SCREENSHOT_CONSTANTS.SCRIPT_INIT_DELAY,
      ping: () =>
        this.sendMessageToTab(
          tabId,
          { action: `${this.name}_ping` },
          undefined,
          SCREENSHOT_CONSTANTS.SCRIPT_INIT_DELAY,
        ),
    });
  }

  /**
   * Execute screenshot operation
   */
  async execute(args: ScreenshotToolParams): Promise<ToolResult> {
    const {
      name = 'screenshot',
      selector,
      storeBase64 = false,
      fullPage = false,
      savePng = true,
      saveToDownloads = false,
      filename,
      fullResolution = false,
      includeBase64InText = false,
    } = args;

    console.log(`Starting screenshot with options:`, redactedArgsForLog(args));

    // Resolve target tab (explicit or active)
    const explicit = await this.tryGetTab(args.tabId);
    const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));

    // auto-chrome-mcp fork v1.9.0: 최소화된 전용 작업 창에서는 **활성 탭만** 캡처된다
    // (2026-09-02 실측: 비활성 탭은 CDP 캡처도 captureVisibleTab 도 실패한다).
    // 병렬 lane 처럼 작업 창에 탭이 여러 개일 때를 위해, 대상이 전용 작업 창의 탭이면
    // 캡처 전에 그 창 안에서 활성화한다. 창은 사용자 화면 밖이라 눈에 보이는 변화가 없다.
    await ensureActiveInWorkWindow(tab);

    // Check URL restrictions
    if (
      tab.url?.startsWith('chrome://') ||
      tab.url?.startsWith('edge://') ||
      tab.url?.startsWith('https://chrome.google.com/webstore') ||
      tab.url?.startsWith('https://microsoftedge.microsoft.com/')
    ) {
      return createErrorResponse(
        'Cannot capture special browser pages or web store pages due to security restrictions.',
      );
    }

    let finalImageDataUrl: string | undefined;
    let finalImageWidthCss: number | undefined;
    let finalImageHeightCss: number | undefined;
    // auto-chrome-mcp fork: results 에서 base64 필드를 제거했다. 이미지 바이트는 절대
    // 텍스트/JSON 응답에 섞지 않고 MCP image 블록으로만 내보낸다(토큰 폭발 방지).
    const results: any = { fileSaved: false };
    let originalScroll: { x: number; y: number } | null = null;
    let didPreparePage = false;
    let pageDetails: ScreenshotPageDetails | undefined;

    try {
      // auto-chrome-mcp fork: CDP 는 대상 탭이 보이지 않아도 정확히 그 탭을 캡처하므로,
      // background 플래그와 무관하게 항상 1순위 경로로 사용한다.
      // 뷰포트 캡처는 콘텐츠 스크립트 없이 CDP 만으로 처리 가능.
      const canUseCdpCapture = !fullPage && !selector;

      // === Path 1: CDP viewport capture (no content script needed) ===
      if (canUseCdpCapture) {
        try {
          const tabId = tab.id!;
          await cdpSessionManager.withSession(tabId, 'screenshot', async () => {
            const metrics = normalizeLayoutMetrics(
              await cdpSessionManager.sendCommand(tabId, 'Page.getLayoutMetrics', {}),
            );
            const base64Data = await this._cdpCaptureScreenshot(tabId, {
              format: 'png',
              fromSurface: true,
              captureBeyondViewport: false,
            });
            finalImageDataUrl = `data:image/png;base64,${base64Data}`;
            // 좌표 스케일링 규약 유지: 컨텍스트에는 CSS 픽셀 기준 뷰포트 크기를 기록한다
            finalImageWidthCss = metrics.viewportWidthCss;
            finalImageHeightCss = metrics.viewportHeightCss;
          });
        } catch (e) {
          console.warn('CDP viewport capture failed, falling back to helper path:', e);
        }
      }

      // === Path 2: Helper-assisted capture (requires content script) ===
      if (!finalImageDataUrl) {
        // Always inject helper when we need pageDetails
        await this.injectContentScript(tab.id!, ['inject-scripts/screenshot-helper.js']);
        // auto-chrome-mcp fork: 예전에는 헬퍼가 준비됐는지와 무관하게 100ms 를 쉬었다.
        // 이제는 ping 에 pong 이 오면 즉시 진행하고, 응답이 없을 때만 상한까지 기다린다.
        await this.waitForScreenshotHelperReady(tab.id!);

        // Prepare page (hide scrollbars, handle fixed elements)
        const prepareResp = await this.sendMessageToTab(tab.id!, {
          action: TOOL_MESSAGE_TYPES.SCREENSHOT_PREPARE_PAGE_FOR_CAPTURE,
          options: { fullPage },
        });
        if (!prepareResp || prepareResp.success !== true) {
          throw new Error(
            'Screenshot helper did not acknowledge page preparation. The content script may not be injected or cannot run on this page.',
          );
        }
        didPreparePage = true;

        // Get page details with validation
        const rawPageDetails = await this.sendMessageToTab(tab.id!, {
          action: TOOL_MESSAGE_TYPES.SCREENSHOT_GET_PAGE_DETAILS,
        });
        pageDetails = assertValidPageDetails(rawPageDetails);
        originalScroll = { x: pageDetails.currentScrollX, y: pageDetails.currentScrollY };

        if (fullPage) {
          this.logInfo('Capturing full page...');
          finalImageDataUrl = await this._captureFullPage(tab, args, pageDetails);
          // Compute final CSS size
          if (args.width && args.height) {
            finalImageWidthCss = args.width;
            finalImageHeightCss = args.height;
          } else if (args.width && !args.height) {
            finalImageWidthCss = args.width;
            const ratio = pageDetails.totalHeight / pageDetails.totalWidth;
            finalImageHeightCss = Math.round(args.width * ratio);
          } else if (!args.width && args.height) {
            finalImageHeightCss = args.height;
            const ratio = pageDetails.totalWidth / pageDetails.totalHeight;
            finalImageWidthCss = Math.round(args.height * ratio);
          } else {
            finalImageWidthCss = pageDetails.totalWidth;
            finalImageHeightCss = pageDetails.totalHeight;
          }
        } else if (selector) {
          this.logInfo(`Capturing element: ${selector}`);
          finalImageDataUrl = await this._captureElement(tab, args, pageDetails.devicePixelRatio);
          if (args.width && args.height) {
            finalImageWidthCss = args.width;
            finalImageHeightCss = args.height;
          } else {
            finalImageWidthCss = pageDetails.viewportWidth;
            finalImageHeightCss = pageDetails.viewportHeight;
          }
        } else {
          // Visible area only — CDP 가 실패했을 때만 도달하는 폴백 경로
          this.logInfo('Capturing visible area (captureVisibleTab fallback)...');
          finalImageDataUrl = await captureVisibleTabFallback(tab.id!, tab.windowId);
          finalImageWidthCss = pageDetails.viewportWidth;
          finalImageHeightCss = pageDetails.viewportHeight;
        }
      }

      if (!finalImageDataUrl) {
        throw new Error('Failed to capture image data');
      }

      // auto-chrome-mcp fork: 캡처 성공 후(모든 경로 공통) saveToDownloads 요청 시 다운로드로 저장.
      // 실패해도 스크린샷 자체는 성공 처리하고 saveError 만 응답에 첨부한다.
      let downloadsSaveResult:
        | { saved: true; downloadId: number; savedFilename: string }
        | { saved: false; saveError: string }
        | undefined;
      if (saveToDownloads === true) {
        downloadsSaveResult = await saveScreenshotToDownloads(finalImageDataUrl, filename);
        Object.assign(results, downloadsSaveResult);
      }

      // auto-chrome-mcp fork: 모델에게 돌려줄 이미지를 먼저 만든다.
      // 좌표 컨텍스트(screenshotWidth/Height)에는 "모델이 실제로 보는 이미지의 픽셀 크기"를
      // 기록해야 chrome_computer 의 좌표 역변환이 맞으므로, setContext 보다 앞에서 계산한다.
      // 주의: savePng / saveToDownloads 는 이 축소본이 아니라 원본(finalImageDataUrl)을 저장한다.
      let modelImage: ModelInputImage | undefined;
      if (storeBase64 === true) {
        modelImage = await prepareImageForModelInput(finalImageDataUrl, {
          // fullResolution:true 면 축소를 건너뛴다(사실상 무제한 긴 변)
          maxLongEdge:
            fullResolution === true ? Number.MAX_SAFE_INTEGER : MODEL_INPUT_MAX_LONG_EDGE,
          quality: 0.8,
          format: 'image/jpeg',
        });
      }

      // 2. Process output
      // Update screenshot context for coordinate scaling by tools like chrome_computer
      try {
        if (typeof finalImageWidthCss === 'number' && typeof finalImageHeightCss === 'number') {
          let hostname = '';
          try {
            hostname = tab.url ? new URL(tab.url).hostname : '';
          } catch {
            // ignore
          }
          // Use pageDetails if available, otherwise fall back to final image dimensions
          // auto-chrome-mcp fork: viewportWidth/Height 는 예전과 완전히 동일하게 "원본 CSS 뷰포트" 크기를 기록한다.
          const viewportWidth = pageDetails?.viewportWidth ?? finalImageWidthCss;
          const viewportHeight = pageDetails?.viewportHeight ?? finalImageHeightCss;
          // auto-chrome-mcp fork: 좌표 기준 프레임은 모델에게 넘어간 이미지의 실제 픽셀 크기.
          // (이미지를 반환하지 않는 경로에서는 기존과 동일하게 CSS 기준 크기를 유지)
          const screenshotWidth = modelImage ? modelImage.width : finalImageWidthCss;
          const screenshotHeight = modelImage ? modelImage.height : finalImageHeightCss;
          screenshotContextManager.setContext(tab.id!, {
            screenshotWidth,
            screenshotHeight,
            viewportWidth,
            viewportHeight,
            devicePixelRatio: pageDetails?.devicePixelRatio,
            hostname,
          });
        }
      } catch (e) {
        console.warn('Failed to set screenshot context:', e);
      }
      if (storeBase64 === true && modelImage) {
        // auto-chrome-mcp fork: 이미지를 텍스트(JSON) 안에 base64 로 넣어 돌려주면 MCP 클라이언트가
        // 이미지 1장에 텍스트 토큰 10만~30만개를 지불한다. 정식 MCP image 블록으로 분리하고
        // Claude 입력 최적 크기(긴 변 1568px)로 축소해 ~1-2k 토큰 수준으로 낮춘다.
        const base64Data = modelImage.dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
        const isDownscaled = modelImage.scale < 1;

        // imageScale = 반환 이미지 1px 이 CSS 픽셀 몇 개에 해당하는지의 역수.
        // 즉 imageScale = (반환 이미지 폭 px) / (이미지가 덮는 CSS 폭 px).
        // 뷰포트 캡처면 분모가 곧 CSS 뷰포트 폭이므로 "이미지 vs 뷰포트" 배율이 된다.
        // 수동 환산: cssX = imageX / imageScale
        const imageScale =
          typeof finalImageWidthCss === 'number' && finalImageWidthCss > 0
            ? Number((modelImage.width / finalImageWidthCss).toFixed(4))
            : 1;

        return {
          content: [
            {
              type: 'text',
              // auto-chrome-mcp fork: 메타데이터만 텍스트로. base64 는 여기 절대 넣지 않는다.
              // saveToDownloads 결과(있다면)는 예전과 동일하게 포함한다.
              text: JSON.stringify({
                success: true,
                message: `Screenshot [${name}] captured successfully`,
                tabId: tab.id,
                url: tab.url,
                name,
                mimeType: modelImage.mimeType,
                width: modelImage.width,
                height: modelImage.height,
                imageScale,
                cssWidth: finalImageWidthCss,
                cssHeight: finalImageHeightCss,
                downscaled: isDownscaled,
                ...(isDownscaled
                  ? { downscaledFrom: `${modelImage.originalWidth}x${modelImage.originalHeight}` }
                  : {}),
                note:
                  'The image is attached as an MCP image content block (no base64 in this text). ' +
                  'Coordinates you read off the image are in image pixels; chrome_computer converts them ' +
                  'automatically via the screenshot context. To convert manually: cssX = imageX / imageScale.',
                ...(includeBase64InText === true ? { base64Data } : {}),
                ...downloadsSaveResult,
              }),
            },
            {
              type: 'image',
              data: base64Data,
              mimeType: modelImage.mimeType,
            },
          ],
          isError: false,
        };
      }

      if (savePng === true) {
        // Save PNG file to downloads
        this.logInfo('Saving PNG...');
        try {
          // 저장 경로는 utils/artifact-path.ts 가 만든다 — mcp-screenshots/YYYY-MM-DD/ 아래.
          const saved = await saveArtifactToDownloads({
            url: finalImageDataUrl,
            kind: 'screenshot',
            name,
            ext: 'png',
          });

          results.downloadId = saved.downloadId;
          results.filename = saved.filename;
          results.fileSaved = true;
          if (saved.fullPath) results.fullPath = saved.fullPath;
        } catch (error) {
          console.error('Error saving PNG file:', error);
          results.saveError = String(error instanceof Error ? error.message : error);
        }
      }
    } catch (error) {
      console.error('Error during screenshot execution:', error);
      return createErrorResponse(
        `Screenshot error: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
      );
    } finally {
      // 3. Reset page only if we prepared it
      if (didPreparePage) {
        try {
          // Only include scroll position if we successfully captured it
          const resetMessage: Record<string, unknown> = {
            action: TOOL_MESSAGE_TYPES.SCREENSHOT_RESET_PAGE_AFTER_CAPTURE,
          };
          if (originalScroll) {
            resetMessage.scrollX = originalScroll.x;
            resetMessage.scrollY = originalScroll.y;
          }
          await this.sendMessageToTab(tab.id!, resetMessage);
        } catch (err) {
          console.warn('Failed to reset page, tab might have closed:', err);
        }
      }
    }

    this.logInfo('Screenshot completed!');

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: `Screenshot [${name}] captured successfully`,
            tabId: tab.id,
            url: tab.url,
            name: name,
            ...results,
          }),
        },
      ],
      isError: false,
    };
  }

  /**
   * Log information
   */
  private logInfo(message: string) {
    console.log(`[Screenshot Tool] ${message}`);
  }

  /**
   * auto-chrome-mcp fork: CDP Page.captureScreenshot 실행 (타임아웃 + 빈 데이터 검증).
   * 호출자는 cdpSessionManager.withSession 안에서 호출해야 한다.
   */
  private async _cdpCaptureScreenshot(
    tabId: number,
    params: Record<string, unknown>,
  ): Promise<string> {
    const shot: any = await withCdpTimeout(
      cdpSessionManager.sendCommand(tabId, 'Page.captureScreenshot', params),
      'CDP Page.captureScreenshot',
    );
    const base64Data = typeof shot?.data === 'string' ? shot.data : '';
    if (!base64Data) {
      throw new Error('CDP Page.captureScreenshot returned empty data');
    }
    return base64Data;
  }

  /**
   * Capture specific element
   *
   * auto-chrome-mcp fork: CDP clip 캡처를 우선 사용한다. 대상 탭이 보이지 않아도 정확하고,
   * captureVisibleTab + crop 과 달리 뷰포트보다 큰 요소도 온전히 담을 수 있다.
   */
  async _captureElement(
    tab: chrome.tabs.Tab,
    options: ScreenshotToolParams,
    pageDpr: number,
  ): Promise<string> {
    const tabId = tab.id!;
    const elementDetails = await this.sendMessageToTab(tabId, {
      action: TOOL_MESSAGE_TYPES.SCREENSHOT_GET_ELEMENT_DETAILS,
      selector: options.selector,
    });

    if (!elementDetails || !elementDetails.rect) {
      throw new Error(`Failed to resolve element rect for selector "${options.selector}"`);
    }

    const dpr = elementDetails.devicePixelRatio || pageDpr || 1;
    const rect = elementDetails.rect as { x: number; y: number; width: number; height: number };
    if (!(rect.width > 0) || !(rect.height > 0)) {
      throw new Error(`Element "${options.selector}" has zero size and cannot be captured`);
    }

    // Element rect is viewport-relative, in CSS pixels
    // captureVisibleTab captures in physical pixels
    const cropRectPx = {
      x: rect.x * dpr,
      y: rect.y * dpr,
      width: rect.width * dpr,
      height: rect.height * dpr,
    };

    // Small delay to ensure element is fully rendered after scrollIntoView
    // auto-chrome-mcp fork: 여기는 "헬퍼 준비"가 아니라 **스크롤 후 실제 페인트**를 기다리는
    // 자리라 조건화하지 않았다. 헬퍼에 새 신호(rAF 응답) 메시지를 추가해야 하는데, 잘못 앞당기면
    // 스크롤 중간 프레임이 찍혀 스크린샷 품질이 조용히 나빠진다. 상한이 100ms 로 짧아 이득도 작다.
    await new Promise((resolve) => setTimeout(resolve, SCREENSHOT_CONSTANTS.SCRIPT_INIT_DELAY));

    // === Primary: CDP clip capture ===
    try {
      return await this._captureElementViaCdp(tabId, rect, options, dpr);
    } catch (e) {
      console.warn('CDP element capture failed, falling back to captureVisibleTab crop:', e);
    }

    // === Fallback: captureVisibleTab + crop (대상 탭이 보이지 않으면 여기서 에러) ===
    const visibleCaptureDataUrl = await captureVisibleTabFallback(tabId, tab.windowId);

    const croppedCanvas = await cropAndResizeImage(
      visibleCaptureDataUrl,
      cropRectPx,
      dpr,
      options.width, // Target output width in CSS pixels
      options.height, // Target output height in CSS pixels
    );
    return canvasToDataURL(croppedCanvas);
  }

  /**
   * auto-chrome-mcp fork: 요소 영역을 CDP clip 으로 캡처.
   * clip 은 문서(페이지) 좌표계의 CSS 픽셀이므로 뷰포트 기준 rect 에 스크롤 오프셋을 더한다.
   * 결과 이미지는 기존 crop 경로와 동일하게 물리 픽셀(= CSS * dpr) 해상도를 갖는다.
   */
  private async _captureElementViaCdp(
    tabId: number,
    rect: { x: number; y: number; width: number; height: number },
    options: ScreenshotToolParams,
    dpr: number,
  ): Promise<string> {
    return await cdpSessionManager.withSession(tabId, 'screenshot', async () => {
      const metrics = normalizeLayoutMetrics(
        await cdpSessionManager.sendCommand(tabId, 'Page.getLayoutMetrics', {}),
      );

      // 요소가 뷰포트를 벗어나면 뷰포트 밖 영역까지 캡처
      const beyondViewport =
        rect.x < 0 ||
        rect.y < 0 ||
        rect.x + rect.width > metrics.viewportWidthCss + SCREENSHOT_CONSTANTS.PIXEL_TOLERANCE ||
        rect.y + rect.height > metrics.viewportHeightCss + SCREENSHOT_CONSTANTS.PIXEL_TOLERANCE;

      const base64Data = await this._cdpCaptureScreenshot(tabId, {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: beyondViewport,
        clip: {
          x: metrics.pageXCss + rect.x,
          y: metrics.pageYCss + rect.y,
          width: rect.width,
          height: rect.height,
          scale: 1,
        },
      });

      const dataUrl = `data:image/png;base64,${base64Data}`;
      if (!options.width && !options.height) return dataUrl;

      // 출력 크기 지정 시 폴백(crop) 경로와 동일한 리사이즈 규칙 적용
      const resized = await cropAndResizeImage(
        dataUrl,
        { x: 0, y: 0, width: rect.width * dpr, height: rect.height * dpr },
        dpr,
        options.width,
        options.height,
      );
      return canvasToDataURL(resized);
    });
  }

  /**
   * auto-chrome-mcp fork: 전체 페이지를 CDP 한 번의 captureBeyondViewport 로 캡처.
   * 스크롤-스티칭이 필요 없고, 대상 탭이 보이지 않아도 동작한다.
   * 캡처가 불가능/위험하다고 판단되면 null 을 돌려 스티칭 경로로 넘긴다.
   */
  private async _captureFullPageViaCdp(
    tabId: number,
    options: ScreenshotToolParams,
    initialPageDetails: any,
  ): Promise<string | null> {
    const dpr = initialPageDetails.devicePixelRatio || 1;

    return await cdpSessionManager.withSession(tabId, 'screenshot', async () => {
      const metrics = normalizeLayoutMetrics(
        await cdpSessionManager.sendCommand(tabId, 'Page.getLayoutMetrics', {}),
      );

      const contentWidthCss = Math.max(metrics.contentWidthCss, metrics.viewportWidthCss);
      const contentHeightCss = Math.max(metrics.contentHeightCss, metrics.viewportHeightCss);

      // Sanity check: 콘텐츠 스크립트가 알려준 문서 크기와 크게 어긋나면(단위 불일치 등) 스티칭으로
      const helperHeightCss = Number(initialPageDetails.totalHeight) || 0;
      if (helperHeightCss > 0 && contentHeightCss > helperHeightCss * 2) {
        this.logInfo(
          `CDP contentSize (${contentHeightCss}) disagrees with page details (${helperHeightCss}); using scroll-stitch path.`,
        );
        return null;
      }

      // Apply maximum height limit for infinite scroll pages (스티칭 경로와 동일 규칙)
      const maxHeightPx = options.maxHeight || SCREENSHOT_CONSTANTS.MAX_CAPTURE_HEIGHT_PX;
      const limitedHeightCss = Math.min(contentHeightCss, Math.floor(maxHeightPx / dpr));

      // 캡처 결과가 Chrome 텍스처 한계를 넘을 정도로 크면 스티칭 경로로
      if (limitedHeightCss * dpr > MAX_CDP_FULLPAGE_HEIGHT_PX) {
        this.logInfo(
          `Full page height ${Math.round(limitedHeightCss * dpr)}px exceeds CDP safe limit (${MAX_CDP_FULLPAGE_HEIGHT_PX}px); using scroll-stitch path.`,
        );
        return null;
      }
      if (!(contentWidthCss > 0) || !(limitedHeightCss > 0)) return null;

      const base64Data = await this._cdpCaptureScreenshot(tabId, {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: 0,
          width: contentWidthCss,
          height: limitedHeightCss,
          scale: 1,
        },
      });

      return await resizeToRequestedSize(
        `data:image/png;base64,${base64Data}`,
        dpr,
        options.width,
        options.height,
      );
    });
  }

  /**
   * Capture full page
   */
  async _captureFullPage(
    tab: chrome.tabs.Tab,
    options: ScreenshotToolParams,
    initialPageDetails: any,
  ): Promise<string> {
    const tabId = tab.id!;
    const dpr = initialPageDetails.devicePixelRatio;

    // === Primary: 단일 CDP 캡처 (백그라운드 탭 지원, 스크롤 이동 없음) ===
    try {
      const cdpDataUrl = await this._captureFullPageViaCdp(tabId, options, initialPageDetails);
      if (cdpDataUrl) return cdpDataUrl;
    } catch (e) {
      console.warn('CDP full page capture failed, falling back to scroll-stitch:', e);
    }

    // === Fallback: captureVisibleTab 스크롤-스티칭 (대상 탭이 보여야 함) ===
    const totalWidthCss = options.width || initialPageDetails.totalWidth; // Use option width if provided
    const totalHeightCss = initialPageDetails.totalHeight; // Full page always uses actual height

    // Apply maximum height limit for infinite scroll pages
    const maxHeightPx = options.maxHeight || SCREENSHOT_CONSTANTS.MAX_CAPTURE_HEIGHT_PX;
    const limitedHeightCss = Math.min(totalHeightCss, maxHeightPx / dpr);

    const totalWidthPx = totalWidthCss * dpr;
    const totalHeightPx = limitedHeightCss * dpr;

    // Viewport dimensions (CSS pixels) - logged for debugging
    this.logInfo(
      `Viewport size: ${initialPageDetails.viewportWidth}x${initialPageDetails.viewportHeight} CSS pixels`,
    );
    this.logInfo(
      `Page dimensions: ${totalWidthCss}x${totalHeightCss} CSS pixels (limited to ${limitedHeightCss} height)`,
    );

    const viewportHeightCss = initialPageDetails.viewportHeight;

    const capturedParts = [];
    let currentScrollYCss = 0;
    let capturedHeightPx = 0;
    let partIndex = 0;

    while (capturedHeightPx < totalHeightPx && partIndex < SCREENSHOT_CONSTANTS.MAX_CAPTURE_PARTS) {
      this.logInfo(
        `Capturing part ${partIndex + 1}... (${Math.round((capturedHeightPx / totalHeightPx) * 100)}%)`,
      );

      if (currentScrollYCss > 0) {
        // Don't scroll for the first part if already at top
        const scrollResp = await this.sendMessageToTab(tabId, {
          action: TOOL_MESSAGE_TYPES.SCREENSHOT_SCROLL_PAGE,
          x: 0,
          y: currentScrollYCss,
          scrollDelay: SCREENSHOT_CONSTANTS.SCROLL_DELAY_MS,
        });
        // Update currentScrollYCss based on actual scroll achieved
        currentScrollYCss = scrollResp.newScrollY;
      }

      // Ensure rendering after scroll
      await new Promise((resolve) =>
        setTimeout(resolve, SCREENSHOT_CONSTANTS.CAPTURE_STITCH_DELAY_MS),
      );

      const dataUrl = await captureVisibleTabFallback(tabId, tab.windowId);

      const yOffsetPx = currentScrollYCss * dpr;
      capturedParts.push({ dataUrl, y: yOffsetPx });

      const imgForHeight = await createImageBitmapFromUrl(dataUrl); // To get actual captured height
      const lastPartEffectiveHeightPx = Math.min(imgForHeight.height, totalHeightPx - yOffsetPx);

      capturedHeightPx = yOffsetPx + lastPartEffectiveHeightPx;

      if (capturedHeightPx >= totalHeightPx - SCREENSHOT_CONSTANTS.PIXEL_TOLERANCE) break;

      currentScrollYCss += viewportHeightCss;
      // Prevent overscrolling past the document height for the next scroll command
      if (
        currentScrollYCss > totalHeightCss - viewportHeightCss &&
        currentScrollYCss < totalHeightCss
      ) {
        currentScrollYCss = totalHeightCss - viewportHeightCss;
      }
      partIndex++;
    }

    // Check if we hit any limits
    if (partIndex >= SCREENSHOT_CONSTANTS.MAX_CAPTURE_PARTS) {
      this.logInfo(
        `Reached maximum number of capture parts (${SCREENSHOT_CONSTANTS.MAX_CAPTURE_PARTS}). This may be an infinite scroll page.`,
      );
    }
    if (totalHeightCss > limitedHeightCss) {
      this.logInfo(
        `Page height (${totalHeightCss}px) exceeds maximum capture height (${maxHeightPx / dpr}px). Capturing limited portion.`,
      );
    }

    this.logInfo('Stitching image...');
    const finalCanvas = await stitchImages(capturedParts, totalWidthPx, totalHeightPx);

    // If user specified width but not height (or vice versa for full page), resize maintaining aspect ratio
    let outputCanvas = finalCanvas;
    if (options.width && !options.height) {
      const targetWidthPx = options.width * dpr;
      const aspectRatio = finalCanvas.height / finalCanvas.width;
      const targetHeightPx = targetWidthPx * aspectRatio;
      outputCanvas = new OffscreenCanvas(targetWidthPx, targetHeightPx);
      const ctx = outputCanvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(finalCanvas, 0, 0, targetWidthPx, targetHeightPx);
      }
    } else if (options.height && !options.width) {
      const targetHeightPx = options.height * dpr;
      const aspectRatio = finalCanvas.width / finalCanvas.height;
      const targetWidthPx = targetHeightPx * aspectRatio;
      outputCanvas = new OffscreenCanvas(targetWidthPx, targetHeightPx);
      const ctx = outputCanvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(finalCanvas, 0, 0, targetWidthPx, targetHeightPx);
      }
    } else if (options.width && options.height) {
      // Both specified, direct resize
      const targetWidthPx = options.width * dpr;
      const targetHeightPx = options.height * dpr;
      outputCanvas = new OffscreenCanvas(targetWidthPx, targetHeightPx);
      const ctx = outputCanvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(finalCanvas, 0, 0, targetWidthPx, targetHeightPx);
      }
    }

    return canvasToDataURL(outputCanvas);
  }
}

export const screenshotTool = new ScreenshotTool();
