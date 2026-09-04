/**
 * 백그라운드 작업 모드 게이트 (auto-chrome-mcp fork).
 *
 * 도구 호출 인자를 "무간섭" 방향으로 보정하는 판정을 한곳에 모았다. 예전에는 이 판정이
 * entrypoints/background/tools/index.ts 안에 있었는데, 그 모듈은 도구 레지스트리 전체를
 * 끌어오므로(record-replay → sharp 네이티브 모듈) 테스트에서 import 할 수 없었다.
 * 판정만 떼어 놓으면 게이트 계약을 단위 테스트로 고정할 수 있다.
 *
 * 규칙:
 *   - 예외 도구(GATE_EXEMPT_TOOLS)는 손대지 않는다 — 정의상 사용자 대면 동작.
 *   - background 가 미지정이면 true 로 주입한다.
 *   - TAB_ID_INJECT_TOOLS 이고 tabId 가 미지정이면 이 세션·레인의 작업 탭을 주입한다.
 *     단 `url` 이 곧 대상 지정인 도구(URL_SELECTS_TARGET_TOOLS)에 url 을 준 호출은 예외다.
 *     그 도구들은 tabId 분기를 url 분기보다 먼저 보므로, 주입하면 URL 이 통째로 무시된다.
 *   - 작업 탭이 없으면 **사용자의 활성 탭으로 흘려보내지 않고** 호출을 거절한다(F2).
 *     각 도구 구현은 tabId 가 없으면 활성 탭으로 fallback 하므로, 여기서 막지 않으면
 *     새 세션의 첫 click/fill/read_page/screenshot 이 사용자가 보고 있는 탭을 조작한다.
 *   - tabId 는 **양의 정수만** 지정으로 인정한다. null·문자열·0·음수·NaN 은 예전에
 *     "명시됨" 으로 통과했고, 그 뒤 도구 구현이 활성 탭으로 fallback 해 게이트가
 *     통째로 뚫렸다. 이제 invalid_tab_id 로 즉시 거절한다.
 *   - 명시적 windowId(양의 정수)가 있으면 사용자가 대상 창을 고른 것이므로 통과시킨다.
 *   - background mode 가 꺼져 있으면 예전 동작을 그대로 둔다.
 */

import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import { isBackgroundModeEnabled } from '@/utils/background-mode';
import { getWorkTabId, sessionKeyOf } from '@/utils/work-tab-manager';

const B = TOOL_NAMES.BROWSER;
const RR = TOOL_NAMES.RECORD_REPLAY;

/**
 * 게이트가 인자를 읽는 유일한 통로 (2026-09-04 Codex 최종 검토 항목 1-c).
 *
 * 게이트 판정은 `tabId`·`windowId`·`tabIds`·`url`·`lane`·`_mcpSessionId`·`background` 를
 * 읽는다. 이 값들을 `args.tabId` 로 읽으면 **prototype 으로 상속된 값**도 읽힌다 —
 * `{"__proto__": {...}}` 로 만들어진 인자가 게이트를 통과하는 경로였다. own 속성만 본다.
 */
function ownArg(args: any, key: string): unknown {
  if (args === null || typeof args !== 'object') return undefined;
  return Object.hasOwn(args, key) ? args[key] : undefined;
}

/** sessionKeyOf 에 넘길 실행 컨텍스트 — own 속성만 추린 사본. */
function ownSessionArgs(args: any): { _mcpSessionId?: unknown; lane?: unknown } {
  return { _mcpSessionId: ownArg(args, '_mcpSessionId'), lane: ownArg(args, 'lane') };
}

/**
 * 백그라운드 작업 모드에서는 **아예 실행하지 않는** 도구.
 *
 * record_replay_flow_run (2026-09-04 Codex 3차 검토, 항목 3):
 * replay 엔진은 대상 탭을 스스로 고른다. rr-utils 의 ensureTab() 은 tabTarget 이 없거나
 * 'current' 면 `chrome.tabs.query({ active: true, currentWindow: true })` 로 **사용자의
 * 활성 탭**을 잡고, legacy step executor 와 대부분의 노드(click·fill·extract·assert·
 * script·wait·drag 등)도 ctx.tabId 를 무시하고 같은 조회를 다시 한다
 * (엔진·노드 전체에서 28곳/16파일). 그래서 게이트가 작업 탭 id 를 주입해도 소비하는
 * 지점이 없고, 작업 탭 유무와 무관하게 사용자가 보고 있는 탭이 조작된다.
 *
 * 엔진 전체가 ctx.tabId 를 존중하도록 고치기 전까지는 모드 ON 에서 거절한다(fail-closed).
 * 모드를 끄면(popup 토글) 예전처럼 실행된다 — 사용자가 간섭을 허용한 상태다.
 * 사이드패널에서 사람이 직접 돌리는 실행은 이 게이트를 타지 않으므로 영향이 없다.
 */
