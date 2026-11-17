/**
 * Центр пула (compute-pool-spec §2, §5, §7, §8): реестр jobs плюс раздача
 * воркерам. Центр никуда не стучится — воркеры сами приходят за задачей
 * ({@link Center.claim}, long-poll) и с сердцебиением ({@link Center.heartbeat}).
 *
 * Правда — по-прежнему `job.mdz` (аренда, попытка, машина — атрибуты); в памяти
 * только ждущие воркеры и их последнее сердцебиение. Центр перезапустили —
 * аренды идущих задач продлеваются на срок ({@link Center.recover}): воркеры
 * успевают прийти с сердцебиением, а пропавшие истекают как обычно.
 */

import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadJobsConfig, recipeName, type JobsConfig } from '../jobs/recipe.js'
import { appendLog, FINAL, jobDir, listIds, newJobId, readJob, withLock, writeJob } from '../jobs/registry.js'
import type { JobInfo, JobStatus } from '../jobs/registry.js'
import type { TemplateValues } from '../template.js'
import { pack, packCode, unpack } from './pack.js'
import { pick } from './select.js'
import { poolDir, putPkg, readPkg, shaOf } from './store.js'
import type { Needs, WorkerState } from './types.js'

export const LEASE_MS = 60_000
export const DEFAULT_RETRIES = 2

/** Что воркер получает вместе с задачей. */
export interface Assignment {
  id: string
  title: string
  lease: string
  leaseUntil: string
  attempt: number
  /** Документ внутри пакета кода (`entry`) либо имя appz. */
  target: string
  /** Рабочий каталог внутри пакета кода. */
  cwd: string
  values: TemplateValues
  keys: string[]
  needs: Needs
  /** Ссылки `роль:sha`. */
  pkgs: string[]
  timeoutMs?: number
  shard?: number
  shards?: number
  /** Рецепт пишет папку прогона — воркер отдаёт её центру. */
  out: boolean
}

export interface HeartbeatReply {
  /** Аренды этих задач у машины больше нет — бросить. */
  drop: string[]
  /** Запрошена отмена. */
  cancel: string[]
  /** Центр поставил машину на паузу (§9). */
  paused: boolean
  leaseMs: number
}

export interface FinishReport {
  id: string
  lease: string
  status: Extract<JobStatus, 'done' | 'failed' | 'cancelled'>
  exit?: number | null
  output?: string
  error?: string
  /** Пути выходов внутри папки прогона (`out/`). */
  outputs?: string[]
  ms?: number
}

export interface LogLine {
  stream: 'stdout' | 'stderr'
  text: string
  ts?: string
}

export interface WorkerView {
  name: string
  alive: boolean
  seen: string
  paused: boolean
  state: WorkerState
}

export interface CenterOpts {
  dir: string
  leaseMs?: number
  /** Хост prod (`$host`): ему — последним (§5). */
  prodHost?: string
  /** Лимиты `$job_keys` на весь пул; default — `$jobs` конфига runz на каждую раздачу. */
  config?: JobsConfig | (() => JobsConfig)
  clock?: () => number
  /** Сердцебиение старше — машина «пропала» в виде «Машины». */
  staleMs?: number
}

interface Waiter {
  name: string
  resolve: (a: Assignment | null) => void
  timer: ReturnType<typeof setTimeout> | null
}

const token = (): string => randomBytes(9).toString('base64url')

