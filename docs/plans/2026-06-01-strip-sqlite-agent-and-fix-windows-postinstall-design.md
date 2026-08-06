# strip SQLite/agent + fix Windows postinstall — Design

**Date**: 2026-06-01
**Author**: scalemaker-ship-it (via Claude Code brainstorming)
**Status**: ✅ Implemented in v1.0.36 (2026-06-01)

## 구현 후 정정 사항 (post-implementation note)

구현 중 design 의 가정 중 다음이 실측과 어긋남이 확인되어 다음과 같이 조정함:

| design 의 가정 (6-2.A/D/E/F)                                                | 실측                                                                       | 조정                                                                                                              |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `useAgentTheme.ts` 는 agent-chat 전용 → 삭제                                | popup/sidepanel/welcome 의 **공통 디자인 토큰 시스템** (CSS 변수 `--ac-*`) | **KEEP**. v1.0.30 의 Claude design tokens 가 이 위에 올라가 있음. 삭제 시 popup 색 깨짐.                          |
| `agent-chat.css` → 삭제                                                     | 위 디자인 토큰 정의 파일 (`.agent-theme { --ac-* }`)                       | **KEEP**. 파일명은 historical (예전엔 chat 전용이었으나 토큰 시스템으로 진화).                                    |
| popup/main.ts 의 `preloadAgentTheme` import 제거 + 즉시 mount               | popup 의 색 깜빡임 차단을 위해 필요                                        | **KEEP**. import + preload 호출 그대로. 주석만 일반화.                                                            |
| welcome/App.vue 의 `class="agent-theme welcome-root"` 의 `agent-theme` 제거 | 디자인 토큰 receiver 라 필요                                               | **KEEP**. class 그대로.                                                                                           |
| `useFloatingDrag.ts` 삭제                                                   | `SidepanelNavigator.vue` 가 사용 (chat 외)                                 | **복원** (git checkout).                                                                                          |
| `background/utils/sidepanel.ts` 통째 검토 후 제거                           | quick-panel/web-editor 가 호출 (design Non-goals 의 quick-panel 영역)      | **함수 시그니처 KEEP**, destination 만 `tab=agent-chat` 제거 → default sidepanel 로 fallback. 호출자는 follow-up. |

design 의 핵심 결정 (D-1/D-2/D-3) 은 모두 유지. agent chat **기능** 자체는 완전 제거되었고, 디자인 토큰 시스템 (이름만 agent 인) 은 보존. agent chat 의 server 측 코드 (`agent/` 디렉토리 + route) 와 chrome extension 측 chat UI (`AgentChat.vue`, `agent-chat/`, `agent/`) 는 모두 삭제됨. better-sqlite3 + drizzle-orm + @anthropic-ai/claude-agent-sdk 3개 의존성은 lockfile 까지 완전 제거 확인됨 (`grep ... pnpm-lock.yaml` → 0).

## 검증 결과 (실측)

| 항목                                                                                      | 결과                                                        |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `pnpm install` 시 Python 요구                                                             | ❌ 없음 (native 모듈 컴파일 0)                              |
| `pnpm-lock.yaml` 에서 `better-sqlite3` / `drizzle-orm` / `@anthropic-ai/claude-agent-sdk` | grep hit 0                                                  |
| `pnpm build:shared / build:native / build:extension`                                      | 3개 모두 성공                                               |
| chrome extension chunk 에서 agent-chat 흔적                                               | 0 (useAgentTheme chunk 만 잔존 = design 토큰)               |
| `pnpm --filter mcp-chrome-scalemaker-bridge test` (jest)                                  | **13/13 pass**                                              |
| 타입 에러 baseline 비교                                                                   | HEAD: 125 → after change: 118 (7 감소, 0 새 에러 introduce) |

## 1. Problem

### 1-A. `npm i -g mcp-chrome-scalemaker-bridge` 가 Python 설치를 요구한다

