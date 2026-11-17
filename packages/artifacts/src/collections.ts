/**
 * Коллекции и реестр (artifacts-spec §3).
 *
 * Коллекция — каталог с артефактами-подпапками, где угодно. Источники:
 *   - реестр — `$artifacts: <путь>[, <путь>…]` в `~/.runz/config.md` (как `$forms`);
 *   - рабочая область — `<каталог сессии>/.nr/artifacts/`, пока сессия открыта;
 *   - демо — `nrchat/artifacts-demo/`, всегда, только чтение.
 * `collection.mdz` в корне необязателен: `$id`, `$title`, `$description`,
 * `$default: true`. Id артефакта — `<коллекция>/<папка>`; ad-hoc папка вне
 * коллекций — её абсолютный путь.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { asText, isContext, parseDocument } from '@kerneldreams/nrd'
import type { IArray } from '@kerneldreams/nrd'
import { resolveIcon } from './icon.js'
import type { ArtifactIcon } from './icon.js'
import { parseManifest } from './manifest.js'
import type { ArtifactManifest, ArtifactWidget, Capability } from './manifest.js'

export type CollectionKind = 'registry' | 'workspace' | 'demo' | 'adhoc'

export interface Collection {
  id: string
  dir: string
  title: string
  description: string
  /** `$default: true` — сюда `artifact_init` кладёт новое, если не сказано иначе. */
  isDefault: boolean
  kind: CollectionKind
  readonly: boolean
  /** Папки артефактов, которых в коллекции не видно (перекрыты правкой-копией или без выбора источника). */
  hidden?: string[]
}

/**
 * Коллекция слоя плагинов (plugin-registry-spec §5–6): папка `plugins/` подключённого реестра (только чтение,
 * правка = копия) или папка пользователя. `hidden` — папки, перекрытые каскадом.
 */
export interface PluginCollection {
  dir: string
  id: string
  title?: string
  readonly?: boolean
}

export interface ArtifactInfo {
  /** `<коллекция>/<папка>`; ad-hoc — абсолютный путь папки. */
  id: string
  collection: string
  folder: string
  dir: string
  title: string
  description: string
  version: number
  uses: Capability[] | null
  /** `$handles` — kinds файлов, которые артефакт открывает вкладкой (open-spec §7); пусто — никакие. */
  handles: string[]
  /** `$places` — места артефакта-плагина (`panel`…); пусто — только свои входы. */
  places: string[]
  /** `$widget` — виджет поля универсального редактора; `null` — не виджет. */
  widget: ArtifactWidget | null
  /** `$icon` как написан в meta.mdz. */
  icon: string | null
  /** `$icon`, разрешённый для фронта (lucide или data-URL файла); `null` — дефолтная иконка. */
  iconRef: ArtifactIcon | null
  entry: 'html' | 'jsx' | null
  hasService: boolean
  readonly: boolean
  manifest: ArtifactManifest | null
  /** Битый манифест / нет входа — артефакт в списке, но не открывается. */
  error?: string
}

export interface RegistryOpts {
  /** Каталог сессии nrchat: его `.nr/artifacts/` — коллекция рабочей области. */
  workspace?: string | null
  /** Демо-коллекция (`nrchat/artifacts-demo`). */
  demoDir?: string | null
  /** Конфиг runz; default `~/.runz/config.md`. */
  configFile?: string
  /** Пути коллекций поверх реестра (тесты, явный список). */
  extra?: string[]
  /** Слой плагинов: коллекции реестров и папки пользователя со скрытыми папками. */
  plugins?: { collections: readonly PluginCollection[]; hidden: readonly string[] }
}

export const WORKSPACE_COLLECTION = join('.nr', 'artifacts')
export const MANIFEST = 'meta.mdz'
export const COLLECTION_MANIFEST = 'collection.mdz'

export function expandHome(p: string): string {
  if (p === '~') return homedir()
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

/** Корневые атрибуты NRD-файла как текст/список; нечитаемый файл — пусто. */
function readAttrs(file: string): Map<string, unknown> {
  const out = new Map<string, unknown>()
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return out
  }
  try {
    const attrs = parseDocument(text, { sigil: "$" }).cast("attrs") as IArray | undefined
    if (!attrs) return out
    for (const attr of attrs.iterate()) {
      if (!isContext(attr)) continue
      const key = attr.get(['key'])
      if (typeof key === 'string') out.set(key, attr.get(['value']))
    }
  } catch {
    // Битый конфиг — не повод не показать остальные коллекции: построчный разбор ниже.
    for (const line of text.split('\n')) {
      const m = /^\$([\w-]+)\s*:\s*(.*)$/.exec(line.trim())
      if (m) out.set(m[1]!, m[2]!)
    }
  }
  return out
}

