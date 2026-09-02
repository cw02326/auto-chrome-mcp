#!/usr/bin/env bash
# Auto Chrome MCP 설치 스크립트 (macOS / Linux)
#
# 사용법: 터미널에 아래 한 줄을 붙여넣고 Enter
#   curl -fsSL https://raw.githubusercontent.com/cw02326/auto-chrome-mcp/main/install.sh | bash
#
# 하는 일 (install.ps1 과 동일한 순서):
#   1. Node.js 20+ 확인
#   2. npm 에서 브리지 전역 설치 → doctor --fix 로 네이티브 메시징 등록까지 자동 점검
#   3. 클로드 코드에 chrome-mcp-stdio 등록 (claude CLI, 없으면 ~/.mcp.json 병합)
#   4. 최신 릴리스에서 확장 zip 내려받아 압축 해제
#
# 테스트용 플래그: --skip-npm / --skip-register / --skip-download

set -euo pipefail

REPO="cw02326/auto-chrome-mcp"
CHROME_PORT="${CHROME_PORT:-12320}"
EXTENSION_DIR="${AUTO_CHROME_MCP_EXTENSION_DIR:-}"

SKIP_NPM=0
SKIP_REGISTER=0
SKIP_DOWNLOAD=0
for arg in "$@"; do
  case "$arg" in
    --skip-npm) SKIP_NPM=1 ;;
    --skip-register) SKIP_REGISTER=1 ;;
    --skip-download) SKIP_DOWNLOAD=1 ;;
    *) echo "알 수 없는 옵션: $arg" >&2; exit 2 ;;
  esac
done

C_GREEN='\033[0;32m'; C_CYAN='\033[0;36m'; C_YELLOW='\033[0;33m'
C_RED='\033[0;31m'; C_BOLD='\033[1m'; C_RESET='\033[0m'
step() { echo -e "\n${C_CYAN}[$1]${C_RESET} $2"; }
ok()   { echo -e "  ${C_GREEN}OK${C_RESET}  $*"; }
warn() { echo -e "  ${C_YELLOW}!!${C_RESET}  $*"; }
err()  { echo -e "  ${C_RED}✗${C_RESET}  $*" >&2; }

echo ""
echo -e "${C_BOLD}=====================================${C_RESET}"
echo -e "${C_BOLD}  Auto Chrome MCP 설치${C_RESET}"
echo -e "${C_BOLD}=====================================${C_RESET}"

# ---------- 1. Node.js 확인 ----------
step 1 "Node.js 확인 중..."
if ! command -v node >/dev/null 2>&1; then
  err "Node.js 가 없습니다."
  echo "     macOS:  brew install node"
  echo "     Linux:  https://nodejs.org 또는 배포판 패키지 관리자"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  err "Node.js 20 이상이 필요합니다 (현재 $(node -v))"
  exit 1
fi
ok "Node.js $(node -v) / npm $(npm -v)"

# ---------- 2. 브리지 설치 ----------
if [ "$SKIP_NPM" -eq 0 ]; then
  step 2 "연결 프로그램(브리지) 설치 중... (1~2분)"
  if ! npm install -g auto-chrome-mcp-bridge >/dev/null 2>&1; then
    err "전역 설치에 실패했습니다."
    echo "     권한 문제라면 npm 전역 경로를 사용자 폴더로 옮기는 것이 안전합니다:"
    echo "       npm config set prefix ~/.npm-global"
    echo "       export PATH=\"\$HOME/.npm-global/bin:\$PATH\"   # 셸 설정 파일에 추가"
    echo "     그 뒤 이 스크립트를 다시 실행하세요. (sudo 는 권장하지 않습니다)"
    exit 1
  fi
  ok "브리지 설치 완료"

  step 3 "연결 상태 자동 점검·수리 중..."
  # doctor 는 네이티브 메시징 매니페스트 등록까지 고쳐 준다. 경고가 있어도 계속 진행한다.
  auto-chrome-mcp-bridge doctor --fix || warn "점검 중 경고가 있었지만 계속 진행합니다."
else
  step 2 "브리지 설치 건너뜀 (테스트 모드)"
fi

