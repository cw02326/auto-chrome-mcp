# Playwright CDP Fallback

> Native messaging 이 막혔을 때 사용자 Chrome 에 같은 세션으로 attach 하는 보조 transport.

## Quick Start

```bash
# 1. bridge 설치
npm i -g auto-chrome-mcp-bridge

# 2. fallback transport 활성화 (env var)
export MCP_PLAYWRIGHT_FALLBACK=1

# 3. Chrome 을 launcher 로 띄움 (CDP 활성화 + default profile)
auto-chrome-launcher      # ~/.auto-chrome-mcp/cdp-port 에 9222 박제

# 4. extension 연결 (popup → Connect)
# bridge 는 12306 (native) + 12307 (fallback) 두 server 띄움

# 5. Claude Code 에서 fallback 사용:
claude mcp add --transport http chrome-mcp-fallback http://127.0.0.1:12307/mcp
```

## Architecture

```
사용자 Chrome (auto-chrome-launcher 로 띄움, --remote-debugging-port=9222)
       │
       │ CDP (Chrome DevTools Protocol)
       ▼
┌──────────────────────────────────────────────────────┐
│  bridge process (auto-chrome-mcp-bridge)              │
│                                                      │
│  ┌──────────────┐    ┌──────────────────────────┐    │
│  │ Primary 12306│    │ Playwright 폴백 12307    │    │
│  │ native msg   │    │ chromium.connectOverCDP  │    │
│  │ (chrome ext) │    │ (CDP attach)             │    │
│  └──────────────┘    └──────────────────────────┘    │
└──────────────────────────────────────────────────────┘
       ▲                       ▲
       │                       │
   Claude Code               Claude Code
   (또는 Cursor)             (또는 다른 client)
```

## Tool coverage (48 도구)

upstream 이 원래 설계했던 33개(design 문서 §4)에, auto-chrome-mcp fork 가 추가한 도구 12개를
더한 숫자다. `chrome_list_browsers` / `chrome_use_browser`는 stdio 프록시가 가로채 확장으로도
Playwright 로도 전달되지 않으므로 이 표에 없다. `record_replay_flow_run` /
`record_replay_list_published`는 MCP 도구 목록 자체에 노출되지 않아(의도적 보류) 역시 대상이
아니다.

| Status                                        | 수    | 도구                                                                                                                                                                                                                                                                 |
| --------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🟢 1:1 매핑 (구현됨)                          | **3** | chrome_navigate, chrome_screenshot, chrome_get_web_content                                                                                                                                                                                                           |
| 🟢 1:1 매핑 (stub, 후속)                      | 12    | chrome_click_element, chrome_fill_or_select, chrome_keyboard, chrome_javascript, chrome_close_tabs, chrome_switch_tab, chrome_get_interactive_elements, chrome_request_element_selection, chrome_read_page, chrome_computer, chrome_handle_dialog, chrome_userscript |
| 🟡 우회 구현 (stub, 후속)                     | 7     | chrome_network_capture(및 내부용 \_start/\_stop), chrome_network_request, chrome_network_debugger_start/stop, chrome_console                                                                                                                                         |
| 🔴 stub (native-only, upstream 11개)          | 11    | chrome_history, chrome_bookmark_search/add/delete, chrome_inject_script, chrome_send_command_to_inject_script, chrome_upload_file, chrome_handle_download, chrome_gif_recorder, search_tabs_content, get_windows_and_tabs                                            |
| 🔴 stub (native-only, upstream, performance)  | 3     | performance_start_trace, performance_stop_trace, performance_analyze_insight                                                                                                                                                                                         |
| 🔴 stub (native-only, fork 추가 12개, 미포팅) | 12    | chrome_request_user_consent, chrome_batch, chrome_set_work_tab, chrome_wait_for, chrome_scroll_collect, chrome_storage, chrome_save_pdf, chrome_emulate, chrome_network_rules, chrome_extract, chrome_find, chrome_shortcut                                          |

2026-09-04 이전에는 `chrome_semantic_search`·`chrome_performance_start_trace`·
`chrome_performance_stop_trace`·`chrome_performance_analyze_insight`·
`chrome_get_windows_and_tabs` 키가 실제 도구 이름과 `chrome_` 접두사가 어긋나 있어(또는 이름
자체가 달라) 절대 매치되지 않는 죽은 stub이었고, fork 추가 도구 12개는 레지스트리에 아예 없어
호출하면 "tool not found"류로 실패했다. 지금은 전부 등록돼 있고, fork 추가 12개는 개별
Playwright 구현 없이 공통 native-only stub 응답을 받는다.

stub 호출 시 응답:

```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "Tool \"chrome_bookmark_search\" is not yet implemented in the Playwright CDP fallback transport.\nReason: This tool requires native messaging mode (chrome.* extension APIs). ...\nSwitch to Primary mode to use this tool."
    }
  ]
}
```

## Why fall back to Playwright?

native messaging path 가 망가질 때 — singleton bug, Chrome 업데이트 호환성, Brave/Vivaldi 변종 등 — bridge 가 사용자 Chrome 에 직접 CDP 로 attach 해서 핵심 도구 (navigate / screenshot / get_content / ...) 를 계속 제공. 같은 인스턴스이므로 사용자 세션·로그인·확장 모두 그대로.

## Code locations

- `packages/chrome-launcher/` — Chrome 을 CDP 활성화로 띄움
- `app/native-server/src/transports/playwright/cdp-client.ts` — `chromium.connectOverCDP(...)` wrapper
- `app/native-server/src/transports/playwright/tool-registry.ts` — 48 tool dispatch table
- `app/native-server/src/transports/playwright/handlers/*.ts` — 도구별 Playwright handler
- `app/native-server/src/transports/playwright/server.ts` — Fastify on :12307

## Limitations

- **Chrome must be launched via `auto-chrome-launcher`** — 일반 Chrome (--remote-debugging-port 없이 띄운) 에는 attach 불가. 보안상 fact.
- **stub 45개** — 후속 PR 에서 점진 구현.
- **단일 Chrome 인스턴스** — multi-profile 동시 사용은 후속 (issue #347 영역).

## Disable

`unset MCP_PLAYWRIGHT_FALLBACK` (or env 안 설정) 후 bridge 재시작.
