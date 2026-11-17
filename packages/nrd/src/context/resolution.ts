// Plugin resolution (§6). Upward search от baseDir:
//   ./.nrd-context/sources|transforms/<name>.<ext>  → ... → stop-маркер / корень
//   → builtin.
// First-wins: локальный plugin перекрывает встроенный. Поиск по ФС — Node-only
// (ленивый import node:fs/path; в браузере просто пропускается → builtin).

import type { SourcePlugin, TransformPlugin } from './types.js'
import { builtinSources } from './builtins/index.js'

type Kind = 'sources' | 'transforms'

const STOP_MARKERS = ['.git', '.server']
const EXTS = ['ts', 'mts', 'js', 'mjs']

/** Ленивый доступ к node:fs/path. undefined → не-Node окружение. */
async function nodeFs(): Promise<{
  existsSync(p: string): boolean
  pathResolve(...p: string[]): string
  dirname(p: string): string
  join(...p: string[]): string
  toFileUrl(p: string): string
} | undefined> {
  try {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const url = await import('node:url')
    return {
      existsSync: (p: string) => fs.existsSync(p),
      pathResolve: (...p: string[]) => path.resolve(...p),
      dirname: (p: string) => path.dirname(p),
      join: (...p: string[]) => path.join(...p),
      toFileUrl: (p: string) => url.pathToFileURL(p).href,
    }
  } catch {
    return undefined
  }
}

/** Найти и импортировать локальный plugin по convention. undefined — нет такого. */
async function findLocal<T>(kind: Kind, name: string, baseDir: string): Promise<T | undefined> {
  const n = await nodeFs()
  if (!n) return undefined

  let dir = n.pathResolve(baseDir)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const ext of EXTS) {
      const file = n.join(dir, '.nrd-context', kind, `${name}.${ext}`)
      if (n.existsSync(file)) {
        const mod = await import(n.toFileUrl(file))
        const plugin = (mod.default ?? mod[name]) as T | undefined
        if (plugin) return plugin
      }
    }
    // stop-маркер на текущем уровне → дальше не идём
    if (STOP_MARKERS.some((m) => n.existsSync(n.join(dir, m)))) break
    const parent = n.dirname(dir)
    if (parent === dir) break // корень
    dir = parent
  }
  return undefined
}

/**
 * Резолв source-плагина по `$nr-type`.
 * Приоритет: explicit (opts.plugins) → локальный файл → builtin.
 */
export async function resolveSourcePlugin(
  name: string,
  baseDir: string,
  explicit: Record<string, SourcePlugin>,
): Promise<SourcePlugin | undefined> {
  if (explicit[name]) return explicit[name]
  const local = await findLocal<SourcePlugin>('sources', name, baseDir)
  if (local) return local
  return builtinSources[name]
}

/**
 * Резолв transform-плагина по `$nr-type`.
 * Приоритет: explicit (opts.transforms) → локальный файл. Встроенных transform
 * нет (модификация — дело потребителя/script).
 */
export async function resolveTransformPlugin(
  name: string,
  baseDir: string,
  explicit: Record<string, TransformPlugin>,
): Promise<TransformPlugin | undefined> {
  if (explicit[name]) return explicit[name]
  return findLocal<TransformPlugin>('transforms', name, baseDir)
}
