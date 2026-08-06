#!/usr/bin/env bash
# scalemaker-chrome.command — macOS .command 더블클릭 진입점.
# .sh 와 동일 로직 — Finder 에서 더블클릭하면 Terminal 이 열리고 실행.
exec "$(dirname "$0")/scalemaker-chrome.sh" "$@"
