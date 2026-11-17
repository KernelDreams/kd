/**
 * Кэш каталога и объявлений для подсказок (kd-cli-spec §6): лёгкая точка входа `kd __complete`
 * читает его без загрузки рантайма. Пересобирается, когда меняются слои (метка — время изменения
 * каталогов тулов, файлов правил и объявлений).
 */

import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ValueSource } from '../complete-values.js'
import { expandHome } from './home.js'
import { providersFile, readProviders } from './providers.js'
import type { Catalog } from './catalog.js'
import { describeEntry, loadDecl, staticDecl } from './catalog.js'
import type { Layers } from './layers.js'
import { actionWord, linkFiles, loadRules } from './objects.js'

export const CACHE_VERSION = 2

export interface CachedField {
  name: string
  title?: string
  kind?: string
  type: string
  enum?: string[]
  default?: unknown
  for?: string[]
  pos?: number
  rest?: boolean
}

export interface CachedTool {
  description: string
  actions: Array<{ name: string; title?: string; default?: boolean }>
  fields: CachedField[]
}

export interface CompletionCache {
  v: number
  stamp: string
  tools: Record<string, CachedTool>
  /** Правила объектов: шаблон и вид. */
  rules: Array<{ id: string; pattern: string; kind?: string }>
  /** Действия объектов для kd: вид / id правила → слово, подпись. */
  actions: Array<{ for: string; word: string; title?: string }>
  /** Источники значений для Tab по видам (модели, машины, боты, задачи, сессии, скиллы). */
  values: ValueSource[]
  /**
   * Метки файлов настроек слоёв (путь → «время правки:размер», нет файла — «-»): лёгкая точка подсказок
   * сверяет их без рантайма и пересобирает кэш, если `settings.mdz` или файл `$layers` поменялся.
   */
  files?: Record<string, string>
}

export const cacheFile = (l: Layers): string => join(l.copy.dataDir, 'cache', 'catalog.json')

const mtime = (p: string): number => {
  try {
    return statSync(p).mtimeMs
  } catch {
    return 0
  }
}

/** Время правки и размер: замена файла тем же временем (копия с сохранением mtime) всё равно меняет метку. */
export const fileMark = (p: string): string => {
  try {
    const st = statSync(p)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return '-'
  }
}

export function layersStamp(l: Layers, c: Catalog): string {
  const parts: string[] = [`v${CACHE_VERSION}`]
  // Настройки слоёв (`settings.mdz`, файлы `$layers`, регистрации сборок): в них источники Tab (`## $complete`) и пути.
  for (const f of settingsFiles(l)) parts.push(`${f}:${fileMark(f)}`)
  for (const layer of l.layers) {
    for (const d of layer.toolDirs) parts.push(`${d}:${mtime(d)}`)
  }
  for (const { file } of linkFiles(l, c)) parts.push(`${file}:${mtime(file)}`)
  for (const t of c.tools.values()) parts.push(`${t.name}:${mtime(t.declFile ?? t.file)}`)
  // Простая сумма — метка, а не криптография.
  let h = 0
  const s = parts.join('|')
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return `${c.tools.size}:${h}`
}

export function readCache(file: string): CompletionCache | null {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8')) as CompletionCache
    return c.v === CACHE_VERSION ? c : null
  } catch {
    return null
  }
}

