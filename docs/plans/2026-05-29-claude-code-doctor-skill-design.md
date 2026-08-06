# Claude Code Doctor SKILL — Design

**Date:** 2026-05-29
**Status:** approved (구현 대기)
**Scope:** chrome-mcp-scalemaker 사용자가 troubleshooting 문제를 Claude Code 에 자연어로 말하면 자동으로 `doctor` / `--fix` / `report` 를 호출·해석하고 설정 문제 (CHROME_PORT, 강제포커스) 도 다뤄주는 SKILL.md 를 패키지에 박제 + welcome 페이지의 prompt 박스로 설치 동의 받기.

---

## 의사결정 요약

| 결정            | 선택                                       | 이유                                                                                                                                               |
| --------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 설치 방식       | welcome 의 prompt 박스 → Claude 가 설치    | 사용자 동의 기반 / Claude Code 안 쓰는 사용자 무영향 / npm 패키지 매너 위반 회피                                                                   |
| 스킬 범위       | 진단·복구 + 설정 문제                      | doctor / fix / report + CHROME_PORT env + 강제포커스 토글 + multi-profile 라우팅. 도구 사용법 (chrome_screenshot 등) 은 별도 스킬로 미루기 (YAGNI) |
| Source of truth | repo 안 `app/native-server/skill/SKILL.md` | bridge build 시 dist 로 복사 → npm publish 에 자동 포함 → 버전 동기화 보장                                                                         |

---

## Section 1 — Architecture & 파일 배치

### 1.1 Source of truth: 우리 repo 안에 SKILL.md 박제

```
app/native-server/skill/SKILL.md          ← 단일 source. 코드와 함께 git 관리.
```

- bridge build 시 `dist/skill/SKILL.md` 로 복사 (build.ts 에 한 줄 추가)
- npm package 의 `files` 에 `dist` 이미 포함되어 있어 자동 publish
- 사용자 글로벌 install 후 경로: `<npm root -g>/mcp-chrome-scalemaker-bridge/dist/skill/SKILL.md`

### 1.2 Welcome 페이지 — 새 prompt 박스 (Troubleshooting collapsible 안)

기존 "Troubleshooting / doctor · report" 섹션 펼치면 기존 doctor / fix / report 버튼 **위에** 새 prompt 박스 추가. 기존 manual 버튼은 그대로 유지 (Claude Code 안 쓰는 사용자용 fallback).

```
┌──────────────────────────────────────────────────────┐
│ 🤖 Claude Code 에 troubleshooting 스킬 설치          │
│ ─────────────────────────────────────────────────── │
│ 이 prompt 를 [복사하기] → 터미널 claude 에 붙여넣기  │
│                                                      │
│ ┌──────────────────────────────────────[복사하기]┐  │
│ │ 다음 파일을 ~/.claude/skills/                   │  │
│ │ chrome-mcp-scalemaker-doctor/SKILL.md 로         │  │
│ │ 복사해서 스킬로 등록해줘:                       │  │
│ │   <npm root -g>/mcp-chrome-scalemaker-bridge/    │  │
│ │   dist/skill/SKILL.md                           │  │
│ │ 이후 chrome mcp 관련 문제가 생기면 이 스킬로    │  │
│ │ 자동 진단·복구 시도해줘.                        │  │
│ └─────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

### 1.3 Claude Code 가 실제로 하는 일 (prompt 받은 후)

1. `npm root -g` 실행 → SKILL.md 절대경로 계산
2. `~/.claude/skills/chrome-mcp-scalemaker-doctor/` 디렉토리 생성 (`mkdir -p`)
3. 기존 SKILL.md 존재 시 `head -10` 으로 frontmatter 확인:
   - 같은 name + scalemaker-version 차이 → diff 보여주고 overwrite 동의
   - 다른 name → 사용자 custom 으로 간주, 덮지 않고 알림만
4. 파일 복사 후 "다음에 'mcp 가 안 돼' 같은 말 하면 자동 발동" 안내

→ **사용자가 한 번만 [복사하기] + 붙여넣기 하면 끝. 이후 영구.**

---

## Section 2 — SKILL.md 본문 구조

### 2.1 Frontmatter (Claude Code 가 트리거 결정에 사용)

```yaml
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

  Skip if the user is using upstream hangwin/mcp-chrome (not the scalemaker
  fork) — this skill knows fork-specific commands and architecture.


# scalemaker-version: <bridge version at build time>
---
```

### 2.2 본문 섹션 5개

#### (A) Architecture in 1 minute

bridge / extension / popup / .mcp.json / native messaging host 관계도. 사용자 증상 듣고 어느 layer 인지 분류용.

```
Claude Code session
   ↓ (stdio)
mcp-server-stdio.js  ← env.CHROME_PORT 로 라우팅
   ↓ (HTTP)
http://127.0.0.1:<port>/mcp
   ↓
bridge (Native Messaging Host)
   ↑ (chrome native messaging)
extension service worker (profile-scoped)
   ↑ (popup → 사용자 설정)
