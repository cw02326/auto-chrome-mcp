# auto-chrome-mcp — Fork 설계 (2026-05-25)

> **상태**: 디자인 합의 완료, implementation 미착수
> **베이스**: [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome) `master @ commit TBD` (11.7k stars, TS/Vue monorepo)
> **fork repo**: `cw02326/auto-chrome-mcp` (예정, 별도 npm 패키지 + GitHub Releases 사이드로드 extension)
> **brainstorming 일자**: 2026-05-25
> **합의 결정 5개**: (1) scope = L1+L2+L3+L4 풀패키지 / (2) Playwright 진입 = Chrome Launcher 별도 / (3) Force Reconnect = A→B→C 점진 escalation / (4) Playwright 미러 = 33 도구 전체 (native-only stub) / (5) fork 위치 = GitHub 별도 repo + npm 배포

---

## 0. 동기 — 왜 fork 가 유일한 답인가

### 사용자 증상 ("연결 안 됨" 의 3 패턴 동시 발생)

1. 첫 연결 성공, 두 번째부터 막힘
2. 처음부터 아예 연결 안 됨
3. 확장은 초록불인데 Claude Code 만 못 봄

→ 셋 다 가끔씩, 재현 불안정 — 단일 패치로 못 푸는 누적 버그

### 진단 결과 (3 트랙 리서치)

