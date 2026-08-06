#!/usr/bin/env bash
# scalemaker-chrome — POSIX shell wrapper (macOS / Linux)
#
# 더블클릭 가능 (Finder/macOS) — Chrome 을 CDP 활성화로 띄움.
# 사용자 default profile 그대로 사용하므로 로그인·북마크·확장 모두 유지.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Node 의존: 명령이 PATH 에 있어야 함.
if ! command -v node >/dev/null 2>&1; then
  echo "❌ node not found in PATH. Install Node.js 20+ first." >&2
  exit 1
fi

# dist 가 빌드되어 있어야 함.
CLI_PATH="$PKG_DIR/dist/cli.js"
if [ ! -f "$CLI_PATH" ]; then
  echo "❌ CLI not built. Run: pnpm --filter mcp-chrome-scalemaker-launcher build" >&2
  exit 1
fi

exec node "$CLI_PATH" "$@"
