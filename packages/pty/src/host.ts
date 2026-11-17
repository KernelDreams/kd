/**
 * Хост терминалов (спека §1–4): сессии tmux `nr-<id>` на своём сокете, экран для человека — node-pty
 * c `tmux attach` (байты в xterm как есть), поток для агента — `Terminal` над `pipe-pane`.
 * При старте находит свои сессии и восстанавливает их состояние (§2 «Перезапуск сервера»).
 */

import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { createRequire } from 'node:module'
import { homedir, userInfo } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { Terminal } from './terminal.js'
import { createTmux, findTmux, isMissing, type Tmux } from './tmux.js'
import type { ReadInput, ReadResult, RunInput, RunResult, TerminalInfo, TerminalState } from './types.js'
import { acceptWebSocket, rejectUpgrade, type WsConnection } from './ws.js'

export interface PtyHostOptions {
  /** Сокет tmux (`-L`): свой у каждого контура стенда. По умолчанию `nr-pty`. */
  socket?: string
  /** Путь к tmux; нет — `NR_PTY_TMUX`, PATH, типовые префиксы. */
  tmux?: string
  /** Шелл терминала; нет — `$SHELL`, иначе логин-шелл пользователя. */
  shell?: string
  /** Каталог потоков `pipe-pane` (0700). По умолчанию `~/.nr-pty/<socket>`. */
  stateDir?: string
  /** Каталог нового терминала по умолчанию — домашний. */
  home?: string
  log?: (message: string) => void
}

export interface EnsureOptions {
  cwd?: string
  cols?: number
  rows?: number
}

export interface PtyHost {
  readonly socket: string
  list(): Promise<TerminalInfo[]>
  /** Терминал с этим id: есть — он, нет — новая сессия (в `cwd`). */
  ensure(id: string, opts?: EnsureOptions): Promise<TerminalInfo>
  info(id: string): Promise<TerminalInfo | null>
  run(input: RunInput): Promise<RunResult>
  read(input: ReadInput): Promise<ReadResult>
  kill(id: string): Promise<boolean>
  /** WebSocket вкладки: `/pty/<id>/attach?cols=&rows=&cwd=`. Авторизация — на вызывающем. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, id: string, query: URLSearchParams): void
  /** Отпустить потоки и вкладки; сессии tmux живут дальше. */
  close(): Promise<void>
}

export class PtyError extends Error {
  constructor(
    message: string,
    readonly code: 'bad_request' | 'not_found' | 'unavailable',
  ) {
    super(message)
    this.name = 'PtyError'
  }
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/i
const RESERVED = new Set(['run', 'read'])
const PREFIX = 'nr-'

export function validId(id: string): boolean {
  return ID_RE.test(id) && !RESERVED.has(id)
}

/** Каталог `shell/` пакета (хуки OSC 133, обёртка ZDOTDIR, конфиг tmux). */
const SHELL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'shell')

type IPty = import('node-pty').IPty

