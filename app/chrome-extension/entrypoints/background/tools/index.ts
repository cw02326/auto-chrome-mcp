import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { summarizeDownloadUrl } from '@/utils/download-url-summary';
import { ERROR_MESSAGES } from '@/common/constants';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import { touchOwnedTab, describeClosedTab } from '@/utils/work-tab-manager';
// auto-chrome-mcp fork(F2): 게이트 판정은 utils/work-tab-gate.ts 한곳에서만 한다.
// (이 모듈은 도구 레지스트리 전체를 끌어와 테스트에서 import 할 수 없으므로 판정을 분리했다.)
import {
  applyBackgroundModeGate,
  backgroundModeUnsupportedErrorText,
  invalidTabIdErrorText,
  noWorkTabErrorText,
} from '@/utils/work-tab-gate';
import {
  EFFECTIVE_BACKGROUND_MODE_ARG,
  stripEffectiveBackgroundMode,
} from '@/utils/background-mode';
import { LEASE_TOKEN_ARG, withTabLock } from '@/utils/tab-lock';
import { applyAutomationGuard } from '@/utils/automation-guard';
import {
  FlowDeadlineExceededError,
  assertWithinFlowDeadline,
  remainingFlowBudgetMs,
  runWithWatchdog,
} from '@/utils/tool-watchdog';
import { describeMissingTab, rejectIfTargetTabGone } from '@/utils/target-tab-guard';
import { getSpawnedTabsSince } from '@/utils/spawned-tab-tracker';
import { getDownloadsSince } from '@/utils/download-tracker';
import { looksLikeLoginUrl } from '@/utils/login-detector';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import * as browserTools from './browser';
import { setBatchToolInvoker } from './browser/batch';
// auto-chrome-mcp fork: url 로 대상을 고르는 호출의 대상 탭을 잠금 전에 미리 해석한다.
// (barrel 로 재수출하면 함수가 toolsMap 에 섞이므로 직접 import — batch.ts 주석과 같은 이유)
import { resolveUrlTargetTabId } from './browser/url-target';
import { sleep } from '@/utils/adaptive-wait';
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
  // 흐름 하나가 여러 스텝을 도는 도구 — 배치와 같은 예산을 준다.
  [TOOL_NAMES.RECORD_REPLAY.FLOW_RUN]: 10 * 60_000,
};

/**
 * Tool call parameter interface
 */
export interface ToolCallParam {
  name: string;
  args: any;
  /**
   * auto-chrome-mcp fork: chrome_batch·chrome_shortcut 이 흐름 제어 상한(100초)의
   * **절대 마감 시각**(epoch ms)을 step 마다 넘긴다.
   *
   * 상대값(남은 ms)이 아니라 절대 시각인 이유(항목 4): 게이트 조회·automation guard 지연·
   * 탭 락 대기가 도구 실행 앞에 있어서, 상대값은 그 대기 동안 낡는다. 절대 시각이면
   * 파이프라인 어느 지점에서 확인해도 같은 마감을 본다. 워치독 예산은 줄이기만 한다.
   */
  deadlineAt?: number;
  /**
   * auto-chrome-mcp fork(2026-09-05 데일리 자동화 설계 2절): **실행 컨텍스트 모드**.
   *
   * 예약 실행처럼 전역 토글과 무관하게 항상 무간섭이어야 하는 실행에서만 `true` 다.
   * 스키마에 없는 내부 전용 값이며, 이 필드로만 들어온다 - 도구 인자에 적혀 온 같은
   * 이름의 키는 아래에서 지운다(호출자가 무간섭 판정을 조작하지 못하게 한다).
   *
   * 여기서 받은 값은 게이트에 들어가기 전에 `args._effectiveBackgroundMode` 로 실어
   * 보낸다. 게이트뿐 아니라 url 대상 해석(url-target) · navigate 재사용 판정 ·
   * 활성화 가드 · chrome_close_tabs 까지 같은 모드를 봐야 판정이 갈리지 않기 때문이다.
   */
  effectiveBackgroundMode?: true;
}

