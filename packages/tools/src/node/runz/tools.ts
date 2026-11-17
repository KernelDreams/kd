/**
 * Тулы `runz` и `runz_list` (pi-ext-runz-spec): запуск runz-скрипта
 * с полным выводом (stdout/stderr раздельно, хвостовая обрезка по `maxChars`)
 * и справочник скриптов. Логика одна — родные `ToolDef` здесь, pi-обёртка
 * Расширения агентов других хостов зовут те же {@link runzCall}/{@link runzListCall}.
 *
 * Ошибки запуска уходят текстом в результат, а не исключением (§2).
 *
 * Окружение:
 *   PI_EXT_RUNZ_BIN      бинарь runz, default `runz` из PATH (читается на каждый вызов)
 *   PI_EXT_RUNZ_CATALOG  `0` — не собирать каталог скриптов в описание тула при создании
 */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { ToolDef, ToolResult } from '../../types.js'
import { errorText, filterCatalog, formatCatalog, formatRun, parseList, parseCatalog } from './format.js'
import { DEFAULT_MAX_CHARS, DEFAULT_TIMEOUT_SEC, MAX_MAX_CHARS, MAX_TIMEOUT_SEC, RunzError, runProcess, STDERR_MAX_CHARS, type RunOutcome } from './run.js'

export interface RunzParams {
  script: string
  args?: string[]
  cwd?: string
  stdin?: string
  maxChars?: number
  timeoutSec?: number
}

export interface RunzListParams {
  filter?: string
}

/** `details` тула `runz`: результат запуска и каталог, в котором он шёл. */
export interface RunzDetails extends RunOutcome {
  cwd: string
}

export interface RunzErrorDetails {
  error: { code: string; message: string }
}

/** Итог вызова: текст модели и `details` (`data` результата тула). */
export interface RunzCallResult<D> {
  text: string
  details: D
  isError?: true
}

/** Инъекции для тестов и хостов; по умолчанию — `process.env` и `runz` из PATH. */
export interface RunzToolsDeps {
  /** argv-префикс запуска runz; default — `PI_EXT_RUNZ_BIN` или `runz`. */
  command?: () => string[]
  /** Имена скриптов для описания тула при создании; `undefined` — без каталога. */
  catalog?: (command: string[]) => string[] | undefined
  env?: () => NodeJS.ProcessEnv
  /** Каталог по умолчанию, когда у вызова нет `ctx.cwd`; default — `process.cwd()`. */
  cwd?: string
  /** `$tools: all` на nr их не берёт — профиль называет (`$tools_extra`). */
  optIn?: boolean
}

/** Больше имён в описание не кладём — справочник целиком даёт `runz_list`. */
const CATALOG_MAX_NAMES = 200
const CATALOG_TIMEOUT_MS = 3_000
export const LIST_TIMEOUT_MS = 30_000

export function clampMaxChars(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : DEFAULT_MAX_CHARS
  return Math.min(Math.max(n, 1_000), MAX_MAX_CHARS)
}

export function clampTimeoutSec(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_SEC
  return Math.min(Math.max(n, 1), MAX_TIMEOUT_SEC)
}

export function defaultCommand(env: NodeJS.ProcessEnv = process.env): string[] {
  return [env.PI_EXT_RUNZ_BIN || 'runz']
}

/**
 * Каталог для описания тула: `runz --runz-list` синхронно при создании
 * (~0.1 s). Не вышло (нет runz, таймаут, пусто) — описание без каталога.
 */
export function loadCatalog(command: string[]): string[] | undefined {
  if (process.env.PI_EXT_RUNZ_CATALOG === '0') return undefined
  const [bin, ...rest] = command
  if (!bin) return undefined
  const r = spawnSync(bin, [...rest, '--runz-list'], { encoding: 'utf8', timeout: CATALOG_TIMEOUT_MS, windowsHide: true })
  if (r.error || r.status !== 0) return undefined
  const names = parseList(r.stdout)
  return names.length > 0 ? names : undefined
}

export function runzFailure(tool: string, e: RunzError): RunzCallResult<RunzErrorDetails> {
  const hint = e.code === 'spawn' ? ' (is runz installed and in PATH? PI_EXT_RUNZ_BIN overrides the binary)' : ''
  return { text: `${errorText(tool, e)}${hint}`, details: { error: { code: e.code, message: e.message } }, isError: true }
}

export function runzDescription(catalog: readonly string[] | undefined): string {
  const names = catalog?.slice(0, CATALOG_MAX_NAMES)
  return (
    'Run a runz script or appz (KernelDreams script runner) and get its full output: exit code, stdout and stderr separately. ' +
    'Prefer it over bash for any `runz <script> ...` command: output is not cut at 2000 lines / 50KB, ' +
    `only at maxChars (default ${DEFAULT_MAX_CHARS}; the tail is kept and the result starts with [truncated: N of M chars]). ` +
    'script is an appz/script name or a path to a .mdz/.ts file, resolved by runz itself; ' +
    'args are separate argv items, flags with values as --key=value. ' +
    'Examples: {"script": "skills", "args": ["view", "<name>"]}; {"script": "ws", "args": ["status"]}. ' +
    'Call runz_list to see available scripts.' +
    (names?.length ? ` Available scripts: ${names.join(', ')}.` : '')
  )
}

export const RUNZ_LIST_DESCRIPTION =
  'List runz scripts and appz available in the session cwd, one line each: name — what it does. ' +
  'Optional filter is a case-insensitive substring of the name or description (e.g. "browser", "google", "telegram"). ' +
  'Then call runz with the chosen script name; run it with no args or --help for its commands.'