export async function createPtyHost(opts: PtyHostOptions = {}): Promise<PtyHost> {
  const log = opts.log ?? ((m: string) => void process.stderr.write(`nr-pty: ${m}\n`))
  const bin = findTmux(opts.tmux)
  if (!bin) throw new PtyError('tmux не найден: поставь tmux или задай путь (NR_PTY_TMUX)', 'unavailable')
  const socket = opts.socket ?? 'nr-pty'
  const stateDir = opts.stateDir ?? join(homedir(), '.nr-pty', socket)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const home = opts.home ?? homedir()
  const shell = opts.shell || process.env.SHELL || safeShell()
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.TMUX
  delete env.TMUX_PANE
  const tmux = createTmux(bin, socket, join(SHELL_DIR, 'tmux.conf'), env)
  const pty = await loadNodePty()

  const terms = new Map<string, Terminal>()
  const clients = new Map<string, Set<{ pty: IPty; conn: WsConnection }>>()
  const starting = new Map<string, Promise<Terminal>>()

  const logFile = (id: string) => join(stateDir, `${id}.log`)

  async function sessions(): Promise<Map<string, number>> {
    try {
      const out = await tmux.run(['list-sessions', '-F', '#{session_name}|||#{session_attached}'])
      const m = new Map<string, number>()
      for (const line of out.split('\n')) {
        const [name, att] = line.split('|||')
        if (name?.startsWith(PREFIX)) m.set(name.slice(PREFIX.length), Number(att) || 0)
      }
      return m
    } catch (err) {
      if (isMissing(err)) return new Map()
      throw err
    }
  }

  async function alive(id: string): Promise<boolean> {
    try {
      await tmux.run(['has-session', '-t', `=${PREFIX}${id}`])
      return true
    } catch {
      return false
    }
  }

  function shellArgs(): { env: Record<string, string>; argv: string[] } {
    const name = basename(shell)
    if (name === 'zsh') {
      return {
        env: { ZDOTDIR: join(SHELL_DIR, 'zsh'), NR_PTY_USER_ZDOTDIR: process.env.ZDOTDIR || home },
        argv: [shell, '-l'],
      }
    }
    if (name === 'bash') return { env: { NR_PTY_SHELL_DIR: SHELL_DIR }, argv: [shell, '--init-file', join(SHELL_DIR, 'bashrc'), '-i'] }
    // Другой шелл — без меток: агент видит «занят», пока не появится хук.
    return { env: {}, argv: [shell, '-l'] }
  }

  async function create(id: string, o: EnsureOptions): Promise<Terminal> {
    const cwd = o.cwd && isDir(o.cwd) ? o.cwd : home
    const { env: extra, argv } = shellArgs()
    const envArgs = Object.entries({ ...extra, NR_PTY: id, TERM_PROGRAM: 'nr-pty' }).flatMap(([k, v]) => ['-e', `${k}=${v}`])
    const cols = clamp(o.cols ?? 120, 20, 500)
    const rows = clamp(o.rows ?? 32, 5, 300)
    await tmux.run(['new-session', '-d', '-s', `${PREFIX}${id}`, '-x', String(cols), '-y', String(rows), '-c', cwd, ...envArgs, ...argv])
    const t = new Terminal(id, tmux, logFile(id), log)
    await t.start(true)
    return t
  }

  async function adopt(id: string): Promise<Terminal> {
    const t = new Terminal(id, tmux, logFile(id), log)
    await t.start(false)
    return t
  }

  async function get(id: string, o: EnsureOptions = {}): Promise<Terminal> {
    if (!validId(id)) throw new PtyError(`терминал: плохой id «${id}»`, 'bad_request')
    const have = terms.get(id)
    if (have && have.state !== 'exited' && (await alive(id))) return have
    if (have) drop(id)
    const pending = starting.get(id)
    if (pending) return pending
    const p = ((await alive(id)) ? adopt(id) : create(id, o)).then((t) => {
      terms.set(id, t)
      return t
    })
    starting.set(id, p)
    try {
      return await p
    } finally {
      starting.delete(id)
    }
  }

  function drop(id: string): void {
    terms.get(id)?.stop()
    terms.delete(id)
  }

  /** Явный терминал или последний активный. */
  async function pick(id: string | undefined): Promise<Terminal> {
    if (id) {
      if (!terms.has(id) && !(await alive(id))) throw new PtyError(`терминала «${id}» нет`, 'not_found')
      return get(id)
    }
    let best: Terminal | null = null
    for (const t of terms.values()) if (t.state !== 'exited' && (!best || t.lastActive > best.lastActive)) best = t
    if (!best) throw new PtyError('нет открытого терминала: открой вкладку терминала', 'not_found')
    return best
  }

  function attachedCount(id: string): number {
    return clients.get(id)?.size ?? 0
  }

  // Восстановление (§2): свои сессии с прошлого запуска — поток и состояние.
  for (const id of (await sessions()).keys()) {
    if (!validId(id)) continue
    try {
      terms.set(id, await adopt(id))
    } catch (err) {
      log(`восстановить ${PREFIX}${id}: ${String(err)}`)
    }
  }
  if (terms.size) log(`восстановлено терминалов: ${terms.size} (${[...terms.values()].map((t) => `${t.id}:${t.state}`).join(', ')})`)

  function attach(t: Terminal, conn: WsConnection, cols: number, rows: number): void {
    const p = pty.spawn(tmux.bin, [...tmux.baseArgs, 'attach-session', '-t', `=${t.session}`], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: home,
      env: { ...(env as Record<string, string>), TERM: 'xterm-256color' },
    })
    const entry = { pty: p, conn }
    let set = clients.get(t.id)
    if (!set) clients.set(t.id, (set = new Set()))
    set.add(entry)
    t.lastActive = Date.now()
    const sendState = (state: TerminalState) => conn.send(`s${JSON.stringify({ state, ...(t.lastCode !== undefined ? { lastCode: t.lastCode } : {}) })}`)
    sendState(t.state)
    const off = t.onState(sendState)
    p.onData((d) => conn.send(`o${d}`))
    p.onExit(() => {
      off()
      set!.delete(entry)
      void alive(t.id).then((yes) => {
        if (!yes) {
          drop(t.id)
          conn.send(`x${JSON.stringify({ reason: 'шелл кончился' })}`)
        }
        conn.close(1000)
      })
    })
    conn.onMessage((msg) => {
      const kind = msg[0]
      const body = msg.slice(1)
      if (kind === 'i') {
        t.noteInput(body)
        p.write(body)
      } else if (kind === 'r') {
        try {
          const r = JSON.parse(body) as { cols?: number; rows?: number }
          if (r.cols && r.rows) p.resize(clamp(r.cols, 2, 500), clamp(r.rows, 2, 300))
        } catch {
          // битый resize — мимо
        }
      }
    })
    conn.onClose(() => {
      off()
      set!.delete(entry)
      try {
        p.kill()
      } catch {
        // уже вышел
      }
    })
  }

  return {
    socket,
    async list() {
      const live = await sessions()
      for (const id of [...terms.keys()]) if (!live.has(id)) drop(id)
      const out: TerminalInfo[] = []
      for (const id of live.keys()) {
        if (!validId(id)) continue
        const t = terms.get(id) ?? (await get(id))
        out.push(await t.info(attachedCount(id)))
      }
      return out
    },
    async ensure(id, o = {}) {
      const t = await get(id, o)
      return t.info(attachedCount(id))
    },
    async info(id) {
      if (!validId(id) || !(await alive(id))) return null
      const t = await get(id)
      return t.info(attachedCount(id))
    },
    async run(input) {
      if (typeof input.command !== 'string' || input.command.trim() === '') throw new PtyError('terminal.run: нужна command', 'bad_request')
      if (input.mode !== undefined && input.mode !== 'insert' && input.mode !== 'execute') throw new PtyError('terminal.run: mode — insert или execute', 'bad_request')
      const t = await pick(input.terminal)
      return t.run(input)
    },
    async read(input) {
      const t = await pick(input.terminal)
      const text = await t.read(input.lines ?? 50)
      const info = await t.info(attachedCount(t.id))
      return { terminal: t.id, state: t.state, text, ...(info.cwd ? { cwd: info.cwd } : {}) }
    },
    async kill(id) {
      if (!validId(id)) return false
      for (const c of clients.get(id) ?? []) c.conn.close(1000, 'killed')
      drop(id)
      try {
        await tmux.run(['kill-session', '-t', `=${PREFIX}${id}`])
      } catch (err) {
        if (!isMissing(err)) throw err
        return false
      } finally {
        rmSync(logFile(id), { force: true })
      }
      return true
    },
    upgrade(req, socket, head, id, query) {
      if (!validId(id)) return rejectUpgrade(socket, 400, 'Bad Request', `плохой id терминала «${id}»`)
      const cols = clamp(Number(query.get('cols')) || 120, 2, 500)
      const rows = clamp(Number(query.get('rows')) || 32, 2, 300)
      const cwd = query.get('cwd') ?? undefined
      get(id, { ...(cwd ? { cwd } : {}), cols, rows }).then(
        (t) => {
          const conn = acceptWebSocket(req, socket, head)
          if (conn) attach(t, conn, cols, rows)
        },
        (err) => rejectUpgrade(socket, 500, 'Internal Server Error', String(err instanceof Error ? err.message : err)),
      )
    },
    async close() {
      for (const set of clients.values()) for (const c of set) c.conn.close(1001, 'server closing')
      clients.clear()
      for (const id of [...terms.keys()]) drop(id)
    },
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(n)))
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function safeShell(): string {
  try {
    return userInfo().shell || '/bin/zsh'
  } catch {
    return '/bin/zsh'
  }
}

/**
 * node-pty с prebuild: npm теряет бит исполнения у `spawn-helper` (macOS), и `spawn` падает
 * `posix_spawnp failed` — ставим бит сами перед первым запуском.
 */
async function loadNodePty(): Promise<typeof import('node-pty')> {
  const require = createRequire(import.meta.url)
  try {
    const root = dirname(require.resolve('node-pty/package.json'))
    for (const p of [join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'), join(root, 'build', 'Release', 'spawn-helper')]) {
      if (existsSync(p) && (statSync(p).mode & 0o111) === 0) chmodSync(p, 0o755)
    }
  } catch {
    // нет прав или другой раскладки — пусть упадёт честно на spawn
  }
  const mod = (await import('node-pty')) as typeof import('node-pty') & { default?: typeof import('node-pty') }
  return mod.default ?? mod
}