/** Пересобрать кэш, если слои изменились. Возвращает, пересобран ли. */
export async function writeCache(l: Layers, c: Catalog, force = false): Promise<boolean> {
  const file = cacheFile(l)
  const stamp = layersStamp(l, c)
  if (!force && readCache(file)?.stamp === stamp) return false
  const tools: Record<string, CachedTool> = {}
  for (const t of c.tools.values()) {
    let decl = null
    try {
      decl = staticDecl(t) ?? (t.layer === "kit" && /\.mjs$/.test(t.file) ? await loadDecl(t) : null)
    } catch {
      decl = null
    }
    tools[t.name] = {
      description: decl?.description || describeEntry(t),
      actions: decl?.actions.map((a) => ({ name: a.name, ...(a.title ? { title: a.title } : {}), ...(a.default ? { default: true } : {}) })) ?? [],
      fields:
        decl?.fields.map((f) => {
          const ui = f.schema['x-ui']
          return {
            name: f.name,
            type: f.schema.type,
            ...(f.schema.title ? { title: f.schema.title } : {}),
            ...(ui.kind ? { kind: ui.kind } : {}),
            ...(f.schema.enum ? { enum: f.schema.enum } : {}),
            ...(f.schema.default !== undefined ? { default: f.schema.default } : {}),
            ...(ui.for ? { for: ui.for } : {}),
            ...(ui.pos !== undefined ? { pos: ui.pos } : {}),
            ...(ui.rest ? { rest: true } : {}),
          }
        }) ?? [],
    }
  }
  const rules = loadRules(l, c)
  const cache: CompletionCache = {
    v: CACHE_VERSION,
    stamp,
    tools,
    rules: rules.links.filter((r) => r.pattern).map((r) => ({ id: r.id, pattern: r.pattern!, ...(r.kind ? { kind: r.kind } : {}) })),
    actions: rules.actions.filter((a) => ['kd', 'exec', 'script'].includes(a.run)).map((a) => ({ for: a.for, word: actionWord(a), ...(a.title ? { title: a.title } : {}) })),
    values: valueSources(l),
    files: Object.fromEntries(settingsFiles(l).map((f) => [f, fileMark(f)])),
  }
  const tmp = `${file}.${process.pid}.tmp`
  // В источниках сети бывают заголовки с ключом — файл только владельцу.
  writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 })
  renameSync(tmp, file)
  return true
}

/** Файлы, где ищутся блоки `## $complete`: настройки слоёв и конфиги студийного профиля. */
function settingsFiles(l: Layers): string[] {
  return [...new Set([...l.settingsFiles, ...l.layers.flatMap((x) => x.configFiles)])]
}

const read = (f: string): string => {
  try {
    return readFileSync(f, 'utf8')
  } catch {
    return ''
  }
}

