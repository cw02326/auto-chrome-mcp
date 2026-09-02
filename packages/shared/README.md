# auto-chrome-mcp-shared

Internal shared types, constants, and message contracts used by the [auto-chrome-mcp](https://github.com/cw02326/auto-chrome-mcp) Chrome extension and the [`auto-chrome-mcp-bridge`](https://www.npmjs.com/package/auto-chrome-mcp-bridge) Node.js Native Messaging host.

**Not intended for direct end-user consumption.** Public APIs are not guaranteed stable across minor versions — pin a specific version if you depend on it.

## Install

```bash
npm install auto-chrome-mcp-shared
```

## Usage

```ts
import { TOOL_NAMES, NativeMessageType } from 'auto-chrome-mcp-shared';
```

Subpath exports: `constants`, `types`, `tools`, `rr-graph`, `step-types`, `labels`, `node-spec`, `node-spec-registry`, `node-specs-builtin`, `agent-types`.

## Links

- Source & issues: <https://github.com/cw02326/auto-chrome-mcp>
- Bridge package: <https://www.npmjs.com/package/auto-chrome-mcp-bridge>

## License

MIT
