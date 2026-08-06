# chrome-mcp-scalemaker-shared

Internal shared types, constants, and message contracts used by the [mcp-chrome-scalemaker](https://github.com/scalemaker-ship-it/mcp-chrome-scalemaker) Chrome extension and the [`mcp-chrome-scalemaker-bridge`](https://www.npmjs.com/package/mcp-chrome-scalemaker-bridge) Node.js Native Messaging host.

**Not intended for direct end-user consumption.** Public APIs are not guaranteed stable across minor versions — pin a specific version if you depend on it.

## Install

```bash
npm install chrome-mcp-scalemaker-shared
```

## Usage

```ts
import { TOOL_NAMES, NativeMessageType } from 'chrome-mcp-scalemaker-shared';
```

Subpath exports: `constants`, `types`, `tools`, `rr-graph`, `step-types`, `labels`, `node-spec`, `node-spec-registry`, `node-specs-builtin`, `agent-types`.

## Links

- Source & issues: <https://github.com/scalemaker-ship-it/mcp-chrome-scalemaker>
- Bridge package: <https://www.npmjs.com/package/mcp-chrome-scalemaker-bridge>

## License

MIT
