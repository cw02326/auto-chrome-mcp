#!/usr/bin/env bash
# mcp-chrome-scalemaker — one-liner installer
#
# 사용:
#   curl -fsSL https://github.com/scalemaker-ship-it/mcp-chrome-scalemaker/raw/main-scalemaker/install.sh | bash
#
# 동작:
#   1. bridge .tgz 다운로드 → npm i -g (postinstall 자동 native messaging manifest 등록)
#   2. extension .zip 다운로드 → ~/Downloads/mcp-chrome-scalemaker-extension/ 압축 해제
#   3. Claude Code 의 ~/.mcp.json 또는 working-dir .mcp.json 에 chrome-mcp-stdio 등록 안내
#   4. chrome://extensions Load unpacked 안내

set -euo pipefail

REPO="scalemaker-ship-it/mcp-chrome-scalemaker"
RELEASE_TAG="${SCALEMAKER_TAG:-scalemaker-v1.0.15}"
BRIDGE_TGZ="mcp-chrome-scalemaker-bridge-1.0.15.tgz"
EXT_ZIP="chrome-mcp-scalemaker-extension.zip"
INSTALL_ROOT="${SCALEMAKER_INSTALL_ROOT:-$HOME/.mcp-chrome-scalemaker}"
EXTENSION_DIR="${SCALEMAKER_EXTENSION_DIR:-$HOME/Downloads/mcp-chrome-scalemaker-extension}"

C_GREEN='\033[0;32m'
C_BLUE='\033[0;34m'
C_YELLOW='\033[0;33m'
C_RED='\033[0;31m'
C_BOLD='\033[1m'
C_RESET='\033[0m'

log()  { echo -e "${C_BLUE}▸${C_RESET} $*"; }
ok()   { echo -e "${C_GREEN}✅${C_RESET} $*"; }
warn() { echo -e "${C_YELLOW}⚠️${C_RESET}  $*"; }
err()  { echo -e "${C_RED}❌${C_RESET} $*" >&2; }

echo -e "${C_BOLD}mcp-chrome-scalemaker installer${C_RESET}"
echo -e "release: ${RELEASE_TAG}"
echo -e "install root: ${INSTALL_ROOT}"
echo ""

# ---------- 1. dependency check ----------
command -v node >/dev/null 2>&1 || { err "node 20+ 필요 — https://nodejs.org 에서 설치 후 재시도"; exit 1; }
command -v npm  >/dev/null 2>&1 || { err "npm 필요 — node 와 함께 설치됨"; exit 1; }
command -v curl >/dev/null 2>&1 || { err "curl 필요"; exit 1; }
command -v unzip >/dev/null 2>&1 || { err "unzip 필요"; exit 1; }

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then
  err "node 20 이상 필요 (현재 v$(node -v))"
  exit 1
fi
ok "node $(node -v) / npm $(npm -v)"

# ---------- 2. install root ----------
mkdir -p "$INSTALL_ROOT"
cd "$INSTALL_ROOT"

# ---------- 3. bridge install ----------
log "bridge 다운로드 + 전역 설치"
BRIDGE_URL="https://github.com/$REPO/releases/download/$RELEASE_TAG/$BRIDGE_TGZ"
curl -fsSL "$BRIDGE_URL" -o "$INSTALL_ROOT/$BRIDGE_TGZ" || {
  err "bridge tgz 다운로드 실패: $BRIDGE_URL"
  exit 1
}
ok "$BRIDGE_TGZ ($(du -h "$INSTALL_ROOT/$BRIDGE_TGZ" | awk '{print $1}'))"

log "npm install -g $BRIDGE_TGZ (postinstall 이 native messaging manifest 자동 등록)"
npm install -g "$INSTALL_ROOT/$BRIDGE_TGZ" 2>&1 | tail -5 || {
  err "bridge npm install 실패"
  exit 1
}
ok "bridge 전역 설치 완료"

# ---------- 4. extension download ----------
log "extension 다운로드"
EXT_URL="https://github.com/$REPO/releases/download/$RELEASE_TAG/$EXT_ZIP"
curl -fsSL "$EXT_URL" -o "$INSTALL_ROOT/$EXT_ZIP" || {
  err "extension zip 다운로드 실패: $EXT_URL"
  exit 1
}
ok "$EXT_ZIP ($(du -h "$INSTALL_ROOT/$EXT_ZIP" | awk '{print $1}'))"

log "extension 압축 해제 → $EXTENSION_DIR"
rm -rf "$EXTENSION_DIR"
mkdir -p "$EXTENSION_DIR"
unzip -q -o "$INSTALL_ROOT/$EXT_ZIP" -d "$EXTENSION_DIR"
ok "extension 파일 $(find "$EXTENSION_DIR" -type f | wc -l | tr -d ' ') 개"

# ---------- 5. cleanup downloads ----------
rm -f "$INSTALL_ROOT/$BRIDGE_TGZ" "$INSTALL_ROOT/$EXT_ZIP"

# ---------- 6. verify bridge + manifest ----------
if command -v mcp-chrome-scalemaker-bridge >/dev/null 2>&1; then
  ok "mcp-chrome-scalemaker-bridge CLI 활성"
else
  warn "PATH 에 mcp-chrome-scalemaker-bridge 없음 — npm global bin 경로 확인 필요"
fi

MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
if [ "$(uname)" = "Linux" ]; then
  MANIFEST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
fi
MANIFEST="$MANIFEST_DIR/com.chromemcpscalemaker.nativehost.json"
if [ -f "$MANIFEST" ]; then
  ok "native messaging manifest 등록됨: $MANIFEST"
else
  warn "manifest 없음 — 수동 등록 필요: mcp-chrome-scalemaker-bridge register --force"
fi

# ---------- 7. chrome://extensions 안내 ----------
echo ""
echo -e "${C_BOLD}===== 설치 완료 — 다음 step =====${C_RESET}"
echo ""
echo -e "${C_BOLD}1) Chrome 확장 로드${C_RESET}"
echo -e "   chrome://extensions 열기 → Developer mode ON → \"Load unpacked\" 클릭"
echo -e "   ${C_GREEN}폴더: $EXTENSION_DIR${C_RESET}"
echo ""
echo -e "${C_BOLD}2) Chrome 재시작${C_RESET} (native messaging 적용 위해)"
echo ""
echo -e "${C_BOLD}3) Claude Code 의 .mcp.json 에 chrome-mcp-stdio 등록${C_RESET}"
cat <<EOF

  "chrome-mcp-stdio": {
    "command": "node",
    "args": [
      "$(npm root -g)/mcp-chrome-scalemaker-bridge/dist/mcp/mcp-server-stdio.js"
    ],
    "env": { "CHROME_PORT": "12320" }
  }

EOF
echo -e "${C_BOLD}4) Claude Code 재시작${C_RESET} → /mcp 명령으로 chrome-mcp-stdio 활성 확인"
echo ""
echo -e "${C_GREEN}Extension ID = aogfhfajjknomcnmlkbjmihjbknlhbbi${C_RESET} (모든 사용자 동일 — manifest.key 박제 효과)"
echo -e "문제 발생 시: extension popup 의 ⚡ 강제 재연결 또는 🔬 진단 리포트 → Self-Test"