// 탭 단위 직렬화는 utils/tab-lock.ts 로 분리했다 (navigate 의 재사용 판정도 같은 busy 상태를 본다).

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
    // 흐름 제어 마감은 파이프라인 전 구간에서 본다 — 게이트 조회 전이 첫 지점이다.
    assertWithinFlowDeadline(param.name, param.deadlineAt, 'before the work-tab gate');

    // auto-chrome-mcp fork(설계 2절): 실행 컨텍스트 모드는 ToolCallParam 으로만 들어온다.
    // 인자에 적혀 온 같은 이름의 키는 먼저 지우고, 러너가 준 값이 있을 때만 다시 싣는다.
    const contextArgs =
      param.args !== null && typeof param.args === 'object' && !Array.isArray(param.args)
        ? { ...param.args }
        : param.args;
    stripEffectiveBackgroundMode(contextArgs);
    if (
      param.effectiveBackgroundMode === true &&
      contextArgs !== null &&
      typeof contextArgs === 'object'
    ) {
      (contextArgs as Record<string, unknown>)[EFFECTIVE_BACKGROUND_MODE_ARG] = true;
    }

    const gate = await applyBackgroundModeGate(param.name, contextArgs);
    const args = gate.args;
    gatedArgs = args;

    // 탭 id 가 될 수 없는 값(null·문자열·0·음수)을 tabId 로 받은 호출은 여기서 끝낸다.
    // 예전에는 "tabId 를 명시했다" 로 보고 통과시켰고, 도구 구현은 그 값을 못 쓰니
    // 사용자의 활성 탭으로 fallback 했다 — 게이트를 우회하는 가장 쉬운 길이었다.
    if (gate.invalidTabId) {
      return createErrorResponse(invalidTabIdErrorText(param.name, param.args?.tabId));
    }

    // auto-chrome-mcp fork(F2): 백그라운드 작업 모드에서 tabId 도, 이 세션·레인의 작업 탭도
    // 없으면 여기서 끝낸다. 예전에는 그대로 통과시켜, 도구 구현의 활성 탭 fallback 때문에
    // 사용자가 보고 있는 탭이 읽히고 조작됐다.
    if (gate.noWorkTab) {
      return createErrorResponse(noWorkTabErrorText(param.name));
    }

    // auto-chrome-mcp fork(항목 3): 대상 탭을 스스로 고르는 도구(record_replay_flow_run)는
    // 작업 탭을 주입해도 소비하지 않는다 — 모드 ON 에서는 실행 자체를 막는다.
    if (gate.unsupportedInBackgroundMode) {
      return createErrorResponse(backgroundModeUnsupportedErrorText(param.name));
    }

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

    // 게이트 조회와 속도 제한 지연을 지나오는 동안 마감이 끝났을 수 있다.
    assertWithinFlowDeadline(param.name, param.deadlineAt, 'after the automation guard delay');

    // auto-chrome-mcp fork(2026-09-04 Codex 최종 검토, 남은 항목):
    // 잠금·busy·touch 추적은 원래 args.tabId 하나만 봤다. 그런데 url 이 곧 대상 지정인
    // 호출(URL_SELECTS_TARGET_TOOLS)에는 게이트가 일부러 tabId 를 주입하지 않는다 —
    // 주입하면 도구가 tabId 분기로 빠져 url 이 통째로 무시되기 때문이다. 그래서 이
    // 호출들만 잠금 없이 실행됐고, url 이 기존 작업 탭과 같으면 tabId 를 명시한
    // click·navigate 와 fetch·inject·capture 가 같은 탭에서 동시에 돌았다.
    //
    // 그래서 도구가 쓰는 것과 **같은 조회 규칙**으로 대상 탭 id 만 미리 확인해, 추적·잠금
    // 에만 쓴다. args 는 손대지 않는다 — 주입하면 위의 회귀가 되살아나고, 백그라운드 작업
    // 모드 OFF 에서 "인자를 보정하지 않는다" 는 게이트 계약도 깨진다.
    // 조회가 빈손이면(도구가 새 탭을 만들 예정) 아직 아무도 모르는 탭이라 잠글 대상이 없다.
    const urlTargetTabId = await resolveUrlTargetTabId(param.name, args);
    /** 이 호출이 실제로 건드릴 탭 — 잠금·busy·touch·팝업 감지의 기준. */
    const trackedTabId = args?.tabId ?? urlTargetTabId;

    // chrome_batch 는 내부에서 step 별로 handleCallTool 을 재진입해 각자 탭 락을 잡는다.
    // 배치 자체가 락을 잡으면 step 과 이중 획득 → 교착이므로 배치는 락 없이 실행.
    // record_replay_flow_run 도 같다: 흐름의 각 노드가 작업 탭 id 를 실어 handleCallTool 을
    // 다시 부르므로(engine/tab-context.ts 의 runToolArgs), 바깥 호출이 그 탭 락을 쥐고 있으면
    // 첫 노드에서 바로 교착한다. 스텝 단위 락은 재진입 호출이 각자 잡는다.
    const REENTRANT_TOOLS = new Set<string>([
      TOOL_NAMES.BROWSER.BATCH,
      TOOL_NAMES.RECORD_REPLAY.FLOW_RUN,
    ]);
    const lockTabId = REENTRANT_TOOLS.has(param.name) ? undefined : trackedTabId;

    // auto-chrome-mcp fork(2026-09-05 Codex 재확인 항목 1): 흐름 실행이 쥔 탭 리스의 토큰.
    //
    // 노드가 부르는 도구 호출에는 `_leaseToken` 이 실려 온다. 그 토큰을 잠금에 넘겨야
    // "이 탭을 이미 쥔 run 이 다시 들어온 것" 과 "다른 세션이 같은 탭을 원하는 것" 이
    // 구분된다. 이게 없으면 run 이 자기 리스에 막혀 첫 노드에서 교착하므로, 예전에는
    // 리스 차단 모드를 아예 끄고 살았다.
    //
    // 토큰은 **도구에 넘기지 않는다.** 내부 식별자일 뿐이고, 도구 인자로 흘러가면 스키마에
    // 없는 키가 구현부와 로그에 그대로 노출된다.
    const leaseToken =
      args !== null && typeof args === 'object' && typeof args[LEASE_TOKEN_ARG] === 'string'
        ? (args[LEASE_TOKEN_ARG] as string)
        : undefined;
    if (leaseToken !== undefined) delete args[LEASE_TOKEN_ARG];

    // auto-chrome-mcp fork: 팝업·새 창 인지 — 이 호출이 대상 탭(또는 세션 작업 탭)에서
    // 새 탭/팝업 창을 열었으면 결과에 알림을 첨부한다. 이게 없으면 모델은 팝업이
    // 열린 사실을 모르고 원래 탭에만 명령을 보내다 실패한다.
    const spawnWatchStart = Date.now();
    const openerCandidates: number[] = [];
    // url 로 해석한 대상 탭도 포함한다 — 예전에는 후보가 세션 작업 탭뿐이어서, url 호출의
    // 팝업 감지·실패 스크린샷·로그인 리다이렉트 경고가 엉뚱한 탭을 봤다.
    if (typeof trackedTabId === 'number') openerCandidates.push(trackedTabId);
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
    touchOwnedTab(trackedTabId);

    const result = (await withTabLock(
      lockTabId,
      () => {
        // 락 대기가 가장 긴 구간이다 — 락을 잡은 직후 다시 확인하고, 워치독에는 그 시점의
        // 남은 시간을 넘긴다(예전에는 step 시작 시점의 낡은 값이 들어갔다).
        assertWithinFlowDeadline(param.name, param.deadlineAt, 'after acquiring the tab lock');
        return runWithWatchdog<ToolResult>(
          param.name,
          args,
          () => tool.execute(args),
          (message) => createErrorResponse(message),
          WATCHDOG_OVERRIDES,
          remainingFlowBudgetMs(param.deadlineAt),
        );
      },
      { token: leaseToken },
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
              url: summarizeDownloadUrl(d.url),
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
    // 흐름 제어 마감 초과는 러너가 stoppedBy:"timeout" 으로 보고해야 하므로 그대로 올린다.
    if (error instanceof FlowDeadlineExceededError) throw error;
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

// auto-chrome-mcp fork(2026-09-05 데일리 자동화 설계 2절): 예약 실행도 같은 파이프라인을
// 지난다. MCP 세션이 없을 뿐 게이트·워치독·탭 잠금은 그대로다.
import { setScheduleToolInvoker } from '../schedule-runner';
setScheduleToolInvoker(handleCallTool);