export const RUNZ_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    script: { type: 'string', description: 'appz/script name or path to a .mdz/.ts file' },
    args: { type: 'array', items: { type: 'string' }, description: 'Arguments, one argv item each; flags as --key=value' },
    cwd: { type: 'string', description: 'Working directory, default the session cwd; relative paths resolve against it' },
    stdin: { type: 'string', description: 'Text passed to the script stdin' },
    maxChars: { type: 'integer', description: `Max chars of stdout, default ${DEFAULT_MAX_CHARS}, max ${MAX_MAX_CHARS}; stderr is capped at ${STDERR_MAX_CHARS}` },
    timeoutSec: { type: 'number', description: `Kill the script after this many seconds, default ${DEFAULT_TIMEOUT_SEC}, max ${MAX_TIMEOUT_SEC}` },
  },
  required: ['script'],
}

export const RUNZ_LIST_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    filter: { type: 'string', description: 'Case-insensitive substring of the script name or description' },
  },
}

export interface RunzCallContext {
  command: string[]
  env: NodeJS.ProcessEnv
  /** Каталог сессии; `params.cwd` резолвится от него. */
  cwd: string
  signal?: AbortSignal
}

/** Вызов `runz <script> …`: текст модели и `details`. */
export async function runzCall(params: RunzParams, c: RunzCallContext): Promise<RunzCallResult<RunzDetails | RunzErrorDetails>> {
  const script = typeof params.script === 'string' ? params.script.trim() : ''
  if (script === '') return runzFailure('runz', new RunzError('bad_request', 'script is required'))
  const args = (params.args ?? []).map(String)
  const cwd = params.cwd ? resolve(c.cwd, params.cwd) : c.cwd
  const timeoutMs = clampTimeoutSec(params.timeoutSec) * 1000
  const res = await runProcess({
    argv: [...c.command, script, ...args],
    cwd,
    maxChars: clampMaxChars(params.maxChars),
    timeoutMs,
    env: c.env,
    ...(params.stdin !== undefined ? { stdin: params.stdin } : {}),
    ...(c.signal ? { signal: c.signal } : {}),
  })
  if (!res.ok) return runzFailure('runz', res.error)
  return { text: formatRun(['runz', script, ...args], res.value, timeoutMs), details: { ...res.value, cwd } }
}

/** Вызов `runz --runz-list` с фильтром по подстроке. */
export async function runzListCall(params: RunzListParams, c: RunzCallContext): Promise<RunzCallResult<{ names: string[]; about: Record<string, string> } | RunzErrorDetails>> {
  const res = await runProcess({
    argv: [...c.command, '--runz-list', '--runz-describe'],
    cwd: c.cwd,
    maxChars: MAX_MAX_CHARS,
    timeoutMs: LIST_TIMEOUT_MS,
    env: c.env,
    ...(c.signal ? { signal: c.signal } : {}),
  })
  if (!res.ok) return runzFailure('runz_list', res.error)
  if (res.value.exitCode !== 0) {
    const text = formatRun(['runz', '--runz-list'], res.value, LIST_TIMEOUT_MS)
    return { text: `runz_list failed [exit]:\n${text}`, details: { error: { code: 'exit', message: res.value.stderr } }, isError: true }
  }
  const items = filterCatalog(parseCatalog(res.value.stdout), params.filter)
  return {
    text: formatCatalog(items, params.filter),
    details: { names: items.map((x) => x.name), about: Object.fromEntries(items.map((x) => [x.name, x.about])) },
  }
}

function toResult<D>(r: RunzCallResult<D>): ToolResult {
  return { text: r.text, data: r.details, ...(r.isError ? { isError: true } : {}) }
}

/**
 * `runz` и `runz_list` родными тулами. Каталог скриптов для описания `runz`
 * собирается один раз, здесь; каталог вызова — `ctx.cwd`, иначе `deps.cwd`.
 */
/** Переменная окружения с id сессии вызова: `runz projektor` передаёт её хабу задач постановщиком. */
export const NR_SESSION_ENV = 'NR_SESSION'

/** Окружение вызова с id сессии; сессии нет — без унаследованного чужого id. */
export function withSession(env: NodeJS.ProcessEnv, sessionId: string | undefined): NodeJS.ProcessEnv {
  const out = { ...env }
  if (sessionId) out[NR_SESSION_ENV] = sessionId
  else delete out[NR_SESSION_ENV]
  return out
}

export function createRunzTools(deps: RunzToolsDeps = {}): ToolDef[] {
  const readEnv = deps.env ?? (() => process.env)
  const command = deps.command ?? (() => defaultCommand(readEnv()))
  const catalog = deps.catalog ?? loadCatalog
  const base = (cwd: string | undefined): string => cwd ?? deps.cwd ?? process.cwd()
  const opt = deps.optIn ? { optIn: true } : {}
  return [
    {
      name: 'runz',
      description: runzDescription(catalog(command())),
      schema: RUNZ_SCHEMA,
      executor: 'backend',
      ...opt,
      async execute(args, ctx) {
        return toResult(await runzCall(args as unknown as RunzParams, { command: command(), env: withSession(readEnv(), ctx.sessionId), cwd: base(ctx.cwd), signal: ctx.signal }))
      },
    },
    {
      name: 'runz_list',
      description: RUNZ_LIST_DESCRIPTION,
      schema: RUNZ_LIST_SCHEMA,
      executor: 'backend',
      ...opt,
      async execute(args, ctx) {
        return toResult(await runzListCall(args as RunzListParams, { command: command(), env: readEnv(), cwd: base(ctx.cwd), signal: ctx.signal }))
      },
    },
  ]
}
