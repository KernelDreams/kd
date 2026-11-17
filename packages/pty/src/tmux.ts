/**
 * tmux терминалов nr (спека §2): свой сервер на сокете `-L <socket>` со своим конфигом —
 * пользовательский `~/.tmux.conf` и его сессии не смешиваются с нашими.
 * PATH сервиса launchd без brew — путь к tmux ищется сам (как `node_path()` exz).
 */

import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

const PREFIXES = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/run/current-system/sw/bin']

/** Путь к tmux: явный → `NR_PTY_TMUX` → PATH → типовые префиксы. Нет — `null`. */
export function findTmux(explicit?: string): string | null {
  const candidates = [explicit, process.env.NR_PTY_TMUX]
  for (const c of candidates) if (c && executable(c)) return c
  for (const dir of [...(process.env.PATH ?? '').split(delimiter), ...PREFIXES]) {
    if (!dir) continue
    const p = join(dir, 'tmux')
    if (executable(p)) return p
  }
  return null
}

function executable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export class TmuxError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message)
    this.name = 'TmuxError'
  }
}

export interface Tmux {
  readonly bin: string
  readonly socket: string
  readonly conf: string
  /** Аргументы до команды: сокет и конфиг — для attach из node-pty. */
  readonly baseArgs: string[]
  run(args: string[]): Promise<string>
}

export function createTmux(bin: string, socket: string, conf: string, env: NodeJS.ProcessEnv): Tmux {
  const baseArgs = ['-L', socket, '-f', conf]
  return {
    bin,
    socket,
    conf,
    baseArgs,
    run(args) {
      return new Promise((resolve, reject) => {
        execFile(bin, [...baseArgs, ...args], { env, maxBuffer: 16 * 1024 * 1024, timeout: 10_000 }, (err, stdout, stderr) => {
          if (err) reject(new TmuxError(`tmux ${args[0]}: ${String(stderr || err.message).trim()}`, String(stderr)))
          else resolve(String(stdout))
        })
      })
    },
  }
}

/** Нет сервера или сессии — не авария, а «нет». */
export function isMissing(err: unknown): boolean {
  const s = err instanceof TmuxError ? err.stderr : String(err)
  return /no server running|can't find session|session not found|no sessions|error connecting to|No such file or directory/i.test(s)
}

/** Одинарные кавычки для команды `pipe-pane` (её выполняет `sh -c`). */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
