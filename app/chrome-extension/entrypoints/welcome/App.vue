<script setup lang="ts">
import { ref } from 'vue';

// agent-theme 디자인 토큰 시스템 (v1.0.36 chat UI 제거됐으나 CSS 변수는 유지)
import '../sidepanel/styles/agent-chat.css';

// scalemaker fork: 두 설치 경로별 next-step 분리
// (A) npm 자동 설치자: bridge + manifest + extension zip 까지 자동
// (B) zip 수동 설치자: extension 만 받은 상태 → bridge 따로 깔아야 함
// v1.0.20: extension 폴더명에 버전 박제 — postinstall.ts 의 SCALEMAKER_EXT_DIR 과 동일 규약.
//   manifest 의 version 을 직접 읽어 어긋남 방지.
const SCALEMAKER_VERSION = chrome.runtime.getManifest().version;
const COMMANDS = {
  // 메인 npm 설치 — postinstall 이 manifest 등록 + extension zip 다운로드 자동 수행
  npmInstall: 'npm install -g mcp-chrome-scalemaker-bridge',
  // Claude Code 에 줄 prompt — 사용자가 [Copy] → 터미널의 Claude Code 에 붙여넣기
  claudePrompt: `지금 working dir (이 프로젝트 폴더) 의 .mcp.json 에 우리 chrome MCP (mcp-chrome-scalemaker) 를 등록해줘. ~/.claude.json 같은 전역 설정에는 손대지 마.

규칙:
- 이름: "chrome-mcp-stdio"
- transport: stdio (HTTP 안 씀)
- command: "node"
- args: ["<npm root -g 출력값>/mcp-chrome-scalemaker-bridge/dist/mcp/mcp-server-stdio.js"]
- env: { "CHROME_PORT": "12320" }

먼저 \`npm root -g\` 를 bash 로 실행해서 실제 경로 얻고, 그 다음에 working dir 의 .mcp.json (없으면 신설) 의 mcpServers.chrome-mcp-stdio 만 추가/갱신해줘. 기존 다른 server 항목은 보존.

등록이 끝나면 아래 절차도 함께 안내해줘:
1. Claude Code 를 Ctrl+C 두 번으로 종료 후 다시 실행 (mcp 서버 재로드)
2. \`/mcp\` 입력해서 chrome-mcp-stdio 가 connected 상태인지 확인
3. 확인 후 Esc 로 빠져나오기`,
  // v1.0.30+: troubleshooting 스킬은 postinstall 이 자동 설치 (~/.claude/ 가 있을 때만).
  // 별도 install prompt 박스 불필요.
  // GitHub repo
  repoUrl: 'https://github.com/scalemaker-ship-it/mcp-chrome-scalemaker',
  // 우리 fork extension ID (deterministic)
  extensionId: 'aogfhfajjknomcnmlkbjmihjbknlhbbi',
  // chrome://extensions URL — 가시화용
  chromeExtensions: 'chrome://extensions',
  // 수동 설치자가 Load unpacked 할 경로 (npm 설치자도 동일)
  extensionPath: `~/Downloads/mcp-chrome-scalemaker-extension-v${SCALEMAKER_VERSION}/`,
} as const;

type CommandKey = keyof typeof COMMANDS;

const copiedKey = ref<CommandKey | null>(null);

// 사용자가 어느 경로로 들어왔는지 선택 — 기본은 'npm' (가장 흔한 경로)
type InstallPath = 'npm' | 'zip';
const activePath = ref<InstallPath>('npm');

function copyLabel(key: CommandKey): string {
  return copiedKey.value === key ? '✅ 복사됨' : '복사하기';
}

function copyColor(key: CommandKey): string {
  return copiedKey.value === key ? 'var(--ac-success)' : 'var(--ac-text-muted)';
}

async function copyCommand(key: CommandKey): Promise<void> {
  try {
    await navigator.clipboard.writeText(COMMANDS[key]);
    copiedKey.value = key;
    window.setTimeout(() => {
      if (copiedKey.value === key) copiedKey.value = null;
    }, 2000);
  } catch (err) {
    console.error('Failed to copy:', err);
    copiedKey.value = null;
  }
}
</script>

