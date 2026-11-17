/**
 * Будильник хаба (nrchat.dev specs/wake-spec.md): отложенное без самоциклов в процессе агента.
 *
 * Запись `{id, session, prompt, when, status…}` — файлом `<dir>/<id>.json` (каталог данных контура,
 * переживает рестарт и релиз; несколько стендов контура видят одни записи). Проход раз в ~30 с
 * проверяет условия: `at` (время), `cron` (+tz), `job` (задача runz-run кончилась), `pid` (процесс
 * вышел), `file` (файл появился / в нём строка), `task` (статус задачи Projektor сменился) и
 * `timeout` условия; `task` с `on: 'verdict'` — вердикт приёмщика или обрыв (событие хоста задач
 * `taskEvent`,: проход его не проверяет, хост переводит записи в `pending` сам и кладёт
 * ход постановщику задачи — той же записью). Сработало — ход `⏰ <prompt>` + что сработало в сессию (`run`, безголовый)
 * и уведомление. Сессия занята — запись `pending`, ход доставит следующий проход. Процесс агента
 * будильник не держит: сессия гаснет по `$idle`, ход поднимет её resume движка.
 *
 * Стреляет только стенд с `fire` (хаб чатов: его `run` доходит до любого движка); остальные
 * стенды контура — только ставят, показывают и снимают записи (тулы их агентов).
 *
 * Сервис `wake` (`withWakeService`): `list` / `get` / `create` / `cancel` / `status` и
 * `tools` / `tool` — тулы агентам `wake_at`, `wake_on`, `wake_list`, `wake_cancel`, `job_start`,
 * `job_status` (на nr — backend-nr, на ACP — MCP `nr-tools`, на машинах — nr-mcp `$hub_services`).
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ProtocolBackend, ServiceEvent, ServicesCapability, ServicesHost } from '@kerneldreams/ui-protocol'

export const WAKE_SERVICE_ID = 'wake'
export const WAKE_DEFAULT_TZ = 'Europe/Warsaw'
/** Строк хвоста лога задачи в ходе будильника. */
export const WAKE_LOG_TAIL = 40
/** Сколько ход ждёт свободной сессии, прежде чем запись станет `failed`. */
const PENDING_MAX_MS = 24 * 3600_000
/** Сколько раз подряд пробовать доставку с не-«занятой» ошибкой. */
const DELIVER_ATTEMPTS = 5
/** Сколько байт конца файла читает условие `file` с `match`. */
const FILE_SCAN_BYTES = 1 << 20

// ── типы ────────────────────────────────────────────────────────────────────

export type WakeWhen =
  | { at: string }
  | { cron: string; tz?: string }
  | { job: string }
  | { pid: number }
  | { file: string; match?: string }
  | { task: string; on?: WakeTaskOn }

/**
 * На что смотрит `task`: `status` — смена статуса Projektor (по умолчанию, проход сверяет
 * статусы); `verdict` — вердикт приёмщика или обрыв задачи: событие шлёт хост задач (`taskEvent`).
 */
export type WakeTaskOn = 'status' | 'verdict'

export type WakeStatus = 'waiting' | 'pending' | 'fired' | 'timeout' | 'cancelled' | 'failed'
export const WAKE_STATUSES: readonly WakeStatus[] = ['waiting', 'pending', 'fired', 'timeout', 'cancelled', 'failed']
/** Записи, которые ещё что-то сделают. */
export const WAKE_LIVE: readonly WakeStatus[] = ['waiting', 'pending']

export interface WakeRecord {
  id: string
  /** Сессия, в которую придёт ход. */
  session: string
  prompt: string
  when: WakeWhen
  status: WakeStatus
  createdAt: string
  /** Кто поставил: `agent` (тул), `job_start`, `user` (UI), `api`. */
  createdBy?: string
  /** Подпись для списка: задача, файл… */
  title?: string
  /** `at` / `cron` — когда сработает (ISO). */
  next?: string
  /** Не дождался к этому времени — ход «не дождался». */
  timeoutAt?: string
  /** `task`: статус при постановке — срабатывает смена. */
  baseline?: string
  firedAt?: string
  /** `cron`: сколько раз сработал. */
  fires?: number
  /** Что сработало, одной строкой. */
  reason?: string
  /** Ход к доставке (`pending`). */
  message?: string
  pendingSince?: string
  /** Ход — «не дождался» (срок вышел), после доставки — `timeout`. */
  timedOut?: boolean
  attempts?: number
  error?: string
}

/** Задача runz-run глазами будильника (адаптер стенда над `@kerneldreams/runz-run/jobs`). */
export interface WakeJobView {
  id: string
  title?: string
  status: string
  exit?: number | null
  started?: string
  ended?: string
  error?: string
  /** Папка задачи (`~/.runz/jobs/<id>`). */
  dir?: string
  /** Файл лога. */
  log?: string
  cmd?: string
  cwd?: string
}

export interface WakeJobs {
  start(o: { cmd: string; cwd: string; title?: string }): Promise<WakeJobView>
  get(id: string): Promise<WakeJobView | null>
  /** Последние `n` строк вывода. */
  tail(id: string, n: number): Promise<string[]>
}

/** Конечные статусы задачи runz-run. */
export const JOB_FINAL = ['done', 'failed', 'cancelled', 'lost']

export interface WakeOptions {
  /** Каталог записей. */
  dir: string
  /** Стрелять (проход и доставка): только у стенда, чей `run` доходит до сессий (хаб). */
  fire?: boolean
  /** Бэкенд для хода (хаб); лениво — стенд собирает его после сервисов. */
  backend?: () => ProtocolBackend | undefined
  jobs?: WakeJobs
  /** Статусы задач пачкой (сервис `tasks`): ref → `{status}`. */
  taskStatus?: (refs: string[]) => Promise<Record<string, { status?: string } | undefined>>
  /** Уведомление человеку (Telegram). */
  notify?: (text: string) => Promise<void> | void
  /** Пояс по умолчанию для `cron` и «19:30». */
  tz?: string
  /** Период прохода, мс (30 с). */
  intervalMs?: number
  /** Каталог по умолчанию для `job_start` без `cwd`. */
  cwd?: string
  log?: (m: string) => void
  /** Часы (тесты). */
  now?: () => number
}

