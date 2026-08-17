# Auto Chrome MCP (구 mcp-chrome-scalemaker)

> [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome) 의 reliability fork — 5+ 개월 머지 안 된 핵심 PR 7개 흡수 + Force Reconnect + Diagnostic UI.
> **stdio transport 강제** (HTTP 12306 안 씀). 웹스토어 등록 안 함 — npm + GitHub Release 사이드로드.

## 한 줄 설치

```bash
npm install -g mcp-chrome-scalemaker-bridge
```

postinstall 이 자동으로 처리하는 것:

- ✅ Bridge 전역 설치
- ✅ Native Messaging manifest 등록 (`com.chromemcpscalemaker.nativehost`)
- ✅ Extension zip 다운로드 → `~/Downloads/mcp-chrome-scalemaker-extension-v<version>/`
- ✅ **Claude Code 가 설치된 경우** (`~/.claude/` 존재 시) troubleshooting 스킬도 자동 설치 → `~/.claude/skills/chrome-mcp-scalemaker-doctor/SKILL.md`. 이후 "MCP 안 돼" 한 마디로 Claude 가 자동 진단·복구.

> Node.js 20+ 필요 — `node -v` 로 확인. macOS / Windows / Linux 공통.
>
> **자동 스킬 설치를 원하지 않으면:** `SCALEMAKER_NO_SKILL=1 npm install -g mcp-chrome-scalemaker-bridge`
> 사용자 custom 스킬 (frontmatter `name` 이 다른 경우) 은 절대 덮어쓰지 않음.
> 같은 스킬이 이미 있으면 `scalemaker-version` 비교 후 새 버전일 때만 갱신.

## 남은 단계 — 2개

### 1. Chrome 확장 로드

`chrome://extensions` 열기 → 우측 상단 **Developer mode** ON → **"Load unpacked"** 클릭 → `~/Downloads/mcp-chrome-scalemaker-extension-v<version>/` 선택.

Extension ID = `aogfhfajjknomcnmlkbjmihjbknlhbbi` (모든 사용자 동일 — `manifest.key` 박제로 unpacked load 시에도 `allowed_origins` 자동 일치).

### 2. Claude Code 에 등록

아래 prompt 를 복사 → 터미널의 `claude` 에 붙여넣기. Claude Code 가 `.mcp.json` 에 `chrome-mcp-stdio` 자동 등록.

```
지금 working dir (이 프로젝트 폴더) 의 .mcp.json 에 우리 chrome MCP (mcp-chrome-scalemaker) 를 등록해줘. ~/.claude.json 같은 전역 설정에는 손대지 마.

규칙:
- 이름: "chrome-mcp-stdio"
- transport: stdio (HTTP 안 씀)
- command: "node"
- args: ["<npm root -g 출력값>/mcp-chrome-scalemaker-bridge/dist/mcp/mcp-server-stdio.js"]
- env: { "CHROME_PORT": "12320" }

먼저 `npm root -g` 를 bash 로 실행해서 실제 경로 얻고, 그 다음에 working dir 의 .mcp.json (없으면 신설) 의 mcpServers.chrome-mcp-stdio 만 추가/갱신해줘. 기존 다른 server 항목은 보존.

등록이 끝나면 아래 절차도 함께 안내해줘:
1. Claude Code 를 Ctrl+C 두 번으로 종료 후 다시 실행 (mcp 서버 재로드)
2. `/mcp` 입력해서 chrome-mcp-stdio 가 connected 상태인지 확인
3. 확인 후 Esc 로 빠져나오기
```

등록 후 Claude Code 재시작 → `/mcp` 로 활성 확인.

## ⚠️ 사이트 권한 자동 허용 — 알아두세요

scalemaker 는 AI 자동화가 끊기지 않도록 Chrome 사이트 권한 prompt 를 **자동으로 처리**합니다 (v1.0.32+). 두 갈래로 동작:

| 권한                | 처리 시점                      | 효과                                                                                     |
| ------------------- | ------------------------------ | ---------------------------------------------------------------------------------------- |
| Popups              | install 시 모든 사이트 일괄    | 모든 사이트의 `window.open()` 차단 안 됨                                                 |
| Notifications       | install 시 모든 사이트 일괄    | 알림 권한 prompt 안 뜸                                                                   |
| Clipboard           | install 시 모든 사이트 일괄    | 클립보드 읽기 prompt 안 뜸                                                               |
| Automatic downloads | install 시 모든 사이트 일괄    | 다중 파일 자동 다운로드 prompt 안 뜸                                                     |
| **Camera**          | **AI 사용 사이트만 누적 자동** | Chrome 정책상 일괄 불가. AI 가 사용한 사이트만 그 origin 영구 허용 (sticky)              |
| **Microphone**      | **AI 사용 사이트만 누적 자동** | 동일                                                                                     |
| **Geolocation**     | **AI 사용 사이트만 누적 자동** | v1.0.32+ 부터 민감 처리로 이동 (OS 권한 + 개인정보 보호). camera/mic 와 동일 모델로 통일 |

**민감 3종 작동 방식 (camera/microphone/geolocation):** AI 가 카메라/마이크/위치 정보를 쓰려고 하면 popup 토글을 확인 → 토글 ON 이면 즉시 그 사이트만 origin 단위로 영구 허용 (`chrome.contentSettings.X.set({primaryPattern:'https://example.com/*', setting:'allow'})`). 한 번 set 된 사이트는 브라우저 재시작 후에도 prompt 안 뜸. 사용자가 직접 `chrome://settings/content/{camera,microphone,location}` 갈 필요 없음.

