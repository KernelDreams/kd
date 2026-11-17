/**
 * `@kerneldreams/runz-run/jobs` — задачи: долгие runz-прогоны вне окна (jobs-spec §1–§3).
 *
 * Задача = один запуск runz в отдельном процессе, который переживает окно, фронт
 * и рестарт бэкенда. Реестр — файлы `~/.runz/jobs/<id>/` ({@link jobsDir}); любой
 * процесс (стенд, CLI, артефакт) видит одно и то же.
 *
 * ```ts
 * const job = await start({ target: 'fix-core.mdz', values: { source: url, out: 'elena' } })
 * for await (const f of attach(job.id)) console.log(f.text)
 * ```
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, statSync, symlinkSync, watch, writeFileSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import type { TemplateValues } from '../template.js'
import { isDocTarget, loadJobsConfig, recipeAttrs, recipeName } from './recipe.js'
import { pack, packCode } from '../pool/pack.js'
import { putPkg } from '../pool/store.js'
import { DEFAULT_RETRIES } from '../pool/center.js'
import type { Needs } from '../pool/types.js'
import {
  appendLog,
  FINAL,
  inputsDir,
  jobsDir,
  lastLine,
  listIds,
  newJobId,
  pidAlive,
  readJob,
  readLog,
  traceOf,
  withLock,
  writeJob,
} from './registry.js'
import type { JobFrame, JobInfo, JobStatus, LogCursor } from './registry.js'
import { launch, signalGroup, tick, type RunnerOpts } from './scheduler.js'

export { jobsDir, parseJob, serializeJob, readLog, isJobId, JOB_STATUSES } from './registry.js'
export type { JobFrame, JobInfo, JobStatus, LogCursor } from './registry.js'
export { loadJobsConfig, recipeAttrs, parseDuration, DEFAULT_MAX, type JobsConfig, type RecipeAttrs } from './recipe.js'
export { scheduler, tick, fits, type RunnerOpts, type Scheduler, type TickResult } from './scheduler.js'
export { resolveInputs } from './wrap.js'

/** Вход задачи (jobs-spec §1 «Входы»): файл путём, байтами или текстом. */
export interface JobFile {
  /** Имя в `inputs/` — его видят значения (`inputs/<name>`). */
  name: string
  /** Путь к файлу: копируется при постановке (исходник можно удалить). */
  path?: string
  /** Байты (base64-строка или буфер): вставка из буфера, загрузка формы. */
  bytes?: string | Uint8Array
  /** Длинный текст файлом. */
  text?: string
  /** С `path`: не копировать, а сослаться (симлинк) — большой файл, который никуда не денется. */
  link?: boolean
}

export interface StartOpts extends RunnerOpts {
  /** Путь к документу runz (.md/.mdz, относительный — от `cwd`) или имя appz; с `cmd` — не нужен. */
  target?: string
  /** Команда оболочки вместо runz: `sh -c <cmd>` в `cwd`; ключ лимитов по умолчанию — `sh`, в пул не идёт. */
  cmd?: string
  values?: TemplateValues
  /** Рабочий каталог runz; default — каталог документа (appz — `process.cwd()`). */
  cwd?: string
  /** Ключи лимитов; default — `$job_keys` рецепта, иначе имя рецепта. */
  keys?: string[]
  title?: string
  files?: JobFile[]
  /** Мимо очереди и лимитов — сразу (`runz job start --now` без стенда). */
  now?: boolean
  /** В пул машин (compute-pool-spec); default — `$jobs: {pool: true}` конфига, `on`/`shards` — тоже в пул. */
  pool?: boolean
  /** Что нужно задаче поверх `$needs` рецепта (§4). */
  needs?: Needs
  /** Прибить к машине на этот запуск (`--on=carol`). */
  on?: string
  /** Порезать на N шардов (`--shards=N`, §8) поверх `$shards` рецепта. */
  shards?: number
  /** Попыток на потерю машины поверх `$retries` (явное решение — и для задачи без `$repeatable`). */
  retries?: number
  /** Задача повторяема (поверх `$repeatable` рецепта). */
  repeatable?: boolean
}