export class Center {
  readonly dir: string
  readonly leaseMs: number
  private readonly clock: () => number
  private readonly staleMs: number
  private readonly workers = new Map<string, { state: WorkerState; seen: number }>()
  private readonly waiters: Waiter[] = []
  private paused: Set<string>
  private chain: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly opts: CenterOpts) {
    this.dir = opts.dir
    this.leaseMs = opts.leaseMs ?? LEASE_MS
    this.clock = opts.clock ?? Date.now
    this.staleMs = opts.staleMs ?? 30_000
    mkdirSync(poolDir(this.dir), { recursive: true })
    try {
      this.paused = new Set(JSON.parse(readFileSync(this.pausedFile, 'utf8')) as string[])
    } catch {
      this.paused = new Set()
    }
  }

  private get pausedFile(): string {
    return join(poolDir(this.dir), 'paused.json')
  }

  private iso(ms = 0): string {
    return new Date(this.clock() + ms).toISOString()
  }

  private config(): JobsConfig {
    const c = this.opts.config
    return typeof c === 'function' ? c() : (c ?? loadJobsConfig())
  }

  /** Одна раздача за раз: проходы реестра не перекрываются внутри процесса. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => undefined)
    return next
  }

  /** Резидентный режим: истечение аренд и раздача по таймеру. */
  start(intervalMs = 1_000): this {
    if (this.timer) return this
    void this.recover()
    this.timer = setInterval(() => void this.dispatch().catch(() => undefined), intervalMs)
    this.timer.unref()
    return this
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const w of this.waiters.splice(0)) {
      if (w.timer) clearTimeout(w.timer)
      w.resolve(null)
    }
  }

  /** После перезапуска центра: идущим задачам — аренда заново на срок. */
  recover(): Promise<string[]> {
    return this.serial(() =>
      withLock(this.dir, () => {
        const ids: string[] = []
        for (const id of listIds(this.dir)) {
          const j = readJob(this.dir, id)
          if (!j?.pool || j.status !== 'running' || !j.lease) continue
          writeJob(this.dir, { ...j, leaseUntil: this.iso(this.leaseMs) })
          ids.push(id)
        }
        return ids
      }),
    )
  }

  // --- машины ---

  private note(state: WorkerState): void {
    this.workers.set(state.name, { state, seen: this.clock() })
  }

  private effective(state: WorkerState): WorkerState {
    return this.paused.has(state.name) ? { ...state, paused: true } : state
  }

  workerList(): WorkerView[] {
    const now = this.clock()
    return [...this.workers.values()]
      .map(({ state, seen }) => ({
        name: state.name,
        alive: now - seen <= this.staleMs,
        seen: new Date(seen).toISOString(),
        paused: state.paused || this.paused.has(state.name),
        state,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  pause(name: string, on = true): void {
    if (on) this.paused.add(name)
    else this.paused.delete(name)
    const tmp = `${this.pausedFile}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify([...this.paused]))
    renameSync(tmp, this.pausedFile)
  }

  /** Сердцебиение: продлить аренды, сказать, что бросить и что отменить. */
  heartbeat(state: WorkerState): Promise<HeartbeatReply> {
    this.note(state)
    return this.serial(() =>
      withLock(this.dir, () => {
        const reply: HeartbeatReply = { drop: [], cancel: [], paused: this.paused.has(state.name), leaseMs: this.leaseMs }
        for (const r of state.running) {
          const j = readJob(this.dir, r.id)
          if (!j || j.status !== 'running' || j.lease !== r.lease || j.worker !== state.name) {
            reply.drop.push(r.id)
            continue
          }
          writeJob(this.dir, { ...j, leaseUntil: this.iso(this.leaseMs) })
          if (j.cancel) reply.cancel.push(r.id)
        }
        return reply
      }),
    )
  }

  /**
   * Запрос задачи: есть подходящая — сразу, нет — ждать до `waitMs` (long-poll),
   * за это время раздача может отдать задачу этой машине. Ничего — null.
   */
  async claim(state: WorkerState, waitMs = 0): Promise<Assignment | null> {
    this.note(state)
    // Тот же воркер с новым запросом — старый запрос закрыть.
    this.dropClaim(state.name)
    let w!: Waiter
    const p = new Promise<Assignment | null>((res) => {
      w = { name: state.name, resolve: res, timer: null }
      this.waiters.push(w)
    })
    await this.dispatch()
    if (this.waiters.includes(w)) {
      if (waitMs <= 0) this.dropClaim(state.name)
      else w.timer = setTimeout(() => this.dropClaim(state.name), waitMs)
    }
    return p
  }

  /** Закрыть ждущий запрос машины (обрыв соединения, таймаут) — ответ null. */
  dropClaim(name: string): void {
    for (const old of this.waiters.filter((x) => x.name === name)) {
      if (old.timer) clearTimeout(old.timer)
      this.waiters.splice(this.waiters.indexOf(old), 1)
      old.resolve(null)
    }
  }

  // --- раздача ---

  /** Проход: истечение аренд, шарды, раздача ждущим воркерам. */
  dispatch(): Promise<{ assigned: string[]; expired: string[] }> {
    return this.serial(() =>
      withLock(this.dir, () => {
        const expired = this.expireLocked()
        this.sweepParentsLocked()
        const assigned = this.assignLocked()
        return { assigned, expired }
      }),
    )
  }

  private poolJobs(): JobInfo[] {
    const out: JobInfo[] = []
    for (const id of listIds(this.dir)) {
      const j = readJob(this.dir, id)
      if (j?.pool) out.push(j)
    }
    return out
  }

  /** Аренда истекла — снова в очередь, попытка +1; попыток нет — `lost` (§7). */
  private expireLocked(): string[] {
    const now = this.clock()
    const ids: string[] = []
    for (const j of this.poolJobs()) {
      if (j.status !== 'running' || !j.lease || !j.leaseUntil) continue
      if (Date.parse(j.leaseUntil) > now) continue
      const attempt = (j.attempt ?? 0) + 1
      const retries = j.retries ?? DEFAULT_RETRIES
      const tried = [...(j.tried ?? []), ...(j.worker ? [j.worker] : [])]
      const next: JobInfo = { ...j, attempt, tried }
      delete next.lease
      delete next.leaseUntil
      if (j.cancel) {
        next.status = 'cancelled'
        next.ended = this.iso()
      } else if (attempt > retries) {
        next.status = 'lost'
        next.ended = this.iso()
        next.error =
          j.repeatable || retries > 0
            ? `машина ${j.worker ?? '?'} пропала, попыток не осталось (${retries})`
            : `машина ${j.worker ?? '?'} пропала посреди задачи без $repeatable — второй раз сама не исполняется; повтор — kd job restart ${j.id}`
      } else {
        next.status = 'queued'
        delete next.started
      }
      writeJob(this.dir, next)
      appendLog(this.dir, j.id, { kind: next.status === 'queued' ? 'expire' : next.status === 'lost' ? 'lost' : 'end', status: next.status, worker: j.worker, attempt })
      ids.push(j.id)
    }
    return ids
  }

  private assignLocked(): string[] {
    if (this.waiters.length === 0) return []
    const jobs = this.poolJobs()
    const limits = this.config().limits
    const byKey = new Map<string, number>()
    for (const j of jobs) if (j.status === 'running' && j.lease) for (const k of new Set(j.keys)) byKey.set(k, (byKey.get(k) ?? 0) + 1)
    // Состояния ждущих с учётом розданного в этом проходе.
    const states = new Map<string, WorkerState>()
    for (const w of this.waiters) {
      const s = this.workers.get(w.name)?.state
      if (s) states.set(w.name, this.effective(s))
    }
    const assigned: string[] = []
    for (const j of jobs) {
      if (j.status !== 'queued' || j.shards !== undefined) continue
      if ([...new Set(j.keys)].some((k) => limits[k] !== undefined && (byKey.get(k) ?? 0) >= limits[k]!)) continue
      const waiting = this.waiters.map((w) => states.get(w.name)).filter((s): s is WorkerState => s !== undefined)
      const w = pick({ needs: j.needs, pkgs: (j.pkgs ?? []).map(shaOf) }, waiting, this.opts.prodHost)
      if (!w) continue
      const lease = token()
      const next: JobInfo = { ...j, status: 'running', worker: w.name, lease, leaseUntil: this.iso(this.leaseMs), started: this.iso() }
      delete next.ended
      delete next.exit
      delete next.output
      delete next.error
      writeJob(this.dir, next)
      appendLog(this.dir, j.id, { kind: 'lease', status: 'running', worker: w.name, attempt: j.attempt ?? 0 })
      for (const k of new Set(j.keys)) byKey.set(k, (byKey.get(k) ?? 0) + 1)
      const wi = this.waiters.findIndex((x) => x.name === w.name)
      const waiter = this.waiters.splice(wi, 1)[0]!
      if (waiter.timer) clearTimeout(waiter.timer)
      states.delete(w.name)
      waiter.resolve(this.assignment(next))
      assigned.push(j.id)
      if (this.waiters.length === 0) break
    }
    return assigned
  }

  private assignment(j: JobInfo): Assignment {
    const a: Assignment = {
      id: j.id,
      title: j.title,
      lease: j.lease!,
      leaseUntil: j.leaseUntil!,
      attempt: j.attempt ?? 0,
      target: j.entry ?? j.target,
      cwd: j.entryCwd ?? '.',
      values: j.values,
      keys: j.keys,
      needs: j.needs ?? {},
      pkgs: j.pkgs ?? [],
      out: j.out !== undefined || j.shard !== undefined || j.parent !== undefined,
    }
    if (j.timeoutMs !== undefined) a.timeoutMs = j.timeoutMs
    if (j.shard !== undefined) a.shard = j.shard
    if (j.shards !== undefined) a.shards = j.shards
    else if (j.shard !== undefined && j.parent) {
      const p = readJob(this.dir, j.parent)
      if (p?.shards !== undefined) a.shards = p.shards
    }
    return a
  }

  // --- от воркера ---

  /** Задача ещё за этой арендой. */
  private current(name: string, id: string, lease: string): JobInfo | null {
    const j = readJob(this.dir, id)
    return j && j.pool && j.status === 'running' && j.lease === lease && j.worker === name ? j : null
  }

  /** Строки лога (кадры с полем `worker`). Аренда чужая — false, строки не пишутся. */
  log(name: string, id: string, lease: string, lines: LogLine[]): Promise<boolean> {
    return this.serial(() =>
      withLock(this.dir, () => {
        if (!this.current(name, id, lease)) return false
        for (const l of lines) appendLog(this.dir, id, { kind: 'line', stream: l.stream, text: l.text, worker: name, ...(l.ts ? { ts: l.ts } : {}) })
        return true
      }),
    )
  }

  /**
   * Конец задачи от воркера. Принимается только от текущей аренды (§7): поздний
   * ответ старой машины — `false`, выходы выброшены. `out` — `tar.gz` папки прогона.
   */
  finish(name: string, r: FinishReport, out?: Buffer): Promise<boolean> {
    return this.serial(() =>
      withLock(this.dir, () => {
        const j = this.current(name, r.id, r.lease)
        if (!j) return false
        const outDir = j.out ?? join(jobDir(this.dir, j.id), 'out')
        if (out && out.length > 0) unpack(out, outDir)
        const next: JobInfo = { ...j, status: r.status, ended: this.iso() }
        delete next.lease
        delete next.leaseUntil
        if (r.exit !== undefined) next.exit = r.exit
        if (r.output) next.output = r.output
        if (r.error) next.error = r.error
        const outputs = (r.outputs ?? []).map((p) => resolve(outDir, p))
        if (outputs.length > 0) next.outputs = outputs
        writeJob(this.dir, next)
        appendLog(this.dir, j.id, { kind: 'end', status: r.status, exit: r.exit ?? null, worker: name, output: r.output, outputs, ...(r.ms !== undefined ? { ms: r.ms } : {}) })
        this.sweepParentsLocked()
        return true
      }),
    ).then(async (ok) => {
      if (ok) await this.dispatch()
      return ok
    })
  }

  /**
   * Машина вернула задачу: предохранитель (`guard`) — без траты попытки (§3, §7);
   * `pause` — тоже; прочее — как потеря машины.
   */
  giveBack(name: string, id: string, lease: string, reason: 'guard' | 'pause' | 'error' = 'guard'): Promise<boolean> {
    return this.serial(() =>
      withLock(this.dir, () => {
        const j = this.current(name, id, lease)
        if (!j) return false
        const attempt = (j.attempt ?? 0) + (reason === 'error' ? 1 : 0)
        const next: JobInfo = { ...j, status: 'queued', attempt, tried: [...(j.tried ?? []), name] }
        delete next.lease
        delete next.leaseUntil
        delete next.started
        if (j.cancel) {
          next.status = 'cancelled'
          next.ended = this.iso()
        } else if (attempt > (j.retries ?? DEFAULT_RETRIES)) {
          next.status = 'lost'
          next.ended = this.iso()
        }
        writeJob(this.dir, next)
        appendLog(this.dir, id, { kind: 'return', status: next.status, worker: name, reason })
        return true
      }),
    ).then(async (ok) => {
      if (ok) await this.dispatch()
      return ok
    })
  }

  pkg(sha: string): Buffer | null {
    return readPkg(this.dir, sha)
  }

  // --- шарды (§8) ---

  /** Родители шардов: прогресс, отмена, склейка, итог. Вызывать под замком. */
  private sweepParentsLocked(): void {
    const jobs = this.poolJobs()
    const kids = new Map<string, JobInfo[]>()
    for (const j of jobs) if (j.parent) (kids.get(j.parent) ?? kids.set(j.parent, []).get(j.parent)!).push(j)
    for (const p of jobs) {
      if (p.shards === undefined || FINAL.has(p.status)) continue
      const all = kids.get(p.id) ?? []
      const shards = all.filter((k) => k.shard !== undefined).sort((a, b) => (a.shard ?? 0) - (b.shard ?? 0))
      const merge = p.mergeJob ? all.find((k) => k.id === p.mergeJob) : undefined
      const done = shards.filter((k) => k.status === 'done').length
      let next: JobInfo = p.shardsDone !== done ? { ...p, shardsDone: done } : p

      if (p.cancel) {
        for (const k of [...shards, ...(merge ? [merge] : [])]) {
          if (FINAL.has(k.status)) continue
          if (k.status === 'queued') {
            writeJob(this.dir, { ...k, status: 'cancelled', ended: this.iso() })
            appendLog(this.dir, k.id, { kind: 'end', status: 'cancelled' })
          } else if (!k.cancel) {
            writeJob(this.dir, { ...k, cancel: this.iso() })
            appendLog(this.dir, k.id, { kind: 'cancel' })
          }
        }
        const live = [...shards, ...(merge ? [merge] : [])].some((k) => !FINAL.has(readJob(this.dir, k.id)?.status ?? 'failed'))
        if (!live) next = this.endParent(next, 'cancelled')
      } else if (merge && FINAL.has(merge.status)) {
        next = this.endParent(next, merge.status, merge)
      } else if (!merge) {
        const bad = shards.find((k) => FINAL.has(k.status) && k.status !== 'done')
        if (bad) {
          next = this.endParent(next, 'failed', undefined, `шард ${bad.shard ?? '?'} (${bad.id}): ${bad.status}${bad.error ? ` — ${bad.error}` : ''}`)
        } else if (shards.length > 0 && done === shards.length) {
          if (p.merge) next = this.startMerge(next, shards)
          else {
            const outputs = shards.flatMap((k) => k.outputs ?? [])
            next = this.endParent({ ...next, ...(outputs.length ? { outputs } : {}) }, 'done')
          }
        }
      }
      if (next !== p) writeJob(this.dir, next)
    }
  }

  private endParent(p: JobInfo, status: JobStatus, from?: JobInfo, error?: string): JobInfo {
    const next: JobInfo = { ...p, status, ended: this.iso() }
    if (from?.output) next.output = from.output
    if (from?.outputs) next.outputs = from.outputs
    if (from?.exit !== undefined) next.exit = from.exit
    const err = error ?? from?.error
    if (err) next.error = err
    appendLog(this.dir, p.id, { kind: 'end', status, ...(from ? { merge_job: from.id } : {}) })
    return next
  }

  /** Все шарды готовы — задача склейки, её `inputs/` — `shard-<i>/` с выходами шардов. */
  private startMerge(p: JobInfo, shards: JobInfo[]): JobInfo {
    const id = newJobId(new Date(this.clock()))
    const stage = join(jobDir(this.dir, p.id), 'merge-inputs')
    rmSync(stage, { recursive: true, force: true })
    mkdirSync(stage, { recursive: true })
    for (const k of shards) {
      const from = k.out ?? join(jobDir(this.dir, k.id), 'out')
      const to = join(stage, `shard-${k.shard ?? 0}`)
      if (existsSync(from)) cpSync(from, to, { recursive: true })
      else mkdirSync(to, { recursive: true })
    }
    const inputs = putPkg(this.dir, 'inputs', pack(stage))
    const code = packCode(p.merge!, resolve(p.merge!, '..'))
    const job: JobInfo = {
      id,
      title: `${p.title} · склейка`,
      target: p.merge!,
      cwd: resolve(p.merge!, '..'),
      keys: [recipeName(p.merge!)],
      values: p.out ? { out: p.out } : {},
      status: 'queued',
      created: this.iso(),
      pool: true,
      parent: p.id,
      pkgs: [putPkg(this.dir, 'code', code), inputs],
      entry: code.entry,
      entryCwd: code.cwd,
      retries: p.retries ?? DEFAULT_RETRIES,
    }
    if (p.out) job.out = p.out
    if (code.dirty) job.dirty = true
    if (p.needs?.host) job.needs = { host: p.needs.host }
    writeJob(this.dir, job)
    appendLog(this.dir, id, { kind: 'queued', status: 'queued', keys: job.keys, parent: p.id })
    appendLog(this.dir, p.id, { kind: 'merge', merge_job: id })
    return { ...p, mergeJob: id }
  }
}