옛날 hangwin 은 안 그랬는데, 우리 fork 부터 (정확히는 **hangwin 의 2025-12-15 commit `704e04d` "feat: add cli agent" 이후 baseline 을 따라간 우리 fork 부터**) Python / VS Build Tools / Xcode CLT 설치를 요구하기 시작.

직접 원인은 `app/native-server/package.json` 에 추가된 **`better-sqlite3@^11.6.0`** — native C++ 모듈이라 사용자 OS/Node 조합에 prebuilt binary 가 없으면 `node-gyp` 로 소스 컴파일 → Python 필요.

같이 추가된:

- `drizzle-orm@^0.38.2` (ORM, 순수 JS — 직접 원인 X)
- `@anthropic-ai/claude-agent-sdk@^0.1.69` (Claude/Codex 호출용, 순수 JS — 직접 원인 X)

세 의존성 모두 **`app/native-server/src/agent/` 하나의 디렉토리에서만 사용**. 우리 fork 의 명시적 타겟 시나리오 (Claude Code → chrome-mcp-stdio → 33 MCP 도구) 에는 전혀 안 쓰임.

### 1-B. Windows 사용자의 `~/Downloads/mcp-chrome-scalemaker-extension-v1.0.X/` 폴더가 비어있다

`app/native-server/src/scripts/postinstall.ts:59-67` 의 Windows extension 다운로드 분기가 silent fail.

```ts
await runCmd('powershell', [
  '-Command',
  `Invoke-WebRequest -Uri "${SCALEMAKER_EXT_URL}" -OutFile "${zipPath}"`,
]);
```

3가지 실패 패턴:

1. **`-UseBasicParsing` 누락** — Internet Explorer DOM 의존성. IE 미설치/비활성 Windows 환경에서 stream 실패.
2. **TLS 버전 미지정** — PowerShell 5.1 default 가 TLS 1.0/1.1. GitHub Release → S3 redirect 의 TLS 1.2 강제와 충돌 시 0 byte 반환.
3. **size 검증 없음** — `runCmd` 가 exit 0 만 보고, **0 byte 파일도 OK 로 처리**. 뒤이은 `tar -xf` 가 빈 zip 을 silent 압축 해제 (exit 0) → 디렉토리는 만들지만 안에 파일 없음.

## 2. Goals

1. `npm i -g mcp-chrome-scalemaker-bridge` 가 **Python / VS Build Tools / Xcode CLT 일절 요구하지 않게** 만들기. 옛날 hangwin (2025-12-15 이전) install 경험 복원.
2. Windows postinstall 의 extension 다운로드 단계를 **robust** 하게: 다운로드 실패는 loud failure 로, 빈 폴더 절대 생성 안 함.
3. 위 두 가지가 우리 fork 의 **명시적 기능 (Force Reconnect, Playwright CDP fallback, Diagnostic UI, MCP 33 도구)** 에 영향 없도록 한다.

## 3. Non-goals

- Playwright dep 제거. (CDP 폴백은 우리 fork 의 핵심 가치. 별도 작업으로 다룬다.)
- hangwin upstream 과의 sync 정책 변경. (`UPSTREAM_DIFF.md` 의 retire 조건은 그대로.)
- chrome extension 의 workflows / element-markers 탭 변경. (agent-chat 만 제거.)
- Quick Panel (Ctrl+Shift+U) 의 처리. (이건 별도 검토 — hangwin 의 `quick-panel.js` 가 91KB. 일단 이번 작업에선 건드리지 않음. follow-up.)

## 4. Decisions (확정)

| #   | 결정                                                                                      | 사용자 확정 |
| --- | ----------------------------------------------------------------------------------------- | ----------- |
| D-1 | native-server 의 `agent/` 디렉토리 통째 삭제 + 3개 의존성 제거                            | ✅          |
| D-2 | chrome extension 의 agent-chat **완전 제거** (탭, 컴포넌트, CSS, 진입점, URL 라우팅 모두) | ✅          |
| D-3 | Windows postinstall PowerShell 다운로드 fix 를 같은 작업에서 처리                         | ✅          |

## 5. Scope 1 — native-server agent 완전 제거

