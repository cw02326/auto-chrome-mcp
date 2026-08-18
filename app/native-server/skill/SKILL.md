---
name: chrome-mcp-scalemaker-doctor
description: |
  Use whenever the user reports ANY problem with the chrome-mcp-scalemaker
  MCP server. Diagnoses via `mcp-chrome-scalemaker-bridge doctor`, fixes with
  `--fix`, exports issue report with `report --copy`, edits .mcp.json's
  CHROME_PORT for multi-profile routing, and guides the popup's 강제 포커스
  toggle.

  Trigger on phrasings like (Korean + English, conversational + technical):
    - "chrome mcp 연결 안 돼" / "MCP 안 돼" / "MCP 가 작동 안 함"
    - "지금 연결이 끊겼어" / "갑자기 끊어졌어" / "disconnected 떠"
    - "popup 에 빨간불" / "노란불" / "서비스 정지로 떠"
    - "/mcp 가 안 잡혀" / "/mcp 에 chrome-mcp-stdio 가 없어"
    - "도구가 timeout" / "스크린샷 안 찍혀" / "navigate 실패"
    - "tab 전환이 안 먹혀" / "click 이 안 돼"
    - "Chrome 이 자꾸 앞으로 튀어나옴" / "강제 포커스 꺼줘" / "다른 앱 작업
       하는데 chrome 이 빼앗아감"
    - "다른 profile 인데 같은 chrome 이 잡혀" / "두 클로드 세션이 같은
       chrome 만 호출" / "12315 로 설정했는데 12320 으로 가"
    - "port 충돌" / "EADDRINUSE" / "PORT_CONFLICT"
    - "bridge 가 안 떠" / "native messaging error" / "manifest 못 찾음"
    - "권한 에러" / "EACCES" / "run_host.sh"
    - "강제 재연결 눌렀는데도 안 돼"
    - "MCP 가 내가 보던 탭을 조작해" / "탭이 자꾸 앞으로 튀어나옴"
    - "스크린샷이 엉뚱한 탭" / "Cannot capture background tab"
    - "runaway loop 에러" / "Automation guard 가 막았어"
    - "MCP 작업 창이 자꾸 생겨" / "작업 창 끄고 싶어"
    - "팝업이 열렸는데 인식을 못해" / "새 창에서 작업이 안 이어져"

  Skip if the user is using upstream hangwin/mcp-chrome (not the auto-chrome-mcp
  fork) — this skill knows fork-specific commands and architecture.

# scalemaker-version: <bridge version at build time>
---

# chrome-mcp-scalemaker doctor

이 스킬은 사용자가 chrome-mcp-scalemaker (auto-chrome-mcp fork) 의 MCP 서버, 확장,
bridge, 또는 도구 호출과 관련된 문제를 보고할 때 자동으로 진단·복구합니다.

**모든 명령은 Bash tool 로 직접 실행하고 stdout/stderr 를 캡처해서 해석한 뒤
사용자에게 자연어로 답변하세요.** "이 명령어를 직접 쳐주세요" 라고 사용자에게
넘기지 마세요.

먼저 `mcp-chrome-scalemaker-bridge -V` 로 auto-chrome-mcp fork 인지 확인하세요.
명령이 없거나 다른 패키지 (`mcp-chrome-bridge` 등) 면 이 스킬은 종료하고
사용자에게 fork 안내만 합니다.

---

## (A) Architecture in 1 minute

사용자 증상 듣고 어느 layer 가 깨졌는지 분류용 mental model:

```
Claude Code session                              ← 사용자가 작업하는 곳
   ↓ (stdio, .mcp.json 의 env 가 여기서 적용)
mcp-server-stdio.js                              ← bridge npm 패키지의 일부
   ↓ (HTTP fetch, URL = CHROME_PORT env override)
http://127.0.0.1:<port>/mcp                      ← bridge HTTP listener (chrome profile 별 분리)
   ↓ (in-process)
bridge (Native Messaging Host process)           ← Chrome 이 connectNative 로 spawn
   ↑ (chrome.runtime.connectNative)
extension service worker                         ← profile-scoped (각 chrome profile 마다 1개)
   ↑ (popup ↔ service worker, chrome.runtime.sendMessage)
popup UI                                         ← port 입력, 강제포커스 토글, 강제 재연결
```

