# Regression Cases — auto-chrome-mcp

> `docs/DESIGN.md` §3 의 회귀 8 케이스 자동화 진행 상황과 사용자 환경 검증 방법.

## 8 케이스 매트릭스

| #   | 케이스                                       | 자동화 위치                                     | 상태        | 통과 기준                         |
| --- | -------------------------------------------- | ----------------------------------------------- | ----------- | --------------------------------- |
| 1   | Claude Code `initialize` 첫 회               | `src/mcp/mcp-server.test.ts`                    | ✅ 자동     | 200 OK + 새 session id            |
| 2   | Claude Code `initialize` 두 번째 (다른 세션) | `src/mcp/mcp-server.test.ts`                    | ✅ 자동     | 200 OK + 첫 세션 살아있음         |
| 3   | Cursor 연결                                  | `src/mcp/stdio-process.test.ts` (실제 프로세스) | ✅ 자동\*   | initialize → tools/list 성공      |
| 4   | Claude Desktop 연결                          | `src/mcp/stdio-process.test.ts` (실제 프로세스) | ✅ 자동\*   | initialize → tools/list 성공      |
| 5   | Chrome 144+ 에서 사용 (pagehide)             | `tests/utils/chrome144-pagehide.test.ts` (확장) | ✅ 자동\*\* | unload 리스너 0건 / pagehide 사용 |
| 6   | bridge SIGTERM 후 재시작                     | `src/mcp/bridge-restart.test.ts`                | ✅ 자동     | EOF 없이 재핸드셰이크             |
| 7   | STDIO 모드, parent 죽인 후 30초              | `src/mcp/stdio-process.test.ts` (실제 프로세스) | ✅ 자동     | bridge 자동 종료 (orphan 0)       |
| 8   | `CHROME_MCP_HOST=0.0.0.0` env                | `src/constant/index.test.ts`                    | ✅ 자동     | LAN 노출 시 URL 변경              |

**8/8 자동화 완료.** `pnpm build` 뒤 native-server `jest` + extension `vitest` 로 전부 돌아간다.
CI 는 두 군데서 실행한다 — `self-test.yml` 이 main 푸시·PR 마다, `release.yml` 이 태그마다.

> v1.8.0 이전까지 `self-test.yml` 은 **한 번도 실행된 적이 없었다** (트리거 브랜치가
> 이전 브랜치와 `master` 로 잡혀 있었는데 기본 브랜치는 `main` 이다). 게다가 vitest 는
> 어느 워크플로에도 없었다가 v1.8.0 에서 추가됐다 — 그때까지 CI 게이트를 통과한 건 jest
> 35건뿐이다. 이 문서의 "CI 가 돌린다" 는 문장을 그동안 곧이곧대로 믿으면 안 됐다.

```bash
cd app/native-server && npx jest      # 7 suites / 35 tests
cd app/chrome-extension && npx vitest run   # 55 files / 815 tests
```

### 자동화의 한계 (정직하게)

\* **#3·#4**: Cursor / Claude Desktop 을 실제로 띄우지는 않는다. 두 앱이 하는 일은 stdio 로
프로세스를 띄우고 `initialize` → `tools/list` 를 부르는 것이고, 그 왕복을 **모킹 없이 진짜
프로세스**로 검증한다. 앱 고유의 UI·설정 문제는 여전히 확장 팝업의 Self-Test 로 확인한다.

\*\* **#5**: "Chrome 144 에서 경고가 안 떴다" 를 런타임으로 증명하려면 실제 Chrome 144 가 필요하다.
대신 원인을 소스에서 고정한다 — 폐기된 `unload` 리스너가 다시 들어오면 테스트가 막는다.
(`beforeunload` 는 폐기 대상이 아니라 허용한다.)

**#7** 은 두 경로를 본다: 클라이언트가 stdin 을 정상적으로 닫는 경우와, 부모가 SIGKILL 로 갑자기
사라지는 경우(파이프 끊김 → 안 되면 부모 PID 워치독이 백업). 자식에게 stdin 을 주지 않으면
시작하자마자 EOF 로 죽어 테스트가 무의미해진다는 것도 실측으로 확인했다.

