/**
 * Где живёт копия `kd` и её данные (kd-cli-spec §3, §10).
 *
 * - Системный `kd` (нет файла режима): общий слой — `~/.kd` (`KD_HOME` переносит).
 * - Режим копии — файл `kd-copy.mdz` рядом с копией: `$mode: installed` (читает общий слой,
 *   регистрируется) или `$mode: portable` (изолирована: данные и вопросы рядом, общий слой
 *   не читает — `$shared: read` включает чтение; регистрация — `$register: true`).
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as nrd from '@kerneldreams/nrd'

/** Корень пакета `@kerneldreams/kd` (комплект: `tools/`, `links.mdz`). */
/**
 * Корень комплекта kd (`dist/tools`, `links.mdz`, `kd-copy.mdz`). `KD_KIT_ROOT` — код kd собран в чужой бандл
 * (сервис сборки), а копия лежит отдельно: тогда корень — папка частной копии сборки.
 */
export const KIT_ROOT = process.env.KD_KIT_ROOT ? resolve(process.env.KD_KIT_ROOT) : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const expandHome = (p: string): string => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)

/** Корневые атрибуты файла mdz типизированными значениями; нет файла — `null`, битый — громко. */
export function readAttrs(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8')
  try {
    const json = nrd.toJson(nrd.parseDocument(text, { sigil: '$' })) as { root?: { attrs?: Array<[string[], unknown]> } }
    const out: Record<string, unknown> = {}
    for (const [p, v] of json.root?.attrs ?? []) out[p.join('.')] = v
    return out
  } catch (err) {
    throw new Error(`${file}: не разобран — ${(err as Error).message}`)
  }
}

export const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === 'string' && v.trim() ? v.replace(/^\$?\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean) : []

export type CopyMode = 'system' | 'installed' | 'portable'

export interface CopyInfo {
  mode: CopyMode
  /** Папка копии (где лежит файл режима); у системного — корень пакета. */
  root: string
  /** Общий слой `~/.kd` (или `KD_HOME`). */
  sharedHome: string
  /** Читает ли копия общий слой. */
  readsShared: boolean
  /** Пишет ли регистрацию в общий слой. */
  registers: boolean
  /** Своя папка данных: у системного — общий слой, у сборки — её папка. */
  dataDir: string
  /** Id сборки для регистрации. */
  appId?: string
}

/** Режим копии по файлу рядом с ней (`kd-copy.mdz` в корне пакета или в `KD_COPY_DIR`). */
export function copyInfo(env: NodeJS.ProcessEnv = process.env): CopyInfo {
  const sharedHome = resolve(expandHome(env.KD_HOME || join(homedir(), '.kd')))
  const root = env.KD_COPY_DIR ? resolve(env.KD_COPY_DIR) : KIT_ROOT
  const attrs = readAttrs(join(root, 'kd-copy.mdz'))
  if (!attrs) return { mode: 'system', root, sharedHome, readsShared: true, registers: false, dataDir: sharedHome }
  const mode = attrs.mode === 'portable' ? 'portable' : 'installed'
  const data = typeof attrs.data === 'string' && attrs.data ? attrs.data : mode === 'portable' ? 'data' : join(sharedHome, 'apps-data', String(attrs.id ?? 'app'))
  const dataDir = isAbsolute(expandHome(data)) ? expandHome(data) : resolve(root, data)
  return {
    mode,
    root,
    sharedHome,
    readsShared: mode === 'installed' || attrs.shared === 'read',
    registers: mode === 'installed' ? attrs.register !== false : attrs.register === true,
    dataDir,
    ...(typeof attrs.id === 'string' ? { appId: attrs.id } : {}),
  }
}

/** Ближайшая папка проекта `.kd/` вверх от cwd (не выше дома и не сам дом). */
export function projectDir(cwd: string): string | null {
  const stop = homedir()
  for (let d = resolve(cwd); ; d = dirname(d)) {
    if (d !== stop) {
      try {
        if (statSync(join(d, '.kd')).isDirectory()) return join(d, '.kd')
      } catch {
        // нет
      }
    }
    if (d === stop || dirname(d) === d) return null
  }
}
