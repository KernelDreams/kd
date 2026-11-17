/**
 * Манифест плагина любого веса (plugin-registry-spec §3, §5): что лежит в папке или файле и как его зовут.
 *
 *   code      вес 3 — `package.json` с полем `nrchat` (`id`, `api`, `places`, `files`), сборка `dist/index.js` в репе;
 *   artifact  вес 2 — папка с `meta.mdz` и/или `index.html` / `index.jsx` (шапка `meta.mdz`);
 *   file      вес 1 — `.mdz` с `## $form` или местом `$places` (шапка файла); репа веса 1 — папка с такими файлами в корне.
 *
 * Id: `nrchat.id` / `$id` шапки, иначе имя файла без `.mdz` или имя папки. Ошибки — словами (`PluginError`).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { hasFormSection, headerList, mdzHeader } from './mdz.js'

export type PluginWeight = 'file' | 'artifact' | 'code'

export interface PluginManifest {
  id: string
  weight: PluginWeight
  title?: string
  description?: string
  /** Диапазон версий Plugin API (`nrchat.api`, `$api`). */
  api?: string
  places?: string[]
  /** Kinds файлов, над которыми работает (`$handles`). */
  handles?: string[]
  icon?: string
  /** Версия из `package.json` (вес 3). */
  version?: string
  /** Вес 1: `.mdz` плагина (абсолютные пути); вес 2–3 — нет. */
  files?: string[]
  /** Вес 3: собран ли (`dist/index.js`). */
  built?: boolean
}

/** Ошибка установки / разбора — текст для человека, `code` — для тестов и провода. */
export class PluginError extends Error {
  constructor(
    message: string,
    readonly code: 'not_plugin' | 'not_built' | 'bad_id' | 'exists' | 'git' | 'not_found' | 'dirty' | 'no_history' | 'bad_request' = 'bad_request',
  ) {
    super(message)
    this.name = 'PluginError'
  }
}

/** Id плагина: буквы, цифры, `-`, `_` и `.` (издатель.имя); с буквы или цифры. */
export const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]*$/i

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

const read = (p: string): string | null => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const list = (v: unknown): string[] | undefined => {
  const out = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? headerList(v) : []
  return out.length ? out : undefined
}

function fromHeader(h: Record<string, string>): Omit<PluginManifest, 'id' | 'weight'> {
  return {
    ...(str(h.title) ? { title: str(h.title)! } : {}),
    ...(str(h.description) ? { description: str(h.description)! } : {}),
    ...(str(h.api) ? { api: str(h.api)! } : {}),
    ...(list(h.places) ? { places: list(h.places)! } : {}),
    ...(list(h.handles) ? { handles: list(h.handles)! } : {}),
    ...(str(h.icon) ? { icon: str(h.icon)! } : {}),
  }
}

/** Плагин-файл (вес 1): `.mdz` с `## $form`. Не он — `null`. */
export function fileManifest(file: string): PluginManifest | null {
  if (extname(file).toLowerCase() !== '.mdz') return null
  const text = read(file)
  if (text === null || !hasFormSection(text)) return null
  const h = mdzHeader(text)
  return { id: str(h.id) ?? basename(file, extname(file)), weight: 'file', ...fromHeader(h), files: [file] }
}

/** `.mdz` с формой в корне папки (без вложенных). */
export function formFiles(dir: string): string[] {
  let names: string[] = []
  try {
    names = readdirSync(dir).sort()
  } catch {
    return []
  }
  return names.filter((n) => !n.startsWith('.') && extname(n).toLowerCase() === '.mdz' && fileManifest(join(dir, n)) !== null).map((n) => join(dir, n))
}

/**
 * Манифест папки: код (package.json с `nrchat`), артефакт (`meta.mdz` / `index.html`), репа плагинов-файлов. Не плагин —
 * `null`. `fallbackId` — имя, если манифест его не задал (по умолчанию имя папки).
 */
export function dirManifest(dir: string, fallbackId = basename(dir)): PluginManifest | null {
  if (!isDir(dir)) return null
  const pkgText = read(join(dir, 'package.json'))
  if (pkgText !== null) {
    let pkg: Record<string, unknown> = {}
    try {
      pkg = JSON.parse(pkgText) as Record<string, unknown>
    } catch {
      // битый package.json — не код-плагин; ниже другие признаки
    }
    const nr = pkg.nrchat
    if (nr && typeof nr === 'object') {
      const n = nr as Record<string, unknown>
      const files = list(n.files)
      return {
        id: str(n.id) ?? fallbackId,
        weight: 'code',
        ...(str(n.title) ?? str(pkg.description) ? { title: str(n.title) ?? fallbackId } : {}),
        ...(str(pkg.description) ? { description: str(pkg.description)! } : {}),
        ...(str(n.api) ? { api: str(n.api)! } : {}),
        ...(list(n.places) ? { places: list(n.places)! } : {}),
        ...(str(n.icon) ? { icon: str(n.icon)! } : {}),
        ...(str(pkg.version) ? { version: str(pkg.version)! } : {}),
        ...(files ? { files } : {}),
        built: existsSync(join(dir, 'dist', 'index.js')),
      }
    }
  }
  const meta = read(join(dir, 'meta.mdz'))
  if (meta !== null || existsSync(join(dir, 'index.html')) || existsSync(join(dir, 'index.jsx'))) {
    const h = meta === null ? {} : mdzHeader(meta)
    return { id: str(h.id) ?? fallbackId, weight: 'artifact', ...fromHeader(h) }
  }
  const files = formFiles(dir)
  if (files.length === 0) return null
  const first = fileManifest(files[0]!)!
  // Один файл — его шапка и есть манифест (id — `$id` или имя файла); несколько — набор с id папки.
  return files.length === 1 ? first : { id: fallbackId, weight: 'file', ...(first.api ? { api: first.api } : {}), files }
}

/** Манифест файла или папки; не плагин — `null`. */
export function readManifest(path: string, fallbackId?: string): PluginManifest | null {
  return isDir(path) ? dirManifest(path, fallbackId) : fileManifest(path)
}