function textOf(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v && typeof v === 'object' && typeof (v as IArray).iterate === 'function' && !isContext(v)) {
    return [...(v as IArray).iterate()].map((x) => asText(x as never) ?? '').join(', ')
  }
  return asText(v as never) ?? ''
}

/** Пути `$artifacts` конфига runz: `${root}` и `~` раскрыты, относительные — от `$root`. */
export function registryPaths(configFile = join(homedir(), '.runz', 'config.md')): string[] {
  const attrs = readAttrs(configFile)
  const raw = textOf(attrs.get('artifacts')).trim()
  if (!raw) return []
  const root = resolve(expandHome(textOf(attrs.get('root')).trim() || homedir()))
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\$\{root\}/g, root))
    .filter(Boolean)
    .map((s) => resolve(root, expandHome(s)))
}

function collectionOf(dir: string, kind: CollectionKind, fallbackId: string): Collection {
  const attrs = readAttrs(join(dir, COLLECTION_MANIFEST))
  const id = textOf(attrs.get('id')).trim() || fallbackId
  return {
    id,
    dir,
    title: textOf(attrs.get('title')).trim() || id,
    description: textOf(attrs.get('description')).trim(),
    isDefault: textOf(attrs.get('default')).trim().toLowerCase() === 'true',
    kind,
    readonly: kind === 'demo',
  }
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Все подключённые коллекции: рабочая область, реестр, демо. Id уникальны (коллизия — суффикс). */
export function listCollections(opts: RegistryOpts = {}): Collection[] {
  const out: Collection[] = []
  const seenDirs = new Set<string>()
  const add = (dir: string, kind: CollectionKind, fallbackId: string): void => {
    const abs = resolve(dir)
    if (seenDirs.has(abs) || !isDir(abs)) return
    seenDirs.add(abs)
    const c = collectionOf(abs, kind, fallbackId)
    let id = c.id
    for (let n = 2; out.some((o) => o.id === id); n++) id = `${c.id}-${n}`
    out.push({ ...c, id })
  }
  if (opts.workspace) add(join(opts.workspace, WORKSPACE_COLLECTION), 'workspace', basename(resolve(opts.workspace)) || 'workspace')
  for (const dir of [...registryPaths(opts.configFile), ...(opts.extra ?? [])]) add(dir, 'registry', basename(dir))
  // Слой плагинов: папка, уже подключённая `$artifacts` (комплект круга 1), получает id и скрытые слоя.
  const hidden = (opts.plugins?.hidden ?? []).map((h) => resolve(h))
  for (const pc of opts.plugins?.collections ?? []) {
    const abs = resolve(pc.dir)
    const have = out.find((c) => c.dir === abs)
    if (have) {
      have.hidden = hidden.filter((h) => dirname(h) === abs)
      continue
    }
    if (!isDir(abs)) continue
    seenDirs.add(abs)
    let id = pc.id
    for (let n = 2; out.some((o) => o.id === id); n++) id = pc.id + '-' + n
    const c = collectionOf(abs, 'registry', id)
    out.push({ ...c, id, ...(pc.title ? { title: pc.title } : {}), readonly: pc.readonly ?? false, hidden: hidden.filter((h) => dirname(h) === abs) })
  }
  if (opts.demoDir) add(opts.demoDir, 'demo', 'demo')
  return out
}

/** Какой файл — вход: ровно один из `index.html` / `index.jsx`. */
export function entryOf(dir: string): { entry: 'html' | 'jsx' | null; error?: string } {
  const html = existsSync(join(dir, 'index.html'))
  const jsx = existsSync(join(dir, 'index.jsx'))
  if (html && jsx) return { entry: null, error: 'два входа: index.html и index.jsx — нужен ровно один' }
  if (!html && !jsx) return { entry: null, error: 'нет входа: index.html или index.jsx' }
  return { entry: html ? 'html' : 'jsx' }
}

/** Прочитать папку артефакта. Ошибки — в `error`, не throw. */
export function readArtifact(dir: string, collection: Collection | null): ArtifactInfo {
  const folder = basename(dir)
  const id = collection ? `${collection.id}/${folder}` : resolve(dir)
  const base: ArtifactInfo = {
    id,
    collection: collection?.id ?? '',
    folder,
    dir: resolve(dir),
    title: folder,
    description: '',
    version: 0,
    uses: null,
    handles: [],
    places: [],
    widget: null,
    icon: null,
    iconRef: null,
    entry: null,
    hasService: existsSync(join(dir, 'service.ts')),
    readonly: collection?.readonly ?? false,
    manifest: null,
  }
  const { entry, error: entryError } = entryOf(dir)
  base.entry = entry
  let text: string
  try {
    text = readFileSync(join(dir, MANIFEST), 'utf8')
  } catch {
    return { ...base, error: `нет ${MANIFEST}` }
  }
  const m = parseManifest(text)
  if (!m.ok) return { ...base, error: m.line ? `${m.error} (строка ${m.line})` : m.error }
  const info: ArtifactInfo = {
    ...base,
    title: m.value.title,
    description: m.value.description,
    version: m.value.version,
    uses: m.value.uses,
    handles: m.value.handles,
    places: m.value.places,
    widget: m.value.widget,
    icon: m.value.icon,
    iconRef: resolveIcon(dir, m.value.icon),
    manifest: m.value,
  }
  return entryError ? { ...info, error: entryError } : info
}

/** Папки-артефакты коллекции: подкаталоги с `meta.mdz` или входом; скрытые — мимо. */
export function listCollection(c: Collection): ArtifactInfo[] {
  let names: string[]
  try {
    names = readdirSync(c.dir)
  } catch {
    return []
  }
  const out: ArtifactInfo[] = []
  for (const name of names.sort()) {
    if (name.startsWith('.') || name.startsWith('_')) continue
    const dir = join(c.dir, name)
    if (!isDir(dir) || c.hidden?.includes(dir)) continue
    if (!existsSync(join(dir, MANIFEST)) && !existsSync(join(dir, 'index.html')) && !existsSync(join(dir, 'index.jsx'))) continue
    out.push(readArtifact(dir, c))
  }
  return out
}

export function listArtifacts(collections: Collection[], collection?: string): ArtifactInfo[] {
  return collections.filter((c) => !collection || c.id === collection).flatMap(listCollection)
}

const inside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Ссылка → артефакт: id `<коллекция>/<папка>` либо путь к папке (абсолютный,
 * `~/…`, относительный от `cwd`). Путь внутри подключённой коллекции получает
 * её id; вне — ad-hoc (вырожденная коллекция из одного).
 */
export function resolveArtifact(ref: string, collections: Collection[], cwd = process.cwd()): ArtifactInfo | null {
  const trimmed = ref.trim()
  if (!trimmed) return null
  const looksLikePath = isAbsolute(trimmed) || trimmed.startsWith('~') || trimmed.startsWith('.') || trimmed.includes(sep + sep)
  if (!looksLikePath) {
    const slash = trimmed.indexOf('/')
    if (slash > 0) {
      const c = collections.find((x) => x.id === trimmed.slice(0, slash))
      const folder = trimmed.slice(slash + 1)
      if (c && folder && !folder.includes('/')) {
        const dir = join(c.dir, folder)
        return isDir(dir) ? readArtifact(dir, c) : null
      }
    }
  }
  const dir = resolve(cwd, expandHome(trimmed))
  if (!looksLikePath && !trimmed.includes('/') && !existsSync(join(dir, MANIFEST))) {
    // Голое имя папки (`ref-sheet`, `exz --artifact comfy`) — слабые модели так и
    // зовут: однозначное по всем коллекциям годится. Одноимённый каталог cwd без
    // meta.mdz (`~/Studio/envs/comfy` рядом с `.nr/artifacts/comfy`) — не артефакт.
    const hits = collections.filter((c) => isDir(join(c.dir, trimmed)))
    if (hits.length === 1) return readArtifact(join(hits[0]!.dir, trimmed), hits[0]!)
  }
  if (!isDir(dir)) return null
  const owner = collections.find((c) => resolve(dirname(dir)) === c.dir && inside(dir, c.dir))
  return readArtifact(dir, owner ?? null)
}
