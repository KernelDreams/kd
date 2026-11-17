/**
 * Сервис ядра `objects` (v1.49, nrchat.dev/specs/objects-spec.md §2–3, §6): типы
 * данными (`<id>.mdz` с `$type: object-type`) и файловый источник записей.
 *
 * Движок без кодеков картинок и без шаблонизатора: кодеки форматов (`ccv3`, `json`, `md`
 * встроены), рендер ntpl, импортёры и провайдеры связей приходят опциями — их даёт
 * `service.ts` плагина `objects` nrchat (там nrd и nr-cards). Здесь — разбор и валидатор
 * типа, строки списка, поиск text-режимом, фасеты, CRUD с корзиной `.nr-trash`, копии со
 * ссылкой на источник, обратные ссылки, история git, слежение.
 *
 *   import { createObjectsService } from './objects.js'
 *   export default createObjectsService({ typeDirs: (meta) => [join(meta.root, 'types')], … })
 */

import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { watchTree, type TreeWatch } from './watch-tree.js'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { parse, serialize } from '@kerneldreams/nrd/md'
import type {
  ObjectDoc,
  ObjectLink,
  ObjectListResult,
  ObjectQuery,
  ObjectRevision,
  ObjectRow,
  ObjectSaveResult,
  ObjectSourceRef,
  ObjectStates,
  ObjectStoreInfo,
  ObjectTemplateView,
  ObjectTypeError,
  ObjectTypeInfo,
  ObjectEditorInfo,
  ObjectTypesResult,
} from '@kerneldreams/ui-protocol'
import type { ServiceMeta, ServiceSink } from '@kerneldreams/ui-protocol/service'
import { TYPE_TYPE, createTypeType } from './objects-meta.js'
import {
  assetsDir,
  colorOf,
  coverInputs,
  coverStateOf,
  hueName,
  listCoverStyles,
  parseColorRule,
  parseCoverRule,
  parseSlices,
  readCoverStyle,
  readSidecar,
  refFiles,
  writeSidecar,
  type ColorRuleDef,
  type CoverGenerator,
  type CoverRule,
} from './objects-cover.js'

const run = promisify(execFile)

// ────────────────────────────────────────────────────────────────────────────
// Опции
// ────────────────────────────────────────────────────────────────────────────

/** Кодек формата файлового источника (`$format`). */
export interface ObjectCodec {
  /** Расширение по умолчанию (`.json`). */
  ext: string
  /** Байты → поля (и сырой текст для «Как текст»). */
  read(bytes: Buffer): { data: Record<string, unknown>; raw?: string }
  /** Поля → байты; `prev` — что лежало (чужие поля обёртки сохраняются). */
  write(data: Record<string, unknown>, prev: Buffer | null): Buffer | string
}

/** Импорт файла в коллекцию типа (`action import`): байты → поля и, если есть, картинка. */
export type ObjectImporter = (file: { name: string; mime: string; bytes: Buffer }) =>
  | { data: Record<string, unknown>; avatar?: { ext: string; bytes: Buffer } }
  | Promise<{ data: Record<string, unknown>; avatar?: { ext: string; bytes: Buffer } }>

/** Экспорт объекта (`action export`): формат → файл для «Скачать». */
export type ObjectExporter = (doc: { data: Record<string, unknown>; avatar: Buffer | null }, format: string) =>
  | { name: string; mime: string; bytes: Buffer }
  | Promise<{ name: string; mime: string; bytes: Buffer }>

/**
 * Читатель вида хранилища (`$layout`, rp-build-spec §13.1): записи не файлами кодека типа, а своим форматом —
 * папка StoryForge с `bot.md`, выход bot-fix. Хранилище такого вида только читается: запись берётся копией.
 */
export interface ObjectLayout {
  /** Записи под корнем хранилища: id (путь от корня) и главный файл (по нему mtime и кэш). */
  scan(root: string): Array<{ id: string; file: string }>
  /** Главный файл → поля типа (у `ccv3` — `data` карточки). */
  read(file: string): Record<string, unknown>
  /** Картинка записи. */
  avatar?(file: string): string | null
}

/** Провайдер ссылок `$links` (`sessions.personas`): кто ссылается на объект. */
export type ObjectLinkProvider = (target: { type: string; id: string; data: Record<string, unknown> }, ctx: unknown) => ObjectLink[] | Promise<ObjectLink[]>

export interface ObjectsServiceOpts {
  /** Каталоги типов от младшего к старшему: позже — перебивает по id (стенд над плагинами). */
  typeDirs(meta: ServiceMeta, ctx: unknown): string[]
  /** Макрос `$paths` (`$personas`) → значение цепочки; нет — `undefined`. */
  vars?(name: string, ctx: unknown): unknown
  /** Кодеки сверх встроенных (`ccv3`, `json`, `md`). */
  codecs?: Record<string, ObjectCodec>
  /** Читатели `$layout` хранилищ (`storyforge`, `bot-fix`). */
  layouts?: Record<string, ObjectLayout>
  /** Рендер ntpl: шаблон + данные → строка. Нет — `$subtitle`/виды-шаблоны пустые. */
  render?(template: string, data: Record<string, unknown>): string
  /** Импортёры по `$import` типа или по `$format` (`ccv3` — PNG-карточка). */
  importers?: Record<string, ObjectImporter>
  exporters?: Record<string, ObjectExporter>
  links?: Record<string, ObjectLinkProvider>
  /** Генератор обложек (`## $cover`, §19.2): ставит работу, файлы кладёт по готовности. Нет — действия `cover` нет. */
  cover?: CoverGenerator
  /** Каталоги стилей обложек от младшего к старшему; default — `<корень стенда>/cover-styles`. */
  coverStyleDirs?(meta: ServiceMeta, ctx: unknown): string[]
  /** Слежение за каталогами (`watch`). Default — да. */
  watch?: boolean
}

// ────────────────────────────────────────────────────────────────────────────
// Тип
// ────────────────────────────────────────────────────────────────────────────

/** Тип с тем, что фронту не отдаётся: каталоги, шаблоны строки, файлы видов. */
export interface ObjectTypeDef extends ObjectTypeInfo {
  dirs: string[]
  /** Маска внутри каталога (`*`, `**`, `?` — например `<папка>/CARD.mdz`), параллельно `dirs`; `null` — все файлы `$ext` вглубь. */
  masks: Array<string | null>
  /** Хранилище каталога (id из `stores`), параллельно `dirs`; `null` — безымянный каталог. */
  dirStores?: Array<string | null>
  /** Откуда id (`$id_from`): путь от каталога без расширения (по умолчанию), папка, имя файла, поле. */
  idFrom: { kind: 'path' | 'dir' | 'file' | 'field'; field?: string }
  /** Колонки и порядок оглавления (`$index_columns`, `$index_sort: -поле`). */
  indexColumns: string[]
  indexSort?: string
  subtitleTpl?: string
  avatarTpl?: string
  badgeFields: string[]
  importer?: string
  templateFiles: Record<string, string>
  /** Виды-редакторы из `$views: <вид>=<редактор>` (до разрешения файлов). */
  editorRefs: Array<{ view: string; id: string }>
  /** Поля из `$fields` (свой тип без кода, §18): из них — схема, если нет `$schema`. */
  fields?: TypeField[]
  /** `$color` с палитрой (§19.1). */
  colorRule?: ColorRuleDef
  /** `## $cover` с шаблоном промпта (§19.2). */
  coverRule?: CoverRule
  /**
   * Поля новой записи (`$defaults: book=true, template=slot`): `create` дописывает те, что не заданы, —
   * «＋» в списке слотов рождает книгу, а не голую карточку. В схему и инспектор не попадают.
   */
  defaults?: Record<string, string>
}

/** Поле своего типа: `$fields: title:string=Название, pages:number=Страниц`. */
export interface TypeField {
  name: string
  type: 'string' | 'text' | 'number' | 'integer' | 'boolean'
  title?: string
}
const FIELD_TYPES = new Set(['string', 'text', 'number', 'integer', 'boolean'])

/** `$fields` → поля; ошибка — строкой. */
export function parseFields(raw: string): TypeField[] | string {
  const out: TypeField[] = []
  for (const item of list(raw)) {
    const m = /^([A-Za-z_][\w-]*)\s*(?::\s*([a-z]+))?\s*(?:=\s*(.+))?$/.exec(item)
    if (!m) return `\`$fields\`: «${item}» — <поле>:<тип>=<подпись>`
    const type = (m[2] ?? 'string') as TypeField['type']
    if (!FIELD_TYPES.has(type)) return `\`$fields\`: «${item}» — тип ${[...FIELD_TYPES].join(' | ')}`
    out.push({ name: m[1]!, type, ...(m[3]?.trim() ? { title: m[3].trim() } : {}) })
  }
  return out
}

/** Поля → `$fields`. */
export function formatFields(fields: readonly TypeField[]): string {
  return fields.map((f) => `${f.name}:${f.type}${f.title ? `=${f.title.replace(/,/g, ' ')}` : ''}`).join(', ')
}

/** Схема из полей: id-поле обязательно, `text` — многострочная строка. */
export function schemaOfFields(fields: readonly TypeField[], idField: string): Record<string, unknown> {
  const properties: Record<string, unknown> = { [idField]: { type: 'string', title: 'Имя' } }
  for (const f of fields) {
    if (f.name === idField) continue
    properties[f.name] = {
      type: f.type === 'text' ? 'string' : f.type,
      ...(f.title ? { title: f.title } : {}),
      ...(f.type === 'text' ? { 'x-ui': { widget: 'textarea' } } : {}),
    }
  }
  return { type: 'object', properties, required: [idField] }
}