popup port input + 강제포커스 토글
```

#### (B) Diagnostic playbook — 증상 → 명령어

| 증상                                 | 1st 명령                              | 후속                                          |
| ------------------------------------ | ------------------------------------- | --------------------------------------------- |
| 연결 안 됨 / disconnected            | `mcp-chrome-scalemaker-bridge doctor` | 빨간불 항목 보고 `--fix`                      |
| 권한 에러 / EACCES                   | `doctor --fix`                        | 안 되면 `fix-permissions` 단독                |
| 두 클로드 세션이 같은 chrome 만 호출 | `.mcp.json` 의 `env.CHROME_PORT` 확인 | 양쪽 다른 port (12315 / 12320) 명시 후 재시작 |
| Chrome 이 자꾸 앞으로 튀어나옴       | popup 의 "강제 포커스" 토글 OFF       | (default 가 이미 OFF — 사용자가 켰을 가능성)  |
| 이슈 등록                            | `report --copy`                       | 클립보드로 마크다운 → GH Issue                |

#### (C) CHROME_PORT 라우팅 (multi-profile)

- `.mcp.json` 의 `env.CHROME_PORT` 가 v1.0.27+ 부터 실제로 read 됨
- 양쪽 working dir 에 다른 port 설정:
  ```json
  "chrome-mcp-stdio": { "env": { "CHROME_PORT": "12315" } }
  ```
- 검증: Claude Code 재시작 후 `/mcp` → chrome-mcp-stdio → View logs 에서
  ```
  [chrome-mcp-stdio] CHROME_PORT=12315 → http://127.0.0.1:12315/mcp
  ```
  line 확인

#### (D) 강제포커스 토글

- popup 의 "실행 상태" 카드 우측 슬라이딩 스위치
- 기본 OFF (v1.0.27+) — MCP 도구 실행 시 OS 윈도우 포커스 안 가로챔
- ON 으로 하면 `chrome.windows.update({focused:true})` 발동 → Chrome 이 다른 앱 앞으로 튀어나옴

#### (E) When to escalate

- doctor 모두 ✅ 인데도 증상 지속 → `report --copy` → GH Issue 에 paste
- 사용자 환경 정보 (OS, Chrome version, Node version, bridge version) 자동 redact 포함

### 2.3 트리거 정확도 — 가짜 트리거 방지

- description 첫 줄에 "chrome-mcp-scalemaker" 패키지명 명시
- "Skip if upstream hangwin/mcp-chrome" line → 다른 fork 사용자에게 false trigger 안 함
- 본문 (A) Architecture 섹션 첫 줄에 "This skill assumes you're on the scalemaker fork — verify with `mcp-chrome-scalemaker-bridge -V`"

### 2.4 갱신 정책 (사용자 dirty 보호)

- `# scalemaker-version: 1.0.28` frontmatter comment 박제 (build 시 자동 주입)
- 다음 install prompt 실행 시 Claude 가 이 라인 비교:
  - 패키지가 더 신선 → diff 보여주고 동의 받아 overwrite
  - 같음 → "이미 최신" 안내, 변경 없음
  - 사용자 custom (name 다름) → 절대 덮지 않음

### 2.5 Bash 호출은 Claude 가 직접

- SKILL 본문에 명시: doctor / fix / report 명령은 Claude 가 Bash tool 로 직접 실행, stdout/stderr 캡처해서 해석
- "이 명령어를 직접 쳐주세요" 같은 hand-off 금지 — 사용자 부담 0

---

## 구현 체크리스트 (다음 세션에서)

1. `app/native-server/skill/SKILL.md` 작성 (본문 5개 섹션)
2. `app/native-server/src/scripts/build.ts` — `dist/skill/SKILL.md` 복사 + frontmatter 의 `# scalemaker-version:` 을 package.json version 으로 치환
3. `app/native-server/package.json` 의 `files` 에 `dist` 가 이미 있는지 확인 (있음 — `["dist", "!dist/node_path.txt"]`)
4. `app/chrome-extension/entrypoints/welcome/App.vue` — Troubleshooting `<details>` 안에 새 prompt 박스 추가 (`COMMANDS` 에 새 key `installSkillPrompt` 추가)
5. 빌드 + 양쪽 (bridge + extension) v1.0.29 로 bump + publish
6. 사용자 테스트 — welcome 에서 [복사하기] → Claude Code 에 붙여넣기 → SKILL 설치 동작 검증 → "MCP가 안 돼" 한 마디로 doctor 자동 발동 확인

---

## 거절한 대안 (Why not)

- **postinstall 자동 설치**: 사용자 동의 없이 `~/.claude/skills/` 건드림 → 매너 위반. Claude Code 안 쓰는 사용자 (Cursor/Cline 등) 에게 쓰레기 파일.
- **CLI `install-skill` 명령**: 그냥 파일 복사 — Claude Code 의 핀환경 동작이 아님. welcome prompt 방식이 더 자연스러움.
- **전체 사용 가이드 (chrome_screenshot 등 도구 사용법까지) 포함**: YAGNI. 한 스킬에 너무 많은 책임 — 필요시 별도 `chrome-mcp-scalemaker-usage` 스킬로 분리 가능.
