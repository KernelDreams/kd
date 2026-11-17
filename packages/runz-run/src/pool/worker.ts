/**
 * Воркер пула (compute-pool-spec §3, §6, §7): один процесс на машину. Сам ходит
 * к центру — сердцебиение раз в 10 с и запрос задачи (long-poll); бюджет и
 * предохранитель задаёт машина в `~/.runz/worker.md`.
 *
 * Задача идёт в `~/.runz/pool/work/<id>-<попытка>/`: `code/` — копия пакета кода
 * из кэша, `inputs/` — входы, `out/` — папка прогона (её воркер отдаёт центру
 * архивом). Центр недоступен — конец задачи ждёт в `outbox/` и уходит, когда
 * центр вернётся; не принят (аренда ушла другой машине) — выбрасывается.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { arch, cpus, freemem, homedir, hostname, loadavg, platform } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { asText, isArray, parseDocument } from '@kerneldreams/nrd'
import { runFile } from '../run.js'
import { materialize, type TemplateValue, type TemplateValues } from '../template.js'
import { runEnv } from '../jobs/scheduler.js'
import { PkgCache } from './cache.js'
import type { Assignment, FinishReport, HeartbeatReply, LogLine } from './center.js'
import { pack } from './pack.js'
import { guardState } from './select.js'
import { splitRef } from './store.js'
import { parseBudget, parseGuard, parseSize, type Budget, type Guard, type Measure, type RunningLease, type WorkerState } from './types.js'

export const WORKER_VERSION = '1'
export const HEARTBEAT_MS = 10_000
export const CLAIM_WAIT_MS = 25_000

/** Как воркер говорит с центром: HTTP ({@link httpPoolClient}) или напрямую (тесты, один процесс). */
export interface PoolClient {
  heartbeat(state: WorkerState): Promise<HeartbeatReply>
  claim(state: WorkerState, waitMs: number): Promise<Assignment | null>
  log(name: string, id: string, lease: string, lines: LogLine[]): Promise<boolean>
  finish(name: string, r: FinishReport, out?: Buffer): Promise<boolean>
  giveBack(name: string, id: string, lease: string, reason: 'guard' | 'pause' | 'error'): Promise<boolean>
  pkg(sha: string): Promise<Buffer>
}

export interface WorkerConfig {
  name: string
  pool: string
  key: string
  budget: Budget
  /** `always`, `HH:MM-HH:MM`, `idle`. */
  hours: string
  guard: Guard
  labels: string[]
  /** Корень воркера: кэш, работа, почтовый ящик. */
  root: string
}

const G = 1024 ** 3

/** Дефолты: машина без конфига отдаёт немного — 2 ядра, 4G, одна задача. */
export function defaultWorkerConfig(): WorkerConfig {
  return {
    name: hostname().split('.')[0]!.toLowerCase(),
    pool: 'https://pool.nr',
    key: '',
    budget: { cpu: 2, mem: 4 * G, disk: 20 * G, jobs: 1 },
    hours: 'always',
    guard: { memFree: 4 * G, diskFree: 20 * G, load: 0.8 },
    labels: [],
    root: join(homedir(), '.runz', 'pool'),
  }
}

export const workerConfigFile = (): string => process.env.RUNZ_WORKER_CONFIG || join(homedir(), '.runz', 'worker.md')

/** `~/.runz/worker.md` (§3); нет файла — дефолты. */
export function loadWorkerConfig(file = workerConfigFile()): WorkerConfig {
  const cfg = defaultWorkerConfig()
  let doc: ReturnType<typeof parseDocument>
  try {
    doc = parseDocument(readFileSync(file, 'utf8'), { sigil: '$' })
  } catch {
    return cfg
  }
  const text = (k: string): string | undefined => asText(doc.get([k]) as never)?.trim() || undefined
  cfg.name = text('name') ?? cfg.name
  cfg.pool = text('pool') ?? cfg.pool
  cfg.key = text('key') ?? cfg.key
  cfg.hours = text('hours') ?? cfg.hours
  cfg.root = text('root')?.replace(/^~(?=$|\/)/, homedir()) ?? cfg.root
  cfg.budget = parseBudget(doc.get(['budget']), cfg.budget)
  cfg.guard = parseGuard(doc.get(['guard']), cfg.guard)
  const labels = doc.get(['labels'])
  if (isArray(labels as never)) cfg.labels = [...(labels as { iterate(): Iterable<unknown> }).iterate()].map((x) => asText(x as never) ?? '').filter(Boolean)
  else if (Array.isArray(labels)) cfg.labels = labels.map(String)
  else if (typeof labels === 'string') cfg.labels = labels.split(',').map((s) => s.trim()).filter(Boolean)
  return cfg
}

