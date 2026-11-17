# @kerneldreams/tools

Agent tools as a single set of `ToolDef`s shared by every consumer: a chat backend, an agent running over ACP, an MCP
server, any future agent. A tool is fixed in one place.

```sh
npm i @kerneldreams/tools
```

## What is inside

| import | description |
|---|---|
| `@kerneldreams/tools` | `ToolDef` / `ToolResult` / `ToolContext` …; files — `createFsTools` (`read`, `ls`, `find`, `grep`, `write`, `edit`, `apply_patch`), path boundaries (`FsRoot`, `scope: 'cwd' \| 'any'`, `readRoots`), truncation; processes — `createExecTools` (`exec`, `process`) and the `ProcessRegistry` / `ExecHost` contract. Node-free: disk access goes through `Fs` (`@kerneldreams/chat-store/fs`), processes through a registry |
| `@kerneldreams/tools/node` | `createProcessRegistry` (`sh -c` in its own process group, output with a cursor, askpass), `which` / `runLines` (`rg` / `fd` from PATH), `createNodeExecHost`; `createRunzTools` — `runz` and `runz_list` (full output, stdout/stderr kept apart, tail truncation) |

Dependencies are only `@kerneldreams/chat-store` (the `Fs` interface) and `diff`: no LLM SDK, no template engine, no
protocol. A test (`test/boundary.test.ts`) enforces this, and also that `node:` imports live only in `src/node/`.

## Example

```js
import { fsOf } from '@kerneldreams/chat-store/fs'
import { createNodeFileSystem } from '@kerneldreams/chat-store/node-fs'
import { createExecTools, createFsTools } from '@kerneldreams/tools'
import { createNodeExecHost, createRunzTools } from '@kerneldreams/tools/node'

const cwd = process.cwd()
const host = createNodeExecHost()
const fs = fsOf(createNodeFileSystem())
const tools = [
  ...createFsTools({ cwd, fs, search: host }),
  ...createExecTools({ cwd, fs, processes: host.processes }),
  ...createRunzTools({ cwd }),
]
const ctx = { signal: AbortSignal.timeout(60_000), sessionId: 's', callId: 'c1', ask: async () => undefined, cwd }
const res = await tools.find((t) => t.name === 'exec').execute({ command: 'echo ok' }, ctx)
```

The full version is in `examples/basic.mjs` (`node examples/basic.mjs [dir]`: `read`, `exec echo ok`, `runz_list`).

`ToolContext.cwd` is the calling directory, when the host knows it (for an ACP host, the session's cwd): `runz` reads
it, while `fs` / `exec` work from their own `FsRoot.cwd`. The `runz` tools use the binary named by `PI_EXT_RUNZ_BIN`,
or `runz` from PATH.

## Development

```
npm install && npm run build
npx vitest run
```
