# @kerneldreams/pty

A terminal shared by a human and an agent: the human sees what the agent types and can interrupt with Ctrl+C; the
agent sees what the human ran and how it ended. The human types passwords themselves — they never reach the agent's
stream.

```sh
npm i @kerneldreams/pty
```

```ts
import { createPtyHost } from '@kerneldreams/pty'

const pty = await createPtyHost({ socket: 'nr-pty-lab' })
await pty.ensure('t1', { cwd: '/tmp' })
await pty.run({ terminal: 't1', command: 'ls', mode: 'execute' })   // { status: 'done', code: 0, output }
await pty.run({ command: 'rm x', mode: 'insert' })                  // typed into the line; Enter is for the human
await pty.read({ lines: 50 })                                       // screen snapshot
server.on('upgrade', (req, socket, head) => pty.upgrade(req, socket, head, 't1', query))
```

- **A session is a tmux session** `nr-<id>` on its own socket (`-L`, with its own `shell/tmux.conf`): closing a tab
  leaves the session alive.
- **Screen** — node-pty running `tmux attach`, bytes go to xterm as is (WebSocket, `upgrade`).
- **Agent stream** — `tmux pipe-pane -O` into a file (OSC 133 marks do not arrive through attach, because tmux
  redraws the screen).
- **Command markup — OSC 133** (`A` / `B` / `C` / `D;code`): hooks in `shell/osc133.zsh|bash`, wired in through a
  `ZDOTDIR` wrapper (your own `.zshrc` and friends load as usual).
- **Server restart**: sessions are found again by prefix, and state is recovered from the stream tail and
  `pane_current_command`.

`run` waits for an empty prompt (if the human is typing or a command is running, it waits `wait` seconds and answers
`busy`), enters the command (`send-keys -l`), and for `execute` presses Enter and returns the output between `C` and
`D` (escape-free, tail) plus the exit code from `D`. For `insert`, the answer comes after the human pressed Enter and
the command finished (`pending` on timeout).

## Tab protocol (WebSocket, text messages)

| from | message | description |
|---|---|---|
| client | `i<bytes>` | keyboard input |
| client | `r{"cols":N,"rows":M}` | size |
| server | `o<bytes>` | screen (the `tmux attach` stream) |
| server | `s{"state":…,"lastCode":N}` | state: `prompt` / `input` / `running` / `unknown` |
| server | `x{"reason":…}` | the shell exited |

Requires `tmux` 3.0 or newer (looked up through the `tmux` option, `NR_PTY_TMUX`, PATH, `/opt/homebrew/bin`,
`/usr/local/bin`).
