import { type Tool } from '@modelcontextprotocol/sdk/types.js';

export const TOOL_NAMES = {
  BROWSER: {
    GET_WINDOWS_AND_TABS: 'get_windows_and_tabs',
    // Hidden from TOOL_SCHEMAS (schema-size reduction, v1.10.1) — still dispatch-registered
    // and fully implemented (vector-search.ts). See docs/TOOLS.md "Hidden Tools".
    SEARCH_TABS_CONTENT: 'search_tabs_content',
    NAVIGATE: 'chrome_navigate',
    SCREENSHOT: 'chrome_screenshot',
    CLOSE_TABS: 'chrome_close_tabs',
    SWITCH_TAB: 'chrome_switch_tab',
    WEB_FETCHER: 'chrome_get_web_content',
    CLICK: 'chrome_click_element',
    FILL: 'chrome_fill_or_select',
    REQUEST_ELEMENT_SELECTION: 'chrome_request_element_selection',
    // Deprecated, hidden from TOOL_SCHEMAS — chrome_read_page replaces it as the primary
    // discovery tool (and falls back to this logic internally when needed). Kept only for
    // backward compatibility. See docs/TOOLS.md "Hidden Tools".
    GET_INTERACTIVE_ELEMENTS: 'chrome_get_interactive_elements',
    NETWORK_CAPTURE: 'chrome_network_capture',
    // Legacy tool names (kept for internal use, not exposed in TOOL_SCHEMAS)
    NETWORK_CAPTURE_START: 'chrome_network_capture_start',
    NETWORK_CAPTURE_STOP: 'chrome_network_capture_stop',
    NETWORK_REQUEST: 'chrome_network_request',
    NETWORK_DEBUGGER_START: 'chrome_network_debugger_start',
    NETWORK_DEBUGGER_STOP: 'chrome_network_debugger_stop',
    KEYBOARD: 'chrome_keyboard',
    HISTORY: 'chrome_history',
    BOOKMARK_SEARCH: 'chrome_bookmark_search',
    BOOKMARK_ADD: 'chrome_bookmark_add',
    BOOKMARK_DELETE: 'chrome_bookmark_delete',
    // Hidden from TOOL_SCHEMAS (schema-size reduction, v1.10.1) — still dispatch-registered
    // and fully implemented (inject-script.ts); also used internally by the record-replay
    // engine. See docs/TOOLS.md "Hidden Tools".
    INJECT_SCRIPT: 'chrome_inject_script',
    SEND_COMMAND_TO_INJECT_SCRIPT: 'chrome_send_command_to_inject_script',
    JAVASCRIPT: 'chrome_javascript',
    CONSOLE: 'chrome_console',
    FILE_UPLOAD: 'chrome_upload_file',
    READ_PAGE: 'chrome_read_page',
    COMPUTER: 'chrome_computer',
    HANDLE_DIALOG: 'chrome_handle_dialog',
    HANDLE_DOWNLOAD: 'chrome_handle_download',
    REQUEST_USER_CONSENT: 'chrome_request_user_consent',
    // Hidden from TOOL_SCHEMAS (schema-size reduction, v1.10.1) — still dispatch-registered
    // and fully implemented (userscript.ts). See docs/TOOLS.md "Hidden Tools".
    USERSCRIPT: 'chrome_userscript',
    PERFORMANCE_START_TRACE: 'performance_start_trace',
    PERFORMANCE_STOP_TRACE: 'performance_stop_trace',
    PERFORMANCE_ANALYZE_INSIGHT: 'performance_analyze_insight',
    GIF_RECORDER: 'chrome_gif_recorder',
    BATCH: 'chrome_batch',
    SET_WORK_TAB: 'chrome_set_work_tab',
    WAIT_FOR: 'chrome_wait_for',
    SCROLL_COLLECT: 'chrome_scroll_collect',
    // auto-chrome-mcp fork(B1~B4)
    STORAGE: 'chrome_storage',
    SAVE_PDF: 'chrome_save_pdf',
    EMULATE: 'chrome_emulate',
    NETWORK_RULES: 'chrome_network_rules',
    EXTRACT: 'chrome_extract',
    FIND: 'chrome_find',
    SHORTCUT: 'chrome_shortcut',
    // stdio 프록시 전용 (extension 으로 forward 되지 않음 — mcp-server-stdio.ts 가 가로챔)
    LIST_BROWSERS: 'chrome_list_browsers',
    USE_BROWSER: 'chrome_use_browser',
  },
  RECORD_REPLAY: {
    FLOW_RUN: 'record_replay_flow_run',
    LIST_PUBLISHED: 'record_replay_list_published',
  },
};

/**
 * 공통 파라미터 설명 상수 — 같은 의미의 파라미터를 여러 도구가 반복해서 쓰므로 한 곳에 모아
 * 짧게 재사용한다(토큰 절감 + 표현 일관성). 의미가 다른 파라미터는 여기 넣지 않고 각 도구에서 따로 쓴다.
 *
 * tabId: 이번 세션의 background 게이트상 tabId 를 생략하면 세션 작업 탭에 주입되고, 작업 탭이 없으면
 * no_work_tab 오류가 난다. 그래서 "생략 = 세션 작업 탭"으로 설명을 통일한다.
 */
const P_TAB_ID = 'Tab id; omit to use the session work tab.';
const P_WINDOW_ID = 'Window to pick the active tab from when tabId is omitted.';
const P_FRAME_ID = 'Target frame id (iframe).';
const P_SELECTOR_TYPE = 'Selector type (default "css").';
const P_WAIT_FOR_ELEMENT_MS =
  'Ms to wait for the element to appear/become visible before failing (default 2000; 0 = fail now).';
const P_BACKGROUND = 'Do not activate the tab or focus the window (default false).';

/**
 * chrome_batch / chrome_shortcut 값 전달 (설계 docs/plans/2026-09-04-batch-flow-design.md).
 * 설명이 길어지면 모든 호출의 토큰이 늘어나므로 예시는 한 줄씩만 둔다.
 */
const P_STEP_AS = 'Name this step result so later steps can read it.';
const P_TEMPLATES =
  'Enable {{name.path}} substitution in step args, e.g. ref: "{{hit.matches[0].ref}}". Auto on when any step has "as".';
const P_RETURN = 'Names to include in the response "results" object.';
const P_WHEN =
  'Run only if this condition holds, e.g. { path: "hit.matches", op: "notEmpty" }. Otherwise the step is skipped.';
const P_STOP_IF = 'Stop the whole run after this step when the condition holds.';
const P_REPEAT =
  'Repeat group: { max: 1-20, until?: condition, delayMs?: 0-5000 } together with a "steps" array.';
const P_GROUP_STEPS = 'Steps of a repeat group (no repeat inside a repeat).';
const P_PARAMS =
  'save: declare { user: { required: true }, pw: { secret: true } }. run: values for {{params.user}}.';

