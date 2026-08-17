/**
 * Tool registry for Playwright CDP fallback transport.
 *
 * design 문서 §4 의 33 도구 분류:
 *   🟢 1:1 매핑       — Playwright API 직접 (navigate, click, screenshot, ...)
 *   🟡 우회 구현       — CDP event 캡처 (network_capture, console)
 *   🔴 stub (native-only) — bookmark_*, history (chrome.history API), inject_script,
 *                           semantic_search, performance, gif_recorder, file_upload, handle_download
 *
 * MVP: 핵심 3개 (navigate, screenshot, get_content) 만 진짜 구현, 나머지 30개 stub.
 * design intent 는 "33 도구 모두 미러 (native-only 는 stub)" — fork v1 에서 점진 확장.
 */
import type { CdpAttachState } from './cdp-client.js';
import { navigateHandler } from './handlers/navigate.js';
import { screenshotHandler } from './handlers/screenshot.js';
import { getContentHandler } from './handlers/get-content.js';

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
 * 33 tool name → handler 매핑.
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
  // semantic search depends on wasm-simd + extension storage
  chrome_semantic_search: stub(NATIVE_ONLY_REASON + ' (semantic engine requires extension wasm)'),
  // performance tracing
  chrome_performance_start_trace: stub(NATIVE_ONLY_REASON + ' (chrome.debugger Trace.start)'),
  chrome_performance_stop_trace: stub(NATIVE_ONLY_REASON),
  chrome_performance_analyze_insight: stub(NATIVE_ONLY_REASON),
  // window/tab list (could be 1to1 with context.pages but extension version exposes window-level info)
  chrome_get_windows_and_tabs: stub(
    '1to1 mapping pending (context.pages → tab list, but window info needs chrome.windows API)',
  ),
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
