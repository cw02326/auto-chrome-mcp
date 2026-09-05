# Auto Chrome MCP API Reference 📚

Complete reference for all 43 tools and their parameters.

41 tools are served by the extension (the `TOOL_SCHEMAS` list); `chrome_list_browsers` and
`chrome_use_browser` are added by the stdio proxy, which answers them locally so they never
reach the browser.

> Parameters here mirror `packages/shared/src/tools.ts` (the schemas actually advertised over
> MCP). If the two disagree, the schema wins — please fix this file.

## 📋 Table of Contents

- [Common Parameters](#-common-parameters)
- [Running agents in parallel](#-running-agents-in-parallel)
- [Browser Management](#-browser-management)
- [Screenshots & Visual](#-screenshots--visual)
- [Network Monitoring](#-network-monitoring)
- [Performance](#-performance)
- [Content Analysis](#-content-analysis)
- [Interaction](#-interaction)
- [Automation](#-automation)
- [Data Management](#-data-management)
- [Browser State & Output](#️-browser-state--output)
- [Hidden Tools (Internal Only)](#️-hidden-tools-internal-only)
- [Response Format](#-response-format)
- [Usage Examples](#-usage-examples)

## 🧩 Common Parameters

Most tools take the same targeting parameters; they are not repeated in every entry below.

- `tabId` (number, optional): tab to act on. **Defaults to this session's work tab** (background
  work mode), falling back to the active tab. Tools that create the target (`chrome_navigate`)
  or address a window instead say so in their own entry.
- `windowId` (number, optional): pick the active tab of this window when `tabId` is omitted.
- `frameId` (number, optional): target an iframe. Refs from `chrome_read_page` / `chrome_find`
  carry the frame they came from, so you rarely need this by hand.
- `selectorType` (string, optional, default `css`): `css` | `xpath` — for tools that accept a
  `selector` (`chrome_click_element`, `chrome_fill_or_select`, `chrome_keyboard`).
- `background` (boolean, optional, **default `true`**): do not activate the tab or focus its
  window. Background work mode (on by default) injects `background: true` whenever you omit it,
  so the session keeps working out of sight. Leave it alone unless you deliberately want focus —
  and note that even `background: false` will not activate a tab in one of _your_ windows: tab
  activation only ever happens inside the dedicated MCP work window.
- `lane` (string, optional): parallel work lane. Sub-agents of one Claude Code session share
  a single MCP session, so without a lane they share one work tab. Give each concurrent
  agent its own lane and pass it on **every** call — see below.

## 🛤️ Running agents in parallel

One Claude Code session runs **one** MCP stdio process, and every sub-agent you spawn talks
through it. The extension therefore sees a single session — so by default all your agents share
one work tab, and each `chrome_navigate` retargets it out from under the others.

Pass a distinct `lane` on every call to get isolation:

```jsonc
// agent 1                                  // agent 2
chrome_navigate { url: "...", lane: "a" }   chrome_navigate { url: "...", lane: "b" }
chrome_read_page { lane: "a" }              chrome_click_element { ref: "e12", lane: "b" }
```

What a lane buys you:

- its **own work tab** — `chrome_navigate` without `tabId` opens/reuses that lane's tab, and no
  other lane can retarget it via `chrome_set_work_tab`
- **protection from cleanup** — a lane's current work tab is never closed by another lane's
  tab housekeeping
- **its own runaway-loop counter** — four agents doing the same thing no longer look like one
  agent stuck in a loop (`automation guard`)

Rules of thumb:

- pick a stable string per agent (`"agent-1"`, `"research"`, …) and use it for the whole task;
  changing lane mid-task means starting over with a fresh work tab
- `chrome_batch` / `chrome_shortcut` pass their `lane` down to every step automatically
- running one agent at a time? Omit `lane` entirely — nothing changes
- without a lane, parallel agents still survive (tab cleanup keeps recently-used tabs), but they
  share one work tab, so **every call must carry an explicit `tabId`**

### Tab housekeeping

MCP-created tabs are cleaned up when a new work tab opens in the same lane. A tab is **never**
closed while it is: the lane's current work tab, executing a tool call, the tab the user is
looking at, or newer than the 90-second idle grace. Beyond that, each lane keeps at most 8 spare
tabs, and any MCP tab untouched for 15 minutes is reclaimed. When a tool fails because its tab
vanished, the error carries a `target_tab_missing` note explaining why and what to do instead.

## 📊 Browser Management

### `get_windows_and_tabs`

List all currently open browser windows and tabs.

**Parameters**: None

**Response**:

```json
{
  "windowCount": 2,
  "tabCount": 5,
  "windows": [
    {
      "windowId": 123,
      "tabs": [
        {
          "tabId": 456,
          "url": "https://example.com",
          "title": "Example Page",
          "active": true
        }
      ]
    }
  ]
}
```

### `chrome_navigate`

Navigate to a URL with optional viewport control.

**Parameters**:

- `url` (string, optional): URL to navigate to (omit when `refresh=true`). Special values:
  `"back"` / `"forward"` navigate that tab's history. `file://` targets require the extension's
  "Allow access to file URLs" toggle at `chrome://extensions` to be on, or the call returns a
  `file_scheme_access_disabled` error instead of attempting the navigation.
- `refresh` (boolean, optional, default `false`): reload instead of navigating (`url` ignored)
- `newWindow` (boolean, optional): Create new window (default: false)
- `newTab` (boolean, optional, default `false`): force a brand-new tab. By default this session
  keeps working in **one** tab: if it already has an MCP-created work tab, that tab is
  navigated instead of piling tabs up. A tab you assigned with `chrome_set_work_tab` is never
  reused this way.
- `tabId` (number, optional): Target an existing tab by ID (navigate/refresh that tab)
- `background` (boolean, optional): Do not activate the tab or focus the window (default: **true**,
  injected by background work mode)
- `width` (number, optional): **Viewport** width in pixels. **Changed in v1.9.0:** width/height no
  longer create a new window — they emulate that viewport size on the work tab (CDP
  `Emulation.setDeviceMetricsOverride`). Pass `newWindow: true` if you really want a window.
- `height` (number, optional): Viewport height in pixels (see `width`)
- `waitUntil` (string, optional, default `domcontentloaded`): how far to wait for the page to
  load before returning - `none` | `domcontentloaded` | `load` | `networkidle`. Prevents
  reading or clicking an empty page right after navigating. Use `networkidle` for data-heavy
  SPAs, `none` to return immediately.
- `waitTimeoutMs` (number, optional, default `15000`, max `60000`): cap for `waitUntil`
- `task` (string, optional, max 24 chars): label for the MCP tab group in the target tab's
  window, so a background tab says what it is doing. It stays until the next `task` or the
  end of the surrounding `chrome_batch` / `chrome_shortcut` run, and never activates a tab
  or focuses a window

The observed load state comes back in the result as a `load` object
(`{ waitUntil, reached, timedOut, waitedMs, readyState, networkInFlight }`). A timeout is
reported there rather than raised as an error, so the model can decide what to do. The
result's `url`/`title` are refreshed after waiting, so redirects are reflected.

**Example**:

```json
{
  "url": "https://example.com",
  "newWindow": true,
  "width": 1920,
  "height": 1080
}
```

### `chrome_close_tabs`

Close specific tabs or windows.

**Parameters**:

- `tabIds` (array, optional): Array of tab IDs to close
- `windowIds` (array, optional): Array of window IDs to close
- `url` (string, optional): close every tab matching this URL (instead of `tabIds`)

**Example**:

```json
{
  "tabIds": [123, 456],
  "windowIds": [789]
}
```

### `chrome_switch_tab`

Switch to a specific browser tab.

**Parameters**:

- `tabId` (number, required): The ID of the tab to switch to.
- `windowId` (number, optional): The ID of the window where the tab is located.

**Example**:

```json
{
  "tabId": 456,
  "windowId": 123
}
```

### `chrome_set_work_tab`

Retarget this session's default work tab **without activating or focusing anything** (unlike
`chrome_switch_tab`). Use it when a tool result reports `new_tabs_opened` — a popup or new tab
appeared (OAuth login, for example) — and you want later tool calls that omit `tabId` to go
there. Call it again with the original tab id to come back.

A tab you set here is _yours_: the session never reuses it for another URL and never closes it
as an idle work tab.

**Parameters**:

- `tabId` (number, optional): tab to make this session's work tab. Omit to just report the current one.
- `clear` (boolean, optional, default `false`): unset the session work tab

**Example**:

```json
{ "tabId": 456 }
```

### `chrome_list_browsers`

List the Chrome profiles available to this session and show which one is active. Each Chrome
profile runs its own bridge server on its own port — one port = one profile — and the port is
shown in that profile's extension popup.

Probes the candidate ports (the active one, anything in `CHROME_PORTS`, plus the defaults
12306 / 12315 / 12320 / 12325) with `GET /ping`. **Handled locally by the stdio proxy**: it
never reaches the browser and touches no tab.

**Parameters**: None

**Response**:

```json
{
  "success": true,
  "activePort": 12320,
  "browsers": [
    { "port": 12320, "alive": true, "version": "1.5.0", "url": "http://127.0.0.1:12320" },
    { "port": 12315, "alive": false }
  ]
}
```

### `chrome_use_browser`

Switch this session to a different Chrome profile by its bridge port — no restart needed.
Every later browser tool call targets the newly selected browser until you switch again.

The port is validated with `GET /ping` first: if no live bridge answers, nothing changes and
the error lists the ports that are alive. **Handled locally by the stdio proxy.**

**Parameters**:

- `port` (number, required): bridge port of the profile to switch to (e.g. `12315`)

**Example**:

```json
{ "port": 12315 }
```

## 📸 Screenshots & Visual

### `chrome_screenshot`

Take advanced screenshots with various options.

**Parameters**:

- `name` (string, optional): Screenshot filename
- `selector` (string, optional): CSS selector for element screenshot
- `tabId` (number, optional): Target tab to capture (default: active tab)
- `background` (boolean, optional): Attempt capture without bringing tab/window to foreground (viewport-only uses CDP)
- `width` (number, optional): Width in pixels (default: 800)
- `height` (number, optional): Height in pixels (default: 600)
- `storeBase64` (boolean, optional): Return base64 data (default: false)
- `fullPage` (boolean, optional): Capture full page (default: true)

- `savePng` (boolean, optional, default `true`): also save a PNG file. To _see_ the page, set
  `savePng: false` and `storeBase64: true`.
- `saveToDownloads` (boolean, optional, default `false`): auto-save the capture as a file
- `filename` (string, optional): name for `saveToDownloads` (path separators are stripped)

Saved files always land in `Downloads/mcp-screenshots/<YYYY-MM-DD>/screenshot_<name>_<HHmmss>.png`
(local date and time). See "산출물 저장 위치와 자동 정리" in the README for the retention settings.

- `fullResolution` (boolean, optional, default `false`): skip the ≤1568px downscale of the returned image
- `windowId` (number, optional)

**Example**:

```json
{
  "selector": ".main-content",
  "fullPage": true,
  "storeBase64": true,
  "width": 1920,
  "height": 1080
}
```

**Response**:

```json
{
  "success": true,
  "base64": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
  "dimensions": {
    "width": 1920,
    "height": 1080
  }
}
```

### `chrome_gif_recorder`

Record tab activity as an animated GIF.

Two modes:

- **Fixed FPS** (`action="start"`): frames at a regular interval — good for animations/video.
- **Auto-capture** (`action="auto_start"`): a frame whenever `chrome_computer` or
  `chrome_navigate` succeeds — better pacing for interaction recordings.

**Parameters**:

- `action` (string, required): `start` | `auto_start` | `capture` | `stop` | `status` | `clear` | `export`
- `tabId` (number, optional): target tab (default: active tab)
- `fps` (number, optional, default `5`, 1–30): fixed-FPS mode only
- `durationMs` (number, optional, default `5000`, max `60000`): fixed-FPS mode only
- `maxFrames` (number, optional): default 50 (fixed) / 100 (auto), max 300
- `width` / `height` (number, optional, default `800` / `600`)
- `maxColors` (number, optional, default `256`): lower = smaller file
- `filename` (string, optional): output name without extension. The file is written to
  `Downloads/mcp-screenshots/<YYYY-MM-DD>/gif_<name>_<HHmmss>.gif`
- `captureDelayMs` (number, optional, default `150`): auto mode — settle time before the frame
- `frameDelayCs` (number, optional, default `20`): auto mode — frame duration in centiseconds
- `annotation` (string, optional): auto mode with `action="capture"` — label drawn on the frame
- `download` (boolean, optional, default `true`): `export` — download, or `false` to drag&drop upload
- `coordinates` / `ref` / `selector` (optional): `export` with `download=false` — drop target
- `enhancedRendering` (object | `true`, optional): auto mode — click indicators, drag paths, labels

**Example**:

```json
{ "action": "auto_start", "maxFrames": 60 }
```

```json
{ "action": "stop", "filename": "login_process" }
```

## 🌐 Network Monitoring

### `chrome_network_capture`

Unified network capture. `action="start"` begins capturing, `action="stop"` ends it and
returns the collected requests.

By default it uses the webRequest API (lightweight, no debugger conflict, no response
bodies). Set `needResponseBody=true` to capture bodies via the Debugger API — that attaches
a debugger to the tab and can conflict with an open DevTools window.

> Replaces the old `chrome_network_capture_start` / `_stop` /
> `chrome_network_debugger_start` / `_stop` tools.

**Parameters**:

- `action` (string, required): `start` | `stop`
- `needResponseBody` (boolean, optional, default `false`): capture response bodies (Debugger API)
- `url` (string, optional): for `start` — navigate here and capture; defaults to the current tab
- `maxCaptureTime` (number, optional, default `180000`): maximum capture time in ms
- `inactivityTimeout` (number, optional, default `60000`): stop after this much silence; `0` disables
- `includeStatic` (boolean, optional, default `false`): include images/scripts/styles
- `tabId` (number, optional): target tab (defaults to the session work tab, else the active tab)
- `limit` (number, optional, default `100`): for `stop` — max requests to return
- `offset` (number, optional, default `0`): for `stop` — skip this many (pagination)
- `countOnly` (boolean, optional, default `false`): for `stop` — counts/summary only

**Example**:

```json
{ "action": "start", "includeStatic": false }
```

```json
{ "action": "stop", "limit": 50, "countOnly": false }
```

### `chrome_network_request`

Send custom HTTP requests.

**Parameters**:

- `url` (string, required): Request URL
- `method` (string, optional): HTTP method (default: "GET")
- `headers` (object, optional): Request headers
- `body` (string, optional): Request body
- `formData` (object, optional): multipart/form-data instead of `body` —
  `{ fields?, files?: [{ name, fileUrl | filePath | base64Data, filename?, contentType? }] }`
- `timeout` (number, optional, default `30000`): request timeout in ms
- `tabId` (number, optional): borrow this tab's browser context (cookies, origin)

**Example**:

```json
{
  "url": "https://api.example.com/data",
  "method": "POST",
  "headers": {
    "Content-Type": "application/json"
  },
  "body": "{\"key\": \"value\"}"
}
```

## ⚡ Performance

### `performance_start_trace`

Start a performance trace on the target page. Can reload the page first and stop by itself.

**Parameters**:

- `reload` (boolean, optional): reload (ignoring cache) once tracing starts
- `autoStop` (boolean, optional, default `false`): stop automatically after `durationMs`
- `durationMs` (number, optional, default `5000`): auto-stop duration
- `tabId` (number, optional): target tab (defaults to the session work tab, else the active tab)

**Example**:

```json
{ "reload": true, "autoStop": true, "durationMs": 8000 }
```

### `performance_stop_trace`

Stop the active trace.

**Parameters**:

- `saveToDownloads` (boolean, optional, default `true`): save the trace JSON to
  `Downloads/mcp-screenshots/<YYYY-MM-DD>/trace_<name>_<HHmmss>.json`
- `filenamePrefix` (string, optional): name to put in the saved filename
- `tabId` (number, optional): target tab

### `performance_analyze_insight`

Lightweight summary of the last recorded trace. (Deep insights such as Core Web Vitals need
the native-side DevTools trace engine.)

**Parameters**:

- `insightName` (string, optional): reserved for deeper analysis (e.g. `"DocumentLatency"`)
- `timeoutMs` (number, optional, default `60000`): raise it for large traces
- `tabId` (number, optional): target tab

## 🔍 Content Analysis

### `chrome_read_page`

Build an accessibility-like tree of the current page (visible viewport by default) with stable `ref_*` identifiers and viewport info. Useful for semantic element discovery or agent planning.

Parameters:

- `filter` (string, optional): `interactive` to only include interactive elements; default includes structural and labeled nodes.
- `depth` (number, optional): max DOM depth to traverse — lower is smaller and faster
- `refId` (string, optional): read only the subtree under this ref (e.g. `"ref_12"`); refs must
  come from a recent read of the same tab and can expire
- `allFrames` (boolean, optional, default `false`): also collect iframes, annotated with `frameId`
- `diff` (boolean, optional, default `true`): return `{unchanged:true}` instead of the full body
  when the page is identical to your previous read — pass `false` to force a full re-send
- `compact` (boolean, optional, default `true`): lossless compaction (~30–50% smaller output)
- `tabId` / `windowId` (number, optional)

Example:

```json
{
  "filter": "interactive"
}
```

Response contains `pageContent` (text tree), `viewport`, and a `refMapCount` summary. Pass the
returned `ref_*` values straight to `chrome_click_element` / `chrome_fill_or_select`, or use
`chrome_find` when you can describe the element instead of reading the whole page.

### `chrome_get_web_content`

Extract HTML or text content from web pages.

**Parameters**:

- `textContent` (boolean, optional, default `true`): visible text plus metadata
- `htmlContent` (boolean, optional, default `false`): visible HTML instead (wins over `textContent`)
- `raw` (boolean, optional, default `false`): text mode returns **reader view** by default —
  navigation, footers and cookie banners stripped, main content kept (`fullTextChars` vs
  `returnedChars` tell you how much was dropped). Pass `true` for the unfiltered page text.
- `diff` (boolean, optional, default `true`): return `{unchanged:true}` when the content is
  identical to your previous read of this tab — pass `false` to force a full re-send
- `selector` (string, optional): CSS selector for specific elements
- `url` (string, optional): fetch this URL instead of the current tab
- `tabId` (number, optional): Specific tab ID (default: the session work tab)
- `background` (boolean, optional): Do not activate tab/focus window while fetching (default: false)

**Example**:

```json
{
  "format": "text",
  "selector": ".article-content"
}
```

### `chrome_extract`

Extract **only the fields you need** via CSS selectors — far cheaper than reading the whole
page when you already know what you want (price, title, links). Deterministic and precise;
prefer it over `chrome_get_web_content` / `chrome_read_page` for targeted scraping.

**Parameters**:

- `fields` (object, required): map of `fieldName` → CSS selector, or `{ selector, attr?, all? }`
  - default value = trimmed `innerText` of the first match
  - `attr` returns that attribute (`href` / `src` resolve to absolute URLs)
  - `all: true` returns an array over every match
- `tabId` (number, optional): target tab (defaults to the session work tab, else the active tab)

**Example**:

```json
{
  "fields": {
    "title": "h1",
    "price": ".price",
    "links": { "selector": "a.item", "attr": "href", "all": true }
  }
}
```

### `chrome_find`

Find elements with natural language (Korean or English) — `"로그인 버튼"`, `"search input"`,
`"장바구니 아이콘"`. Scores the accessibility tree with synonym + fuzzy matching and returns
ranked candidates with a `ref` usable directly in `chrome_click_element` /
`chrome_fill_or_select`, plus role, name, coordinates and `frameId`.

Cheaper and more direct than reading the whole page when you know what you are after.

**Parameters**:

- `query` (string, required): natural-language description of the element
- `tabId` (number, optional): target tab
- `maxResults` (number, optional, default `5`, max `20`)
- `allFrames` (boolean, optional, default `true`): also search inside iframes

**Example**:

```json
{ "query": "로그인 버튼" }
```

### `chrome_scroll_collect`

Collect an infinite-scroll / lazy-loaded page in **one** call: scrolls to the bottom
repeatedly (the window or a container), waits for new content, and returns the accumulated
text or links. Stops when the page stops growing, `stopText` appears, or `maxScrolls` /
`maxChars` is hit.

**Background tabs**: Chrome stops producing frames in inactive tabs, so `requestAnimationFrame`
never runs and the `IntersectionObserver` behind infinite scroll never fires. `renderMode`
keeps the tab rendering by forcing frames over CDP — which is why the tab shows a "debugging"
infobar while collecting. The result reports what was actually applied in `renderAssist`
(`frame-pump` | `not-needed` | `off` | `unavailable`); when rendering could not be kept alive,
`stoppedReason` says `noGrowthWhileHidden` instead of falsely claiming `bottomReached`.

**Parameters**:

- `tabId` (number, optional): target tab
- `maxScrolls` (number, optional, default `10`, max `30`)
- `delayMs` (number, optional, default `700`, 200–3000): wait after each scroll
- `containerSelector` (string, optional): scroll this element instead of the window
- `stopText` (string, optional): stop early once this text appears
- `collect` (string, optional, default `text`): `text` | `links` (links are deduped `[{text, href}]`)
- `maxChars` (number, optional, default `100000`, max `300000`)
- `renderMode` (string, optional, default `auto`): `auto` (only when the tab is not visible) | `force` | `off`

**Example**:

```json
{ "maxScrolls": 20, "collect": "links", "stopText": "No more results" }
```

### `chrome_javascript`

Run JavaScript in a tab and return the result. Uses CDP `Runtime.evaluate` with
`awaitPromise` + `returnByValue`, falling back to `chrome.scripting.executeScript` when the
debugger is busy. Output is sanitized (secrets redacted) and truncated.

> The redaction works on structured return values. Dumping `document.body.innerText`
> wholesale bypasses it — avoid that on pages showing tokens or credentials.

**Parameters**:

- `code` (string, required): runs inside an async function body, so top-level `await` and `return` work
- `tabId` (number, optional): target tab (default: active tab)
- `timeoutMs` (number, optional, default `15000`)
- `maxOutputBytes` (number, optional, default `51200`): output cap after sanitization

**Example**:

```json
{ "code": "return { title: document.title, items: document.querySelectorAll('li').length };" }
```

### `chrome_console`

Capture console output from a tab.

- **snapshot** (default): one-time capture, waits ~2s for messages
- **buffer**: a persistent per-tab buffer you can read instantly and clear when you want

**Parameters**:

- `tabId` (number, optional) / `windowId` (number, optional) / `url` (string, optional): where to capture
- `background` (boolean, optional, default `false`): do not activate the tab while capturing
- `mode` (string, optional, default `snapshot`): `snapshot` | `buffer` (`buffer: true` is an alias)
- `clear` (boolean, optional): buffer mode — clear **before** reading
- `clearAfterRead` (boolean, optional): buffer mode — clear **after** reading (avoids duplicates)
- `pattern` (string, optional): regex filter over message text; `/pattern/flags` supported
- `onlyErrors` (boolean, optional, default `false`) / `includeExceptions` (boolean, optional, default `true`)
- `limit` / `maxMessages` (number, optional, default `100`) / `offset` (number, optional) / `countOnly` (boolean, optional)

**Example**:

```json
{ "mode": "buffer", "pattern": "\[MyApp\]", "clearAfterRead": true }
```

### `chrome_get_interactive_elements` (deprecated)

Replaced by `chrome_read_page` as the primary discovery tool. The `read_page` implementation will automatically fallback to the interactive-elements logic when the accessibility tree is unavailable or too sparse. This tool is no longer listed via ListTools and is kept only for backward compatibility.

## 🎯 Interaction

### `chrome_computer`

Unified advanced interaction tool that prioritizes high-level DOM actions with CDP fallback. Supports hover, click, drag, scroll, typing, key chords, fill, wait and screenshot. If a recent screenshot was taken via `chrome_screenshot`, coordinates are auto-scaled from screenshot space to viewport space.

Parameters:

- `action` (string, required): `left_click` | `right_click` | `double_click` | `triple_click` | `left_click_drag` | `scroll` | `type` | `key` | `fill` | `hover` | `wait` | `screenshot`
- `tabId` (number, optional): Target an existing tab by ID (default: active tab)
- `background` (boolean, optional): Avoid focusing/activating tab/window for certain operations (best-effort)
- `ref` (string, optional): element ref from `chrome_read_page` (preferred). Used for click/scroll/type/key and as drag end when provided
- `coordinates` (object, optional): `{ "x": 100, "y": 200 }` for click/scroll or drag end
- `startRef` (string, optional): element ref for drag start
- `startCoordinates` (object, optional): for `left_click_drag` when no `startRef`
- `scrollDirection` (string, optional): `up` | `down` | `left` | `right`
- `scrollAmount` (number, optional): ticks 1–10 (default 3)
- `text` (string, optional): for `type` (raw text) or `key` (space-separated chords/keys like `"cmd+a Enter"`)
- `duration` (number, optional): seconds for `wait` (max 30)
- `selector` (string, optional): for `fill` when no `ref`
- `value` (string, optional): for `fill` value
- `elements` (array, optional): for `fill_form` — `[{ ref, value }]` to fill several fields at once
- `modifiers` (object, optional): modifier keys held during click actions
- `repeat` (number, optional, default `1`, max `100`): repeat the `key` sequence
- `region` (object, optional): for `zoom` — `(x0,y0)-(x1,y1)` in viewport pixels
- `fullResolution` (boolean, optional, default `false`): `screenshot`/`zoom` — skip the ≤1568px downscale
- `width` / `height` (number, optional): for `resize_page`
- `appear` (boolean, optional, default `true`): `wait` with text — wait for it to appear, or disappear
- `timeout` (number, optional, default `10000`, max `120000`): `wait` with text

Examples:

```json
{ "action": "left_click", "coordinates": { "x": 420, "y": 260 } }
```

```json
{ "action": "key", "text": "cmd+a Backspace" }
```

```json
{ "action": "fill", "ref": "ref_7", "value": "user@example.com" }
```

```json
{ "action": "hover", "ref": "ref_12", "duration": 0.6 }
```

```json
{ "action": "left_click_drag", "startRef": "ref_10", "ref": "ref_15" }
```

### `chrome_click_element`

Click elements using a ref, selector, or coordinates.

**Parameters**:

- `ref` (string, optional): Element ref from `chrome_read_page` (preferred when available)
- `selector` (string, optional): CSS selector for target element
- `coordinates` (object, optional): `{ "x": 120, "y": 240 }` viewport coordinates
- `waitForElementMs` (number, optional, default `2000`): how long to wait for the element to
  appear **and become visible** before failing. Set `0` to fail immediately.
- `double` (boolean, optional, default `false`): double click
- `button` (string, optional, default `left`): `left` | `right` | `middle`
- `modifiers` (object, optional): modifier keys held during the click
- `waitForNavigation` (boolean, optional, default `false`): wait for navigation after the click
- `timeout` (number, optional, default `5000`): timeout for that wait

At least one of `ref`, `selector`, or `coordinates` must be provided.

**Blocked clicks (`obstruction`)**: when the click fails because something is on top of the
target, the result includes an `obstruction` object instead of a bare error - the covering
element (tag/id/class/text/z-index), the modal-ish ancestor if one was found
(`<dialog open>`, `role="dialog"`, `aria-modal`, or a high-z-index layer), its viewport
coverage, whether the body scroll is locked, and a hint for what to do next. Read it rather
than retrying the same click. Other failure reasons are distinguished too:
`hidden_by_css`, `transparent`, `zero_size`, `outside_viewport`.

When clicking by `ref`, the event is dispatched directly on the element, so the click
succeeds even while covered - in that case the result carries the same `obstruction` object
plus a `warning`, because the site may have ignored the click.

**Example**:

```json
{
  "ref": "ref_42"
}
```

### `chrome_fill_or_select`

Fill form fields or select options.

**Parameters**:

- `ref` (string, optional): Element ref from `chrome_read_page`
- `selector` (string, optional): CSS selector for target element
- `value` (string, required): Value to fill or select
- `waitForElementMs` (number, optional, default `2000`): how long to wait for the field to
  appear before failing. Set `0` to fail immediately.

Provide `ref` or `selector` to identify the element.

Works on `<input>`, `<textarea>`, `<select>` **and `contenteditable` elements** — which is
what every modern editor uses (Google Flow, Gemini, ChatGPT, Notion, the Naver blog editor).
Editable elements are filled with `execCommand('insertText')` so `beforeinput`/`input` fire
natively and frameworks pick the change up. Shadow DOM is searched too.

When the target is not fillable, the error names the element you actually hit (tag + the
`ref`/`selector` you passed) and points at the right tool instead.

**Example**:

```json
{
  "ref": "ref_7",
  "value": "user@example.com"
}
```

### `chrome_keyboard`

Send key combinations **or plain text** to the page.

- Key combination: `"Ctrl+C"`, `"Enter"`, `"Tab"`, `"ArrowDown"`
- Sequence: `"Ctrl+A, Delete"`
- Text: `"Hello World"` — typed through the native value setter, so React and other
  controlled inputs register it; `contenteditable` targets use `insertText`.

If no token parses as a key, the whole string is treated as text (so `"Hello, World"` keeps
its comma). Long text automatically shortens the per-character delay to stay within budget.

**Parameters**:

- `keys` (string, required): key combination, comma-separated sequence, or text to type
- `selector` (string, optional): focus this element first
- `delay` (number, optional, default `0`): delay between keystrokes in ms

**Example**:

```json
{
  "keys": "Hello World",
  "selector": "#text-input"
}
```

### `chrome_wait_for`

Wait until the page is actually ready before acting — this is what removes
"clicked/read too early" failures after navigation, a click, or an AJAX update.

Conditions are AND-combined and at least one is required. A timeout is **not** an error: you
get `success: false` plus the observed state, so you can decide what to do next.

**Parameters**:

- `selector` (string, optional) + `state` (string, optional, default `visible`): `visible` | `attached` | `hidden`
- `text` (string, optional): wait until this text appears in the body
- `documentReady` (boolean, optional): wait for `readyState === "complete"`
- `networkIdleMs` (number, optional): wait for this much silence on the tab's network (e.g. `500`)
- `timeoutMs` (number, optional, default `15000`, max `60000`)
- `pollMs` (number, optional, default `250`, min `100`)
- `tabId` (number, optional): target tab

**Example**:

```json
{ "selector": ".results", "state": "visible", "networkIdleMs": 500 }
```

### `chrome_upload_file`

Upload files into a form's `input[type="file"]` via CDP.

**Parameters**:

- `selector` (string, required): CSS selector for the file input
- `filePath` (string, optional): local path to upload
- `fileUrl` (string, optional): download from this URL first, then upload
- `base64Data` (string, optional): upload this base64 payload
- `fileName` (string, optional, default `uploaded-file`): name to use with `fileUrl` / `base64Data`
- `multiple` (boolean, optional, default `false`): the input accepts multiple files
- `tabId` / `windowId` (number, optional)

**Example**:

```json
{ "selector": "input[type=file]", "filePath": "C:/Users/me/Pictures/photo.png" }
```

### `chrome_handle_dialog`

Answer a JavaScript dialog (`alert` / `confirm` / `prompt`) over CDP.

> A native dialog blocks the extension until it is answered. Prefer not to trigger one; if a
> page does, handle it here rather than waiting it out.

**Parameters**:

- `action` (string, required): `accept` | `dismiss`
- `promptText` (string, optional): text to submit when accepting a `prompt`
- `tabId` (number, optional): target tab

**Example**:

```json
{ "action": "accept", "promptText": "yes" }
```

### `chrome_handle_download`

Wait for a browser download and return its details (id, filename, url, state, size).

**Parameters**:

- `filenameContains` (string, optional): only match downloads whose filename or URL contains this
- `timeoutMs` (number, optional, default `60000`, max `300000`)
- `waitForComplete` (boolean, optional, default `true`): wait for the download to finish

**Example**:

```json
{ "filenameContains": "invoice", "timeoutMs": 120000 }
```

### `chrome_request_element_selection`

Ask the **user** to click the element(s) you could not locate — a human-in-the-loop fallback
after roughly three failed attempts with `chrome_read_page` + `chrome_click_element` /
`chrome_fill_or_select` / `chrome_computer`. The user sees a panel with your instructions and
picks each element on the page.

Returns refs compatible with `chrome_click_element` / `chrome_fill_or_select`, including the
iframe `frameId`.

**Parameters**:

- `requests` (array, required): one entry per element to pick; each produces exactly one selection
- `timeoutMs` (number, optional, default `180000`, max `600000`)
- `tabId` / `windowId` (number, optional)

**Example**:

```json
{ "requests": [{ "label": "결제 버튼", "description": "주문서 하단의 파란 버튼" }] }
```

### `chrome_request_user_consent`

Ask for consent **before** using a sensitive site feature (camera, microphone, geolocation).
Returns `{ approved, source }`.

If the matching popup toggle is ON, it returns `{ approved: true, source: "toggle" }`
immediately and stickily allows the active tab's origin via `chrome.contentSettings`.
Otherwise a small consent window opens and waits up to 60s for the user.

**Parameters**:

- `action` (string, required): `camera` | `microphone` | `geolocation`
- `reason` (string, required): shown to the user, in their language

**Example**:

```json
{ "action": "microphone", "reason": "녹화 시작을 위해 마이크에 접근합니다" }
```

## 🤖 Automation

### `chrome_batch`

Run several browser tool steps sequentially in **one** call — cuts the round-trip latency of
chains like click → fill → click → screenshot. Each step targets the session work tab by
default.

Steps may not include `chrome_batch` itself or interactive tools (`chrome_switch_tab`,
element selection, user consent). By default the run stops at the first failure.

Once substitution is on (any flow key or `templates: true`), a step may call `chrome_userscript`
only with the read-only actions `list` and `get`; every other action is rejected with
`flow_stateful_tool_forbidden`. `create`, `update`, `enable`, `disable`, and `remove` all write the
same persisted store, and a persisted script is re-injected into every later matching tab, so a
substituted secret would outlive the call. `send_command` pushes a substituted payload into an
already persisted script, and `export` pulls every stored script body into the flow. A plain
`chrome_userscript` call on its own, and a v1 `chrome_batch` with no flow keys, are unaffected.

**Parameters**:

- `steps` (array, required, max 20): `{ tool: string, args?: object }` in order
- `continueOnError` (boolean, optional, default `false`): run the rest even after a failure
- `task` (string, optional, max 24 chars): label shown on the MCP tab group while this run is in
  flight, so a background run says what it is doing; the group goes back to `MCP` when it ends

**Value passing and flow control** (all optional, and all of them switch substitution on):

- `as` (string, on a step): name this step result, then read it from later steps with
  `{{name.path}}`. A whole string that is one token keeps the original type; a token inside a
  longer string is embedded as text. A reference that resolves to nothing fails that step with
  `unresolved_reference` instead of passing an empty string. `{{prev...}}` is the step that ran
  last, and `{{name.$ok}}` / `{{name.$text}}` / `{{name.$error}}` are the meta fields.
- `when` (object, on a step): run the step only if the condition holds, otherwise its status is
  `skipped`. A condition is JSON, never an expression:
  `{ "path": "hit.matches", "op": "notEmpty" }`, or `all` / `any` / `not` around such leaves.
  Operators: `exists`, `notExists`, `empty`, `notEmpty`, `eq`, `ne`, `gt`, `gte`, `lt`, `lte`,
  `contains`. A `value` may itself contain `{{...}}`, which is substituted before the comparison.
- `stopIf` (object, on a step): after the step runs, stop the whole call when the condition
  holds. That step reports `stopped`, the remaining steps report `skipped`.
- `repeat` (object) with `steps` (array): a repeat group.
  `{ "repeat": { "max": 1..20, "until": condition, "delayMs": 0..5000 }, "steps": [...] }`.
  Groups cannot nest, count as one item against the 20 step limit, and report one entry with
  `attempts: { count, stoppedBy }` where `stoppedBy` is `until`, `stopIf`, `max` or `failure`.
  Each round clears the inner `as` names and `prev`; `{{loop.index}}` starts at 0 and
  `{{loop.count}}` is the round number. Give the group an `as` to keep one snapshot per round.
- `templates` (boolean) forces substitution on, `return` (array of `as` names) adds a `results`
  object to the response.

Target arguments (`tabId`, `tabIds`, `windowId`, `lane`, `_mcpSessionId`, and `url` on tools
where the url picks the tab) cannot come from a template: those are rejected with
`template_forbidden_key`. A run with flow control stops at 100 tool calls
(`total_runs_exceeded`) or 100 seconds (`timeout`) and returns what it has so far.

**Example (a)**, search then click the first hit:

```json
{
  "steps": [
    { "tool": "chrome_navigate", "args": { "url": "https://search.example.com/?q=크롬" } },
    {
      "tool": "chrome_find",
      "as": "hit",
      "args": { "query": "첫 번째 검색 결과", "maxResults": 1 }
    },
    {
      "tool": "chrome_click_element",
      "when": { "path": "hit.matches[0].ref", "op": "exists" },
      "args": { "ref": "{{hit.matches[0].ref}}" }
    },
    { "tool": "chrome_screenshot" }
  ]
}
```

**Example (b)**, collect a list until the next button is gone:

```json
{
  "return": ["pages"],
  "steps": [
    { "tool": "chrome_navigate", "args": { "url": "https://list.example.com/items?page=1" } },
    {
      "repeat": { "max": 20, "until": { "path": "next.matches", "op": "empty" }, "delayMs": 500 },
      "as": "pages",
      "steps": [
        {
          "tool": "chrome_extract",
          "as": "page",
          "args": { "fields": { "titles": { "selector": ".item h3", "all": true } } }
        },
        {
          "tool": "chrome_find",
          "as": "next",
          "args": { "query": "다음 페이지 버튼", "maxResults": 1 }
        },
        {
          "tool": "chrome_click_element",
          "when": { "path": "next.matches", "op": "notEmpty" },
          "args": { "ref": "{{next.matches[0].ref}}" }
        }
      ]
    }
  ]
}
```

**Example**, the plain v1 form is unchanged (no new key, no substitution):

```json
{
  "steps": [
    { "tool": "chrome_fill_or_select", "args": { "selector": "#id", "value": "me@example.com" } },
    { "tool": "chrome_fill_or_select", "args": { "selector": "#pw", "value": "secret" } },
    { "tool": "chrome_click_element", "args": { "selector": "button[type=submit]" } },
    { "tool": "chrome_wait_for", "args": { "selector": ".dashboard" } }
  ]
}
```

### `chrome_shortcut`

Save and replay a named macro — a `chrome_batch` step list stored under a name, so repeated
workflows (login flows, routine collection) survive across sessions.

**Parameters**:

- `action` (string, required): `save` | `run` | `list` | `delete` | `history` | `schedule` |
  `unschedule` | `schedules`
- `name` (string, optional): shortcut name (`save` / `run` / `delete` / `schedule` /
  `unschedule`; filters `history`)
- `steps` (array, optional, max 20): for `save` — steps in `chrome_batch` format
- `description` (string, optional): for `save` — what this shortcut does
- `continueOnError` (boolean, optional, default `false`): for `run`
- `params` (object, optional): for `save`, the declaration; for `run`, the values
- `templates` (boolean, optional) / `return` (array, optional): same meaning as in `chrome_batch`
- `task` (string, optional): same meaning as in `chrome_batch`; for `run`, defaults to the
  shortcut name
- `return` (array, optional): for `save`, the names a scheduled run records; for `run`, the names
  this call returns (a `run` value wins over the saved one)
- `history` reads past runs: `runId` returns that one run in full (with its `results`), otherwise
  you get summaries only, filtered by `name`, `since` (ISO or epoch ms) and `status`, `limit`
  runs at a time (default 20, max 100)
- `schedule` (object, optional): for `action: "schedule"`, either
  `{ every: "15m"|"1h"|"6h"|"24h" }` or `{ daily: ["08:00"], days?: ["mon", ...] }`
- `notify` (boolean, optional, default `true`) / `report` (boolean, optional, default `false`) /
  `loginCheck` (string, optional): schedule options, described below

Saved steps take every `chrome_batch` flow key (`as`, `when`, `stopIf`, `repeat`), including a
`{ repeat: {...}, steps: [...] }` group as a top level item. A record that
uses any of them is a v2 record: it may not store `tabId`, `tabIds`, `windowId`, or a
`chrome_close_tabs` url, because a stored tab id points at a different tab later
(`stale_target_forbidden`). Records saved before this feature keep running exactly as they did,
with no substitution at all.

**Parameters of a saved shortcut** (max 16). Each declaration takes `required`, `default`,
`secret` and `description`. `required` with a `default`, or `secret` with a `default`, is
rejected. At run time a supplied value wins over the default, a missing required value is
`missing_param`, a name that was never declared is `unknown_param`, and `{{params.x}}` without a
declaration is rejected when saving (`undeclared_param`). A `secret` must be a string, is never
written to storage, and is replaced with `***` everywhere in the response.

**Example (c)**, a login shortcut that takes an account:

```json
{
  "action": "save",
  "name": "site-login",
  "params": {
    "user": { "required": true, "description": "아이디" },
    "pw": { "required": true, "secret": true },
    "url": { "default": "https://example.com/login" }
  },
  "steps": [
    { "tool": "chrome_navigate", "args": { "url": "{{params.url}}" } },
    { "tool": "chrome_find", "as": "idBox", "args": { "query": "아이디 입력창", "maxResults": 1 } },
    {
      "tool": "chrome_fill_or_select",
      "args": { "ref": "{{idBox.matches[0].ref}}", "value": "{{params.user}}" }
    },
    {
      "tool": "chrome_find",
      "as": "pwBox",
      "args": { "query": "비밀번호 입력창", "maxResults": 1 }
    },
    {
      "tool": "chrome_fill_or_select",
      "args": { "ref": "{{pwBox.matches[0].ref}}", "value": "{{params.pw}}" }
    },
    { "tool": "chrome_keyboard", "args": { "keys": "Enter" } },
    {
      "tool": "chrome_find",
      "as": "logout",
      "args": { "query": "로그아웃 버튼", "maxResults": 1 },
      "stopIf": { "path": "logout.matches", "op": "notEmpty" }
    },
    { "tool": "chrome_screenshot" }
  ]
}
```

**Example**, running it:

```json
{ "action": "run", "name": "site-login", "params": { "user": "me@example.com", "pw": "..." } }
```

#### Scheduling a shortcut

`action: "schedule"` makes the extension run a saved shortcut on its own, with no MCP session
open. Chrome is the only thing that is always running, so the timer lives there: one
single-shot `chrome.alarms` entry per schedule, re-armed after every run.

- Pick exactly one of `every` (`15m`, `1h`, `6h`, `24h`) or `daily` (up to 4 local `HH:mm` times,
  at least 5 minutes apart within the same day). `days` (`mon`..`sun`) narrows `daily` to certain
  weekdays. There is no cron syntax on purpose: it is unreadable, and a parser is an error
  surface that buys nothing for daily work.
- One schedule per shortcut, at most 20 in total (`too_many_schedules`). Scheduling the same name
  again replaces it (`replaced: true`) and leaves exactly one alarm. `unschedule` removes the
  record and the alarm; deleting the shortcut removes both as well.
- Everything is validated when you schedule, not when it runs. A failure at 3am is a failure
  nobody sees. That includes `params` (`unknown_param`, `missing_param`), stored tab targets
  (`stale_target_forbidden`, applied even to records saved before this feature), and the first
  step.
- **The first step must be a plain `chrome_navigate` with a `url`**, not a repeat group, not
  conditional, not `refresh` (`schedule_first_step_invalid`). A scheduled run starts with no work
  tab, and navigate is the only way to open one. Every later step targets that tab.
- **Secrets cannot be scheduled.** A shortcut with a `required` secret is rejected outright
  (`secret_required_unschedulable`), and passing a secret value in the schedule is
  `secret_param_in_schedule`. Storing a password in extension storage is storing it in plain
  text, so there is no option to do it. For sites that need a login, rely on the Chrome profile
  cookies: sign in once by hand, and the scheduled run shares that session.
- `loginCheck` is the `as` name of a top level step. When that step ends the run through its
  `stopIf`, the status is `login_required` instead of `stopped`, and you get a notification.
  Other `stopIf` stops are normal early exits and stay quiet.
- Runs are serial, always background, and always in their own session bucket
  (`scheduled::<name>`). They never activate a tab or focus a window. When the run ends its tabs
  are closed, and if you open one of them mid-run the run stops with `user_took_over_tab` and
  leaves the tab alone.
- Limits: 100 tool calls and 100 seconds per run (same as `chrome_batch`), 120 seconds end to
  end, and a run that waited more than 10 minutes in the queue is recorded as `skipped_queue`
  instead of running late. Missed runs are caught up **once**, not once per missed slot.
- Failures write one screenshot and, with `report: true`, a JSON copy of the run record to
  `Downloads/mcp-screenshots/YYYY-MM-DD/report_<name>_<HHmmss>.json` (up to 256KiB of results,
  versus 24,000 characters in `history`). Notifications only fire on the 1st and 3rd consecutive
  failure, and carry nothing but the name, an error code and a step number.

**Example (a)**, collect dashboard numbers every weekday at 08:00. Save first, then schedule.

```json
{
  "action": "save",
  "name": "daily-dashboard",
  "return": ["kpi"],
  "params": { "site": { "default": "https://dash.example.com/overview" } },
  "steps": [
    { "tool": "chrome_navigate", "args": { "url": "{{params.site}}" } },
    { "tool": "chrome_wait_for", "args": { "selector": ".kpi-card", "timeout": 10000 } },
    {
      "tool": "chrome_extract",
      "as": "kpi",
      "args": {
        "fields": {
          "visitors": ".kpi-card.visitors .value",
          "orders": ".kpi-card.orders .value",
          "revenue": ".kpi-card.revenue .value"
        }
      }
    }
  ]
}
```

```json
{
  "action": "schedule",
  "name": "daily-dashboard",
  "schedule": { "daily": ["08:00"], "days": ["mon", "tue", "wed", "thu", "fri"] },
  "report": true
}
```

In the morning, `{ "action": "history", "name": "daily-dashboard", "limit": 1 }` gives the
summary, and opening it by `runId` gives `results.kpi.values`.

**Example (b)**, check a board for new posts every hour. No new post means the `stopIf` ends the
run as `stopped`, which is silent.

```json
{
  "action": "save",
  "name": "board-watch",
  "return": ["latest"],
  "params": { "lastSeen": { "required": true, "description": "마지막으로 본 글 번호" } },
  "steps": [
    { "tool": "chrome_navigate", "args": { "url": "https://board.example.com/list" } },
    {
      "tool": "chrome_extract",
      "as": "latest",
      "args": {
        "fields": {
          "id": { "selector": ".row:first-child .id" },
          "title": { "selector": ".row:first-child .title" }
        }
      },
      "stopIf": { "path": "latest.values.id", "op": "eq", "value": "{{params.lastSeen}}" }
    },
    { "tool": "chrome_screenshot" }
  ]
}
```

```json
{
  "action": "schedule",
  "name": "board-watch",
  "schedule": { "every": "1h" },
  "params": { "lastSeen": "10422" }
}
```

**Example (c)**, notice that a login expired instead of silently collecting an empty page.

```json
{
  "action": "save",
  "name": "crm-export",
  "return": ["rows"],
  "steps": [
    { "tool": "chrome_navigate", "args": { "url": "https://crm.example.com/reports/today" } },
    {
      "tool": "chrome_find",
      "as": "loginForm",
      "args": { "query": "비밀번호 입력창", "maxResults": 1 },
      "stopIf": { "path": "loginForm.matches", "op": "notEmpty" }
    },
    {
      "tool": "chrome_extract",
      "as": "rows",
      "args": { "fields": { "names": { "selector": "table td.name", "all": true } } }
    }
  ]
}
```

```json
{
  "action": "schedule",
  "name": "crm-export",
  "schedule": { "daily": ["07:30", "12:30"] },
  "loginCheck": "loginForm"
}
```

The password box showing up means the session expired: the run is recorded as `login_required`
and a notification says `crm-export: login_required (step 1)`. Sign in again in Chrome and the
next run is normal.

**Example**, the morning routine:

```json
{ "action": "schedules" }
```

```json
{ "action": "history", "since": "2026-09-04T22:00:00", "limit": 50 }
```

```json
{ "action": "history", "runId": "daily-dashboard:2026-09-05T08:00:00.000Z" }
```

A step by step walkthrough in Korean is in
[`docs/DAILY-AUTOMATION-ko.md`](./DAILY-AUTOMATION-ko.md).

### `record_replay_list_published`

List the published record-replay flows so you can pick one to run. A flow is recorded and
published in the extension side panel; this tool only reads the list.

**Parameters**: none (plus the common `lane`).

**Returns**: `{ success, published: [{ id, slug, name, version, description }] }`.

### `record_replay_flow_run`

Run one published flow on this session work tab.

The flow engine never picks a tab on its own: the tab is supplied to it, and every step the
flow runs carries that tab id. Where that tab comes from is decided in this order:

1. the `tabId` you passed, or this session's work tab, which the work-tab gate injects;
2. otherwise the **flow start URL**: a `startUrl` argument, or the page the flow was recorded
   on (`startUrl` is stored with the flow when you record it in the side panel). The tool
   opens that page as a background work tab through the same path
   `chrome_navigate(background: true)` uses, so the tab is registered as this session's work
   tab and stays open afterwards, exactly as if you had called `chrome_navigate` yourself;
3. only when there is neither a work tab nor a start URL is the call refused with
   `no_work_tab`. Call `chrome_navigate` first, or pass `tabId`.

Flows recorded before start URLs existed have none, so they still need a work tab. The call
cannot be nested inside `chrome_batch` or `chrome_shortcut` steps.

**Parameters**:

- `flowId` (string, required): id from `record_replay_list_published`
- `args` (object, optional): values for the flow variables, keyed by variable name
- `tabTarget` (string, optional, default `current`): `current` runs in the work tab. `new`
  opens a background tab in the work tab window, runs there, and leaves the tab open. It is
  ignored when the run tab was just created from the start URL, since that tab is already new
- `startUrl` (string, optional): open this URL in the run tab before the first step. It
  overrides the flow's own start URL, and is what a work tab is created from when there is none
- `refresh` (boolean, optional, default `false`): reload the run tab before the first step
- `captureNetwork` (boolean, optional, default `false`): record network requests during the run
- `returnLogs` (boolean, optional, default `false`): include the step log, capped at 4000 chars
- `timeoutMs` (number, optional): abort the whole run after this many ms
- `tabId` (number, optional): run in this exact tab instead of the session work tab

**Returns** a summary, not the raw run record: `success`, `runId`, `flowId`, `tabId`,
`tabSource` (`work_tab` | `created_from_start_url` | `explicit`; how the run tab was obtained),
`summary { total, success, failed, tookMs }`, `paused`, `outputs` (the flow variables that are
not marked sensitive) and, when a step failed, `failedStep { stepId, message }`. Step logs and
the failure screenshot are left out unless you ask for logs.

**Example**, with no `chrome_navigate` needed when the flow knows its own start page:

```json
{ "flowId": "flow_daily_report", "args": { "date": "2026-09-05" }, "returnLogs": true }
```

## 📚 Data Management

### `chrome_history`

Search browser history with filters. Results paginate — use `limit` / `offset`, or
`countOnly: true` when you only need the total.

**Parameters**:

- `text` (string, optional): Search text in URL/title
- `startTime` (string, optional): Start date (ISO format)
- `endTime` (string, optional): End date (ISO format)
- `maxResults` (number, optional): Maximum results (default: 100)
- `excludeCurrentTabs` (boolean, optional): Exclude current tabs (default: true)
- `limit` (number, optional, default `100`) / `offset` (number, optional, default `0`): pagination
- `countOnly` (boolean, optional, default `false`): return only `totalCount`

**Example**:

```json
{
  "text": "github",
  "startTime": "2024-01-01",
  "maxResults": 50
}
```

### `chrome_bookmark_search`

Search bookmarks by keywords.

**Parameters**:

- `query` (string, optional): Search keywords
- `maxResults` (number, optional): Maximum results (default: 100)
- `folderPath` (string, optional): Search within specific folder

**Example**:

```json
{
  "query": "documentation",
  "maxResults": 20,
  "folderPath": "Work/Resources"
}
```

### `chrome_bookmark_add`

Add new bookmarks with folder support.

**Parameters**:

- `url` (string, optional): URL to bookmark (default: current tab)
- `title` (string, optional): Bookmark title (default: page title)
- `parentId` (string, optional): Parent folder ID or path
- `createFolder` (boolean, optional): Create folder if not exists (default: false)

**Example**:

```json
{
  "url": "https://example.com",
  "title": "Example Site",
  "parentId": "Work/Resources",
  "createFolder": true
}
```

### `chrome_bookmark_delete`

Delete bookmarks by ID or URL.

**Parameters**:

- `bookmarkId` (string, optional): Bookmark ID to delete
- `url` (string, optional): URL to find and delete

- `title` (string, optional): bookmark title, used to disambiguate when deleting by URL

**Example**:

```json
{
  "url": "https://example.com"
}
```

## 🗄️ Browser State & Output

### `chrome_storage`

Read or modify cookies, `localStorage`, or `sessionStorage`.

**Parameters**:

- `kind` (string, optional): `cookies` (default) | `local` | `session`
- `action` (string, optional): `get` (default) | `set` | `remove` | `clear`
- `url` (string, optional): cookie target URL - required for `set`/`remove`, defaults to the work tab URL
- `domain` (string, optional): scope cookies by domain (`get`, `clear`)
- `name` / `key` (string, optional): cookie name / storage key
- `value` (string, optional): value to write
- `path`, `secure`, `httpOnly`, `sameSite`, `expirationDate`: cookie attributes for `set`
- `includeValues` (boolean, optional, default `false`): return real values instead of masked placeholders

**Values are masked by default.** Names, domains and expiry still come back, but the value
reads as `<hidden:128chars>` unless you pass `includeValues: true` - cookies are usually
auth tokens, and this keeps them out of transcripts by accident.

`action: "clear"` refuses to run without a scope (`url` or `domain`), so it cannot wipe every
cookie in the browser.

**Example** - save then restore a login session:

```json
{ "kind": "cookies", "action": "get", "domain": "example.com", "includeValues": true }
```

### `chrome_save_pdf`

Save the current page as a PDF into `Downloads/mcp-screenshots/<YYYY-MM-DD>/pdf_<name>_<HHmmss>.pdf`.

**Parameters**:

- `filename` (string, optional): `.pdf` is appended automatically
- `paperFormat` (string, optional): `a4` (default) | `a3` | `letter` | `legal`
- `landscape` (boolean, optional, default `false`)
- `printBackground` (boolean, optional, default `true`)
- `scale` (number, optional, `0.1`-`2`, default `1`)
- `pageRanges` (string, optional): e.g. `"1-3"`. Default all pages
- `displayHeaderFooter` (boolean, optional, default `false`)
- `marginInches` (number, optional, `0`-`3`, default `0.4`)

Unlike a screenshot the text stays selectable and multi-page documents are captured in full.
The PDF bytes are **not** returned - only the saved filename - because a single PDF would be
hundreds of thousands of tokens.

### `chrome_emulate`

Emulate a device viewport for responsive/mobile checking.

**Parameters**:

- `action` (string, optional): `set` (default) | `reset` | `status`
- `device` (string, optional): `iphone-se` | `iphone-15` | `pixel-8` | `galaxy-s23` | `ipad` |
  `desktop-1280` | `desktop-1080p`
- `width`, `height`, `deviceScaleFactor`, `mobile`, `hasTouch`, `userAgent`: custom overrides

The real window is never resized, so this works on background work tabs and does not disturb
what the user is looking at. Emulation **persists until `action: "reset"`** because the CDP
session must stay attached - Chrome may show its automation notice bar on the emulated tab
until you reset it. Closing the tab clears the state automatically.

### `chrome_network_rules`

Block network requests with `declarativeNetRequest` **session** rules.

**Parameters**:

- `action` (string, optional): `block` (default) | `unblock` | `list` | `clear`
- `preset` (string, optional): `ads` | `trackers` | `images` | `media` | `fonts`
- `patterns` (string[], optional): custom urlFilter patterns, e.g. `["||doubleclick.net^"]` (max 100)
- `tabId` (number, optional): apply to one tab only. Omit for all tabs
- `ruleIds` (number[], optional): for `action: "unblock"` - ids from `action: "list"`

Blocking ads/trackers makes pages load noticeably faster and cuts the boilerplate that
`chrome_read_page` / `chrome_get_web_content` would otherwise return, which saves tokens.

Rules are session-scoped (gone when Chrome restarts) and only occupy rule ids 9000-9899, so
they never collide with other session rules. **Caveat**: some sites depend on tracker domains
for login or checkout - if a flow breaks unexpectedly, `action: "clear"` first.

**Example**:

```json
{ "action": "block", "preset": "ads", "tabId": 42 }
```

## 🕶️ Hidden Tools (Internal Only)

These tool names exist in `packages/shared/src/tools.ts` (`TOOL_NAMES`) and have a real,
working implementation registered in the extension's dispatch map (`REGISTERED_TOOL_NAMES`),
but their schema is not part of `TOOL_SCHEMAS` - they are not advertised over MCP `ListTools`
and a normal agent session cannot discover or call them by name. This is deliberate (mostly to
keep the advertised schema small - see the v1.10.1 "토큰 절감" changelog entry), not an
oversight, so they are not being removed. This section exists so a future cleanup pass does not
mistake them for dead code.

- **`search_tabs_content`** - semantic (vector) search over previously indexed tab content.
  Requires the local embedding model/vector DB to be initialized; hidden to keep it out of the
  default schema surface.
- **`chrome_inject_script`** - injects a JS/CSS script into a tab's `ISOLATED` or `MAIN` world.
  Superseded for most agent use by `chrome_javascript` (CDP `Runtime.evaluate`) and
  `chrome_userscript` (persistent, CSP-aware); still used internally by the record-replay
  engine.
- **`chrome_send_command_to_inject_script`** - sends a named event/payload to a script
  previously injected with `chrome_inject_script`. Only useful paired with that tool.
- **`chrome_userscript`** - Tampermonkey-style persistent script/CSS manager
  (create/list/get/enable/disable/update/remove/send_command/export), CSP-aware with
  automatic strategy selection. Fully implemented and exercised by tests; hidden for the same
  schema-size reason as the tools above.
- **`chrome_get_interactive_elements`** (deprecated) - see its own entry under
  [Content Analysis](#-content-analysis). Replaced by `chrome_read_page`, kept only for
  backward compatibility.
- **`chrome_network_capture_start`** / **`chrome_network_capture_stop`** - the start/stop
  halves of the `webRequest`-based capture. `chrome_network_capture` is the advertised
  wrapper that runs both around a scripted interaction; the halves stay hidden because a bare
  `start` with no matching `stop` leaks a listener. The record-replay engine calls
  `start` directly (`rr-utils.ts`).
- **`chrome_network_debugger_start`** / **`chrome_network_debugger_stop`** - the same split
  for the `chrome.debugger` (CDP) capture path, which also returns response bodies. Hidden for
  the same pairing reason; the record-replay scheduler calls `start` directly
  (`engine/scheduler.ts`).

If you need one of these from an MCP client, call it by its exact name anyway - the dispatcher
still accepts it, it is just not listed for the model to discover on its own.

## 📋 Response Format

All tools return responses in the following format:

```json
{
  "content": [
    {
      "type": "text",
      "text": "JSON string containing the actual response data"
    }
  ],
  "isError": false
}
```

For errors:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Error message describing what went wrong"
    }
  ],
  "isError": true
}
```

## 🔧 Usage Examples

### Complete Workflow Example

```javascript
// 1. Navigate — waits for the DOM by default, so the next call sees a real page
await callTool('chrome_navigate', { url: 'https://example.com' });

// 2. Start capturing network traffic
await callTool('chrome_network_capture', { action: 'start', maxCaptureTime: 30000 });

// 3. Find and click, without guessing selectors
const [button] = (await callTool('chrome_find', { query: '데이터 불러오기 버튼' })).candidates;
await callTool('chrome_click_element', { ref: button.ref });

// 4. Wait until the results are really there
await callTool('chrome_wait_for', { selector: '.results', networkIdleMs: 500 });

// 5. Pull just the fields you need (cheaper than reading the page)
const data = await callTool('chrome_extract', {
  fields: {
    title: 'h1',
    rows: { selector: '.results .row', all: true },
  },
});

// 6. Stop the capture and read what was requested
const networkData = await callTool('chrome_network_capture', { action: 'stop', limit: 50 });

// 7. Save a bookmark
await callTool('chrome_bookmark_add', {
  title: 'Data Analysis Page',
  parentId: 'Work/Analytics',
});
```

### Collecting an Infinite-Scroll Page

```javascript
// One call replaces scroll → read → scroll → read. Works in a background tab:
// renderMode keeps the tab rendering so lazy loading actually fires.
const feed = await callTool('chrome_scroll_collect', {
  collect: 'links',
  maxScrolls: 20,
  stopText: 'No more results',
});
// Check `renderAssist` and `stoppedReason` — `noGrowthWhileHidden` means the page never
// loaded more, not that you reached the bottom.
```

### Chaining Without Round-Trips

```javascript
await callTool('chrome_batch', {
  steps: [
    { tool: 'chrome_fill_or_select', args: { selector: '#id', value: 'me@example.com' } },
    { tool: 'chrome_fill_or_select', args: { selector: '#pw', value: 'secret' } },
    { tool: 'chrome_click_element', args: { selector: 'button[type=submit]' } },
    { tool: 'chrome_wait_for', args: { selector: '.dashboard' } },
  ],
});
```

This API covers browser automation end to end: discovery, interaction, waiting, capture, and
export — with the session working in a background tab so it never steals the tab you are on.