const tabIdProp = { type: 'number' as const, description: P_TAB_ID };
const windowIdProp = { type: 'number' as const, description: P_WINDOW_ID };
const frameIdProp = { type: 'number' as const, description: P_FRAME_ID };
const selectorTypeProp = {
  type: 'string' as const,
  enum: ['css', 'xpath'],
  description: P_SELECTOR_TYPE,
};
const waitForElementMsProp = { type: 'number' as const, description: P_WAIT_FOR_ELEMENT_MS };
const backgroundProp = { type: 'boolean' as const, description: P_BACKGROUND };

export const TOOL_SCHEMAS: Tool[] = [
  {
    name: TOOL_NAMES.BROWSER.BATCH,
    description:
      'Run several browser steps in ONE call (fewer round-trips for chains like click -> fill -> screenshot). Steps target the session work tab. Cannot nest chrome_batch or interactive tools (switch_tab, element selection, consent). Stops on first error unless continueOnError. Returns per-step JSON.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description:
            'Steps in order (max 20). Each: { tool: string, args?: object }, or a repeat group { repeat: {...}, steps: [...] }',
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string', description: 'Tool name, e.g. chrome_click_element' },
              args: { type: 'object', description: 'Arguments for the tool' },
              as: { type: 'string', description: P_STEP_AS },
              when: { type: 'object', description: P_WHEN },
              stopIf: { type: 'object', description: P_STOP_IF },
              repeat: { type: 'object', description: P_REPEAT },
              steps: { type: 'array', description: P_GROUP_STEPS },
            },
          },
        },
        continueOnError: {
          type: 'boolean',
          description: 'Keep running after a step fails (default false)',
        },
        templates: { type: 'boolean', description: P_TEMPLATES },
        return: {
          type: 'array',
          items: { type: 'string' },
          description: P_RETURN,
        },
      },
      required: ['steps'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.FIND,
    description:
      'Find elements by natural-language query (Korean/English, e.g. "로그인 버튼", "search input"). Returns ranked candidates with ref (usable in chrome_click_element / chrome_fill_or_select), role, name, coordinates, frameId. Cheaper than reading the whole page when you know the target.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language description of the element (Korean/English)',
        },
        tabId: tabIdProp,
        maxResults: { type: 'number', description: 'Max candidates (default 5, max 20)' },
        allFrames: {
          type: 'boolean',
          description: 'Also search inside iframes (default true)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SHORTCUT,
    description:
      'Save and run named macros (a chrome_batch step list stored under a name). action: save {name, steps, description} | run (through the normal pipeline) | list | delete. Use for flows you repeat across sessions (logins, routine collection).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['save', 'run', 'list', 'delete'],
          description: 'What to do',
        },
        name: { type: 'string', description: 'Shortcut name (save/run/delete)' },
        steps: {
          type: 'array',
          description:
            'action="save": chrome_batch steps, max 20. Each: { tool: string, args?: object }, or a repeat group',
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string' },
              args: { type: 'object' },
              as: { type: 'string', description: P_STEP_AS },
              when: { type: 'object', description: P_WHEN },
              stopIf: { type: 'object', description: P_STOP_IF },
              repeat: { type: 'object', description: P_REPEAT },
              steps: { type: 'array', description: P_GROUP_STEPS },
            },
          },
        },
        description: { type: 'string', description: 'action="save": what this shortcut does' },
        continueOnError: {
          type: 'boolean',
          description: 'action="run": keep running after a failure (default false)',
        },
        templates: { type: 'boolean', description: P_TEMPLATES },
        return: {
          type: 'array',
          items: { type: 'string' },
          description: P_RETURN,
        },
        params: { type: 'object', description: P_PARAMS },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.EXTRACT,
    description:
      'Extract ONLY the fields you need via CSS selectors, far cheaper than reading the whole page (e.g. price, title, links). Prefer over chrome_get_web_content / chrome_read_page for targeted scraping.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: tabIdProp,
        fields: {
          type: 'object',
          description:
            'Map of fieldName -> CSS selector (string) or { selector, attr?, all? }. Default = trimmed innerText of first match; attr returns that attribute (href/src become absolute URLs); all:true returns an array over every match (max 100, 2000 chars each). Max 20 fields.',
        },
        frameId: frameIdProp,
      },
      required: ['fields'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.WAIT_FOR,
    description:
      'Wait until the page is ready before acting, avoiding "acted too early" failures after navigation/clicks/AJAX. Conditions (AND-combined, at least one required): selector state, text appears, document ready, or network idle. A timeout returns success:false with the observed state (not an error).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: tabIdProp,
        selector: { type: 'string', description: 'CSS selector to wait for' },
        state: {
          type: 'string',
          enum: ['visible', 'attached', 'hidden'],
          description: "Selector condition (default 'visible'). 'hidden' = absent or not visible.",
        },
        text: { type: 'string', description: 'Wait until this text appears in the page body' },
        documentReady: {
          type: 'boolean',
          description: "Wait for document.readyState === 'complete'",
        },
        networkIdleMs: {
          type: 'number',
          description: 'Wait until no in-flight requests for this many ms (e.g. 500)',
        },
        timeoutMs: { type: 'number', description: 'Max wait (default 15000, max 60000)' },
        pollMs: { type: 'number', description: 'Poll interval (default 250, min 100)' },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SCROLL_COLLECT,
    description:
      'Collect content from infinite-scroll / lazy-loaded pages in ONE call: repeatedly scrolls to the bottom (window or a container), waits for new content, returns accumulated text or links. Stops when the page stops growing, stopText appears, or maxScrolls/maxChars is reached.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: tabIdProp,
        maxScrolls: { type: 'number', description: 'Max scroll passes (default 10, max 30)' },
        delayMs: {
          type: 'number',
          description: 'Wait after each scroll for content to load (default 700, 200-3000)',
        },
        containerSelector: {
          type: 'string',
          description: 'Scroll this element instead of the window (e.g. a feed container)',
        },
        stopText: { type: 'string', description: 'Stop early when this text appears' },
        collect: {
          type: 'string',
          enum: ['text', 'links'],
          description: "What to return (default 'text'). 'links' = deduped [{text, href}]",
        },
        maxChars: { type: 'number', description: 'Output cap (default 100000, max 300000)' },
        renderMode: {
          type: 'string',
          enum: ['auto', 'force', 'off'],
          description:
            "Keep a background tab rendering so lazy loading fires (inactive tabs stop producing frames, so IntersectionObserver never triggers). 'auto' (default) = only when hidden, 'force' = always, 'off' = never. Uses CDP (shows a debug infobar).",
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SET_WORK_TAB,
    description:
      "Retarget this session's default work tab WITHOUT focusing anything (unlike chrome_switch_tab). Use when a result reports new_tabs_opened (a popup/new tab, e.g. OAuth) so later tabId-less calls target it; call again with the original tabId to return. No args = report current; clear:true = unset.",
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description:
            "Tab id to make this session's work tab. Omit to just query the current one.",
        },
        clear: {
          type: 'boolean',
          description: 'Unset the session work tab (default false)',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.GET_WINDOWS_AND_TABS,
    description:
      'Get all open windows and tabs. Marks MCP session work tabs (mcpWorkTabSessions), the dedicated MCP work window (isMcpWorkWindow), and tabs recently spawned by page actions like popups (recentlySpawned with openerTabId).',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: TOOL_NAMES.RECORD_REPLAY.FLOW_RUN,
    description:
      'Run a published record-replay flow (recorded in the extension side panel) on this session work tab. Requires a work tab: call chrome_navigate first, otherwise the call is refused with no_work_tab. Cannot be nested inside chrome_batch. Returns a summary: success, step counts, first failed step, flow outputs.',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: {
          type: 'string',
          description: 'Flow id, from record_replay_list_published.',
        },
        args: {
          type: 'object',
          description: 'Values for the flow variables, keyed by variable name.',
        },
        tabTarget: {
          type: 'string',
          enum: ['current', 'new'],
          description:
            "'current' (default) runs in the work tab. 'new' opens a background tab in the work tab window, runs there and leaves it open. Pass a specific tab as tabId, not here.",
        },
        startUrl: {
          type: 'string',
          description: 'Open this URL in the run tab before the first step.',
        },
        refresh: {
          type: 'boolean',
          description: 'Reload the run tab before the first step (default false).',
        },
        captureNetwork: {
          type: 'boolean',
          description: 'Record network requests during the run (default false).',
        },
        returnLogs: {
          type: 'boolean',
          description: 'Include the step log, capped at 4000 chars (default false).',
        },
        timeoutMs: {
          type: 'number',
          description: 'Abort the whole run after this many ms.',
        },
        tabId: tabIdProp,
      },
      required: ['flowId'],
    },
  },
  {
    name: TOOL_NAMES.RECORD_REPLAY.LIST_PUBLISHED,
    description:
      'List the published record-replay flows (id, slug, name, version, description) that record_replay_flow_run can run.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.PERFORMANCE_START_TRACE,
    description:
      'Start a performance trace on the selected page. Optionally reload and/or auto-stop after a short duration.',
    inputSchema: {
      type: 'object',
      properties: {
        reload: {
          type: 'boolean',
          description: 'Reload the page (ignoring cache) once tracing starts.',
        },
        autoStop: {
          type: 'boolean',
          description: 'Automatically stop the trace (default false).',
        },
        durationMs: {
          type: 'number',
          description: 'Auto-stop duration in ms when autoStop is true (default 5000).',
        },
        tabId: tabIdProp,
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.PERFORMANCE_STOP_TRACE,
    description: 'Stop the active performance trace on the selected page.',
    inputSchema: {
      type: 'object',
      properties: {
        saveToDownloads: {
          type: 'boolean',
          description:
            'Save the trace as a JSON file under Downloads/mcp-screenshots/<date>/ (default true).',
        },
        filenamePrefix: {
          type: 'string',
          description: 'Optional name to put in the saved trace filename.',
        },
        tabId: tabIdProp,
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.PERFORMANCE_ANALYZE_INSIGHT,
    description:
      'Lightweight summary of the last recorded trace. Deep insights (CWV, breakdowns) need the native DevTools trace engine.',
    inputSchema: {
      type: 'object',
      properties: {
        insightName: {
          type: 'string',
          description: 'Insight name for future deep analysis (e.g. "DocumentLatency").',
        },
        timeoutMs: {
          type: 'number',
          description: 'Native-host deep-analysis timeout in ms (default 60000).',
        },
        tabId: tabIdProp,
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.READ_PAGE,
    description:
      'Accessibility-tree view of the elements visible in the viewport; optional interactive-only filter. Prefer over a screenshot for locating/acting on elements; use chrome_extract for known fields, chrome_find for a natural-language lookup.\n' +
      'Compact format (default, lossless): 1 space indent per tree level; the bare token ref_N is the element ref (pass as refId, or as ref to click/fill/computer); @x,y is the element center; empty wrappers collapsed. compact:false for verbose. With allFrames, sections read "=== frame <frameId> | <url> ===" and refs inside are frame-local (pass that frameId).\n' +
      'If an element is missing, screenshot (chrome_computer action="screenshot") for its coordinates. markedElements are user-marked with highest priority.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description:
            '"interactive" for buttons/links/inputs only (default: all visible elements)',
        },
        depth: {
          type: 'number',
          description: 'Max DOM depth to traverse (integer >= 0). Lower = smaller output.',
        },
        refId: {
          type: 'string',
          description:
            'Focus on the subtree at this refId (e.g. "ref_12"), from a recent read of the same tab (refs may expire).',
        },
        tabId: {
          type: 'number',
          description: 'Target an existing tab by ID (default: active tab).',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab when tabId is omitted.',
        },
        allFrames: {
          type: 'boolean',
          description: 'Also collect from iframes (merged, annotated with frameId). Default: false',
        },
        diff: {
          type: 'boolean',
          description:
            'When true (default), returns {unchanged:true} if the page is identical to your last read; false forces re-send.',
        },
        compact: {
          type: 'boolean',
          description: 'Lossless compaction (~30-50% smaller). Default: true; false for verbose.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.COMPUTER,
    description:
      'Mouse/keyboard interaction and screenshots. Before clicking (especially an icon), get its ref from chrome_read_page. If a click misses, screenshot and aim the cursor tip at the target center.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID (default: active tab)' },
        background: {
          type: 'boolean',
          description: 'Avoid focusing/activating the tab or window where possible. Default: false',
        },
        fullResolution: {
          type: 'boolean',
          description: 'screenshot/zoom: skip the <=1568px downscale (default false)',
        },
        action: {
          type: 'string',
          description:
            'Action: left_click|right_click|double_click|triple_click|left_click_drag|scroll|scroll_to|type|key|fill|fill_form|hover|wait|resize_page|zoom|screenshot',
        },
        ref: {
          type: 'string',
          description:
            'Element ref from chrome_read_page (click/scroll/key/type, drag end); beats coordinates.',
        },
        coordinates: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
          description:
            'Screenshot-space if a recent screenshot exists, else viewport. Required for click/scroll and the drag end.',
        },
        startCoordinates: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
          description: 'Starting coordinates for drag.',
        },
        startRef: {
          type: 'string',
          description: 'Drag start ref (alternative to startCoordinates).',
        },
        scrollDirection: {
          type: 'string',
          description: 'Scroll direction: up|down|left|right',
        },
        scrollAmount: {
          type: 'number',
          description: 'Scroll ticks (1-10), default 3',
        },
        text: {
          type: 'string',
          description:
            'Text to type (action=type), or space-separated keys/chords (action=key, e.g. "Backspace Enter", "cmd+a")',
        },
        repeat: {
          type: 'number',
          description: 'action=key: repeat (1-100, default 1).',
        },
        modifiers: {
          type: 'object',
          description: 'Modifier keys for clicks.',
          properties: {
            altKey: { type: 'boolean' },
            ctrlKey: { type: 'boolean' },
            metaKey: { type: 'boolean' },
            shiftKey: { type: 'boolean' },
          },
        },
        region: {
          type: 'object',
          description:
            'action=zoom: region (x0,y0)-(x1,y1) in viewport px (or screenshot-space if a recent screenshot exists).',
          properties: {
            x0: { type: 'number' },
            y0: { type: 'number' },
            x1: { type: 'number' },
            y1: { type: 'number' },
          },
          required: ['x0', 'y0', 'x1', 'y1'],
        },
        // For action=fill
        selector: {
          type: 'string',
          description: 'CSS selector for fill (alternative to ref).',
        },
        value: {
          oneOf: [{ type: 'string' }, { type: 'boolean' }, { type: 'number' }],
          description: 'Value for action=fill (string|boolean|number)',
        },
        elements: {
          type: 'array',
          description: 'action=fill_form: elements to fill (ref + value)',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string', description: 'Element ref from chrome_read_page' },
              value: { type: 'string', description: 'Value to set (stringified if non-string).' },
            },
            required: ['ref', 'value'],
          },
        },
        width: { type: 'number', description: 'action=resize_page: viewport width' },
        height: { type: 'number', description: 'action=resize_page: viewport height' },
        appear: {
          type: 'boolean',
          description: 'action=wait+text: appear (true, default) or disappear (false)',
        },
        timeout: {
          type: 'number',
          description: 'action=wait+text: timeout in ms (default 10000, max 120000)',
        },
        duration: {
          type: 'number',
          description: 'Seconds to wait for action=wait (max 30s)',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NAVIGATE,
    description: 'Navigate to a URL, refresh the current tab, or go back/forward in history',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'URL to navigate to. Special values "back"/"forward" navigate history in the target tab.',
        },
        newWindow: {
          type: 'boolean',
          description: 'Create a new window for the URL (default false).',
        },
        waitUntil: {
          type: 'string',
          enum: ['none', 'domcontentloaded', 'load', 'networkidle'],
          description:
            'How far to wait before returning. Default "domcontentloaded" (avoids reading an empty page); "networkidle" for data-heavy SPAs, "none" to return immediately. The observed load state is reported back (a timeout is reported, not an error).',
        },
        waitTimeoutMs: {
          type: 'number',
          description: 'Max wait for waitUntil (default 15000, max 60000).',
        },
        tabId: {
          type: 'number',
          description: 'Navigate/refresh/back/forward this existing tab instead of the active tab.',
        },
        windowId: {
          type: 'number',
          description:
            'Existing window for a new tab, or to pick the active tab when tabId is omitted.',
        },
        background: backgroundProp,
        newTab: {
          type: 'boolean',
          description:
            'Force a brand-new tab. By default the session works in ONE tab: an existing MCP work tab is navigated instead of piling up tabs. Tabs set via chrome_set_work_tab are never reused this way.',
        },
        width: {
          type: 'number',
          description:
            'Window width px (default 1280). Providing width or height creates a new window.',
        },
        height: {
          type: 'number',
          description:
            'Window height px (default 720). Providing width or height creates a new window.',
        },
        refresh: {
          type: 'boolean',
          description: 'Refresh the active tab instead of navigating (url ignored). Default false.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SCREENSHOT,
    description:
      '[Prefer chrome_read_page, or chrome_computer action="screenshot"] Take a screenshot of the page or an element. Use this tool only when you need its advanced options.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name for the screenshot, if saving as PNG' },
        selector: { type: 'string', description: 'CSS selector for element to screenshot' },
        tabId: {
          type: 'number',
          description: 'Target tab ID to capture from (default: active tab).',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab when tabId is not provided.',
        },
        background: {
          type: 'boolean',
          description:
            'Capture without bringing the tab/window to the foreground. For element/full-page capture the tab may still be activated in its window without focusing it. Default: false',
        },
        width: { type: 'number', description: 'Width in pixels (default: 800)' },
        height: { type: 'number', description: 'Height in pixels (default: 600)' },
        storeBase64: {
          type: 'boolean',
          description:
            'Return the image as an MCP image content block (default: false). Auto-downscaled to <=1568px long edge (metadata reports imageScale); pass fullResolution:true to skip.',
        },
        fullResolution: {
          type: 'boolean',
          description: 'Skip the <=1568px downscale for the returned image (default: false)',
        },
        fullPage: {
          type: 'boolean',
          description: 'Store screenshot of the entire page (default: true)',
        },
        savePng: {
          type: 'boolean',
          description:
            'Save as a PNG file (default: true). To see the page, set false and storeBase64 true.',
        },
        saveToDownloads: {
          type: 'boolean',
          description: 'Also auto-save to Downloads/mcp-screenshots/<date>/ (default: false)',
        },
        filename: {
          type: 'string',
          description:
            'Name for saveToDownloads (sanitized; always kept under mcp-screenshots/<date>/).',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CLOSE_TABS,
    description: 'Close one or more browser tabs',
    inputSchema: {
      type: 'object',
      properties: {
        tabIds: {
          type: 'array',
          items: { type: 'number' },
          description: 'Tab IDs to close. If not provided, closes the active tab.',
        },
        url: {
          type: 'string',
          description: 'Close tabs matching this URL. Can be used instead of tabIds.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SWITCH_TAB,
    description:
      'Bring a tab to the front (activates it and can take OS focus). Use ONLY when the user explicitly asked to switch/show a tab. To retarget automation without disturbing the user, use chrome_set_work_tab; this tool is exempt from the no-interference gate, so it changes what the user sees.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'The ID of the tab to switch to.',
        },
        windowId: {
          type: 'number',
          description: 'The ID of the window where the tab is located.',
        },
      },
      required: ['tabId'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.WEB_FETCHER,
    description:
      'Read a page as text (reader view by default: nav/footer/cookie-banner noise stripped) or cleaned HTML. Repeat reads of an unchanged tab return {unchanged:true}; both modes are length-capped (report fullTextChars/fullHtmlChars vs returnedChars). For known fields prefer chrome_extract; for clicking/typing prefer chrome_read_page (returns refs); use this for the page content itself.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to fetch. If not provided, uses the current active tab',
        },
        tabId: {
          type: 'number',
          description: 'Target an existing tab by ID (default: active tab).',
        },
        background: backgroundProp,
        htmlContent: {
          type: 'boolean',
          description:
            'Return cleaned HTML (scripts/styles/SVG stripped) instead of text. Much more expensive; use only for markup/attributes and pair with selector. If true, textContent is ignored (default: false)',
        },
        textContent: {
          type: 'boolean',
          description: 'Visible text with metadata. Ignored if htmlContent is true (default true)',
        },

        selector: {
          type: 'string',
          description: 'CSS selector to return content from a specific element only.',
        },
        maxChars: {
          type: 'number',
          description:
            'Cap on returned HTML length (default 100000, htmlContent mode only); reports truncated:true when cut.',
        },
        raw: {
          type: 'boolean',
          description:
            'Text mode: reader-view by default (noise stripped); true = unfiltered full text. Default false',
        },
        diff: {
          type: 'boolean',
          description:
            'When true (default), returns {unchanged:true} if identical to your last read (text/HTML tracked separately); false forces re-send.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NETWORK_REQUEST,
    description: 'Send a network request from the browser with cookies and other browser context',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to send the request to',
        },
        method: {
          type: 'string',
          description: 'HTTP method to use (default: GET)',
        },
        headers: {
          type: 'object',
          description: 'Headers to include in the request',
        },
        body: {
          type: 'string',
          description: 'Body of the request (for POST, PUT, etc.)',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 30000)',
        },
        formData: {
          type: 'object',
          description:
            'Multipart/form-data descriptor. Overrides body and builds FormData with optional file attachments. Shape: { fields?: Record<string,string|number|boolean>, files?: Array<{ name, fileUrl?, filePath?, base64Data?, filename?, contentType? }> }. Also a compact array form: [ [name, fileSpec, filename?], ... ] where fileSpec is url:, file:, or base64:.',
        },
        tabId: {
          type: 'number',
          description:
            "Tab id whose browser context (cookies, origin) is used. Omit to use this session's work tab.",
        },
      },
      required: ['url'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NETWORK_CAPTURE,
    description:
      'Unified network capture. action="start" begins, action="stop" ends and returns results. needResponseBody=true captures response bodies (Debugger API, may conflict with DevTools); the default webRequest mode is lightweight but has no response body.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'stop'],
          description: '"start" begins capture, "stop" ends and returns results',
        },
        needResponseBody: {
          type: 'boolean',
          description: 'Capture response bodies via the Debugger API (default: false).',
        },
        url: {
          type: 'string',
          description:
            'action="start": URL to capture from. If omitted, uses the current active tab.',
        },
        maxCaptureTime: {
          type: 'number',
          description: 'Maximum capture time in ms (default: 180000)',
        },
        inactivityTimeout: {
          type: 'number',
          description: 'Stop after inactivity in ms (default: 60000). Set 0 to disable.',
        },
        includeStatic: {
          type: 'boolean',
          description: 'Include static resources like images/scripts/styles (default: false)',
        },
        tabId: tabIdProp,
        limit: {
          type: 'number',
          description: 'action="stop": max requests to return (default 100; paginate with offset)',
        },
        offset: {
          type: 'number',
          description: 'action="stop": skip this many captured requests (default 0)',
        },
        countOnly: {
          type: 'boolean',
          description: 'action="stop": counts/summary only, no request array (default false)',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.HANDLE_DOWNLOAD,
    description: 'Wait for a browser download and return details (id, filename, url, state, size)',
    inputSchema: {
      type: 'object',
      properties: {
        filenameContains: { type: 'string', description: 'Filter by substring in filename or URL' },
        timeoutMs: { type: 'number', description: 'Timeout in ms (default 60000, max 300000)' },
        waitForComplete: { type: 'boolean', description: 'Wait until completed (default true)' },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.HISTORY,
    description: 'Retrieve and search browsing history from Chrome',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            'Text to search in history URLs/titles. Empty = all entries in the time range.',
        },
        startTime: {
          type: 'string',
          description:
            'Start time: ISO, relative ("1 day ago"), or keyword ("now"/"today"/"yesterday"). Default: 24 hours ago',
        },
        endTime: {
          type: 'string',
          description:
            'End time: ISO, relative, or keyword ("now"/"today"/"yesterday"). Default: now',
        },
        maxResults: {
          type: 'number',
          description: 'Max history entries to return (default: 100)',
        },
        excludeCurrentTabs: {
          type: 'boolean',
          description: 'When true, exclude URLs currently open in any tab. Default false',
        },
        limit: {
          type: 'number',
          description: 'Return at most this many entries (default 100; pagination with offset)',
        },
        offset: {
          type: 'number',
          description: 'Skip this many entries before returning (default 0)',
        },
        countOnly: {
          type: 'boolean',
          description: 'Return only totalCount without the entries array (default: false)',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.BOOKMARK_SEARCH,
    description: 'Search Chrome bookmarks by title and URL',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Query matched against bookmark titles and URLs. Empty = all bookmarks.',
        },
        maxResults: {
          type: 'number',
          description: 'Max bookmarks to return (default: 50)',
        },
        folderPath: {
          type: 'string',
          description: 'Limit to a folder: a path string (e.g. "Work/Projects") or a folder ID.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.BOOKMARK_ADD,
    description: 'Add a new bookmark to Chrome',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to bookmark. If not provided, uses the current active tab URL.',
        },
        title: {
          type: 'string',
          description: 'Title. If not provided, uses the page title.',
        },
        parentId: {
          type: 'string',
          description:
            'Parent folder: path (e.g. "Work/Projects") or folder ID. Default: "Bookmarks Bar".',
        },
        createFolder: {
          type: 'boolean',
          description: 'Create the parent folder if missing (default: false)',
        },
        tabId: {
          type: 'number',
          description:
            "Tab id to bookmark when url is omitted. Omit to use this session's work tab.",
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.BOOKMARK_DELETE,
    description: 'Delete a bookmark from Chrome',
    inputSchema: {
      type: 'object',
      properties: {
        bookmarkId: {
          type: 'string',
          description: 'ID of the bookmark to delete. Either bookmarkId or url is required.',
        },
        url: {
          type: 'string',
          description: 'URL of the bookmark to delete. Used if bookmarkId is not provided.',
        },
        title: {
          type: 'string',
          description: 'Title to help match when deleting by URL.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.JAVASCRIPT,
    description:
      'Execute JavaScript in a tab and return the result. Uses CDP Runtime.evaluate (awaitPromise, returnByValue) and falls back to chrome.scripting.executeScript if the debugger is busy. Output is sanitized (sensitive data redacted) and truncated by default.',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'JavaScript to run (async function body; top-level await and "return ..." supported).',
        },
        tabId: {
          type: 'number',
          description: "Target tab id. Omit to use this session's work tab.",
        },
        timeoutMs: {
          type: 'number',
          description: 'Execution timeout in ms (default: 15000).',
        },
        maxOutputBytes: {
          type: 'number',
          description: 'Max output bytes after sanitization (default 51200); excess truncated.',
        },
      },
      required: ['code'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CLICK,
    description:
      'Click an element by CSS selector, XPath, element ref (from chrome_read_page), or viewport coordinates. More focused than chrome_computer for simple clicks; waits briefly (waitForElementMs). If blocked/covered, the result carries an "obstruction" object naming the overlay on top; read it instead of retrying.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector or XPath for the element to click.',
        },
        waitForElementMs: waitForElementMsProp,
        selectorType: selectorTypeProp,
        ref: {
          type: 'string',
          description: 'Element ref from chrome_read_page (takes precedence over selector).',
        },
        coordinates: {
          type: 'object',
          description: 'Viewport coordinates to click at.',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
          required: ['x', 'y'],
        },
        double: {
          type: 'boolean',
          description: 'Double click when true (default: false).',
        },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'Mouse button (default: "left").',
        },
        modifiers: {
          type: 'object',
          description: 'Modifier keys to hold during click.',
          properties: {
            altKey: { type: 'boolean' },
            ctrlKey: { type: 'boolean' },
            metaKey: { type: 'boolean' },
            shiftKey: { type: 'boolean' },
          },
        },
        waitForNavigation: {
          type: 'boolean',
          description: 'Wait for navigation after click (default: false).',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in ms for waiting (default: 5000).',
        },
        tabId: {
          type: 'number',
          description: "Target tab id. Omit to use this session's work tab.",
        },
        windowId: windowIdProp,
        frameId: frameIdProp,
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.FILL,
    description:
      'Fill or select a form element. Supports input, textarea, select, checkbox, radio, and contenteditable (editor prompt boxes like Google Flow, Gemini, ChatGPT, Notion). Target by CSS selector, XPath, or element ref.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector or XPath for the form element.',
        },
        waitForElementMs: waitForElementMsProp,
        selectorType: selectorTypeProp,
        ref: {
          type: 'string',
          description: 'Element ref from chrome_read_page (takes precedence over selector).',
        },
        value: {
          type: ['string', 'number', 'boolean'],
          description:
            'Value: string (text), boolean (checkbox/radio), or option value/text (select).',
        },
        tabId: {
          type: 'number',
          description: "Target tab id. Omit to use this session's work tab.",
        },
        windowId: windowIdProp,
        frameId: frameIdProp,
      },
      required: ['value'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.REQUEST_ELEMENT_SELECTION,
    description:
      'Ask the user to manually select elements on the page. A human-in-the-loop fallback when you cannot locate the target after ~3 attempts with chrome_read_page + click/fill/computer. Returns element refs for chrome_click_element/chrome_fill_or_select (including iframe frameId).',
    inputSchema: {
      type: 'object',
      properties: {
        requests: {
          type: 'array',
          description:
            'Selection requests; each yields one picked element the user clicks on the page.',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'Stable request id for correlation. Auto-generated if omitted.',
              },
              name: {
                type: 'string',
                description: 'Short label shown to the user (e.g. "Login button").',
              },
              description: {
                type: 'string',
                description: 'Optional longer instruction shown to the user.',
              },
            },
            required: ['name'],
          },
        },
        timeoutMs: {
          type: 'number',
          description: 'Timeout ms for the user to finish (default 180000, max 600000).',
        },
        tabId: {
          type: 'number',
          description: "Target tab id. Omit to use this session's work tab.",
        },
        windowId: windowIdProp,
      },
      required: ['requests'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.KEYBOARD,
    description:
      'Simulate keyboard input: single keys (Enter, Tab, Escape), combinations (Ctrl+C, Ctrl+V), and text. Can target a specific element or send to the focused element.',
    inputSchema: {
      type: 'object',
      properties: {
        keys: {
          type: 'string',
          description:
            'Keys or combinations, e.g. "Enter", "Tab", "Ctrl+C", "Shift+Tab", "Hello World".',
        },
        selector: {
          type: 'string',
          description: 'CSS selector or XPath for the element to receive keyboard events.',
        },
        selectorType: selectorTypeProp,
        delay: {
          type: 'number',
          description: 'Delay between keystrokes in ms (default: 50).',
        },
        tabId: {
          type: 'number',
          description: "Target tab id. Omit to use this session's work tab.",
        },
        windowId: windowIdProp,
        frameId: frameIdProp,
      },
      required: ['keys'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CONSOLE,
    description:
      'Capture console output from a tab. Snapshot mode (default) does a one-time capture with a ~2s wait; buffer mode keeps a persistent per-tab buffer you can read/clear instantly.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'URL to navigate to and capture from. If omitted, uses the current active tab',
        },
        tabId: {
          type: 'number',
          description: 'Target an existing tab by ID (default: active tab).',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab when tabId is omitted.',
        },
        background: {
          type: 'boolean',
          description: 'Do not activate tab/focus window when capturing via CDP. Default: false',
        },
        includeExceptions: {
          type: 'boolean',
          description: 'Include uncaught exceptions (default: true)',
        },
        maxMessages: {
          type: 'number',
          description: 'Max messages in snapshot mode (default: 100). limit takes precedence.',
        },
        offset: {
          type: 'number',
          description: 'Skip this many messages before returning (default 0)',
        },
        countOnly: {
          type: 'boolean',
          description: 'Return only counts/summary without the message array (default: false)',
        },
        mode: {
          type: 'string',
          enum: ['snapshot', 'buffer'],
          description:
            'snapshot (default; waits ~2s) or buffer (persistent per-tab buffer; instant).',
        },
        buffer: {
          type: 'boolean',
          description: 'Alias for mode="buffer" (default: false).',
        },
        clear: {
          type: 'boolean',
          description: 'Buffer mode: clear the buffered logs before reading (default: false).',
        },
        clearAfterRead: {
          type: 'boolean',
          description:
            'Buffer mode: clear the buffered logs AFTER reading (avoids duplicates). Default: false',
        },
        pattern: {
          type: 'string',
          description: 'Regex filter on message/exception text. Supports /pattern/flags.',
        },
        onlyErrors: {
          type: 'boolean',
          description:
            'Only error-level messages (plus exceptions if includeExceptions). Default: false.',
        },
        limit: {
          type: 'number',
          description:
            'Limit returned messages (snapshot: alias for maxMessages; buffer: from the buffer).',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.FILE_UPLOAD,
    description: 'Upload files to file-input form elements using Chrome DevTools Protocol',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID (default: active tab)' },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab when tabId is omitted',
        },
        selector: {
          type: 'string',
          description: 'CSS selector for the file input (input[type="file"])',
        },
        filePath: {
          type: 'string',
          description: 'Local file path to upload',
        },
        fileUrl: {
          type: 'string',
          description: 'URL to download the file from before uploading',
        },
        base64Data: {
          type: 'string',
          description: 'Base64 encoded file data to upload',
        },
        fileName: {
          type: 'string',
          description:
            'Filename for base64/URL (default "uploaded-file"). Name only; path separators or ".." rejected.',
        },
        multiple: {
          type: 'boolean',
          description: 'Whether the input accepts multiple files (default: false)',
        },
      },
      required: ['selector'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.HANDLE_DIALOG,
    description: 'Handle JavaScript dialogs (alert/confirm/prompt) via CDP',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'accept | dismiss' },
        promptText: {
          type: 'string',
          description: 'Optional prompt text when accepting a prompt',
        },
        tabId: tabIdProp,
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.REQUEST_USER_CONSENT,
    description:
      'Request user consent BEFORE using sensitive site features (camera, microphone, geolocation). Returns { approved, source }. If the matching popup toggle is ON, returns approved immediately and sticky-allows the current tab origin (chrome.contentSettings); if OFF, opens a consent popup and awaits the user (max 60s).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['camera', 'microphone', 'geolocation'],
          description: 'Which sensitive permission you intend to use.',
        },
        reason: {
          type: 'string',
          description:
            'Explanation shown to the user in the consent window (e.g. "녹화 시작을 위해 마이크에 접근합니다").',
        },
      },
      required: ['action', 'reason'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.GIF_RECORDER,
    description:
      'Record browser tab activity as an animated GIF. action="start" records at a fixed FPS (good for animations); action="auto_start" captures a frame whenever a chrome_computer or chrome_navigate action succeeds (better-paced interaction recordings). Use "stop" to end and save.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'stop', 'status', 'auto_start', 'capture', 'clear', 'export'],
          description:
            'start = fixed-FPS recording; auto_start = auto-capture (frames on tool actions); stop = end and save; status = current state; capture = manually grab a frame in auto mode; clear = drop state without saving; export = download or drag&drop-upload the last GIF.',
        },
        tabId: {
          type: 'number',
          description:
            'Target tab (default active tab). For start/auto_start, and export (download=false) drag&drop target.',
        },
        fps: {
          type: 'number',
          description: 'FPS for fixed-FPS mode (1-30, default: 5).',
        },
        durationMs: {
          type: 'number',
          description: 'Max duration in ms (default: 5000, max: 60000). Fixed-FPS only.',
        },
        maxFrames: {
          type: 'number',
          description: 'Max frames (default: 50 fixed-FPS, 100 auto; max: 300).',
        },
        width: {
          type: 'number',
          description: 'Output width in px (default: 800, max: 1920).',
        },
        height: {
          type: 'number',
          description: 'Output height in px (default: 600, max: 1080).',
        },
        maxColors: {
          type: 'number',
          description: 'Max palette colors (default: 256). Lower = smaller file.',
        },
        filename: {
          type: 'string',
          description: 'Output name (no extension). Saved under Downloads/mcp-screenshots/<date>/.',
        },
        captureDelayMs: {
          type: 'number',
          description: 'Auto mode: delay in ms after an action before capturing (default: 150).',
        },
        frameDelayCs: {
          type: 'number',
          description:
            'Auto mode: display duration per frame in centiseconds (default: 20 = 200ms).',
        },
        annotation: {
          type: 'string',
          description: 'Auto mode (action="capture"): optional text label on the frame.',
        },
        download: {
          type: 'boolean',
          description: 'Export only: true (default) to download, false to upload via drag&drop.',
        },
        coordinates: {
          type: 'object',
          description: 'Export (download=false): target coordinates for drag&drop.',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
          required: ['x', 'y'],
        },
        ref: {
          type: 'string',
          description: 'Export (download=false): element ref for the drag&drop target.',
        },
        selector: {
          type: 'string',
          description: 'Export (download=false): CSS selector for the drag&drop target.',
        },
        enhancedRendering: {
          type: 'object',
          description:
            'Auto mode: visual overlays for recorded actions. Pass `true` for all defaults, or an object. Each overlay group accepts true or an object with the listed props (all optional, sensible defaults).',
          properties: {
            clickIndicators: {
              oneOf: [
                { type: 'boolean' },
                {
                  type: 'object',
                  properties: {
                    enabled: { type: 'boolean' },
                    color: { type: 'string' },
                    radius: { type: 'number' },
                    animationDurationMs: { type: 'number' },
                    animationFrames: { type: 'number' },
                    animationIntervalMs: { type: 'number' },
                  },
                },
              ],
              description: 'Click indicator overlay.',
            },
            dragPaths: {
              oneOf: [
                { type: 'boolean' },
                {
                  type: 'object',
                  properties: {
                    enabled: { type: 'boolean' },
                    color: { type: 'string' },
                    lineWidth: { type: 'number' },
                    lineDash: { type: 'array', items: { type: 'number' } },
                    arrowSize: { type: 'number' },
                  },
                },
              ],
              description: 'Drag path overlay.',
            },
            labels: {
              oneOf: [
                { type: 'boolean' },
                {
                  type: 'object',
                  properties: {
                    enabled: { type: 'boolean' },
                    font: { type: 'string' },
                    textColor: { type: 'string' },
                    bgColor: { type: 'string' },
                    padding: { type: 'number' },
                    borderRadius: { type: 'number' },
                    offset: {
                      type: 'object',
                      properties: { x: { type: 'number' }, y: { type: 'number' } },
                    },
                  },
                },
              ],
              description: 'Action label overlay.',
            },
            durationMs: {
              type: 'number',
              description: 'How long overlays stay visible in ms (default: 1500).',
            },
          },
        },
      },
      required: ['action'],
    },
  },
  // ===== auto-chrome-mcp fork (B1~B4) =====
  {
    name: TOOL_NAMES.BROWSER.STORAGE,
    description:
      'Read or modify cookies, localStorage, or sessionStorage. Use it to save/restore a login session, test the logged-out state, pre-seed a consent cookie, or inspect front-end state. VALUES are masked by default (names/domains/expiry still returned); pass includeValues:true only when you need the secrets.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['cookies', 'local', 'session'],
          description: 'cookies, localStorage, or sessionStorage. Default "cookies".',
        },
        action: {
          type: 'string',
          enum: ['get', 'set', 'remove', 'clear'],
          description: 'Default "get". "clear" requires a scope (url or domain for cookies).',
        },
        url: {
          type: 'string',
          description:
            'Cookies: target URL. Required for set/remove. Defaults to the work tab URL.',
        },
        domain: { type: 'string', description: 'Cookies: filter/scope by domain (get, clear).' },
        name: { type: 'string', description: 'Cookie name.' },
        key: {
          type: 'string',
          description: 'localStorage/sessionStorage key (omit on get to list all).',
        },
        value: { type: 'string', description: 'Value to write (set).' },
        path: { type: 'string', description: 'Cookie path (set).' },
        secure: { type: 'boolean', description: 'Cookie Secure flag (set).' },
        httpOnly: { type: 'boolean', description: 'Cookie HttpOnly flag (set).' },
        sameSite: {
          type: 'string',
          enum: ['no_restriction', 'lax', 'strict'],
          description: 'Cookie SameSite (set).',
        },
        expirationDate: {
          type: 'number',
          description: 'Cookie expiry, unix seconds (set). Omit for a session cookie.',
        },
        includeValues: {
          type: 'boolean',
          description: 'Return real values instead of masks. Default false (usually auth tokens).',
        },
        tabId: { type: 'number', description: 'Target tab. Defaults to the session work tab.' },
        windowId: windowIdProp,
      },
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SAVE_PDF,
    description:
      'Save the page as a PDF into Downloads (via Page.printToPDF). Unlike a screenshot the text stays selectable and multi-page documents are captured in full; use it to archive notices, contracts, invoices, reports. The PDF bytes are NOT returned (too large); the result carries the saved filename.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab. Defaults to the session work tab.' },
        windowId: windowIdProp,
        filename: {
          type: 'string',
          description: 'File name (".pdf" added). Saved under Downloads/mcp-screenshots/<date>/.',
        },
        paperFormat: {
          type: 'string',
          enum: ['a4', 'a3', 'letter', 'legal'],
          description: 'Paper size (default a4).',
        },
        landscape: { type: 'boolean', description: 'Landscape orientation (default false).' },
        printBackground: {
          type: 'boolean',
          description: 'Include background colors/images (default true).',
        },
        scale: { type: 'number', description: 'Render scale 0.1-2 (default 1).' },
        pageRanges: {
          type: 'string',
          description: 'Pages to include, e.g. "1-3" or "2". Default all.',
        },
        displayHeaderFooter: {
          type: 'boolean',
          description: 'Print URL/page numbers in header and footer (default false).',
        },
        marginInches: {
          type: 'number',
          description: 'Margin on all sides in inches, 0-3 (default 0.4).',
        },
      },
    },
  },
  {
    name: TOOL_NAMES.BROWSER.EMULATE,
    description:
      'Emulate a device viewport (size, pixel density, touch, User-Agent) on a tab for responsive/mobile checking. The real window is never resized, so it works on background work tabs. Emulation persists until action="reset"; always reset when done (Chrome shows an automation notice on an emulated tab).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['set', 'reset', 'status'],
          description: 'Default "set". "status" also lists available device presets.',
        },
        device: {
          type: 'string',
          description:
            'Preset: iphone-se, iphone-15, pixel-8, galaxy-s23, ipad, desktop-1280, desktop-1080p.',
        },
        width: {
          type: 'number',
          description: 'Custom viewport width in CSS px (overrides preset).',
        },
        height: {
          type: 'number',
          description: 'Custom viewport height in CSS px (overrides preset).',
        },
        deviceScaleFactor: { type: 'number', description: 'Device pixel ratio, 0-5.' },
        mobile: {
          type: 'boolean',
          description: 'Emulate a mobile device (affects viewport meta handling).',
        },
        hasTouch: { type: 'boolean', description: 'Enable touch event emulation.' },
        userAgent: { type: 'string', description: 'Override the User-Agent string.' },
        tabId: { type: 'number', description: 'Target tab. Defaults to the session work tab.' },
        windowId: windowIdProp,
      },
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NETWORK_RULES,
    description:
      'Block network requests with declarativeNetRequest session rules. Blocking ads/trackers or heavy images speeds up pages and cuts boilerplate tokens. Rules are session-scoped (gone on Chrome restart) and can be limited to one tab. Note: some sites need tracker domains for login.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['block', 'unblock', 'list', 'clear'],
          description: 'Default "block". "list" shows active rules with ids, "clear" removes all.',
        },
        preset: {
          type: 'string',
          enum: ['ads', 'trackers', 'images', 'media', 'fonts'],
          description:
            'Rule set: ads/trackers block known domains; images/media/fonts block those resource types.',
        },
        patterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Custom urlFilter patterns, e.g. ["||doubleclick.net^", "/ads/"]. Max 100.',
        },
        tabId: {
          type: 'number',
          description: 'Apply only to this tab. Omit to apply to all tabs.',
        },
        ruleIds: {
          type: 'array',
          items: { type: 'number' },
          description: 'action="unblock": rule ids to remove (from action="list").',
        },
      },
    },
  },
];