핵심 invariant:

- **stdio-config.json 의 url 은 hardcoded** 이고, `mcp-server-stdio.js` 가
  `process.env.CHROME_PORT` 가 있으면 그 port 로 override (v1.0.27+)
- **chrome profile 별로 bridge process 가 분리 spawn** 됨 (각자 다른 port listen)
- popup 의 port 입력 → service worker → connectNative → bridge 가 그 port 로 listen
- 강제포커스 토글 (`chrome.storage.local` 의 `forceFocusOnToolCall`, default false) =
  `chrome.windows.update({focused:true})` 게이트

---

## (B) Diagnostic playbook — 증상 → 명령 (Claude 가 직접 실행)

**중요: 모든 명령은 Bash tool 로 Claude 가 직접 실행. 사용자에게 "이거 한 번
쳐보세요" 하지 마세요. stdout/stderr 캡처해서 해석한 뒤 자연어로 답합니다.**

### 분기 알고리즘

1. **증상 listening** → 아래 trigger 표에서 최초 매칭 1개 골라 1st command 실행.
2. **stdout 캡처** → `doctor` 결과면 (B-doctor-output) 표 따라 ❌ 항목별 후속 결정.
3. **후속 명령** 실행 후 사용자에게 결과 요약 (`'doctor 결과 권한 항목 빨간불.
--fix 실행해서 chmod 755 적용함. 이제 popup 다시 열어봐줄래?'` 같이).
4. **3회 시도 후 미해결** → (E) escalate → `report --copy` + GH Issue URL 안내.

### Trigger → 1st command

| 사용자 발화 패턴                                                                            | 1st command (Claude 가 Bash 로)                                                      | 후속 분기                                                                                             |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| "연결 안 돼" / "disconnected" / "popup 빨간불" / "service stopped"                          | `mcp-chrome-scalemaker-bridge doctor`                                                | (B-doctor-output) 표                                                                                  |
| "권한 에러" / "EACCES" / "permission denied" / "run_host.sh" 언급                           | `mcp-chrome-scalemaker-bridge doctor --fix`                                          | 여전히 실패 시 `mcp-chrome-scalemaker-bridge fix-permissions` 단독                                    |
| "manifest 못 찾음" / "native messaging error" / "Specified native messaging host not found" | `mcp-chrome-scalemaker-bridge doctor --fix`                                          | 후속 doctor 재실행해서 ✅ 확인                                                                        |
| "두 세션이 같은 chrome 만 호출" / "다른 profile 인데" / "12315 로 설정했는데 12320 가"      | (B-doctor 대신) `.mcp.json` read 부터 — section (C) 점검 절차 1-5 따라               | port 일치 후 사용자에게 Claude Code 재시작 + `/mcp` 검증 안내                                         |
| "Chrome 이 자꾸 앞으로 튀어나옴" / "포커스 빼앗김" / "강제 포커스 꺼"                       | (명령 없음) popup 의 "강제 포커스" 토글 OFF 안내 — section (D)                       | popup 못 열겠다면 chrome.storage.local 의 `forceFocusOnToolCall` 을 false 로 직접 set 안내            |
| "/mcp 가 비어있음" / "/mcp 에 chrome-mcp-stdio 없어"                                        | (명령 없음) working dir 의 `.mcp.json` read                                          | 없으면 welcome 페이지의 "Claude prompt 등록" 박스를 사용자에게 안내                                   |
| "도구 timeout" / "스크린샷 안 찍혀" / "navigate 실패" / "tab 전환 안 됨"                    | `mcp-chrome-scalemaker-bridge doctor`                                                | Connectivity ✅ 인데도 안 되면 popup 의 "강제 재연결" 5단계 안내                                      |
| "port 충돌" / "EADDRINUSE" / "PORT_CONFLICT"                                                | `lsof -i :<port>` 로 점유 process 식별                                               | bridge 좀비면 `kill -9 <pid>` 권유. 다른 process (e.g., 다른 chrome profile bridge) 면 그쪽 port 변경 |
| "강제 재연결 눌렀는데도 안 돼" / "5단계 다 빨간불"                                          | `mcp-chrome-scalemaker-bridge doctor` + `mcp-chrome-scalemaker-bridge report --copy` | (E) escalate — 진단 + 리포트 모두 사용자에게                                                          |
| "이슈 등록" / "버그 신고" / "GH issue 작성"                                                 | `mcp-chrome-scalemaker-bridge report --copy`                                         | 클립보드 마크다운 + 사용자에게 issue URL 안내                                                         |

