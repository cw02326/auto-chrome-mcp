# Regression Cases — mcp-chrome-scalemaker

> `docs/DESIGN.md` §3 의 회귀 8 케이스 자동화 진행 상황과 사용자 환경 검증 방법.

## 8 케이스 매트릭스

| #   | 케이스                                       | 자동화 위치                                                      | 상태                             | 통과 기준                         |
| --- | -------------------------------------------- | ---------------------------------------------------------------- | -------------------------------- | --------------------------------- |
| 1   | Claude Code `initialize` 첫 회               | `src/mcp/mcp-server.test.ts` (단위) + Phase 4 Self-Test (사용자) | ✅ 단위 통과 / 🟡 Self-Test 후속 | 200 OK + 새 session id            |
| 2   | Claude Code `initialize` 두 번째 (다른 세션) | `src/mcp/mcp-server.test.ts` (factory + transport 격리 검증)     | ✅ 단위 통과                     | 200 OK + 첫 세션 살아있음         |
| 3   | Cursor 연결                                  | Phase 4 Self-Test + 사용자 환경 manual                           | 🟡 후속                          | tools/list 성공                   |
| 4   | Claude Desktop 연결                          | Phase 4 Self-Test + 사용자 환경 manual                           | 🟡 후속                          | tools/list 성공                   |
| 5   | Chrome 144+ 에서 사용 (pagehide)             | extension vitest (후속) + Phase 4 manual                         | 🟡 후속                          | unload deprecation warning 무발생 |
| 6   | bridge SIGTERM 후 재시작                     | Phase 4 Self-Test + 사용자 환경 manual                           | 🟡 후속                          | EOF 없이 재핸드셰이크             |
| 7   | STDIO 모드, parent 죽인 후 30초              | child_process 시뮬레이션 (후속)                                  | 🟡 후속                          | bridge 자동 종료 (orphan 0)       |
| 8   | `CHROME_MCP_HOST=0.0.0.0` env                | `src/constant/index.test.ts` (10 tests)                          | ✅ 단위 통과                     | LAN 노출 시 URL 변경              |

**범례**: ✅ 자동화 완료 / 🟡 Phase 4 (Self-Test) 또는 후속 phase 에서 자동화

## 현재 자동화 상태 (Phase 1 마감)

```bash
$ cd app/native-server && pnpm test
Test Suites: 3 passed, 3 total
Tests:       13 passed, 13 total
```

자동 검증되는 케이스: **#1, #2, #8** (직접) — PR #346 + PR #313 흡수의 핵심.

## fork policy — jest config

upstream 의 `coverageThreshold: { global: { branches: 70, functions: 80, lines: 80, statements: 80 } }` 는 회귀 통합 테스트 추가만으로는 못 채워서 PR 흡수 검증을 차단함. fork 는:

- **coverageThreshold 제거** — 회귀 충실성 우선, coverage 는 측정만 (CI 의 self-test.yml 에서 report 만 출력)
- **moduleNameMapper 추가** — `'\\.js$' → '$1'` (baseline `server.test.ts` 가 `'../constant/index.js'` import 때문에 항상 fail 이었던 것 fix)

## 후속 자동화 계획 (Phase 4·Phase 5)

| Phase                         | 작업                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Phase 4 — Diagnostic UI       | extension 의 Self-Test 버튼 = 케이스 1·2·3·4·6 을 사용자 환경에서 1 클릭 실행                                             |
| Phase 5 — CI                  | `.github/workflows/self-test.yml` = PR 마다 8 케이스 중 자동화 가능한 것 모두 (child_process 로 케이스 7 시뮬레이션 포함) |
| Phase 3 — Playwright fallback | Playwright e2e = 케이스 3·4 의 실 클라이언트 시나리오 (mock client OK)                                                    |

## 사용자 환경 manual 검증 (Phase 4 가 ready 되기 전)

```bash
# 1. 두 번째 세션 살아있음 검증 (수동)
curl -X POST http://127.0.0.1:12306/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"a","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test-a","version":"1.0"}}}'
# → 200 OK, session id 받기

curl -X POST http://127.0.0.1:12306/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"b","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test-b","version":"1.0"}}}'
# → 200 OK, 다른 session id 받기

# 두 session id 모두 살아있어야 함 (factory pattern 검증)

# 8. LAN 노출 검증
CHROME_MCP_HOST=0.0.0.0 mcp-chrome-scalemaker-bridge
# → 서버가 0.0.0.0:12306 에 listen
```
