/**
 * Процесс `service.ts` артефакта (artifacts-spec §2: `$service`, переносится
 * через сервисы плагинов). Отдельный процесс, не импорт в бэкенд: сервис гостя —
 * полный Node, может упасть или `process.exit` (v1 `hello-service` так и делает),
 * бэкенд от этого жить не перестаёт.
 *
 *   node service-runner.js --dir=<папка> --data=<dataDir> [--workspace=<каталог>]
 *
 * Провод — JSON-строки по stdio (как exz v1 `wire.ts`):
 *   stdin  {id, cmd, params}        → stdout {id, ok, value|error}
 *   stdin  {close: true} | EOF      → meta.closed резолвится, процесс выходит
 *   stdout {event, payload}         push (`emit`); `{event:'__ready'}` — обработчики стоят
 *
 * Контракт сервиса — v1 и v2 разом: `meta.channel.{on,emit,closed}` (exz v1) и
 * `meta.{on,emit,closed}`; `meta.file`, `meta.dataDir`, `meta.projectDir`.
 * ctx — `buildScopes` из `@kerneldreams/runz-runtime`, если воркспейс runz найден, иначе `{}`.
 * Легаси-импорты v1 (`@kerneldreams/nrd/web`, `@kerneldreams/nrd`) — псевдонимы на
 * `@kerneldreams/nrd`: код гостя не правится.
 */

import { existsSync, readFileSync } from 'node:fs'
import { register } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

type Handler = (params: unknown) => unknown

function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const a of argv) {
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq === -1) out[a.slice(2)] = ''
    else out[a.slice(2, eq)] = a.slice(eq + 1)
  }
  return out
}

const send = (m: unknown): void => void process.stdout.write(`${JSON.stringify(m)}\n`)
const log = (s: string): void => void process.stderr.write(`artifact service: ${s}\n`)

/** Воркспейс runz: `$runz:` конфига, иначе `<$root>/Projects/runz` (как sidecar exz). */
function runzWorkspace(): string | null {
  const expand = (p: string): string => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)
  let text = ''
  try {
    text = readFileSync(join(homedir(), '.runz', 'config.md'), 'utf8')
  } catch {
    // нет конфига
  }
  const attr = (k: string): string | null => new RegExp(`^\\$${k}\\s*:\\s*(.+)$`, 'm').exec(text)?.[1]?.trim() ?? null
  const root = attr('root')
  const candidates = [process.env.NR_RUNZ_WORKSPACE ?? null, attr('runz'), root ? join(expand(root), 'Projects', 'runz') : null]
  return (
    candidates
      .filter((p): p is string => !!p)
      .map(expand)
      .find((p) => existsSync(join(p, 'packages', 'runtime', 'src', 'resolve-hook.ts'))) ?? null
  )
}

const ALIASES = `
const MAP = { '@kerneldreams/nrd/web': '@kerneldreams/nrd', '@kerneldreams/nrd': '@kerneldreams/nrd', '@exz/service': 'data:text/javascript,export {}' }
export async function resolve(specifier, context, next) {
  const to = MAP[specifier]
  if (to) return to.startsWith('data:') ? { url: to, shortCircuit: true } : next(to, context)
  return next(specifier, context)
}
`

async function main(): Promise<void> {
  const f = flags(process.argv.slice(2))
  const dir = f.dir
  if (!dir) {
    log('--dir обязателен')
    process.exit(2)
  }
  const serviceFile = join(dir, 'service.ts')
  const workspace = runzWorkspace()
  // Порядок: сначала хук runz (последний зарегистрированный вызывается первым —
  // псевдонимы переписывают спецификатор до него).
  if (workspace) {
    try {
      register(pathToFileURL(join(workspace, 'packages', 'runtime', 'src', 'resolve-hook.ts')).href, {
        data: { workspaceRoot: workspace, envs: [] },
      })
    } catch (e) {
      log(`resolve-хук runz не встал: ${(e as Error).message}`)
    }
  }
  register(`data:text/javascript,${encodeURIComponent(ALIASES)}`)

  let ctx: unknown = {}
  if (workspace) {
    try {
      const rt = (await import('@kerneldreams/runz-runtime' as string)) as {
        buildScopes: (l: unknown) => { document: unknown }
        loadConfigFile: (p: string) => unknown
        globalRunzDir: () => string
      }
      ctx = rt.buildScopes({
        cliArgs: {},
        doc: null,
        explicitConfig: null,
        scriptConfig: null,
        projectConfig: rt.loadConfigFile(join(dir, '.runz', 'config.md')),
        globalConfig: rt.loadConfigFile(join(rt.globalRunzDir(), 'config.md')),
        env: process.env as Record<string, string>,
      }).document
    } catch (e) {
      log(`ctx без runz: ${(e as Error).message}`)
    }
  }

  const handlers = new Map<string, Handler>()
  let resolveClosed: () => void = () => {}
  const closed = new Promise<void>((r) => (resolveClosed = r))
  const on = (cmd: string, h: Handler): void => void handlers.set(cmd, h)
  const emit = (event: string, payload?: unknown): void => send({ event, payload })
  const meta = {
    file: f.file || null,
    doc: null,
    projectDir: dir,
    artifactDir: dir,
    dataDir: f.data || join(dir, 'data'),
    workspace: f.workspace || null,
    debug: false,
    dry: false,
    channel: { on, emit, closed },
    on,
    emit,
    closed,
  }

  const mod = (await import(pathToFileURL(serviceFile).href)) as { default?: unknown }
  if (typeof mod.default !== 'function') throw new Error(`${serviceFile}: нет default-экспорта-функции`)
  const done = Promise.resolve((mod.default as (c: unknown, m: unknown) => unknown)(ctx, meta))
  send({ event: '__ready' })

  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let msg: { id?: number; cmd?: string; params?: unknown; close?: boolean }
      try {
        msg = JSON.parse(line) as typeof msg
      } catch {
        continue
      }
      if (msg.close) {
        resolveClosed()
        continue
      }
      if (typeof msg.id !== 'number' || typeof msg.cmd !== 'string') continue
      const id = msg.id
      const h = handlers.get(msg.cmd)
      if (!h) {
        send({ id, ok: false, error: `unknown service command: ${msg.cmd}` })
        continue
      }
      Promise.resolve()
        .then(() => h(msg.params))
        .then(
          (value) => send({ id, ok: true, value: value === undefined ? null : value }),
          (e: unknown) => send({ id, ok: false, error: e instanceof Error ? e.message : String(e) }),
        )
    }
  })
  process.stdin.on('end', () => resolveClosed())
  await Promise.race([done, closed])
  // Сервис вернулся сам (без ожидания closed) — живём до закрытия канала.
  await closed
  process.exit(0)
}

main().catch((e: unknown) => {
  log(e instanceof Error ? (e.stack ?? e.message) : String(e))
  process.exit(1)
})