export interface WakeCreateInput {
  session: string
  prompt: string
  when: WakeWhen
  /** Срок ожидания: длительность («2h») или время (ISO). */
  timeout?: string
  title?: string
  createdBy?: string
}

export interface WakeTaskEvent {
  task: string
  /** Что случилось одной строкой: «принято — …». */
  reason: string
  /** Подробности хода ждущим (сессии исполнителя и приёмщика). */
  details?: string
  /** Постановщик: ход в эту сессию. */
  session?: string
  /** Текст хода постановщику целиком (иначе — из `reason`/`details`). */
  message?: string
  /** Кто шлёт (`createdBy`): `tasks`. */
  by?: string
}

export interface Wake {
  create(input: WakeCreateInput): Promise<WakeRecord>
  list(o?: { session?: string; all?: boolean }): WakeRecord[]
  get(id: string): WakeRecord | undefined
  cancel(id: string): WakeRecord
  /**
   * Событие задачи: вердикт приёмщика или обрыв. Ждущие `wake_on {task, on: 'verdict'}` —
   * в `pending`; `session` + `message` — ход постановщику (запись сразу `pending`, если эта сессия
   * не ждёт того же сама: один ход на событие). Доставит стреляющий стенд следующим проходом.
   * Возвращает id записей, которые пойдут ходом.
   */
  taskEvent(e: WakeTaskEvent): string[]
  /** Один проход: что сработало и что доставлено. */
  once(): Promise<{ triggered: string[]; delivered: string[] }>
  start(): void
  stop(): void
  readonly dir: string
  readonly fires: boolean
  /** Методы сервиса `wake`. */
  readonly methods: readonly string[]
  call(method: string, args: unknown): Promise<unknown>
}

// ── время ───────────────────────────────────────────────────────────────────

interface ZonedParts {
  y: number
  mo: number
  d: number
  h: number
  mi: number
  dow: number
}

const fmtCache = new Map<string, Intl.DateTimeFormat>()
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' })
    fmtCache.set(tz, f)
  }
  return f
}

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

export function zonedParts(ms: number, tz: string): ZonedParts {
  const p: Record<string, string> = {}
  for (const x of fmt(tz).formatToParts(new Date(ms))) p[x.type] = x.value
  return { y: +p.year!, mo: +p.month!, d: +p.day!, h: +p.hour! % 24, mi: +p.minute!, dow: DOW[p.weekday!] ?? 0 }
}

/** Настенное время пояса → UTC (мс). */
export function zonedTime(tz: string, y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s)
  const off = (ms: number): number => {
    const p = zonedParts(ms, tz)
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(ms / 60_000) * 60_000
  }
  let t = guess - off(guess)
  t = guess - off(t)
  return t
}

/** Проверить пояс: неизвестный — исключение. */
export function checkTz(tz: string): string {
  try {
    fmt(tz)
  } catch {
    throw new Error(`wake: неизвестный часовой пояс ${tz}`)
  }
  return tz
}

const UNIT_MS: Array<[RegExp, number]> = [
  [/^(d|д|дн|дня|дней|day|days)$/, 86_400_000],
  [/^(h|ч|час|часа|часов|hr|hrs|hour|hours)$/, 3_600_000],
  [/^(m|м|мин|минут|минуты|min|mins|minute|minutes)$/, 60_000],
  [/^(s|с|сек|секунд|секунды|sec|secs|second|seconds)$/, 1_000],
]

/** «2h», «1h30m», «90 мин», «через 2 ч», «+45s» → мс; не длительность — undefined. */
export function parseDuration(text: string): number | undefined {
  const t = text.trim().toLowerCase().replace(/^(через|in|\+)\s*/, '')
  if (!t) return undefined
  const re = /(\d+(?:[.,]\d+)?)\s*([a-zа-яё]+)/g
  // Весь текст — числа с единицами, без мусора между ними.
  if (t.replace(re, '').trim() !== '') return undefined
  let total = 0
  for (const m of t.matchAll(re)) {
    const unit = UNIT_MS.find(([r]) => r.test(m[2]!))
    if (!unit) return undefined
    total += parseFloat(m[1]!.replace(',', '.')) * unit[1]
  }
  return total > 0 ? Math.round(total) : undefined
}

/**
 * Время срабатывания: ISO (`2026-11-06T19:30Z`; без пояса — в `tz`), длительность («через 2h»,
 * «90m»), «19:30» / «завтра 09:00» (в `tz`, прошедшее сегодня — завтра).
 */
export function parseAt(text: string, tz: string, now: number): number {
  const t = String(text ?? '').trim()
  if (!t) throw new Error('wake: пустое время')
  const dur = parseDuration(t)
  if (dur !== undefined) return now + dur
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t)
  if (local) return zonedTime(tz, +local[1]!, +local[2]!, +local[3]!, +(local[4] ?? 0), +(local[5] ?? 0), +(local[6] ?? 0))
  const hm = /^(завтра|tomorrow)?\s*(?:в|at)?\s*(\d{1,2}):(\d{2})$/i.exec(t)
  if (hm) {
    const p = zonedParts(now, tz)
    let at = zonedTime(tz, p.y, p.mo, p.d, +hm[2]!, +hm[3]!)
    if (hm[1]) at = zonedTime(tz, p.y, p.mo, p.d + 1, +hm[2]!, +hm[3]!)
    else if (at <= now) at = zonedTime(tz, p.y, p.mo, p.d + 1, +hm[2]!, +hm[3]!)
    return at
  }
  const iso = Date.parse(t)
  if (Number.isFinite(iso) && /\d{4}-\d{2}-\d{2}/.test(t)) return iso
  throw new Error(`wake: не понял время «${t}» — ISO, «через 2h», «19:30»`)
}