export const BACKGROUND_MODE_UNSUPPORTED_TOOLS: ReadonlySet<string> = new Set<string>([
  RR.FLOW_RUN,
]);

/**
 * 백그라운드 작업 모드 게이트에서 완전히 제외되는 도구 — 정의상 사용자 대면 동작.
 */
export const GATE_EXEMPT_TOOLS: ReadonlySet<string> = new Set<string>([
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
export const TAB_ID_INJECT_TOOLS: ReadonlySet<string> = new Set<string>([
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
 * TAB_ID_INJECT_TOOLS 중에서도 **args.windowId 를 실제로 대상 탭 해석에 쓰는** 도구.
 *
 * 각 도구 구현이 `getActiveTabOrThrowInWindow(args.windowId)` / `getActiveTabInWindow(windowId)`
 * 또는 `chrome.tabs.query({ active:true, windowId })` 로 그 창의 활성 탭을 고르는 것을
 * 코드로 확인한 목록이다 (2026-09-04 Codex 2차 검토 반영). 여기 든 도구만 windowId 로
 * 게이트를 통과시킨다 — 사용자가 창을 골랐고 도구가 그 지정을 실제로 따르기 때문이다.
 *
 * **여기에 없는 TAB_ID_INJECT_TOOLS 는 windowId 를 소비하지 않고 전역 활성 탭(currentWindow)
 * 으로 fallback 한다.** 그런 도구는 windowId 가 있어도 work tab 규칙을 그대로 적용해야
 * 새 세션의 `{code, windowId}` 호출이 사용자가 보던 탭에서 실행되는 것을 막는다(fail-closed).
 *
 * 코드 근거 (app/chrome-extension/entrypoints/background/tools/browser/):
 *   - SCREENSHOT     screenshot.ts:370  getActiveTabOrThrowInWindow(args.windowId)
 *   - WEB_FETCHER    web-fetcher.ts:98  chrome.tabs.query({active:true, windowId})
 *   - CLICK          interaction.ts:107 getActiveTabOrThrowInWindow(args.windowId)
 *   - FILL           interaction.ts:378 getActiveTabOrThrowInWindow(args.windowId)
 *   - KEYBOARD       keyboard.ts:39     getActiveTabOrThrowInWindow(args.windowId)
 *   - CONSOLE        console.ts:234     chrome.tabs.query({active:true, windowId})
 *   - FILE_UPLOAD    file-upload.ts:47  getActiveTabOrThrowInWindow(args.windowId)
 *   - READ_PAGE      read-page.ts:253   getActiveTabOrThrowInWindow(args?.windowId)
 *   - COMPUTER       computer.ts:234    getActiveTabOrThrowInWindow(args.windowId)
 *   - INJECT_SCRIPT  inject-script.ts:77 chrome.tabs.query({active:true, windowId})
 *   - FIND           find.ts:540        getActiveTabOrThrowInWindow(params.windowId)
 *   - STORAGE        storage.ts:150,295 getActiveTabInWindow/OrThrowInWindow(params.windowId)
 *   - SAVE_PDF       pdf.ts:88          getActiveTabOrThrowInWindow(params.windowId)
 *   - EMULATE        emulate.ts:144     getActiveTabOrThrowInWindow(params.windowId)
 *
 * windowId 를 무시하는 것으로 확인된 도구(→ 목록에서 뺀다, fail-closed):
 *   - JAVASCRIPT     javascript.ts:474  getActiveTabOrThrow() (windowId 인자 없음)
 *   - EXTRACT        extract.ts:265     getActiveTabOrThrowInWindow() (인자 없음)
 *   - SCROLL_COLLECT scroll-collect.ts:366 getActiveTabOrThrowInWindow() (인자 없음)
 *   - WAIT_FOR       wait-for.ts:212    getActiveTabOrThrowInWindow() (인자 없음)
 *   - GIF_RECORDER   gif-recorder.ts:1291 getActiveTabOrThrow()
 *   - HANDLE_DIALOG  dialog.ts:26       getActiveTabOrThrow()
 *   - GET_INTERACTIVE_ELEMENTS web-fetcher.ts:371 chrome.tabs.query({active,currentWindow})
 *   - NETWORK_REQUEST network-request.ts:44 getActiveTabInWindow() (인자 없음)
 *   - NETWORK_CAPTURE(_START/STOP)·NETWORK_DEBUGGER(_START/STOP) getActiveTabInWindow()/getActiveTabOrThrow()
 *   - PERFORMANCE_(START_TRACE/STOP_TRACE/ANALYZE_INSIGHT) performance.ts getActiveTabInWindow() (인자 없음)
 *   - USERSCRIPT     userscript.ts getActiveTab() (창 개념 없음)
 *   - NETWORK_RULES  windowId·tabId 모두 안 씀 (NO_TAB_NEEDED)
 */
export const WINDOW_ID_AWARE_TOOLS: ReadonlySet<string> = new Set<string>([
  B.SCREENSHOT,
  B.WEB_FETCHER,
  B.CLICK,
  B.FILL,
  B.KEYBOARD,
  B.CONSOLE,
  B.FILE_UPLOAD,
  B.READ_PAGE,
  B.COMPUTER,
  B.INJECT_SCRIPT,
  B.FIND,
  B.STORAGE,
  B.SAVE_PDF,
  B.EMULATE,
]);

/**
 * TAB_ID_INJECT_TOOLS 중에서도, tabId 가 없으면 **대상 탭을 아예 찾지 않는** 호출.
 * 사용자 탭을 건드릴 수 없으므로 작업 탭이 없다는 이유로 막지 않는다.
 *
 * 이 목록이 늘어나면 그만큼 게이트에 구멍이 나므로 근거를 함께 남길 것.
 */
const NO_TAB_NEEDED: Record<string, (args: any) => boolean> = {
  // tabId 를 주지 않으면 규칙 범위가 '모든 탭' 이다 — network-rules.ts 에는 활성 탭을
  // 조회하는 경로가 없다 (params.tabId 만 본다).
  [B.NETWORK_RULES]: () => true,
  // 쿠키 조작은 범위(url 또는 domain)만 있으면 대상 탭을 찾지 않는다.
  [B.STORAGE]: (args) => {
    // kind 가 'local'·'session' 이면 웹 스토리지 경로라 반드시 탭에서 실행해야 한다.
    const kind = ownArg(args, 'kind');
    if (kind === 'local' || kind === 'session') return false;
    // url 을 직접 준 호출은 storage.ts resolveUrl 이 그대로 쓰고 조기 반환한다.
    const storageUrl = ownArg(args, 'url');
    if (typeof storageUrl === 'string' && storageUrl.trim().length > 0) return true;
    // domain 은 get·clear 에서만 범위로 썼다(handleCookies 가 query.domain 으로 바로 조회한다).
    // set·remove 는 chrome.cookies 가 url 을 요구하므로 여전히 대상 탭을 찾으러 간다.
    const rawAction = ownArg(args, 'action');
    const action = typeof rawAction === 'string' ? rawAction : 'get';
    const domain = ownArg(args, 'domain');
    const hasDomain = typeof domain === 'string' && domain.trim().length > 0;
    return hasDomain && (action === 'get' || action === 'clear');
  },
};

/** 거절 응답의 오류 코드 — 모델이 문구가 아니라 코드로 분기할 수 있게 고정한다. */
export const NO_WORK_TAB_ERROR = 'no_work_tab';

/** 탭 id 가 될 수 없는 값을 tabId 로 받았을 때의 오류 코드. */
export const INVALID_TAB_ID_ERROR = 'invalid_tab_id';

/** 백그라운드 작업 모드에서 실행할 수 없는 도구를 부른 경우의 오류 코드. */
export const BACKGROUND_MODE_UNSUPPORTED_ERROR = 'background_mode_unsupported';

/**
 * 이 값이 "호출자가 지정한 탭" 인가.
 *
 * 탭 id 는 항상 양의 정수다. 예전에는 `tabId !== undefined` 만 봤기 때문에
 * `tabId: null`·`"x"`·0 같은 값이 "명시됨" 으로 통과하고, 그 뒤 도구 구현이
 * tabId 가 없다고 보고 **사용자의 활성 탭으로 fallback** 했다. 게이트가 통째로 뚫렸다.
 */
export function isExplicitTabId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * 이 값이 "호출자가 지정한 창" 인가.
 *
 * 양의 정수만 인정한다 — WINDOW_ID_CURRENT(-2) 같은 별칭은 "지금 보는 창" 을 뜻하므로
 * 사용자 탭으로 흘러갈 수 있다. 인정하지 않으면 게이트가 막는다(fail-closed).
 */
function isExplicitWindowId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * WINDOW_ID_AWARE_TOOLS 중에서도 **`url` 인자가 오면 창 지정을 버리는** 도구.
 *
 * 이 세 도구는 url 이 있으면 창과 무관하게 전체 탭에서 첫 URL 일치 탭을 고른다.
 *   - WEB_FETCHER    web-fetcher.ts   chrome.tabs.query({}) 전체 검색
 *   - CONSOLE        console.ts       navigateToUrl → chrome.tabs.query({ url })
 *   - INJECT_SCRIPT  inject-script.ts chrome.tabs.query({}) 전체 검색
 *
 * 그래서 `{windowId: 42, url: X}` 가 다른 사용자 창의 탭을 읽거나 디버거를 붙였다.
 * url 이 함께 오면 windowId 예외를 주지 않는다(fail-closed). (2026-09-04 Codex 3차 검토)
 *
 * 그 뒤 최종 검토에서, 이때 작업 탭을 주입하면 도구가 tabId 분기로 빠져 url 이 통째로
 * 무시된다는 것이 드러났다. 그래서 지금은 URL_SELECTS_TARGET_TOOLS 규칙이 먼저 적용돼
 * 주입도 거절도 하지 않고, 도구가 url-target.ts 로 세션 범위에서 찾거나 만든다.
 * 이 목록은 여전히 필요하다 — url 이 있으면 windowId 는 "그 창의 활성 탭" 이 아니라
 * "새 탭을 붙일 창" 으로만 쓰인다는 판정이 여기서 나온다.
 */
const URL_OVERRIDES_WINDOW_TOOLS: ReadonlySet<string> = new Set<string>([
  B.WEB_FETCHER,
  B.CONSOLE,
  B.INJECT_SCRIPT,
]);

/** url 인자가 "대상 탭을 고르는 값" 으로 실제로 쓰이는가 (빈 문자열은 분기를 타지 않는다). */
function hasUrlArg(args: any): boolean {
  const url = ownArg(args, 'url');
  return typeof url === 'string' && url.trim().length > 0;
}

/**
 * `url` 인자가 **대상 탭 지정 그 자체**인 도구.
 *
 * 이 도구들의 execute 는 `tabId` 분기를 `url` 분기보다 먼저 본다. 그래서 게이트가 작업
 * tabId 를 주입하면 url 분기에 도달하지 못하고, `chrome_get_web_content({url})` 이
 * 요청한 URL 대신 기존 작업 탭 내용을 돌려줬다(2026-09-04 Codex 최종 검토 회귀 1건).
 * 이 목록의 도구는 url 이 오면 tabId 를 주입하지 않고, 작업 탭이 없다고 거절하지도 않는다.
 * URL 자체가 대상 지정이므로 도구가 url-target.ts 로 찾거나 만든다.
 *
 * 코드 근거:
 *   - WEB_FETCHER          web-fetcher.ts execute: `else if (url)` → findTabByUrlInSessionScope
 *                          → 없으면 createTabForUrl (찾거나 만들기)
 *   - CONSOLE              console.ts execute: `else if (url)` → navigateToUrl
 *                          → findTabByUrlInSessionScope, 없으면 createTabForUrl (찾거나 만들기)
 *   - INJECT_SCRIPT        inject-script.ts execute: `else if (url)` → findTabByUrlInSessionScope
 *                          → 없으면 createTabForUrl (찾거나 만들기)
 *   - NETWORK_CAPTURE      network-capture.ts handleStart: url 을 delegate 로 그대로 넘긴다
 *   - NETWORK_CAPTURE_START network-capture-web-request.ts execute: `else if (targetUrl)`
 *                          → findTabByUrlInSessionScope, 없으면 createTabForUrl (찾거나 만들기)
 *   - NETWORK_DEBUGGER_START network-capture-debugger.ts execute: `else if (targetUrl)`
 *                          → findTabByUrlInSessionScope, 없으면 createTabForUrl (찾거나 만들기)
 *
 * 여기 없는 도구의 `url` 은 대상 탭 지정이 아니다:
 *   - STORAGE         storage.ts resolveUrl — 쿠키 범위(url/domain)일 뿐이다. NO_TAB_NEEDED 가 따로 본다.
 *   - NETWORK_REQUEST network-request.ts — 보낼 요청의 URL 이다. 대상 탭은 tabId·활성 탭으로 고른다.
 *   - NAVIGATE        게이트의 주입 대상이 아니다(자체 탭 선택 + 작업 탭 기록 담당).
 */
export const URL_SELECTS_TARGET_TOOLS: ReadonlySet<string> = new Set<string>([
  B.WEB_FETCHER,
  B.CONSOLE,
  B.INJECT_SCRIPT,
  B.NETWORK_CAPTURE,
  B.NETWORK_CAPTURE_START,
  B.NETWORK_DEBUGGER_START,
]);

/** 이 호출에서 url 이 대상 탭을 고르는가. */
function urlSelectsTarget(name: string, args: any): boolean {
  return URL_SELECTS_TARGET_TOOLS.has(name) && hasUrlArg(args);
}

/**
 * 이 호출에서 windowId 가 **실제로 대상 탭을 고르는가**.
 *
 * windowId 예외는 그 도구가 windowId 로 창의 활성 탭을 고를 때만 안전하다. windowId 를
 * 소비하지 않는 도구(chrome_javascript 등)는 windowId 가 있어도 전역 활성 탭으로
 * fallback 하므로, 예외를 주면 새 세션의 첫 호출이 사용자가 보던 탭에서 실행된다.
 * 따라서 양의 정수 windowId + WINDOW_ID_AWARE_TOOLS 둘 다일 때만 참이다.
 *
 * url 분기가 있는 도구는 url 이 함께 오면 창 지정 자체가 무시되므로 예외에서 제외한다.
 */
function windowIdSelectsTarget(name: string, args: any): boolean {
  if (!isExplicitWindowId(ownArg(args, 'windowId'))) return false;
  if (!WINDOW_ID_AWARE_TOOLS.has(name)) return false;
  if (URL_OVERRIDES_WINDOW_TOOLS.has(name) && hasUrlArg(args)) return false;
  return true;
}

/** tabId 를 줬는데 그 값이 탭 id 가 될 수 없는 경우 (undefined 는 "안 준 것" 으로 본다). */
export function hasInvalidTabId(args: any): boolean {
  if (args === null || typeof args !== 'object') return false;
  // 상속된 tabId 는 '준 것' 으로 보지 않는다 — own 이 아니면 아래 판정에서도 무시된다.
  if (!Object.hasOwn(args, 'tabId')) return false;
  if (args.tabId === undefined) return false;
  return !isExplicitTabId(args.tabId);
}

/**
 * 작업 탭이 없어 거절할 때 돌려줄 본문. createErrorResponse 가 문자열만 받으므로
 * 구조화 정보를 JSON 문자열로 싣는다.
 */
export function noWorkTabErrorText(toolName: string): string {
  return JSON.stringify({
    error: NO_WORK_TAB_ERROR,
    tool: toolName,
    message:
      'chrome_navigate 로 작업 탭을 먼저 만들거나 tabId 를 지정하세요 ' +
      '(백그라운드 작업 모드에서는 사용자가 보고 있는 탭을 대신 쓰지 않습니다).',
  });
}

/**
 * 못 쓸 tabId 를 받았을 때 돌려줄 본문. 거절하지 않으면 도구 구현이 사용자의
 * 활성 탭을 대상으로 삼는다 — 게이트가 있는 이유 자체가 없어진다.
 */
export function invalidTabIdErrorText(toolName: string, tabId: unknown): string {
  return JSON.stringify({
    error: INVALID_TAB_ID_ERROR,
    tool: toolName,
    received: typeof tabId === 'number' || typeof tabId === 'string' ? tabId : typeof tabId,
    message:
      'tabId 는 양의 정수여야 합니다. 잘못된 값이 오면 사용자가 보고 있는 탭으로 ' +
      'fallback 하지 않고 거절합니다. get_windows_and_tabs 로 탭 id 를 확인하거나, ' +
      'tabId 를 아예 빼고 부르세요(이 세션·레인의 작업 탭이 자동으로 쓰입니다).',
  });
}

/**
 * 백그라운드 작업 모드에서 실행할 수 없는 도구를 부른 경우의 본문.
 */
export function backgroundModeUnsupportedErrorText(toolName: string): string {
  return JSON.stringify({
    error: BACKGROUND_MODE_UNSUPPORTED_ERROR,
    tool: toolName,
    message:
      '이 도구는 대상 탭을 스스로 고르기 때문에 백그라운드 작업 모드에서는 실행하지 않습니다 ' +
      '(사용자가 보고 있는 탭을 조작하게 됩니다). 확장 팝업에서 백그라운드 작업 모드를 끄거나, ' +
      '사이드패널에서 직접 실행하세요.',
  });
}

/**
 * 이 호출이 "작업 탭이 없으면 거절" 대상인가. background mode 가 켜져 있고 작업 탭이
 * 없다는 사실은 호출부가 판정한다 — 이 함수는 도구·인자만 본다.
 */
export function requiresWorkTab(name: string, args: any): boolean {
  if (GATE_EXEMPT_TOOLS.has(name)) return false;
  if (!TAB_ID_INJECT_TOOLS.has(name)) return false;
  // 양의 정수만 "명시됨" 이다. 그 밖의 값은 게이트 우회 수단이었다.
  if (isExplicitTabId(ownArg(args, 'tabId'))) return false;
  // url 이 곧 대상 지정인 호출은 작업 탭을 요구하지 않는다. 도구가 세션 소유 탭에서
  // URL 일치 탭을 찾고, 없으면 새 탭을 만든다(사용자 탭은 후보가 아니다).
  if (urlSelectsTarget(name, args)) return false;
  // 사용자가 창을 지정했고 **그 도구가 windowId 로 대상 탭을 고를 때만** 작업 탭을
  // 요구하지 않는다. windowId 를 무시하는 도구는 창 지정이 있어도 전역 활성 탭으로
  // fallback 하므로 게이트를 그대로 적용한다(fail-closed).
  if (windowIdSelectsTarget(name, args)) return false;
  const exempt = NO_TAB_NEEDED[name];
  if (exempt && exempt(args)) return false;
  return true;
}

export interface BackgroundModeGateResult {
  /** 보정된 도구 인자 (호출자가 명시한 값은 절대 덮어쓰지 않는다). */
  args: any;
  /** 이 세션·레인의 작업 탭 id. 조회할 필요가 없는 경로에서는 null. */
  workTabId: number | null;
  /**
   * true 면 호출을 실행하지 말고 no_work_tab 오류를 돌려줘야 한다.
   * (사용자가 보고 있는 탭으로 흘러가는 것을 막는 유일한 지점이다.)
   */
  noWorkTab: boolean;
  /** true 면 tabId 값 자체가 잘못됐다 — invalid_tab_id 오류를 돌려줘야 한다. */
  invalidTabId: boolean;
  /**
   * true 면 이 도구는 백그라운드 작업 모드에서 실행할 수 없다 —
   * background_mode_unsupported 오류를 돌려줘야 한다.
   */
  unsupportedInBackgroundMode: boolean;
}

/**
 * 백그라운드 작업 모드가 ON 이면 도구 args 를 무간섭 방향으로 보정한다.
 * 호출자가 명시한 값은 절대 덮어쓰지 않는다.
 *
 * 판정 순서도 계약의 일부다 — getWorkTabId 는 chrome.tabs.get 을 부르므로, 결과를 쓰지
 * 않는 경로에서는 아예 부르지 않는다(도구 호출마다 붙던 고정 대기였다).
 */
export async function applyBackgroundModeGate(
  name: string,
  args: any,
): Promise<BackgroundModeGateResult> {
  // ① 인자 검증이 가장 앞이다. 예외 도구도 못 쓸 tabId 로 부르면 그 도구가
  //   활성 탭을 대상으로 삼으므로, 게이트 적용 여부와 무관하게 거절한다.
  if (hasInvalidTabId(args)) {
    return {
      args,
      workTabId: null,
      noWorkTab: false,
      invalidTabId: true,
      unsupportedInBackgroundMode: false,
    };
  }

  // ② 게이트를 아예 타지 않는 사용자 대면 도구 — 작업 탭을 조회하지 않는다.
  if (GATE_EXEMPT_TOOLS.has(name)) {
    return {
      args,
      workTabId: null,
      noWorkTab: false,
      invalidTabId: false,
      unsupportedInBackgroundMode: false,
    };
  }

  const explicitTab = isExplicitTabId(ownArg(args, 'tabId'));
  // windowId 는 그 도구가 실제로 대상 해석에 쓸 때만 "대상 지정" 으로 인정한다.
  const windowSelectsTarget = windowIdSelectsTarget(name, args);
  // url 이 곧 대상 지정인 호출은 tabId 를 주입하면 안 된다 — 도구가 tabId 를 먼저 보므로
  // 주입하는 순간 url 이 통째로 무시된다.
  const urlTarget = urlSelectsTarget(name, args);

  // ③ 모드가 꺼져 있으면 인자를 보정하지 않는다(예전 동작). 작업 탭 조회는
  //   handleCallTool 의 팝업 감지(opener 후보)가 쓰므로 남긴다 — 단, 호출자가 대상
  //   탭을 직접 지정했으면 그 탭이 이미 첫 후보라 조회를 생략해도 잃는 것이 없다.
  if (!(await isBackgroundModeEnabled())) {
    const workTabId = explicitTab ? null : await getWorkTabId(sessionKeyOf(ownSessionArgs(args)));
    return {
      args,
      workTabId,
      noWorkTab: false,
      invalidTabId: false,
      unsupportedInBackgroundMode: false,
    };
  }

  // ③-1 대상 탭을 스스로 고르는 도구는 모드 ON 에서 실행하지 않는다(항목 3).
  //     작업 탭을 주입해도 엔진이 소비하지 않으므로, 통과시키면 사용자 탭이 조작된다.
  if (BACKGROUND_MODE_UNSUPPORTED_TOOLS.has(name)) {
    return {
      args,
      workTabId: null,
      noWorkTab: false,
      invalidTabId: false,
      unsupportedInBackgroundMode: true,
    };
  }

  // spread 는 own 열거 속성만 복사하므로 상속으로 실려 온 대상 지정 키는 여기서 사라진다.
  const patched = { ...(args ?? {}) };
  if (patched.background === undefined) {
    patched.background = true;
  }

  // ④ 대상 탭을 직접 지정한 호출은 작업 탭이 아예 필요 없다.
  if (explicitTab) {
    return {
      args: patched,
      workTabId: null,
      noWorkTab: false,
      invalidTabId: false,
      unsupportedInBackgroundMode: false,
    };
  }

  const workTabId = await getWorkTabId(sessionKeyOf(ownSessionArgs(args)));

  // windowId 로 대상을 고르는 도구는 주입도 거절도 하지 않는다 — 사용자가 창을 골랐고,
  // 도구 구현이 그 창의 활성 탭을 쓴다. 작업 탭을 끼워 넣으면 그 지정이 무시된다.
  // windowId 를 무시하는 도구는 이 조건을 통과해 작업 탭 주입/거절 규칙을 그대로 받는다.
  // url 로 대상을 고르는 호출도 통과시킨다 — 주입하면 도구가 tabId 분기로 빠져 url 이
  // 무시되고, 거절하면 URL 을 준 호출이 작업 탭 없다는 이유로 실패한다.
  if (
    TAB_ID_INJECT_TOOLS.has(name) &&
    patched.tabId === undefined &&
    !windowSelectsTarget &&
    !urlTarget
  ) {
    if (workTabId !== null) {
      patched.tabId = workTabId;
    } else if (requiresWorkTab(name, args)) {
      // auto-chrome-mcp fork(F2): 여기서 막지 않으면 도구 구현이 사용자의 활성 탭으로
      // fallback 한다. 새 세션의 첫 호출이 사용자가 보던 페이지를 읽거나 클릭했다.
      return {
        args: patched,
        workTabId,
        noWorkTab: true,
        invalidTabId: false,
        unsupportedInBackgroundMode: false,
      };
    }
  }
  return {
    args: patched,
    workTabId,
    noWorkTab: false,
    invalidTabId: false,
    unsupportedInBackgroundMode: false,
  };
}