**#3·#4·#7 은 `dist` 가 필요하다** — 실제 빌드 산출물을 띄우기 때문이다. 빌드가 없으면 명확한
메시지와 함께 실패한다(조용히 건너뛰지 않는다).

## 병렬 에이전트 레인 회귀 (v1.7.0)

사용자 환경에서 나온 실패: 서브에이전트 4개를 동시에 띄우면 전원 `tab_not_found`. 실브라우저
없이 재현·고정하려고 `tests/utils/work-tab-parallel.test.ts` 에 계약을 박아 뒀다.

| 검증                                             | 왜 필요한가                                             |
| ------------------------------------------------ | ------------------------------------------------------- |
| 레인 4개의 작업 탭이 모두 살아남는다             | **원 버그 그대로** — v1.6.0 에서는 마지막 하나만 남았다 |
| lane 없이도 유예 안의 병렬 탭은 안 닫힌다        | 레인을 안 쓰는 기존 호출의 2차 방어선                   |
| 유예 밖 유휴 탭 / 레인당 상한 초과분은 정리된다  | 정리를 느슨하게 만든 대가로 탭이 쌓이면 안 된다         |
| 다른 레인 탭은 방치(15분) 전엔 안 건드린다       | 남의 병렬 작업을 끊지 않으면서 유령 탭은 회수           |
| 실행 중 / 사용자가 보는 탭은 절대 안 닫는다      | 사용자 눈앞의 탭을 닫는 사고 방지                       |
| 구버전 저장 형식(`number[]`) 을 읽어도 안 깨진다 | 브라우저를 안 껐는데 확장만 갱신되는 실제 경로          |

`tests/utils/tool-schema-lane.test.ts` 는 `lane` 이 탭 대상 도구에만 붙고, 어느 도구에서도
필수가 되지 않는지를 지킨다(주입이 조용히 깨지거나 기존 호출을 망가뜨리는 것 방지).
automation-guard 테스트에는 레인별 반복 카운터 분리가 추가됐다.

**실브라우저 확인 방법**: 확장 리로드 + Claude Code 재시작 후, 서브에이전트 4개에게 각각
`lane: "agent-1..4"` 를 주고 서로 다른 사이트를 열게 한다. 크롬에 탭 4개가 동시에 남아 있고
어느 에이전트도 `tab_not_found` 를 만나지 않아야 한다.

**실브라우저 검증 완료 (2026-08-24)**: 위 절차대로 에이전트 4개를 동시 실행했다. 각 에이전트가
`navigate → read_page(tabId 생략) → navigate(newTab:true) → read_page → 첫 탭 재navigate` 를
돌렸고 결과는:

- MCP 탭 **8개(에이전트당 2개)가 전부 동시 생존**, 사용자가 열어 둔 탭 8개도 그대로.
- `get_windows_and_tabs` 의 `mcpWorkTabSessions` 가 `stdio-8772-w48b1v::agent-1..4` 로 표시 —
  **세션 id 는 넷 다 동일**(서브에이전트가 stdio 프로세스를 공유한다는 것의 실측 증거)하고
  레인만 갈렸다.
- `tabId` 를 생략한 `read_page` 가 4개 레인 모두 자기 작업 탭을 정확히 타깃했다.
- `tab_not_found` **0건**. 각 에이전트의 첫 탭은 다른 레인이 새 탭을 만든 뒤에도 살아남아
  재navigate 에 성공했다.
- agent-1 은 `example.com` 로드가 타임아웃돼 80초를 소비했는데, 그 사이 다른 레인 3개가 탭을
  6개 만들었음에도 agent-1 의 탭은 회수되지 않았다 — 유예·보호 규칙이 실제로 작동한다.

관측된 에러 2종은 레인과 무관한 콘텐츠 문제였다: `Accessibility tree is too sparse`
(example.com/org 처럼 요소가 거의 없는 페이지를 `filter:"interactive"` 로 읽음),
`Frame with ID 0 is showing error page` (example.com 로드 실패). 둘 다 에러에 실린 `tabId` 가
해당 레인의 탭과 일치해, 오히려 레인 라우팅이 정확했다는 증거가 됐다.

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

## 무간섭 모드 회귀 — 사용자 활성 탭 불변 (v1.9.0)