/** Задача для показа: + последняя строка вывода (колонка «шаг»). */
export type JobView = JobInfo & { last?: string }

const SAFE_NAME = /^[^/\\\0]+$/

function writeInputs(dir: string, id: string, files: JobFile[]): void {
  if (files.length === 0) return
  const base = inputsDir(dir, id)
  mkdirSync(base, { recursive: true })
  for (const f of files) {
    const name = basename(String(f.name ?? ''))
    if (!SAFE_NAME.test(name) || name === '.' || name === '..') throw new Error(`jobs: плохое имя входа "${String(f.name)}"`)
    const to = resolve(base, name)
    if (f.path !== undefined) {
      const from = resolve(f.path)
      if (!existsSync(from) || !statSync(from).isFile()) throw new Error(`jobs: входа нет: ${f.path}`)
      if (f.link) symlinkSync(from, to)
      else copyFileSync(from, to)
    } else if (f.bytes !== undefined) {
      writeFileSync(to, typeof f.bytes === 'string' ? Buffer.from(f.bytes, 'base64') : f.bytes)
    } else if (f.text !== undefined) {
      writeFileSync(to, f.text)
    } else {
      throw new Error(`jobs: вход "${name}" без path/bytes/text`)
    }
  }
}

/** Заголовок по умолчанию: имя бота, папка прогона, хвост источника, имя рецепта. */
function defaultTitle(target: string, values: TemplateValues): string {
  const s = (k: string): string | undefined => {
    const v = values[k]
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
  }
  const src = s('source')
  const tail = src && !src.includes('\n') ? src.replace(/[?#].*$/, '').replace(/\/+$/, '').split(/[/\\]/).pop() : undefined
  const out = s('out')?.replace(/[/\\]+$/, '').split(/[/\\]/).pop()
  return s('title') ?? s('name') ?? out ?? tail ?? recipeName(target)
}

/** Поставить задачу: пишет `queued` и делает проход планировщика (стартует, если есть слот). */
export async function start(opts: StartOpts): Promise<JobInfo> {
  const dir = jobsDir(opts.dir)
  const cwd0 = resolve(opts.cwd ?? process.cwd())
  if (opts.cmd !== undefined) return startCmd(dir, cwd0, opts.cmd, opts)
  if (!opts.target) throw new Error('jobs: нет target (документ runz или appz) и нет cmd')
  const asPath = resolve(cwd0, opts.target)
  const doc = isDocTarget(asPath)
  if (!doc && (opts.target.includes('/') || /\.mdz?$/i.test(opts.target))) throw new Error(`jobs: документа нет: ${opts.target}`)
  const target = doc ? asPath : opts.target
  const cwd = opts.cwd ? cwd0 : doc ? resolve(asPath, '..') : cwd0
  const values = opts.values ?? {}
  const attrs = recipeAttrs(target, values)
  const outVal = typeof values.out === 'string' && values.out !== '' ? values.out : attrs.out
  const id = newJobId()
  const job: JobInfo = {
    id,
    title: opts.title?.trim() || defaultTitle(target, values),
    target,
    cwd,
    keys: opts.keys?.length ? opts.keys : (attrs.keys ?? [recipeName(target)]),
    values,
    status: 'queued',
    created: new Date().toISOString(),
  }
  if (outVal) job.out = isAbsolute(outVal) ? outVal : resolve(cwd, outVal)
  if (attrs.timeoutMs !== undefined) job.timeoutMs = attrs.timeoutMs

  mkdirSync(dir, { recursive: true })
  writeInputs(dir, id, opts.files ?? [])

  const shards = opts.shards ?? attrs.shards
  const toPool = opts.pool ?? (opts.on !== undefined || shards !== undefined || (opts.config ?? loadJobsConfig()).pool)
  if (toPool && !opts.now) return startPool(dir, job, opts, attrs, shards, doc)

  if (opts.now) return enqueueNow(dir, job, opts.runz)
  writeJob(dir, job)
  appendLog(dir, id, { kind: 'queued', status: 'queued', keys: job.keys })
  await tick(opts)
  return readJob(dir, id) ?? job
}

/**
 * `now`: постановка и запуск одной критической секцией. Иначе резидентный
 * планировщик (fs-watch реестра) успевал увидеть `queued` и запустить задачу, а
 * следом её запускал и `now` — две обёртки на одну задачу (10.11).
 */
function enqueueNow(dir: string, job: JobInfo, runz?: string[]): Promise<JobInfo> {
  return withLock(dir, () => {
    const cur = readJob(dir, job.id)
    if (cur && cur.status !== 'queued') return cur
    if (!cur) {
      writeJob(dir, job)
      appendLog(dir, job.id, { kind: 'queued', status: 'queued', keys: job.keys })
    }
    return launch(dir, cur ?? job, runz)
  })
}

/** Задача-команда: `sh -c <cmd>` в `cwd`, без рецепта и пула. */
async function startCmd(dir: string, cwd: string, cmd: string, opts: StartOpts): Promise<JobInfo> {
  if (!cmd.trim()) throw new Error('jobs: пустая команда')
  const id = newJobId()
  const first = cmd.trim().split('\n')[0]!
  const job: JobInfo = {
    id,
    title: opts.title?.trim() || (first.length > 80 ? `${first.slice(0, 79)}…` : first),
    target: 'sh',
    cmd,
    cwd,
    keys: opts.keys?.length ? opts.keys : ['sh'],
    values: {},
    status: 'queued',
    created: new Date().toISOString(),
  }
  mkdirSync(dir, { recursive: true })
  writeInputs(dir, id, opts.files ?? [])
  if (opts.now) return enqueueNow(dir, job, opts.runz)
  writeJob(dir, job)
  appendLog(dir, id, { kind: 'queued', status: 'queued', keys: job.keys })
  await tick(opts)
  return readJob(dir, id) ?? job
}

/**
 * Постановка в пул (compute-pool-spec §4, §6, §8): код и входы — пакетами по
 * хэшу, задача ждёт центр. Шарды — родитель (`running`, без машины) и N дочерних
 * `queued`, у каждой своя папка прогона `<задача>/out`.
 */
async function startPool(
  dir: string,
  base: JobInfo,
  o: StartOpts,
  attrs: ReturnType<typeof recipeAttrs>,
  shards: number | undefined,
  doc: boolean,
): Promise<JobInfo> {
  // Повтор после потери машины — только у повторяемой задачи (kd-cli-spec §11); иначе ноль попыток,
  // если постановщик не решил иначе флагом (`retries`).
  const repeatable = o.repeatable ?? attrs.repeatable ?? false
  const job: JobInfo = { ...base, pool: true, retries: o.retries ?? (repeatable ? (attrs.retries ?? DEFAULT_RETRIES) : 0), ...(repeatable ? { repeatable: true } : {}) }
  const needs: Needs = { ...(attrs.needs ?? {}), ...(o.needs ?? {}) }
  if (o.on) needs.host = o.on
  if (Object.keys(needs).length > 0) job.needs = needs
  const pkgs: string[] = []
  if (doc) {
    const code = packCode(job.target, job.cwd)
    pkgs.push(putPkg(dir, 'code', code))
    job.entry = code.entry
    job.entryCwd = code.cwd
    if (code.dirty) job.dirty = true
  }
  const inputs = inputsDir(dir, job.id)
  if (existsSync(inputs)) pkgs.push(putPkg(dir, 'inputs', pack(inputs)))
  if (pkgs.length > 0) job.pkgs = pkgs

  if (!shards) {
    writeJob(dir, job)
    appendLog(dir, job.id, { kind: 'queued', status: 'queued', keys: job.keys, pool: true })
    return job
  }
  const parent: JobInfo = { ...job, status: 'running', started: new Date().toISOString(), shards, shardsDone: 0 }
  delete parent.pkgs
  if (attrs.merge) parent.merge = attrs.merge
  writeJob(dir, parent)
  appendLog(dir, job.id, { kind: 'queued', status: 'running', keys: job.keys, shards })
  for (let i = 0; i < shards; i++) {
    const kid: JobInfo = { ...job, id: newJobId(), title: `${job.title} · шард ${i + 1}/${shards}`, created: new Date().toISOString(), shard: i, parent: job.id }
    // Шарды пишут свой `out/`; итог родителя — выход склейки в его папку прогона.
    delete kid.out
    const values = { ...kid.values }
    delete values.out
    kid.values = values
    writeJob(dir, kid)
    appendLog(dir, kid.id, { kind: 'queued', status: 'queued', keys: kid.keys, parent: job.id, shard: i })
  }
  return parent
}

/** Показ статуса: `running` с мёртвым процессом — `lost` (запишет проход планировщика). */
function view(dir: string, j: JobInfo): JobView {
  const v: JobView = j.status === 'running' && !j.pool && !pidAlive(j.pid) ? { ...j, status: j.cancel ? 'cancelled' : 'lost' } : { ...j }
  const last = lastLine(dir, j.id)
  if (last !== undefined) v.last = last
  // Идущая задача: след уже пишется — путь из указателя.
  if (!v.trace) {
    const trace = traceOf(dir, j.id)
    if (trace) v.trace = trace
  }
  return v
}

export interface ListOpts {
  dir?: string
  status?: JobStatus | JobStatus[]
  /** Только задачи этого документа (абсолютный путь) или appz. */
  target?: string
  /** Не больше N последних. */
  limit?: number
}

/** Задачи, новые первыми. */
export function list(opts: ListOpts = {}): JobView[] {
  const dir = jobsDir(opts.dir)
  const want = opts.status === undefined ? null : new Set(Array.isArray(opts.status) ? opts.status : [opts.status])
  const target = opts.target === undefined ? undefined : isDocTarget(opts.target) ? resolve(opts.target) : opts.target
  const out: JobView[] = []
  for (const id of listIds(dir).reverse()) {
    const j = readJob(dir, id)
    if (!j) continue
    if (target !== undefined && j.target !== target) continue
    const v = view(dir, j)
    if (want && !want.has(v.status)) continue
    out.push(v)
    if (opts.limit !== undefined && out.length >= opts.limit) break
  }
  return out
}

export function get(id: string, opts: { dir?: string } = {}): JobView | null {
  const dir = jobsDir(opts.dir)
  const j = readJob(dir, id)
  return j ? view(dir, j) : null
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((r) => {
    const t = setTimeout(r, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      r()
    }, { once: true })
  })

/**
 * Кадры лога с номера `from` (хвост `log.ndjson`), потом живые — до конца задачи
 * или `signal`. Подключиться можно в любой момент из любого процесса.
 */
export async function* attach(
  id: string,
  opts: { dir?: string; from?: number; signal?: AbortSignal; pollMs?: number } = {},
): AsyncGenerator<JobFrame> {
  const dir = jobsDir(opts.dir)
  if (!readJob(dir, id)) throw new Error(`jobs: нет задачи ${id}`)
  let cursor: LogCursor = { offset: 0, n: 0 }
  const from = opts.from ?? 0
  let wake: (() => void) | null = null
  let watcher: ReturnType<typeof watch> | null = null
  try {
    watcher = watch(resolve(dir, id), { persistent: false }, () => wake?.())
  } catch {
    watcher = null
  }
  try {
    for (;;) {
      const r = readLog(dir, id, from, cursor)
      cursor = r.cursor
      for (const f of r.frames) yield f
      if (opts.signal?.aborted) return
      const j = readJob(dir, id)
      const status = j ? view(dir, j).status : 'lost'
      if (FINAL.has(status)) {
        // Последние строки могли дописаться между чтением лога и статуса.
        const tail = readLog(dir, id, from, cursor)
        for (const f of tail.frames) yield f
        return
      }
      await Promise.race([
        sleep(opts.pollMs ?? 500, opts.signal),
        new Promise<void>((res) => {
          wake = res
        }),
      ])
      wake = null
    }
  } finally {
    watcher?.close()
  }
}

/**
 * Отмена: `queued` — сразу `cancelled`; `running` — SIGTERM группе обёртки (она
 * закончит `cancelled`, runz через 10 с добьётся SIGKILL). Ждёт конца до `waitMs`
 * (default 3 с) и делает проход планировщика: слот освобождён — следующая стартует.
 */
export async function cancel(id: string, opts: RunnerOpts & { waitMs?: number } = {}): Promise<JobView | null> {
  const dir = jobsDir(opts.dir)
  const j = await withLock(dir, () => {
    const job = readJob(dir, id)
    if (!job || FINAL.has(job.status)) return job
    const at = new Date().toISOString()
    if (job.status === 'queued') {
      const next: JobInfo = { ...job, status: 'cancelled', ended: at }
      writeJob(dir, next)
      appendLog(dir, id, { kind: 'end', status: 'cancelled' })
      return next
    }
    const next: JobInfo = { ...job, cancel: job.cancel ?? at }
    writeJob(dir, next)
    appendLog(dir, id, { kind: 'cancel' })
    signalGroup(job.pid, 'SIGTERM')
    return next
  })
  if (!j) return null
  if (FINAL.has(j.status)) return view(dir, j)
  const deadline = Date.now() + (opts.waitMs ?? 3_000)
  while (Date.now() < deadline) {
    const cur = get(id, { dir })
    if (!cur || FINAL.has(cur.status)) break
    await sleep(50)
  }
  // Обёртка, убитая до своих обработчиков, прохода не сделает — сделаем за неё.
  await tick(opts).catch(() => undefined)
  return get(id, { dir })
}

/** Новая задача с теми же target/values/cwd/keys и копией `inputs/` — рецепт идемпотентен, продолжит с места. */
export async function restart(id: string, opts: RunnerOpts & { now?: boolean } = {}): Promise<JobInfo> {
  const dir = jobsDir(opts.dir)
  const old = readJob(dir, id)
  if (!old) throw new Error(`jobs: нет задачи ${id}`)
  const nid = newJobId()
  const job: JobInfo = {
    id: nid,
    title: old.title,
    target: old.target,
    ...(old.cmd !== undefined ? { cmd: old.cmd } : {}),
    cwd: old.cwd,
    keys: old.keys,
    values: old.values,
    status: 'queued',
    created: new Date().toISOString(),
    restartOf: id,
  }
  if (old.out) job.out = old.out
  if (old.timeoutMs !== undefined) job.timeoutMs = old.timeoutMs
  if (old.pool && old.shards === undefined) {
    job.pool = true
    for (const k of ['needs', 'retries', 'pkgs', 'entry', 'entryCwd', 'dirty', 'shard', 'parent'] as const) {
      if (old[k] !== undefined) (job as unknown as Record<string, unknown>)[k] = old[k]
    }
  }
  const from = inputsDir(dir, id)
  mkdirSync(resolve(dir, nid), { recursive: true })
  if (existsSync(from)) cpSync(from, inputsDir(dir, nid), { recursive: true, verbatimSymlinks: true })
  writeJob(dir, job)
  appendLog(dir, nid, { kind: 'queued', status: 'queued', keys: job.keys, restart_of: id })
  if (job.pool) return job
  // Запись уже видна планировщику: запускаем, только если он не успел (иначе две обёртки).
  if (opts.now) return enqueueNow(dir, job, opts.runz)
  await tick(opts)
  return readJob(dir, nid) ?? job
}
