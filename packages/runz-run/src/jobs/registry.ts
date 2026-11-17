/**
 * Реестр задач на диске (jobs-spec §1): `<jobs>/<id>/job.mdz` + `log.ndjson` +
 * `inputs/`. Файл — единственная правда: процессы (стенд, CLI, обёртка задачи)
 * не делят памяти, правка любого `job.mdz` — под замком `<jobs>/.lock`.
 *
 * `job.mdz` читает человек (nrlib/CLAUDE.md «файлы читает человек»): шапка —
 * короткие машинные атрибуты, значения запуска и тексты (итог, ошибка) — блоками.
 */

import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { asText, isArray, parseDocument } from '@kerneldreams/nrd'
import type { IArray, IContext } from '@kerneldreams/nrd'
import { nrdString, valueBlock, type TemplateValue, type TemplateValues } from '../template.js'
import { formatNeeds, parseNeeds, type Needs } from '../pool/types.js'

export const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled', 'lost'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]
export const FINAL: ReadonlySet<JobStatus> = new Set(['done', 'failed', 'cancelled', 'lost'])

export interface JobInfo {
  /** Сортируемый по времени: `20261008-143012-a1b2`. */
  id: string
  title: string
  /** Путь к документу runz (.md/.mdz) или имя appz; у задачи-команды — `sh`. */
  target: string
  /** Команда оболочки вместо runz (`job_start` агента): `sh -c <cmd>` в `cwd`, конец — по коду выхода. */
  cmd?: string
  cwd: string
  keys: string[]
  values: TemplateValues
  status: JobStatus
  created: string
  started?: string
  ended?: string
  /** pid обёртки `job-wrap` — лидера группы процессов задачи. */
  pid?: number
  /** pid процесса runz (своя группа процессов внутри обёртки). */
  child?: number
  exit?: number | null
  /** Папка прогона (значение `out` относительно `cwd`), если рецепт её объявил. */
  out?: string
  /** Таймаут, мс (`$job_timeout` рецепта); нет — без таймаута. */
  timeoutMs?: number
  /** Задача, перезапуском которой создана эта. */
  restartOf?: string
  /** Запрошена отмена (время) — обёртка закончит `cancelled`. */
  cancel?: string
  /** Сколько раз задача поднималась из `lost` (`resume_lost`). */
  resumed?: number
  /** Итог runz (`ScriptResult.output`). */
  output?: string
  /** Пути `ScriptResult.outputs` (картинки, файлы). */
  outputs?: string[]
  /**
   * След прогона `run.trace.jsonl` (pipeline-run-spec §2.1): runz пишет его в `out` рецепта
   * и кладёт путь в `<задача>/trace.path` (`RUNZ_TRACE_POINTER`); у идущей задачи — из указателя (`view`).
   */
  trace?: string
  /** Причина отказа: хвост stderr, таймаут. */
  error?: string

  // --- пул машин (compute-pool-spec) ---
  /** Задачу раздаёт центр пула, а не планировщик машины. */
  pool?: boolean
  /** Что нужно задаче (§4). */
  needs?: Needs
  /** Попыток на потерю машины (§7, `$retries`, default 2). */
  retries?: number
  /** Задача заявила `$repeatable`: потеря машины — повтор у следующего воркера; иначе — `lost`, повтор — флагом. */
  repeatable?: boolean
  /** Номер попытки (0 — первая). */
  attempt?: number
  /** Машина текущей (или последней) попытки. */
  worker?: string
  /** Токен аренды текущей попытки. */
  lease?: string
  leaseUntil?: string
  /** Машины прошлых попыток. */
  tried?: string[]
  /** Пакеты задачи по sha: код, входы. */
  pkgs?: string[]
  /** Документ и рабочий каталог внутри пакета кода. */
  entry?: string
  entryCwd?: string
  /** Код взят из рабочей копии с правками без коммита. */
  dirty?: boolean
  /** Шарды (§8): у родителя — сколько, у дочерней — её номер и родитель. */
  shards?: number
  shard?: number
  parent?: string
  /** Рецепт склейки (`$merge`) и поставленная задача склейки. */
  merge?: string
  mergeJob?: string
  /** Готовых шардов у родителя (`17/32`). */
  shardsDone?: number
}

/** Кадр `log.ndjson`. `n` — номер строки лога (для `attach({from})`). */
export interface JobFrame {
  n: number
  ts: string
  kind: 'queued' | 'start' | 'line' | 'end' | 'lost' | 'cancel' | 'resume' | 'lease' | 'expire' | 'return' | 'merge'
  stream?: 'stdout' | 'stderr'
  text?: string
  status?: JobStatus
  [key: string]: unknown
}

