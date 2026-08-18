#!/usr/bin/env bash
# auto-chrome-mcp Chrome MCP — one-shot verification: build both artifacts + run all tests + doctor.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
FAIL=0

echo "==================== BUILD ===================="
pnpm run build:shared  >/tmp/sm_shared.log  2>&1 && echo "[OK] build:shared"    || { echo "[FAIL] build:shared";    FAIL=1; tail -20 /tmp/sm_shared.log; }
pnpm run build:native  >/tmp/sm_native.log  2>&1 && echo "[OK] build:native"    || { echo "[FAIL] build:native";    FAIL=1; tail -20 /tmp/sm_native.log; }
pnpm run build:extension >/tmp/sm_ext.log   2>&1 && echo "[OK] build:extension" || { echo "[FAIL] build:extension"; FAIL=1; tail -20 /tmp/sm_ext.log; }

echo "==================== TESTS ===================="
( cd app/native-server && pnpm test ) >/tmp/sm_ntest.log 2>&1
if grep -q "Tests:.*failed" /tmp/sm_ntest.log || ! grep -q "passed" /tmp/sm_ntest.log; then
  echo "[FAIL] native-server tests"; FAIL=1; grep -E "Tests:|Suites:|✕|FAIL" /tmp/sm_ntest.log | head
else
  echo "[OK] native-server tests: $(grep -oE 'Tests:[^,]*' /tmp/sm_ntest.log | head -1)"
fi

( cd app/chrome-extension && pnpm test ) >/tmp/sm_etest.log 2>&1
if grep -qE "Test Files.*failed" /tmp/sm_etest.log; then
  echo "[FAIL] extension tests"; FAIL=1; grep -E "Test Files|Tests |FAIL " /tmp/sm_etest.log | tail
else
  echo "[OK] extension tests: $(grep -E 'Tests ' /tmp/sm_etest.log | tail -1 | tr -s ' ')"
fi

echo "==================== DOCTOR ===================="
DOC=$(node app/native-server/dist/cli.js doctor 2>&1 | sed 's/\x1b\[[0-9;]*m//g')
echo "$DOC" | grep -E "\[OK\]|\[ERROR\]|\[WARN\]" | grep -vE "Chrome manifest|Connectivity" | sed 's/^/  /'
echo "  (manifest/connectivity ERROR/WARN expected until registered+running)"

echo "==================== RESULT ===================="
if [ "$FAIL" -eq 0 ]; then echo "✅ ALL GREEN"; else echo "❌ FAILURES ABOVE"; fi
exit $FAIL