// ── cron ────────────────────────────────────────────────────────────────────

interface CronSpec {
  min: Set<number>
  hour: Set<number>
  dom: Set<number>
  mon: Set<number>
  dow: Set<number>
  domAny: boolean
  dowAny: boolean
}

const CRON_ALIAS: Record<string, string> = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *' }

function cronField(text: string, lo: number, hi: number, name: string): Set<number> {
  const out = new Set<number>()
  for (const part of text.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim())
    if (!m) throw new Error(`wake: cron — плохое поле ${name}: «${text}»`)
    const step = m[4] ? +m[4] : 1
    const a = m[1] === '*' ? lo : +m[2]!
    const b = m[1] === '*' ? hi : m[3] !== undefined ? +m[3] : m[4] ? hi : a
    if (a < lo || b > hi || a > b || step < 1) throw new Error(`wake: cron — поле ${name} вне ${lo}–${hi}: «${text}»`)
    for (let v = a; v <= b; v += step) out.add(v)
  }
  return out
}

export function parseCron(expr: string): CronSpec {
  const e = CRON_ALIAS[expr.trim().toLowerCase()] ?? expr.trim()
  const f = e.split(/\s+/)
  if (f.length !== 5) throw new Error(`wake: cron — пять полей «мин час день месяц день_недели», а не «${expr}»`)
  const dow = cronField(f[4]!, 0, 7, 'день недели')
  if (dow.has(7)) dow.add(0)
  return { min: cronField(f[0]!, 0, 59, 'минута'), hour: cronField(f[1]!, 0, 23, 'час'), dom: cronField(f[2]!, 1, 31, 'день'), mon: cronField(f[3]!, 1, 12, 'месяц'), dow, domAny: f[2] === '*', dowAny: f[4] === '*' }
}

/** Следующее срабатывание cron строго после `after` (мс) в поясе `tz`. */
export function nextCron(expr: string, tz: string, after: number): number {
  const spec = parseCron(expr)
  let t = Math.floor(after / 60_000) * 60_000 + 60_000
  const limit = after + 400 * 86_400_000
  while (t < limit) {
    const p = zonedParts(t, tz)
    const dayOk = spec.domAny && spec.dowAny ? true : spec.domAny ? spec.dow.has(p.dow) : spec.dowAny ? spec.dom.has(p.d) : spec.dom.has(p.d) || spec.dow.has(p.dow)
    if (!spec.mon.has(p.mo) || !dayOk) {
      t += (60 - p.mi) * 60_000 // к следующему часу: смена дня в любом поясе — на границе часа
      continue
    }
    if (!spec.hour.has(p.h)) {
      t += (60 - p.mi) * 60_000
      continue
    }
    if (!spec.min.has(p.mi)) {
      t += 60_000
      continue
    }
    return t
  }
  throw new Error(`wake: cron «${expr}» не срабатывает за год`)
}

// ── формат ──────────────────────────────────────────────────────────────────

/** «19:30» сегодня, «пт 19:30», иначе дата — для списков и подписей. */
export function shortTime(ms: number, tz: string, now: number): string {
  const p = zonedParts(ms, tz)
  const n = zonedParts(now, tz)
  const hm = `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`
  if (p.y === n.y && p.mo === n.mo && p.d === n.d) return hm
  if (Math.abs(ms - now) < 6 * 86_400_000) return `${['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][p.dow]} ${hm}`
  return `${String(p.d).padStart(2, '0')}.${String(p.mo).padStart(2, '0')} ${hm}`
}

/** Условие одной строкой. */
export function describeWhen(r: Pick<WakeRecord, 'when' | 'next' | 'title'>, tz: string, now: number): string {
  const w = r.when as Record<string, unknown>
  if ('at' in w) return r.next ? `в ${shortTime(Date.parse(r.next), tz, now)}` : `в ${String(w.at)}`
  if ('cron' in w) return `cron ${String(w.cron)}${w.tz ? ` (${String(w.tz)})` : ''}${r.next ? `, след. ${shortTime(Date.parse(r.next), tz, now)}` : ''}`
  if ('job' in w) return `конец задачи ${String(w.job)}${r.title ? ` «${r.title}»` : ''}`
  if ('pid' in w) return `выход процесса ${String(w.pid)}`
  if ('file' in w) return w.match ? `строка /${String(w.match)}/ в ${String(w.file)}` : `файл ${String(w.file)}`
  if ('task' in w) return w.on === 'verdict' ? `вердикт ${String(w.task)}` : `смена статуса ${String(w.task)}`
  return JSON.stringify(w)
}

function durationText(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} с`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} мин ${s % 60} с`
  return `${Math.floor(m / 60)} ч ${m % 60} мин`
}

// ── хранилище ───────────────────────────────────────────────────────────────

const ID_RE = /^w-[0-9a-z-]+$/

function newId(now: number): string {
  const d = new Date(now)
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `w-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}-${randomBytes(3).toString('hex')}`
}

function isWhen(v: unknown): v is WakeWhen {
  if (!v || typeof v !== 'object') return false
  const w = v as Record<string, unknown>
  return typeof w.at === 'string' || typeof w.cron === 'string' || typeof w.job === 'string' || typeof w.pid === 'number' || typeof w.file === 'string' || typeof w.task === 'string'
}

function readRecord(file: string): WakeRecord | undefined {
  try {
    const r = JSON.parse(readFileSync(file, 'utf8')) as WakeRecord
    if (!r || typeof r.id !== 'string' || typeof r.session !== 'string' || !isWhen(r.when) || !WAKE_STATUSES.includes(r.status)) return undefined
    return r
  } catch {
    return undefined
  }
}