### 5-1. 삭제 대상 파일/디렉토리

```
app/native-server/src/agent/                  ← 통째 삭제
app/native-server/src/agent/chat-service.ts
app/native-server/src/agent/session-service.ts
app/native-server/src/agent/project-service.ts
app/native-server/src/agent/message-service.ts
app/native-server/src/agent/attachment-service.ts
app/native-server/src/agent/db/                ← schema, client, index
app/native-server/src/agent/engines/            ← claude.ts, codex.ts, types.ts
app/native-server/src/server/routes/agent.ts   ← HTTP route 통째 삭제
```

### 5-2. 수정 대상 파일

| 파일                                              | 변경                                                                                                                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/native-server/package.json`                  | `dependencies` 에서 `better-sqlite3`, `drizzle-orm`, `@anthropic-ai/claude-agent-sdk` 제거. `devDependencies` 에서 `@types/better-sqlite3` 제거.               |
| `app/native-server/src/server/index.ts:27-30, 62` | `AgentChatService`, `CodexEngine`, `ClaudeEngine`, `closeDb` import 제거. `engines: [...]` 부트 코드 제거. fastify route registration 에서 `agentRoutes` 제거. |
| `app/native-server/src/scripts/utils.ts:130`      | "better-sqlite3" 언급 주석을 generic 문구로 ("native modules" 같은 일반론).                                                                                    |
| `app/native-server/src/scripts/build.ts:140`      | 동일.                                                                                                                                                          |
| `pnpm-lock.yaml`                                  | `pnpm install` 자동 재생성.                                                                                                                                    |

### 5-3. 기존 사용자의 DB 파일

`~/.mcp-chrome-scalemaker/agent.db` (또는 `agent.sqlite`) 같은 파일이 있을 수 있음. 우리 fork 가 정식 release 안 했으니 dogfood 사용자 대상.

**조치**: postinstall 에서 잔존 DB 파일을 **silent 삭제** (없으면 no-op). 사용자 경고 없이 청소. 데이터 유실 risk 평가 → agent chat 세션 기록 외엔 없으므로 무시 가능.

```ts
// postinstall.ts 에 추가
const legacyDbPaths = [
  path.join(SCALEMAKER_INSTALL_ROOT, 'agent.db'),
  path.join(SCALEMAKER_INSTALL_ROOT, 'agent.sqlite'),
];
for (const p of legacyDbPaths) {
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
```

## 6. Scope 2 — chrome extension agent-chat 완전 제거

### 6-1. 삭제 대상 파일

```
app/chrome-extension/entrypoints/sidepanel/components/AgentChat.vue
app/chrome-extension/entrypoints/sidepanel/composables/useAgentTheme.ts
app/chrome-extension/entrypoints/sidepanel/styles/agent-chat.css
app/chrome-extension/entrypoints/sidepanel/components/AgentChat/  ← 하위 디렉토리 있으면 통째
```

### 6-2. 수정 대상 파일

#### A. `entrypoints/sidepanel/App.vue`

- L5: `v-if="activeTab !== 'agent-chat'"` 제거 (조건 자체를 없앰)
- L33-34: `<div v-show="activeTab === 'agent-chat'"><AgentChat /></div>` 제거
- L293: `import AgentChat from './components/AgentChat.vue'` 제거
- L296: `useAgentTheme` import 제거 (composable 자체를 지움)
- L300: `const { theme, initTheme } = useAgentTheme()` 제거
- L303: `activeTab` 타입에서 `'agent-chat'` 제거 + **default 값을 `'workflows'` 로 변경**
- L306: `handleTabChange` 시그니처에서 `'agent-chat'` 제거
- L740-741: URL param `?tab=agent-chat` 처리 분기 제거 (workflows 로 fallback)

#### B. `entrypoints/sidepanel/components/SidepanelNavigator.vue`

- L52-53, 75: agent-chat 탭 버튼 제거
- L175: `TabType` 에서 `'agent-chat'` 제거

#### C. `entrypoints/popup/App.vue`

- L626: `openSidepanelAndClose('agent-chat')` 호출 함수 통째 제거
- L626 호출 함수가 template 에서 어디서 binding 되는지 추적해서 해당 button/UI 도 제거
- L258, 282, 2807: `useAgentTheme`, `agent-theme`, `entry-icon.agent` 흔적 제거. popup root class `class="popup-container agent-theme"` → `class="popup-container"` 로 변경.

#### D. `entrypoints/popup/main.ts`

- L5: `import '../sidepanel/styles/agent-chat.css'` 제거
- L6: `import { preloadAgentTheme } from '../sidepanel/composables/useAgentTheme'` 제거
- L11: `preloadAgentTheme().then(...)` → 그냥 즉시 `createApp(App).mount('#app')` + ENSURE_NATIVE message 전송

#### E. `entrypoints/welcome/App.vue`

- L4: `import '../sidepanel/styles/agent-chat.css'` 제거
- L74: `class="agent-theme welcome-root"` → `class="welcome-root"`
- 만약 다른 곳에서 `agent-theme` CSS 변수에 의존하면 그 시각 토큰들을 `welcome-root` 내부에서 직접 정의 (이미 v1.0.30 즈음 Claude design tokens 로 옮긴 흔적 있음 → 충돌 가능성 점검)

#### F. `entrypoints/background/utils/sidepanel.ts`

전체 삭제 검토. 이 헬퍼는 web-editor/quick-panel 에서 호출되므로 호출처도 함께 봐야 함. 호출처가 모두 agent-chat 진입용이면 통째 제거. 다른 용도면 `tab=agent-chat` 분기만 빼기.

### 6-3. 빌드 산출물 cleanup

```
app/chrome-extension/.output/chrome-mv3/assets/agent-chat-ypbYzAUS.css   ← 다음 build 시 자동 사라짐
```

`pnpm build:extension` 한 번 돌리면 stale artifact 자동 제거됨. CI 검증 (`grep agent-chat .output/chrome-mv3 -r` → 0 hit) 추가.

## 7. Scope 3 — Windows postinstall extension 다운로드 fix

### 7-1. 변경 위치

`app/native-server/src/scripts/postinstall.ts:58-86` (downloadAndExtractExtension 의 try block).

### 7-2. fix 들

#### Fix-1: PowerShell 명령 강화

```ts
if (os.platform() === 'win32') {
  await runCmd('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    [
      `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12`,
      `$ProgressPreference = 'SilentlyContinue'`, // progress bar 가 stdout 점유 차단
      `Invoke-WebRequest -UseBasicParsing -Uri "${SCALEMAKER_EXT_URL}" -OutFile "${zipPath}"`,
    ].join('; '),
  ]);
}
```

추가 사항:

- `-NoProfile` — 사용자 PS profile 로 인한 부수 효과 제거
- `-ExecutionPolicy Bypass` — restricted 정책 우회
- `TLS 1.2 강제` — GitHub Release → S3 의 redirect 통과 보장
- `$ProgressPreference = 'SilentlyContinue'` — progress bar IE DOM 의존성 회피 (가장 흔한 silent fail 원인)
- `-UseBasicParsing` — IE 의존성 명시적 제거

#### Fix-2: 다운로드 size 검증

```ts
const stat = fs.statSync(zipPath);
if (stat.size < 1024) {
  // 1KB 미만 = 거의 확실히 실패한 다운로드 (정상 extension zip 은 5-15MB)
  fs.unlinkSync(zipPath);
  throw new Error(
    `Extension zip download returned suspiciously small file (${stat.size} bytes) — likely TLS/proxy failure`,
  );
}
```

#### Fix-3: 압축 해제 후 파일 카운트 검증

```ts
const files = fs.readdirSync(SCALEMAKER_EXT_DIR);
if (files.length === 0) {
  fs.rmdirSync(SCALEMAKER_EXT_DIR);
  throw new Error(`Extension extraction produced empty directory — zip may be corrupt`);
}
// manifest.json 존재까지 확인 (확장 zip 의 필수 파일)
const manifestPath = path.join(SCALEMAKER_EXT_DIR, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  throw new Error(`Extension zip extracted but manifest.json missing — corrupt zip`);
}
```

#### Fix-4: 실패 시 명확한 fallback 안내

실패 메시지에 **수동 다운로드 URL + 압축 해제 destination** 둘 다 표시. PowerShell error 의 stderr 도 같이 표시 (현재 잘림).

```ts
catch (e) {
  console.log(colorText(`\n❌ Extension auto-download failed: ${(e as Error).message}`, 'red'));
  console.log(colorText(`\n수동 다운로드:`, 'yellow'));
  console.log(`  1) ${SCALEMAKER_EXT_URL}`);
  console.log(`  2) 다운받은 zip 을 다음 폴더에 압축 해제:`);
  console.log(colorText(`     ${SCALEMAKER_EXT_DIR}`, 'green'));
  console.log(`  3) chrome://extensions → Developer mode ON → Load unpacked → 그 폴더 선택`);
  return null;
}
```

### 7-3. Windows 외 플랫폼은?

curl 기반 macOS/Linux 분기에도 같은 robustness 추가:

- `curl -fsSL` 의 `-f` (fail on HTTP 4xx/5xx) 는 이미 있음 ✅
- size 검증 + manifest.json 검증 → **공통 path 로 빼서 양쪽 다 적용**

## 8. Migration / 사용자 영향

| 사용자 그룹                                           | 영향                                                     | 마이그레이션                                                                             |
| ----------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Claude Code + MCP 도구만 쓰는 사용자 (= primary user) | ✅ 영향 없음. install 경험 ↑↑↑.                          | 그냥 `npm i -g` 새로 받기만 하면 됨.                                                     |
| sidepanel 의 agent-chat 을 모르고 있던 사용자         | 영향 없음 (못 봤으니까)                                  | 없음                                                                                     |
| sidepanel 의 agent-chat 을 실제로 쓰던 사용자         | 🟡 **기능 사라짐**. sidepanel 열어도 agent chat 탭 없음. | hangwin upstream (`hangwin/mcp-chrome` 1.0.29+) 으로 가야 함. README 에 안내 한 줄 추가. |
| `~/.mcp-chrome-scalemaker/agent.db` 가 있는 사용자    | 🟢 silent 삭제. 잃을 것은 chat 세션 기록뿐.              | 없음                                                                                     |

## 9. Verification

### 9-1. install 검증 (Python 안 묻는지)

3개 환경에서 clean install:

| OS                 | Node        | 검증 명령                               | 기대 결과                                                                                             |
| ------------------ | ----------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| macOS arm64        | 24.x (최신) | `npm i -g mcp-chrome-scalemaker-bridge` | Python 안 묻고 완료. native 모듈 컴파일 0                                                             |
| Windows 11 x64     | 22.x LTS    | `npm i -g mcp-chrome-scalemaker-bridge` | Python 안 묻고 완료. `~/Downloads/mcp-chrome-scalemaker-extension-v*/` 에 manifest.json 포함 ~95 파일 |
| Linux Ubuntu 22.04 | 20.x LTS    | `npm i -g mcp-chrome-scalemaker-bridge` | Python 안 묻고 완료                                                                                   |

**Python 묻는지 어떻게 알지?**: install 출력에 `node-gyp`, `python`, `gyp ERR!`, `Microsoft Visual C++ Build Tools` 단어가 등장하면 fail. `npm install --loglevel=verbose 2>&1 | grep -iE "python|node-gyp|gyp"` 에 hit 없으면 pass.

### 9-2. 기능 회귀 검증

| 기능                                            | 검증 방법                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| MCP 33 도구 (navigate, click, screenshot, etc.) | `pnpm --filter mcp-chrome-scalemaker-bridge test` (jest) — 기존 13개 테스트 통과 유지 |
| Force Reconnect 5단계                           | popup → "강제 재연결" 버튼 → 정상 reconnect                                           |
| Playwright CDP 폴백                             | 환경변수로 native 끄고 playwright 활성, MCP 도구 호출 가능                            |
| Diagnostic Report                               | popup → 진단 리포트 → 4 stage 모두 ✓                                                  |
| sidepanel                                       | workflows, element-markers 탭만 보임. agent-chat 흔적 0                               |
| popup                                           | 빨간/노란/녹색 status. sidepanel 여는 버튼 (있다면) workflows/element-markers 만      |
| welcome                                         | "Claude Code 등록 prompt" 박스 정상. 색감 변경 없음 (Claude design tokens)            |

### 9-3. Windows postinstall 회귀

수동: Windows 11 머신에서 `npm i -g mcp-chrome-scalemaker-bridge` → 다음 확인:

- `~/Downloads/mcp-chrome-scalemaker-extension-v1.0.36/` 안에 `manifest.json`, `background.js`, `assets/` 등 다 있음
- `agent-chat-*.css` 는 없음 (= scope 2 결과)
- `VERSION` 파일 정상 작성

다운로드 실패 시뮬레이션: `SCALEMAKER_EXT_URL` 을 invalid URL 로 임시 변경 → loud error + manual fallback 안내 출력 + 빈 폴더 생성 안 됨.

## 10. Risks / Tradeoffs

| Risk                                                 | 평가                                                                                                                  | mitigation            |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------- |
| hangwin upstream 과의 conflict 증가                  | 🟢 낮음. agent 디렉토리는 한 곳에 격리되어 있어 sync 시 해당 디렉토리만 무시하면 됨. `UPSTREAM_DIFF.md` 에 명시 추가. | sync 정책 갱신        |
| sidepanel 사용자가 변화에 놀람                       | 🟡 가능. welcome 에 한 줄 안내 추가 ("sidepanel 의 chat 기능은 v1.0.36 부터 제거됨. hangwin upstream 으로 이동 가능") | release note 명시     |
| Windows PowerShell 5.1 미만 환경 (Windows 7 etc.)    | 🟢 매우 낮음. fork target 은 Windows 10+ 만. doctor 에서 OS 검증 이미 있음.                                           | —                     |
| `useAgentTheme` 가 다른 곳에서 import 되어 빌드 실패 | 🟡 grep 으로 모든 import 사이트 추적 → 한 번에 정리. CI 의 `pnpm build` 가 catch.                                     | 작업 전 grep 한 번 더 |

## 11. Versioning

- 다음 release: **`scalemaker-v1.0.36`**.
- `package.json` 의 모든 version field 일괄 bump (1.0.35 → 1.0.36).
- release note 의 강조 포인트:
  - "🐍 Python install prompt 영구 제거 (better-sqlite3 의존성 삭제)"
  - "🪟 Windows extension 자동 다운로드 robust 화 (빈 폴더 문제 해결)"
  - "🧹 사용 안 하던 agent chat UI 제거 — 빌드 크기 ↓"

## 12. Implementation order

1. **branch 분기**: `main-scalemaker` 에서 worktree 따고 작업 (using-git-worktrees 스킬)
2. **Scope 1** (native-server agent 제거) — clean. typecheck + jest 통과 확인.
3. **Scope 2** (chrome-extension agent-chat 제거) — typecheck + `pnpm build:extension` 통과 확인.
4. **Scope 3** (Windows postinstall fix) — 빌드 확인. Windows VM 또는 GitHub Actions windows runner 로 verify.
5. version bump 1.0.36.
6. `pnpm install` → lockfile 갱신.
7. local install → `pnpm publish` dry run.
8. release tag → GitHub Release 자동 빌드.
9. README 업데이트 (변경 사항 한 줄).

## 13. Out of scope (followup)

- `quick-panel.js` 와 `Ctrl+Shift+U` 단축키 처리. Scope 2 에서 일단 안 건드림.
- `chrome-devtools-frontend@^1.0.1299282` dep 가 정말 필요한지 검토 (debugger 도구가 안 쓰면 ↓ install 크기).
- Playwright 를 optional dep 으로 분리 (CDP 폴백 실제 트리거 시점에 lazy install).
