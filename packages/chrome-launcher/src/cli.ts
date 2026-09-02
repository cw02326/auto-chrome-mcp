#!/usr/bin/env node
/**
 * CLI entrypoint — `auto-chrome-launcher` 명령.
 *
 * 사용:
 *   auto-chrome-launcher                    # default 9222, auto-detect 모든 것
 *   auto-chrome-launcher --port=9222
 *   auto-chrome-launcher --start-url=https://example.com
 *   auto-chrome-launcher --binary=/path/to/chrome  --user-data-dir=/path
 *   auto-chrome-launcher --verbose
 */
import { launchChrome } from './launch.js';

const parseArgs = (argv: string[]) => {
  const out: { [k: string]: string | boolean } = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        out[a.slice(2)] = true;
      }
    }
  }
  return out;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const verbose = Boolean(args.verbose);

  if (args.help || args.h) {
    console.log(`auto-chrome-launcher — Chrome launcher with CDP enabled

Options:
  --port=N           CDP debugging port (default 9222, auto-escalation to 9223+)
  --user-data-dir=P  Override Chrome user-data-dir (default = auto-detect)
  --binary=P         Override Chrome binary path
  --start-url=URL    First tab URL
  --verbose          Verbose log
  --help, -h         Show this help

Outputs:
  ~/.auto-chrome-mcp/cdp-port  → active CDP port (consumed by bridge)
`);
    process.exit(0);
  }

  try {
    const result = await launchChrome({
      port: typeof args.port === 'string' ? Number(args.port) : undefined,
      userDataDir:
        typeof args['user-data-dir'] === 'string' ? (args['user-data-dir'] as string) : undefined,
      binaryPath: typeof args.binary === 'string' ? (args.binary as string) : undefined,
      startUrl: typeof args['start-url'] === 'string' ? (args['start-url'] as string) : undefined,
      verbose,
    });

    console.log(
      JSON.stringify(
        {
          ok: true,
          binary: result.binary,
          userDataDir: result.userDataDir,
          cdpPort: result.cdpPort,
          reused: result.reused,
          cdpUrl: `http://127.0.0.1:${result.cdpPort}`,
          pid: result.process.pid ?? null,
        },
        null,
        2,
      ),
    );

    // detach: Chrome 이 종료될 때까지 그대로 보유해야 user 가 닫을 때 우리도 종료.
    // 그러나 reused 인 경우 우리가 spawn 안 했으므로 즉시 종료 OK.
    if (result.reused) {
      process.exit(0);
    }
    // Chrome 종료 대기 (사용자가 닫으면 우리도 종료).
    result.process.once('exit', (code) => {
      console.error(`[launcher] Chrome exited with code ${code}`);
      process.exit(code ?? 0);
    });
  } catch (e: any) {
    console.error(JSON.stringify({ ok: false, error: e?.message || String(e) }));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