<template>
  <div class="agent-theme welcome-root">
    <div class="min-h-screen flex flex-col">
      <header class="welcome-header flex-none px-6 py-5">
        <div class="max-w-3xl mx-auto flex items-center justify-between gap-4">
          <div class="flex items-center gap-3 min-w-0">
            <div
              class="welcome-icon w-10 h-10 flex items-center justify-center flex-shrink-0"
              aria-hidden="true"
            >
              <svg
                class="w-6 h-6"
                :style="{ color: 'var(--ac-accent)' }"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M13 10V3L4 14h7v7l9-11h-7z"
                />
              </svg>
            </div>
            <div class="min-w-0">
              <h1 class="welcome-title text-lg font-medium tracking-tight truncate">
                ScaleMaker Chrome Mcp
              </h1>
              <p class="welcome-muted text-sm truncate"> 확장 설치 후 남은 마지막 단계입니다. </p>
            </div>
          </div>
        </div>
      </header>

      <main class="flex-1 px-6 py-8">
        <div class="max-w-3xl mx-auto space-y-6">
          <!-- 경로 선택 탭 -->
          <section class="welcome-card p-2">
            <div class="welcome-tabs grid grid-cols-2 gap-2">
              <button
                class="welcome-tab px-4 py-3 text-sm font-medium"
                :class="{ 'welcome-tab--active': activePath === 'npm' }"
                @click="activePath = 'npm'"
              >
                <div class="welcome-mono welcome-subtle text-[10px] uppercase tracking-widest">
                  Path A
                </div>
                <div class="welcome-title mt-0.5">npm 명령어로 설치</div>
                <div class="welcome-muted text-xs mt-0.5">
                  <code class="welcome-code">npm install -g</code> 로 깔았다면
                </div>
              </button>
              <button
                class="welcome-tab px-4 py-3 text-sm font-medium"
                :class="{ 'welcome-tab--active': activePath === 'zip' }"
                @click="activePath = 'zip'"
              >
                <div class="welcome-mono welcome-subtle text-[10px] uppercase tracking-widest">
                  Path B
                </div>
                <div class="welcome-title mt-0.5">zip 으로 수동 설치</div>
                <div class="welcome-muted text-xs mt-0.5">
                  GitHub Release 에서 zip 만 받았다면
                </div>
              </button>
            </div>
          </section>

          <!-- Path A: npm 자동 설치자 -->
          <section v-if="activePath === 'npm'" class="welcome-card welcome-card--primary p-6">
            <h2 class="welcome-title text-xl font-medium">
              npm 으로 설치한 경우 — 거의 다 끝났습니다
            </h2>
            <p class="welcome-muted text-sm mt-2">
              <code class="welcome-code welcome-code-inline px-1 py-0.5"
                >npm install -g mcp-chrome-scalemaker-bridge</code
              >
              가 postinstall 에서 자동으로 처리한 것:
            </p>

            <ul class="welcome-checklist mt-3 space-y-1.5 text-sm">
              <li>✅ Bridge 전역 설치</li>
              <li
                >✅ Native Messaging manifest 등록 (<code class="welcome-code"
                  >com.chromemcpscalemaker.nativehost</code
                >)</li
              >
              <li
                >✅ Extension zip 다운로드 →
                <code class="welcome-code">{{ COMMANDS.extensionPath }}</code></li
              >
            </ul>

            <div
              class="mt-6 pt-5"
              :style="{ borderTop: 'var(--ac-border-width) solid var(--ac-border)' }"
            >
              <h3 class="welcome-title text-base font-medium">마지막 단계 — Claude Code 에 등록</h3>

              <ol class="mt-4 space-y-4 welcome-steps">
                <li class="welcome-step">
                  <div class="welcome-step-num">1</div>
                  <div class="min-w-0">
                    <div class="welcome-title text-sm font-medium">Claude Code 에 등록</div>
                    <p class="welcome-muted text-sm mt-1">
                      아래 prompt 를 [복사하기] → 터미널의
                      <code class="welcome-code welcome-code-inline px-1 py-0.5">claude</code> 에
                      붙여넣기. Claude Code 가
                      <code class="welcome-code welcome-code-inline px-1 py-0.5">.mcp.json</code> 에
                      <code class="welcome-code welcome-code-inline px-1 py-0.5"
                        >chrome-mcp-stdio</code
                      >
                      자동 등록.
                    </p>
                    <div class="welcome-command-row welcome-command-row--prompt mt-3">
                      <button
                        class="welcome-mono welcome-copy-floating ac-btn"
                        :style="{ color: copyColor('claudePrompt') }"
                        @click="copyCommand('claudePrompt')"
                      >
                        {{ copyLabel('claudePrompt') }}
                      </button>
                      <pre
                        class="welcome-code text-xs break-all"
                        style="white-space: pre-wrap; margin: 0"
                        >{{ COMMANDS.claudePrompt }}</pre
                      >
                    </div>
                    <p class="welcome-subtle text-xs mt-2">
                      등록 후 Claude Code 재시작 →
                      <code class="welcome-code welcome-code-inline px-1 py-0.5">/mcp</code> 로 활성
                      확인.
                    </p>
                  </div>
                </li>
              </ol>
              <p class="welcome-subtle text-xs mt-4">
                troubleshooting 스킬 (
                <code class="welcome-code welcome-code-inline px-1 py-0.5"
                  >~/.claude/skills/chrome-mcp-scalemaker-doctor/</code
                >
                ) 도 npm 설치 시 자동 등록됩니다. 이후 "MCP 안 돼" 한 마디로 자동 진단·복구.
              </p>
            </div>
          </section>

          <!-- Path B: zip 수동 설치자 -->
          <section v-if="activePath === 'zip'" class="welcome-card welcome-card--primary p-6">
            <h2 class="welcome-title text-xl font-medium">
              zip 으로 수동 설치한 경우 — Bridge 추가 설치 필요
            </h2>
            <p class="welcome-muted text-sm mt-2">
              extension zip 만 받아서 Load unpacked 했다면, Native Messaging host (bridge) 는
              <strong>아직 안 깔린 상태</strong>입니다. Chrome 이 extension 과 통신할 수 없으니
              bridge 설치 필수.
            </p>

            <div
              class="mt-6 pt-5"
              :style="{ borderTop: 'var(--ac-border-width) solid var(--ac-border)' }"
            >
              <h3 class="welcome-title text-base font-medium">남은 단계 — 2개</h3>

              <ol class="mt-4 space-y-4 welcome-steps">
                <li class="welcome-step">
                  <div class="welcome-step-num">1</div>
                  <div class="min-w-0">
                    <div class="welcome-title text-sm font-medium">
                      Bridge 설치 — Native Messaging manifest + troubleshooting 스킬 자동 등록
                    </div>
                    <p class="welcome-muted text-sm mt-1"> 터미널에서: </p>
                    <div
                      class="welcome-command-row mt-3 flex items-center justify-between gap-3 px-4 py-3"
                    >
                      <code class="welcome-code text-sm break-all">{{ COMMANDS.npmInstall }}</code>
                      <button
                        class="welcome-mono px-2 py-1 text-xs font-medium ac-btn flex-shrink-0"
                        :style="{ color: copyColor('npmInstall') }"
                        @click="copyCommand('npmInstall')"
                      >
                        {{ copyLabel('npmInstall') }}
                      </button>
                    </div>
                    <p class="welcome-subtle text-xs mt-2">
                      postinstall 이 자동으로 manifest 등록 +
                      <code class="welcome-code welcome-code-inline px-1 py-0.5"
                        >com.chromemcpscalemaker.nativehost.json</code
                      >
                      배치. Node.js 20+ 필요 —
                      <code class="welcome-code welcome-code-inline px-1 py-0.5">node -v</code> 로
                      확인.
                    </p>
                  </div>
                </li>

                <li class="welcome-step">
                  <div class="welcome-step-num">2</div>
                  <div class="min-w-0">
                    <div class="welcome-title text-sm font-medium">Claude Code 에 등록</div>
                    <p class="welcome-muted text-sm mt-1">
                      아래 prompt 를 [복사하기] → 터미널의
                      <code class="welcome-code welcome-code-inline px-1 py-0.5">claude</code> 에
                      붙여넣기. Claude Code 가
                      <code class="welcome-code welcome-code-inline px-1 py-0.5">.mcp.json</code> 에
                      <code class="welcome-code welcome-code-inline px-1 py-0.5"
                        >chrome-mcp-stdio</code
                      >
                      자동 등록.
                    </p>
                    <div class="welcome-command-row welcome-command-row--prompt mt-3">
                      <button
                        class="welcome-mono welcome-copy-floating ac-btn"
                        :style="{ color: copyColor('claudePrompt') }"
                        @click="copyCommand('claudePrompt')"
                      >
                        {{ copyLabel('claudePrompt') }}
                      </button>
                      <pre
                        class="welcome-code text-xs break-all"
                        style="white-space: pre-wrap; margin: 0"
                        >{{ COMMANDS.claudePrompt }}</pre
                      >
                    </div>
                    <p class="welcome-subtle text-xs mt-2">
                      등록 후 Claude Code 재시작 →
                      <code class="welcome-code welcome-code-inline px-1 py-0.5">/mcp</code> 로 활성
                      확인.
                    </p>
                  </div>
                </li>
              </ol>
              <p class="welcome-subtle text-xs mt-4">
                troubleshooting 스킬 (
                <code class="welcome-code welcome-code-inline px-1 py-0.5"
                  >~/.claude/skills/chrome-mcp-scalemaker-doctor/</code
                >
                ) 도 step 1 의 npm 설치 시 자동 등록됩니다. 이후 "MCP 안 돼" 한 마디로 자동
                진단·복구.
              </p>
            </div>
          </section>

          <!-- v1.0.29+: 별도 스킬 설치 섹션은 각 Path 의 마지막 step (선택) 으로 흡수됨. -->
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.welcome-root {
  min-height: 100%;
  background: var(--ac-bg);
  background-image: var(--ac-bg-pattern);
  background-size: var(--ac-bg-pattern-size);
  color: var(--ac-text);
  font-family: var(--ac-font-body);
}