사용자 환경에서 나온 실패: "MCP 가 새 크롬 탭을 띄우면 백그라운드에 머물지 않고 실제로 앞에
떠서, 내가 PC 를 쓰는 중에 방해가 된다."

### 자동 (`tests/utils/`)

| 파일                                           | 무엇을 고정하나                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no-interference-mode.test.ts`                 | 전용 작업 창 배치 3종, 최소화 전 워밍업 성공/실패 분기, 지연 이중 비포커스와 사용자 창 복귀, 사용자가 다른 앱으로 옮기면 복귀 취소, `width`/`height` 는 창을 안 만들고 뷰포트 에뮬레이션, `newWindow:true` 는 관리자 경로, navigate 폴백 두 곳이 활성 탭을 안 만듦, 배치 설정 기본값·저장값, 활성화 가드의 판정 4줄 |
| `no-interference-tool-sweep.test.ts`           | **등록된 비예외 도구 40개를 대표 인자로 한 번씩 실행**해, 전용 작업 창 밖의 탭에 `active:true` 가 가거나 `focused:true` 가 나가면 실패. fixture 의 도구 이름 집합이 `TOOL_SCHEMAS` 와 어긋나도 실패하므로 **새 도구를 fixture 없이 추가할 수 없다**                                                                 |
| `background-mode.test.ts`                      | 작업 창 모드 기본값(`dedicated`)과 구버전 키 마이그레이션 의미                                                                                                                                                                                                                                                      |
| `record-replay/tab-cursor.integration.test.ts` | 플로우 `openTab`/`switchTab` 의 새 동작(+ `foreground:true` 예외)                                                                                                                                                                                                                                                   |

### 실기 (실제 크롬, 배포 후 — 2026-09-02 실행 결과)

1. 사용자 창의 활성 탭 id 와 `windows.getLastFocused().id` 를 기록한다.
2. 새 세션에서 `chrome_navigate`(example.com → news.ycombinator.com), `chrome_screenshot`
   3종(뷰포트·전체·요소), `chrome_click_element`, `chrome_get_web_content`,
   `chrome_read_page`, `chrome_scroll_collect` 를 실행한다.
3. 1의 두 값이 그대로여야 한다.
4. 스크린샷 3종이 실제 페이지를 담아야 한다(단색 아님). 파일로 저장했다면 색 수를 세어
   기계적으로도 확인한다.
5. 바탕화면 작업 영역에 새 창이 나타나지 않아야 한다(작업 표시줄 항목은 허용).

| 항목                          | 실행 전               | 실행 후               |
| ----------------------------- | --------------------- | --------------------- |
| 사용자 창 id                  | 384623014 (maximized) | 384623014 (maximized) |
| 사용자 창의 활성 탭 id        | 384623194             | 384623194             |
| `windows.getLastFocused().id` | 384623014             | 384623014             |
| MCP 작업 창                   | 384623237 (minimized) | 384623237 (minimized) |

전부 통과. 스크린샷 18장(example.com·news.ycombinator.com × 뷰포트·전체·요소 × 3회)이 모두
정상이었고, 저장본의 색 수는 154~598 로 빈 이미지가 아니었다.

### 이 회귀를 볼 때 알아야 할 실측 사실

- **한 번도 그려지지 않은 창을 최소화하면 그 창의 CDP 캡처가 영영 안 돌아온다.** 그래서 최소화
  전에 프레임을 1장 강제로 뽑는다(워밍업). 이 순서가 깨지면 `chrome_screenshot` 이 타임아웃으로
  멎는다 — 회귀가 났을 때 가장 먼저 의심할 곳이다.
- **최소화된 창에서는 그 창의 활성 탭만 캡처된다.** 병렬 lane 으로 작업 창에 탭이 여러 개면
  캡처 대상 탭을 그 창 안에서 활성화해야 한다(`screenshot.ts` 가 처리).
- **오프스크린 좌표는 크롬이 거부한다**(`Bounds must be at least 50% within visible screen space`).
  `offscreen` 배치를 골라도 실제로는 최소화로 대체된다.

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
CHROME_MCP_HOST=0.0.0.0 auto-chrome-mcp-bridge
# → 서버가 0.0.0.0:12306 에 listen
```