/** Каталог реестра: `RUNZ_JOBS_DIR` либо `~/.runz/jobs`. */
export function jobsDir(dir?: string): string {
  return dir ?? process.env.RUNZ_JOBS_DIR ?? join(homedir(), '.runz', 'jobs')
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

/** Время + случайный хвост: сортировка имён = порядок постановки. */
export function newJobId(now = new Date()): string {
  const d = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const t = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`
  return `${d}-${t}-${randomBytes(2).toString('hex')}`
}

export const jobDir = (dir: string, id: string): string => join(dir, id)
export const jobFile = (dir: string, id: string): string => join(dir, id, 'job.mdz')
export const logFile = (dir: string, id: string): string => join(dir, id, 'log.ndjson')
export const inputsDir = (dir: string, id: string): string => join(dir, id, 'inputs')

const ID_RE = /^\d{8}-\d{9}-[0-9a-f]{4}$/
export const isJobId = (id: string): boolean => ID_RE.test(id)

// --- job.mdz ---

/** Строка атрибута: короткое — как есть, со спецсимволами — quoted-скаляр NRD. */
function attr(key: string, value: string | number | boolean | string[] | null | undefined): string | null {
  if (value === undefined) return null
  if (value === null) return `$${key}: null`
  if (Array.isArray(value)) return `$${key}: $[${value.map(nrdString).join(', ')}]`
  if (typeof value !== 'string') return `$${key}: ${String(value)}`
  return `$${key}: ${nrdString(value)}`
}

/** Текст блока: строки, похожие на заголовок NRD, не должны ломать документ. */
const blockBody = (text: string): string =>
  text
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => (/^#{1,6} /.test(l) || /^\$\$?[\w[]/.test(l) ? ' ' + l : l))
    .join('\n')
    .trimEnd()

export function serializeJob(j: JobInfo): string {
  const head = [
    attr('id', j.id),
    attr('title', j.title),
    attr('status', j.status),
    attr('target', j.target),
    attr('cmd', j.cmd),
    attr('cwd', j.cwd),
    attr('keys', j.keys),
    attr('out', j.out),
    attr('created', j.created),
    attr('started', j.started),
    attr('ended', j.ended),
    attr('pid', j.pid),
    attr('child', j.child),
    attr('exit', j.exit),
    attr('timeout_ms', j.timeoutMs),
    attr('restart_of', j.restartOf),
    attr('cancel', j.cancel),
    attr('resumed', j.resumed),
    attr('outputs', j.outputs),
    attr('pool', j.pool),
    j.needs && Object.keys(j.needs).length > 0 ? `$needs: ${formatNeeds(j.needs)}` : null,
    attr('retries', j.retries),
    attr('repeatable', j.repeatable),
    attr('attempt', j.attempt),
    attr('worker', j.worker),
    attr('lease', j.lease),
    attr('lease_until', j.leaseUntil),
    attr('tried', j.tried),
    attr('pkgs', j.pkgs),
    attr('entry', j.entry),
    attr('entry_cwd', j.entryCwd),
    attr('dirty', j.dirty),
    attr('shards', j.shards),
    attr('shard', j.shard),
    attr('parent', j.parent),
    attr('merge', j.merge),
    attr('merge_job', j.mergeJob),
    attr('shards_done', j.shardsDone),
  ].filter((l): l is string => l !== null)
  const parts = [head.join('\n')]
  if (Object.keys(j.values).length > 0) parts.push(`## $values\n${valueBlock(j.values)}`)
  if (j.output) parts.push(`## $output\n${blockBody(j.output)}`)
  if (j.error) parts.push(`## $error\n${blockBody(j.error)}`)
  return parts.join('\n\n') + '\n'
}

/** Значение-строка из `job.mdz`: `\${` писатель ставил как opt-out — назад в литерал. */
const unescape = (s: string): string => s.replace(/\\\$\{/g, '${')

function scalarOf(v: unknown): TemplateValue | undefined {
  if (typeof v === 'number' || typeof v === 'boolean') return v
  const t = asText(v as never)
  return t === undefined ? undefined : unescape(t)
}

function listOf(v: unknown): string[] {
  if (!isArray(v as never)) {
    const t = asText(v as never)
    return t ? [unescape(t)] : []
  }
  const out: string[] = []
  for (const x of (v as IArray).iterate()) {
    const t = asText(x as never)
    if (t !== undefined) out.push(unescape(t))
  }
  return out
}

function blockText(doc: IContext, name: string): string | undefined {
  const b = doc.get([name])
  if (!isArray(b as never)) return undefined
  const first = (b as IArray).at(0) as IContext | undefined
  const t = first?.cast('text')
  return typeof t === 'string' && t !== '' ? t.split('\n').map((l) => (/^ (#{1,6} |\$)/.test(l) ? l.slice(1) : l)).join('\n') : undefined
}

export function parseJob(text: string): JobInfo {
  const doc = parseDocument(text, { sigil: '$' })
  const str = (k: string): string | undefined => {
    const v = scalarOf(doc.get([k]))
    return v === undefined ? undefined : String(v)
  }
  const num = (k: string): number | undefined => {
    const v = doc.get([k])
    if (typeof v === 'number') return v
    const n = Number(asText(v as never))
    return asText(v as never) !== undefined && Number.isFinite(n) ? n : undefined
  }
  const values: TemplateValues = {}
  const vb = doc.get(['values'])
  if (isArray(vb as never)) {
    const ctx = (vb as IArray).at(0) as IContext | undefined
    const keys = (ctx?.cast('keys') as string[] | undefined) ?? []
    for (const k of keys) {
      const v = ctx!.get([k])
      if (isArray(v as never)) {
        const items: TemplateValue[] = []
        for (const x of (v as IArray).iterate()) {
          const s = scalarOf(x)
          if (s !== undefined) items.push(s)
        }
        values[k] = items
      } else {
        const s = scalarOf(v)
        if (s !== undefined) values[k] = s
      }
    }
  }
  const status = str('status') as JobStatus | undefined
  const j: JobInfo = {
    id: str('id') ?? '',
    title: str('title') ?? '',
    target: str('target') ?? '',
    cwd: str('cwd') ?? '',
    keys: listOf(doc.get(['keys'])),
    values,
    status: status && (JOB_STATUSES as readonly string[]).includes(status) ? status : 'failed',
    created: str('created') ?? '',
  }
  const set = <K extends keyof JobInfo>(k: K, v: JobInfo[K] | undefined): void => {
    if (v !== undefined) j[k] = v
  }
  set('cmd', str('cmd'))
  set('out', str('out'))
  set('started', str('started'))
  set('ended', str('ended'))
  set('pid', num('pid'))
  set('child', num('child'))
  const exit = doc.get(['exit'])
  if (exit === null) j.exit = null
  else set('exit', num('exit'))
  set('timeoutMs', num('timeout_ms'))
  set('restartOf', str('restart_of'))
  set('cancel', str('cancel'))
  set('resumed', num('resumed'))
  const outputs = doc.get(['outputs'])
  if (outputs !== undefined) j.outputs = listOf(outputs)
  if (doc.get(['pool']) === true) j.pool = true
  const needs = parseNeeds(doc.get(['needs']))
  if (needs) j.needs = needs
  set('retries', num('retries'))
  if (doc.get(['repeatable']) === true || str('repeatable') === 'true') j.repeatable = true
  set('attempt', num('attempt'))
  set('worker', str('worker'))
  set('lease', str('lease'))
  set('leaseUntil', str('lease_until'))
  const tried = doc.get(['tried'])
  if (tried !== undefined) j.tried = listOf(tried)
  const pkgs = doc.get(['pkgs'])
  if (pkgs !== undefined) j.pkgs = listOf(pkgs)
  set('entry', str('entry'))
  set('entryCwd', str('entry_cwd'))
  if (doc.get(['dirty']) === true) j.dirty = true
  set('shards', num('shards'))
  set('shard', num('shard'))
  set('parent', str('parent'))
  set('merge', str('merge'))
  set('mergeJob', str('merge_job'))
  set('shardsDone', num('shards_done'))
  set('output', blockText(doc, 'output'))
  set('error', blockText(doc, 'error'))
  return j
}

export function readJob(dir: string, id: string): JobInfo | null {
  let text: string
  try {
    text = readFileSync(jobFile(dir, id), 'utf8')
  } catch {
    return null
  }
  const j = parseJob(text)
  // Каталог — источник id: человек мог поправить шапку.
  j.id = id
  return j
}

/** Атомарная запись: читатель (панель, CLI) не видит полупустого файла. */
export function writeJob(dir: string, j: JobInfo): void {
  mkdirSync(jobDir(dir, j.id), { recursive: true })
  const file = jobFile(dir, j.id)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, serializeJob(j))
  renameSync(tmp, file)
}

export function listIds(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter(isJobId)
      .sort()
  } catch {
    return []
  }
}

// --- log.ndjson ---

export function appendLog(dir: string, id: string, frame: Omit<JobFrame, 'n' | 'ts'> & { ts?: string }): void {
  const line = JSON.stringify({ ts: frame.ts ?? new Date().toISOString(), ...frame })
  appendFileSync(logFile(dir, id), line + '\n')
}

/** Позиция дочитки лога: байтовое смещение и номер строки на нём. */
export interface LogCursor {
  offset: number
  n: number
}

/** Кадры от курсора (номера `< from` пропускаются) и новый курсор. */
export function readLog(dir: string, id: string, from = 0, cursor: LogCursor = { offset: 0, n: 0 }): { frames: JobFrame[]; cursor: LogCursor } {
  const file = logFile(dir, id)
  let size: number
  try {
    size = statSync(file).size
  } catch {
    return { frames: [], cursor }
  }
  if (size <= cursor.offset) return { frames: [], cursor }
  const fd = openSync(file, 'r')
  const buf = Buffer.alloc(size - cursor.offset)
  try {
    readSync(fd, buf, 0, buf.length, cursor.offset)
  } finally {
    closeSync(fd)
  }
  // Хвост без \n — строка ещё пишется: дочитаем в следующий раз.
  const end = buf.lastIndexOf(10) + 1
  const frames: JobFrame[] = []
  let n = cursor.n
  for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
    if (line === '') continue
    if (n >= from) {
      try {
        frames.push({ ...(JSON.parse(line) as Omit<JobFrame, 'n'>), n } as JobFrame)
      } catch {
        frames.push({ n, ts: '', kind: 'line', stream: 'stdout', text: line })
      }
    }
    n++
  }
  return { frames, cursor: { offset: cursor.offset + end, n } }
}

/** Последняя строка вывода задачи — колонка «шаг» панели. */
export function lastLine(dir: string, id: string): string | undefined {
  const file = logFile(dir, id)
  let size: number
  try {
    size = statSync(file).size
  } catch {
    return undefined
  }
  const len = Math.min(size, 16 * 1024)
  const fd = openSync(file, 'r')
  const buf = Buffer.alloc(len)
  try {
    readSync(fd, buf, 0, len, size - len)
  } finally {
    closeSync(fd)
  }
  const lines = buf.toString('utf8').split('\n').reverse()
  for (const l of lines) {
    try {
      const f = JSON.parse(l) as JobFrame
      if (f.kind === 'line' && typeof f.text === 'string' && f.text.trim() !== '') return f.text
    } catch {
      // обрезанная первая строка окна
    }
  }
  return undefined
}

// --- замок ---

export function pidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM — процесс есть, но чужой.
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const LOCK_STALE_MS = 30_000
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Замок без ожидания: `true` — взят. Протухший (держатель мёртв или висит > 30 с) — снимается. */
export function tryLock(file: string): boolean {
  try {
    const fd = openSync(file, 'wx')
    writeFileSync(fd, `${process.pid}\n`)
    closeSync(fd)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  }
  try {
    const holder = Number(readFileSync(file, 'utf8').trim())
    const age = Date.now() - statSync(file).mtimeMs
    if ((holder && holder !== process.pid && !pidAlive(holder)) || age > LOCK_STALE_MS) rmSync(file, { force: true })
  } catch {
    // замок сняли между проверками
  }
  return false
}

/** Короткая критическая секция над реестром (`<jobs>/.lock`). */
export async function withLock<T>(dir: string, fn: () => T | Promise<T>): Promise<T> {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, '.lock')
  const deadline = Date.now() + LOCK_STALE_MS + 5_000
  while (!tryLock(file)) {
    if (Date.now() > deadline) throw new Error(`jobs: замок ${file} не отпускается`)
    await sleep(15 + Math.random() * 20)
  }
  try {
    return await fn()
  } finally {
    rmSync(file, { force: true })
  }
}

export const exists = existsSync

/** Файл-указатель следа прогона задачи: runz пишет сюда путь `run.trace.jsonl`. */
export const tracePointer = (dir: string, id: string): string => join(dir, id, 'trace.path')

/** Путь следа задачи из указателя; нет указателя или следа — `undefined`. */
export function traceOf(dir: string, id: string): string | undefined {
  try {
    const p = readFileSync(tracePointer(dir, id), 'utf8').trim()
    return p && existsSync(p) ? p : undefined
  } catch {
    return undefined
  }
}