.welcome-header {
  background: var(--ac-header-bg);
  border-bottom: var(--ac-border-width) solid var(--ac-header-border);
  backdrop-filter: blur(8px);
}

.welcome-card {
  background: var(--ac-surface);
  border: var(--ac-border-width) solid var(--ac-border);
  border-radius: var(--ac-radius-card);
  box-shadow: var(--ac-shadow-card);
}

.welcome-card--primary {
  box-shadow: var(--ac-shadow-float);
}

.welcome-icon {
  background: var(--ac-surface);
  border: var(--ac-border-width) solid var(--ac-border);
  border-radius: var(--ac-radius-card);
  box-shadow: var(--ac-shadow-card);
}

.welcome-title {
  font-family: var(--ac-font-heading);
  color: var(--ac-text);
}

.welcome-muted {
  color: var(--ac-text-muted);
}

.welcome-subtle {
  color: var(--ac-text-subtle);
}

.welcome-mono {
  font-family: var(--ac-font-mono);
}

.welcome-code {
  font-family: var(--ac-font-code);
}

.welcome-button {
  font-family: var(--ac-font-mono);
  color: var(--ac-text-muted);
  background: var(--ac-surface);
  border: var(--ac-border-width) solid var(--ac-border);
  border-radius: var(--ac-radius-button);
  cursor: pointer;
  transition: all 0.2s ease;
}

