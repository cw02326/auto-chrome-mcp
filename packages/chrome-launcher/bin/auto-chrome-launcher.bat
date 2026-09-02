@echo off
REM auto-chrome-launcher.bat — Windows 더블클릭 진입점.
REM Chrome 을 CDP 활성화로 띄운다. 사용자 default profile 그대로 사용.

setlocal

set "SCRIPT_DIR=%~dp0"
set "PKG_DIR=%SCRIPT_DIR%.."

where node >nul 2>nul
if errorlevel 1 (
  echo Error: node not found in PATH. Install Node.js 20+ first. 1>&2
  exit /b 1
)

set "CLI_PATH=%PKG_DIR%\dist\cli.js"
if not exist "%CLI_PATH%" (
  echo Error: CLI not built. Run: pnpm --filter auto-chrome-mcp-launcher build 1>&2
  exit /b 1
)

node "%CLI_PATH%" %*
endlocal