**root cause 1 — Singleton transport bug** (압도적 1순위, [#306](https://github.com/hangwin/mcp-chrome/issues/306)·[#321](https://github.com/hangwin/mcp-chrome/issues/321)·[#346](https://github.com/hangwin/mcp-chrome/pull/346))

`mcp-chrome-bridge` 의 `mcp-server.js` 의 `getMcpServer()` 가 싱글톤 → MCP SDK 의 `Server.connect(transport)` 가 `_transport` 를 덮어씀 → 두 번째 클라이언트 `initialize` 보내면 첫 번째 session 의 transport 가 orphan → 첫 세션 "잠긴 듯" 안 됨.

- 임시 우회 1: `pkill -9 -f mcp-chrome-bridge` (issue #306 의 ColaMint 댓글)
- 임시 우회 2: 매 세션 시작할 때 extension 에서 Disconnect → Connect + Claude Code `/mcp reconnect`
- 진짜 fix: factory 패턴 (`createMcpServer()` per session) — PR #346
- **수정 위치**: `~/.npm-global/lib/node_modules/mcp-chrome-bridge/dist/mcp/mcp-server.js`

**root cause 2 — ERR_HTTP_HEADERS_SENT** (Hono + StreamableHTTPServerTransport double-response, [#349](https://github.com/hangwin/mcp-chrome/issues/349))

두 번째 호출 때 500 에러. SDK 의 `handleRequest(req, res, body)` 가 Node `ServerResponse` 에 직접 쓴 후, Hono 라우트가 또 Response 반환 → headers 두 번 전송 시도.

**root cause 3 — stale process 12306 점유** (사용자 가설, 실측 상 #1 의 외관)

브릿지 죽었는데 포트 점유 잔존. 흔치 않음. SO_REUSEPORT 같은 단순 강제 점유는 두 인스턴스 충돌로 더 망함.

### 6 패턴 그룹 (50+ open issues + 30 PRs 정독 후)

| 그룹                             | 증상 키                                       | 인기 이슈                                                                                                                                                                                                                                                                                                                                                                       | 매치 PR (모두 OPEN, fork 흡수 후보)                                       |
| -------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 🔴 A Singleton transport         | "已连接, 服务未启动" / 노란불 / 첫 회 후 실패 | [#198](https://github.com/hangwin/mcp-chrome/issues/198) (11c) · [#137](https://github.com/hangwin/mcp-chrome/issues/137) (7c) · [#306](https://github.com/hangwin/mcp-chrome/issues/306) (9c) · [#321](https://github.com/hangwin/mcp-chrome/issues/321) · [#342](https://github.com/hangwin/mcp-chrome/issues/342) · [#332](https://github.com/hangwin/mcp-chrome/issues/332) | **#346** (factory pattern + 테스트) · #301 · #295                         |
| 🟠 B Stale reconnect / EOF       | "Already connected" / EOF 재연결 실패         | [#306](https://github.com/hangwin/mcp-chrome/issues/306)                                                                                                                                                                                                                                                                                                                        | **#312** (stale client reconnection) · **#338** (sequential HTTP clients) |
| 🟡 C STDIO 종료 청소             | parent 죽어도 살아남음                        | —                                                                                                                                                                                                                                                                                                                                                                               | **#304** (parent stdin close 시 exit) · **#302** (session cleanup)        |
| 🟢 D Chrome 144+ 호환            | 144 업데이트 후 deprecated unload             | [#288](https://github.com/hangwin/mcp-chrome/issues/288)                                                                                                                                                                                                                                                                                                                        | **#329** (pagehide 대체)                                                  |
| 🔵 E Native msg Chromium 변형    | Brave/Vivaldi 에서 host 못 찾음               | [#196](https://github.com/hangwin/mcp-chrome/issues/196)                                                                                                                                                                                                                                                                                                                        | —                                                                         |
| 🟣 F 다중 프로파일/멀티 인스턴스 | 두 Chrome 동시 X                              | [#347](https://github.com/hangwin/mcp-chrome/issues/347) · [#345](https://github.com/hangwin/mcp-chrome/issues/345)                                                                                                                                                                                                                                                             | — (이번 fork 범위 밖)                                                     |

### 결정적 시사점

- **PR #346 등 핵심 fix 가 OPEN 인 채로 5+ 개월** — upstream 머지 활동 둔화 → **fork 가 사실상 유일한 해**. 비슷한 fork 시도 (PR 만 떠 있고 머지 안 됨) 있지만 통합본 없음
- 사용자가 보는 "셋 다 가끔씩" = A + B + C + D 누적 → **6 PR 흡수 + Force Reconnect 슈퍼 버튼 + Playwright 폴백** 의 **fork 디스트리뷰션** 으로 풀어야 함

### 유사 패키지 비교 (대안 평가)

| 도구                                 | 메커니즘                                               | 사용자 케이스 정합도                             |
| ------------------------------------ | ------------------------------------------------------ | ------------------------------------------------ |
| **playwright-mcp** (MS 공식)         | 새 Chromium spawn, isolated profile                    | ❌ 기존 Chrome 세션·로그인 못 씀                 |
| **chrome-devtools-mcp** (Google)     | CDP 직접                                               | 🟡 Chrome 띄울 때 `--remote-debugging-port` 필요 |
| **playwriter** (remorses/playwriter) | Chrome 확장 + Playwright snippet, 사용자 Chrome attach | ✅ 컨셉 가장 비슷 — 폴백 후보                    |
| **browser-use**                      | Playwright 기반 headless                               | ❌ 세션 분리                                     |

→ mcp-chrome 의 "사용자 daily Chrome 세션 그대로 사용" 가치 명제는 유지하면서, 신뢰성을 fork 가 보강하는 게 핵심.

---

## 1. Architecture & 전체 그림

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                       auto-chrome-mcp (fork of hangwin/mcp-chrome)         │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│   Claude Code                                                                   │
│      │                                                                          │
│      │  HTTP 12306/mcp (primary)                                                │
│      │  HTTP 12307/mcp (fallback, Playwright transport)                         │
│      ▼                                                                          │
│   ┌────────────────────────────────────────────┐                                │
│   │  bridge process (mcp-chrome-scalemaker-     │                                │
│   │  bridge npm pkg)                           │                                │
│   │                                            │                                │
│   │  ┌────────────────┐  ┌───────────────────┐ │                                │
│   │  │ Primary Path:  │  │ Fallback Path:    │ │                                │
│   │  │ MCP factory*   │  │ Playwright CDP    │ │                                │
│   │  │ (per-session)  │  │ chromium.connect  │ │                                │
│   │  │                │  │ OverCDP(:9222)    │ │                                │
│   │  └────────┬───────┘  └─────────┬─────────┘ │                                │
│   │           │                     │           │                                │
│   │           ▼                     │           │                                │
│   │   Native Messaging              │           │                                │
│   │           │                     │           │                                │
│   └───────────┼─────────────────────┼───────────┘                                │
│               │                     │                                            │
│               ▼                     ▼                                            │
│   ┌────────────────────────┐   ┌────────────────────────────────────┐           │
│   │  Chrome Extension      │   │  사용자 Chrome (--remote-debugging-  │           │
│   │  (Vue + TS, our fork)  │   │  port=9222, launcher 가 띄움)        │           │
│   │  - Connect 슈퍼버튼    │   │  같은 프로파일·로그인·탭 공유          │           │
│   │  - 4 stage indicator   │   │                                    │           │
│   │  - Health probe        │   └────────────────────────────────────┘           │
│   └────────────────────────┘                                                    │
│                                                                                 │
│   * factory pattern = PR #346 흡수 — singleton 제거                              │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 4 신규 컴포넌트 (fork 가 신설)

| 코드명                  | 위치                                            | 책임                                                                                                                |
| ----------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `connection-supervisor` | `app/native-server/src/supervisor/`             | Force Reconnect 5단계 (kill→port→spawn→handshake→ping) 오케스트레이션, A→B→C escalation                             |
| `playwright-fallback`   | `app/native-server/src/transports/playwright/`  | CDP attach + 33개 도구 미러, 별도 HTTP 서버 12307                                                                   |
| `chrome-launcher`       | `packages/chrome-launcher/`                     | OS 분기 셸 (`.command` / `.bat` / `.sh`), 사용자 default Chrome 프로파일 자동 감지 + `--remote-debugging-port=9222` |
| `diagnostic-ui`         | `app/chrome-extension/src/views/Diagnostic.vue` | 4 stage indicator (process · port · handshake · MCP) 실시간 표시 + Self-Test                                        |

### 통신 경로 요약

- **12306** = 기존 native messaging 경로 (primary)
- **12307** = Playwright CDP 폴백 (별도 포트, 별도 transport)
- **9222** = Chrome CDP endpoint (launcher 가 활성화)
- Playwright 폴백은 bridge 가 살아있는 동안에도 사용자 토글로 강제 전환 가능
- bridge process = npm 글로벌 패키지, `npm i -g mcp-chrome-scalemaker-bridge`

---

## 2. L1 — 흡수할 7 PR 매트릭스

### 흡수 대상 (모두 upstream OPEN, 5+ 개월 머지 안 됨)

| 순서 | PR                              | 영역                                                       | 충돌 위험            | 비고                                                    |
| ---- | ------------------------------- | ---------------------------------------------------------- | -------------------- | ------------------------------------------------------- |
| 1    | **#346** factory pattern        | `app/native-server/src/mcp/mcp-server.ts` (singleton 제거) | —                    | **베이스라인, 가장 정제** (테스트 포함)                 |
| 2    | #338 sequential clients         | 같은 파일 영역                                             | 🔴 #346 과 중복      | diff 비교 후 #346 이 cover 안 하는 케이스만 cherry-pick |
| 3    | #312 stale reconnect            | `app/native-server/src/transports/http.ts` (가설)          | 🟢 별도 영역         | EOF 재연결 처리                                         |
| 4    | #302 stdio session cleanup      | `app/native-server/src/transports/stdio.ts`                | 🟡 #304 와 중복 가능 | diff 비교                                               |
| 5    | #304 stdio exit on parent death | 같은 파일                                                  | 🟡 #302 와 중복 가능 | 차이 = parent SIGCHLD 감지 vs onExit                    |
| 6    | #329 pagehide for Chrome 120+   | `app/chrome-extension/src/background.ts`                   | 🟢 별도 영역         | Chrome 144+ 호환                                        |
| 7    | #313 `CHROME_MCP_HOST` env      | constant.ts                                                | 🟢 별도 영역         | L5 보너스 (포트 충돌 시 회피)                           |

### 흡수 작업 흐름 (브랜치 시퀀스)

```
master (upstream fork point)
   │
   ▼
[branch: ingest-pr-346]   ─ #346 cherry-pick + 테스트 통과 확인
   │
   ▼
[branch: ingest-pr-338]   ─ #338 diff 와 비교, 잔여 케이스만 추가 / 또는 SKIP
   │
   ▼
[branch: ingest-pr-312]   ─ #312 cherry-pick
   │
   ▼
[branch: ingest-stdio]    ─ #302, #304 diff 비교 후 union 으로 한 번에
   │
   ▼
[branch: ingest-pr-329]   ─ #329 cherry-pick
   │
   ▼
[branch: ingest-pr-313]   ─ #313 cherry-pick
   │
   ▼
[branch: main-scalemaker]  ─ 모두 합본 + 회귀 8 케이스 통과
```

### 회귀 8 케이스 (각 흡수 후 통과 의무)

| #   | 케이스                                       | 통과 기준                                     |
| --- | -------------------------------------------- | --------------------------------------------- |
| 1   | Claude Code `initialize` 첫 회               | 200 OK, 새 session id                         |
| 2   | Claude Code `initialize` 두 번째 (다른 세션) | 200 OK, **첫 세션 살아있음** (← #346 의 핵심) |
| 3   | Cursor 연결                                  | tools/list 성공                               |
| 4   | Claude Desktop 연결                          | tools/list 성공                               |
| 5   | Chrome 144+ 에서 사용                        | pagehide 동작                                 |
| 6   | bridge SIGTERM 후 재시작                     | EOF 없이 재핸드셰이크                         |
| 7   | STDIO 모드, parent 죽인 후 30초              | bridge 자동 종료 (orphan 0)                   |
| 8   | `CHROME_MCP_HOST=0.0.0.0` env                | LAN 노출                                      |

---

## 3. L2 — Force Reconnect 5단계 슈퍼 버튼

### 동작 흐름 — A→B→C 점진 escalation

Connect 버튼 클릭 = 항상 5단계 자동 실행. 실패 시 escalation 권유 다이얼로그.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  [Connect] 클릭                                                              │
│                                                                              │
│  ──── Stage A: 청소 + 재시작 (자동, 사용자 컨펌 X) ────                       │
│   ① process kill          pkill mcp-chrome-bridge (macOS/Linux)             │
│                           taskkill /F /IM mcp-chrome-bridge.exe (Windows)    │
│                           ⏱ 1s 대기                                          │
│                                                                              │
│   ② port free probe       lsof -ti:12306 → 잔존 PID 있으면 SIGKILL          │
│                           netstat -ano | findstr :12306 (Windows)            │
│                           ⏱ 0.5s · 최대 5회 retry                            │
│                                                                              │
│   ③ bridge spawn          mcp-chrome-bridge --port=12306                     │
│                           readiness probe (GET /health 200 까지 backoff)    │
│                           ⏱ max 10s                                          │
│                                                                              │
│   ④ native handshake      extension → bridge 핸드셰이크 ping                │
│                           ⏱ max 3s · 3회 retry                               │
│                                                                              │
│   ⑤ MCP initialize ping   POST /mcp { jsonrpc: initialize }                 │
│                           200 OK + sessionId 검증                            │
│                           ⏱ max 5s · 5회 retry                               │
│                                                                              │
│   ✅ 모두 통과 → done                                                        │
│   ❌ ③·④·⑤ 중 하나 실패 → Stage B 자동 진입                                  │
│                                                                              │
│  ──── Stage B: native messaging host 재등록 (자동) ────                     │
│   ⓐ manifest 경로 검증     macOS: ~/Library/Application Support/Google/      │
│                             Chrome/NativeMessagingHosts/                      │
│                             com.chromemcp.nativehost.json                    │
│                            Windows: HKCU\Software\Google\Chrome\             │
│                             NativeMessagingHosts (registry)                  │
│                            Linux: ~/.config/google-chrome/                    │
│                             NativeMessagingHosts/                            │
│                                                                              │
│   ⓑ 재설치                 `mcp-chrome-bridge install` (npm 패키지의           │
│                             CLI 명령) 자동 호출 → manifest 재생성·재등록      │
│                                                                              │
│   ⓒ Stage A 재시도         ②~⑤ 한 번 더                                     │
│                                                                              │
│   ✅ 통과 → done                                                             │
│   ❌ 실패 → Stage C 다이얼로그                                               │
│                                                                              │
│  ──── Stage C: Chrome 재시작 (사용자 confirm 필수) ────                     │
│   다이얼로그: "Chrome 을 종료 후 launcher 로 재시작하면 해결 가능성 높음.    │
│                현재 열린 탭은 Chrome 의 'Continue where you left off'        │
│                설정으로 복원 가능. 진행하시겠어요? [Yes / No]"                │
│                                                                              │
│   Yes → Chrome 프로세스 SIGTERM → 5s 대기 → launcher 실행                    │
│   No  → "Playwright 폴백 모드로 전환할까요?" 다이얼로그                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Extension UI 변화

```
┌──────────────────────────────────────────────────┐
│  Chrome MCP Server (auto-chrome-mcp fork)              │
├──────────────────────────────────────────────────┤
│                                                  │
│  [  ⚡ Force Reconnect  ]   ← 메인 액션 버튼      │
│                                                  │
│  ─── Connection Health ───                       │
│   ✅ Bridge process       (pid 12345)            │
│   ✅ Port 12306           (free)                 │
│   ✅ Native messaging     (handshake ok)         │
│   ✅ MCP transport        (session: a1b2c3)      │
│                                                  │
│  ─── Mode ───                                    │
│   ● Primary (native)                             │
│   ○ Playwright fallback (CDP :9222)              │
│                                                  │
│  ─── Logs (최근 10줄) ───                        │
│   18:42:11  Stage A start                        │
│   18:42:12  ① process kill ok                    │
│   18:42:12  ② port 12306 freed                   │
│   18:42:14  ③ bridge spawned (pid 12345)         │
│   18:42:14  ④ handshake ok                       │
│   18:42:15  ⑤ MCP initialize ok                  │
│   18:42:15  ✅ Connected                         │
│                                                  │
│  [ Open Diagnostic Report ]  ← L4 진단 UI 진입   │
└──────────────────────────────────────────────────┘
```

### 보안 핸드프린트 — pkill 권한 위험

- 사용자 권한 안에서만 kill (`-9 -f mcp-chrome-bridge` 패턴 lock — 다른 프로세스 절대 X)
- extension 자체는 sandbox 라 직접 pkill 못 함 → **bridge process 가 자기 자신을 죽이는 self-suicide RPC 엔드포인트** (POST `/admin/restart`) 가 필요. 호출 받으면 graceful drain → exit → systemd/launchd 없으니 chrome native messaging 의 auto-respawn 에 의존
- ③ spawn 은 실제로는 "Chrome 이 native messaging 으로 bridge 를 자동 spawn" 의존 — extension 이 `chrome.runtime.connectNative` 호출하면 Chrome 이 bridge 새로 띄움

---

## 4. L3 — Chrome Launcher + Playwright CDP 폴백

### Chrome Launcher 패키지 (`packages/chrome-launcher/`)

**목적**: 사용자가 Chrome 을 일반적으로 띄우는 대신 launcher 로 띄우면, 자동으로 CDP 활성화 + 기존 프로파일·로그인 보존. 1회 진입장벽 극복 후 영원히 사용.

```
packages/chrome-launcher/
├── README.md                          ← 설치·사용법 + OS별 안내
├── bin/
│   ├── scalemaker-chrome.command       ← macOS (더블클릭 가능)
│   ├── scalemaker-chrome.bat           ← Windows
│   └── scalemaker-chrome.sh            ← Linux
├── src/
│   ├── detect-profile.ts              ← OS 별 default Chrome user-data-dir 자동 감지
│   ├── detect-binary.ts               ← Chrome 실행 파일 경로 감지
│   ├── ensure-port-free.ts            ← 9222 점유 시 9223, 9224... 자동 escalation
│   └── launch.ts                      ← 메인 진입점
└── package.json
```

### OS 분기 — Chrome user-data-dir 자동 감지

| OS      | Chrome binary                                                  | user-data-dir                                 |
| ------- | -------------------------------------------------------------- | --------------------------------------------- |
| macOS   | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` | `~/Library/Application Support/Google/Chrome` |
| Windows | `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`          | `%LOCALAPPDATA%\Google\Chrome\User Data`      |
| Linux   | `/usr/bin/google-chrome`                                       | `~/.config/google-chrome`                     |

### Launcher 실행 흐름

```
1. detect-binary → Chrome 실행 파일 발견
2. detect-profile → user-data-dir 자동 감지
3. ensure-port-free → 9222 점유 검사
     - 점유 X → 9222 사용
     - 점유 O 가 auto-chrome-mcp 가 띄운 거면 → 그 인스턴스 재사용 (skip launch)
     - 점유 O 가 다른 거면 → 9223 → 9224... escalation
4. spawn:
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
       --remote-debugging-port=9222 \
       --user-data-dir="$HOME/Library/Application Support/Google/Chrome" \
       --no-first-run --no-default-browser-check \
       --restore-last-session
5. wait for CDP endpoint ready (GET http://localhost:9222/json/version)
6. write port to ~/.mcp-chrome-scalemaker/cdp-port (bridge 가 읽음)
```

### Playwright CDP 폴백 동작

```
사용자 Chrome (launcher 로 띄워짐, port 9222)
       │
       │  CDP (Chrome DevTools Protocol)
       ▼
┌──────────────────────────────────────────────────────┐
│  bridge process — Playwright fallback transport     │
│                                                      │
│  on transport-failure (primary native msg) OR        │
│  on user-toggle (UI 의 Playwright 모드 라디오):       │
│                                                      │
│  1. read ~/.mcp-chrome-scalemaker/cdp-port            │
│  2. browser = await chromium.connectOverCDP(         │
│       `http://localhost:${port}`                     │
│     )                                                │
│  3. context = browser.contexts()[0]   // existing    │
│  4. expose 33 tools via HTTP 12307/mcp:              │
│     - 18 tools = Playwright API 직접 매핑            │
│     - 7 tools = CDP event 캡처 우회                  │
│     - 8 tools = stub (native-only 표시)              │
│  5. on disconnect → primary 재시도 후 다시 fallback  │
└──────────────────────────────────────────────────────┘
```

### 33 도구 미러 분류표

| 그룹                  | 도구 수 | Playwright 매핑                                                                                                                                                                                                                                                                                                   | 대상 도구                                                                                                                             |
| --------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 🟢 1:1 매핑           | 18      | `page.goto`, `page.click`, `page.screenshot`, `page.content`, `page.fill`, `page.keyboard`, `page.evaluate`, `context.cookies`, `browser.contexts`, `page.goBack`, `page.reload`, `page.url`, `page.title`, `page.viewportSize`, `page.locator`, `page.waitForSelector`, `page.mouse`, `page.locator.boundingBox` | navigate, click, screenshot, get_content, fill_or_select, keyboard, javascript, tabs, navigate_back, reload, scroll, ...              |
| 🟡 우회 구현          | 7       | CDP event 캡처 (Network.requestWillBeSent / Network.responseReceived)                                                                                                                                                                                                                                             | network_capture, console, network_request                                                                                             |
| 🔴 stub (native-only) | 8       | `{ error: "tool requires native messaging mode" }`                                                                                                                                                                                                                                                                | bookmark*\*, history (chrome.history API), inject_script, semantic_search, performance*\*, gif_recorder, upload_file, handle_download |

### 구현 작업량 (예상)

- 🟢 1:1 매핑 18개 = **3~4일**
- 🟡 우회 구현 7개 = **2~3일**
- 🔴 stub 8개 = **반일**
- 통합 테스트 + 두 transport 간 동작 동등성 검증 = **2일**
- **합 ~7~10일** (1주 ± α)

---

## 5. L4 — Diagnostic Report UI

### 위치 & 진입

extension popup → "Open Diagnostic Report" 클릭 → 별창 (`chrome-extension://.../diagnostic.html`, 800×600)

### 화면 구성

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Diagnostic Report — auto-chrome-mcp                               │
│                                          [Copy as JSON] [Run Self-Test] │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ─── Environment ───                                                    │
│   OS              macOS 14.7 (darwin arm64)                             │
│   Chrome          Version 140.0.7339.214                                │
│   bridge npm      mcp-chrome-scalemaker-bridge@1.2.0                     │
│   extension       1.2.0 (matched ✅)                                    │
│                                                                         │
│  ─── Processes ───                                                      │
│   bridge          pid 12345 · up 3m12s · 48 MB                          │
│   Chrome          pid 99812 · 12 tabs                                   │
│                                                                         │
│  ─── Ports ───                                                          │
│   12306 (MCP primary)    ✅ owned by bridge (pid 12345)                 │
│   12307 (MCP fallback)   ⚪ unused                                      │
│   9222  (CDP)            ✅ owned by Chrome (pid 99812)                 │
│                                                                         │
│  ─── Native Messaging Host ───                                          │
│   manifest path   ~/Library/Application Support/Google/Chrome/          │
│                    NativeMessagingHosts/com.chromemcp.nativehost.json   │
│   exists          ✅                                                    │
│   bridge binary   ✅ (path resolved, executable)                        │
│                                                                         │
│  ─── MCP Sessions ───                                                   │
│   session a1b2c3   client=claude-code   uptime=2m04s   tools=33         │
│   session d4e5f6   client=cursor        uptime=18s     tools=33         │
│                                                                         │
│  ─── Transport ───                                                      │
│   active mode    Primary (native)                                       │
│   fallback ready Yes (CDP attached, page=12)                            │
│                                                                         │
│  ─── Recent Logs (last 50) ───                                          │
│   18:42:11  [supervisor]  Stage A start                                 │
│   18:42:12  [supervisor]  ① process kill ok                             │
│   18:42:12  [supervisor]  ② port 12306 freed                            │
│   18:42:14  [bridge]      spawned, listening :12306                     │
│   ...                                                                   │
│                                                                         │
│  ─── Self-Test (Run Self-Test 클릭 시) ───                              │
│   ✅ #1 initialize 첫 회         (142ms)                                │
│   ✅ #2 initialize 두 번째       (98ms, first session alive ✅)         │
│   ✅ #3 tools/list               (33 tools)                             │
│   ✅ #4 navigate google.com      (1.2s)                                 │
│   ✅ #5 screenshot               (340ms)                                │
│   ✅ #6 CDP fallback toggle      (Playwright connected, page=12)        │
│   ✅ #7 Force Reconnect Stage A  (3.4s end-to-end)                      │
│   ⏭  #8 Force Reconnect Stage C  (Chrome 종료 필요, skip)                │
└─────────────────────────────────────────────────────────────────────────┘
```

### Copy as JSON (issue 등록 친화)

```json
{
  "fork": "auto-chrome-mcp@1.2.0",
  "env": { "os": "darwin", "arch": "arm64", "chrome": "140.0.7339.214" },
  "processes": { "bridge": { "pid": 12345, "uptime_s": 192 } },
  "ports": { "12306": "bridge", "12307": null, "9222": "chrome" },
  "sessions": [
    { "id": "a1b2c3", "client": "claude-code", "tools": 33 }
  ],
  "transport": { "mode": "primary", "fallback_ready": true },
  "recent_logs": [...]
}
```

→ 사용자가 GitHub issue 등록할 때 이 JSON 그대로 복사 → 디버깅 시간 1/10 로 단축.

### Self-Test 자동 실행

회귀 8 케이스를 extension UI 에서 1 클릭으로 실행. 각 케이스의 통과/실패/실패 사유를 인라인 표시. CI 가 아닌 사용자 환경에서도 즉시 진단 가능.

---

## 6. L5 — 배포·릴리스·Upstream Sync

### 배포 방식 매트릭스

| 컴포넌트             | 배포 채널                                                                | 사용자 설치 방법                                                                                   |
| -------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| **bridge** (npm pkg) | npm registry — `mcp-chrome-scalemaker-bridge`                            | `npm i -g mcp-chrome-scalemaker-bridge` (원본과 충돌 X, 패키지명 다름)                             |
| **extension**        | ❌ Chrome Web Store 사용 안 함 (정책상 fork reject 위험 + 검수 2주 지연) | ✅ GitHub Releases 의 `.zip` → unpacked 사이드로드 (chrome://extensions 개발자모드 ON → 폴더 로드) |
| **chrome-launcher**  | GitHub Releases 의 OS별 단일 셸                                          | macOS `.command` 더블클릭 / Windows `.bat` 더블클릭                                                |

→ 사용자 1회 셋업 = (1) `npm i -g ...` + (2) GitHub zip 다운로드해서 extension 폴더 로드 + (3) launcher 다운로드. 5분 미만.

### Repo 초기 구조

```
mcp-chrome-scalemaker/                       ← cw02326/auto-chrome-mcp
├── README.md                               ← fork 의 motivation + 5 fix + 진입 방법
├── UPSTREAM_DIFF.md                        ← 우리 fork 가 upstream 대비 추가한 6 카테고리 명세
├── app/
│   ├── chrome-extension/                   ← 본가 + diagnostic.html + Force Reconnect UI
│   └── native-server/                      ← 본가 + supervisor + playwright transport
├── packages/
│   ├── shared/
│   ├── wasm-simd/
│   └── chrome-launcher/                    ← 신설
├── docs/
│   ├── TROUBLESHOOTING.md                  ← 본가 + 신규 진단 흐름 안내
│   ├── PLAYWRIGHT_FALLBACK.md              ← CDP 폴백 사용법
│   ├── FORCE_RECONNECT.md                  ← A→B→C escalation 동작 명세
│   └── UPSTREAM_SYNC.md                    ← 우리 sync 정책 박제
├── .github/
│   └── workflows/
│       ├── release.yml                     ← tag push 시 npm publish + .zip release
│       ├── upstream-check.yml              ← 매주 upstream master diff 검사 (issue auto-create)
│       └── self-test.yml                   ← PR 마다 회귀 8 케이스
└── pnpm-workspace.yaml
```

### 버전 관리 — Upstream divergence indicator

semver `MAJOR.MINOR.PATCH` 의 `MAJOR` 를 upstream 추적용으로 활용:

| 우리 버전 | upstream 베이스                                | 의미               |
| --------- | ---------------------------------------------- | ------------------ |
| `1.x.x`   | upstream `master @ commit abc123` (1.2.0 시점) | 첫 출시            |
| `2.x.x`   | upstream 의 다음 minor 흡수                    | upstream sync 발생 |

`UPSTREAM_DIFF.md` 에 cherry-pick 한 PR 목록 + upstream commit hash 박제, 매 sync 마다 갱신.

### Upstream Sync 정책

```
[월 1회 정기 작업]

1. upstream-check.yml 이 매주 화요일 실행:
   - git fetch upstream master
   - upstream..origin/main-scalemaker diff > UPSTREAM_DIFF.report
   - 우리가 흡수한 PR (#346, #312, ...) 가 upstream 에 머지됐는지 확인
   - 머지 발견 → GitHub issue 자동 생성 ("PR #346 merged upstream — retire our cherry-pick")

2. 사람 작업:
   - upstream 의 새 commit 들을 cherry-pick (충돌 시 우리 우선)
   - 우리 cherry-pick 중 upstream 머지된 건 retire
   - 회귀 8 케이스 통과 확인
   - tag v2.0.0 push → release.yml 자동 npm publish + .zip release

3. 사용자 알림:
   - extension UI 에 새 버전 알림 (chrome.runtime.requestUpdateCheck)
   - "Update available" → GitHub Releases 페이지로 안내
```

### 릴리스 워크플로우 (`release.yml` 요지)

```yaml
on:
  push:
    tags: ['v*']
jobs:
  publish:
    - pnpm install + pnpm build
    - npm publish (mcp-chrome-scalemaker-bridge, with --provenance)
    - extension zip + chrome-launcher tarball → GitHub Release attach
    - self-test 8 회귀 → fail 시 release abort
```

---

## 7. mcp-chrome (원본) vs auto-chrome-mcp (fork) 패치 비교표

### 7.1 흡수한 기존 PR 7개 — root cause fix (모두 OPEN 인 채 upstream 머지 안 됨)

| #    | 영역                      | 원본                                                                                 | fork 변경                                           | 해결되는 증상                                                                                         |
| ---- | ------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| #346 | `mcp-server.ts` singleton | `getMcpServer()` 가 1개 인스턴스만 반환 → 두 번째 연결 시 첫 세션 transport 덮어쓰기 | **factory pattern** `createMcpServer()` per session | "已连接, 服务未启动" 노란불 / 첫 회 후 모든 호출 실패 / 두 번째 Claude Code 세션 연결 시 첫 세션 끊김 |
| #338 | sequential HTTP clients   | `"Already connected to a transport"` 에러                                            | #346 와 union, 잔여 케이스 cherry-pick              | 순차 HTTP 클라이언트 연결 실패                                                                        |
| #312 | stale client reconnect    | EOF 후 영구 실패                                                                     | graceful reconnect handler                          | 네트워크 잠깐 끊김 후 영영 안 돌아옴                                                                  |
| #302 | STDIO session cleanup     | exit 시 session 잔존                                                                 | onExit 청소                                         | STDIO 모드에서 orphan session 누적                                                                    |
| #304 | STDIO parent death        | parent 죽어도 bridge 살아남음                                                        | parent stdin close → exit                           | STDIO 모드 zombie process                                                                             |
| #329 | Chrome 144+ 호환          | deprecated `unload` event                                                            | `pagehide` 대체                                     | Chrome 144 업데이트 후 `Error: Streamable HTTP error`                                                 |
| #313 | env var                   | 호스트 하드코딩 127.0.0.1                                                            | `CHROME_MCP_HOST` 환경변수 지원                     | LAN 노출 / 포트 충돌 회피                                                                             |

### 7.2 신규 — Force Reconnect 5단계 슈퍼 버튼

|                     | 원본                                                                                 | fork                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Connect 버튼 동작   | "그냥 연결 시도, 안 되면 안 됨" 메시지                                               | **5단계 자동 청소 + 재시작 + A→B→C escalation**                                                        |
| Stage A             | ❌ 없음                                                                              | ① process kill → ② port 12306 free probe → ③ bridge spawn → ④ native handshake → ⑤ MCP initialize ping |
| Stage B (A 실패 시) | ❌ 없음                                                                              | native messaging host manifest 재등록 (`mcp-chrome-bridge install` 자동 호출) + Stage A 재시도         |
| Stage C (B 실패 시) | ❌ 없음                                                                              | 사용자 confirm 다이얼로그 → Chrome 종료 → launcher 재시작 (또는 Playwright 폴백 전환 권유)             |
| 임시 우회 방법      | 사용자가 직접 `pkill -9 -f mcp-chrome-bridge` 수동 실행 (issue #306 댓글에서만 공유) | **버튼 1번이면 자동**                                                                                  |

### 7.3 신규 — Playwright CDP 폴백 transport

|                | 원본                          | fork                                                                             |
| -------------- | ----------------------------- | -------------------------------------------------------------------------------- |
| 통신 경로      | native messaging 만 (한 경로) | **2 경로 병존**: native (12306) + Playwright CDP (12307)                         |
| native 실패 시 | 사용 불가 — 끝                | **CDP 폴백 자동/수동 전환** — 같은 Chrome 인스턴스에 attach (세션·로그인 그대로) |
| 도구 미러      | —                             | **33 도구 미러** (18개 1:1 / 7개 CDP 우회 / 8개 native-only stub)                |
| Mode 토글      | ❌                            | extension UI 에 라디오 (Primary / Playwright fallback)                           |

### 7.4 신규 — Chrome Launcher 패키지 (`packages/chrome-launcher/`)

|                                | 원본                                 | fork                                                                             |
| ------------------------------ | ------------------------------------ | -------------------------------------------------------------------------------- |
| Chrome 띄우는 방법             | 사용자가 일반 Chrome 그대로          | **launcher 스크립트 더블클릭** (macOS `.command` / Windows `.bat` / Linux `.sh`) |
| `--remote-debugging-port=9222` | ❌ 사용자가 수동 설정 (대부분 안 함) | **자동 활성화** (Playwright 폴백 전제)                                           |
| user-data-dir                  | —                                    | **default profile 자동 감지** → 사용자 세션·북마크·로그인 그대로                 |
| 포트 충돌 처리                 | —                                    | 9222 점유 시 9223→9224 escalation                                                |

### 7.5 신규 — Diagnostic Report UI

|                   | 원본                              | fork                                                                                                                 |
| ----------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 진단 정보         | ❌ ("연결 안 됨" 만 표시)         | **별창 진단 리포트** — environment / processes / ports / native msg manifest / sessions / transport / 최근 50줄 로그 |
| Copy as JSON      | ❌                                | ✅ **issue 등록 친화** JSON 한 번에 복사                                                                             |
| Self-Test         | ❌                                | ✅ **회귀 8 케이스 1 클릭 자동 실행** — 사용자 환경 즉시 진단                                                        |
| Health 인디케이터 | "Connected" / "Not connected" 2단 | **4 stage 실시간** (process · port · handshake · MCP)                                                                |

### 7.6 신규 — 운영/배포 강화

|                    | 원본        | fork                                                                                          |
| ------------------ | ----------- | --------------------------------------------------------------------------------------------- |
| 회귀 테스트        | 없음        | **CI 의 self-test.yml** — 8 회귀 케이스 PR 마다                                               |
| Upstream sync 자동 | 없음        | **upstream-check.yml** 매주 — 새 머지 발견 시 GitHub issue 자동 생성, 우리 cherry-pick retire |
| Release 자동화     | 없음        | **release.yml** — tag push → npm publish + GitHub Release .zip 자동                           |
| 버전 관리          | 단일 semver | semver MAJOR = **upstream 베이스 추적 indicator** + `UPSTREAM_DIFF.md`                        |

---

## 8. 사용자가 직접 체감하는 변화 (Before / After)

| 시나리오                        | Before (원본)                                               | After (fork)                                                           |
| ------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| Claude Code 첫 연결             | OK                                                          | OK                                                                     |
| Claude Code 두 번째 세션 시작   | ❌ 첫 세션 끊김, 둘 다 사용 불가                            | ✅ 두 세션 모두 작동 (factory pattern)                                 |
| 네트워크 일시 끊김 후           | ❌ 영영 안 돌아옴                                           | ✅ EOF 후 자동 재연결                                                  |
| Chrome 144 업데이트 후          | ❌ Streamable HTTP error                                    | ✅ pagehide 적용, 정상                                                 |
| 그래도 연결 안 될 때            | 사용자가 `pkill -9` 수동 실행 후 빙빙 (Stack Overflow 검색) | **Connect 버튼 1회 = 자동 청소 + escalation**                          |
| Cursor 와 Claude Code 동시 사용 | ❌ 둘 중 하나만                                             | ✅ 둘 다 동시                                                          |
| 모든 방법 실패 시               | 완전 사용 불가                                              | **Playwright 폴백 모드로 전환** → 같은 Chrome 에서 핵심 도구 계속 사용 |
| 디버깅 정보                     | "연결 안 됨" 외 정보 0                                      | **진단 리포트 + Self-Test + Copy JSON**                                |

---

## 9. 다음 단계 (implementation 진입 시)

본 디자인이 합의된 상태이므로, implementation 단계로 넘어갈 때:

1. **별도 worktree 생성** — `superpowers:using-git-worktrees` 활용해서 본 vault (`claude_lecture`) 와 격리. fork repo 는 `~/projects/mcp-chrome-scalemaker/` 같은 별도 위치
2. **upstream fork 떠서 베이스라인 commit hash 픽스** — `gh repo fork hangwin/mcp-chrome --clone --remote --org scalemaker-ship-it` (또는 본인 계정)
3. **`superpowers:writing-plans` 로 implementation plan 작성** — 본 디자인의 L1→L2→L3→L4→L5 순서로 step-by-step plan
4. **회귀 8 케이스 + Self-Test 인프라 먼저 구축** — TDD 원칙 (`superpowers:test-driven-development`)
5. **L1 흡수 7 PR 부터 시작** — 각 PR cherry-pick 마다 회귀 통과 확인
6. **L2 → L3 → L4 → L5 순차 진행**

총 예상 일정: **2~3주** (1주 = L1 흡수 + 회귀 인프라, 1주 = L2 + L3 핵심, 1주 = L3 stub + L4 + L5 + 릴리스)

본 vault 의 거버넌스 (claude_lecture AGENTS.md) 와는 **분리** — fork 는 우리 강의·자산도와 무관한 별도 개발 도구.

---

## 참조

- 원본 repo: https://github.com/hangwin/mcp-chrome
- 핵심 fix PR: [#346](https://github.com/hangwin/mcp-chrome/pull/346) factory pattern (MankhongGarden)
- root cause 이슈: [#306](https://github.com/hangwin/mcp-chrome/issues/306) (9 comments) · [#321](https://github.com/hangwin/mcp-chrome/issues/321) · [#198](https://github.com/hangwin/mcp-chrome/issues/198) (11 comments)
- 유사 패키지 비교 글: [Playwright MCP vs Claude in Chrome (2026)](https://lalatenduswain.medium.com/playwright-mcp-vs-claude-in-chrome-which-browser-testing-tool-should-you-use-in-2026-e502bee0067a)
- Playwriter (컨셉 유사 fork 사례): https://github.com/remorses/playwriter
- MCP 공식 SDK 의 `Server.connect(transport)` 동작 (transport 덮어쓰기 원인): `@modelcontextprotocol/sdk` 의 `Server.connect` 구현