# ---------- 3. 클로드 코드에 등록 ----------
if [ "$SKIP_REGISTER" -eq 0 ]; then
  step 4 "클로드 코드에 등록 중..."
  NPM_ROOT="$(npm root -g)"
  STDIO_PATH="$NPM_ROOT/auto-chrome-mcp-bridge/dist/mcp/mcp-server-stdio.js"
  if [ ! -f "$STDIO_PATH" ]; then
    err "브리지 파일을 찾을 수 없습니다: $STDIO_PATH"
    exit 1
  fi

  REGISTERED=0
  if command -v claude >/dev/null 2>&1; then
    claude mcp remove --scope user chrome-mcp-stdio >/dev/null 2>&1 || true
    if claude mcp add --scope user --transport stdio chrome-mcp-stdio \
        -e "CHROME_PORT=$CHROME_PORT" -- node "$STDIO_PATH" >/dev/null 2>&1; then
      ok "클로드 코드 전역 등록 완료 (어느 폴더에서 실행해도 사용 가능)"
      REGISTERED=1
    else
      warn "claude mcp 등록 실패 — 설정 파일 방식으로 대신 등록합니다."
    fi
  fi

  if [ "$REGISTERED" -eq 0 ]; then
    # fallback: 홈 폴더 .mcp.json 병합 (node 로 처리 — jq 의존성을 만들지 않는다)
    MCP_FILE="$HOME/.mcp.json"
    node -e '
      const fs = require("fs");
      const [file, stdioPath, port] = process.argv.slice(1);
      let cfg = {};
      if (fs.existsSync(file)) {
        try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); }
        catch { console.error("기존 .mcp.json 을 읽을 수 없어 새로 만듭니다."); }
      }
      cfg.mcpServers = cfg.mcpServers || {};
      cfg.mcpServers["chrome-mcp-stdio"] = {
        type: "stdio",
        command: "node",
        args: [stdioPath],
        env: { CHROME_PORT: port },
      };
      fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
    ' "$MCP_FILE" "$STDIO_PATH" "$CHROME_PORT"
    ok "설정 파일 등록 완료: $MCP_FILE"
  fi
else
  step 4 "클로드 등록 건너뜀 (테스트 모드)"
fi

# ---------- 4. 크롬 확장 다운로드 ----------
if [ "$SKIP_DOWNLOAD" -eq 0 ]; then
  step 5 "크롬 확장 프로그램 다운로드 중..."
  command -v curl >/dev/null 2>&1 || { err "curl 이 필요합니다"; exit 1; }
  command -v unzip >/dev/null 2>&1 || { err "unzip 이 필요합니다"; exit 1; }

  # 릴리스 에셋 중 *chrome.zip 을 고른다 (버전이 이름에 들어가므로 패턴으로 찾는다).
  ASSET_URL="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | node -e '
      let d = "";
      process.stdin.on("data", (c) => (d += c)).on("end", () => {
        const rel = JSON.parse(d);
        const a = (rel.assets || []).find((x) => x.name.endsWith("chrome.zip"));
        if (!a) { console.error("확장 zip 을 찾을 수 없습니다."); process.exit(1); }
        console.log(a.browser_download_url);
      });')"

  if [ -z "$EXTENSION_DIR" ]; then
    if [ -d "$HOME/Documents" ]; then
      EXTENSION_DIR="$HOME/Documents/AutoChromeMCP-확장프로그램"
    else
      EXTENSION_DIR="$HOME/AutoChromeMCP-확장프로그램"
    fi
  fi

  ZIP_TMP="$(mktemp -t auto-chrome-mcp-ext.XXXXXX).zip"
  curl -fsSL "$ASSET_URL" -o "$ZIP_TMP"
  rm -rf "$EXTENSION_DIR"
  mkdir -p "$EXTENSION_DIR"
  unzip -q -o "$ZIP_TMP" -d "$EXTENSION_DIR"
  rm -f "$ZIP_TMP"
  ok "확장 프로그램 준비 완료: $EXTENSION_DIR"

  # 폴더를 열어 준다 (실패해도 설치에는 지장 없다)
  if command -v open >/dev/null 2>&1; then
    open "$EXTENSION_DIR" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$EXTENSION_DIR" >/dev/null 2>&1 || true
  fi
else
  step 5 "확장 다운로드 건너뜀 (테스트 모드)"
  EXTENSION_DIR="${EXTENSION_DIR:-(건너뜀)}"
fi

# ---------- 안내 ----------
cat <<EOF

$(echo -e "${C_BOLD}=====================================${C_RESET}")
$(echo -e "${C_BOLD}  거의 다 됐어요! 남은 일은 2가지${C_RESET}")
$(echo -e "${C_BOLD}=====================================${C_RESET}")

 1. 크롬에서 chrome://extensions 를 열고:
    - 오른쪽 위 '개발자 모드' 켜기
    - '압축해제된 확장 프로그램을 로드합니다' 클릭
    - 이 폴더 선택: $EXTENSION_DIR

 2. 클로드 코드를 껐다가 다시 켜기

 확인: 클로드 코드에 /mcp 를 입력했을 때 chrome-mcp-stdio 가 보이면 성공!

 문제가 생기면: 확장 팝업의 ⚡ 강제 재연결, 또는 터미널에서
   auto-chrome-mcp-bridge doctor

EOF
