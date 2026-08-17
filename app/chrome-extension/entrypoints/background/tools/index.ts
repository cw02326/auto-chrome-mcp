import { createErrorResponse } from '@/common/tool-handler';
import { ERROR_MESSAGES } from '@/common/constants';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import { isBackgroundModeEnabled } from '@/utils/background-mode';
import { getWorkTabId, DEFAULT_SESSION_ID } from '@/utils/work-tab-manager';
import { applyAutomationGuard } from '@/utils/automation-guard';
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
    return await withTabLock(lockTabId, () => tool.execute(args));
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