### (B-doctor-output) `doctor` 결과 해석 → 후속 명령

doctor 는 10개 항목 점검. 결과 stdout 에서 ❌ 항목별 결정:

| ❌ 항목                             | 의미                                                            | Claude 의 후속 action                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Installation**                    | 패키지가 PATH 에 없음                                           | `npm install -g mcp-chrome-scalemaker-bridge` 실행 권유 (사용자가 sudo 필요할 수 있어 Claude 가 직접 실행 X)                                                                                                                                                                                                                                                                                                        |
| **Host files**                      | dist 안 파일 누락 (꼬임)                                        | 재설치 권유 — `npm uninstall -g ... && npm install -g ...`                                                                                                                                                                                                                                                                                                                                                          |
| **Host permissions**                | `run_host.sh` 실행 권한 없음                                    | `mcp-chrome-scalemaker-bridge doctor --fix` 또는 `... fix-permissions` 직접 실행                                                                                                                                                                                                                                                                                                                                    |
| **Node executable**                 | Node 20+ 가 wrapper script 에서 안 잡힘                         | 사용자 OS 의 node version 확인 (`node -v`) → 20 미만이면 업데이트 안내. nvm/volta/asdf/fnm 사용자면 `export CHROME_MCP_NODE_PATH=$(which node)` 후 재시도                                                                                                                                                                                                                                                           |
| **Chrome / Chromium manifest**      | OS 별 디렉토리에 `com.chromemcpscalemaker.nativehost.json` 없음 | `mcp-chrome-scalemaker-bridge doctor --fix` 로 user-level 자동 재등록                                                                                                                                                                                                                                                                                                                                               |
| **Windows registry** (Windows 만)   | registry 키 누락                                                | `doctor --fix` 시도 → 실패 시 관리자 PowerShell 안내                                                                                                                                                                                                                                                                                                                                                                |
| **Port config** / **Port constant** | `stdio-config.json` 의 URL port 가 깨짐                         | `mcp-chrome-scalemaker-bridge update-port <port>` 실행                                                                                                                                                                                                                                                                                                                                                              |
| **Connectivity**                    | bridge 가 해당 port 에서 응답 X                                 | v1.0.30+ doctor 는 active bridge process 의 actual port 도 같이 점검 → message 에 "active bridge found on port(s) X" 가 보이면 false WARN (popup 의 dynamic port 가 hardcoded 와 다를 뿐, 실제는 정상). 그 message 없이 진짜 ⚠️ 면 `ps aux \| grep mcp-chrome-scalemaker-bridge` → `lsof -aPi -p <pid> \| grep LISTEN` 로 살아있는지 확인. 죽었으면 popup "강제 재연결" 안내. 다른 process 점유면 위 port 충돌 분기 |
| **Logs**                            | log 디렉토리 쓰기 실패 (드뭄)                                   | `chmod +w ~/Library/Logs/mcp-chrome-scalemaker-bridge/` (macOS) 등 안내                                                                                                                                                                                                                                                                                                                                             |

### 사용자 발화 → Bash 호출 예시

> 사용자: "MCP 안 돼"
>
> Claude:
>
> 1. Bash: `mcp-chrome-scalemaker-bridge doctor` → stdout 캡처
> 2. 결과: "Host permissions" 가 ❌
> 3. Bash: `mcp-chrome-scalemaker-bridge doctor --fix` → stdout 캡처
> 4. 결과: 모두 ✅
> 5. 사용자: "permissions 이 빠져있었네. fix 적용했어. popup 다시 열어서 연결되는지 확인해줘."

---

## (C) CHROME_PORT 라우팅 (multi-profile)

**증상:** 두 Chrome profile 을 다른 port 로 띄웠는데 두 Claude Code 세션이 모두
같은 chrome 만 호출함.

