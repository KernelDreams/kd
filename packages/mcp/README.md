# @kerneldreams/mcp

An agent's hands on a machine: **one agent per machine** — an installed host agent (`@kerneldreams/host-agent`, the file panel) plus the `@kerneldreams/tools` agent tools (read, ls, find, grep, write, edit, apply_patch, exec, process; `runz` / `runz_list` when `runz` is found), served over MCP Streamable HTTP. It ships as a single bun binary, so Node is not needed on the machine.

```
npm i -g @kerneldreams/mcp
```

## Minimal example

```
nr-mcp init --name=my-machine --roots=$HOME/work   # writes the config with a fresh token (mode 600)
nr-mcp serve                                       # listens on 127.0.0.1:7890
```

```
curl http://127.0.0.1:7890/health                  # {ok, host, platform, arch, version, tools[]} — no token needed
curl -X POST http://127.0.0.1:7890/mcp \
  -H "Authorization: Bearer $(nr-mcp token)" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Library entry (`import ... from '@kerneldreams/mcp'`): `parseConfig`, `startServer`, `createMachineTools`,
`createRootsGuard`, `handleRpc`, `attachHubTools`, `createWatchThread`.

## Routes

| route | what |
|---|---|
| `GET /health` | `{ok, host, platform, arch, version, tools[]}` — no token |
| `POST /mcp` | MCP (JSON-RPC, reply is `application/json`); `Mcp-Session-Id` is the key of `exec` processes; `DELETE` kills the session's processes |
| `GET /agent` | the host agent for a controlling service: SSE, the first event is `hello` + `session`, then watch `update`s |
| `POST /agent/<session>` | an agent request `{id, op, args}` → `{id, ok, result \| error, code}` |
| `POST /c/<secret>/mcp` | the same MCP for connectors that cannot send headers (such as a claude.ai connector): the secret is the config's `$connector`; without it there is no route, a wrong secret is a 404 |

The token is accepted only as `Authorization: Bearer` and is never read from the query; the connector path secret is
not written to the log (`/c/***`). A tool error is returned as `isError` and the process does not crash. Watching runs
in a separate thread.

## Config `~/.config/nr-mcp/config.md`

```
$name: mini                    machine name (visible to the model and to the controlling service)
$token: …                      bearer
$connector: …                  path secret of /c/<secret>/mcp (>= 32 chars); absent — no connector entry
$roots: [~/work, ~/projects]   roots: anything outside is refused (for the panel agent and for tools); default — home
$policy: auto                  no approvals
$deny: []                      masks of exec commands (`*` is any substring); default empty
$port: 7890
$listen: 127.0.0.1             use 0.0.0.0 when the machine sits behind another machine's tunnel
$hub: http://127.0.0.1:7800/api   an upstream service hub: its services' tools become the machine's tools
$hub_services: [archive]       which hub services (default archive); $hub_key — the hub's bearer, if it needs one
$stdio_<name>: /path/to/node /path/to/server.mjs   a child MCP over stdio: its tools become the machine's tools
```

**Child MCP servers (`$stdio_<name>`).** `nr-mcp` starts the server itself and exposes its tools in `/mcp` (a name
that is already taken is skipped; a crashed child is restarted by the next call). On macOS the child takes its
permissions (Accessibility, Screen Recording) from `nr-mcp`: grant them once in System Settings for `nr-mcp`, and
every client of the machine gets them. `runz host install --only=mcp` preserves `$stdio_*` and `$hub*` lines.

**Signing on darwin.** `build-bin.mjs` signs the binary with a persistent self-signed certificate from a keychain on the
build machine (see the script for the expected names): macOS permissions are tied to the certificate and survive
updates. Without the keychain the binary keeps bun's signature, and the permissions are lost on every update.

## CLI

```
nr-mcp [serve] [--log=<file>]   serve; --log appends server lines to a file (Windows: the binary has no console)
nr-mcp init [--name=…] [--roots=a,b] [--port=…] [--listen=…]   write the config with a fresh token (mode 600)
nr-mcp token                    print the token to stdout
nr-mcp connector                print the connector path secret to stdout (exit code 1 if absent)
nr-mcp version
```

`NR_MCP_CONFIG` points at another config path.

## Build and install

```
npm install && npm run build      # dist (node dist/cli.js)
npm run build:bin                 # bin/nr-mcp-darwin-arm64, bin/nr-mcp-linux-x64 (bun --compile)
node scripts/build-bin.mjs win32-x64   # bin/nr-mcp-win32-x64.exe, no console window (--windows-hide-console)
```

`runz host install --only=mcp` installs it according to the `## $hosts` section of the host manifest (`$mcp`): the
local machine — a LaunchAgent / `systemd --user`; a remote one over ssh — linux: `systemd --user` + linger, darwin:
a LaunchAgent, win32: scp of the `.exe` plus a PowerShell script (a scheduled task `nr-mcp` at user logon, restarted
on failure, log `~/.local/state/nr-mcp.log`). On Windows the admin ssh reads keys from
`C:\ProgramData\ssh\administrators_authorized_keys`; the controlling host's key goes there once, from an
administrator PowerShell. Roots must be live drives only: `realpath` on a disconnected network drive hangs startup.

**claude.ai connector.** Put the machine's domain behind your access gateway (service token) and expose the `/c/`
path as a separate bypass application; keep the connector addresses in `~/.config/nr-mcp/hosts.md` of the controlling
host (`$connector`). The controlling service talks to the agent with `createRemoteHost({url, token})`
(`@kerneldreams/backend-http`), or over ssh.

## License

MIT
