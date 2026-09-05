/**
 * Tool registry for Playwright CDP fallback transport.
 *
 * design 문서 §4 의 원래 33 도구 분류 (upstream 기준):
 *   🟢 1:1 매핑       — Playwright API 직접 (navigate, click, screenshot, ...)
 *   🟡 우회 구현       — CDP event 캡처 (network_capture, console)
 *   🔴 stub (native-only) — bookmark_*, history (chrome.history API), inject_script,
 *                           search_tabs_content, performance, gif_recorder, file_upload,
 *                           handle_download
 *
 * auto-chrome-mcp fork 가 upstream 이후 도구 12개(chrome_batch, chrome_set_work_tab,
 * chrome_wait_for, chrome_scroll_collect, chrome_storage, chrome_save_pdf, chrome_emulate,
 * chrome_network_rules, chrome_extract, chrome_find, chrome_shortcut,
 * chrome_request_user_consent)를 추가했다. 2026-09-04 이전에는 이 12개가 레지스트리에
 * 아예 없었고(빠진 키는 안내 없이 실패), 5개 키는 실제 이름과 접두사가 달라 죽은
 * stub 이었다 — 전부 이 시점에 바로잡았다.
 *
 * MVP: 핵심 3개 (navigate, screenshot, get_content) 만 진짜 구현, 나머지는 stub.
 * design intent 는 "모든 도구를 미러 (native-only 는 stub)" — fork v1 에서 점진 확장.
 * 총 48개(upstream 36 + fork 12) 도구가 이 레지스트리에 등록돼 있다.
 */
import type { CdpAttachState } from './cdp-client.js';
import { navigateHandler } from './handlers/navigate.js';
import { screenshotHandler } from './handlers/screenshot.js';
import { getContentHandler } from './handlers/get-content.js';

/**
 * `'workaround'` 는 아직 어떤 도구에도 붙어 있지 않다(현재 1to1 3 / stub 45 / workaround 0).
 * CDP event capture 로 우회 구현하는 도구(network_capture 계열, console)를 실제로 만들 때
 * 그 항목의 status 를 이 값으로 올린다. docs/PLAYWRIGHT_FALLBACK.md 의 표와 같은 분류다.
 */
export type ToolStatus = '1to1' | 'workaround' | 'stub';

export interface ToolHandler {
  status: ToolStatus;
  /** Handler 본문. throw 시 caller 가 MCP error 로 변환. */
  call?: (cdp: CdpAttachState, args: any) => Promise<unknown>;
  /** stub 의 경우 안내 메시지. */
  stubReason?: string;
}

const stub = (reason: string): ToolHandler => ({
  status: 'stub',
  stubReason: reason,
});

const NATIVE_ONLY_REASON =
  'This tool requires native messaging mode (chrome.* extension APIs). ' +
  'Switch to Primary mode or use the Chrome extension directly.';

/**
 * 48 tool name → handler 매핑 (upstream 36 + fork 12).
 * Tool 이름은 auto-chrome-mcp-shared 의 TOOL_NAMES 와 1:1 일치.
 */