const KNOWN_KEYS = new Set([
  'type', 'id', 'title', 'icon', 'source', 'paths', 'format', 'ext', 'schema', 'id_field', 'title_field', 'subtitle',
  'avatar', 'badges', 'columns', 'search', 'filters', 'sort', 'actions', 'import', 'links', 'views', 'version', 'service', 'parent',
  'id_from', 'states', 'state_labels', 'state_args', 'state_field', 'waiting', 'index', 'index_columns', 'index_sort',
  'fields', 'color', 'color_steps', 'palette', 'defaults',
])
const GLOB = /[*?[]/

/** `база/маска` → каталог и маска (первый сегмент с `*`, `?`, `[` и всё после). */
function splitMask(p: string): { base: string; mask: string | null } {
  const parts = p.split('/')
  const i = parts.findIndex((x) => GLOB.test(x))
  if (i < 0) return { base: p, mask: null }
  return { base: parts.slice(0, i).join('/') || '.', mask: parts.slice(i).join('/') }
}

/** Маска пути (`*`, `?`, `**`) → RegExp по относительному пути с `/`. */
export function maskRe(mask: string): RegExp {
  let re = ''
  for (let i = 0; i < mask.length; i++) {
    const c = mask[i]!
    if (c === '*' && mask[i + 1] === '*') {
      re += mask[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += mask[i + 2] === '/' ? 2 : 1
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/** `ready → accepted | returned; accepted → sent` (или `->`) → переходы. */
export function parseStates(raw: string): Record<string, string[]> | string {
  const out: Record<string, string[]> = {}
  for (const part of raw.split(';').map((x) => x.trim()).filter(Boolean)) {
    const m = /^([\w-]+)\s*(?:→|->)\s*(.+)$/.exec(part)
    if (!m) return `\`$states\`: «${part}» — нужно «из → в | в»`
    out[m[1]!] = [...(out[m[1]!] ?? []), ...m[2]!.split('|').map((x) => x.trim()).filter(Boolean)]
  }
  return out
}

/** `a=x, b=y` → {a: 'x', b: 'y'}; `a=x|y` у аргументов — список. */
function pairs(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of list(raw)) {
    const i = p.indexOf('=')
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim()
  }
  return out
}
const SOURCES = new Set(['files', 'service', 'protocol'])
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/

/** Значение атрибута: кавычки сняты, хвостовой ` # коммент` у голого значения — тоже. */
function scalar(raw: unknown): string {
  const s = String(raw ?? '').trim()
  if (/^".*"$/.test(s) || /^'.*'$/.test(s)) return s.slice(1, -1)
  return s.replace(/\s+#\s.*$/, '').trim()
}

const list = (raw: unknown): string[] =>
  scalar(raw)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

function expandHome(p: string): string {
  if (p === '~') return homedir()
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

/** Простой объект (не звено цепочки runz): блоки `## $bots` разворачивает сервис, движок их сам не читает. */
const isPlain = (v: unknown): v is Record<string, unknown> => isRecord(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)

/** `{mine: {path, layout}, lab: {…}}` — карта хранилищ по id; один блок с `$path` — сам по себе. */
const storesOfMap = (v: Record<string, unknown>): unknown[] =>
  'path' in v || 'source' in v || 'host' in v ? [v] : Object.entries(v).map(([id, x]) => (isRecord(x) ? { id, ...x } : { id, path: x }))

const yes = (v: unknown): boolean => v === true || /^(true|yes|1|да)$/i.test(scalar(v))

/** Своя машина: `$host` хранилища совпадает с ней (или `local`) — папка читается здесь же. */
export function localHost(h: string): boolean {
  const me = hostname().toLowerCase().replace(/\..*$/, '')
  const x = h.toLowerCase().replace(/\..*$/, '')
  return x === '' || x === 'local' || x === 'localhost' || x === me
}

/**
 * Блок хранилища (`## $bots mine`: `$id` — имя блока, `$path`, `$host`, `$source: service:<id>`, `$layout`,
 * `$readonly`, `$title`, `$group`) → полка типа и каталог, если записи читаются здесь.
 */
export function storeOf(x: Record<string, unknown>, abs: (p: string) => string): { info: ObjectStoreInfo; dir?: string } | null {
  const id = scalar(x.id)
  if (!id || !/^[\w.-]+$/.test(id)) return null
  const title = scalar(x.title) || id
  const layout = scalar(x.layout)
  const group = scalar(x.group)
  const host = scalar(x.host)
  const src = scalar(x.source)
  const info: ObjectStoreInfo = { id, title, ...(layout ? { layout } : {}), ...(group ? { group } : {}) }
  const m = /^service:([\w.-]+)$/.exec(src)
  if (m) return { info: { ...info, service: m[1]!, readonly: true } }
  if (yes(x.readonly) || (layout && layout !== 'cards')) info.readonly = true
  const path = scalar(x.path)
  if (!path) return { info: { ...info, offline: 'не задан `$path`' } }
  if (host) info.host = host
  if (host && !localHost(host)) return { info: { ...info, offline: `машина ${host}: папка не на этом хосте` } }
  const dir = abs(path)
  if (!existsSync(dir)) return { info: { ...info, offline: `нет папки ${path}` }, dir }
  return { info, dir }
}

/**
 * Разобрать и проверить файл типа (валидатор §2). `vars` — макросы `$paths`; `base` —
 * от чего считать относительные пути коллекций (корень стенда). Ошибка — строкой, не throw.
 */
export function parseObjectType(
  text: string,
  file: string,
  opts: { vars?: (name: string) => unknown; base?: string; codecs?: Iterable<string> } = {},
): { type: ObjectTypeDef } | { error: ObjectTypeError } {
  const fail = (message: string, id?: string): { error: ObjectTypeError } => ({ error: { file, message, ...(id ? { id } : {}) } })
  let attrs: Array<{ key: string[]; value: unknown }>
  try {
    attrs = (parse(text) as { root: { attrs: Array<{ key: string[]; value: unknown }> } }).root.attrs
  } catch (e) {
    return fail(`не разбирается: ${(e as Error).message}`)
  }
  const a: Record<string, string> = {}
  for (const at of attrs) if (at.key.length === 1 && at.key[0]) a[at.key[0]] = at.value as string
  if (scalar(a.type) !== 'object-type') return fail('нет `$type: object-type`')
  const id = scalar(a.id)
  if (!id) return fail('нет `$id`')
  if (!ID_RE.test(id)) return fail(`\`$id: ${id}\` — только a-z, 0-9, _ и -`, id)
  const unknown = Object.keys(a).filter((k) => !KNOWN_KEYS.has(k) && !k.startsWith('action.') && !/^discuss\.[^.]+\.(agent|skills|space|scope)$/.test(k))
  if (unknown.length) return fail(`неизвестные ключи: ${unknown.map((k) => `$${k}`).join(', ')}`, id)
  const source = scalar(a.source) || 'files'
  if (!SOURCES.has(source)) return fail(`\`$source: ${source}\` — files | service | protocol`, id)
  const idField = scalar(a.id_field)
  if (!idField) return fail('нет `$id_field` (системное имя объекта; из заголовка не выводится)', id)
  // Не-файловый тип: записи держит источник плагина фронта (`objectSources`, v1.53) — id в `$service`.
  const service = scalar(a.service)
  if (source !== 'files' && !service) return fail(`типу \`$source: ${source}\` нужен \`$service\` (id источника плагина)`, id)
  let parent: { field: string; type: string } | undefined
  if (scalar(a.parent)) {
    const m = /^([\w.-]+)\s*(?:→|->)\s*([a-z0-9][a-z0-9_-]*)$/.exec(scalar(a.parent))
    if (!m) return fail(`\`$parent: ${scalar(a.parent)}\` — <поле> → <тип>`, id)
    parent = { field: m[1]!, type: m[2]! }
  }
  const discuss: Record<string, { agent?: string; skills?: string[]; space?: string; scope?: string }> = {}
  for (const [k, v] of Object.entries(a)) {
    const m = /^discuss\.([^.]+)\.(agent|skills|space|scope)$/.exec(k)
    if (!m) continue
    const d = (discuss[m[1]!] ??= {})
    if (m[2] === 'skills') d.skills = list(v)
    else d[m[2] as 'agent' | 'space' | 'scope'] = expandHome(scalar(v))
  }
  const dir = dirname(file)
  const dirs: string[] = []
  const masks: Array<string | null> = []
  const dirStores: Array<string | null> = []
  const stores: ObjectStoreInfo[] = []
  let format: string | undefined
  if (source === 'files') {
    format = scalar(a.format)
    if (!format) return fail('файловому типу нужен `$format`', id)
    const codecs = new Set(opts.codecs ?? [])
    if (!codecs.has(format)) return fail(`нет кодека \`${format}\` (есть: ${[...codecs].join(', ')})`, id)
    const paths = list(a.paths)
    if (!paths.length) return fail('файловому типу нужен `$paths`', id)
    for (const p of paths) {
      if (p.startsWith('$')) {
        const slash = p.indexOf('/')
        const name = p.slice(1, slash < 0 ? undefined : slash)
        const mask = slash < 0 ? null : p.slice(slash + 1) || null
        const v = opts.vars?.(name)
        const vals = Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? v.split(',') : isPlain(v) ? storesOfMap(v) : []
        for (const x of vals) {
          // Хранилище (`## $bots <id>`, §13.1): блок с `$path` / `$host` / `$source`, `$layout`, `$readonly`.
          if (isPlain(x)) {
            const st = storeOf(x, (p) => resolve(opts.base ?? dir, expandHome(p)))
            if (!st) continue
            if (stores.some((o) => o.id === st.info.id)) continue
            stores.push(st.info)
            if (st.dir) {
              dirs.push(st.dir)
              masks.push(mask)
              dirStores.push(st.info.id)
            }
            continue
          }
          if (typeof x !== 'string' || !x.trim()) continue
          dirs.push(resolve(opts.base ?? dir, expandHome(x.trim())))
          masks.push(mask)
          dirStores.push(null)
        }
        continue
      }
      const { base, mask } = splitMask(p)
      dirs.push(resolve(opts.base ?? dir, expandHome(base)))
      masks.push(mask)
      dirStores.push(null)
    }
  }
  const idFromRaw = scalar(a.id_from)
  let idFrom: ObjectTypeDef['idFrom'] = { kind: 'path' }
  if (idFromRaw) {
    const [kind, field] = idFromRaw.split(/\s+/)
    if (kind === 'field' && field) idFrom = { kind: 'field', field }
    else if (kind === 'dir' || kind === 'file' || kind === 'path') idFrom = { kind }
    else return fail(`\`$id_from: ${idFromRaw}\` — path | dir | file | field <поле>`, id)
  }
  let states: ObjectStates | undefined
  if (scalar(a.states)) {
    const tr = parseStates(scalar(a.states))
    if (typeof tr === 'string') return fail(tr, id)
    const args: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(pairs(a.state_args))) args[k] = v.split('|').map((x) => x.trim()).filter(Boolean)
    states = { field: scalar(a.state_field) || 'state', transitions: tr, labels: pairs(a.state_labels), args }
  }
  let waiting: Record<string, string[]> | undefined
  if (scalar(a.waiting)) {
    waiting = {}
    for (const [k, v] of Object.entries(pairs(a.waiting))) waiting[k] = v.split('|').map((x) => x.trim()).filter(Boolean)
    if (!Object.keys(waiting).length) return fail('`$waiting` — фильтр `поле=значение`', id)
  }
  let schema: Record<string, unknown> | undefined
  const schemaRef = scalar(a.schema)
  if (schemaRef) {
    const sfile = isAbsolute(schemaRef) ? schemaRef : resolve(dir, schemaRef)
    if (!existsSync(sfile)) return fail(`нет схемы ${schemaRef}`, id)
    try {
      schema = JSON.parse(readFileSync(sfile, 'utf-8')) as Record<string, unknown>
    } catch (e) {
      return fail(`схема ${schemaRef}: ${(e as Error).message}`, id)
    }
    if (schema.type !== 'object' || typeof schema.properties !== 'object') return fail(`схема ${schemaRef}: нужен \`type: object\` с \`properties\``, id)
  }
  let fields: TypeField[] | undefined
  if (scalar(a.fields)) {
    const f = parseFields(scalar(a.fields))
    if (typeof f === 'string') return fail(f, id)
    fields = f
    schema ??= schemaOfFields(f, idField)
  }
  const search = list(a.search).map((s) => {
    const [field, w] = s.split('^')
    return { field: field!.trim(), weight: w ? Number(w) || 1 : 1 }
  })
  const versionRaw = scalar(a.version)
  const version = versionRaw ? Number(versionRaw) : undefined
  if (versionRaw && !Number.isInteger(version)) return fail(`\`$version: ${versionRaw}\` — целое`, id)
  const badges = list(a.badges)
  // `$views: sheet=fate-condensed, inspector` — вид `sheet` рисует редактор `fate-condensed` (universal-editor-spec §2).
  const viewNames: string[] = []
  const editorRefs: Array<{ view: string; id: string }> = []
  for (const v of list(a.views)) {
    const eq = v.indexOf('=')
    if (eq < 0) {
      viewNames.push(v)
      continue
    }
    const view = v.slice(0, eq).trim()
    const ed = v.slice(eq + 1).trim()
    if (!view || !ed || !ID_RE.test(ed)) return fail(`\`$views\`: «${v}» — <вид>=<редактор> (id редактора — a-z, 0-9, _ и -)`, id)
    viewNames.push(view)
    editorRefs.push({ view, id: ed })
  }
  const colorRule = parseColorRule(a)
  if (typeof colorRule === 'string') return fail(colorRule, id)
  const coverRule = parseCoverRule(text)
  if (typeof coverRule === 'string') return fail(coverRule, id)
  if (coverRule && source !== 'files') return fail('`## $cover` — только у файлового типа (обложка лежит рядом с записью)', id)
  for (const w of coverRule?.warnings ?? []) process.stderr.write(`objects: ${file}: ${w}\n`)
  const slices = parseSlices(text)
  if (typeof slices === 'string') return fail(slices, id)
  const type: ObjectTypeDef = {
    id,
    title: scalar(a.title) || id,
    ...(scalar(a.icon) ? { icon: scalar(a.icon) } : {}),
    source: source as ObjectTypeDef['source'],
    ...(format ? { format } : {}),
    ...(scalar(a.ext) ? { ext: scalar(a.ext) } : {}),
    ...(schema ? { schema } : {}),
    idField,
    titleField: scalar(a.title_field) || idField,
    search: search.length ? search : [{ field: scalar(a.title_field) || idField, weight: 1 }, { field: idField, weight: 1 }],
    filters: list(a.filters),
    sort: list(a.sort),
    actions: list(a.actions),
    links: list(a.links),
    views: viewNames,
    templates: [],
    columns: list(a.columns).length ? list(a.columns) : badges,
    ...(version !== undefined ? { version } : {}),
    file,
    ...(states ? { states } : {}),
    ...(waiting ? { waiting } : {}),
    ...(scalar(a.index) ? { index: scalar(a.index) } : {}),
    ...(service ? { service } : {}),
    ...(parent ? { parent } : {}),
    ...(Object.keys(discuss).length ? { discuss } : {}),
    ...(Object.keys(pairs(a.defaults)).length ? { defaults: pairs(a.defaults) } : {}),
    ...(slices.length ? { slices } : {}),
    dirs,
    masks,
    ...(stores.length ? { stores, dirStores } : {}),
    idFrom,
    indexColumns: list(a.index_columns).length ? list(a.index_columns) : [scalar(a.title_field) || idField, ...(list(a.columns).length ? list(a.columns) : badges)],
    ...(scalar(a.index_sort) ? { indexSort: scalar(a.index_sort) } : {}),
    ...(scalar(a.subtitle) ? { subtitleTpl: scalar(a.subtitle) } : {}),
    ...(scalar(a.avatar) ? { avatarTpl: scalar(a.avatar) } : {}),
    badgeFields: badges,
    ...(scalar(a.import) ? { importer: scalar(a.import) } : {}),
    templateFiles: {},
    editorRefs,
    ...(fields ? { fields } : {}),
    color: { by: colorRule.by, ...(colorRule.field ? { field: colorRule.field } : {}), steps: colorRule.steps },
    colorRule,
    ...(coverRule
      ? {
          cover: { refs: coverRule.refs.map((r) => (r.type ? `${r.field} → ${r.type}` : r.field)), ...(coverRule.style ? { style: coverRule.style } : {}), styles: coverRule.styles, preset: coverRule.preset },
          coverRule,
        }
      : {}),
  }
  return { type }
}

/** Файл описания редактора: `editors/<id>.editor.mdz` (или `.editor.json`) в каталоге типа, потом в прочих. */
export function editorFile(id: string, dirs: string[]): string | null {
  for (const d of dirs) {
    for (const ext of ['.editor.mdz', '.editor.json']) {
      const f = join(d, 'editors', `${id}${ext}`)
      if (existsSync(f)) return f
    }
  }
  return null
}

/** Разрешить редакторы типа: текст описаний — во `editors` (v1.52), не найденные — в `editorErrors`. */
export function attachEditors(t: ObjectTypeDef, dirs: string[]): void {
  if (!t.editorRefs.length) return
  const own = t.file ? [dirname(t.file)] : []
  const order = [...own, ...[...dirs].reverse().filter((d) => !own.includes(d))]
  const editors: ObjectEditorInfo[] = []
  const errors: string[] = []
  for (const ref of t.editorRefs) {
    const file = editorFile(ref.id, order)
    if (!file) {
      errors.push(`вид ${ref.view}: нет редактора editors/${ref.id}.editor.mdz`)
      continue
    }
    let text: string
    try {
      text = readFileSync(file, 'utf-8')
    } catch (e) {
      errors.push(`вид ${ref.view}: ${(e as Error).message}`)
      continue
    }
    const format = file.endsWith('.json') ? 'json' : 'mdz'
    let title: string | undefined
    if (format === 'mdz') title = /^\$title:\s*(.+?)\s*$/m.exec(text)?.[1]?.replace(/^(["'])(.*)\1$/, '$2')
    else {
      try {
        const v = JSON.parse(text) as { title?: unknown }
        if (typeof v.title === 'string') title = v.title
      } catch {
        // Битый JSON — разберёт и покажет ошибку фронт (nr-forms).
      }
    }
    editors.push({ id: ref.id, view: ref.view, format, text, file, ...(title ? { title } : {}) })
  }
  t.editors = editors
  if (errors.length) t.editorErrors = errors
  else delete t.editorErrors
}

/**
 * Вид-шаблон `views/<id>.ntpl`: первая строка-комментарий `<# type: persona; title: Коротко #>`
 * говорит, к каким типам и как подписан; без неё — ко всем типам каталога.
 */
export function templateHeader(text: string, file: string): { id: string; title: string; types: string[] | null } {
  const id = basename(file).replace(/\.ntpl$/, '')
  const m = /^\s*<#([\s\S]*?)#>/.exec(text)
  const fields: Record<string, string> = {}
  if (m) for (const part of m[1]!.split(';')) {
    const i = part.indexOf(':')
    if (i > 0) fields[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  const types = fields.type ?? fields.types
  return { id, title: fields.title || id, types: types ? types.split(',').map((x) => x.trim()).filter(Boolean) : null }
}

/** Загрузить типы из каталогов: старший перебивает младшего по id; ошибки — списком. */
export function loadObjectTypes(
  dirs: string[],
  opts: { vars?: (name: string) => unknown; base?: string; codecs?: Iterable<string> } = {},
): { types: Map<string, ObjectTypeDef>; errors: ObjectTypeError[] } {
  const types = new Map<string, ObjectTypeDef>()
  const errors: ObjectTypeError[] = []
  const codecs = [...(opts.codecs ?? [])]
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    const local: ObjectTypeDef[] = []
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.mdz')) continue
      const file = join(dir, name)
      let text: string
      try {
        text = readFileSync(file, 'utf-8')
      } catch (e) {
        errors.push({ file, message: (e as Error).message })
        continue
      }
      if (!/^\s*\$type:\s*object-type\b/m.test(text)) continue
      const r = parseObjectType(text, file, { ...opts, codecs })
      if ('error' in r) {
        errors.push(r.error)
        continue
      }
      types.set(r.type.id, r.type)
      local.push(r.type)
    }
    // Виды-шаблоны каталога: к типам этого же каталога (и к перебитым ниже — по id).
    const vdir = join(dir, 'views')
    if (existsSync(vdir)) {
      for (const name of readdirSync(vdir).sort()) {
        if (!name.endsWith('.ntpl')) continue
        const file = join(vdir, name)
        const head = templateHeader(readFileSync(file, 'utf-8'), file)
        const targets = head.types ? head.types.map((t) => types.get(t)).filter((t): t is ObjectTypeDef => !!t) : local
        for (const t of targets) {
          t.templateFiles[head.id] = file
          t.templates = [...t.templates.filter((v) => v.id !== head.id), { id: head.id, title: head.title }]
        }
      }
    }
  }
  for (const t of types.values()) attachEditors(t, dirs)
  return { types, errors }
}

/** Что отдаётся фронту: без путей коллекций и файлов шаблонов. */
export function typeInfo(t: ObjectTypeDef): ObjectTypeInfo {
  const { dirs: _d, masks: _m, dirStores: _ds, idFrom: _f, indexColumns: _c, indexSort: _o, subtitleTpl: _s, avatarTpl: _a, badgeFields: _b, importer: _i, templateFiles: _t, editorRefs: _e, fields: _fl, colorRule: _cr, coverRule: _cv, defaults: _df, ...info } = t
  return info
}

// ────────────────────────────────────────────────────────────────────────────
// Кодеки
// ────────────────────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Устойчивый `_id` у элементов массивов объектов (урок Roll20): «Сравнить» по полям и
 * правки патчами не ломаются от сортировки. Проставляется при чтении, если нет.
 */
export function stampIds(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => {
      if (!isRecord(v)) return stampIds(v)
      const out = stampIds(v) as Record<string, unknown>
      return typeof out._id === 'string' && out._id ? out : { _id: randomBytes(4).toString('hex'), ...out }
    })
  }
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stampIds(v)]))
  return value
}

const json = (data: unknown): string => JSON.stringify(data, null, 2) + '\n'

/** CCv3 (`chara_card_v3`): поля — `data` карты; обёртка (`spec`, чужие ключи) — как лежала. v2 читается. */
export const ccv3Codec: ObjectCodec = {
  ext: '.json',
  read(bytes) {
    const raw = bytes.toString('utf-8')
    const card = JSON.parse(raw) as Record<string, unknown>
    const data = isRecord(card.data) ? card.data : card
    return { data: stampIds(data) as Record<string, unknown>, raw }
  },
  write(data, prev) {
    let card: Record<string, unknown> = { spec: 'chara_card_v3', spec_version: '3.0' }
    if (prev) {
      try {
        const old = JSON.parse(prev.toString('utf-8')) as Record<string, unknown>
        if (isRecord(old) && isRecord(old.data)) card = old
      } catch {
        // Битый файл переписывается чистой картой.
      }
    }
    return json({ ...card, spec: 'chara_card_v3', spec_version: '3.0', data })
  },
}

export const jsonCodec: ObjectCodec = {
  ext: '.json',
  read(bytes) {
    const raw = bytes.toString('utf-8')
    const v = JSON.parse(raw) as unknown
    return { data: stampIds(isRecord(v) ? v : { value: v }) as Record<string, unknown>, raw }
  },
  write: (data) => json(data),
}

/** Markdown: тело — поле `text`, заголовок `# …` — `title`. */
export const mdCodec: ObjectCodec = {
  ext: '.md',
  read(bytes) {
    const raw = bytes.toString('utf-8')
    const title = /^#\s+(.+)$/m.exec(raw)?.[1]?.trim()
    return { data: { ...(title ? { title } : {}), text: raw }, raw }
  },
  write: (data) => String(data.text ?? ''),
}

type MdDoc = { root: { attrs: Array<{ key: string[]; value: unknown }>; children: unknown[]; body?: string } }

/** `[a, b]` в шапке mdz — список строк (теги, задачи карточки). */
function mdzValue(v: unknown): unknown {
  if (typeof v !== 'string') return v
  const m = /^\[(.*)\]$/s.exec(v.trim())
  if (!m) return v
  return m[1]!
    .split(',')
    .map((x) => x.trim().replace(/^(["'])(.*)\1$/, '$2'))
    .filter(Boolean)
}

/** Значение поля → строка шапки: список — `[a, b]`, строка с `#`, кавычкой, скобкой или краевыми пробелами — в кавычках. */
function mdzFormat(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => mdzFormat(x)).join(', ')}]`
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v === null || v === undefined) return ''
  const s = (typeof v === 'object' ? JSON.stringify(v) : String(v)).replace(/\r?\n/g, ' ')
  const plain = s === s.trim() && !/(^["'[{|>]|\s#|[,\]]$)/.test(s) && !/^(true|false|null|-?\d+(\.\d+)?)$/.test(s)
  return plain ? s : JSON.stringify(s)
}

const HEAD_LINE = /^\$([^\s:]+)\s*:(.*)$/

/**
 * mdz: поля — атрибуты корня (`$ключ: значение`, вложенный ключ — `a.b`, `[a, b]` — список),
 * markdown-тело без секций — поле `text`, заголовок `# …` — `title`, если `$title` нет.
 * Запись правит шапку построчно: несменённые строки — как лежали (кавычки, порядок), сменённые —
 * на своём месте, новые — в конец шапки, снятые — уходят; тело и секции — байт в байт
 * (`text` меняет тело только у файла без секций `## $…`).
 */
export const mdzCodec: ObjectCodec = {
  ext: '.mdz',
  read(bytes) {
    const raw = bytes.toString('utf-8')
    const doc = parse(raw) as unknown as MdDoc
    const data: Record<string, unknown> = {}
    for (const a of doc.root.attrs) data[a.key.join('.')] = mdzValue(a.value)
    const body = doc.root.body ?? ''
    if (body.trim() && !('text' in data)) data.text = body
    if (!('title' in data)) {
      const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim()
      if (title) data.title = title
    }
    return { data, raw }
  },
  write(data, prev) {
    const prevText = prev ? prev.toString('utf-8') : ''
    const doc = parse(prevText) as unknown as MdDoc
    const prevAttrs = new Map(doc.root.attrs.map((a) => [a.key.join('.'), mdzValue(a.value)] as const))
    const prevBody = doc.root.body ?? ''
    const lines = prevText.split('\n')
    let head = 0
    while (head < lines.length && HEAD_LINE.test(lines[head]!) && !/^\s*[|>]/.test(HEAD_LINE.exec(lines[head]!)![2]!)) head++
    // Многострочные значения или шапка не только из `$ключ:` — запись разбором nr-md (как раньше).
    const lineKeys = lines.slice(0, head).map((l) => HEAD_LINE.exec(l)![1]!)
    const simple = lineKeys.length === doc.root.attrs.length && lineKeys.every((k, i) => k === doc.root.attrs[i]!.key.join('.'))
    const bodyKey = !prevAttrs.has('text')
    const newBody = bodyKey && typeof data.text === 'string' && !doc.root.children.length ? data.text.replace(/\s+$/, '') : null
    const headingTitle = /^#\s+(.+)$/m.exec(newBody ?? prevBody)?.[1]?.trim()
    const fields = Object.entries(data).filter(([k, v]) => {
      if (v === undefined || k.startsWith('_')) return false
      if (k === 'text' && bodyKey) return false
      if (k === 'title' && !prevAttrs.has('title') && v === headingTitle) return false
      return true
    })
    if (!simple) {
      const keep = doc.root.attrs.filter((a) => fields.some(([k]) => k === a.key.join('.')))
      for (const a of keep) a.value = mdzFormat(data[a.key.join('.')])
      const seen = new Set(keep.map((a) => a.key.join('.')))
      for (const [k, v] of fields) if (!seen.has(k)) keep.push({ key: k.split('.'), value: mdzFormat(v) })
      doc.root.attrs = keep
      if (newBody !== null) doc.root.body = newBody
      const text = serialize(doc as never)
      return text.endsWith('\n') ? text : `${text}\n`
    }
    const want = new Map(fields)
    const out: string[] = []
    for (const line of lines.slice(0, head)) {
      const k = HEAD_LINE.exec(line)![1]!
      if (!want.has(k)) continue
      const v = want.get(k)
      want.delete(k)
      out.push(JSON.stringify(prevAttrs.get(k)) === JSON.stringify(v) ? line : `$${k}: ${mdzFormat(v)}`)
    }
    for (const [k, v] of want) out.push(`$${k}: ${mdzFormat(v)}`)
    let rest = lines.slice(head).join('\n')
    if (newBody !== null && newBody !== prevBody.replace(/\s+$/, '')) {
      const at = prevBody ? rest.indexOf(prevBody) : -1
      rest = at >= 0 ? rest.slice(0, at) + newBody + rest.slice(at + prevBody.length) : `${rest.trim() ? `${rest.replace(/\n*$/, '')}\n\n` : '\n'}${newBody}`
    }
    if (!head && !prevText) rest = newBody !== null ? `\n${newBody}` : ''
    const text = out.length ? out.join('\n') + (rest ? `\n${rest}` : '') : rest.replace(/^\n+/, '')
    return text.endsWith('\n') ? text : `${text}\n`
  },
}

export const BUILTIN_CODECS: Record<string, ObjectCodec> = { ccv3: ccv3Codec, json: jsonCodec, md: mdCodec, mdz: mdzCodec }

// ────────────────────────────────────────────────────────────────────────────
// Версии типа и миграции
// ────────────────────────────────────────────────────────────────────────────

/** Миграция `migrations/<from>-<to>.json` рядом с типом: переименовать, задать, снять поля. */
export interface ObjectMigration {
  rename?: Record<string, string>
  set?: Record<string, unknown>
  drop?: string[]
}

/** Версия объекта: `extensions.nrchat.version` у CCv3, `_version` у прочих; нет — 1. */
export function versionOf(data: Record<string, unknown>, ccv3: boolean): number {
  const v = ccv3 ? (isRecord(data.extensions) && isRecord(data.extensions.nrchat) ? data.extensions.nrchat.version : undefined) : data._version
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 1
}

export function withVersion(data: Record<string, unknown>, version: number, ccv3: boolean): Record<string, unknown> {
  if (!ccv3) return { ...data, _version: version }
  const ext = isRecord(data.extensions) ? data.extensions : {}
  const nr = isRecord(ext.nrchat) ? ext.nrchat : {}
  return { ...data, extensions: { ...ext, nrchat: { ...nr, version } } }
}

/** Цепочка миграций от версии объекта до версии типа; шага нет — объект как есть (и ошибка). */
export function migrate(data: Record<string, unknown>, from: number, to: number, dir: string): { data: Record<string, unknown>; error?: string } {
  let cur = { ...data }
  for (let v = from; v < to; v++) {
    const file = join(dir, 'migrations', `${v}-${v + 1}.json`)
    if (!existsSync(file)) return { data: cur, error: `нет миграции ${v}-${v + 1}` }
    let m: ObjectMigration
    try {
      m = JSON.parse(readFileSync(file, 'utf-8')) as ObjectMigration
    } catch (e) {
      return { data: cur, error: `migrations/${v}-${v + 1}.json: ${(e as Error).message}` }
    }
    for (const [a, b] of Object.entries(m.rename ?? {})) {
      if (a in cur) {
        cur[b] = cur[a]
        delete cur[a]
      }
    }
    for (const k of m.drop ?? []) delete cur[k]
    cur = { ...cur, ...(m.set ?? {}) }
  }
  return { data: cur }
}

// ────────────────────────────────────────────────────────────────────────────
// Строки, поиск, фасеты
// ────────────────────────────────────────────────────────────────────────────

const IMAGE_EXTS = ['png', 'webp', 'jpg', 'jpeg', 'gif'] as const

/** Ссылка копии на источник: `extensions.nrchat.source` (CCv3) или `source`. */
export function sourceOf(data: Record<string, unknown>): ObjectSourceRef | undefined {
  const ext = isRecord(data.extensions) && isRecord(data.extensions.nrchat) ? data.extensions.nrchat.source : undefined
  const v = ext ?? data.source
  return isRecord(v) && typeof v.type === 'string' && typeof v.id === 'string'
    ? { ...(typeof v.store === 'string' && v.store ? { store: v.store } : {}), type: v.type, id: v.id, ...(typeof v.hash === 'string' ? { hash: v.hash } : {}) }
    : undefined
}

function withSource(data: Record<string, unknown>, ref: ObjectSourceRef, ccv3: boolean): Record<string, unknown> {
  if (!ccv3) return { ...data, source: ref }
  const ext = isRecord(data.extensions) ? data.extensions : {}
  const nr = isRecord(ext.nrchat) ? ext.nrchat : {}
  return { ...data, extensions: { ...ext, nrchat: { ...nr, source: ref } } }
}

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable)
  if (isRecord(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]))
  return v
}

/** Хэш полей объекта без служебного (`_id`, ссылка на источник): «отстала ли копия». */
export function fieldsHash(data: Record<string, unknown>): string {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip)
    if (!isRecord(v)) return v
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) if (k !== '_id' && k !== 'source' && k !== '_version') out[k] = strip(x)
    return out
  }
  const d = strip(data) as Record<string, unknown>
  if (isRecord(d.extensions) && isRecord(d.extensions.nrchat)) {
    delete d.extensions.nrchat.source
    delete d.extensions.nrchat.version
    if (!Object.keys(d.extensions.nrchat).length) delete d.extensions.nrchat
    if (!Object.keys(d.extensions).length) delete d.extensions
  }
  return createHash('sha1').update(JSON.stringify(stable(d))).digest('hex').slice(0, 12)
}

