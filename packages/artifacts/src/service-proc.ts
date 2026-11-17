/**
 * Хост-сторона `__host.service` (artifacts-spec §2): один процесс
 * `service-runner` на артефакт. Ленивый старт на первом `call`/`on`, выгрузка по
 * `$service-idle`, прозрачный респаун, детект падения; `$service: eager` —
 * старт сразу. Встроенное событие `__state` — `{state: up|idle|down|crashed, code?}`
 * (как exz v1).
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type ServiceState = 'up' | 'idle' | 'down' | 'crashed'
export type Result<T = unknown> = { ok: true; value: T } | { ok: false; error: string }

export interface ServiceProcOpts {
  dir: string
  dataDir: string
  workspace: string | null
  mode: 'lazy' | 'eager'
  idleSeconds: number
  /** Бинарь node; default — текущий. */
  node?: string
  env?: NodeJS.ProcessEnv
  warn?: (m: string) => void
}

const CALL_TIMEOUT_MS = 60_000
const START_TIMEOUT_MS = 30_000
const GRACE_MS = 3_000

/** Скомпилированный раннер рядом с модулем; из исходников (тесты) — `../dist`. */
const RUNNER = [new URL('./service-runner.js', import.meta.url), new URL('../dist/service-runner.js', import.meta.url)]
  .map((u) => fileURLToPath(u))
  .find((p) => existsSync(p)) ?? fileURLToPath(new URL('./service-runner.js', import.meta.url))

export class ServiceProc {
  private child: ChildProcess | null = null
  private ready: Promise<void> | null = null
  private seq = 0
  private pending = new Map<number, (r: Result) => void>()
  private listeners = new Map<string, Set<(p: unknown) => void>>()
  private idleTimer: NodeJS.Timeout | null = null
  private closing = false
  state: ServiceState = 'down'

  constructor(private readonly opts: ServiceProcOpts) {
    if (opts.mode === 'eager') void this.start().catch(() => {})
  }

  get exists(): boolean {
    return existsSync(join(this.opts.dir, 'service.ts'))
  }

  private setState(state: ServiceState, code?: number | null): void {
    this.state = state
    this.fire('__state', code === undefined ? { state } : { state, code })
  }

  private fire(event: string, payload: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) {
      try {
        cb(payload)
      } catch {
        // подписчик — не наша забота
      }
    }
  }

  on(event: string, cb: (payload: unknown) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) this.listeners.set(event, (set = new Set()))
    set.add(cb)
    // Подписка на события будит сервис: push-сервису (tick) без старта нечего слать.
    if (event !== '__state' && this.exists) void this.start().catch(() => {})
    else if (event === '__state') cb({ state: this.state })
    return () => void set.delete(cb)
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready
    if (!this.exists) return Promise.reject(new Error('no service'))
    this.closing = false
    this.ready = new Promise<void>((resolve, reject) => {
      const args = [RUNNER, `--dir=${this.opts.dir}`, `--data=${this.opts.dataDir}`]
      if (this.opts.workspace) args.push(`--workspace=${this.opts.workspace}`)
      const child = spawn(this.opts.node ?? process.execPath, args, {
        cwd: this.opts.dir,
        env: this.opts.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.child = child
      let buf = ''
      let up = false
      const timer = setTimeout(() => {
        if (!up) {
          reject(new Error(`service не поднялся за ${START_TIMEOUT_MS / 1000} с`))
          child.kill('SIGKILL')
        }
      }, START_TIMEOUT_MS)
      child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
        buf += chunk
        let nl: number
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          let msg: { id?: number; ok?: boolean; value?: unknown; error?: string; event?: string; payload?: unknown }
          try {
            msg = JSON.parse(line) as typeof msg
          } catch {
            continue
          }
          if (msg.event === '__ready') {
            up = true
            clearTimeout(timer)
            this.setState('up')
            resolve()
          } else if (typeof msg.event === 'string') this.fire(msg.event, msg.payload)
          else if (typeof msg.id === 'number') {
            const settle = this.pending.get(msg.id)
            this.pending.delete(msg.id)
            settle?.(msg.ok ? { ok: true, value: msg.value } : { ok: false, error: msg.error ?? 'service error' })
          }
        }
      })
      let stderr = ''
      child.stderr!.setEncoding('utf8').on('data', (c: string) => {
        stderr = (stderr + c).slice(-4000)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        this.child = null
        this.ready = null
        for (const settle of this.pending.values()) settle({ ok: false, error: `service exited (code ${code ?? 'signal'})` })
        this.pending.clear()
        if (!up) reject(new Error(`service упал при старте (code ${code}): ${stderr.trim().split('\n').slice(-3).join(' | ')}`))
        if (this.closing) this.setState(this.closing ? 'idle' : 'down', code)
        else {
          this.setState('crashed', code)
          if (stderr.trim()) this.opts.warn?.(`${this.opts.dir}: service crashed: ${stderr.trim().split('\n').slice(-3).join(' | ')}`)
        }
      })
    })
    return this.ready
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.opts.mode === 'eager' || this.opts.idleSeconds <= 0) return
    this.idleTimer = setTimeout(() => void this.stop(), this.opts.idleSeconds * 1000)
    this.idleTimer.unref()
  }

  async call(cmd: string, params: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<Result> {
    if (!this.exists) return { ok: false, error: 'no service' }
    try {
      await this.start()
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
    this.touch()
    const child = this.child
    if (!child?.stdin) return { ok: false, error: 'service down' }
    const id = ++this.seq
    return new Promise<Result>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, error: `service call timeout: ${cmd} (${timeoutMs} ms)` })
      }, timeoutMs)
      this.pending.set(id, (r) => {
        clearTimeout(timer)
        resolve(r)
      })
      child.stdin!.write(`${JSON.stringify({ id, cmd, params })}\n`)
    })
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    this.closing = true
    try {
      child.stdin?.write(`${JSON.stringify({ close: true })}\n`)
      child.stdin?.end()
    } catch {
      // уже закрыт
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, GRACE_MS)
      child.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
    })
  }
}