/**
 * auto-chrome-mcp fork(P1): 병렬 작업 레인 인자를 탭 대상 도구 전부에 주입한다.
 *
 * 왜 필요한가 — 한 Claude Code 세션의 서브에이전트들은 **같은 stdio 프로세스**를 공유한다.
 * 확장 입장에선 전부 같은 세션으로 보여, 세션당 작업 탭이 하나뿐이면 병렬 에이전트들이 서로의
 * 작업 탭을 덮어쓰고 정리 로직이 형제 탭을 닫아 전원 실패한다. lane 을 주면 버킷이 갈라져 각자
 * 자기 작업 탭을 갖고, 한 레인의 탭은 다른 레인이 닫거나 재지정하지 않는다.
 *
 * 스키마마다 손으로 넣지 않고 여기서 한 번에 주입한다 — 도구가 늘어도 자동으로 따라온다.
 */
const LANE_EXEMPT_TOOLS = new Set<string>([
  TOOL_NAMES.BROWSER.GET_WINDOWS_AND_TABS,
  TOOL_NAMES.BROWSER.SEARCH_TABS_CONTENT,
  TOOL_NAMES.BROWSER.HISTORY,
  TOOL_NAMES.BROWSER.BOOKMARK_SEARCH,
  TOOL_NAMES.BROWSER.BOOKMARK_ADD,
  TOOL_NAMES.BROWSER.BOOKMARK_DELETE,
  TOOL_NAMES.BROWSER.REQUEST_USER_CONSENT,
  // record_replay 두 도구는 여기 넣지 않는다. flow_run 은 레인별 작업 탭을 그대로 받아야
  // 하고(게이트의 TAB_ID_INJECT_TOOLS), list_published 도 같은 레인 인자를 달고 다니는 편이
  // 호출 형태가 일관된다.
]);

const LANE_DESCRIPTION_SHORT = 'Parallel-agent lane id (same value every call). Omit if solo.';

const LANE_DESCRIPTION_LONG =
  'Parallel lane id. Sub-agents of one Claude Code session share one MCP session, so without a lane ' +
  "they overwrite each other's work tab. Give each concurrent agent a distinct lane (same value " +
  'every call): a lane keeps its own work tab that no other lane closes or retargets.';

for (const tool of TOOL_SCHEMAS) {
  if (LANE_EXEMPT_TOOLS.has(tool.name)) continue;
  const schema = tool.inputSchema as { properties?: Record<string, unknown> };
  if (!schema || typeof schema !== 'object') continue;
  if (!schema.properties) schema.properties = {};
  if (schema.properties.lane !== undefined) continue;
  schema.properties.lane = {
    type: 'string',
    description:
      tool.name === TOOL_NAMES.BROWSER.NAVIGATE || tool.name === TOOL_NAMES.BROWSER.SET_WORK_TAB
        ? LANE_DESCRIPTION_LONG
        : LANE_DESCRIPTION_SHORT,
  };
}