.welcome-button:hover {
  background: var(--ac-hover-bg-subtle);
}

.welcome-command-row {
  background: var(--ac-code-bg);
  border: var(--ac-border-width) solid var(--ac-code-border);
  border-radius: var(--ac-radius-inner);
}

/* v1.0.28: prompt 박스 — 복사 버튼이 우상단에 진짜로 float (텍스트 위로 떠 있음). */
.welcome-command-row--prompt {
  position: relative;
  padding: 16px;
}

.welcome-copy-floating {
  position: absolute;
  top: 8px;
  right: 8px;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 500;
  background: rgba(255, 255, 255, 0.92);
  border: var(--ac-border-width) solid var(--ac-border);
  border-radius: var(--ac-radius-button);
  z-index: 2;
  backdrop-filter: blur(4px);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
}

.welcome-copy-floating:hover {
  background: #ffffff;
  border-color: var(--ac-accent);
}

.welcome-alt-row {
  background: var(--ac-surface-muted);
  border: var(--ac-border-width) solid var(--ac-border);
  border-radius: var(--ac-radius-inner);
}

.welcome-report-card {
  background: var(--ac-diff-del-bg);
  border: var(--ac-border-width) solid var(--ac-diff-del-border);
  border-radius: var(--ac-radius-inner);
}

.welcome-code-inline {
  background: var(--ac-hover-bg-subtle);
  border: var(--ac-border-width) solid var(--ac-border);
  border-radius: 6px;
}

.ac-btn {
  cursor: pointer;
  transition: all 0.2s ease;
}

.ac-btn:hover {
  opacity: 0.8;
}

summary {
  list-style: none;
}

summary::-webkit-details-marker {
  display: none;
}

/* 설치 경로 탭 */
.welcome-tab {
  background: transparent;
  border: var(--ac-border-width) solid transparent;
  border-radius: var(--ac-radius-inner);
  text-align: left;
  cursor: pointer;
  transition: all 0.15s ease;
}

.welcome-tab:hover {
  background: var(--ac-hover-bg-subtle);
}

.welcome-tab--active {
  background: var(--ac-surface-muted);
  border-color: var(--ac-accent);
  box-shadow: 0 0 0 1px var(--ac-accent);
}

/* 자동 처리된 항목 체크리스트 */
.welcome-checklist {
  list-style: none;
  padding: 0;
  margin: 0;
  color: var(--ac-text);
}

.welcome-checklist li {
  padding: 6px 0;
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

/* 번호가 매겨진 step */
.welcome-steps {
  list-style: none;
  padding: 0;
  margin: 0;
  counter-reset: step;
}

.welcome-step {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}

.welcome-step-num {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--ac-accent);
  color: var(--ac-on-accent, #fff);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--ac-font-mono);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
}
</style>