function writeRecord(dir: string, r: WakeRecord): void {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${r.id}.json`)
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  writeFileSync(tmp, JSON.stringify(r, null, 2) + '\n')
  renameSync(tmp, file)
}

function tailText(file: string, bytes: number): string {
  const size = statSync(file).size
  const from = Math.max(0, size - bytes)
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(size - from)
    readSync(fd, buf, 0, buf.length, from)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const expandHome = (p: string): string => (p === '~' || p.startsWith('~/') ? join(process.env.HOME ?? '', p.slice(1)) : p)

/** Ошибка, после которой доставку стоит повторить: сессия занята, движок перезапускается, сеть. */
export function wakeTransient(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code
  if (code === 'busy' || code === 'engine_unavailable' || code === 'conflict') return true
  const text = `${(e as Error)?.message ?? ''} ${String((e as { cause?: { code?: unknown } })?.cause?.code ?? '')} ${String(code ?? '')}`
  return e instanceof TypeError || /busy|занят|fetch failed|ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|other side closed|недоступен/i.test(text)
}

function notFound(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code
  return code === 'not_found' || /not found|не найден|нет сессии/i.test((e as Error)?.message ?? '')
}

// ── будильник ───────────────────────────────────────────────────────────────

export function createWake(opts: WakeOptions): Wake {
  const dir = resolve(opts.dir)
  const tz = checkTz(opts.tz ?? WAKE_DEFAULT_TZ)
  const now = opts.now ?? Date.now
  const log = opts.log ?? (() => {})
  let timer: ReturnType<typeof setInterval> | undefined
  let running: Promise<{ triggered: string[]; delivered: string[] }> | undefined
  /** Сессии, ход которых сейчас доставляется (не слать второй, пока первый не начался). */
  const delivering = new Set<string>()

  function all(): WakeRecord[] {
    if (!existsSync(dir)) return []
    const out: WakeRecord[] = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const r = readRecord(join(dir, name))
      if (r) out.push(r)
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  }

  function get(id: string): WakeRecord | undefined {
    if (!ID_RE.test(id)) return undefined
    return readRecord(join(dir, `${id}.json`))
  }

  /** Перечитать и записать (другой стенд мог снять запись). */
  function update(id: string, patch: (r: WakeRecord) => WakeRecord | undefined): WakeRecord | undefined {
    const cur = get(id)
    if (!cur) return undefined
    const next = patch(cur)
    if (next) writeRecord(dir, next)
    return next
  }

  async function create(input: WakeCreateInput): Promise<WakeRecord> {
    const session = String(input.session ?? '').trim()
    if (!session) throw Object.assign(new Error('wake: нет сессии — куда слать ход'), { code: 'bad_request' })
    const prompt = String(input.prompt ?? '').trim()
    if (!prompt) throw Object.assign(new Error('wake: пустой prompt — что сказать агенту, когда сработает'), { code: 'bad_request' })
    if (!isWhen(input.when)) throw Object.assign(new Error('wake: условие — одно из at, cron, job, pid, file, task'), { code: 'bad_request' })
    const t = now()
    const when = { ...input.when } as WakeWhen
    const r: WakeRecord = { id: newId(t), session, prompt, when, status: 'waiting', createdAt: new Date(t).toISOString() }
    if (input.createdBy) r.createdBy = input.createdBy
    if (input.title) r.title = input.title
    if ('at' in when) r.next = new Date(parseAt(when.at, tz, t)).toISOString()
    else if ('cron' in when) {
      if (when.tz) checkTz(when.tz)
      r.next = new Date(nextCron(when.cron, when.tz ?? tz, t)).toISOString()
    } else if ('pid' in when) {
      if (!Number.isInteger(when.pid) || when.pid <= 0) throw Object.assign(new Error('wake: pid — целое > 0'), { code: 'bad_request' })
    } else if ('file' in when) {
      when.file = resolve(expandHome(when.file))
      if (when.match !== undefined) {
        try {
          new RegExp(when.match)
        } catch {
          throw Object.assign(new Error(`wake: плохой regex «${when.match}»`), { code: 'bad_request' })
        }
      }
    } else if ('job' in when) {
      const j = await opts.jobs?.get(when.job).catch(() => null)
      if (opts.jobs && !j) throw Object.assign(new Error(`wake: нет задачи ${when.job}`), { code: 'not_found' })
      if (j?.title && !r.title) r.title = j.title
    } else if ('task' in when) {
      when.task = when.task.trim().toUpperCase()
      if (when.on !== undefined && when.on !== 'status' && when.on !== 'verdict') throw Object.assign(new Error(`wake: on — status или verdict, не «${String(when.on)}»`), { code: 'bad_request' })
      if (when.on !== 'verdict') delete when.on
      const st = when.on === 'verdict' ? undefined : await opts.taskStatus?.([when.task]).catch(() => undefined)
      const s = st?.[when.task]?.status
      if (s) r.baseline = s
    }
    if (input.timeout) {
      const d = parseDuration(input.timeout)
      r.timeoutAt = new Date(d !== undefined ? t + d : parseAt(input.timeout, tz, t)).toISOString()
    }
    writeRecord(dir, r)
    log(`будильник ${r.id}: ${describeWhen(r, tz, t)} → сессия ${session}`)
    return r
  }

  function cancel(id: string): WakeRecord {
    const r = update(id, (cur) => (WAKE_LIVE.includes(cur.status) ? { ...cur, status: 'cancelled', firedAt: new Date(now()).toISOString() } : cur))
    if (!r) throw Object.assign(new Error(`wake: нет будильника ${id}`), { code: 'not_found' })
    return r
  }

  function list(o: { session?: string; all?: boolean } = {}): WakeRecord[] {
    return all().filter((r) => (!o.session || r.session === o.session) && (o.all || WAKE_LIVE.includes(r.status)))
  }

  // ── условия ──

  /** Сработало ли: текст «что сработало» и подробности хода; нет — undefined. */
  async function check(r: WakeRecord, t: number, statuses: Record<string, { status?: string } | undefined>): Promise<{ reason: string; details?: string } | undefined> {
    const w = r.when
    if ('at' in w || 'cron' in w) {
      if (r.next && Date.parse(r.next) <= t) return { reason: 'at' in w ? `время ${shortTime(Date.parse(r.next), tz, t)}` : `cron ${w.cron} (${shortTime(Date.parse(r.next), w.tz ?? tz, t)})` }
      return undefined
    }
    if ('pid' in w) return pidAlive(w.pid) ? undefined : { reason: `процесс ${w.pid} вышел` }
    if ('file' in w) {
      if (!existsSync(w.file)) return undefined
      if (w.match === undefined) return { reason: `файл появился: ${w.file}` }
      const re = new RegExp(w.match, 'm')
      const text = tailText(w.file, FILE_SCAN_BYTES)
      const m = re.exec(text)
      if (!m) return undefined
      const line = text.slice(text.lastIndexOf('\n', m.index) + 1).split('\n')[0]!.slice(0, 500)
      return { reason: `в ${w.file} есть /${w.match}/`, details: `строка: ${line}` }
    }
    if ('task' in w) {
      // Вердикт — событием хоста задач (`taskEvent`), не опросом.
      if (w.on === 'verdict') return undefined
      const s = statuses[w.task]?.status
      if (!s) return undefined
      if (r.baseline === undefined) {
        update(r.id, (cur) => ({ ...cur, baseline: s }))
        return undefined
      }
      return s === r.baseline ? undefined : { reason: `задача ${w.task}: ${r.baseline} → ${s}` }
    }
    if ('job' in w) {
      if (!opts.jobs) return undefined
      const j = await opts.jobs.get(w.job)
      if (!j) return { reason: `задачи ${w.job} нет в реестре` }
      if (!JOB_FINAL.includes(j.status)) return undefined
      return { reason: `задача ${j.id}${j.title ? ` «${j.title}»` : ''}: ${j.status}`, details: await jobDetails(j) }
    }
    return undefined
  }

  async function jobDetails(j: WakeJobView): Promise<string> {
    const lines: string[] = []
    const took = j.started && j.ended ? `, ${durationText(Date.parse(j.ended) - Date.parse(j.started))}` : ''
    lines.push(`статус: ${j.status}${j.exit !== undefined && j.exit !== null ? `, exit ${j.exit}` : ''}${took}`)
    if (j.cmd) lines.push(`команда: ${j.cmd.split('\n')[0]}`)
    if (j.dir) lines.push(`папка: ${j.dir}`)
    if (j.log) lines.push(`лог: ${j.log}`)
    if (j.error) lines.push(`ошибка: ${j.error.split('\n').slice(-5).join(' / ').slice(0, 600)}`)
    const tail = await opts.jobs!.tail(j.id, WAKE_LOG_TAIL).catch(() => [] as string[])
    if (tail.length) lines.push(`хвост лога (${tail.length} стр.):`, '```', ...tail.map((l) => l.slice(0, 400)), '```')
    return lines.join('\n')
  }

  function messageOf(r: WakeRecord, reason: string, details?: string, timedOut = false): string {
    return [`⏰ ${r.prompt}`, '', timedOut ? `Не дождался: ${reason}` : `Сработало: ${reason}`, ...(details ? [details] : []), '', `(будильник ${r.id})`].join('\n')
  }

  function taskEvent(e: WakeTaskEvent): string[] {
    const task = String(e.task ?? '').trim().toUpperCase()
    if (!task) throw Object.assign(new Error('wake: taskEvent без задачи'), { code: 'bad_request' })
    const t = now()
    const at = new Date(t).toISOString()
    const out: string[] = []
    const woken = new Set<string>()
    for (const r of all()) {
      if (r.status !== 'waiting' || !('task' in r.when) || r.when.task !== task || r.when.on !== 'verdict') continue
      const message = messageOf(r, e.reason, e.details)
      const next = update(r.id, (cur) => (cur.status === 'waiting' ? { ...cur, status: 'pending', reason: e.reason, message, pendingSince: at } : undefined))
      if (next) {
        out.push(r.id)
        woken.add(r.session)
      }
    }
    const session = String(e.session ?? '').trim()
    if (session && !woken.has(session)) {
      const message = e.message ?? [`⏰ ${e.reason}`, ...(e.details ? ['', e.details] : [])].join('\n')
      const r: WakeRecord = {
        id: newId(t),
        session,
        prompt: e.reason,
        when: { task, on: 'verdict' },
        status: 'pending',
        createdAt: at,
        createdBy: e.by ?? 'tasks',
        title: task,
        reason: e.reason,
        message,
        pendingSince: at,
      }
      writeRecord(dir, r)
      out.push(r.id)
    }
    if (out.length) log(`будильник: ${e.reason.split('\n')[0]} → ${out.join(', ')}`)
    return out
  }

  // ── доставка ──

  async function deliver(r: WakeRecord): Promise<boolean> {
    const b = opts.backend?.()
    if (!b || !r.message) return false
    if (delivering.has(r.session)) return false
    delivering.add(r.session)
    let started = false
    try {
      const it = b.run(r.session, { userMessage: r.message, headless: true })[Symbol.asyncIterator]()
      const first = await it.next()
      const ev = first.value as { type?: string; status?: string; error?: { message?: string; code?: string } } | undefined
      if (!first.done && ev?.type === 'run_end' && ev.status === 'error') throw Object.assign(new Error(ev.error?.message ?? 'ран упал'), { code: ev.error?.code })
      started = true
      // Остаток рана — в фоне: событиям ход будильника никто не ждёт.
      void (async () => {
        try {
          for (let x = first; !x.done; x = await it.next()) {
            /* дочитываем */
          }
        } catch (e) {
          log(`будильник ${r.id}: ран оборвался — ${(e as Error)?.message ?? e}`)
        }
      })()
      const t = new Date(now()).toISOString()
      update(r.id, (cur) => {
        const base: WakeRecord = { ...cur, firedAt: t }
        for (const k of ['message', 'pendingSince', 'attempts', 'error', 'timedOut'] as const) delete base[k]
        if (cur.timedOut) return { ...base, status: 'timeout' }
        if ('cron' in cur.when) return { ...base, status: 'waiting', fires: (cur.fires ?? 0) + 1, next: new Date(nextCron(cur.when.cron, cur.when.tz ?? tz, now())).toISOString() }
        return { ...base, status: 'fired' }
      })
      log(`будильник ${r.id}: ход в сессию ${r.session}`)
      // Ход хоста задач (вердикт) — Telegram уже отправил сам хост.
      if (r.createdBy !== 'tasks') void Promise.resolve(opts.notify?.(`⏰ ${r.prompt.split('\n')[0]!.slice(0, 200)}\n${r.reason ?? ''}\nсессия ${r.session}`)).catch(() => {})
      return true
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e)
      update(r.id, (cur) => {
        if (cur.status !== 'pending') return undefined
        const attempts = (cur.attempts ?? 0) + (wakeTransient(e) ? 0 : 1)
        const old = cur.pendingSince ? now() - Date.parse(cur.pendingSince) : 0
        if (notFound(e) || attempts >= DELIVER_ATTEMPTS || old > PENDING_MAX_MS) {
          log(`будильник ${r.id}: ход не доставлен — ${msg}`)
          return { ...cur, status: 'failed', error: msg, attempts }
        }
        return { ...cur, error: msg, attempts }
      })
      return false
    } finally {
      if (!started) delivering.delete(r.session)
      else setTimeout(() => delivering.delete(r.session), 1_000).unref?.()
    }
  }

  async function pass(): Promise<{ triggered: string[]; delivered: string[] }> {
    const triggered: string[] = []
    const delivered: string[] = []
    if (!opts.fire) return { triggered, delivered }
    const records = all().filter((r) => WAKE_LIVE.includes(r.status))
    const refs = [...new Set(records.filter((r) => r.status === 'waiting' && 'task' in r.when && r.when.on !== 'verdict').map((r) => (r.when as { task: string }).task))]
    const statuses = refs.length && opts.taskStatus ? await opts.taskStatus(refs).catch(() => ({})) : {}
    const t = now()
    for (const r of records) {
      if (r.status !== 'waiting') continue
      let hit: { reason: string; details?: string } | undefined
      try {
        hit = await check(r, t, statuses)
      } catch (e) {
        log(`будильник ${r.id}: проверка упала — ${(e as Error)?.message ?? e}`)
        continue
      }
      let timedOut = false
      if (!hit && r.timeoutAt && Date.parse(r.timeoutAt) <= t) {
        hit = { reason: `${describeWhen(r, tz, t)} — срок ${shortTime(Date.parse(r.timeoutAt), tz, t)} вышел` }
        timedOut = true
      }
      if (!hit) continue
      const message = messageOf(r, hit.reason, hit.details, timedOut)
      const next = update(r.id, (cur) => (cur.status === 'waiting' ? { ...cur, status: 'pending', reason: hit!.reason, message, pendingSince: new Date(t).toISOString(), ...(timedOut ? { timedOut: true } : {}) } : undefined))
      if (next) triggered.push(r.id)
    }
    for (const r of all().filter((x) => x.status === 'pending')) {
      if (await deliver(r)) delivered.push(r.id)
    }
    return { triggered, delivered }
  }

  // ── сервис ──

  const methods = ['list', 'get', 'create', 'cancel', 'status', 'tools', 'tool'] as const

  const sessionOf = (args: Record<string, unknown>, session: { id?: string } | undefined): string => {
    const s = (typeof args.session === 'string' && args.session.trim()) || session?.id || ''
    if (!s) throw Object.assign(new Error('wake: нет id сессии — тул зовут из сессии или с аргументом session'), { code: 'bad_request' })
    return s
  }

  function view(r: WakeRecord): WakeRecord & { label: string } {
    return { ...r, label: describeWhen(r, ('cron' in r.when && r.when.tz) || tz, now()) }
  }

  function line(r: WakeRecord): string {
    return `${r.id} · ${r.status} · ${describeWhen(r, tz, now())} · «${r.prompt.split('\n')[0]!.slice(0, 80)}»${r.reason ? ` · ${r.reason}` : ''}${r.error ? ` · ошибка: ${r.error}` : ''}`
  }

  async function jobStatusText(id: string): Promise<{ text: string; data: unknown }> {
    if (!opts.jobs) throw new Error('job_status: у стенда нет реестра задач')
    const j = await opts.jobs.get(id)
    if (!j) throw Object.assign(new Error(`job_status: нет задачи ${id}`), { code: 'not_found' })
    const waits = all().filter((r) => 'job' in r.when && r.when.job === id && WAKE_LIVE.includes(r.status))
    const text = [`задача ${j.id}${j.title ? ` «${j.title}»` : ''}`, await jobDetails(j), ...(waits.length ? [`будильники: ${waits.map((w) => w.id).join(', ')}`] : [])].join('\n')
    return { text, data: { job: j, wakes: waits.map((w) => w.id) } }
  }

  async function runTool(name: string, args: Record<string, unknown>, session: { id?: string; cwd?: string } | undefined): Promise<{ text: string; data?: unknown; isError?: boolean }> {
    const timeout = typeof args.timeout === 'string' && args.timeout.trim() ? args.timeout.trim() : undefined
    switch (name) {
      case 'wake_at': {
        const when: WakeWhen = typeof args.cron === 'string' && args.cron.trim() ? { cron: args.cron.trim(), ...(typeof args.tz === 'string' && args.tz ? { tz: args.tz } : {}) } : { at: String(args.when ?? args.at ?? '') }
        const r = await create({ session: sessionOf(args, session), prompt: String(args.prompt ?? ''), when, createdBy: 'agent' })
        return { text: `будильник ${r.id}: ${describeWhen(r, tz, now())} — ход «⏰ ${r.prompt.split('\n')[0]}» придёт в эту сессию сам. Сейчас закончи ход.`, data: view(r) }
      }
      case 'wake_on': {
        let when: WakeWhen | undefined
        if (typeof args.job === 'string' && args.job) when = { job: args.job }
        else if (args.pid !== undefined && args.pid !== '') when = { pid: Number(args.pid) }
        else if (typeof args.file === 'string' && args.file) when = { file: args.file, ...(typeof args.match === 'string' && args.match ? { match: args.match } : {}) }
        else if (typeof args.task === 'string' && args.task) when = { task: args.task, ...(args.on === 'verdict' || args.on === 'status' ? { on: args.on } : {}) }
        if (!when) throw Object.assign(new Error('wake_on: нужно одно из job, pid, file (+match), task'), { code: 'bad_request' })
        const r = await create({ session: sessionOf(args, session), prompt: String(args.prompt ?? ''), when, ...(timeout ? { timeout } : {}), createdBy: 'agent' })
        return { text: `будильник ${r.id}: ${describeWhen(r, tz, now())}${r.timeoutAt ? `, срок ${shortTime(Date.parse(r.timeoutAt), tz, now())}` : ''} — ход придёт в эту сессию сам. Сейчас закончи ход.`, data: view(r) }
      }
      case 'wake_list': {
        const rs = list({ ...(args.all_sessions === true ? {} : { session: sessionOf(args, session) }), all: args.all === true })
        return { text: rs.length ? rs.map(line).join('\n') : 'будильников нет', data: rs.map(view) }
      }
      case 'wake_cancel': {
        const r = cancel(String(args.id ?? ''))
        return { text: `будильник ${r.id}: ${r.status}`, data: view(r) }
      }
      case 'job_start': {
        if (!opts.jobs) throw new Error('job_start: у стенда нет реестра задач')
        const cmd = String(args.cmd ?? '')
        if (!cmd.trim()) throw Object.assign(new Error('job_start: пустая cmd'), { code: 'bad_request' })
        const cwd = resolve(expandHome(typeof args.cwd === 'string' && args.cwd ? args.cwd : (session?.cwd ?? opts.cwd ?? process.cwd())))
        const j = await opts.jobs.start({ cmd, cwd, ...(typeof args.title === 'string' && args.title ? { title: args.title } : {}) })
        const wakePrompt = args.wake === false || args.wake === 'off' ? undefined : typeof args.wake === 'string' && args.wake.trim() ? args.wake.trim() : `задача ${j.id}${j.title ? ` «${j.title}»` : ''} кончилась — проверь итог и доложи`
        let r: WakeRecord | undefined
        const sid = (typeof args.session === 'string' && args.session) || session?.id
        if (wakePrompt && sid) r = await create({ session: sid, prompt: wakePrompt, when: { job: j.id }, ...(timeout ? { timeout } : {}), ...(j.title ? { title: j.title } : {}), createdBy: 'job_start' })
        const text = [
          `задача ${j.id} запущена${j.title ? ` «${j.title}»` : ''} (${j.status}), cwd ${cwd}`,
          ...(j.log ? [`лог: ${j.log}`] : []),
          ...(j.dir ? [`папка: ${j.dir}`] : []),
          r ? `будильник ${r.id}: по концу задачи в эту сессию придёт ход «⏰ ${wakePrompt}». Сейчас закончи ход; статус — только job_status.` : 'будильник не ставился; статус — job_status.',
        ].join('\n')
        return { text, data: { job: j, ...(r ? { wake: view(r) } : {}) } }
      }
      case 'job_status': {
        return jobStatusText(String(args.id ?? ''))
      }
      default:
        throw Object.assign(new Error(`wake: нет тула ${name}`), { code: 'not_found' })
    }
  }

  async function call(method: string, args: unknown): Promise<unknown> {
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
    switch (method) {
      case 'list':
        return list({ ...(typeof a.session === 'string' && a.session ? { session: a.session } : {}), all: a.all === true }).map(view)
      case 'get': {
        const r = get(String(a.id ?? ''))
        if (!r) throw Object.assign(new Error(`wake: нет будильника ${String(a.id)}`), { code: 'not_found' })
        return view(r)
      }
      case 'create': {
        const timeout = typeof a.timeout === 'string' && a.timeout ? a.timeout : undefined
        return view(await create({ session: String(a.session ?? ''), prompt: String(a.prompt ?? ''), when: a.when as WakeWhen, ...(timeout ? { timeout } : {}), ...(typeof a.title === 'string' ? { title: a.title } : {}), createdBy: typeof a.createdBy === 'string' ? a.createdBy : 'user' }))
      }
      case 'cancel':
        return view(cancel(String(a.id ?? '')))
      case 'status': {
        const rs = all()
        const by: Record<string, number> = {}
        for (const r of rs) by[r.status] = (by[r.status] ?? 0) + 1
        return { dir, fire: !!opts.fire, tz, counts: by, live: rs.filter((r) => WAKE_LIVE.includes(r.status)).length }
      }
      case 'tools':
        return WAKE_TOOLS.filter((t) => opts.jobs || !t.name.startsWith('job_'))
      case 'tool': {
        const session = (a.session && typeof a.session === 'object' ? a.session : undefined) as { id?: string; cwd?: string } | undefined
        const targs = (a.args && typeof a.args === 'object' ? a.args : {}) as Record<string, unknown>
        try {
          return await runTool(String(a.name ?? ''), targs, session)
        } catch (e) {
          return { text: `${(e as Error)?.message ?? e}`, isError: true }
        }
      }
      default:
        throw Object.assign(new Error(`wake: нет метода ${method}`), { code: 'not_supported' })
    }
  }

  const wake: Wake = {
    create,
    list,
    get,
    cancel,
    taskEvent,
    once() {
      running ??= pass().finally(() => {
        running = undefined
      })
      return running
    },
    start() {
      if (timer || !opts.fire) return
      const tick = (): void => void wake.once().catch((e: unknown) => log(`будильник: проход упал — ${(e as Error)?.message ?? e}`))
      setTimeout(tick, 3_000).unref?.()
      timer = setInterval(tick, opts.intervalMs ?? 30_000)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
    },
    dir,
    fires: !!opts.fire,
    methods,
    call,
  }
  return wake
}

// ── тулы ────────────────────────────────────────────────────────────────────

const PROMPT_DESC = 'Что сказать себе, когда сработает: ход придёт в эту сессию как «⏰ <prompt>» + что сработало.'
const TIMEOUT_DESC = 'Срок ожидания («6h», «90m» или время ISO); вышел — ход «не дождался».'

/** Декларации тулов сервиса `wake` (формат `tools` сервиса: name, description, schema). */
export const WAKE_TOOLS = [
  {
    name: 'wake_at',
    description:
      'Будильник по времени: в указанное время в эту сессию придёт ход «⏰ <prompt>», даже если сессия погашена или стенд перезапускался. when — «через 2h», «90m», «19:30», «завтра 09:00» или ISO (пояс Europe/Warsaw); повторять — cron (5 полей, tz). После постановки закончи ход — не жди внутри сессии.',
    schema: {
      type: 'object',
      properties: {
        when: { type: 'string', description: 'Когда: «через 2h», «45m», «19:30», «завтра 09:00», ISO.' },
        cron: { type: 'string', description: 'Вместо when — повторять: «0 9 * * 1-5».' },
        tz: { type: 'string', description: 'Пояс cron (по умолчанию Europe/Warsaw).' },
        prompt: { type: 'string', description: PROMPT_DESC },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'wake_on',
    description:
      'Будильник по событию: ход «⏰ <prompt>» придёт в эту сессию, когда кончится задача runz-run (job), выйдет процесс (pid), появится файл или строка в нём (file + match), задача Projektor (task): on=verdict — вердикт приёмщика или обрыв (ждать конца чужой задачи — так, не временем), on=status (по умолчанию) — смена статуса. Задачу, запущенную из этой сессии (runz projektor, task_begin), ждать не надо: ход «⏰ DEV-N: принято | отказ | оборван» придёт сам. Одно условие; timeout — срок. После постановки закончи ход.',
    schema: {
      type: 'object',
      properties: {
        job: { type: 'string', description: 'id задачи runz-run (job_start, runz job).' },
        pid: { type: 'number', description: 'pid процесса на машине хаба.' },
        file: { type: 'string', description: 'Путь к файлу: сработает, когда появится.' },
        match: { type: 'string', description: 'С file: regex строки в файле (конец файла до 1 МБ).' },
        task: { type: 'string', description: 'Задача трекера (PROJ-123).' },
        on: { type: 'string', enum: ['status', 'verdict'], description: 'С task: verdict — вердикт приёмщика или обрыв; status — смена статуса (по умолчанию).' },
        timeout: { type: 'string', description: TIMEOUT_DESC },
        prompt: { type: 'string', description: PROMPT_DESC },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'wake_list',
    description: 'Будильники этой сессии (живые; all — и сработавшие/снятые; all_sessions — всех сессий). Статус долгой работы бери отсюда и из job_status, не по памяти.',
    schema: { type: 'object', properties: { all: { type: 'boolean' }, all_sessions: { type: 'boolean' } } },
  },
  {
    name: 'wake_cancel',
    description: 'Снять будильник по id.',
    schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'job_start',
    description:
      'Запустить долгую команду оболочки задачей runz-run (отдельный процесс, переживает сессию и рестарт стенда; лог и папка в ~/.runz/jobs/<id>). По умолчанию ставит будильник на конец задачи — ход с итогом и хвостом лога придёт сюда сам. Всё дольше ~10 минут — только так, не run_in_background/nohup в ходе.',
    schema: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'Команда (sh -c).' },
        cwd: { type: 'string', description: 'Каталог; по умолчанию — каталог сессии.' },
        title: { type: 'string', description: 'Подпись задачи.' },
        wake: { description: 'Prompt будильника на конец задачи (строка) или false — без будильника.', type: ['string', 'boolean'] },
        timeout: { type: 'string', description: TIMEOUT_DESC },
      },
      required: ['cmd'],
    },
  },
  {
    name: 'job_status',
    description: 'Статус задачи runz-run: статус, exit, время, папка, лог и его хвост. Единственный источник правды о долгой работе — не пиши статус по памяти.',
    schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
] as const

// ── сервис хоста ────────────────────────────────────────────────────────────

/** Хост сервисов стенда + встроенный сервис `wake` (как `tasks` у ACP-стенда). */
export function withWakeService(host: ServicesHost | undefined, wake: Wake): ServicesHost {
  const none = (plugin: string, method: string): AsyncIterable<ServiceEvent> => ({
    [Symbol.asyncIterator]() {
      return { next: () => Promise.reject(Object.assign(new Error(`services.${plugin}.${method}: нет стрима`), { code: 'not_supported' })) }
    },
  })
  return {
    async call(plugin, method, args) {
      if (plugin === WAKE_SERVICE_ID) return wake.call(method, args)
      if (!host) throw Object.assign(new Error(`services.${plugin}: нет сервиса`), { code: 'not_supported' })
      return host.call(plugin, method, args)
    },
    stream(plugin, method, args) {
      if (plugin === WAKE_SERVICE_ID || !host) return none(plugin, method)
      return host.stream(plugin, method, args)
    },
    async capability(): Promise<ServicesCapability> {
      const ext = host ? await host.capability().catch(() => ({})) : {}
      return { ...ext, [WAKE_SERVICE_ID]: { methods: [...wake.methods], streams: [] } }
    },
    async close() {
      wake.stop()
      await host?.close()
    },
  }
}
