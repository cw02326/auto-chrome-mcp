import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { ERROR_MESSAGES } from '@/common/constants';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import { isBackgroundModeEnabled } from '@/utils/background-mode';
import {
  getWorkTabId,
  sessionKeyOf,
  touchOwnedTab,
  describeClosedTab,
} from '@/utils/work-tab-manager';
import { withTabLock } from '@/utils/tab-lock';
import { applyAutomationGuard } from '@/utils/automation-guard';
import { runWithWatchdog } from '@/utils/tool-watchdog';
import { describeMissingTab, rejectIfTargetTabGone } from '@/utils/target-tab-guard';
import { getSpawnedTabsSince } from '@/utils/spawned-tab-tracker';
import { getDownloadsSince } from '@/utils/download-tracker';
import { looksLikeLoginUrl } from '@/utils/login-detector';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import * as browserTools from './browser';
import { setBatchToolInvoker } from './browser/batch';
import { flowRunTool, listPublishedFlowsTool } from './record-replay';

const tools = { ...browserTools, flowRunTool, listPublishedFlowsTool } as any;
const toolsMap = new Map(Object.values(tools).map((tool: any) => [tool.name, tool]));

/**
 * 실제로 등록된 도구 이름 전부.
 *
 * 무간섭 회귀 테스트가 fixture 누락을 잡는 데 쓴다. TOOL_SCHEMAS(=모델에게 광고하는 목록)
 * 와 달리 광고하지 않는 내부 도구까지 포함하므로, 새 도구가 조용히 추가되는 것을 잡는다.
 */
export const REGISTERED_TOOL_NAMES: readonly string[] = Array.from(toolsMap.keys()) as string[];

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
  // auto-chrome-mcp fork(B1~B4)
  B.STORAGE,
  B.SAVE_PDF,
  B.EMULATE,
  B.NETWORK_RULES,
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
 * auto-chrome-mcp fork: 오래 걸리는 게 정상인 도구들 — 사용자 입력 대기 · 장시간 수집.
 * 나머지는 utils/tool-watchdog.ts 의 기본 예산을 쓴다.
 */
const WATCHDOG_OVERRIDES: Record<string, number> = {
  [B.REQUEST_ELEMENT_SELECTION]: 11 * 60_000,
  [B.REQUEST_USER_CONSENT]: 11 * 60_000,
  [B.BATCH]: 10 * 60_000,
  [B.SHORTCUT]: 10 * 60_000,
  [B.SCROLL_COLLECT]: 5 * 60_000,
  [B.GIF_RECORDER]: 5 * 60_000,
  [B.PERFORMANCE_START_TRACE]: 5 * 60_000,
  [B.PERFORMANCE_STOP_TRACE]: 5 * 60_000,
};

/**
 * Tool call parameter interface
 */
export interface ToolCallParam {
  name: string;
  args: any;
}

/**
 * 작업 탭 버킷 키 — stdio 프록시가 실어 보낸 _mcpSessionId 에, 호출자가 준 lane 을 더한다.
 *
 * 한 Claude Code 세션의 서브에이전트들은 stdio 프로세스를 공유해 _mcpSessionId 가 같다.
 * lane 을 주면 그만큼 버킷이 갈라져 병렬 에이전트가 서로의 작업 탭을 덮어쓰지 않는다.
 * 인자는 strip 하지 않는다 (navigate/close_tabs 가 같은 키를 다시 계산한다).
 */
function getSessionId(args: any): string {
  return sessionKeyOf(args);
}

/**
 * 백그라운드 작업 모드가 ON 이면 도구 args 를 무간섭 방향으로 보정한다.
 * 호출자가 명시한 값은 절대 덮어쓰지 않는다.
 */
