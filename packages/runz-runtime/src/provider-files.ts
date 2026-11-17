/**
 * @kerneldreams/runz-runtime — провайдеры файлами.
 *
 * Новый `$type` блока `## $provider <имя>` — файл `<type>.ts` (`.mjs`, `.js`) в папке
 * провайдеров, без правки runz. Контракты — существующие: файл отдаёт фабрику
 * `(cfg, ctx) => ImageProvider | StreamProvider` (`@kerneldreams/nrd/contracts` /
 * `@kerneldreams/nrd/node`) и объявляет вид:
 *
 *   export const kind = 'image'            // 'image' | 'video' | 'audio' — медиа, 'llm' — текст
 *   export default function (cfg, ctx) { return { generate(req) { … } } }
 *
 * `cfg` — `resolveProviderConfig` блока (`baseUrl`, `apiKey`, `type`, `timeout`, `think`)
 * плюс `name` — имя блока; прочие атрибуты блока — `ctx.get(['provider', cfg.name, '<ключ>'])`.
 *
 * Папки — `$providers_dir` цепочки (список); нет — `<стенд>/providers/` (каталог
 * ближайшего к cwd `.runz/`), `~/.runz/providers/`, затем образцы пакета
 * (`src/providers/`: `a1111`). Первая папка с файлом выигрывает; файл с именем
 * встроенного типа его перекрывает.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { asText } from '@kerneldreams/nrd'
import type { IContext } from '@kerneldreams/nrd'
import type { ProviderConfig } from '@kerneldreams/engine'
import { builtinProvidersDir } from './home.ts'
import { nearestEnvDir, userEnvDir } from './envs.ts'

/** Расширения файла провайдера — по приоритету. */
export const PROVIDER_FILE_EXTS = ['.ts', '.mjs', '.js'] as const

/** Виды провайдера-файла: медиа (контракт `ImageProvider`) и текст (`StreamProvider`). */
export const MEDIA_KINDS = ['image', 'video', 'audio'] as const
export const LLM_KIND = 'llm'

/** Конфиг, который получает фабрика файла: блок `## $provider` + его имя. */
export type ProviderFileConfig = ProviderConfig & { name: string }

/** Фабрика провайдера-файла (`export default`). */
export type ProviderFactory<P = unknown> = (cfg: ProviderFileConfig, ctx: IContext) => P | Promise<P>

/** Найденный файл провайдера. */
export interface ProviderFile {
  type: string
  path: string
}

const TYPE_RE = /^[\w.-]+$/

const expandHome = (p: string): string => (p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p)

function textList(v: unknown): string[] {
  if (v === undefined || v === null) return []
  if (typeof v === 'object' && 'iterate' in v) {
    return [...(v as { iterate(): Iterable<unknown> }).iterate()].map((x) => asText(x as never) ?? '').filter(Boolean)
  }
  const t = asText(v as never)
  return t ? [t] : []
}

/**
 * Папки провайдеров по приоритету: `$providers_dir` цепочки, иначе
 * `<стенд>/providers`, `~/.runz/providers`, образцы пакета. Несуществующие — отброшены.
 */
export function providerDirs(ctx: IContext, cwd: string = process.cwd()): string[] {
  const explicit = textList(ctx.get(['providers_dir'])).map((p) => resolve(cwd, expandHome(p)))
  let dirs = explicit
  if (!dirs.length) {
    const user = userEnvDir()
    const env = nearestEnvDir(cwd)
    const stand = existsSync(env) && env !== user ? join(dirname(env), 'providers') : undefined
    dirs = [...(stand ? [stand] : []), join(user, 'providers'), builtinProvidersDir()]
  }
  return [...new Set(dirs)].filter((d) => existsSync(d))
}

/** Файл провайдера типа `type` в папках (первая выигрывает); нет — `undefined`. */
export function findProviderFile(dirs: string[], type: string | undefined): ProviderFile | undefined {
  if (!type || !TYPE_RE.test(type)) return undefined
  for (const d of dirs) {
    for (const ext of PROVIDER_FILE_EXTS) {
      const path = join(d, type + ext)
      if (existsSync(path)) return { type, path }
    }
  }
  return undefined
}

/** Все файлы провайдеров в папках: тип → файл (ближняя папка выигрывает). */
export function listProviderFiles(dirs: string[]): ProviderFile[] {
  const seen = new Map<string, ProviderFile>()
  for (const d of dirs) {
    let names: string[]
    try {
      names = readdirSync(d)
    } catch {
      continue
    }
    for (const ext of PROVIDER_FILE_EXTS) {
      for (const f of names) {
        if (extname(f) !== ext || f.endsWith('.d.ts')) continue
        const type = basename(f, ext)
        if (TYPE_RE.test(type) && !seen.has(type)) seen.set(type, { type, path: join(d, f) })
      }
    }
  }
  return [...seen.values()]
}

const KIND_RE = /export\s+const\s+kind\b[^=]*=\s*(\[[^\]]*\]|'[^']*'|"[^"]*")/

/**
 * Виды файла без импорта — по тексту `export const kind = …` (нужно синхронному
 * `listImageProviders`). Не нашли — `[]`.
 */
export function providerFileKinds(path: string): string[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const m = KIND_RE.exec(text)
  return m ? [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]) : []
}

/** Файл — медиа-провайдер (картинки/видео/звук). */
export const isMediaFile = (path: string): boolean => providerFileKinds(path).some((k) => (MEDIA_KINDS as readonly string[]).includes(k))

/** Файл — LLM-провайдер. */
export const isLlmFile = (path: string): boolean => providerFileKinds(path).includes(LLM_KIND)

/**
 * Загрузить файл и собрать провайдер: проверка `kind` (`want`), фабрики и того, что
 * фабрика вернула (`method` — `generate` / `stream`). Любой сбой — ошибка с путём.
 */
export async function loadProviderFile<P>(
  file: ProviderFile,
  cfg: ProviderFileConfig,
  ctx: IContext,
  want: 'media' | 'llm',
): Promise<P> {
  const fail = (why: string): Error => new Error(`runz: провайдер-файл ${file.path} ($type: ${file.type}) — ${why}`)
  let mod: Record<string, unknown>
  try {
    mod = (await import(pathToFileURL(file.path).href)) as Record<string, unknown>
  } catch (e) {
    throw fail(`не загрузился: ${e instanceof Error ? e.message : String(e)}`)
  }
  const kinds = (Array.isArray(mod.kind) ? mod.kind : [mod.kind]).filter((k): k is string => typeof k === 'string')
  if (!kinds.length) throw fail(`нет export const kind ('image' | 'video' | 'audio' | 'llm')`)
  const ok = want === 'llm' ? kinds.includes(LLM_KIND) : kinds.some((k) => (MEDIA_KINDS as readonly string[]).includes(k))
  if (!ok) throw fail(`kind ${kinds.join(', ')} — нужен ${want === 'llm' ? "'llm'" : "'image' | 'video' | 'audio'"}`)
  const factory = mod.default
  if (typeof factory !== 'function') throw fail('нет фабрики: export default (cfg, ctx) => провайдер')
  let provider: unknown
  try {
    provider = await (factory as ProviderFactory)(cfg, ctx)
  } catch (e) {
    throw fail(`фабрика упала: ${e instanceof Error ? e.message : String(e)}`)
  }
  const method = want === 'llm' ? 'stream' : 'generate'
  if (!provider || typeof (provider as Record<string, unknown>)[method] !== 'function') {
    throw fail(`фабрика вернула не ${want === 'llm' ? 'StreamProvider' : 'ImageProvider'} (нет ${method}())`)
  }
  return provider as P
}