**원인:** v1.0.26 까지 `mcp-server-stdio.js` 가 `process.env.CHROME_PORT` 를
무시하고 hardcoded 12320 으로 가는 버그. v1.0.27+ 에서 fix.

**점검 절차:**

1. 사용자에게 양쪽 working dir 의 `.mcp.json` 보여달라고 요청
2. 각 dir 의 `mcpServers.chrome-mcp-stdio.env.CHROME_PORT` 가 서로 다른 port 인지 확인
3. 없거나 같으면 다음 형태로 수정 제안:
   ```json
   {
     "mcpServers": {
       "chrome-mcp-stdio": {
         "command": "node",
         "args": ["<npm root -g>/mcp-chrome-scalemaker-bridge/dist/mcp/mcp-server-stdio.js"],
         "env": { "CHROME_PORT": "12315" }
       }
     }
   }
   ```
4. 양쪽 Claude Code 세션을 `Ctrl+C 두 번` 종료 → 재시작
5. 검증: 각 세션의 첫 도구 호출 시 stderr (Claude Code 의 `/mcp` →
   chrome-mcp-stdio → View logs) 에 다음 line 찍히는지 확인:
   ```
   [chrome-mcp-stdio] CHROME_PORT=12315 → http://127.0.0.1:12315/mcp
   ```

각 chrome profile 의 popup port 입력 (서비스 상태 카드의 "연결 포트") 도
`.mcp.json` 의 CHROME_PORT 와 같은 숫자여야 함 — profile A 의 popup 이 12315
면 그쪽 working dir 의 .mcp.json 도 12315.

---

## (D) 강제포커스 토글

**증상:** "Chrome 이 자꾸 다른 앱 앞으로 튀어나옴", "MCP 도구 호출할 때마다
포커스 빼앗김".

**원인:** MCP 도구 (`chrome_screenshot`, `chrome_navigate` 등) 실행 시 bridge 가
`chrome.windows.update({focused:true})` 호출 → OS 윈도우 포커스 가로채기.

**해결:**

- v1.0.27+ 기본값 = **OFF** (강제포커스 안 함). 사용자가 명시적으로 켰을
  가능성.
- popup 의 "실행 상태" 카드 우측 슬라이딩 스위치 "강제 포커스" 가 OFF 인지 확인
- ON 이면 클릭해서 OFF 로 토글
- 저장 위치 = `chrome.storage.local` 의 `forceFocusOnToolCall` (boolean)

**가드 적용 범위:**

- ✅ 차단: `chrome.windows.update({focused:true})`, `chrome.windows.create({focused:true})`
- ❌ 차단 안 함 (탭 동작에 필수): `chrome.tabs.update({active:true})`,
  `chrome.tabs.create({active:true})`

즉 토글 OFF 여도 같은 chrome 윈도우 내 탭은 전환됨 (도구 동작에 필요). OS
윈도우 포커스만 안 가로챔.

---

## (D-2) 백그라운드 작업 모드 + 신뢰성 도구 (v1.1.0+/v1.2.0+)

v1.1.0 부터 MCP 도구는 사용자의 브라우징을 방해하지 않는 **백그라운드 작업 모드**로 동작한다.

| 토글 (popup)      | storage.local 키           | 기본값 | 의미                                                    |
| ----------------- | -------------------------- | ------ | ------------------------------------------------------- |
| 강제 포커스       | `forceFocusOnToolCall`     | OFF    | ON 이면 도구 호출 시 OS 윈도우 포커스 가로챔            |
| 백그라운드 작업   | `backgroundWorkMode`       | ON     | ON 이면 탭 활성화 없이 세션별 "작업 탭"을 대상으로 동작 |
| 전용 작업 창      | `dedicatedWorkWindow`      | ON     | ON 이면 MCP 작업 탭을 별도 비포커스 창에 모음           |
| (popup 토글 없음) | `automationGuardEnabled`   | ON     | 도메인 속도 제한 + 동일 호출 반복 폭주 가드             |
| (popup 토글 없음) | `errorScreenshotOnFailure` | ON     | 도구 실패 시 화면 JPEG 자동 첨부                        |

