# mcp-chrome-scalemaker-launcher

> Chrome launcher with `--remote-debugging-port=9222` for [auto-chrome-mcp](https://github.com/cw02326/auto-chrome-mcp) Playwright CDP fallback.

## What it does

1. **Detects Chrome binary** — macOS / Windows / Linux 자동 분기 (Google Chrome stable / beta / dev / canary / Chromium)
2. **Detects user-data-dir** — default profile 자동 감지 → 로그인·북마크·확장 그대로
3. **Auto-escalates CDP port** — 9222 점유 시 9223 → 9224 ... 자동 시도
4. **Spawns Chrome** with `--remote-debugging-port` + `--restore-last-session`
5. **Writes port file** to `~/.mcp-chrome-scalemaker/cdp-port` (bridge 가 fallback transport 진입 시 읽음)

## Why a separate launcher?

`chromium.connectOverCDP('http://localhost:9222')` 는 Chrome 이 처음 띄울 때부터 `--remote-debugging-port=9222` 플래그를 받아야 동작. 이미 떠 있는 일반 Chrome 에 사후 활성화는 (보안상) 불가능. 그래서 fork 가 별도 launcher 를 제공해서 1회 진입장벽을 극복.

## Install

```bash
npm i -g mcp-chrome-scalemaker-bridge   # bridge 가 launcher 도 의존성으로 가져옴
```

또는 GitHub Releases 에서 OS 별 단일 셸 다운로드.

## Usage

```bash
# macOS / Linux — 더블클릭 가능 (Finder)
./bin/scalemaker-chrome.command    # macOS
./bin/scalemaker-chrome.sh         # Linux

# Windows — 더블클릭
bin\scalemaker-chrome.bat

# CLI 직접
scalemaker-chrome --port=9222 --verbose
scalemaker-chrome --start-url=https://example.com
scalemaker-chrome --binary=/path/to/chrome --user-data-dir=/path
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

1. user runs `scalemaker-chrome` once → CDP port written to `~/.mcp-chrome-scalemaker/cdp-port`
2. bridge process 의 Playwright fallback transport 가 그 파일 읽고 `chromium.connectOverCDP(...)` 호출
3. 같은 Chrome 인스턴스에 attach — 사용자 세션 그대로 사용

## OS coverage

| OS      | Binary candidates                                                                         | user-data-dir                                 |
| ------- | ----------------------------------------------------------------------------------------- | --------------------------------------------- |
| macOS   | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` + beta/dev/canary/Chromium | `~/Library/Application Support/Google/Chrome` |
| Windows | `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe` (+ Program Files variants)          | `%LOCALAPPDATA%\Google\Chrome\User Data`      |
| Linux   | `/usr/bin/google-chrome` / `chromium` / `/snap/bin/chromium`                              | `~/.config/google-chrome`                     |

PATH lookup fallback included for arbitrary `google-chrome` / `chromium` symlinks.
