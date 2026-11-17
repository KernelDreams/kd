/**
 * Ошибки рантайма артефакта: статическая проверка finalize не
 * видит DOM — `app.js` ищет `#drop`, а в `index.html` уже `#drop-zone`, скрипт
 * падает на первой строке, и агент об этом не знает. Ловит их prelude гостя
 * (`window.onerror`, `unhandledrejection`, незагрузившийся `<script>`) в
 * открытой вкладке nrchat; сюда они доезжают через сервис плагина.
 *
 * Канал между pi (pi-ext-artifact) и сервисом — файлы в каталоге данных плагина,
 * как очередь `open.jsonl` у `artifact_open`: процессы разные, общий только диск.
 *
 *   runtime/<hash>.json      журнал ошибок артефакта (последние, текущей версии) → `artifact_errors`
 *   open.jsonl  {check}      «открой и проверь» — строка очереди с id проверки
 *   checks/<id>.ack          сервис передал запрос живому клиенту (подписчику events)
 *   checks/<id>.json         клиент: загрузилось, прошло окно — вот ошибки
 *
 * Headless-браузера в бэкенде нет сознательно: проверка — в той вкладке, где
 * артефакт и будет жить. Клиента нет — «не проверено», а не провал.
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { ArtifactInfo } from './collections.js'
import { pluginDataRoot } from './lifecycle.js'

export interface RuntimeError {
  message: string
  /** Файл относительно папки артефакта (`app.js`), если известен. */
  source?: string
  line?: number
  col?: number
  /** Стек до {@link STACK_LINES} строк. */
  stack?: string
  /** `error` | `unhandledrejection` | `resource` (не загрузился `<script>`/`<link>`). */
  kind?: string
}

export interface RuntimeLog {
  id: string
  dir: string
  version: number
  updatedAt: number
  errors: RuntimeError[]
}

export type RuntimeCheck =
  | { status: 'checked'; errors: RuntimeError[] }
  | { status: 'no-client' }
  | { status: 'timeout' }

/** Окно после `load`, в которое ошибка считается ошибкой запуска (уточнение п.2). */
export const RUNTIME_WINDOW_MS = 3000
export const STACK_LINES = 20
const LOG_KEEP = 20
const MAX_MESSAGE = 2000

const hashDir = (dir: string): string => createHash('sha1').update(resolve(dir)).digest('hex').slice(0, 16)

export function runtimeLogFile(dir: string, root = pluginDataRoot()): string {
  return join(root, 'runtime', `${hashDir(dir)}.json`)
}

export function checkFile(check: string, ext: 'ack' | 'json', root = pluginDataRoot()): string {
  if (!/^[\w-]+$/.test(check)) throw new Error(`плохой id проверки: ${check}`)
  return join(root, 'checks', `${check}.${ext}`)
}

export const newCheckId = (): string => `c${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

/** Привести то, что прислал гость, к {@link RuntimeError} (данные чужие — только известные поля, длины обрезаны). */
export function normalizeRuntimeError(raw: unknown): RuntimeError | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const message = typeof r.message === 'string' && r.message.trim() ? r.message.slice(0, MAX_MESSAGE) : null
  if (!message) return null
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined)
  const str = (v: unknown, max = 500): string | undefined => (typeof v === 'string' && v ? v.slice(0, max) : undefined)
  const stack = str(r.stack, 8000)?.split('\n').slice(0, STACK_LINES).join('\n')
  const out: RuntimeError = { message }
  const source = str(r.source)
  if (source) out.source = source
  const line = num(r.line)
  if (line) out.line = line
  const col = num(r.col)
  if (col) out.col = col
  if (stack) out.stack = stack
  const kind = str(r.kind, 40)
  if (kind) out.kind = kind
  return out
}

/** Дописать ошибки в журнал артефакта; смена версии журнал обнуляет (старые ошибки — про старый код). */
export function appendRuntimeErrors(info: Pick<ArtifactInfo, 'id' | 'dir' | 'version'>, errors: RuntimeError[], root = pluginDataRoot()): RuntimeLog {
  const file = runtimeLogFile(info.dir, root)
  let log = readLog(file)
  if (!log || log.version !== info.version) log = { id: info.id, dir: info.dir, version: info.version, updatedAt: 0, errors: [] }
  log.errors = [...log.errors, ...errors].slice(-LOG_KEEP)
  log.updatedAt = Date.now()
  writeAtomic(file, `${JSON.stringify(log, null, 2)}\n`)
  return log
}

function readLog(file: string): RuntimeLog | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as RuntimeLog
  } catch {
    return null
  }
}

/** Журнал ошибок артефакта (для `artifact_errors`); нет — null. */
export function readRuntimeErrors(dir: string, root = pluginDataRoot()): RuntimeLog | null {
  return readLog(runtimeLogFile(dir, root))
}

/** Сервис: запрос проверки передан живому клиенту. */
export function ackCheck(check: string, root = pluginDataRoot()): void {
  writeAtomic(checkFile(check, 'ack', root), `${Date.now()}\n`)
}

/** Сервис: результат проверки от клиента. Первый ответ побеждает (открыто несколько окон). */
export function writeCheckResult(check: string, errors: RuntimeError[], root = pluginDataRoot()): boolean {
  const file = checkFile(check, 'json', root)
  if (existsSync(file)) return false
  writeAtomic(file, `${JSON.stringify({ errors, at: Date.now() })}\n`)
  return true
}

export interface AwaitCheckOpts {
  root?: string
  /** Сколько ждать, что запрос подхватил клиент; нет — «нет открытого nrchat». */
  ackMs?: number
  /** Сколько ждать результата после ack (загрузка + окно {@link RUNTIME_WINDOW_MS}). */
  resultMs?: number
  pollMs?: number
  signal?: AbortSignal
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** pi: дождаться результата проверки. Файлы проверки убираются за собой. */
export async function awaitRuntimeCheck(check: string, opts: AwaitCheckOpts = {}): Promise<RuntimeCheck> {
  const root = opts.root ?? pluginDataRoot()
  const ack = checkFile(check, 'ack', root)
  const result = checkFile(check, 'json', root)
  const poll = opts.pollMs ?? 100
  const cleanup = (): void => {
    rmSync(ack, { force: true })
    rmSync(result, { force: true })
  }
  try {
    let deadline = Date.now() + (opts.ackMs ?? 2500)
    let acked = false
    for (;;) {
      if (opts.signal?.aborted) return { status: 'timeout' }
      if (existsSync(result)) {
        const r = JSON.parse(readFileSync(result, 'utf8')) as { errors?: unknown[] }
        return { status: 'checked', errors: (r.errors ?? []).map(normalizeRuntimeError).filter((e): e is RuntimeError => e !== null) }
      }
      if (!acked && existsSync(ack)) {
        acked = true
        deadline = Date.now() + (opts.resultMs ?? 20_000)
      }
      if (Date.now() > deadline) return acked ? { status: 'timeout' } : { status: 'no-client' }
      await sleep(poll)
    }
  } finally {
    cleanup()
  }
}