/** Блоки `## $<section> <name>` текста: имя → строки атрибутов. */
function blocks(text: string, section: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = []
  const parts = text.split(/^(?=## )/m)
  for (const p of parts) {
    const m = new RegExp(`^## \\$${section}(?:[ \\t]+(\\S+))?[ \\t]*$`, 'm').exec(p.split('\n')[0]!)
    if (m) out.push({ name: m[1] ?? '', body: p })
  }
  return out
}

const attr = (body: string, k: string): string | undefined => {
  const v = new RegExp(`^\\$${k.replace(/[.]/g, '\\.')}:[ \\t]*(.*)$`, 'm').exec(body)?.[1]?.trim()
  if (v === undefined) return undefined
  return /^(['"]).*\1$/.test(v) ? v.slice(1, -1) : v
}

/** Остальные файлы настроек слоёв: `${блок.ключ}` ищется в своём файле, потом в них. */
let otherTexts: string[] = []

/** `${имя}` — корневой атрибут файла, `${блок.ключ}` — атрибут блока `## $блок`; `${env.X}` остаётся до вызова. */
function subst(v: string, text: string): string {
  return v.replace(/\$\{([\w-]+)(?:\.([\w-]+))?\}/g, (all, a: string, b?: string) => {
    if (a === 'env') return all
    for (const t of [text, ...otherTexts]) {
      if (!b) {
        const r = attr(t.split(/^## /m)[0] ?? '', a)
        if (r !== undefined) return r
        continue
      }
      const blk = blocks(t, a).find((x) => !x.name)
      const r = blk && attr(blk.body, b)
      if (r !== undefined && r !== '') return r
    }
    return ''
  })
}

function parseSource(kind: string, body: string, text: string, base: string): ValueSource {
  const s: ValueSource = { kind }
  const g = (k: string): string | undefined => {
    const v = attr(body, k)
    return v === undefined ? undefined : subst(v, text)
  }
  const list = g('list')
  if (list) s.list = list.replace(/^\$?\[|\]$/g, '').split(',').map((x) => x.trim()).filter(Boolean)
  const abs = (p: string): string => {
    const e = expandHome(p)
    return e.startsWith('/') || /^[A-Za-z]:[\\/]/.test(e) ? e : join(base, e)
  }
  const dir = g('dir')
  if (dir) s.dir = abs(dir)
  const ext = g('ext')
  if (ext) s.ext = ext.replace(/^\$?\[|\]$/g, '')
  const bl = g('blocks')
  if (bl) s.blocks = abs(bl)
  const sec = g('section')
  if (sec) s.section = sec
  for (const k of ['url', 'method', 'body', 'path', 'value', 'label'] as const) {
    const v = g(k)
    if (v) s[k] = v
  }
  const ttl = Number(g('ttl'))
  if (ttl > 0) s.ttl = ttl
  const headers: Record<string, string> = {}
  for (const m of body.matchAll(/^\$headers\.([\w-]+):[ \t]*(.+)$/gm)) headers[m[1]!] = subst(m[2]!.trim(), text)
  if (Object.keys(headers).length) s.headers = headers
  return s
}

/**
 * Источники значений для Tab: блоки `## $complete <вид>` настроек и конфигов слоёв, плюс
 * встроенные — сессии копии, машины (`## $hosts`), боты (`$bots`), модели провайдера по
 * умолчанию. Заявленный блоком вид встроенный источник того же вида заменяет.
 */
export function valueSources(l: Layers): ValueSource[] {
  const own: ValueSource[] = []
  const auto: ValueSource[] = [{ kind: 'session', dir: join(l.copy.dataDir, 'sessions', '{cwd}'), ext: '.mds' }]
  const files = settingsFiles(l)
  otherTexts = files.map(read).filter(Boolean)
  for (const f of files) {
    const text = read(f)
    if (!text) continue
    const base = join(f, '..')
    for (const b of blocks(text, 'complete')) if (b.name) own.push(parseSource(b.name, b.body, text, base))
    if (blocks(text, 'hosts').some((b) => b.name)) auto.push({ kind: 'host', blocks: f, section: 'hosts' })
    const bots = attr(text.split(/^## /m)[0] ?? '', 'bots')
    if (bots) auto.push({ kind: 'bot', dir: expandHome(bots), ext: '.json,.mdz,.png,.md' })
  }
  // Модели: провайдер по умолчанию — свой файл kd, иначе конфиг студийного профиля.
  const kp = readProviders(providersFile(l))
  const kdef = kp.list.find((p) => p.name === kp.default) ?? kp.list[0]
  if (kdef?.baseUrl) auto.push({ kind: 'model', url: `${kdef.baseUrl.replace(/\/+$/, '')}/models`, path: 'data', value: 'id', ...(kdef.key ? { headers: { authorization: `Bearer ${'$'}{env.${kdef.key}}` } } : {}) })
  else {
    for (const f of l.layers.flatMap((x) => x.configFiles)) {
      const text = read(f)
      const def = attr(text.split(/^## /m)[0] ?? '', 'default_provider')
      const blk = def && blocks(text, 'provider').find((b) => b.name === def)
      const url = blk && attr(blk.body, 'base_url')
      if (!blk || !url) continue
      const key = subst(attr(blk.body, 'api_key') ?? '', text)
      auto.push({ kind: 'model', url: `${url.replace(/\/+$/, '')}/models`, path: 'data', value: 'id', ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}) })
      break
    }
  }
  const claimed = new Set(own.map((s) => s.kind))
  return [...own, ...auto.filter((s) => !claimed.has(s.kind))]
}
