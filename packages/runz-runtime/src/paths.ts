/**
 * @kerneldreams/runz-runtime — path normalization
 *
 * Единственное место, где пути из цепочки конфигов (`$paths`, `$dataDir`,
 * `--runz-config`, явный путь скрипта) приводятся к абсолютным. Ведущий `~`
 * раскрывается в домашнюю директорию, поэтому один и тот же
 * `~/.runz/config.md` работает на всех машинах.
 *
 * `~user` не поддерживается. `~` не в начале строки — обычный символ.
 */

import * as os from 'node:os'
import * as path from 'node:path'
import { isArray, asText } from '@kerneldreams/nrd'
import type { Value } from '@kerneldreams/nrd'

/** Раскрыть ведущий `~`, `~/`, `~\` в `os.homedir()`. Остальное — как есть. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (/^~[/\\]/.test(p)) return path.join(os.homedir(), p.slice(2))
  return p
}

/**
 * Путь из цепочки → абсолютный: `~` раскрыт, относительный резолвится
 * от `base`.
 */
export function resolvePath(p: string, base: string): string {
  return path.resolve(base, expandHome(p))
}

/**
 * Значение `$paths` → список абсолютных директорий. Принимает массив (JS или
 * IArray) либо строку со списком через запятую.
 */
export function parsePathList(v: Value, base: string): string[] {
  if (v === undefined || v === null) return []
  let raw: string[]
  if (Array.isArray(v)) raw = v.map(item => asText(item) ?? String(item))
  else if (isArray(v)) raw = [...v.iterate()].map(item => asText(item) ?? String(item))
  else raw = (asText(v) ?? String(v)).split(',')
  return raw
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => resolvePath(s, base))
}