async function applyBackgroundModeGate(
  name: string,
  args: any,
): Promise<{ args: any; workTabId: number | null }> {
  // auto-chrome-mcp fork: 작업 탭 조회는 호출당 한 번이면 충분하다. 예전엔 게이트와
  // handleCallTool 이 각각 조회해 매 호출마다 chrome.storage.session 쓰기가 두 번 났다.
  // 조회는 게이트를 타지 않는 경로에서도 한다 — handleCallTool 의 팝업 감지가 이 값을
  // opener 후보로 쓰므로, 모드가 꺼져 있다고 빼면 팝업 알림이 조용히 사라진다.
  const workTabId = await getWorkTabId(getSessionId(args));

  if (GATE_EXEMPT_TOOLS.has(name)) return { args, workTabId };
  if (!(await isBackgroundModeEnabled())) return { args, workTabId };

  const patched = { ...(args ?? {}) };
  if (patched.background === undefined) {
    patched.background = true;
  }
  if (TAB_ID_INJECT_TOOLS.has(name) && patched.tabId === undefined && workTabId !== null) {
    patched.tabId = workTabId;
  }
  return { args: patched, workTabId };
}

// 탭 단위 직렬화는 utils/tab-lock.ts 로 분리했다 (navigate 의 재사용 판정도 같은 busy 상태를 본다).

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * auto-chrome-mcp fork(F4): 도구 실패 시 대상 탭 화면을 JPEG 로 캡처해 결과에 첨부.
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

/**
 * auto-chrome-mcp fork: 실패 진단 자체가 매달리면 안 된다.
 *
 * 실패 원인이 "페이지가 멎었다" 인 경우가 많은데, 멎은 렌더러에서는 Page.captureScreenshot
 * 도 영영 안 돌아온다. 워치독이 탭 락은 이미 풀어 줬어도, 진단이 매달리면 이 호출의 응답
 * 자체가 클라이언트로 안 나간다. 진단은 어디까지나 부가정보이므로 짧게 끊는다.
 */
const FAILURE_SCREENSHOT_TIMEOUT_MS = 5_000;

async function captureFailureScreenshot(tabId: number): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const shot: any = await Promise.race([
      cdpSessionManager.sendCommand(tabId, 'Page.captureScreenshot', {
        format: 'jpeg',
        quality: 50,
      }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), FAILURE_SCREENSHOT_TIMEOUT_MS);
      }),
    ]);
    if (typeof shot?.data !== 'string' || shot.data.length === 0) return null;
    // auto-chrome-mcp fork(T7): 원인 파악엔 축소본으로 충분 — 이미지 토큰 최소화
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
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * auto-chrome-mcp fork: 실패한 결과에 진단 정보를 붙인다 (사라진 탭 안내 + 실패 스크린샷).
 * 도구가 에러 결과를 돌려준 경우와 예외를 던진 경우 **둘 다** 같은 도움을 받게 하려고 뽑아냈다.
 */
