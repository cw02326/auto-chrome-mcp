# Force Reconnect

> A→B→C 점진 escalation 명세 + 사용 방법.

## 동작

extension popup 의 **⚡ Force Reconnect** 버튼 = 5 step Stage A 자동 실행:

| Step           | 작업                                            | 통과 기준                                  |
| -------------- | ----------------------------------------------- | ------------------------------------------ |
| ① process_kill | `POST /admin/drain`                             | 200 OK 또는 connection refused (이미 죽음) |
| ② port_free    | `GET /health` 가 timeout/refused 까지 backoff   | bridge 죽음 확인                           |
| ③ spawn        | background 에 `force-reconnect-respawn` message | `chrome.runtime.connectNative` 재트리거    |
| ④ handshake    | `/health` 가 200 응답 + 새 `bridge.pid`         | 새 bridge 살아있음                         |
| ⑤ mcp_ping     | `POST /mcp { initialize }`                      | 200 OK + `mcp-session-id` 헤더             |

Stage A 가 ③·④·⑤ 중 실패하면 Stage B/C escalation 안내 (후속).

## 왜 5 step 인가

upstream issue #306 등에서 "已连接, 服务未启动" 상태로 stuck 되는 케이스, 사용자 임시 우회 = `pkill -9 -f mcp-chrome-bridge` 수동 실행. Force Reconnect 는 이를 1 클릭으로 자동화:

- ① drain = pkill 의 graceful 버전 (bridge 자살 후 Chrome 자동 respawn)
- ② port_free = 죽음 확인 (점유 잔존 검출)
- ③ spawn = chrome.runtime.connectNative 재트리거
- ④ handshake = 새 bridge 살아있음 확인 + pid 비교
- ⑤ mcp_ping = MCP layer 까지 회복 확인

`bridge.pid` 가 이전과 다른 값이면 정말 새 process 가 떴다는 증거. 동일하면 chrome 의 respawn 이 안 됐다는 신호 (Stage B 후보).

## Code locations

- `app/native-server/src/server/routes/admin.ts` — `POST /admin/drain` + `GET /health`
- `app/native-server/src/server/index.ts` — `gracefulDrain()` method
- `app/chrome-extension/utils/force-reconnect.ts` — 5 step orchestrator
- `app/chrome-extension/entrypoints/background/native-host.ts` — `force-reconnect-respawn` message handler
- `app/chrome-extension/entrypoints/popup/components/ForceReconnect.vue` — UI

## Manual testing

```bash
# 1. 두 client 동시 연결 (factory pattern 검증):
curl -X POST http://127.0.0.1:12306/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":"a","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"a","version":"1"}}}' \
  -i | grep -i mcp-session-id

# Force Reconnect 직접 (Stage A drain step):
curl -X POST http://127.0.0.1:12306/admin/drain
# → 200 OK + bridge 5s 안에 exit
# → chrome 이 native messaging port 끊김 감지

# Bridge 가 다시 떠 있는지:
sleep 3 && curl -s http://127.0.0.1:12306/health | jq .bridge.pid
```

## Stage B/C (후속 구현)

### Stage B — native messaging host manifest 재등록

Stage A 의 ③ spawn 실패 시. native messaging host manifest 가 손상되었거나 경로 mismatch 인 경우:

- macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.autochromemcp.nativehost.json`
- Windows: `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.autochromemcp.nativehost` (registry)
- Linux: `~/.config/google-chrome/NativeMessagingHosts/com.autochromemcp.nativehost.json`

수동 fix: `auto-chrome-mcp-bridge register` 또는 `auto-chrome-mcp-bridge doctor --fix` 실행 (manifest 재생성).

### Stage C — Chrome restart with launcher

Stage B 도 실패 시. Chrome 자체 재시작:

```bash
# 사용자 confirm 후
osascript -e 'quit app "Google Chrome"'  # macOS
sleep 5
auto-chrome-launcher  # launcher 가 새 Chrome 띄움 (CDP 활성화 + Continue where you left off)
```

Stage C 다이얼로그 UI 는 후속 PR 에서.
