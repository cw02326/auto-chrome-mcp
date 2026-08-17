import { createErrorResponse } from '@/common/tool-handler';
import { ERROR_MESSAGES } from '@/common/constants';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import { isBackgroundModeEnabled } from '@/utils/background-mode';
import { getWorkTabId, DEFAULT_SESSION_ID } from '@/utils/work-tab-manager';
import { applyAutomationGuard } from '@/utils/automation-guard';
import { getSpawnedTabsSince } from '@/utils/spawned-tab-tracker';
import { getDownloadsSince } from '@/utils/download-tracker';
import { looksLikeLoginUrl } from '@/utils/login-detector';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import * as browserTools from './browser';
import { setBatchToolInvoker } from './browser/batch';
import { flowRunTool, listPublishedFlowsTool } from './record-replay';

const tools = { ...browserTools, flowRunTool, listPublishedFlowsTool } as any;
const toolsMap = new Map(Object.values(tools).map((tool: any) => [tool.name, tool]));

const B = TOOL_NAMES.BROWSER;

/**
 * 백그라운드 작업 모드 게이트에서 완전히 제외되는 도구 — 정의상 사용자 대면 동작.
 */
const GATE_EXEMPT_TOOLS = new Set<string>([
  B.SWITCH_TAB,
  B.REQUEST_ELEMENT_SELECTION,
  B.REQUEST_USER_CONSENT,
]);

/**
 * tabId 파라미터를 받는 도구 — 모드 ON + tabId 미지정이면 해당 세션의 MCP 작업 탭을
 * 주입해 사용자의 활성 탭 대신 작업 탭을 대상으로 하게 한다.
 * (chrome_navigate 는 자체 탭 선택 로직 + 작업 탭 기록 담당이라 제외.
 *  chrome_close_tabs 는 tabIds 배열이라 도구 내부에서 작업 탭 fallback 처리.)
 */
const TAB_ID_INJECT_TOOLS = new Set<string>([
  B.SCREENSHOT,
  B.WEB_FETCHER,
  B.CLICK,
  B.FILL,
  B.KEYBOARD,
  B.JAVASCRIPT,
  B.CONSOLE,
  B.FILE_UPLOAD,
  B.READ_PAGE,
  B.COMPUTER,
  B.GIF_RECORDER,
  B.INJECT_SCRIPT,
  B.GET_INTERACTIVE_ELEMENTS,
  B.HANDLE_DIALOG,
  B.NETWORK_REQUEST,
  B.NETWORK_CAPTURE_START,
  B.NETWORK_CAPTURE_STOP,
  B.NETWORK_DEBUGGER_START,
  B.NETWORK_DEBUGGER_STOP,
  B.NETWORK_CAPTURE,
  B.USERSCRIPT,
  B.PERFORMANCE_START_TRACE,
  B.PERFORMANCE_STOP_TRACE,
  B.PERFORMANCE_ANALYZE_INSIGHT,
  B.WAIT_FOR,
  B.SCROLL_COLLECT,
  B.EXTRACT,
  B.FIND,
]);

/**
 * 액션성 도구 — automation guard(도메인 속도 제한 + 반복 폭주 가드) 적용 대상.
 * 읽기 전용 도구(스크린샷·read_page 등)는 제외.
 */
const GUARDED_ACTION_TOOLS = new Set<string>([
  B.NAVIGATE,
  B.CLICK,
  B.FILL,
  B.KEYBOARD,
  B.COMPUTER,
  B.NETWORK_REQUEST,
  B.JAVASCRIPT,
  B.FILE_UPLOAD,
]);

/**
 * Tool call parameter interface
 */
export interface ToolCallParam {
  name: string;
  args: any;
}

/**
 * 세션 id 추출 — stdio 프록시가 모든 호출 인자에 _mcpSessionId 를 실어 보낸다.
 * 인자는 strip 하지 않는다 (navigate/close_tabs 가 세션별 작업 탭 기록에 사용).
 */
function getSessionId(args: any): string {
  return typeof args?._mcpSessionId === 'string' && args._mcpSessionId
    ? args._mcpSessionId
    : DEFAULT_SESSION_ID;
}

/**
 * 백그라운드 작업 모드가 ON 이면 도구 args 를 무간섭 방향으로 보정한다.
 * 호출자가 명시한 값은 절대 덮어쓰지 않는다.
 */
