/**
 * @kerneldreams/runz-runtime — расширения файлами.
 *
 * Открытое ядро объявляет точки расширения (слоты), реализацию подаёт установка: хост в процессе —
 * `registerExtension(слот, модуль)`, командная строка — файл `<слот>.ts` (`.mjs`, `.js`) в папке
 * расширений. Слоты:
 *
 *   agent — цикл агента: `createAgent(opts) → HelperAgent` (`helpers.agent`, `kd agent`),
 *           необязательно `cardCodec` — кодек карты персоны для драйвера nr-chat;
 *   acp   — ACP-агент на stdio: `createAcpAgent(backend, opts)`, `serveAcpStdio(app)` (`kd acp`).
 *
 * Папки — по порядку: `KD_EXTENSIONS` (пути через `:`), `$extensions_dir` цепочки (список),
 * `<стенд>/extensions/` (каталог ближайшего к cwd `.runz/`), `~/.runz/extensions/`. Первая папка с
 * файлом выигрывает. Нет расширения — `requireExtension` бросает понятную ошибку, импорт ядра не падает.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { asText } from '@kerneldreams/nrd'
import type { IContext } from '@kerneldreams/nrd'
import { nearestEnvDir, userEnvDir } from './envs.ts'

/** Известные слоты и что в них ждут — для сообщения об ошибке. */
export const EXTENSION_SLOTS: Record<string, string> = {
  agent: 'агент (цикл с тулами: createAgent)',
  acp: 'ACP-агент (createAcpAgent, serveAcpStdio)',
}

const EXTS = ['.ts', '.mjs', '.js'] as const
const SLOT_RE = /^[\w.-]+$/

const registered = new Map<string, unknown>()
const loaded = new Map<string, Promise<unknown>>()

/** Подать реализацию слота из процесса (хост, тест). `undefined` — снять. */
export function registerExtension(slot: string, mod: unknown): void {
  if (mod === undefined) registered.delete(slot)
  else registered.set(slot, mod)
  loaded.delete(slot)
}

const expandHome = (p: string): string => (p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p)

function textList(v: unknown): string[] {
  if (v === undefined || v === null) return []
  if (typeof v === 'object' && 'iterate' in v) {
    return [...(v as { iterate(): Iterable<unknown> }).iterate()].map((x) => asText(x as never) ?? '').filter(Boolean)
  }
  const t = asText(v as never)
  return t ? [t] : []
}

/** Папки расширений по приоритету; несуществующие отброшены. */
export function extensionDirs(ctx?: IContext, cwd: string = process.cwd()): string[] {
  const env = (process.env.KD_EXTENSIONS ?? '').split(delimiter).filter(Boolean)
  const explicit = ctx ? textList(ctx.get(['extensions_dir'])) : []
  const user = userEnvDir()
  const near = nearestEnvDir(cwd)
  const stand = existsSync(near) && near !== user ? join(dirname(near), 'extensions') : undefined
  const dirs = [...env, ...explicit].map((p) => resolve(cwd, expandHome(p)))
  if (stand) dirs.push(stand)
  dirs.push(join(user, 'extensions'))
  return [...new Set(dirs)].filter((d) => existsSync(d))
}

/** Файл слота в папках (первая выигрывает). */
export function findExtensionFile(dirs: string[], slot: string): string | undefined {
  if (!SLOT_RE.test(slot)) return undefined
  for (const d of dirs) {
    for (const ext of EXTS) {
      const f = join(d, slot + ext)
      if (existsSync(f)) return f
    }
  }
  return undefined
}

/** Реализация слота: поданная из процесса, иначе файл; нет — `undefined`. Ошибка загрузки файла — громкая. */
export async function loadExtension<T = Record<string, unknown>>(slot: string, opts: { ctx?: IContext; cwd?: string } = {}): Promise<T | undefined> {
  if (registered.has(slot)) return registered.get(slot) as T
  const file = findExtensionFile(extensionDirs(opts.ctx, opts.cwd), slot)
  if (!file) return undefined
  let p = loaded.get(file)
  if (!p) {
    p = import(pathToFileURL(file).href).catch((err: unknown) => {
      loaded.delete(file)
      const why = err instanceof Error ? err.message.split('\n')[0] : String(err)
      throw new Error(`расширение ${slot} (${file}) не загрузилось: ${why}`)
    })
    loaded.set(file, p)
  }
  return (await p) as T
}

/** Ошибка «расширение не установлено» — отличима от прочих (`code`). */
export class ExtensionMissingError extends Error {
  readonly code = 'KD_EXTENSION_MISSING'
  constructor(readonly slot: string, what: string) {
    const kind = EXTENSION_SLOTS[slot] ?? slot
    super(
      `${what}: ${kind} не установлен — нет расширения «${slot}». ` +
        `Положи файл ${slot}.mjs в ~/.runz/extensions/ (или в папку из $extensions_dir / KD_EXTENSIONS), ` +
        `который отдаёт реализацию слота.`,
    )
    this.name = 'ExtensionMissingError'
  }
}

/** Реализация слота или `ExtensionMissingError`. */
export async function requireExtension<T = Record<string, unknown>>(slot: string, what: string, opts: { ctx?: IContext; cwd?: string } = {}): Promise<T> {
  const mod = await loadExtension<T>(slot, opts)
  if (mod === undefined) throw new ExtensionMissingError(slot, what)
  return mod
}
