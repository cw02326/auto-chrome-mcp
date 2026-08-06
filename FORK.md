# mcp-chrome-scalemaker

> Fork of [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome) with reliability fixes + Force Reconnect + Playwright CDP fallback.

## Why this fork?

원본 mcp-chrome 의 5+ 개월 머지 안 된 핵심 PR 들 (#346 singleton transport bug, #312 stale reconnect, #329 Chrome 144+ pagehide 등) 을 흡수하고, 4 신규 컴포넌트를 추가한 reliability-focused fork.

상세 설계 → [`docs/DESIGN.md`](./docs/DESIGN.md)
upstream diff → [`UPSTREAM_DIFF.md`](./UPSTREAM_DIFF.md)

## What's different

### 흡수한 upstream PR (7개)

- **#346** — factory pattern (singleton 제거) — `"已连接, 服务未启动"` 노란불 해결
- **#338** — sequential HTTP clients
- **#312** — stale reconnect EOF handler
- **#302 + #304** — STDIO session/parent cleanup
- **#329** — Chrome 144+ pagehide
- **#313** — `CHROME_MCP_HOST` env

### 신규 (fork 전용)

- **Force Reconnect 슈퍼 버튼** — A→B→C 점진 escalation (kill→port→spawn→handshake→ping)
- **Chrome Launcher** — `--remote-debugging-port=9222` 자동 + 사용자 default profile 그대로
- **Playwright CDP 폴백** — native 실패 시 같은 Chrome 에 attach (세션 공유, 33 도구 미러)
- **Diagnostic Report UI** — 4 stage indicator + Self-Test + Copy as JSON

## Install

```bash
# 1. bridge (npm)
npm i -g mcp-chrome-scalemaker-bridge

# 2. extension (Chrome Web Store 사용 안 함 — Releases 의 .zip 사이드로드)
# https://github.com/scalemaker-ship-it/mcp-chrome-scalemaker/releases 에서 latest .zip 다운로드
# chrome://extensions → Developer mode ON → Load unpacked → 폴더 선택

# 3. Chrome Launcher (Playwright 폴백 사용할 때만)
# Releases 에서 OS 별 launcher 다운로드 → 더블클릭
```

## Compatibility with upstream

이 fork 의 npm 패키지명·extension ID 는 upstream 과 다르므로, **원본 mcp-chrome 과 병존 가능**. 같은 Chrome 에서 두 확장을 동시에 활성화하면 12306 포트 충돌이 나니, 하나만 활성화하길 권장.

## Upstream sync

매주 자동으로 upstream master 와 diff 검사 (`upstream-check.yml`). 우리가 cherry-pick 한 PR 이 upstream 에 머지되면 retire issue 자동 생성. 월 1회 정기 sync.

## License

원본과 동일 (MIT 추정 — LICENSE 파일 참조).