/** Поле по пути `a.b`; массив строк — как есть. */
function pick(data: Record<string, unknown>, path: string): unknown {
  let cur: unknown = data
  for (const k of path.split('.')) cur = isRecord(cur) ? cur[k] : undefined
  return cur
}

function textOf(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join(', ')
  if (isRecord(v)) return ''
  return String(v)
}

function valuesOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(valuesOf)
  const s = textOf(v).trim()
  return s ? [s] : []
}

/** Сравнение значений полей: числа — как числа, прочее — строкой; пустое — в конец. */
export function cmpValues(a: unknown, b: unknown, down = false): number {
  const sa = textOf(a).trim()
  const sb = textOf(b).trim()
  if (!sa || !sb) return sa ? -1 : sb ? 1 : 0
  const na = Number(sa)
  const nb = Number(sb)
  const d = Number.isFinite(na) && Number.isFinite(nb) ? na - nb : sa.localeCompare(sb)
  return down ? -d : d
}

/** Нормализация для text-поиска: регистр, ё → е. */
export const fold = (s: string): string => s.toLowerCase().replace(/ё/g, 'е')

/**
 * Оценка text-режима (§7, до общего движка T5): каждое слово запроса должно найтись хоть в
 * одном поле корпуса; вес — сумма весов полей с совпадением (+ бонус за начало). 0 — мимо.
 */
