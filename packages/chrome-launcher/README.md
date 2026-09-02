# auto-chrome-mcp-launcher

> Chrome launcher with `--remote-debugging-port=9222` for [auto-chrome-mcp](https://github.com/cw02326/auto-chrome-mcp) Playwright CDP fallback.

## What it does

1. **Detects Chrome binary** — macOS / Windows / Linux 자동 분기 (Google Chrome stable / beta / dev / canary / Chromium)
2. **Detects user-data-dir** — default profile 자동 감지 → 로그인·북마크·확장 그대로
3. **Auto-escalates CDP port** — 9222 점유 시 9223 → 9224 ... 자동 시도
4. **Spawns Chrome** with `--remote-debugging-port` + `--restore-last-session`
5. **Writes port file** to `~/.auto-chrome-mcp/cdp-port` (bridge 가 fallback transport 진입 시 읽음)

## Why a separate launcher?

`chromium.connectOverCDP('http://localhost:9222')` 는 Chrome 이 처음 띄울 때부터 `--remote-debugging-port=9222` 플래그를 받아야 동작. 이미 떠 있는 일반 Chrome 에 사후 활성화는 (보안상) 불가능. 그래서 fork 가 별도 launcher 를 제공해서 1회 진입장벽을 극복.

## Install

런처는 npm 에 따로 올리지 않는다. 저장소를 받아 빌드한 뒤 아래 bin 래퍼를 실행한다.

```bash
corepack pnpm --filter auto-chrome-mcp-launcher build
```

또는 GitHub Releases 의 `chrome-launcher-v<version>.tar.gz` 를 받아 푼다.

## Usage

```bash
# macOS / Linux — 더블클릭 가능 (Finder)
./bin/auto-chrome-launcher.command    # macOS
./bin/auto-chrome-launcher.sh         # Linux

# Windows — 더블클릭
bin\auto-chrome-launcher.bat

# CLI 직접
auto-chrome-launcher --port=9222 --verbose
auto-chrome-launcher --start-url=https://example.com
auto-chrome-launcher --binary=/path/to/chrome --user-data-dir=/path
```

## Output (JSON)

```json
{
  "ok": true,
  "binary": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "userDataDir": "/Users/me/Library/Application Support/Google/Chrome",
  "cdpPort": 9222,
  "reused": false,
  "cdpUrl": "http://127.0.0.1:9222",
  "pid": 12345
}
```

## How fork's Playwright transport consumes this

1. user runs `auto-chrome-launcher` once → CDP port written to `~/.auto-chrome-mcp/cdp-port`
2. bridge process 의 Playwright fallback transport 가 그 파일 읽고 `chromium.connectOverCDP(...)` 호출
3. 같은 Chrome 인스턴스에 attach — 사용자 세션 그대로 사용

## OS coverage

| OS      | Binary candidates                                                                         | user-data-dir                                 |
| ------- | ----------------------------------------------------------------------------------------- | --------------------------------------------- |
| macOS   | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` + beta/dev/canary/Chromium | `~/Library/Application Support/Google/Chrome` |
| Windows | `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe` (+ Program Files variants)          | `%LOCALAPPDATA%\Google\Chrome\User Data`      |
| Linux   | `/usr/bin/google-chrome` / `chromium` / `/snap/bin/chromium`                              | `~/.config/google-chrome`                     |

PATH lookup fallback included for arbitrary `google-chrome` / `chromium` symlinks.
