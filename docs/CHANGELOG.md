# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v1.4.1] — 이중 응답 수정 (2026-08-18)

### Fixed

- **`ERR_HTTP_HEADERS_SENT` 대량 발생**: MCP transport 가 `reply.raw` 에 직접 응답을 쓰는데
  Fastify 는 그것을 모른 채 핸들러 종료 후 자체 응답을 한 번 더 보내고 있었다. 결과적으로
  요청 한 건마다 stderr 에 스택이 쌓였다. `/mcp` POST·GET·DELETE, `/sse`, `/messages` 전부
  transport 에 `reply.raw` 를 넘기기 **전에** `reply.hijack()` 하도록 고쳤다.
- 기존 에러 처리의 `if (!reply.sent)` 가드는 raw 쓰기를 반영하지 않아 무력했다. hijack 이후
  상태를 볼 수 있는 `reply.raw.headersSent` / `writableEnded` 기준으로 바꾸고 공용 헬퍼
  `endRawWithError` 로 정리했다.
- GET `/mcp` 는 헤더를 flush 한 뒤에야 hijack 하고 있었다. 순서를 바로잡았다.

MCP 클라이언트를 둘 이상(Claude Code + Codex) 동시에 붙이면서 드러난 문제다. jest 25 통과.

## [v1.4.0] — 현재 창 작업 탭 (2026-08-18)

### Changed — MCP 작업 탭 기본 위치

- **작업 탭이 별도 창이 아니라 사용자가 열어 둔 현재 창에 열린다.** 설정이
  `dedicatedWorkWindow`(boolean) → `mcpWorkWindowMode`(`current` | `dedicated`) 로 바뀌고
  기본값은 `current`. 구버전 boolean 설정은 자동 승계된다.
- `current` 모드의 탭은 항상 비활성(`active: false`)으로 생성 — 사용자가 보던 탭을
  뺏지 않는다. 스크린샷·read_page 는 CDP 경로라 보이지 않는 탭에서도 동작한다.
- 대상 창은 열린 창 중 type `normal` 만 후보로 삼는다 (팝업·개발자도구·앱 창, 시크릿 창,
  이전에 만든 전용 작업 창 제외). 적격 창이 없으면 종전처럼 새 창을 만든다.
- 전용 작업 창은 팝업 토글로 계속 쓸 수 있다 (기본 OFF).

### Fixed

- **사용자 탭 하이재킹**: 같은 URL 재사용 후보에서 사용자 탭을 빼는 필터가 전용 작업 창이
  켜져 있을 때만 걸려 있었다. 토글을 끄면 MCP 가 사용자가 열어 둔 탭을 잡아 조작했다.
  이제 백그라운드 작업 모드면 창 모드와 무관하게 항상 적용된다.
- **doctor 가 남의 npm 패키지 설치를 안내하던 문제**: 복구 명령의 패키지명이
  `mcp-chrome-scalemaker-bridge` 였다. 이 이름은 npm 에서 타 계정 소유다.
  실제 패키지명 `auto-chrome-mcp-bridge` 로 정정했다.
- **postinstall 안내의 잘못된 경로**: `<npm root -g>/mcp-chrome-scalemaker-bridge/...` 로
  안내했으나 실제 설치 폴더는 `auto-chrome-mcp-bridge` 다. 아울러 프로젝트별 `.mcp.json`
  대신 `claude mcp add -s user` 전역 등록을 안내하도록 바꿨다 (프로젝트마다 넣으면
  경로가 어긋나 깨지기 쉽다).
- doctor 의 bridge 프로세스 탐지가 구 폴더명만 찾던 것을 두 이름 모두 인정하도록 수정.

### Chore

- 주석·문서의 `scalemaker` 표기를 `auto-chrome-mcp` 로 정리 (95개 파일). 네이티브 호스트
  id, npm 패키지명·bin 별칭, 워크스페이스 package.json name, doctor 스킬명, 런타임 데이터
  폴더는 기존 설치 호환을 위해 그대로 뒀다.

## [v1.3.0] — Auto Chrome MCP (2026-08-17)

### Added — Claude-in-Chrome 격차 해소 (사용자 선택 1–3)

- **`chrome_find`**: natural-language element search (Korean/English) over the accessibility tree — synonym + fuzzy scoring, iframe search included; returns ranked refs/coordinates/frameId usable directly with click/fill/computer.
- **Multi-browser switching** (stdio-local tools, never forwarded to the extension): `chrome_list_browsers` probes candidate bridge ports (active + `CHROME_PORTS` env + defaults) via GET /ping; `chrome_use_browser` switches the session's active browser profile mid-session with clean session termination on the old bridge.
- **`chrome_shortcut`**: named saved macros (chrome_batch step format) — save/run/list/delete, stored in extension storage, executed through the normal tool gate (session work tabs, guards, locks all apply).

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

## [v1.1.0] — auto-chrome-mcp fork (2026-08-17)

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