export function scoreText(corpus: Array<{ text: string; weight: number }>, q: string): number {
  const words = fold(q).split(/\s+/).filter(Boolean)
  if (!words.length) return 1
  let total = 0
  for (const w of words) {
    let best = 0
    for (const c of corpus) {
      const t = fold(c.text)
      const i = t.indexOf(w)
      if (i < 0) continue
      const s = c.weight * (i === 0 || /[\s\-_,.]/.test(t[i - 1] ?? '') ? 2 : 1)
      if (s > best) best = s
    }
    if (!best) return 0
    total += best
  }
  return total
}

// ────────────────────────────────────────────────────────────────────────────
// Файловый источник
// ────────────────────────────────────────────────────────────────────────────

interface Entry {
  id: string
  file: string
  dir: string
  mtime: number
  size: number
  /** Хранилище и его читатель (`$layout`). */
  store?: string
  layout?: ObjectLayout
}

interface Read {
  data: Record<string, unknown>
  raw?: string
  bytes: Buffer
  hash: string
}

const TRASH = '.nr-trash'
const SAFE_ID = /^(?!\.)[^\\:*?"<>|]+$/

function okId(id: string): boolean {
  return SAFE_ID.test(id) && !id.split('/').some((p) => p === '' || p === '.' || p === '..' || p.startsWith('.'))
}

function walk(dir: string, ext: string, out: Entry[], root = dir): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (name.startsWith('.')) continue
    const file = join(dir, name)
    let st
    try {
      st = statSync(file)
    } catch {
      continue
    }
    // `<запись>.assets/` — обложка, иконка, sidecar записи (§19.2), не записи.
    if (st.isDirectory()) {
      if (!name.endsWith('.assets')) walk(file, ext, out, root)
    } else if (name.endsWith(ext)) {
      const id = relative(root, file).slice(0, -ext.length).split(sep).join('/')
      out.push({ id, file, dir: root, mtime: st.mtimeMs, size: st.size })
    }
  }
}

/** Файлы каталога по маске (`<папка>/CARD.mdz`): глубина — по маске, `**` — до 8; скрытое и корзина — мимо. */
function walkMask(root: string, mask: string, out: string[]): void {
  const re = maskRe(mask)
  const inAssets = mask.includes('.assets')
  const depth = mask.includes('**') ? 8 : mask.split('/').length
  const go = (dir: string, rel: string, d: number): void => {
    let ents
    try {
      ents = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of ents) {
      // Ассеты записи — мимо, если маска сама не идёт в `.assets` (карточки чатов `*.assets/card.mdz`).
      if (ent.name.startsWith('.') || (!inAssets && ent.name.endsWith('.assets'))) continue
      const r = rel ? `${rel}/${ent.name}` : ent.name
      const full = join(dir, ent.name)
      const isDir = ent.isDirectory() || (ent.isSymbolicLink() && (() => { try { return statSync(full).isDirectory() } catch { return false } })())
      if (isDir) {
        if (d + 1 < depth) go(full, r, d + 1)
      } else if (re.test(r)) out.push(full)
    }
  }
  go(root, '', 0)
}

function avatarFile(entry: Entry): string | null {
  const stem = entry.file.slice(0, -extname(entry.file).length)
  for (const e of IMAGE_EXTS) if (existsSync(`${stem}.${e}`)) return `${stem}.${e}`
  return null
}

function mimeOf(file: string): string {
  const e = extname(file).slice(1).toLowerCase()
  return e === 'jpg' || e === 'jpeg' ? 'image/jpeg' : e === 'svg' ? 'image/svg+xml' : `image/${e}`
}

function assetMime(file: string): string {
  const e = extname(file).slice(1).toLowerCase()
  if ((IMAGE_EXTS as readonly string[]).includes(e) || e === 'svg') return mimeOf(file)
  const map: Record<string, string> = { html: 'text/html; charset=utf-8', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', json: 'application/json', pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm' }
  return map[e] ?? 'application/octet-stream'
}

function trashMove(file: string, dir: string): void {
  const trash = join(dir, TRASH)
  mkdirSync(trash, { recursive: true })
  let target = join(trash, basename(file))
  if (existsSync(target)) target = join(trash, `${Date.now()}-${basename(file)}`)
  renameSync(file, target)
}

/** Движок над типами: то, что `service.ts` регистрирует методами. Отдельно — ради тестов. */
export interface ObjectsEngine {
  reload(): void
  types(): ObjectTypesResult
  type(id: string): ObjectTypeDef
  list(q: ObjectQuery): ObjectListResult
  get(p: { type: string; id: string; rev?: string }): Promise<ObjectDoc>
  create(p: { type: string; data: Record<string, unknown> }): ObjectSaveResult
  save(p: { type: string; id: string; data?: Record<string, unknown>; raw?: string; hash?: string }): ObjectSaveResult
  remove(p: { type: string; ids: string[] }): { removed: string[] }
  duplicate(p: { type: string; id: string; newId?: string }): ObjectSaveResult
  importFile(p: { type: string; file: { name: string; mime: string; data: string }; id?: string }): Promise<ObjectSaveResult>
  exportObject(p: { type: string; id: string; format?: string }): Promise<{ name: string; mime: string; data: string }>
  /** Картинка объекта (аватар): файл `<id>.<ext>` рядом, прежние картинки — в корзину. */
  setAvatar(p: { type: string; id: string; file: { name: string; mime: string; data: string } }): ObjectSaveResult
  links(p: { type: string; id: string }): Promise<ObjectLink[]>
  history(p: { type: string; id: string }): Promise<ObjectRevision[]>
  render(p: { type: string; id: string; view: string }): Promise<{ html: string }>
  asset(type: string, id: string, rel?: string): { mime: string; bytes: Buffer } | null
  /** Переход состояния (`$states`): `to` — целевое состояние. */
  setState(p: { type: string; id: string; to: string; input?: Record<string, unknown> }): ObjectSaveResult
  /** Сбросить список коллекции (пришло событие слежения). */
  forget(type: string): void
  /** Пересобрать оглавление (`$index`). */
  index(p: { type: string }): { files: string[]; rows: number }
  /** Каталоги для слежения: типы и коллекции. */
  watched(): string[]
  /** Каталоги типов (и их `views/`). */
  typeDirs(): string[]
  /**
   * Обложки (§19.2): `missing` — недостающие и устаревшие, `all` — все, кроме закреплённых и ручных,
   * `one` — запись `ids[0]` принудительно (снимает замок, ручную картинку — в корзину).
   */
  cover(p: { type: string; mode: 'missing' | 'all' | 'one'; ids?: string[] }): { queued: Array<{ id: string; job?: string }>; skipped: number }
  /** Закрепить / открепить обложку записи. */
  coverLock(p: { type: string; id: string; locked: boolean }): ObjectSaveResult
  /** Стиль обложки: у записи (поле `cover_style`) или у типа (`scope: 'type'`); пусто — по правилу. */
  coverStyle(p: { type: string; id?: string; style: string; scope: 'record' | 'type' }): { style: string }
  /** Стили обложек стенда и текущий стиль типа. */
  coverStyles(p: { type: string }): { styles: Array<{ id: string; title: string }>; current?: string }
}