export const TOOL_REGISTRY: Record<string, ToolHandler> = {
  // -------- 🟢 1:1 매핑 (MVP — 3개 진짜 구현) --------
  chrome_navigate: { status: '1to1', call: navigateHandler },
  chrome_screenshot: { status: '1to1', call: screenshotHandler },
  chrome_get_web_content: { status: '1to1', call: getContentHandler },

  // -------- 🟢 1:1 매핑 (후속 구현 예정 — 현재 stub) --------
  chrome_click_element: stub('1to1 mapping pending (page.click)'),
  chrome_fill_or_select: stub('1to1 mapping pending (page.fill / page.selectOption)'),
  chrome_keyboard: stub('1to1 mapping pending (page.keyboard)'),
  chrome_javascript: stub('1to1 mapping pending (page.evaluate)'),
  chrome_close_tabs: stub('1to1 mapping pending (page.close)'),
  chrome_switch_tab: stub('1to1 mapping pending (context.pages + bringToFront)'),
  chrome_get_interactive_elements: stub('1to1 mapping pending (page.locator + ARIA tree)'),
  chrome_request_element_selection: stub('1to1 mapping pending (page.locator)'),
  chrome_read_page: stub('1to1 mapping pending (accessibility tree)'),
  chrome_computer: stub('1to1 mapping pending (page.mouse + page.keyboard)'),
  chrome_handle_dialog: stub('1to1 mapping pending (page.on(dialog))'),
  chrome_userscript: stub('1to1 mapping pending (page.evaluate + addInitScript)'),

  // -------- 🟡 우회 구현 (CDP event capture) --------
  chrome_network_capture: stub('CDP event capture pending (Network.requestWillBeSent)'),
  chrome_network_capture_start: stub('CDP event capture pending'),
  chrome_network_capture_stop: stub('CDP event capture pending'),
  chrome_network_request: stub('CDP event capture pending'),
  chrome_network_debugger_start: stub('CDP event capture pending'),
  chrome_network_debugger_stop: stub('CDP event capture pending'),
  chrome_console: stub('CDP event capture pending (Runtime.consoleAPICalled)'),

  // -------- 🔴 stub (native-only) --------
  chrome_history: stub(NATIVE_ONLY_REASON + ' (uses chrome.history API)'),
  chrome_bookmark_search: stub(NATIVE_ONLY_REASON + ' (uses chrome.bookmarks API)'),
  chrome_bookmark_add: stub(NATIVE_ONLY_REASON + ' (uses chrome.bookmarks API)'),
  chrome_bookmark_delete: stub(NATIVE_ONLY_REASON + ' (uses chrome.bookmarks API)'),
  chrome_inject_script: stub(NATIVE_ONLY_REASON + ' (uses chrome.scripting API)'),
  chrome_send_command_to_inject_script: stub(NATIVE_ONLY_REASON),
  chrome_upload_file: stub(NATIVE_ONLY_REASON + ' (file system access)'),
  chrome_handle_download: stub(NATIVE_ONLY_REASON + ' (chrome.downloads API)'),
  chrome_gif_recorder: stub(NATIVE_ONLY_REASON + ' (extension-only screen capture)'),
  // 2026-09-04: 이 다섯 키는 실제 도구 이름과 'chrome_' 접두사가 어긋나 있어(또는 완전히
  // 다른 이름이라) TOOL_REGISTRY 조회가 절대 매치되지 않는 죽은 stub 이었다. 실제 이름으로
  // 바로잡았다 — 값은 그대로(전부 native-only), 키만 수정.
  // semantic search depends on wasm-simd + extension storage
  search_tabs_content: stub(NATIVE_ONLY_REASON + ' (semantic engine requires extension wasm)'),
  // performance tracing
  performance_start_trace: stub(NATIVE_ONLY_REASON + ' (chrome.debugger Trace.start)'),
  performance_stop_trace: stub(NATIVE_ONLY_REASON),
  performance_analyze_insight: stub(NATIVE_ONLY_REASON),
  // window/tab list (could be 1to1 with context.pages but extension version exposes window-level info)
  get_windows_and_tabs: stub(
    '1to1 mapping pending (context.pages -> tab list, but window info needs chrome.windows API)',
  ),

  // -------- 🔴 stub (fork-added tools, not yet triaged for this transport) --------
  // 2026-09-04: 이 12개는 auto-chrome-mcp fork 가 upstream 의 33-도구 설계 이후 추가했고,
  // 이 레지스트리(design 문서 §4 의 33 도구 표)에는 한 번도 반영되지 않아 완전히 빠져
  // 있었다 — 즉 폴백 모드에서 부르면 TOOL_REGISTRY 에 키가 없어 안내 없이 실패했다.
  // 개별 Playwright 구현 없이 우선 공통 native-only stub 으로 등록해 이유가 담긴 에러를
  // 즉시 돌려주게 한다(chrome.storage.session lane 게이트, declarativeNetRequest 등
  // extension 전용 API 에 의존하는 도구가 섞여 있어 개별 포팅은 후속 작업).
  chrome_request_user_consent: stub(NATIVE_ONLY_REASON + ' (fork-added; not yet ported)'),
  chrome_batch: stub(NATIVE_ONLY_REASON + ' (fork-added; not yet ported)'),
  chrome_set_work_tab: stub(NATIVE_ONLY_REASON + ' (fork-added; not yet ported)'),
  chrome_wait_for: stub(NATIVE_ONLY_REASON + ' (fork-added; not yet ported)'),
  chrome_scroll_collect: stub(NATIVE_ONLY_REASON + ' (fork-added; not yet ported)'),
  chrome_storage: stub(NATIVE_ONLY_REASON + ' (fork-added; not yet ported)'),
  chrome_save_pdf: stub(NATIVE_ONLY_REASON + ' (fork-added; not yet ported)'),
  chrome_emulate: stub(NATIVE_ONLY_REASON + ' (fork-added; not yet ported)'),
  chrome_network_rules: stub(NATIVE_ONLY_REASON + ' (fork-added; not yet ported)'),
  chrome_extract: stub(NATIVE_ONLY_REASON + ' (fork-added; not yet ported)'),
  chrome_find: stub(NATIVE_ONLY_REASON + ' (fork-added; not yet ported)'),
  chrome_shortcut: stub(NATIVE_ONLY_REASON + ' (fork-added; not yet ported)'),
};

/**
 * 카운트별 분류 — UI / diagnostic 표시용.
 */
export const REGISTRY_STATS = () => {
  const counts: Record<ToolStatus, number> = { '1to1': 0, workaround: 0, stub: 0 };
  for (const h of Object.values(TOOL_REGISTRY)) {
    counts[h.status]++;
  }
  return {
    total: Object.keys(TOOL_REGISTRY).length,
    implemented:
      counts['1to1'] -
      Object.values(TOOL_REGISTRY).filter((h) => h.status === '1to1' && !h.call).length,
    by_status: counts,
  };
};
