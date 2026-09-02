import { createServer } from 'node:net';

/**
 * 9222 점유 검사 + 점유 시 9223 → 9224 → ... 자동 escalation.
 *
 * 검사 방법: net.createServer().listen(port, host) 가 EADDRINUSE 인지.
 * Playwright 의 connectOverCDP 는 CDP endpoint 가 listen 인지 확인 못함 — 우리가
 * 직접 listen 시도 후 즉시 close.
 */
export const ensurePortFree = async (
  startPort: number = 9222,
  host: string = '127.0.0.1',
  maxAttempts: number = 10,
): Promise<number> => {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    const isFree = await isPortFree(port, host);
    if (isFree) return port;
  }
  throw new Error(
    `No free port found in range ${startPort}-${startPort + maxAttempts - 1} on ${host}`,
  );
};

export const isPortFree = (port: number, host: string = '127.0.0.1'): Promise<boolean> =>
  new Promise((resolve) => {
    const tester = createServer()
      .once('error', () => resolve(false))
      .once('listening', () => {
        tester.close(() => resolve(true));
      })
      .listen(port, host);
  });

/**
 * Check if a port is already serving a Chrome CDP endpoint by hitting /json/version.
 * Returns true if a CDP-style response is detected.
 */
export const isChromeCdpEndpoint = async (
  port: number,
  host: string = '127.0.0.1',
): Promise<boolean> => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`http://${host}:${port}/json/version`, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) return false;
    const payload = (await res.json()) as { Browser?: string };
    return typeof payload?.Browser === 'string' && payload.Browser.includes('Chrome');
  } catch {
    return false;
  }
};