async function applyBackgroundModeGate(name: string, args: any): Promise<any> {
  if (GATE_EXEMPT_TOOLS.has(name)) return args;
  if (!(await isBackgroundModeEnabled())) return args;

  const patched = { ...(args ?? {}) };
  if (patched.background === undefined) {
    patched.background = true;
  }
  if (TAB_ID_INJECT_TOOLS.has(name) && patched.tabId === undefined) {
    const workTabId = await getWorkTabId(getSessionId(patched));
    if (workTabId !== null) {
      patched.tabId = workTabId;
    }
  }
  return patched;
}

/**
 * 탭 단위 직렬화 (scalemaker fork): 같은 탭을 대상으로 한 도구 호출은 순차 실행.
 * 두 세션이 같은 탭에 동시에 입력을 보내 꼬이는 것을 방지한다.
 * tabId 를 특정할 수 없는 호출은 락 없이 실행.
 */
const tabLockTails = new Map<number, Promise<unknown>>();

async function withTabLock<T>(tabId: unknown, fn: () => Promise<T>): Promise<T> {
  if (typeof tabId !== 'number') return fn();
  const prev = tabLockTails.get(tabId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tabLockTails.set(tabId, tail);
  void tail.then(() => {
    if (tabLockTails.get(tabId) === tail) tabLockTails.delete(tabId);
  });
  return run;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * scalemaker fork(F4): 도구 실패 시 대상 탭 화면을 JPEG 로 캡처해 결과에 첨부.
 * chrome.storage.local 'errorScreenshotOnFailure' (기본 ON) 로 끌 수 있다.
 */
async function isErrorScreenshotEnabled(): Promise<boolean> {
  try {
    const r = await chrome.storage.local.get(['errorScreenshotOnFailure']);
    return r['errorScreenshotOnFailure'] !== false;
  } catch {
    return true;
  }
}

async function captureFailureScreenshot(tabId: number): Promise<string | null> {
  try {
    const shot: any = await cdpSessionManager.sendCommand(tabId, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality: 50,
    });
    if (typeof shot?.data !== 'string' || shot.data.length === 0) return null;
    // scalemaker fork(T7): 원인 파악엔 축소본으로 충분 — 이미지 토큰 최소화
    try {
      const { compressImage } = await import('@/utils/image-utils');
      const compressed = await compressImage(`data:image/jpeg;base64,${shot.data}`, {
        scale: 0.6,
        quality: 0.6,
        format: 'image/jpeg',
      });
      return compressed.dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
    } catch {
      return shot.data;
    }
  } catch {
    return null;
  }
}

/**
 * Handle tool execution
 */
export const handleCallTool = async (param: ToolCallParam) => {
  const tool = toolsMap.get(param.name);
  if (!tool) {
    return createErrorResponse(`Tool ${param.name} not found`);
  }

  try {
    const args = await applyBackgroundModeGate(param.name, param.args);

    if (GUARDED_ACTION_TOOLS.has(param.name)) {
      const verdict = await applyAutomationGuard(param.name, args);
      if (verdict && 'blocked' in verdict) {
        return createErrorResponse(verdict.blocked);
      }
      if (verdict && 'delayMs' in verdict && verdict.delayMs > 0) {
        console.log(`[automation-guard] throttling ${param.name} by ${verdict.delayMs}ms`);
        await sleep(verdict.delayMs);
      }
    }

    // chrome_batch 는 내부에서 step 별로 handleCallTool 을 재진입해 각자 탭 락을 잡는다.
    // 배치 자체가 락을 잡으면 step 과 이중 획득 → 교착이므로 배치는 락 없이 실행.
    const lockTabId = param.name === TOOL_NAMES.BROWSER.BATCH ? undefined : args?.tabId;

    // scalemaker fork: 팝업·새 창 인지 — 이 호출이 대상 탭(또는 세션 작업 탭)에서
    // 새 탭/팝업 창을 열었으면 결과에 알림을 첨부한다. 이게 없으면 모델은 팝업이
    // 열린 사실을 모르고 원래 탭에만 명령을 보내다 실패한다.
    const spawnWatchStart = Date.now();
    const openerCandidates: number[] = [];
    if (typeof args?.tabId === 'number') openerCandidates.push(args.tabId);
    const sessionWorkTab = await getWorkTabId(getSessionId(args));
    if (sessionWorkTab !== null && !openerCandidates.includes(sessionWorkTab)) {
      openerCandidates.push(sessionWorkTab);
    }

    // scalemaker fork(F2): 로그인 리다이렉트 감지용 — 실행 전 대상 탭 URL 기록
    const primaryTabId = openerCandidates.length > 0 ? openerCandidates[0] : null;
    let preCallUrl: string | null = null;
    if (primaryTabId !== null) {
      try {
        preCallUrl = (await chrome.tabs.get(primaryTabId)).url ?? null;
      } catch {
        preCallUrl = null;
      }
    }

    const result = await withTabLock(lockTabId, () => tool.execute(args));

    if (openerCandidates.length > 0 && result && Array.isArray(result.content)) {
      const spawned = getSpawnedTabsSince(spawnWatchStart, openerCandidates);
      if (spawned.length > 0) {
        const tabs = [];
        for (const s of spawned) {
          try {
            const live = await chrome.tabs.get(s.tabId);
            tabs.push({
              tabId: s.tabId,
              url: live.url || live.pendingUrl || s.url,
              title: live.title,
              windowId: live.windowId,
              windowType: s.windowType,
              openerTabId: s.openerTabId,
            });
          } catch {
            // 이미 닫힌 탭은 보고하지 않음
          }
        }
        if (tabs.length > 0) {
          result.content.push({
            type: 'text',
            text: JSON.stringify({
              event: 'new_tabs_opened',
              message:
                'This tool call opened new tab(s)/popup window(s). To interact with one, pass its tabId to subsequent tools, or call chrome_set_work_tab to retarget this session’s default work tab.',
              tabs,
            }),
          });
        }
      }
    }

    if (result && Array.isArray(result.content)) {
      // scalemaker fork(F5): 이 호출 중 시작된 다운로드를 결과에 첨부
      const downloads = getDownloadsSince(spawnWatchStart);
      if (downloads.length > 0) {
        result.content.push({
          type: 'text',
          text: JSON.stringify({
            event: 'downloads_started',
            message:
              'Download(s) started during this tool call. Use chrome_handle_download to wait for completion / get the final saved path.',
            downloads: downloads.map((d) => ({
              id: d.id,
              url: d.url,
              filename: d.filename,
              state: d.state,
              totalBytes: d.totalBytes,
            })),
          }),
        });
      }

      // scalemaker fork(F2): 실행 후 대상 탭이 로그인 페이지로 "바뀐" 경우 경고
      if (primaryTabId !== null && !looksLikeLoginUrl(preCallUrl)) {
        try {
          const postUrl = (await chrome.tabs.get(primaryTabId)).url ?? null;
          if (postUrl && postUrl !== preCallUrl && looksLikeLoginUrl(postUrl)) {
            result.content.push({
              type: 'text',
              text: JSON.stringify({
                event: 'login_required_suspected',
                message:
                  'The target tab appears to have been redirected to a login page (session may have expired). Ask the user to log in, or handle authentication before retrying.',
                url: postUrl,
                tabId: primaryTabId,
              }),
            });
          }
        } catch {
          // 탭이 닫혔으면 무시
        }
      }

      // scalemaker fork(F4): 도구 실패 시 현재 화면 자동 첨부 (원인 파악용)
      if (result.isError === true && primaryTabId !== null && (await isErrorScreenshotEnabled())) {
        const jpegBase64 = await captureFailureScreenshot(primaryTabId);
        if (jpegBase64) {
          result.content.push({
            type: 'text',
            text: JSON.stringify({
              event: 'failure_screenshot_attached',
              tabId: primaryTabId,
              note: 'Screenshot of the target tab at failure time (disable via chrome.storage.local errorScreenshotOnFailure=false)',
            }),
          });
          result.content.push({
            type: 'image',
            data: jpegBase64,
            mimeType: 'image/jpeg',
          });
        }
      }
    }

    return result;
  } catch (error) {
    console.error(`Tool execution failed for ${param.name}:`, error);
    return createErrorResponse(
      error instanceof Error ? error.message : ERROR_MESSAGES.TOOL_EXECUTION_FAILED,
    );
  }
};

// scalemaker fork: chrome_batch 가 step 을 같은 게이트(handleCallTool)로 재진입시키도록 배선.
// (barrel 재수출하면 toolsMap 에 함수가 섞이므로 직접 import — batch.ts 주석 참고)
setBatchToolInvoker(handleCallTool);

// scalemaker fork: chrome_shortcut(run) 도 저장된 step 을 같은 게이트로 실행
import { setShortcutToolInvoker } from './browser/shortcut';
setShortcutToolInvoker(handleCallTool);
