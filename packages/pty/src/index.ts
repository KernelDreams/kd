/**
 * nr-pty — общий терминал человека и агента (спека `nr-far.dev/specs/nr-pty-spec.md`).
 *
 * ```ts
 * const pty = await createPtyHost({ socket: 'nr-pty-lab' })
 * server.on('upgrade', (req, socket, head) => pty.upgrade(req, socket, head, id, query))
 * await pty.run({ command: 'ls', mode: 'execute' })   // { status: 'done', code: 0, output }
 * ```
 */

export { createPtyHost, PtyError, validId, type EnsureOptions, type PtyHost, type PtyHostOptions } from './host.js'
export { cook, Osc133Parser, tail, type MarkKind, type StreamEvent } from './osc.js'
export { findTmux } from './tmux.js'
export type { ReadInput, ReadResult, RunInput, RunMode, RunResult, TerminalInfo, TerminalState } from './types.js'
export { acceptWebSocket, rejectUpgrade, type WsConnection } from './ws.js'
