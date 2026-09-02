# Upstream Diff — auto-chrome-mcp vs hangwin/mcp-chrome

**Last sync**: 2026-05-25 (fork 생성일)
**Baseline commit**: `f48e71751e00bc09725c7e173423cff4f2ccd12a` (upstream master @ Merge PR #272)
**Upstream**: https://github.com/hangwin/mcp-chrome

이 fork 는 upstream 의 다음 7 PR 을 흡수하고, 4 신규 컴포넌트를 추가한다.

## 흡수한 upstream OPEN PR (cherry-pick 대상)

| 상태 | PR #                                                   | 제목                                                         | 영역                                      | 흡수 commit                  | retire 조건              |
| ---- | ------------------------------------------------------ | ------------------------------------------------------------ | ----------------------------------------- | ---------------------------- | ------------------------ |
| ✅   | [#346](https://github.com/hangwin/mcp-chrome/pull/346) | fix(native-server): use per-session MCP Server factory       | `app/native-server/src/mcp/mcp-server.ts` | `2ade997`                    | upstream 머지 시         |
| 🟡   | [#338](https://github.com/hangwin/mcp-chrome/pull/338) | fix: prevent sequential Streamable HTTP clients from failing | `app/native-server/src/server/index.ts`   | `dd68835` (partial, cleanup) | upstream 머지 시         |
| ✅   | [#312](https://github.com/hangwin/mcp-chrome/pull/312) | fix: handle stale MCP client reconnection                    | `mcp-server-stdio.ts` EOF 핸들러          | `fe79ca6`                    | upstream 머지 시         |
| ✅   | [#302](https://github.com/hangwin/mcp-chrome/pull/302) | fix(stdio): session cleanup on exit                          | stdio transport                           | `39d5edf` + `375ba07`        | upstream 머지 시         |
| 🟢   | [#304](https://github.com/hangwin/mcp-chrome/pull/304) | fix: exit stdio server when parent process dies              | stdio transport                           | (#302 superset 으로 cover)   | #302 머지 시 같이 retire |
| ✅   | [#329](https://github.com/hangwin/mcp-chrome/pull/329) | fix: replace deprecated unload event with pagehide           | extension content scripts                 | `a10e22e`                    | upstream 머지 시         |
| ✅   | [#313](https://github.com/hangwin/mcp-chrome/pull/313) | feat(constant): add CHROME_MCP_HOST env support              | constant.ts                               | `d9f8011`                    | upstream 머지 시         |

**범례**: ✅ 완전 흡수 / 🟡 부분 흡수 (#346 와 중복 제외) / 🟢 다른 PR 의 superset 으로 cover

## 신규 컴포넌트 (fork 전용)

| 컴포넌트                | 위치                                            | 설계                                    |
| ----------------------- | ----------------------------------------------- | --------------------------------------- |
| `connection-supervisor` | `app/native-server/src/supervisor/`             | Force Reconnect 5단계 A→B→C escalation  |
| `playwright-fallback`   | `app/native-server/src/transports/playwright/`  | CDP attach + 33 도구 미러 (18+7+8 stub) |
| `chrome-launcher`       | `packages/chrome-launcher/`                     | OS 분기 launcher 스크립트               |
| `diagnostic-ui`         | `app/chrome-extension/src/views/Diagnostic.vue` | 4 stage indicator + Self-Test           |

## 신규 패키지 명명

| 컴포넌트              | upstream 이름                | fork 이름                                                        |
| --------------------- | ---------------------------- | ---------------------------------------------------------------- |
| monorepo root         | `mcp-chrome-bridge-monorepo` | `auto-chrome-mcp-monorepo`                                       |
| native server npm pkg | `mcp-chrome-bridge`          | `auto-chrome-mcp-bridge`                                         |
| extension             | `chrome-mcp-server`          | `auto-chrome-mcp-extension`                                      |
| shared                | `chrome-mcp-shared`          | `auto-chrome-mcp-shared` (rename — npm publish 위해 unique name) |
| wasm-simd             | `@chrome-mcp/wasm-simd`      | `@chrome-mcp/wasm-simd` (변경 X)                                 |
| 신규                  | —                            | `auto-chrome-mcp-launcher`                                       |

## upstream 의도적 제거 (fork divergence)

| upstream commit                   | upstream 도입 시점 | 제거 영역                                                                                                                                                                                          | 제거 사유                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `704e04d` ("feat: add cli agent") | 2025-12-15         | `app/native-server/src/agent/` (chat-service, db, engines, services) + `server/routes/agent.ts` + chrome extension 의 `AgentChat.vue`, `agent-chat/`, `agent/` 디렉토리, 12개 agent-\* composables | upstream 이 추가한 cli-agent (sidepanel 안 채팅 UI + Claude/Codex 엔진) 가 **`better-sqlite3` native 모듈을 요구** → 사용자 install 시 Python / VS Build Tools / Xcode CLT 필요. 우리 fork 의 명시적 시나리오 (Claude Code → chrome-mcp-stdio → MCP 33 도구) 는 agent chat 을 안 씀. v1.0.36 에서 통째 제거 → 옛날 hangwin (2025-12-15 이전) install 경험 복원. `better-sqlite3` + `drizzle-orm` + `@anthropic-ai/claude-agent-sdk` 3개 dep 일소. |

upstream 과의 sync 정책: 위 영역의 변경은 **흡수 안 함**. agent 디렉토리 또는 agent route 가 다시 update 되어도 retire 가 아니라 무시 (intentional divergence).

## 동기화 로그

| 일자       | upstream SHA | 작업                                                                                                                                                                                   | 비고                                                                                                                                        |
| ---------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-25 | `f48e717`    | fork 생성, baseline 박제                                                                                                                                                               | 초기                                                                                                                                        |
| 2026-05-25 | `f48e717`    | 7 PR 흡수 완료 (#346, #338 partial, #312, #302, #329, #313 / #304 = #302 superset 으로 skip)                                                                                           | Phase 1 L1 baseline. full build (shared+native+extension) 모두 통과                                                                         |
| 2026-05-25 | `f48e717`    | **v1.0.0 release** — L1~L5 모두 완료, Phase 6 final validation 통과                                                                                                                    | jest 13/13 통과, build native+extension+launcher 모두 OK, CI workflows ready                                                                |
| 2026-06-01 | `f48e717`    | **v1.0.36** — upstream `704e04d` (cli-agent) 통째 제거. `better-sqlite3`/`drizzle-orm`/`@anthropic-ai/claude-agent-sdk` 제거 → Python 요구 영구 소멸. Windows postinstall 빈 폴더 fix. | jest 13/13, build (native + extension) 통과. 자세한 설계 → `docs/plans/2026-06-01-strip-sqlite-agent-and-fix-windows-postinstall-design.md` |
