// Чтение файла с развёрнутыми `$[[path]]`-инклюдами — одно на ступень Node.
//
// Путь инклюда резолвится от папки файла, в котором он написан (не от
// корневого документа): на этом стоят конфиг-слои system ← campaign ← session.
// Инклюд без расширения ищется как есть, затем с .mdz/.md/.mdd/.mds.
// Цикл — IncludeCycleError с цепочкой, не молчаливое обрезание.

import { existsSync, statSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { resolveIncludes } from '../core/index.js'
import { readTextSync } from './fs.js'

/** Расширения, подставляемые инклюду без расширения — в порядке пробы. */
export const INCLUDE_EXTENSIONS: readonly string[] = ['.mdz', '.md', '.mdd', '.mds']

function isFile(p: string): boolean {
  return existsSync(p) && statSync(p).isFile()
}

/** Абсолютный путь инклюда: как есть, затем с подставленным расширением. */
function locate(target: string, fromDir: string): string {
  const p = resolve(fromDir, target)
  if (extname(p) || isFile(p)) return p
  for (const ext of INCLUDE_EXTENSIONS) {
    if (isFile(p + ext)) return p + ext
  }
  return p
}

export interface ReadIncludesOptions {
  /**
   * Запасные папки: инклюд, не найденный от папки включающего файла, ищется
   * в них по очереди (comfy: `workflows/` приложения для профилей).
   */
  fallbackDirs?: readonly string[]
  /** Каждый прочитанный инклюд (абсолютный путь) — кто включён (профили `preset`: папки поиска). */
  onRead?: (file: string) => void
}

/** Путь инклюда: от папки включающего, затем по запасным папкам; не нашёлся — первый. */
function locateWithFallback(target: string, fromDir: string, fallbackDirs: readonly string[]): string {
  const primary = locate(target, fromDir)
  if (isFile(primary)) return primary
  for (const dir of fallbackDirs) {
    const p = locate(target, dir)
    if (isFile(p)) return p
  }
  return primary
}

/**
 * Прочитать файл, развернув `$[[path]]`-инклюды по цепочке.
 *
 * `baseDir` — от чего резолвятся инклюды самого файла (по умолчанию его
 * папка); вложенные — всегда от папки включающего файла, затем
 * `opts.fallbackDirs`. Не найденный инклюд остаётся как есть с
 * предупреждением в stderr; цикл — бросает.
 */
export function readTextWithIncludes(
  file: string,
  baseDir?: string,
  tag = '[nrd]',
  opts: ReadIncludesOptions = {},
): string {
  const fallback = opts.fallbackDirs ?? []
  const root = resolve(file)
  const rootDir = baseDir !== undefined ? resolve(baseDir) : dirname(root)
  return resolveIncludes(
    readTextSync(root),
    (p) => {
      try {
        const text = readTextSync(p)
        opts.onRead?.(p)
        return text
      } catch (e) {
        // Молча выпавший инклюд = невидимо искалеченный документ.
        process.stderr.write(`${tag} include failed: ${p} — ${(e as Error).message}\n`)
        return undefined
      }
    },
    {
      from: root,
      resolvePath: (target, from) =>
        locateWithFallback(target, from === root || from === undefined ? rootDir : dirname(from), fallback),
      onCycle: 'throw',
    },
  )
}
