# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v1.2.0] — Auto Chrome MCP (2026-08-17)

### Added — 팝업 인지 · 신뢰성 (F1–F7)

- **Popup/new-tab awareness**: tool calls that spawn new tabs/popup windows (OAuth logins, target=\_blank) now report `new_tabs_opened` in the result; new `chrome_set_work_tab` retargets the session work tab without focusing anything; `get_windows_and_tabs` marks work tabs, the MCP window, and recently spawned tabs.
- **`chrome_wait_for`**: wait for selector/text/document-ready/network-idle before acting (timeout returns observed state, not an error).
- **Frame-aware interaction**: click/fill auto-search iframes when the selector isn't in the top frame (probe protocol, first-found wins, frameId reported); `read_page`/interactive-elements gain `allFrames`.
- **Failure screenshots**: failed tool calls attach a downscaled JPEG of the target tab (`errorScreenshotOnFailure` to disable).
- **Login-redirect detection**: `login_required_suspected` warning when the target tab lands on a login page mid-call.
- **Download awareness**: downloads started during a call are reported (`downloads_started`).
- **Popup focus return**: popup windows opened by MCP work tabs are blurred so the user's window regains OS focus.
- **`chrome_scroll_collect`**: one-call infinite-scroll content collection (virtualized-list overlap handling included).

### Added — 토큰 절감 (T1–T7, 품질 무손실)

- **Screenshots as MCP image blocks**: `storeBase64` no longer returns base64 inside text (was 100k+ text tokens per shot); images are auto-downscaled to ≤1568px long edge with exact `imageScale` metadata (also fixes a long-standing coordinate-mapping drift on downscaled screenshots); `fullResolution` opt-out. computer zoom had the same leak — fixed.
- **Diff mode** (`diff`, default on): `read_page`/`get_web_content` return `{unchanged:true}` instead of re-sending identical content (ref map stays fresh).
- **`chrome_extract`**: CSS-selector field extraction — return only the values you need instead of full-page reads.
- **Reader mode** (`raw:false` default): `get_web_content` strips nav/footer/cookie/ad boilerplate and no longer dumps full body text when Readability fails.
- **Lossless a11y-tree compaction** (`compact`, default on): 35–50% smaller `read_page` output (wrapper collapse, dedup, notation shortening; refs/roles/states preserved).
- **Pagination**: console/network-capture/history gain `limit`/`offset`/`countOnly`.
- Failure screenshots are downscaled ~40% further.

## [v1.1.0] — scalemaker fork (2026-08-17)

### Added — 백그라운드 작업 모드 (non-interference)

- **Background work mode** (`backgroundWorkMode`, default ON, popup toggle "백그라운드 작업"): MCP tools no longer activate tabs or steal focus; all tools default `background: true` via a central gate in `tools/index.ts`.
- **Per-session work tabs** (max 10, LRU): each Claude Code session's stdio proxy injects `_mcpSessionId` into every call; `chrome_navigate` records the session's work tab, and tabId-less tool calls target it instead of the user's active tab. Work tabs show an "MCP" action badge.
- **Dedicated MCP work window** (`dedicatedWorkWindow`, default ON, popup toggle "전용 작업 창"): MCP tabs are created in a separate unfocused window; URL-reuse never grabs tabs from user windows in background mode.
- **`chrome_batch` tool**: run up to 20 tool steps in one MCP round-trip (stop-on-error or continueOnError).
- **Screenshot auto-save**: `saveToDownloads`/`filename` params save captures under `Downloads/mcp-screenshots/`.
- **Automation guard** (`automationGuardEnabled`, default ON): per-domain soft throttle (30 actions/10s, delay ≤5s) and runaway-loop breaker (identical call ×12 in 120s → blocked).
- **Per-tab serialization**: concurrent tool calls targeting the same tab are queued, so two sessions can't interleave input on one tab.
- **`tabId` param added** to dialog / network_request / network_capture / performance×3 / userscript / bookmark_add schemas.

### Fixed

