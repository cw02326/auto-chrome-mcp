#!/usr/bin/env node
import serverInstance from './server';
import nativeMessagingHostInstance from './native-messaging-host';
import { PlaywrightFallbackServer } from './transports/playwright';

// v1.0.19: bridge dynamic port.
// 이전 v1.0.5~18 은 spawn 즉시 hardcoded NATIVE_SERVER_PORT(12320) 으로 listen 했음.
// 그래서 사용자가 popup 에서 다른 port (예: 12310) 입력해도 무시되고 12320 에서만
// listen 됐음 → multi-browser / multi-profile 시나리오에서 같은 port race 만 발생.
//
// 새 동작:
//   1. nativeMessagingHostInstance.start() — stdin 으로 NM protocol 시작
//   2. Chrome 이 extension 의 connectNative 직후 START(port=<user-input>) 메시지 전송
//   3. native-messaging-host.ts 의 startServer(port) 가 그 port 로 listen 시작
//   4. EADDRINUSE 면 server.start 의 catch 에서 self-exit
//
// → 다른 port 끼리는 자연스럽게 isolated. 같은 port 의 takeover 는 별도 작업(B).
//
// fallback watchdog: START 메시지가 5초 안에 안 오면 self-exit.
// 정상 시나리오에선 connectNative 직후 즉시 와야 함 (background/native-host.ts:482).

try {
  serverInstance.setNativeHost(nativeMessagingHostInstance);
  nativeMessagingHostInstance.setServer(serverInstance);
  nativeMessagingHostInstance.start();
} catch {
  process.exit(1);
}

const startWatchdogMs = 5000;
setTimeout(() => {
  if (!serverInstance.isRunning) {
    console.error(
      `[bridge] no START message within ${startWatchdogMs}ms — self-exit (extension never sent port)`,
    );
    process.exit(0);
  }
}, startWatchdogMs).unref();

// Playwright CDP fallback (옵트인)
let playwrightFallback: PlaywrightFallbackServer | null = null;
if (process.env.MCP_PLAYWRIGHT_FALLBACK === '1') {
  playwrightFallback = new PlaywrightFallbackServer();
  playwrightFallback.start().catch((e) => {
    console.error('[playwright-fallback] start failed:', e?.message || e);
  });
}

process.on('error', () => {
  process.exit(1);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGPIPE', () => process.exit(0));
process.on('SIGHUP', () => process.exit(0));

process.on('uncaughtException', () => {
  process.exit(1);
});

process.on('unhandledRejection', () => {
  // ignore
});