**OS 레벨 권한은 사용자 직접 설정 필요:**

- macOS: `시스템 설정 > 개인정보 보호 및 보안 > 카메라/마이크/위치 서비스` → Google Chrome 토글 ON
- Windows: `설정 > 개인 정보 보호 > 카메라/마이크/위치` → Chrome 허용
- (OS 권한이 꺼져 있으면 Chrome 확장이 아무리 허용해도 디바이스/위치 접근 자체가 안 됨)

**AI 자동화 흐름 confirm 게이트:** popup 하단 "권한 설정" 의 토글 3개 (camera/microphone/geolocation) 는 AI 가 해당 기능을 쓸 때마다 사용자 confirm 을 받을지 결정합니다.

- **Default**: 토글 3개 전부 **ON** (install 시 초기화). 묻지 않고 즉시 사용.
- **OFF 로 내리면**: AI 가 해당 기능 호출 시 작은 confirm 창이 떠서 허용 여부를 묻습니다 (60초 timeout).
- 끄려면: 확장 아이콘 클릭 → popup 하단 "권한 설정" 섹션에서 토글 OFF.

> **보안 모델** — 비민감 4종 (popups/notifications/clipboard/autoDownload) 은 install 시 모든 사이트 일괄 허용이라 일반 사용자에게 위험할 수 있음. 민감 3종 (camera/microphone/geolocation) 은 AI 가 방문한 사이트에만 누적 추가되므로 사용자가 신뢰하지 않는 사이트엔 영향 없음 (그 사이트에 가지 않으면 추가 안 됨). 별도 Chrome 프로필 사용을 권장합니다.
>
> **opt-out:** 자동 권한 세팅을 원하지 않으면 설치 후 `chrome://settings/content` 에서 비민감 4종을 직접 default 로 되돌리세요. 민감 3종의 origin 별 누적 허용은 `chrome://settings/content/{camera,microphone,location}` 에서 사이트별로 삭제 가능.

## 왜 fork?

| 흡수한 upstream PR (5+ 개월 OPEN)                   | 효과                                                        |
| --------------------------------------------------- | ----------------------------------------------------------- |
| **#346** singleton transport 제거 → factory pattern | "已连接, 服务未启动" 노란불 해결 / 두 client 동시 연결 가능 |
| **#312** stale reconnect EOF handler                | 네트워크 잠시 끊김 후 자동 복구                             |
| **#302 + #304** STDIO session/parent cleanup        | parent 죽으면 zombie 0                                      |
| **#329** pagehide for Chrome 144+                   | 144 업데이트 후 streamable HTTP error 해결                  |
| **#338** partial (transport close cleanup)          | memory leak 방지                                            |
| **#313** `CHROME_MCP_HOST` env                      | LAN 노출 / 포트 충돌 회피                                   |

| Fork 신규                                            | 효과                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **⚡ 강제 재연결** 5단계 슈퍼버튼                    | drain → port free → spawn → handshake → MCP ping 자동. 사용자 `pkill` 수동 작업 0                      |
| **🔬 진단 리포트** + Self-Test                       | env / bridge process / Self-Test 5 케이스 / Copy as JSON                                               |
| **deterministic extension ID** (`manifest.key` 박제) | 모든 사용자 ID = `aogfhfajjknomcnmlkbjmihjbknlhbbi` → unpacked load 시에도 `allowed_origins` 자동 일치 |
| **stdio 강제 정책**                                  | HTTP 12306 안 씀. native messaging 기반 stdio 만                                                       |
| **Claude design tokens** (warm cream + coral)        | popup UI = Anthropic Claude 디자인 시스템                                                              |
| **한국어 patch**                                     | popup 의 UI 텍스트 한국어 (단축 도구·관리 메뉴 등 잡 기능은 제거)                                      |

(옵션) **Chrome Launcher + Playwright CDP 폴백** — `scalemaker-chrome` CLI 가 Chrome 을 `--remote-debugging-port=9222` 로 띄움. native messaging 끊겨도 CDP attach 로 도구 미러. 일반 사용엔 불필요.

## 진단 / 트러블슈팅

설치가 꼬였다면:

```bash
mcp-chrome-scalemaker-bridge doctor          # 상태 점검
mcp-chrome-scalemaker-bridge doctor --fix    # 자동 복구
mcp-chrome-scalemaker-bridge report --copy   # 진단 리포트 (이슈 등록용)
```

## Upstream sync

매주 자동 검사 (`upstream-check.yml`) + 월 1회 정기 sync. 흡수한 PR 이 upstream 머지되면 retire issue 자동 생성. 정책 → [`docs/UPSTREAM_SYNC.md`](./docs/UPSTREAM_SYNC.md)

## 더 자세히

- 설계 → [`docs/DESIGN.md`](./docs/DESIGN.md) (33KB, 9 섹션)
- 흡수 PR 매트릭스 → [`UPSTREAM_DIFF.md`](./UPSTREAM_DIFF.md)
- 강제 재연결 동작 → [`docs/FORCE_RECONNECT.md`](./docs/FORCE_RECONNECT.md)
- 회귀 케이스 → [`docs/REGRESSION_CASES.md`](./docs/REGRESSION_CASES.md)
- Playwright 폴백 → [`docs/PLAYWRIGHT_FALLBACK.md`](./docs/PLAYWRIGHT_FALLBACK.md)

## License

원본 MIT — [`LICENSE`](./LICENSE).