핵심 동작: 세션(stdio)마다 `_mcpSessionId` 자동 주입 → 세션별 작업 탭(최대 10, LRU, "MCP" 뱃지).
`chrome_navigate` 가 작업 탭을 확정하므로 **세션 첫 작업은 navigate 부터**. 팝업/새 창이 열리면
결과에 `new_tabs_opened` 알림이 붙고, `chrome_set_work_tab` 으로 화면 전환 없이 작업 탭 이동.
v1.2.0 신규 도구: `chrome_wait_for`(로딩 대기), `chrome_scroll_collect`(무한스크롤 수집),
`chrome_extract`(선택자 정밀 추출), `chrome_batch`(다단계 1회 호출). read_page/get_web_content 는
diff·compact·reader 모드 기본 ON(토큰 절감, `diff:false`/`compact:false`/`raw:true` 로 해제).
v1.3.0 신규: `chrome_find`(자연어 요소 검색 — 한/영, iframe 포함), `chrome_shortcut`(이름 매크로
저장/실행), `chrome_list_browsers`/`chrome_use_browser`(세션 중 브라우저 프로필 전환 — stdio 로컬
도구라 extension 버전과 무관, 브리지 1.3.0+ 필요. 프로필별 포트는 각 확장 popup 에 표시).

### 증상 → 처방

| 증상                                                  | 처방                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| "MCP 가 내가 보던 탭을 조작해"                        | ① "백그라운드 작업" 토글 ON 확인 ② 그 세션에서 `chrome_navigate` 를 먼저 호출했는지 확인 (작업 탭 미확정이면 활성 탭 fallback) |
| "탭/창이 자꾸 앞으로 나옴"                            | "강제 포커스" OFF + "백그라운드 작업" ON 확인. 확장 버전 1.1.0 미만인지 확인 (`chrome://extensions`)                           |
| "Cannot capture background tab: CDP unavailable" 에러 | 해당 탭에 DevTools(F12)/다른 디버거가 붙어 있음 → 닫고 재시도                                                                  |
| "Automation guard: identical ... runaway loop" 에러   | 동일 호출 12회 반복 감지. 의도적이면 `chrome.storage.local.set({automationGuardEnabled:false})`                                |
| "MCP 작업 창이 자꾸 생겨"                             | popup 의 "전용 작업 창" 토글 OFF                                                                                               |
| "팝업이 열렸는데 인식 못함" (v1.2.0 미만)             | 확장을 1.2.0+ 로 업데이트 — 결과에 `new_tabs_opened` 알림 + `chrome_set_work_tab` 제공                                         |
| "클릭했는데 내용이 없다/빈 결과"                      | `chrome_wait_for` 로 selector/text/networkIdle 대기 후 재시도                                                                  |
| "iframe 안 요소 클릭 실패" (v1.2.0 미만)              | 1.2.0+ 는 자동 프레임 탐색. 구버전이면 업데이트                                                                                |
| 두 세션이 같은 탭을 잡음                              | v1.1.0+ 는 세션별 작업 탭 분리. 각 세션에서 navigate 로 각자 작업 탭 확정                                                      |

## (E) When to escalate

자체 해결 못 하면:

1. `mcp-chrome-scalemaker-bridge report --copy` 실행 (사용자 환경 정보 + doctor
   결과를 마크다운으로 클립보드에 복사. username/path/token 자동 redact)
2. GitHub Issue 생성: https://github.com/cw02326/auto-chrome-mcp/issues/new
3. 사용자에게 "클립보드에 진단 리포트가 있으니 issue 본문에 붙여넣기" 안내

**옵션:**

- `report --json` — JSON 형식
- `report --output <file>` — 파일 저장
- `report --no-redact` — 마스킹 해제 (full path 공유 동의 시)
- `report --include-logs <none|tail|full>` — wrapper 로그 포함 정도 (기본 tail)

---

## 처리 흐름 요약

사용자 증상 → (이 스킬 trigger) → bridge 명령 자동 호출 → 결과 해석 → 사용자에게
자연어로 답변 + 필요 시 추가 명령 (--fix 등) 호출 → 해결 안 되면 (E) escalate.

사용자가 직접 명령 치게 만들지 마세요. **Claude 가 Bash 로 다 합니다.**