export function createObjectsEngine(opts: {
  typeDirs: () => string[]
  vars?: (name: string) => unknown
  base?: string
  codecs?: Record<string, ObjectCodec>
  layouts?: Record<string, ObjectLayout>
  render?: (template: string, data: Record<string, unknown>) => string
  importers?: Record<string, ObjectImporter>
  exporters?: Record<string, ObjectExporter>
  links?: Record<string, ObjectLinkProvider>
  cover?: CoverGenerator
  coverStyleDirs?: () => string[]
  /** Где помнить стиль обложки типа (`cover-styles.json`). */
  stateDir?: string
  ctx?: unknown
}): ObjectsEngine {
  const codecs: Record<string, ObjectCodec> = { ...BUILTIN_CODECS, ...opts.codecs }
  let state: { types: Map<string, ObjectTypeDef>; errors: ObjectTypeError[] } | null = null
  const cache = new Map<string, { mtime: number; size: number; read: Read }>()

  const load = (): NonNullable<typeof state> =>
    (state ??= loadObjectTypes(opts.typeDirs(), { vars: opts.vars, base: opts.base, codecs: Object.keys(codecs) }))

  const typeOf = (id: string): ObjectTypeDef => {
    const t = load().types.get(id)
    if (!t) throw Object.assign(new Error(`objects: нет типа ${id}`), { code: 'not_found' })
    return t
  }
  const extOf = (t: ObjectTypeDef): string => t.ext ?? codecs[t.format ?? '']?.ext ?? '.json'
  const codecOf = (t: ObjectTypeDef): ObjectCodec => {
    const c = codecs[t.format ?? '']
    if (!c) throw Object.assign(new Error(`objects: тип ${t.id} не файловый`), { code: 'not_supported' })
    return c
  }

  const layoutOf = (t: ObjectTypeDef, store: string | null | undefined): ObjectLayout | undefined => {
    const l = store ? t.stores?.find((x) => x.id === store)?.layout : undefined
    return l && l !== 'cards' ? opts.layouts?.[l] : undefined
  }
  const storeInfo = (t: ObjectTypeDef, store: string | undefined): ObjectStoreInfo | undefined => (store ? t.stores?.find((x) => x.id === store) : undefined)
  /** Хранилище только для чтения (`$readonly`, вид не кодека типа): правка, удаление, картинка — нельзя. */
  const guard = (t: ObjectTypeDef, e: Entry): void => {
    const st = storeInfo(t, e.store)
    if (st?.readonly || e.layout) throw Object.assign(new Error(`objects: хранилище «${st?.title ?? e.store}» только для чтения — возьми копию`), { code: 'forbidden' })
  }
  const avatarOf = (e: Entry): string | null => (e.layout ? (e.layout.avatar?.(e.file) ?? null) : avatarFile(e))
  const masked = (t: ObjectTypeDef): boolean => t.masks.some((m) => m !== null) || t.idFrom.kind !== 'path' || !!t.dirStores?.some((st) => !!layoutOf(t, st))
  /** Обход по маскам дорог (каталог сессий): список коллекции живёт секунду, запись его сбрасывает. */
  const scans = new Map<string, { at: number; list: Entry[]; stamp: string }>()
  /** Отпечаток каталогов типа (mtime): файл добавили или убрали — обход недействителен сразу, а не через секунду. */
  const stampOf = (t: ObjectTypeDef): string =>
    t.dirs
      .map((d) => {
        try {
          return String(statSync(d).mtimeMs)
        } catch {
          return '-'
        }
      })
      .join('|')

  const idOfFile = (t: ObjectTypeDef, file: string, base: string): string | null => {
    const ext = extname(file)
    switch (t.idFrom.kind) {
      case 'dir':
        return basename(dirname(file))
      case 'file':
        return basename(file, ext)
      case 'field': {
        try {
          const st = statSync(file)
          const r = readFile(t, file, st)
          const v = textOf(r.data[t.idFrom.field!]).trim()
          return v || null
        } catch {
          return null
        }
      }
      default:
        return relative(base, file).slice(0, -ext.length || undefined).split(sep).join('/')
    }
  }

  const entries = (t: ObjectTypeDef): Entry[] => {
    if (t.source !== 'files') return []
    const stamp = masked(t) ? stampOf(t) : ''
    if (masked(t)) {
      const hit = scans.get(t.id)
      if (hit && Date.now() - hit.at < 1000 && hit.stamp === stamp) return hit.list
    }
    const out: Entry[] = []
    const seen = new Set<string>()
    t.dirs.forEach((dir, i) => {
      const mask = t.masks[i] ?? null
      const store = t.dirStores?.[i] ?? undefined
      const layout = layoutOf(t, store)
      const local: Entry[] = []
      if (layout) {
        // Своё хранилище (`$layout`): id с префиксом хранилища — slug одной папки не перекрывает другую.
        let found: Array<{ id: string; file: string }> = []
        try {
          found = layout.scan(dir)
        } catch {
          found = []
        }
        for (const f of found) {
          let st
          try {
            st = statSync(f.file)
          } catch {
            continue
          }
          const id = `${store}/${f.id}`
          if (okId(id)) local.push({ id, file: f.file, dir, mtime: st.mtimeMs, size: st.size, store, layout })
        }
      } else if (mask === null && t.idFrom.kind === 'path') walk(dir, extOf(t), local)
      else {
        const files: string[] = []
        if (mask === null) {
          const tmp: Entry[] = []
          walk(dir, extOf(t), tmp)
          files.push(...tmp.map((e) => e.file))
        } else walkMask(dir, mask, files)
        for (const file of files) {
          let st
          try {
            st = statSync(file)
          } catch {
            continue
          }
          const id = idOfFile(t, file, dir)
          if (id && okId(id)) local.push({ id, file, dir, mtime: st.mtimeMs, size: st.size })
        }
      }
      if (store && !layout) for (const e of local) e.store = store
      for (const e of local) if (!seen.has(e.id)) {
        seen.add(e.id)
        out.push(e)
      }
    })
    if (masked(t)) scans.set(t.id, { at: Date.now(), list: out, stamp })
    return out
  }

  const find = (t: ObjectTypeDef, id: string): Entry | null => {
    if (!okId(id)) return null
    if (masked(t)) {
      // Обход живёт секунду: запись, которую только что положил другой процесс (импорт с площадки), — пересканировать раз.
      let e = entries(t).find((x) => x.id === id)
      if (!e && scans.has(t.id)) {
        scans.delete(t.id)
        e = entries(t).find((x) => x.id === id)
      }
      if (!e) return null
      try {
        const st = statSync(e.file)
        return { ...e, mtime: st.mtimeMs, size: st.size }
      } catch {
        return null
      }
    }
    for (const [i, dir] of t.dirs.entries()) {
      const file = join(dir, `${id}${extOf(t)}`)
      if (existsSync(file)) {
        const st = statSync(file)
        const store = t.dirStores?.[i] ?? undefined
        return { id, file, dir, mtime: st.mtimeMs, size: st.size, ...(store ? { store } : {}) }
      }
    }
    return null
  }

  /** Файл → поля (кэш по mtime/size; миграции версии типа). */
  const readFile = (t: ObjectTypeDef, file: string, st: { mtimeMs: number; size: number }, layout?: ObjectLayout): { data: Record<string, unknown>; raw?: string; bytes: Buffer; hash: string } => {
    const hit = cache.get(file)
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.read
    const bytes = readFileSync(file)
    const parsed = layout ? { data: layout.read(file), raw: bytes.toString('utf-8') } : codecOf(t).read(bytes)
    // Тип поменялся — старый объект читается по миграциям, переписывается при сохранении.
    if (t.version !== undefined) {
      const ccv3 = t.format === 'ccv3'
      const from = versionOf(parsed.data, ccv3)
      if (from < t.version) parsed.data = withVersion(migrate(parsed.data, from, t.version, dirname(t.file ?? file)).data, t.version, ccv3)
    }
    const read: Read = { data: parsed.data, ...(parsed.raw !== undefined ? { raw: parsed.raw } : {}), bytes, hash: createHash('sha1').update(bytes).digest('hex').slice(0, 16) }
    cache.set(file, { mtime: st.mtimeMs, size: st.size, read })
    return read
  }

  /** `postponed` с прошедшим `until` — `ready` (§15.1 п.3): файл не трогается. */
  const effective = (t: ObjectTypeDef, data: Record<string, unknown>): Record<string, unknown> => {
    const st = t.states
    if (!st || data[st.field] !== 'postponed') return data
    const until = Date.parse(textOf(data.until))
    return Number.isFinite(until) && until <= Date.now() ? { ...data, [st.field]: 'ready' } : data
  }

  const readEntry = (t: ObjectTypeDef, e: Entry): Read => {
    const r = readFile(t, e.file, { mtimeMs: e.mtime, size: e.size }, e.layout)
    return { ...r, data: effective(t, { ...r.data, [t.idField]: e.id }) }
  }

  const tpl = (template: string | undefined, data: Record<string, unknown>): string => {
    if (!template || !opts.render) return ''
    try {
      return opts.render(template, data).trim()
    } catch {
      return ''
    }
  }

  // ── лицо записи (§19) ────────────────────────────────────────────────────
  const styleDirs = (): string[] => opts.coverStyleDirs?.() ?? (opts.base ? [join(opts.base, 'cover-styles')] : [])
  const stateFile = (): string | null => (opts.stateDir ? join(opts.stateDir, 'cover-styles.json') : null)
  const typeStyles = (): Record<string, string> => {
    const f = stateFile()
    if (!f || !existsSync(f)) return {}
    try {
      const v = JSON.parse(readFileSync(f, 'utf-8')) as unknown
      return isRecord(v) ? (Object.fromEntries(Object.entries(v).filter((x): x is [string, string] => typeof x[1] === 'string'))) : {}
    } catch {
      return {}
    }
  }
  const styleOf = (t: ObjectTypeDef, data: Record<string, unknown>): string | undefined =>
    textOf(data.cover_style).trim() || typeStyles()[t.id] || t.coverRule?.style

  /** Рефы правила записи: картинки полей, картинки записей по ссылке, свой аватар. */
  const refsOf = (t: ObjectTypeDef, e: Entry, data: Record<string, unknown>): string[] => {
    const out: string[] = []
    for (const ref of t.coverRule?.refs ?? []) {
      if (ref.field === '@avatar') {
        const av = avatarOf(e)
        if (av) out.push(av)
        continue
      }
      const vals = valuesOf(pick(data, ref.field))
      if (!ref.type) {
        out.push(...refFiles(vals, e.file, homedir()))
        continue
      }
      const other = load().types.get(ref.type)
      if (!other) continue
      for (const v of vals) {
        const oe = find(other, v) ?? find(other, v.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, ''))
        if (!oe) continue
        const dir = assetsDir(oe.file)
        const img = (other.coverRule ? coverStateOf(dir, '').cover : null) ?? avatarOf(oe)
        if (img) out.push(img)
      }
    }
    return [...new Set(out)]
  }

  /** Входы генерации записи (промпт по шаблону, стиль, рефы) и их хэш. */
  const inputsOf = (t: ObjectTypeDef, e: Entry, r: Read, hue?: number) => {
    const rule = t.coverRule!
    const title = textOf(pick(r.data, t.titleField)).trim() || e.id
    const scope = { ...r.data, id: e.id, type: t.id, title, ...(hue !== undefined ? { hue, color_name: hueName(hue) } : {}) }
    const styleId = styleOf(t, r.data)
    const style = styleId ? readCoverStyle(styleDirs(), styleId) : null
    const prompt = tpl(rule.prompt, scope) || title
    const negative = rule.negative ? tpl(rule.negative, scope) : undefined
    return { title, ...coverInputs({ prompt, ...(negative ? { negative } : {}), refs: refsOf(t, e, r.data), style, preset: rule.preset }) }
  }

  const assetUrl = (t: ObjectTypeDef, e: Entry, file: string): string =>
    `/asset/${encodeURIComponent(t.id)}/${encodeURIComponent(e.id)}/${relative(dirname(e.file), file).split(sep).map(encodeURIComponent).join('/')}?v=${Math.round(statSync(file).mtimeMs)}`

  const coverFace = (t: ObjectTypeDef, e: Entry, r: Read, hue?: number): Pick<ObjectRow, 'cover' | 'icon' | 'coverState' | 'coverError'> => {
    let hash = ''
    try {
      hash = inputsOf(t, e, r, hue).hash
    } catch {
      // рефы недоступны — состояние по файлам
    }
    const st = coverStateOf(assetsDir(e.file), hash)
    return {
      coverState: st.state,
      ...(st.cover ? { cover: assetUrl(t, e, st.cover), icon: assetUrl(t, e, st.icon ?? st.cover) } : {}),
      ...(st.error ? { coverError: st.error } : {}),
    }
  }

  /** Поставить запись: sidecar `pending` сразу (список видит «в очереди»), генератор — фоном. */
  const enqueue = (t: ObjectTypeDef, e: Entry, r: Read, hue?: number): { id: string; job?: string } => {
    if (!opts.cover) throw Object.assign(new Error('objects: нет генератора обложек на этом стенде'), { code: 'not_supported' })
    const inp = inputsOf(t, e, r, hue)
    const dir = assetsDir(e.file)
    const side = readSidecar(dir) ?? {}
    const at = new Date().toISOString()
    const { error: _err, ...rest } = side
    writeSidecar(dir, { ...rest, pending: { hash: inp.hash, at } })
    const req = {
      type: t.id,
      id: e.id,
      title: inp.title,
      prompt: inp.prompt,
      ...(inp.negative ? { negative: inp.negative } : {}),
      refs: inp.refs,
      preset: inp.preset,
      ...(inp.style ? { style: inp.style } : {}),
      hash: inp.hash,
      ...(hue !== undefined ? { hue } : {}),
      dir,
      icon: t.coverRule!.iconSize,
      keys: t.coverRule!.keys,
    }
    void Promise.resolve()
      .then(() => opts.cover!(req))
      .then(
        (res) => {
          const cur = readSidecar(dir)
          if (res.job && cur?.pending?.hash === inp.hash && !cur.pending.job) writeSidecar(dir, { ...cur, pending: { ...cur.pending, job: res.job } })
        },
        (err: unknown) => {
          const cur = readSidecar(dir) ?? {}
          const { pending: _p, ...left } = cur
          writeSidecar(dir, { ...left, error: { hash: inp.hash, message: (err as Error).message ?? String(err), at: new Date().toISOString() } })
        },
      )
    return { id: e.id }
  }

  /** Авто (§19.2): изменился хэш входов — в очередь; `$auto: all` — и недостающие. Ошибка на тех же входах — не повторять. */
  const autoCover = (t: ObjectTypeDef, items: Array<{ e: Entry; r: Read; row: ObjectRow }>): void => {
    const rule = t.coverRule
    if (!rule || rule.auto === 'off' || !opts.cover) return
    for (const { e, r, row } of items) {
      if (row.coverError) continue
      if (row.coverState === 'stale' || (rule.auto === 'all' && row.coverState === 'missing')) {
        try {
          enqueue(t, e, r, row.hue)
        } catch {
          // генератор недоступен — останется «устарела»
        }
      }
    }
  }

  const rowOf = (t: ObjectTypeDef, e: Entry, r: Read): ObjectRow => {
    const avatar = avatarOf(e)
    const assets = { avatar: avatar ? `/asset/${encodeURIComponent(t.id)}/${encodeURIComponent(e.id)}?v=${Math.round(statSync(avatar).mtimeMs)}` : '' }
    const scope = { ...r.data, id: e.id, type: t.id, assets }
    const title = textOf(pick(r.data, t.titleField)).trim() || e.id
    const subtitle = tpl(t.subtitleTpl, scope)
    const av = t.avatarTpl ? tpl(t.avatarTpl, scope) : assets.avatar
    const badges = t.badgeFields.flatMap((f) => valuesOf(pick(r.data, f)))
    const fields = Object.fromEntries(t.columns.map((c) => [c, textOf(pick(r.data, c))]))
    const source = sourceOf(r.data)
    const color = t.colorRule ? colorOf(t.colorRule, e.id, t.colorRule.field ? textOf(pick(r.data, t.colorRule.field)).trim() : '') : {}
    const face = t.coverRule ? coverFace(t, e, r, color.hue) : null
    return {
      type: t.id,
      id: e.id,
      title,
      ...color,
      ...(face ?? {}),
      ...(subtitle ? { subtitle } : {}),
      ...(av ? { avatar: av } : {}),
      ...(badges.length ? { badges } : {}),
      ...(t.columns.length ? { fields } : {}),
      updatedAt: Math.round(e.mtime),
      ...(source ? { source } : {}),
      ...(e.store ? { store: e.store } : {}),
    }
  }

  const docOf = (t: ObjectTypeDef, e: Entry, r: Read): ObjectDoc => ({
    type: t.id,
    id: e.id,
    data: r.data,
    ...(r.raw !== undefined ? { raw: r.raw } : {}),
    hash: r.hash,
    fieldsHash: fieldsHash(r.data),
    row: rowOf(t, e, r),
    path: e.file,
  })

  /** Ошибки полей по схеме: обязательные непустые, `id` — имя файла. */
  const check = (t: ObjectTypeDef, data: Record<string, unknown>, isNew: boolean): Record<string, string> => {
    const out: Record<string, string> = {}
    const required = new Set<string>([t.idField, ...(Array.isArray(t.schema?.required) ? (t.schema!.required as string[]) : [])])
    for (const f of required) if (textOf(pick(data, f)).trim() === '') out[f] = 'обязательное поле'
    const id = textOf(data[t.idField]).trim()
    if (id && !okId(id)) out[t.idField] = 'недопустимое имя: без «/» в начале, «..», «:» и скрытых имён'
    else if (id && isNew && find(t, id)) out[t.idField] = `«${id}» уже есть`
    return out
  }

  /** Файл нового объекта: у маски — сегмент id (`dir` — папка, `file` — имя) подставляется, прочие — буквальные. */
  const newFile = (t: ObjectTypeDef, id: string): { dir: string; file: string } => {
    // Новое — в первое хранилище, куда можно писать (§13.1): `$readonly` и чужой вид пропускаются.
    const at = t.dirs.findIndex((_, i) => {
      const st = storeInfo(t, t.dirStores?.[i] ?? undefined)
      return !st || (!st.readonly && !st.offline && !layoutOf(t, st.id))
    })
    const dir = t.dirs[at]
    if (!dir) throw Object.assign(new Error(`objects: у типа ${t.id} нет каталога, куда можно писать`), { code: 'not_supported' })
    const mask = t.masks[at] ?? null
    if (mask === null) {
      if (t.idFrom.kind === 'path' || t.idFrom.kind === 'file') return { dir, file: join(dir, `${id}${extOf(t)}`) }
    } else {
      const segs = mask.split('/')
      const at = t.idFrom.kind === 'dir' ? segs.length - 2 : t.idFrom.kind === 'file' ? segs.length - 1 : -1
      const literal = segs.every((x, i) => i === at || !GLOB.test(x))
      if (at >= 0 && literal && (segs[at]!.match(/\*/g) ?? []).length === 1 && !segs[at]!.includes('**')) {
        segs[at] = segs[at]!.replace('*', id)
        return { dir, file: join(dir, ...segs) }
      }
    }
    throw Object.assign(new Error(`objects: тип ${t.id} не создаёт объекты сам (маска ${mask ?? '—'}, id — ${t.idFrom.kind})`), { code: 'not_supported' })
  }

  const write = (t: ObjectTypeDef, id: string, data: Record<string, unknown>, prev: Entry | null): Entry => {
    if (prev) guard(t, prev)
    const target = prev ? { dir: prev.dir, file: prev.file } : newFile(t, id)
    mkdirSync(dirname(target.file), { recursive: true })
    // id из пути — не поле файла; у масок и id из поля — поле файла (`$slug`, `$session`) остаётся.
    const { [t.idField]: _drop, ...rest } = data
    const fields = masked(t) ? data : rest
    const body = t.version !== undefined ? withVersion(fields, t.version, t.format === 'ccv3') : fields
    const bytes = codecOf(t).write(body, prev ? readFileSync(target.file) : null)
    writeFileSync(target.file, bytes)
    scans.delete(t.id)
    const st = statSync(target.file)
    const i = t.dirs.indexOf(target.dir)
    const store = i >= 0 ? (t.dirStores?.[i] ?? undefined) : undefined
    return { id, file: target.file, dir: target.dir, mtime: st.mtimeMs, size: st.size, ...(store ? { store } : {}) }
  }

  /** Перевести объект в другое состояние (`$states`): поле, `decided_at`, аргументы перехода. */
  const setState = (t: ObjectTypeDef, id: string, to: string, input: Record<string, unknown>): ObjectSaveResult => {
    const st = t.states
    if (!st) throw Object.assign(new Error(`objects: у типа ${t.id} нет $states`), { code: 'not_supported' })
    const e = find(t, id)
    if (!e) throw Object.assign(new Error(`objects: нет ${t.id}/${id}`), { code: 'not_found' })
    const cur = readEntry(t, e)
    const from = textOf(cur.data[st.field])
    if (!(st.transitions[from] ?? []).includes(to)) {
      const message = `«${from || '—'}» → «${to}» нельзя (можно: ${(st.transitions[from] ?? []).join(', ') || 'ничего'})`
      return { invalid: { [st.field]: message }, message }
    }
    const need = st.args[to] ?? []
    const missing = need.filter((k) => textOf(input[k]).trim() === '')
    if (missing.length) {
      const message = `«${to}»: нужно ${missing.join(', ')}`
      return { invalid: Object.fromEntries(missing.map((k) => [k, 'обязательное поле'])), message }
    }
    // На диске — без «виртуального» ready: пишем поверх того, что в файле.
    const disk = readFile(t, e.file, { mtimeMs: e.mtime, size: e.size }).data
    const data: Record<string, unknown> = { ...disk, [t.idField]: id, [st.field]: to, decided_at: new Date().toISOString() }
    for (const k of ['comment', 'until', ...need]) {
      const v = textOf(input[k]).trim()
      if (v) data[k] = v
    }
    return saved(t, write(t, id, data, e))
  }

  /** Оглавление коллекции (`$index`): таблица в каждом каталоге типа; текст вокруг таблицы — как лежал. */
  const writeIndex = (t: ObjectTypeDef): { files: string[]; rows: number } => {
    if (!t.index) throw Object.assign(new Error(`objects: у типа ${t.id} нет $index`), { code: 'not_supported' })
    const all = entries(t)
    const files: string[] = []
    let total = 0
    const titleOf = (f: string): string => {
      const p = isRecord(t.schema?.properties) ? (t.schema!.properties as Record<string, unknown>)[f] : undefined
      return isRecord(p) && typeof p.title === 'string' ? p.title : f
    }
    const cell = (v: unknown): string => textOf(v).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim() || '—'
    t.dirs.forEach((dir) => {
      const rows = all.filter((e) => e.dir === dir).map((e) => ({ e, data: readEntry(t, e).data }))
      const key = t.indexSort?.replace(/^-/, '')
      if (key) rows.sort((a, b) => cmpValues(pick(a.data, key), pick(b.data, key), t.indexSort!.startsWith('-')) || a.e.id.localeCompare(b.e.id))
      const cols = t.indexColumns
      const lines = [
        `| ${[...cols.map(titleOf), 'карточка'].join(' | ')} |`,
        `|${[...cols, ''].map(() => '---').join('|')}|`,
        ...rows.map(({ e, data }) => `| ${[...cols.map((c) => cell(pick(data, c))), `[${basename(e.file)}](${relative(dir, e.file).split(sep).join('/')})`].join(' | ')} |`),
      ]
      const file = join(dir, t.index!)
      const prev = existsSync(file) ? readFileSync(file, 'utf-8') : `# ${t.title}\n\nСобрано из карточек (действие «Обновить INDEX»), руками не править.\n`
      const pl = prev.split('\n')
      const start = pl.findIndex((l) => /^\|.*\|\s*$/.test(l))
      let end = start
      if (start >= 0) while (end < pl.length && /^\|.*\|\s*$/.test(pl[end]!)) end++
      const next = start >= 0 ? [...pl.slice(0, start), ...lines, ...pl.slice(end)].join('\n') : `${prev.replace(/\n*$/, '')}\n\n${lines.join('\n')}\n`
      writeFileSync(file, next)
      files.push(file)
      total += rows.length
    })
    return { files, rows: total }
  }

  const saved = (t: ObjectTypeDef, e: Entry): ObjectSaveResult => ({ doc: docOf(t, e, readEntry(t, e)) })

  // Тип `type` (§18): типы стенда — записями; встроенный, перебить файлом нельзя.
  const meta = createTypeType({ types: () => load(), typeDirs: () => opts.typeDirs(), reload: () => engine.reload() })
  const metaDef = (): ObjectTypeDef => ({ ...meta.info, dirs: [], masks: [], idFrom: { kind: 'path' }, indexColumns: [], badgeFields: [], templateFiles: {}, editorRefs: [] })

  const engine: ObjectsEngine = {
    reload() {
      state = null
      cache.clear()
    },
    types() {
      const s = load()
      // Вид хранилища без читателя на этом стенде — полка гаснет с причиной, а не пустеет молча.
      const info = (t: ObjectTypeDef): ObjectTypeInfo => {
        const i = typeInfo(t)
        if (i.stores) i.stores = i.stores.map((st) => (st.layout && st.layout !== 'cards' && !st.service && !st.offline && !opts.layouts?.[st.layout] ? { ...st, offline: `нет читателя вида ${st.layout}` } : st))
        return i
      }
      return { types: [...[...s.types.values()].filter((t) => t.id !== TYPE_TYPE).map(info), meta.info], errors: s.errors }
    },
    type: (id) => (id === TYPE_TYPE ? metaDef() : typeOf(id)),
    list(q) {
      if (q.type === TYPE_TYPE) return meta.list(q)
      const t = typeOf(q.type)
      const all = entries(t).filter((e) => !q.store || e.store === q.store).map((e) => {
        try {
          const r = readEntry(t, e)
          return { e, r }
        } catch {
          return null
        }
      }).filter((x): x is { e: Entry; r: Read } => x !== null)
      const facets: ObjectListResult['facets'] = {}
      for (const f of t.filters) {
        const counts = new Map<string, number>()
        for (const { r } of all) for (const v of new Set(valuesOf(pick(r.data, f)))) counts.set(v, (counts.get(v) ?? 0) + 1)
        facets[f] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      }
      let rows = all.filter(({ r }) => Object.entries(q.filters ?? {}).every(([f, allowed]) => !allowed.length || valuesOf(pick(r.data, f)).some((v) => allowed.includes(v))))
      let scored = rows.map((x) => ({ ...x, score: 1 }))
      if (q.q && q.q.trim()) {
        scored = rows
          .map((x) => ({ ...x, score: scoreText(t.search.map((s) => ({ text: s.field === t.idField ? x.e.id : textOf(pick(x.r.data, s.field)), weight: s.weight })), q.q!) }))
          .filter((x) => x.score > 0)
      }
      // `-поле` в `$sort`/`sort` — по убыванию.
      const rawKey = q.sort ?? (q.q ? '' : (t.sort[0] ?? t.titleField))
      const key = rawKey.replace(/^-/, '')
      const down = rawKey.startsWith('-')
      scored.sort((a, b) => {
        if (!key) return b.score - a.score || rowOf(t, a.e, a.r).title.localeCompare(rowOf(t, b.e, b.r).title)
        const dn = !!q.desc !== down
        if (key === 'updatedAt') return (a.e.mtime - b.e.mtime) * (dn ? -1 : 1)
        // Пустое значение — в конец в обе стороны.
        return cmpValues(pick(a.r.data, key), pick(b.r.data, key), dn) || a.e.id.localeCompare(b.e.id)
      })
      if (!key && q.desc) scored.reverse()
      rows = scored
      const offset = q.offset ?? 0
      const page = rows.slice(offset, q.limit ? offset + q.limit : undefined)
      const out = page.map(({ e, r }) => ({ e, r, row: rowOf(t, e, r) }))
      autoCover(t, out)
      return { rows: out.map((x) => x.row), total: rows.length, facets }
    },
    async get(p) {
      if (p.type === TYPE_TYPE) return meta.get(p.id)
      const t = typeOf(p.type)
      const e = find(t, p.id)
      if (!e) throw Object.assign(new Error(`objects: нет ${p.type}/${p.id}`), { code: 'not_found' })
      if (!p.rev) return docOf(t, e, readEntry(t, e))
      const rel = relative(dirname(e.file), e.file)
      const { stdout } = await run('git', ['-C', dirname(e.file), 'show', `${p.rev}:./${rel}`], { encoding: 'buffer', maxBuffer: 32 << 20 })
      const bytes = stdout as unknown as Buffer
      const parsed = codecOf(t).read(bytes)
      const r: Read = { data: effective(t, { ...parsed.data, [t.idField]: e.id }), ...(parsed.raw !== undefined ? { raw: parsed.raw } : {}), bytes, hash: createHash('sha1').update(bytes).digest('hex').slice(0, 16) }
      return { ...docOf(t, e, r), rev: p.rev }
    },
    create(p) {
      if (p.type === TYPE_TYPE) return meta.create(p.data)
      const t = typeOf(p.type)
      const data = { ...p.data }
      for (const [k, v] of Object.entries(t.defaults ?? {})) if (data[k] === undefined || data[k] === '') data[k] = v === 'true' ? true : v === 'false' ? false : v
      const invalid = check(t, data, true)
      if (Object.keys(invalid).length) return { invalid, message: Object.values(invalid)[0]! }
      const id = textOf(data[t.idField]).trim()
      return saved(t, write(t, id, data, null))
    },
    save(p) {
      if (p.type === TYPE_TYPE) return meta.save(p.id, p.data ?? {})
      const t = typeOf(p.type)
      const e = find(t, p.id)
      if (!e) throw Object.assign(new Error(`objects: нет ${p.type}/${p.id}`), { code: 'not_found' })
      const cur = readEntry(t, e)
      if (p.hash && p.hash !== cur.hash) return { conflict: true, doc: docOf(t, e, cur) }
      if (typeof p.raw === 'string') {
        guard(t, e)
        try {
          codecOf(t).read(Buffer.from(p.raw))
        } catch (err) {
          return { invalid: { raw: (err as Error).message }, message: `не разбирается: ${(err as Error).message}` }
        }
        writeFileSync(e.file, p.raw)
        const st = statSync(e.file)
        return saved(t, { ...e, mtime: st.mtimeMs, size: st.size })
      }
      const data = { ...(p.data ?? cur.data), [t.idField]: p.id }
      const invalid = check(t, data, false)
      if (Object.keys(invalid).length) return { invalid, message: Object.values(invalid)[0]! }
      const res = saved(t, write(t, p.id, data, e))
      // Правка поля шаблона — обложка устарела: в очередь сразу, не дожидаясь списка (§19.2).
      if (t.coverRule && 'doc' in res && res.doc) {
        const ne = find(t, p.id)
        if (ne) autoCover(t, [{ e: ne, r: readEntry(t, ne), row: res.doc.row }])
      }
      return res
    },
    remove(p) {
      if (p.type === TYPE_TYPE) {
        // Тип — в корзину каталога типов; его записи не трогаются.
        const own = opts.typeDirs().at(-1)
        const removed = p.ids.filter((id) => {
          const t = load().types.get(id)
          if (!t?.file || !own || dirname(t.file) !== own) return false
          trashMove(t.file, own)
          return true
        })
        engine.reload()
        return { removed }
      }
      const t = typeOf(p.type)
      const removed: string[] = []
      for (const id of p.ids) {
        const e = find(t, id)
        if (!e) continue
        guard(t, e)
        const av = avatarOf(e)
        trashMove(e.file, e.dir)
        if (av) trashMove(av, e.dir)
        cache.delete(e.file)
        scans.delete(t.id)
        removed.push(id)
      }
      return { removed }
    },
    duplicate(p) {
      const t = typeOf(p.type)
      const e = find(t, p.id)
      if (!e) throw Object.assign(new Error(`objects: нет ${p.type}/${p.id}`), { code: 'not_found' })
      const r = readEntry(t, e)
      // Копия из своего хранилища (`<хранилище>/<slug>`) — в библиотеку под slug, ссылка помнит хранилище.
      const base = e.layout ? p.id.slice(p.id.indexOf('/') + 1).replace(/\//g, '-') : p.id
      let id = p.newId?.trim() || (e.layout ? base : `${p.id}-copy`)
      if (!p.newId) for (let n = 2; find(t, id); n++) id = e.layout ? `${base}-${n}` : `${p.id}-copy-${n}`
      const ref: ObjectSourceRef = { ...(e.store ? { store: e.store } : {}), type: t.id, id: p.id, hash: fieldsHash(r.data) }
      const data = withSource({ ...r.data, [t.idField]: id }, ref, t.format === 'ccv3')
      const res = engine.create({ type: t.id, data })
      if ('doc' in res) {
        const av = avatarOf(e)
        if (av) {
          const target = join(dirname(res.doc.path!), `${id}${extname(av)}`)
          writeFileSync(target, readFileSync(av))
          return saved(t, find(t, id)!)
        }
      }
      return res
    },
    async importFile(p) {
      const t = typeOf(p.type)
      const imp = opts.importers?.[t.importer ?? ''] ?? opts.importers?.[t.format ?? '']
      const bytes = Buffer.from(p.file.data, 'base64')
      const got = imp ? await imp({ name: p.file.name, mime: p.file.mime, bytes }) : { data: codecOf(t).read(bytes).data }
      const fromName = basename(p.file.name).replace(/\.[^.]+$/, '')
      const slug = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
      let id = p.id?.trim() || textOf(got.data[t.idField]).trim() || slug(textOf(pick(got.data, t.titleField))) || slug(fromName) || 'object'
      if (!p.id) for (let n = 2; find(t, id); n++) id = `${slug(fromName) || 'object'}-${n}`
      const res = engine.create({ type: t.id, data: { ...got.data, [t.idField]: id } })
      if ('doc' in res && got.avatar) {
        writeFileSync(join(dirname(res.doc.path!), `${id}.${got.avatar.ext}`), got.avatar.bytes)
        return saved(t, find(t, id)!)
      }
      return res
    },
    async exportObject(p) {
      const t = typeOf(p.type)
      const e = find(t, p.id)
      if (!e) throw Object.assign(new Error(`objects: нет ${p.type}/${p.id}`), { code: 'not_found' })
      const r = readEntry(t, e)
      const format = p.format ?? t.format ?? 'json'
      const av = avatarOf(e)
      const ex = opts.exporters?.[format]
      if (ex) {
        const { [t.idField]: _id, ...data } = r.data
        const out = await ex({ data, avatar: av ? readFileSync(av) : null }, format)
        return { name: out.name, mime: out.mime, data: out.bytes.toString('base64') }
      }
      return { name: basename(e.file), mime: 'application/json', data: r.bytes.toString('base64') }
    },
    setAvatar(p) {
      const t = typeOf(p.type)
      const e = find(t, p.id)
      if (!e) throw Object.assign(new Error(`objects: нет ${p.type}/${p.id}`), { code: 'not_found' })
      guard(t, e)
      const sub = (p.file.mime.split('/')[1] ?? extname(p.file.name).slice(1) ?? 'png').toLowerCase()
      const ext = sub === 'jpeg' ? 'jpg' : sub.replace(/[^a-z0-9]/g, '') || 'png'
      if (!(IMAGE_EXTS as readonly string[]).includes(ext)) return { invalid: { avatar: `не картинка: ${p.file.mime}` }, message: `не картинка: ${p.file.mime}` }
      const prev = avatarOf(e)
      if (prev) trashMove(prev, e.dir)
      writeFileSync(`${e.file.slice(0, -extname(e.file).length)}.${ext}`, Buffer.from(p.file.data, 'base64'))
      return saved(t, e)
    },
    async links(p) {
      const t = typeOf(p.type)
      const e = find(t, p.id)
      if (!e) return []
      const r = readEntry(t, e)
      const hash = fieldsHash(r.data)
      const out: ObjectLink[] = []
      for (const other of load().types.values()) {
        for (const oe of entries(other)) {
          let or: Read
          try {
            or = readEntry(other, oe)
          } catch {
            continue
          }
          const src = sourceOf(or.data)
          if (!src || src.type !== t.id || src.id !== p.id || (other.id === t.id && oe.id === p.id)) continue
          out.push({ kind: other.id, id: oe.id, title: textOf(pick(or.data, other.titleField)) || oe.id, via: 'copy', ...(src.hash && src.hash !== hash ? { stale: true } : {}), open: { type: other.id, id: oe.id } })
        }
      }
      for (const name of t.links) {
        const prov = opts.links?.[name]
        if (!prov) continue
        try {
          out.push(...(await prov({ type: t.id, id: p.id, data: r.data }, opts.ctx)))
        } catch {
          // Провайдер упал — остальные ссылки видны.
        }
      }
      return out
    },
    async history(p) {
      const t = typeOf(p.type)
      const e = find(t, p.id)
      if (!e) return []
      try {
        const { stdout } = await run('git', ['-C', dirname(e.file), 'log', '--format=%H%x1f%at%x1f%an%x1f%s', '--', basename(e.file)], { maxBuffer: 8 << 20 })
        return String(stdout)
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [rev, at, author, subject] = line.split('\x1f')
            return { rev: rev!, at: Number(at) * 1000, author: author ?? '', subject: subject ?? '' }
          })
      } catch {
        return []
      }
    },
    async render(p) {
      const t = typeOf(p.type)
      const file = t.templateFiles[p.view]
      if (!file) throw Object.assign(new Error(`objects: у типа ${p.type} нет вида-шаблона ${p.view}`), { code: 'not_found' })
      const doc = await engine.get({ type: p.type, id: p.id })
      const text = readFileSync(file, 'utf-8').replace(/^\s*<#[\s\S]*?#>\s*/, '')
      if (!opts.render) return { html: '' }
      return { html: opts.render(text, { ...doc.data, id: doc.id, type: doc.type, row: doc.row }) }
    },
    asset(type, id, rel) {
      const t = load().types.get(type)
      if (!t) return null
      const e = find(t, id)
      if (!e) return null
      if (rel) {
        // Картинка по относительному пути карточки — только внутри папки объекта.
        const root = dirname(e.file)
        const file = resolve(root, rel)
        if (file !== root && !file.startsWith(root + sep)) return null
        if (!existsSync(file) || !statSync(file).isFile()) return null
        return { mime: assetMime(file), bytes: readFileSync(file) }
      }
      const av = avatarOf(e)
      return av ? { mime: mimeOf(av), bytes: readFileSync(av) } : null
    },
    forget(type) {
      scans.delete(type)
    },
    setState(p) {
      return setState(typeOf(p.type), p.id, p.to, p.input ?? {})
    },
    index(p) {
      return writeIndex(typeOf(p.type))
    },
    cover(p) {
      const t = typeOf(p.type)
      if (!t.coverRule) throw Object.assign(new Error(`objects: у типа ${p.type} нет \`## $cover\``), { code: 'not_supported' })
      const queued: Array<{ id: string; job?: string }> = []
      let skipped = 0
      const pool = p.ids?.length ? p.ids.map((id) => find(t, id)).filter((e): e is Entry => !!e) : entries(t)
      for (const e of p.mode === 'one' ? pool.slice(0, 1) : pool) {
        const r = readEntry(t, e)
        const row = rowOf(t, e, r)
        const st = row.coverState
        if (p.mode === 'one') {
          // Явная перегенерация: снять замок; ручную картинку — в корзину, не затирать молча.
          const dir = assetsDir(e.file)
          if (st === 'manual') for (const n of ['cover', 'icon']) for (const x of ['png', 'webp', 'jpg', 'jpeg']) if (existsSync(join(dir, `${n}.${x}`))) trashMove(join(dir, `${n}.${x}`), dir)
          const side = readSidecar(dir)
          if (side?.locked) writeSidecar(dir, { ...side, locked: false })
        } else if (st === 'locked' || st === 'manual' || st === 'queued' || (p.mode === 'missing' && st === 'ready')) {
          skipped += 1
          continue
        }
        queued.push(enqueue(t, e, r, row.hue))
      }
      return { queued, skipped }
    },
    coverLock(p) {
      const t = typeOf(p.type)
      const e = find(t, p.id)
      if (!e) throw Object.assign(new Error(`objects: нет ${p.type}/${p.id}`), { code: 'not_found' })
      const dir = assetsDir(e.file)
      const side = readSidecar(dir) ?? {}
      writeSidecar(dir, { ...side, locked: p.locked })
      return saved(t, e)
    },
    coverStyle(p) {
      const t = typeOf(p.type)
      if (!t.coverRule) throw Object.assign(new Error(`objects: у типа ${p.type} нет \`## $cover\``), { code: 'not_supported' })
      if (p.style && !readCoverStyle(styleDirs(), p.style)) throw Object.assign(new Error(`objects: нет стиля обложки ${p.style}`), { code: 'not_found' })
      if (p.scope === 'type') {
        const f = stateFile()
        if (!f) throw Object.assign(new Error('objects: стенду некуда записать стиль типа'), { code: 'not_supported' })
        const cur = typeStyles()
        if (p.style) cur[t.id] = p.style
        else delete cur[t.id]
        mkdirSync(dirname(f), { recursive: true })
        writeFileSync(f, JSON.stringify(cur, null, 2) + '\n')
        scans.delete(t.id)
        return { style: p.style }
      }
      const e = find(t, p.id ?? '')
      if (!e) throw Object.assign(new Error(`objects: нет ${p.type}/${String(p.id)}`), { code: 'not_found' })
      const cur = readEntry(t, e)
      const data = { ...cur.data }
      if (p.style) data.cover_style = p.style
      else delete data.cover_style
      engine.save({ type: t.id, id: e.id, data })
      return { style: p.style }
    },
    coverStyles(p) {
      const t = typeOf(p.type)
      const cur = typeStyles()[t.id] ?? t.coverRule?.style
      return { styles: listCoverStyles(styleDirs()), ...(cur ? { current: cur } : {}) }
    },
    watched() {
      const s = load()
      const dirs = new Set<string>(engine.typeDirs())
      for (const t of s.types.values()) for (const d of t.dirs) dirs.add(d)
      return [...dirs]
    },
    typeDirs() {
      return opts.typeDirs().flatMap((d) => [d, join(d, 'views'), join(d, 'editors')])
    },
  }
  return engine
}