/**
 * Свободная память по-честному: на macOS `os.freemem()` — только совсем пустые
 * страницы (сотни мегабайт на живой машине), в запас идут и неактивные,
 * спекулятивные, вычищаемые (`vm_stat`).
 */
export function freeMemory(): number {
  if (platform() !== 'darwin') return freemem()
  try {
    const out = execFileSync('vm_stat', { encoding: 'utf8' })
    const page = Number(/page size of (\d+)/.exec(out)?.[1] ?? 16384)
    const pages = (name: string): number => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(out)?.[1] ?? 0)
    return (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable')) * page
  } catch {
    return freemem()
  }
}

export function measure(path: string): Measure {
  const n = Math.max(1, cpus().length)
  const la = loadavg()[0] ?? 0
  let diskFree = Number.POSITIVE_INFINITY
  try {
    mkdirSync(path, { recursive: true })
    const s = statfsSync(path)
    diskFree = Number(s.bavail) * Number(s.bsize)
  } catch {
    // нет statfs — диск не ограничивает
  }
  return { memFree: freeMemory(), diskFree, load: la / n, cpuFree: Math.max(0, n - la) }
}

/** Секунды без клавиатуры и мыши (macOS `HIDIdleTime`); не знаем — 0. */
export function idleSeconds(): number {
  if (platform() !== 'darwin') return 0
  try {
    const out = execFileSync('ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { encoding: 'utf8' })
    const ns = Number(/"HIDIdleTime" = (\d+)/.exec(out)?.[1] ?? 0)
    return ns / 1e9
  } catch {
    return 0
  }
}

const IDLE_AFTER_S = 300

/** Можно ли сейчас брать новое (`$hours`). Идущее доделывается в любом случае. */
export function hoursOk(hours: string, now: Date, idle: () => number = idleSeconds): boolean {
  const h = hours.trim().toLowerCase()
  if (h === '' || h === 'always') return true
  if (h === 'never') return false
  if (h === 'idle') return idle() >= IDLE_AFTER_S
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(h)
  if (!m) return true
  const from = Number(m[1]) * 60 + Number(m[2])
  const to = Number(m[3]) * 60 + Number(m[4])
  const t = now.getHours() * 60 + now.getMinutes()
  return from <= to ? t >= from && t < to : t >= from || t < to
}

// --- исполнение ---

export interface ExecTask {
  assignment: Assignment
  /** Каталог задачи: `code/`, `inputs/`, `out/`. */
  work: string
  /** Документ (абсолютный путь) или имя appz. */
  file: string
  cwd: string
  values: TemplateValues
  env: NodeJS.ProcessEnv
  signal: AbortSignal
  onLine(stream: 'stdout' | 'stderr', text: string): void
}

export interface ExecResult {
  status: 'done' | 'failed' | 'cancelled'
  exit: number | null
  output: string
  /** Абсолютные пути выходов. */
  outputs: string[]
  error?: string
  ms: number
}

export type Executor = (t: ExecTask) => Promise<ExecResult>

const cliArgs = (values: TemplateValues): string[] =>
  Object.entries(values).map(([k, v]) => `--${k}=${Array.isArray(v) ? v.join(',') : String(v)}`)

/** Исполнитель по умолчанию — runz, как обёртка `job-wrap`: значения материализуются рядом с рецептом. */
export function runzExecutor(runz: string[] = ['runz']): Executor {
  return async (t) => {
    let file = t.file
    let args: string[] = []
    let temp: string | null = null
    const doc = isAbsolute(t.file) && existsSync(t.file)
    try {
      if (doc && Object.keys(t.values).length > 0) {
        const ext = extname(t.file) || '.mdz'
        temp = join(dirname(t.file), `.${basename(t.file, ext)}.job-${t.assignment.id}${ext}`)
        writeFileSync(temp, materialize(readFileSync(t.file, 'utf8'), t.values))
        file = temp
      } else if (!doc) {
        args = cliArgs(t.values)
      }
      const r = await runFile({ file, args, runz, cwd: t.cwd, env: t.env, signal: t.signal, timeoutMs: t.assignment.timeoutMs ?? 0, killGraceMs: 10_000, onLine: t.onLine })
      const status = t.signal.aborted ? 'cancelled' : r.ok ? 'done' : 'failed'
      const res: ExecResult = { status, exit: r.exitCode, output: r.output, outputs: r.outputs.flatMap((o) => (o.type === 'text' ? [] : [o.path])), ms: r.ms }
      if (status === 'failed') res.error = (r.timedOut ? `таймаут ${Math.round((t.assignment.timeoutMs ?? 0) / 1000)} с` : r.stderr.trim() || r.output || `runz exit ${String(r.exitCode)}`).slice(-2_000)
      return res
    } finally {
      if (temp) rmSync(temp, { force: true })
    }
  }
}

// --- воркер ---

interface Live {
  a: Assignment
  started: string
  ac: AbortController
  /** Почему прервали: отмена пользователем, предохранитель, аренда ушла. */
  why?: 'cancel' | 'guard' | 'drop'
  lines: LogLine[]
  done: Promise<void>
}

interface Outbox {
  report: FinishReport
  hasOut: boolean
}

export interface WorkerOpts {
  config: WorkerConfig
  client: PoolClient
  exec?: Executor
  /** Замер машины; default — {@link measure} по корню воркера. */
  measure?: () => Measure
  clock?: () => Date
  idle?: () => number
  log?: (msg: string) => void
}

const MAX_BUFFERED_LINES = 5_000

export class Worker {
  readonly cfg: WorkerConfig
  readonly cache: PkgCache
  private readonly live = new Map<string, Live>()
  private readonly exec: Executor
  private readonly measureFn: () => Measure
  private centerPaused = false
  private stopped = false
  private hbTimer: ReturnType<typeof setInterval> | null = null
  /** Последний замер и состояние предохранителя (для `status`). */
  last: { measure: Measure; guard: WorkerState['guard'] } | null = null

  constructor(private readonly opts: WorkerOpts) {
    this.cfg = opts.config
    this.cache = new PkgCache(join(this.cfg.root, 'cache'), this.cfg.budget.disk)
    this.exec = opts.exec ?? runzExecutor()
    this.measureFn = opts.measure ?? (() => measure(this.cfg.root))
    mkdirSync(this.outboxDir, { recursive: true })
  }

  private get outboxDir(): string {
    return join(this.cfg.root, 'outbox')
  }

  private get pauseFile(): string {
    return join(this.cfg.root, 'paused')
  }

  /** Пауза машины руками (`runz worker pause`): доделать идущее, новое не брать. */
  static setPaused(root: string, on: boolean): void {
    mkdirSync(root, { recursive: true })
    if (on) writeFileSync(join(root, 'paused'), new Date().toISOString() + '\n')
    else rmSync(join(root, 'paused'), { force: true })
  }

  get paused(): boolean {
    return this.centerPaused || existsSync(this.pauseFile)
  }

  running(): string[] {
    return [...this.live.keys()]
  }

  /** Состояние для центра. */
  state(): WorkerState {
    const m = this.measureFn()
    const guard = guardState(this.cfg.guard, m)
    this.last = { measure: m, guard }
    const running: RunningLease[] = [...this.live.values()].map((l) => ({ id: l.a.id, lease: l.a.lease, needs: l.a.needs, started: l.started }))
    const now = this.opts.clock?.() ?? new Date()
    return {
      name: this.cfg.name,
      os: platform(),
      arch: arch(),
      labels: this.cfg.labels,
      budget: this.cfg.budget,
      measure: m,
      guard,
      // Не те часы — для центра то же, что пауза: новое не давать.
      paused: this.paused || !hoursOk(this.cfg.hours, now, this.opts.idle),
      running,
      cache: this.cache.list(),
      version: WORKER_VERSION,
    }
  }

  private say(msg: string): void {
    this.opts.log?.(msg)
  }

  /**
   * Сердцебиение: аренды, отмены, пауза центра; предохранитель глубоко пробит —
   * остановить самую младшую задачу (§3); отдать накопленное (лог, outbox).
   */
  async heartbeat(): Promise<WorkerState> {
    const st = this.state()
    if (st.guard === 'deep' && this.live.size > 0) {
      const youngest = [...this.live.values()].sort((a, b) => b.started.localeCompare(a.started))[0]!
      this.say(`предохранитель: память ${Math.round(st.measure.memFree / 1024 ** 2)}M — останавливаю ${youngest.a.id}`)
      youngest.why = 'guard'
      youngest.ac.abort()
    }
    try {
      const r = await this.opts.client.heartbeat(st)
      this.centerPaused = r.paused
      for (const id of r.drop) {
        const l = this.live.get(id)
        if (l && !l.why) {
          this.say(`аренда ${id} ушла — бросаю`)
          l.why = 'drop'
          l.ac.abort()
        }
      }
      for (const id of r.cancel) {
        const l = this.live.get(id)
        if (l && !l.why) {
          l.why = 'cancel'
          l.ac.abort()
        }
      }
      await this.flushLogs()
      await this.flushOutbox()
    } catch (e) {
      this.say(`центр недоступен: ${(e as Error).message}`)
    }
    this.writeStatus(st)
    return st
  }

  private writeStatus(st: WorkerState): void {
    try {
      const file = join(this.cfg.root, 'status.json')
      writeFileSync(`${file}.tmp`, JSON.stringify({ ...st, at: new Date().toISOString(), pool: this.cfg.pool }, null, 1))
      renameSync(`${file}.tmp`, file)
    } catch {
      // статус — для глаз, не критичен
    }
  }

  /** Можно ли сейчас спрашивать задачу (центр решает, влезает ли). */
  canAsk(st: WorkerState): boolean {
    return !this.stopped && !st.paused && st.guard === 'ok'
  }

  /** Один запрос задачи; получил — запускает (не ждёт конца). */
  async claimOnce(waitMs = 0): Promise<string | null> {
    const st = this.state()
    if (!this.canAsk(st)) return null
    const a = await this.opts.client.claim(st, waitMs)
    if (!a) return null
    this.startJob(a)
    return a.id
  }

  /** Резидентный режим: сердцебиение по таймеру, запросы задач подряд. */
  async run(): Promise<void> {
    this.hbTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS)
    await this.heartbeat()
    while (!this.stopped) {
      let got: string | null = null
      try {
        got = await this.claimOnce(CLAIM_WAIT_MS)
      } catch (e) {
        this.say(`центр недоступен: ${(e as Error).message}`)
      }
      if (!got && !this.stopped) await new Promise((r) => setTimeout(r, 2_000))
    }
  }

  /** Остановить воркер: новое не брать; `abort` — и идущее вернуть в очередь. */
  async stop(abort = false): Promise<void> {
    this.stopped = true
    if (this.hbTimer) clearInterval(this.hbTimer)
    if (abort) {
      for (const l of this.live.values()) {
        l.why = 'guard'
        l.ac.abort()
      }
    }
    await this.idle()
  }

  /** Дождаться конца всех идущих задач. */
  async idle(): Promise<void> {
    while (this.live.size > 0) await Promise.all([...this.live.values()].map((l) => l.done))
  }

  private startJob(a: Assignment): void {
    const ac = new AbortController()
    const live: Live = { a, started: new Date().toISOString(), ac, lines: [], done: Promise.resolve() }
    this.live.set(a.id, live)
    live.done = this.runJob(live).finally(() => this.live.delete(a.id))
  }

  private async runJob(l: Live): Promise<void> {
    const a = l.a
    const work = join(this.cfg.root, 'work', `${a.id}-${a.attempt}`)
    rmSync(work, { recursive: true, force: true })
    mkdirSync(work, { recursive: true })
    let flush: ReturnType<typeof setInterval> | null = null
    try {
      const keep = this.keepPkgs()
      let code: string | null = null
      for (const ref of a.pkgs) {
        const { role, sha } = splitRef(ref)
        const src = await this.cache.ensure(sha, (s) => this.opts.client.pkg(s), keep)
        const dst = join(work, role)
        cpSync(src, dst, { recursive: true })
        if (role === 'code') code = dst
      }
      mkdirSync(join(work, 'inputs'), { recursive: true })
      const file = code ? join(code, a.target) : a.target
      const cwd = code ? resolve(code, a.cwd) : work
      const values = this.values(a, work)
      const env: NodeJS.ProcessEnv = { ...runEnv(), RUNZ_JOB_DIR: work, RUNZ_JOB_ID: a.id, RUNZ_POOL_WORKER: this.cfg.name }
      if (a.shard !== undefined) env.RUNZ_SHARD = String(a.shard)
      if (a.shards !== undefined) env.RUNZ_SHARDS = String(a.shards)
      flush = setInterval(() => void this.flushLogs(), 1_000)
      const r = await this.exec({
        assignment: a,
        work,
        file,
        cwd,
        values,
        env,
        signal: l.ac.signal,
        onLine: (stream, text) => {
          l.lines.push({ stream, text, ts: new Date().toISOString() })
          // Центр долго недоступен — держим голову и хвост, середину выкидываем.
          if (l.lines.length > MAX_BUFFERED_LINES) l.lines.splice(1_000, l.lines.length - MAX_BUFFERED_LINES + 1, { stream: 'stderr', text: '[pool: строки лога пропущены — центр был недоступен]' })
        },
      })
      clearInterval(flush)
      flush = null
      if (l.why === 'drop') return
      if (l.why === 'guard') {
        await this.flushLog(l)
        await this.opts.client.giveBack(this.cfg.name, a.id, a.lease, 'guard').catch(() => false)
        return
      }
      await this.flushLog(l)
      const outDir = join(work, 'out')
      const report: FinishReport = { id: a.id, lease: a.lease, status: l.why === 'cancel' ? 'cancelled' : r.status, exit: r.exit, ms: r.ms }
      if (r.output) report.output = r.output
      if (r.error) report.error = r.error
      const inside = r.outputs.filter((p) => !relative(outDir, p).startsWith('..') && !isAbsolute(relative(outDir, p)))
      if (inside.length > 0) report.outputs = inside.map((p) => relative(outDir, p).split(sep).join('/'))
      const out = existsSync(outDir) ? pack(outDir).bytes : undefined
      this.toOutbox(report, out)
      await this.flushOutbox()
    } catch (e) {
      if (flush) clearInterval(flush)
      if (l.why === 'drop') return
      this.say(`задача ${a.id}: ${(e as Error).message}`)
      await this.flushLog(l).catch(() => undefined)
      this.toOutbox({ id: a.id, lease: a.lease, status: 'failed', error: `pool ${this.cfg.name}: ${(e as Error).message}` })
      await this.flushOutbox()
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }

  /** Пакеты идущих задач кэш не выкидывает. */
  private keepPkgs(): string[] {
    return [...this.live.values()].flatMap((l) => l.a.pkgs.map((r) => splitRef(r).sha))
  }

  /** `inputs/<имя>` → входы задачи, `out` — папка прогона этой машины. */
  private values(a: Assignment, work: string): TemplateValues {
    const one = (v: TemplateValue): TemplateValue => {
      if (typeof v !== 'string' || !v.startsWith('inputs/')) return v
      const p = join(work, 'inputs', v.slice('inputs/'.length))
      return existsSync(p) ? p : v
    }
    const out: TemplateValues = {}
    for (const [k, v] of Object.entries(a.values)) out[k] = Array.isArray(v) ? v.map(one) : one(v)
    if (a.out) {
      mkdirSync(join(work, 'out'), { recursive: true })
      out.out = join(work, 'out')
    }
    return out
  }

  private async flushLog(l: Live): Promise<void> {
    if (l.lines.length === 0) return
    const batch = l.lines.splice(0)
    try {
      await this.opts.client.log(this.cfg.name, l.a.id, l.a.lease, batch)
    } catch {
      l.lines.unshift(...batch)
    }
  }

  private async flushLogs(): Promise<void> {
    await Promise.all([...this.live.values()].map((l) => this.flushLog(l)))
  }

  private toOutbox(report: FinishReport, out?: Buffer): void {
    const base = join(this.outboxDir, report.id)
    if (out) writeFileSync(`${base}.tgz`, out)
    const ob: Outbox = { report, hasOut: out !== undefined }
    writeFileSync(`${base}.json.tmp`, JSON.stringify(ob))
    renameSync(`${base}.json.tmp`, `${base}.json`)
  }

  /** Отдать накопленные концы задач. Не принят — аренда ушла другой машине: выбросить. */
  async flushOutbox(): Promise<number> {
    let sent = 0
    let names: string[]
    try {
      names = readdirSync(this.outboxDir).filter((n) => n.endsWith('.json'))
    } catch {
      return 0
    }
    for (const n of names) {
      const base = join(this.outboxDir, n.slice(0, -'.json'.length))
      let ob: Outbox
      try {
        ob = JSON.parse(readFileSync(`${base}.json`, 'utf8')) as Outbox
      } catch {
        rmSync(`${base}.json`, { force: true })
        continue
      }
      const out = ob.hasOut && existsSync(`${base}.tgz`) ? readFileSync(`${base}.tgz`) : undefined
      try {
        const ok = await this.opts.client.finish(this.cfg.name, ob.report, out)
        if (!ok) this.say(`задача ${ob.report.id}: центр не принял конец (аренда ушла) — выбрасываю`)
        sent++
      } catch {
        continue // центр недоступен — в следующий раз
      }
      rmSync(`${base}.json`, { force: true })
      rmSync(`${base}.tgz`, { force: true })
    }
    return sent
  }

  /** Сколько в outbox ждёт центра. */
  pending(): number {
    try {
      return readdirSync(this.outboxDir).filter((n) => n.endsWith('.json')).length
    } catch {
      return 0
    }
  }
}

export { parseSize }
