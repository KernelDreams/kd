/**
 * Реестр процессов `exec` (tools-spec §2): команда — `sh -c` в своей группе
 * процессов (kill бьёт и детей: `python3 -m http.server` под `sh`), вывод
 * stdout+stderr — общий буфер с курсором чтения для `process poll`.
 *
 * Образец — OpenClaw `bash-process-registry`/`bash-tools.process` (yield в фон,
 * poll по курсору, kill), без PTY, approvals-шлюза и host/node.
 *
 * Живут в процессе бэкенда: `killAll()` — при остановке бэкенда (хост),
 * процессы рана — при отмене этого рана (`signal` старта).
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createOutputDecoder } from './oem.js'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProcInfo, ProcessRegistry } from '../host.js'

interface Proc extends ProcInfo {
  child: ChildProcess
  /** Хвост вывода (до `maxBufferBytes`), `dropped` — сколько символов срезано с головы. */
  buffer: string
  dropped: number
  /** Абсолютная позиция чтения poll. */
  cursor: number
  timeout?: ReturnType<typeof setTimeout>
  done: Promise<void>
  notify: Set<() => void>
  /** Кто убил: отмена рана, таймаут, kill. */
  killedBy?: 'abort' | 'timeout' | 'kill'
  /** Сокет/хелпер askpass процесса — убрать по его завершении. */
  askpass?: { stop(): void }
}

/** Максимум на строку запроса хелпера (приглашение sudo короткое). */
const ASKPASS_MAX_LINE = 4096

/**
 * `SUDO_ASKPASS` процесса: unix-сокет в каталоге 0700 + скрипт-хелпер, который
 * шлёт приглашение (`$1`) в сокет и печатает ответ. Хелпер зовёт `sudo` сам,
 * когда нет терминала (процесс — в своей сессии, `detached`) и задан askpass.
 */
function startAskpass(ask: (prompt: string) => Promise<string | undefined>, basePath: string): { env: Record<string, string>; stop(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'nr-askpass-'))
  chmodSync(dir, 0o700)
  const sock = join(dir, 's')
  const script = join(dir, 'askpass.sh')
  // `nc -U`: приглашение строкой, ответ — строкой; без ответа сокет закрывается пустым → exit 1.
  writeFileSync(script, `#!/bin/sh\nout=$(printf '%s\\n' "$1" | nc -U '${sock.replace(/'/g, "'\\''")}') || exit 1\n[ -n "$out" ] || exit 1\nprintf '%s\\n' "$out"\n`, { mode: 0o700 })
  // `sudo` без терминала сам askpass не берёт — только с `-A`: шим перед PATH
  // добавляет `-A` (если в вызове нет `-S`/`-A`/`-n`), настоящий sudo — первый в PATH без шима.
  writeFileSync(
    join(dir, 'sudo'),
    `#!/bin/sh\n` +
      `case " $* " in *" -S "*|*" --stdin "*|*" -A "*|*" --askpass "*|*" -n "*|*" --non-interactive "*) flag= ;; *) flag=-A ;; esac\n` +
      `PATH='${basePath.replace(/'/g, "'\\''")}'\nexec sudo $flag "$@"\n`,
    { mode: 0o700 },
  )
  const server: Server = createServer((c) => {
    let buf = ''
    let asked = false
    c.setEncoding('utf8')
    c.on('error', () => {})
    c.on('data', (d: string) => {
      buf += d
      const nl = buf.indexOf('\n')
      if ((nl < 0 && buf.length < ASKPASS_MAX_LINE) || asked) return
      asked = true
      const prompt = (nl < 0 ? buf : buf.slice(0, nl)).trim()
      ask(prompt)
        .then((pw) => c.end(pw ? `${pw.replace(/[\r\n]+/g, '')}\n` : ''))
        .catch(() => c.end())
    })
  })
  server.listen(sock)
  server.unref()
  return {
    env: { SUDO_ASKPASS: script, PATH: `${dir}:${basePath}` },
    stop() {
      server.close()
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* уже нет */
      }
    },
  }
}