// ────────────────────────────────────────────────────────────────────────────
// Сервис
// ────────────────────────────────────────────────────────────────────────────

/**
 * `service.ts` сервиса `objects`: методы на `meta.on`, стрим `watch`, картинки — `http`
 * (`GET /services/objects/http/asset/<type>/<id>`).
 */
export function createObjectsService(opts: ObjectsServiceOpts): (ctx: unknown, meta: ServiceMeta) => void {
  return (ctx, meta) => {
    const engine = createObjectsEngine({
      typeDirs: () => opts.typeDirs(meta, ctx),
      vars: (name) => opts.vars?.(name, ctx),
      base: meta.root,
      ...(opts.codecs ? { codecs: opts.codecs } : {}),
      ...(opts.layouts ? { layouts: opts.layouts } : {}),
      ...(opts.render ? { render: opts.render } : {}),
      ...(opts.importers ? { importers: opts.importers } : {}),
      ...(opts.exporters ? { exporters: opts.exporters } : {}),
      ...(opts.links ? { links: opts.links } : {}),
      ...(opts.cover ? { cover: opts.cover } : {}),
      ...(opts.coverStyleDirs ? { coverStyleDirs: () => opts.coverStyleDirs!(meta, ctx) } : {}),
      stateDir: meta.dataDir,
      ctx,
    })
    const P = (p: unknown): Record<string, unknown> => (isRecord(p) ? p : {})
    const str = (v: unknown, name: string): string => {
      if (typeof v !== 'string' || v === '') throw Object.assign(new Error(`objects: нужен ${name}`), { code: 'bad_request' })
      return v
    }
    meta.on('types', () => {
      engine.reload()
      return engine.types()
    })
    meta.on('list', (p) => engine.list(P(p) as unknown as ObjectQuery))
    meta.on('get', (p) => engine.get({ type: str(P(p).type, 'type'), id: str(P(p).id, 'id'), ...(typeof P(p).rev === 'string' ? { rev: P(p).rev as string } : {}) }))
    meta.on('create', (p) => engine.create({ type: str(P(p).type, 'type'), data: isRecord(P(p).data) ? (P(p).data as Record<string, unknown>) : {} }))
    meta.on('save', (p) => {
      const q = P(p)
      return engine.save({
        type: str(q.type, 'type'),
        id: str(q.id, 'id'),
        ...(isRecord(q.data) ? { data: q.data } : {}),
        ...(typeof q.raw === 'string' ? { raw: q.raw } : {}),
        ...(typeof q.hash === 'string' ? { hash: q.hash } : {}),
      })
    })
    meta.on('remove', (p) => engine.remove({ type: str(P(p).type, 'type'), ids: Array.isArray(P(p).ids) ? (P(p).ids as unknown[]).filter((x): x is string => typeof x === 'string') : [] }))
    meta.on('action', async (p) => {
      const q = P(p)
      const type = str(q.type, 'type')
      const input = P(q.input)
      switch (q.action) {
        case 'duplicate':
          return engine.duplicate({ type, id: str(q.id, 'id'), ...(typeof input.newId === 'string' ? { newId: input.newId } : {}) })
        case 'import': {
          const f = P(input.file)
          return engine.importFile({ type, file: { name: str(f.name, 'file.name'), mime: typeof f.mime === 'string' ? f.mime : '', data: str(f.data, 'file.data') }, ...(typeof input.id === 'string' ? { id: input.id } : {}) })
        }
        case 'avatar': {
          const f = P(input.file)
          return engine.setAvatar({ type, id: str(q.id, 'id'), file: { name: str(f.name, 'file.name'), mime: typeof f.mime === 'string' ? f.mime : '', data: str(f.data, 'file.data') } })
        }
        case 'export':
          return engine.exportObject({ type, id: str(q.id, 'id'), ...(typeof input.format === 'string' ? { format: input.format } : {}) })
        case 'index':
          return engine.index({ type })
        case 'cover': {
          const mode = input.mode === 'all' || input.mode === 'missing' ? input.mode : typeof q.id === 'string' ? 'one' : 'missing'
          const ids = Array.isArray(input.ids) ? (input.ids as unknown[]).filter((x): x is string => typeof x === 'string') : typeof q.id === 'string' ? [q.id] : undefined
          return engine.cover({ type, mode, ...(ids ? { ids } : {}) })
        }
        case 'cover-lock':
          return engine.coverLock({ type, id: str(q.id, 'id'), locked: input.locked !== false })
        case 'cover-style':
          return engine.coverStyle({ type, ...(typeof q.id === 'string' ? { id: q.id } : {}), style: typeof input.style === 'string' ? input.style : '', scope: input.scope === 'type' ? 'type' : 'record' })
        case 'cover-styles':
          return engine.coverStyles({ type })
        default: {
          // Переход `$states`: действие — целевое состояние (`accepted`, `returned`…).
          const def = engine.type(type)
          const to = String(q.action ?? '')
          if (def.states && Object.values(def.states.transitions).some((xs) => xs.includes(to))) return engine.setState({ type, id: str(q.id, 'id'), to, input })
        }
          throw Object.assign(new Error(`objects: нет действия ${String(q.action)}`), { code: 'not_supported' })
      }
    })
    meta.on('links', (p) => engine.links({ type: str(P(p).type, 'type'), id: str(P(p).id, 'id') }))
    meta.on('history', (p) => engine.history({ type: str(P(p).type, 'type'), id: str(P(p).id, 'id') }))
    meta.on('render', (p) => engine.render({ type: str(P(p).type, 'type'), id: str(P(p).id, 'id'), view: str(P(p).view, 'view') }))
    meta.on('http', (p) => {
      const path = String(P(p).path ?? '')
      // `/asset/<тип>/<id>/<rel>` — файл по относительному пути карточки; `/asset/<тип>/<id>` — аватар.
      const rel = /^\/asset\/([^/]+)\/([^/]+)\/(.+)$/.exec(path)
      const m = /^\/asset\/([^/]+)\/(.+)$/.exec(path)
      const dec = (x: string): string => decodeURIComponent(x)
      const a = (rel ? engine.asset(dec(rel[1]!), dec(rel[2]!), rel[3]!.split('/').map(dec).join('/')) : null) ?? (m ? engine.asset(dec(m[1]!), dec(m[2]!)) : null)
      if (!a) return { status: 404, body: 'нет картинки' }
      return { status: 200, headers: { 'content-type': a.mime, 'cache-control': 'max-age=3600' }, body: { __b64: a.bytes.toString('base64') } }
    })
    const sinks = new Set<ServiceSink>()
    let stop: (() => void) | null = null
    meta.stream(
      'watch',
      (_p, sink: ServiceSink, signal) =>
        new Promise<void>((done) => {
          sinks.add(sink)
          stop ??= watchDirs(engine, sinks, opts.watch !== false)
          signal.addEventListener('abort', () => {
            sinks.delete(sink)
            if (!sinks.size) {
              stop?.()
              stop = null
            }
            done()
          })
        }),
    )
  }
}

