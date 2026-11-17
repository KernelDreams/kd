# @kerneldreams/host-agent

A transport for a file panel to a remote host **with no installation**: the hub keeps one
`ssh -T <alias> <node> -e <loader>` process per host and feeds this script as the first line of input (base64).
After that it is JSON lines: `{id, op, args}` → `{id, ok, result | error, code}`, and events
`{event: 'update', watch, paths}`.

```sh
npm i @kerneldreams/host-agent
```

```js
import { spawn } from 'node:child_process'
import { agentLine, bootstrapCode } from '@kerneldreams/host-agent'

const p = spawn('ssh', ['-T', host, 'node', '-e', '"' + bootstrapCode() + '"'])  // quoted for the remote shell
p.stdin.write(agentLine())
```

Operations: `init` (denied paths), `stat`, `list`, `read` (in chunks), `write` (atomic, with a revision), `put` /
`finish` (chunked transfer), `mkdir`, `rename`, `delete` (to `~/.nr-trash` on the host), `copy`, `walk`, `search`,
`watch` / `unwatch`, `disk`, `thumb` (sips / qlmanage / ffmpeg / magick — whichever is present), `exec` (no shell).

Paths on the wire are POSIX; on Windows `C:\Users\x` ↔ `/C:/Users/x`. No dependencies, Node 18 or newer.

The package exports `agentSource()`, `bootstrapCode()`, `agentLine()` and `AGENT_VERSION`; the agent itself is
`@kerneldreams/host-agent/agent.cjs`.

## Embedded agent

The same `agent.cjs` can be embedded in a process: `import { createAgent } from '@kerneldreams/host-agent/embed'`.
One session per connection (`createAgent({ emit, roots, watchDir })`): `call({id, op, args})` returns the reply,
events go to `emit`, `roots` are the machine's roots (anything outside gives `forbidden`, `exec cwd` included), and
`watchDir` supplies your own watching (a thread). Over ssh everything works as before: one session per process, with
stdin/stdout as the wire. A hub can talk to an installed agent over HTTP.