- Screenshots are now CDP-first: background tabs capture correctly (incl. fullPage via `captureBeyondViewport`); the captureVisibleTab fallback errors instead of silently returning the wrong tab.
- `chrome_computer` sub-delegations (screenshot/click/fill/keyboard, 10 call sites) now forward the resolved `tabId`.
- Removed needless `tabs.update({active:true})` in console / inject-script / network-capture / web-fetcher; two raw `windows.update({focused:true})` calls now respect the force-focus policy; record-replay window focus routed through the same policy.
- GIF recording of tabs in non-focused windows activates the tab within its own window (animations keep running) and restores the previous tab afterwards.
- `chrome_console` deep-serializes lossy objects (depth 4, 5000 chars, budgeted CDP calls) instead of returning truncated previews (upstream #215).
- CDP attach conflicts retry once (300ms) and report an actionable error; stale debugger sessions are cleaned on force-detach.
- `chrome_close_tabs` with no args closes the session work tab, never the user's active tab, in background mode.

## [v0.0.5]

### Improved

- **Image Compression**: Compress base64 images when using screenshot tool
- **Interactive Elements Detection Optimization**: Enhanced interactive elements detection tool with expanded search scope, now supports finding interactive div elements

## [v0.0.4]

### Added

- **STDIO Connection Support**: Added support for connecting to the MCP server via standard input/output (stdio) method
- **Console Output Capture Tool**: New `chrome_console` tool for capturing browser console output

## [v0.0.3]

### Added

- **Inject script tool**: For injecting content scripts into web page
- **Send command to inject script tool**: For sending commands to the injected script

## [v0.0.2]

### Added

- **Conditional Semantic Engine Initialization**: Smart cache-based initialization that only loads models when cached versions are available
- **Enhanced Model Cache Management**: Comprehensive cache management system with automatic cleanup and size limits
- **Windows Platform Compatibility**: Full support for Windows Chrome Native Messaging with registry-based manifest detection
- **Cache Statistics and Manual Management**: User interface for viewing cache stats and manual cache cleanup
- **Concurrent Initialization Protection**: Prevents duplicate initialization attempts across components

### Improved

- **Startup Performance**: Dramatically reduced startup time when no model cache exists (from ~3s to ~0.5s)
- **Memory Usage**: Optimized memory consumption through on-demand model loading
- **Cache Expiration Logic**: Intelligent cache expiration (14 days) with automatic cleanup
- **Error Handling**: Enhanced error handling for model initialization failures
- **Component Coordination**: Simplified initialization flow between semantic engine and content indexer

### Fixed

- **Windows Native Host Issues**: Resolved Node.js environment conflicts with multiple NVM installations
- **Race Condition Prevention**: Eliminated concurrent initialization attempts that could cause conflicts
- **Cache Size Management**: Automatic cleanup when cache exceeds 500MB limit
- **Model Download Optimization**: Prevents unnecessary model downloads during plugin startup

### Technical Improvements

- **ModelCacheManager**: Added `isModelCached()` and `hasAnyValidCache()` methods for cache detection
- **SemanticSimilarityEngine**: Added cache checking functions and conditional initialization logic
- **Background Script**: Implemented smart initialization based on cache availability
- **VectorSearchTool**: Simplified to passive initialization model
- **ContentIndexer**: Enhanced with semantic engine readiness checks

### Documentation

- Added comprehensive conditional initialization documentation
- Updated cache management system documentation
- Created troubleshooting guides for Windows platform issues

## [v0.0.1]

### Added

- **Core Browser Tools**: Complete set of browser automation tools for web interaction
  - **Click Tool**: Intelligent element clicking with coordinate and selector support
  - **Fill Tool**: Form filling with text input and selection capabilities
  - **Screenshot Tool**: Full page and element-specific screenshot capture
  - **Navigation Tools**: URL navigation and page interaction utilities
  - **Keyboard Tool**: Keyboard input simulation and hotkey support

- **Vector Search Engine**: Advanced semantic search capabilities
  - **Content Indexing**: Automatic indexing of browser tab content
  - **Semantic Similarity**: AI-powered text similarity matching
  - **Vector Database**: Efficient storage and retrieval of embeddings
  - **Multi-language Support**: Comprehensive multilingual text processing

- **Native Host Integration**: Seamless communication with external applications
  - **Chrome Native Messaging**: Bidirectional communication channel
  - **Cross-platform Support**: Windows, macOS, and Linux compatibility
  - **Message Protocol**: Structured messaging system for tool execution

- **AI Model Integration**: State-of-the-art language models for semantic processing
  - **Transformer Models**: Support for multiple pre-trained models
  - **ONNX Runtime**: Optimized model inference with WebAssembly
  - **Model Management**: Dynamic model loading and switching
  - **Performance Optimization**: SIMD acceleration and memory pooling

- **User Interface**: Intuitive popup interface for extension management
  - **Model Selection**: Easy switching between different AI models
  - **Status Monitoring**: Real-time initialization and download progress
  - **Settings Management**: User preferences and configuration options
  - **Cache Management**: Visual cache statistics and cleanup controls

### Technical Foundation

- **Extension Architecture**: Robust Chrome extension with background scripts and content injection
- **Worker-based Processing**: Offscreen document for heavy computational tasks
- **Memory Management**: LRU caching and efficient resource utilization
- **Error Handling**: Comprehensive error reporting and recovery mechanisms
- **TypeScript Implementation**: Full type safety and modern JavaScript features

### Initial Features

- Multi-tab content analysis and search
- Real-time semantic similarity computation
- Automated web page interaction
- Cross-platform native messaging
- Extensible tool framework for future enhancements