/**
 * Слежение: изменился файл типа/вида — `types`; файл коллекции — `changed` с id.
 * Один набор вотчей на всех подписчиков: вкладок много, дерево одно.
 */
function watchDirs(engine: ObjectsEngine, sinks: Set<ServiceSink>, enabled: boolean): () => void {
  const emit: ServiceSink = (kind, data) => {
    for (const s of sinks) s(kind, data)
  }
  const watchers: TreeWatch[] = []
  let armed = ''
  let timer: NodeJS.Timeout | null = null
  let typesDirty = false
  const changed = new Map<string, Set<string>>()
  const flush = (): void => {
    timer = null
    if (typesDirty) {
      typesDirty = false
      engine.reload()
      emit('types', {})
      arm()
    }
    for (const [type, ids] of changed) {
      engine.forget(type)
      emit('changed', { type, ids: [...ids] })
    }
    changed.clear()
  }
  const bump = (): void => {
    if (!timer) timer = setTimeout(flush, 120)
  }
  const onEvent = (dir: string, name: string): void => {
    if (name.split(/[\\/]/).includes(TRASH)) return
    if (engine.typeDirs().includes(dir) && /\.(mdz|ntpl|json)$/.test(name)) typesDirty = true
    for (const t of engine.types().types) {
      const def = engine.type(t.id)
      const at = def.dirs.indexOf(dir)
      if (at < 0) continue
      const mask = def.masks[at] ?? null
      const relName = name.split(sep).join('/')
      // Обложка, иконка, sidecar записи (`<запись>.assets/…`, §19.2) — коллекция перечитывается.
      if (/\.assets\//.test(relName)) {
        changed.set(t.id, changed.get(t.id) ?? new Set<string>())
        continue
      }
      if (mask !== null || def.idFrom.kind !== 'path') {
        // id не из пути — коллекция перечитывается целиком, если файл под маской.
        if (mask === null ? relName.endsWith(def.ext ?? '') : maskRe(mask).test(relName)) changed.set(t.id, changed.get(t.id) ?? new Set<string>())
        continue
      }
      const stem = name.replace(/\.[^./\\]+$/, '').split(sep).join('/')
      if (stem) {
        const set = changed.get(t.id) ?? new Set<string>()
        set.add(stem)
        changed.set(t.id, set)
      }
    }
    bump()
  }
  const arm = (): void => {
    const dirs = enabled ? engine.watched().filter((d) => existsSync(d)) : []
    const key = dirs.join('\n')
    if (key === armed) return
    armed = key
    for (const w of watchers.splice(0)) w.close()
    for (const dir of dirs) {
      try {
        watchers.push(watchTree(dir, (name) => onEvent(dir, name)))
      } catch {
        // Каталог исчез между проверкой и watch — следующий опрос подберёт.
      }
    }
  }
  // Каталог мог появиться после старта (новый `envs/types`): опрос раз в 2 с недорогой.
  const poll = setInterval(() => {
    const before = armed
    arm()
    if (armed !== before) {
      engine.reload()
      emit('types', {})
    }
  }, 2000)
  arm()
  return () => {
    clearInterval(poll)
    if (timer) clearTimeout(timer)
    for (const w of watchers) w.close()
  }
}

export { assetsDir, colorOf, coverStateOf, hueName, parseColorRule, parseCoverRule, parseSlices } from './objects-cover.js'
export type { CoverGenerator, CoverJobRequest, CoverRule, CoverSidecar, ColorRuleDef } from './objects-cover.js'