async function attachFailureDiagnostics(
  result: ToolResult,
  argsTabId: unknown,
  primaryTabId: number | null,
): Promise<void> {
  if (!result || !Array.isArray(result.content)) return;

  // (bare 'Tab not found' 만 보면 모델은 같은 tabId 로 재시도하다 계속 실패한다)
  const missingHint = describeMissingTab(result, argsTabId);
  if (missingHint) {
    result.content.push({ type: 'text', text: JSON.stringify(missingHint) });
  }

  // auto-chrome-mcp fork(F4): 도구 실패 시 현재 화면 자동 첨부 (원인 파악용)
  if (primaryTabId === null || !(await isErrorScreenshotEnabled())) return;
  const jpegBase64 = await captureFailureScreenshot(primaryTabId);
  if (!jpegBase64) return;
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

/**
 * Handle tool execution
 */
export const handleCallTool = async (param: ToolCallParam) => {
  const tool = toolsMap.get(param.name);
  if (!tool) {
    return createErrorResponse(`Tool ${param.name} not found`);
  }

  // auto-chrome-mcp fork: 실패 진단(사라진 탭 안내 · 실패 스크린샷)은 예외로 끝난 호출에도
  // 붙어야 한다. 예전엔 tool 이 throw 하면 catch 가 맨 에러 문자열만 돌려줘, 정작 가장
  // 알고 싶은 실패에서 단서가 제일 적었다.
  let gatedArgs: any = param.args;
  let primaryTabId: number | null = null;

  try {
    const gate = await applyBackgroundModeGate(param.name, param.args);
    const args = gate.args;
    gatedArgs = args;

    // 대상 탭이 이미 없으면 여기서 끝낸다 — 아래 도구들은 없으면 활성 탭으로 흘러간다.
    const goneTab = await rejectIfTargetTabGone(param.name, args);
    if (goneTab) return goneTab;

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

    // auto-chrome-mcp fork: 팝업·새 창 인지 — 이 호출이 대상 탭(또는 세션 작업 탭)에서
    // 새 탭/팝업 창을 열었으면 결과에 알림을 첨부한다. 이게 없으면 모델은 팝업이
    // 열린 사실을 모르고 원래 탭에만 명령을 보내다 실패한다.
    const spawnWatchStart = Date.now();
    const openerCandidates: number[] = [];
    if (typeof args?.tabId === 'number') openerCandidates.push(args.tabId);
    // 게이트가 이미 조회해 둔 작업 탭을 재사용한다 (중복 조회 = storage 쓰기 2회였다).
    const sessionWorkTab = gate.workTabId;
    if (sessionWorkTab !== null && !openerCandidates.includes(sessionWorkTab)) {
      openerCandidates.push(sessionWorkTab);
    }

    // auto-chrome-mcp fork(F2): 로그인 리다이렉트 감지용 — 실행 전 대상 탭 URL 기록
    primaryTabId = openerCandidates.length > 0 ? openerCandidates[0] : null;
    let preCallUrl: string | null = null;
    if (primaryTabId !== null) {
      try {
        preCallUrl = (await chrome.tabs.get(primaryTabId)).url ?? null;
      } catch {
        preCallUrl = null;
      }
    }

    // auto-chrome-mcp fork(P1): 이 탭을 지금 쓰고 있다고 표시 — 정리 로직이 살아 있는
    // 병렬 작업 탭을 유휴로 오인해 닫지 않게 한다.
    touchOwnedTab(args?.tabId);

    const result = (await withTabLock(lockTabId, () =>
      runWithWatchdog<ToolResult>(
        param.name,
        args,
        () => tool.execute(args),
        (message) => createErrorResponse(message),
        WATCHDOG_OVERRIDES,
      ),
    )) as ToolResult;

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
      // auto-chrome-mcp fork(F5): 이 호출 중 시작된 다운로드를 결과에 첨부
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

      // auto-chrome-mcp fork(F2): 실행 후 대상 탭이 로그인 페이지로 "바뀐" 경우 경고
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

      if (result.isError === true) {
        await attachFailureDiagnostics(result, args?.tabId, primaryTabId);
      }
    }

    return result;
  } catch (error) {
    console.error(`Tool execution failed for ${param.name}:`, error);
    const failure = createErrorResponse(
      error instanceof Error ? error.message : ERROR_MESSAGES.TOOL_EXECUTION_FAILED,
    );
    await attachFailureDiagnostics(failure, gatedArgs?.tabId, primaryTabId);
    return failure;
  }
};

// auto-chrome-mcp fork: chrome_batch 가 step 을 같은 게이트(handleCallTool)로 재진입시키도록 배선.
// (barrel 재수출하면 toolsMap 에 함수가 섞이므로 직접 import — batch.ts 주석 참고)
setBatchToolInvoker(handleCallTool);

// auto-chrome-mcp fork: chrome_shortcut(run) 도 저장된 step 을 같은 게이트로 실행
import { setShortcutToolInvoker } from './browser/shortcut';
setShortcutToolInvoker(handleCallTool);
