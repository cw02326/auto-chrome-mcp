# mcp-chrome-scalemaker-bridge

Node.js Native Messaging host that connects [Claude Code](https://claude.com/claude-code) (or any MCP client) to your live Chrome browser via the [auto-chrome-mcp](https://github.com/cw02326/auto-chrome-mcp) extension.

This is the **auto-chrome-mcp fork** of `mcp-chrome-bridge`, adding Force Reconnect, a Playwright CDP fallback launcher, dynamic-port negotiation, and self-healing diagnostics.

## Install

```bash
npm install -g mcp-chrome-scalemaker-bridge
```

The postinstall step will:

1. Register the Chrome Native Messaging host (user-level, no sudo).
2. Download the matching Chrome extension to `~/Downloads/mcp-chrome-scalemaker-extension-v<version>/`.
3. Print the next-step instructions for loading the extension and wiring `chrome-mcp-stdio` into your `.mcp.json`.

## Wire into Claude Code

Paste this into Claude Code once after install:

> Register `chrome-mcp-stdio` in `.mcp.json` with `command: "node"`, `args: ["<npm root -g>/mcp-chrome-scalemaker-bridge/dist/mcp/mcp-server-stdio.js"]`, `env: { "CHROME_PORT": "12320" }`. Run `npm root -g` first to resolve the path. Preserve any existing servers.

Then run `/mcp` in Claude Code to confirm `chrome-mcp-stdio` is connected.

## Load the Chrome extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select `~/Downloads/mcp-chrome-scalemaker-extension-v<version>/`

The extension ID is fixed at `aogfhfajjknomcnmlkbjmihjbknlhbbi` via a pinned `manifest.key`, so every install gets the same ID.

## Diagnostics

```bash
mcp-chrome-scalemaker-bridge doctor        # health check
mcp-chrome-scalemaker-bridge doctor --fix  # attempt auto-repair
mcp-chrome-scalemaker-bridge report --copy # copy a diagnostic report to clipboard
```

## Supported platforms

| OS      | Chrome | Chromium |
| ------- | ------ | -------- |
| macOS   | ✓      | ✓        |
| Linux   | ✓      | ✓        |
| Windows | ✓      | ✓        |

## Links

- Source & issues: <https://github.com/cw02326/auto-chrome-mcp>
- Releases: <https://github.com/cw02326/auto-chrome-mcp/releases>
- Upstream: <https://github.com/hangwin/mcp-chrome>

## License

MIT