const WIN = process.platform === 'win32'

/**
 * Шелл команды: POSIX — `/bin/sh -c`, Windows — `cmd.exe /d /s /c "…"` (как `child_process.exec`). Вывод в OEM
 * (cp866) разбирает {@link createOutputDecoder}: `chcp` без консоли не действует.
 */
export function shellOf(command: string, win = WIN): [string, string[]] {
  return win ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`]] : ['/bin/sh', ['-c', command]]
}

export function createProcessRegistry(opts: { maxBufferBytes?: number } = {}): ProcessRegistry {
  const maxBuffer = opts.maxBufferBytes ?? 1024 * 1024
  const procs = new Map<string, Proc>()
  let seq = 0

  const info = (p: Proc): ProcInfo => {
    const out: ProcInfo = { id: p.id, sessionId: p.sessionId, command: p.command, cwd: p.cwd, status: p.status, startedAt: p.startedAt, background: p.background }
    if (p.pid !== undefined) out.pid = p.pid
    if (p.exitCode !== undefined) out.exitCode = p.exitCode
    if (p.signal !== undefined) out.signal = p.signal
    if (p.endedAt !== undefined) out.endedAt = p.endedAt
    return out
  }

  const killGroup = (p: Proc, sig: NodeJS.Signals): void => {
    if (p.status !== 'running' || p.pid === undefined) return
    if (WIN) {
      // группы процессов нет: дерево по pid (cmd.exe и его дети)
      const r = spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      if (r.status !== 0) p.child.kill(sig)
      return
    }
    try {
      process.kill(-p.pid, sig) // группа: sh и его дети
    } catch {
      try {
        p.child.kill(sig)
      } catch {
        /* уже нет */
      }
    }
  }

  const reg: ProcessRegistry = {
    shell: WIN ? 'cmd.exe /c' : 'sh -c',
    start(o) {
      const id = `p${++seq}`
      const askpass = o.askpass && !WIN ? startAskpass(o.askpass, o.env?.PATH ?? process.env.PATH ?? '/usr/bin:/bin') : undefined
      const [shell, args] = shellOf(o.command)
      const child = spawn(shell, args, {
        cwd: o.cwd,
        env: { ...process.env, ...(o.env ?? {}), ...(askpass?.env ?? {}) },
        // Windows: detached — своё окно консоли; группа там не нужна (дерево гасит taskkill /T)
        detached: !WIN,
        windowsHide: true,
        windowsVerbatimArguments: WIN,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let resolveDone!: () => void
      const p: Proc = {
        id,
        sessionId: o.sessionId,
        command: o.command,
        cwd: o.cwd,
        status: 'running',
        startedAt: Date.now(),
        background: false,
        child,
        buffer: '',
        dropped: 0,
        cursor: 0,
        done: new Promise<void>((r) => (resolveDone = r)),
        notify: new Set(),
      }
      if (askpass) p.askpass = askpass
      if (child.pid !== undefined) p.pid = child.pid
      const decode = createOutputDecoder()
      const append = (chunk: Buffer | string): void => {
        p.buffer += decode(chunk)
        if (p.buffer.length > maxBuffer) {
          const cut = p.buffer.length - maxBuffer
          p.buffer = p.buffer.slice(cut)
          p.dropped += cut
        }
        for (const n of [...p.notify]) n()
      }
      child.stdout?.on('data', append)
      child.stderr?.on('data', append)
      child.stdin?.on('error', () => {})
      const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (p.status === 'running') p.status = p.killedBy ? 'killed' : 'exited'
        p.exitCode = code
        p.signal = signal
        p.endedAt = Date.now()
        if (p.timeout) clearTimeout(p.timeout)
        p.askpass?.stop()
        o.signal?.removeEventListener('abort', onAbort)
        resolveDone()
        for (const n of [...p.notify]) n()
      }
      child.on('error', (err) => {
        append(`\n[spawn error: ${err.message}]\n`)
        finish(127, null)
      })
      child.on('close', (code, signal) => finish(code, signal))
      const onAbort = (): void => {
        p.killedBy = 'abort'
        killGroup(p, 'SIGTERM')
      }
      if (o.signal) {
        if (o.signal.aborted) onAbort()
        else o.signal.addEventListener('abort', onAbort, { once: true })
      }
      if (o.timeoutMs && o.timeoutMs > 0) {
        p.timeout = setTimeout(() => {
          append(`\n[timeout: killed after ${Math.round(o.timeoutMs! / 1000)}s]\n`)
          p.killedBy = 'timeout'
          killGroup(p, 'SIGTERM')
        }, o.timeoutMs)
        p.timeout.unref?.()
      }
      procs.set(id, p)
      return info(p)
    },

    get: (id) => {
      const p = procs.get(id)
      return p ? info(p) : undefined
    },

    list: (sessionId) => [...procs.values()].filter((p) => sessionId === undefined || p.sessionId === sessionId).map(info),

    async wait(id, ms, signal) {
      const p = procs.get(id)
      if (!p) return true
      if (p.status !== 'running') return true
      await race(p.done, ms, signal)
      return p.status !== 'running'
    },

    async waitOutput(id, ms, signal) {
      const p = procs.get(id)
      if (!p || p.status !== 'running') return
      if (p.dropped + p.buffer.length > p.cursor) return
      let wake!: () => void
      const woke = new Promise<void>((r) => (wake = r))
      p.notify.add(wake)
      try {
        await race(woke, ms, signal)
      } finally {
        p.notify.delete(wake)
      }
    },

    output(id) {
      const p = procs.get(id)
      if (!p) return { text: '', dropped: 0 }
      p.cursor = p.dropped + p.buffer.length
      return { text: p.buffer, dropped: p.dropped }
    },

    read(id) {
      const p = procs.get(id)
      if (!p) return { text: '', skipped: 0 }
      const from = Math.max(p.cursor, p.dropped)
      const skipped = from - p.cursor
      const text = p.buffer.slice(from - p.dropped)
      p.cursor = p.dropped + p.buffer.length
      return { text, skipped }
    },

    markBackground(id) {
      const p = procs.get(id)
      if (p) p.background = true
    },

    write(id, input) {
      const p = procs.get(id)
      if (!p || p.status !== 'running' || !p.child.stdin || p.child.stdin.destroyed) return false
      p.child.stdin.write(input)
      return true
    },

    kill(id, sig: string = 'SIGTERM') {
      const p = procs.get(id)
      if (!p || p.status !== 'running') return false
      p.killedBy = 'kill'
      killGroup(p, sig as NodeJS.Signals)
      // Не умер за 2 с — SIGKILL.
      const t = setTimeout(() => killGroup(p, 'SIGKILL'), 2000)
      t.unref?.()
      void p.done.then(() => clearTimeout(t))
      return true
    },

    remove(id) {
      const p = procs.get(id)
      if (p && p.status !== 'running') procs.delete(id)
    },

    killSession(sessionId) {
      let n = 0
      for (const p of procs.values()) if (p.sessionId === sessionId && reg.kill(p.id)) n++
      return n
    },

    killAll() {
      let n = 0
      for (const p of procs.values()) {
        if (p.status !== 'running') continue
        p.killedBy = 'kill'
        killGroup(p, 'SIGKILL')
        n++
      }
      return n
    },
  }
  return reg
}

function race(p: Promise<unknown>, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(done, Math.max(0, ms))
    function done(): void {
      clearTimeout(t)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    if (signal?.aborted) return done()
    signal?.addEventListener('abort', done, { once: true })
    void p.then(done, done)
  })
}
