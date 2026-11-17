/**
 * Реестр плагинов — git-репа (plugin-registry-spec §6), подключается только на чтение: клон в `<слой>/.registries/<id>`,
 * обновление — по команде и при старте не чаще раза в N часов. Раскладка:
 *
 *   registry.mdz             имя, описание, версия схемы
 *   entries/<id>.mdz         плагин в чужой репе: `$url`, `$tag`, описание, места, `$api`
 *   plugins/<id>.mdz         короткий плагин-файл прямо в реестре
 *   plugins/<id>/            артефакт прямо в реестре
 *   skills/<id>/  skins/<id>.skin.css  icon-packs/<id>/  distributions/<id>.json
 *
 * Снимок комплекта (Pix): реестр без сети — папка-копия, пока клона нет или сеть упала.
 * Опубликовать = добавить файл и запушить (`publishEntry`, `runz plugins publish`).
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { git, isGitDir, splitRef } from './git.js'
import { headerList, mdzHeader, renderHeader } from './mdz.js'
import { PLUGIN_ID, PluginError, dirManifest, fileManifest, type PluginManifest, type PluginWeight } from './manifest.js'
import { ensureLayer, readRegistries, registryDir, writeRegistries, type RegistryRef, type RegistryState } from './layer.js'
import { repoName } from './install.js'

export const REGISTRY_SCHEMA = 1

/** Id реестра из ссылки (`…/nr-plugins.git` → `nr-plugins`). */
export const registryIdOf = (url: string): string => repoName(url)

export interface RegistryInfo {
  id: string
  title: string
  description?: string
  schema?: number
  dir: string
}

/** Запись реестра: плагин в чужой репе (`entries/<id>.mdz`). */
export interface RegistryEntry {
  id: string
  url: string
  tag?: string
  title?: string
  description?: string
  places?: string[]
  handles?: string[]
  api?: string
  icon?: string
  weight?: PluginWeight
  file: string
}

/** Плагин, лежащий прямо в реестре (`plugins/<id>.mdz` или `plugins/<id>/`). */
export interface RegistryPlugin {
  manifest: PluginManifest
  /** Файл или папка. */
  path: string
}

export interface RegistryContent {
  info: RegistryInfo
  entries: RegistryEntry[]
  plugins: RegistryPlugin[]
  skills: string[]
  skins: string[]
  iconPacks: string[]
  distributions: string[]
}

const names = (dir: string): string[] => {
  try {
    return readdirSync(dir)
      .filter((n) => !n.startsWith('.') && !n.startsWith('_'))
      .sort()
  } catch {
    return []
  }
}
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function readRegistry(dir: string, id = basename(dir)): RegistryContent {
  let h: Record<string, string> = {}
  try {
    h = mdzHeader(readFileSync(join(dir, 'registry.mdz'), 'utf8'))
  } catch {
    // без registry.mdz — реестр с id папки
  }
  const info: RegistryInfo = {
    id,
    title: h.title || id,
    ...(h.description ? { description: h.description } : {}),
    ...(Number.isFinite(Number(h.schema)) && h.schema ? { schema: Number(h.schema) } : {}),
    dir,
  }
  const entries: RegistryEntry[] = []
  for (const n of names(join(dir, 'entries'))) {
    if (extname(n) !== '.mdz') continue
    const file = join(dir, 'entries', n)
    const e = mdzHeader(readFileSync(file, 'utf8'))
    if (!e.url) continue
    const w = e.weight as PluginWeight | undefined
    entries.push({
      id: e.id || basename(n, '.mdz'),
      url: e.url,
      file,
      ...(e.tag ? { tag: e.tag } : {}),
      ...(e.title ? { title: e.title } : {}),
      ...(e.description ? { description: e.description } : {}),
      ...(headerList(e.places).length ? { places: headerList(e.places) } : {}),
      ...(headerList(e.handles).length ? { handles: headerList(e.handles) } : {}),
      ...(e.api ? { api: e.api } : {}),
      ...(e.icon ? { icon: e.icon } : {}),
      ...(w === 'file' || w === 'artifact' || w === 'code' ? { weight: w } : {}),
    })
  }
  const plugins: RegistryPlugin[] = []
  for (const n of names(join(dir, 'plugins'))) {
    const path = join(dir, 'plugins', n)
    const m = isDir(path) ? dirManifest(path) : fileManifest(path)
    if (m) plugins.push({ manifest: m, path })
  }
  return {
    info,
    entries,
    plugins,
    skills: names(join(dir, 'skills')).filter((n) => isDir(join(dir, 'skills', n))),
    skins: names(join(dir, 'skins')).filter((n) => n.endsWith('.skin.css')).map((n) => n.slice(0, -'.skin.css'.length)),
    iconPacks: names(join(dir, 'icon-packs')).filter((n) => isDir(join(dir, 'icon-packs', n))),
    distributions: names(join(dir, 'distributions')).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)),
  }
}

export interface SyncOpts {
  /** Не чаще раза в столько часов (кроме `force`); default 6. */
  maxAgeHours?: number
  force?: boolean
  now?: () => Date
}

export interface SyncResult {
  id: string
  /** `cloned` / `updated` — сходили в сеть; `fresh` — не время; `snapshot` — стоит снимок; `failed` — ошибка в `error`. */
  status: 'cloned' | 'updated' | 'fresh' | 'snapshot' | 'failed'
  error?: string
}

/** Нормализовать список из настройки: строки-ссылки или `{url, id?, snapshot?}`. */
export function normalizeRegistries(raw: unknown): RegistryRef[] {
  const out: RegistryRef[] = []
  for (const item of Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\n,]/) : []) {
    const r: RegistryRef | null =
      typeof item === 'string'
        ? item.trim()
          ? { id: registryIdOf(item.trim()), url: item.trim() }
          : null
        : item && typeof item === 'object' && (typeof (item as RegistryRef).url === 'string' || typeof (item as RegistryRef).snapshot === 'string')
          ? (() => {
              const x = item as RegistryRef
              const id = x.id || (x.url ? registryIdOf(x.url) : basename(x.snapshot!))
              return { id, ...(x.url ? { url: x.url } : {}), ...(x.snapshot ? { snapshot: x.snapshot } : {}), ...(x.title ? { title: x.title } : {}) }
            })()
          : null
    if (r && PLUGIN_ID.test(r.id) && !out.some((o) => o.id === r.id)) out.push(r)
  }
  return out
}

function placeSnapshot(dst: string, snapshot: string): void {
  rmSync(dst, { recursive: true, force: true })
  mkdirSync(join(dst, '..'), { recursive: true })
  cpSync(snapshot, dst, { recursive: true, filter: (p) => !/[\\/]\.git([\\/]|$)/.test(p) })
}

/**
 * Подключить реестры списком (порядок = каскад) и обновить те, кому пора. Сеть упала — остаётся прежний клон или
 * снимок, ошибка — в состоянии. Реестры, которых в списке больше нет, — отключаются (клон удаляется).
 */
export function syncRegistries(layer: string, refs: readonly RegistryRef[], opts: SyncOpts = {}): SyncResult[] {
  ensureLayer(layer)
  const now = opts.now?.() ?? new Date()
  const maxAge = (opts.maxAgeHours ?? 6) * 3600_000
  const file = readRegistries(layer)
  const state: Record<string, RegistryState> = {}
  const results: SyncResult[] = []
  for (const ref of refs) {
    const dir = registryDir(layer, ref.id)
    const prev = file.state[ref.id] ?? {}
    const st: RegistryState = { ...prev }
    const cloned = existsSync(join(dir, '.git')) && isGitDir(dir)
    const due = opts.force || !cloned || !prev.fetchedAt || now.getTime() - Date.parse(prev.fetchedAt) >= maxAge
    if (!ref.url || !due) {
      if (!cloned && !existsSync(dir) && ref.snapshot && existsSync(ref.snapshot)) placeSnapshot(dir, ref.snapshot)
      const snap = !cloned && existsSync(dir)
      state[ref.id] = { ...st, ...(snap ? { snapshot: true } : {}) }
      results.push({ id: ref.id, status: snap ? 'snapshot' : 'fresh' })
      continue
    }
    try {
      if (cloned) {
        git(['fetch', '--quiet', '--depth', '1', 'origin'], dir)
        git(['reset', '--quiet', '--hard', 'FETCH_HEAD'], dir)
        git(['clean', '-fdq'], dir)
        results.push({ id: ref.id, status: 'updated' })
      } else {
        const tmp = mkdtempSync(join(tmpdir(), 'nr-registry-'))
        try {
          git(['clone', '--quiet', '--depth', '1', ref.url, join(tmp, 'r')])
          rmSync(dir, { recursive: true, force: true })
          mkdirSync(join(dir, '..'), { recursive: true })
          cpSync(join(tmp, 'r'), dir, { recursive: true })
        } finally {
          rmSync(tmp, { recursive: true, force: true })
        }
        results.push({ id: ref.id, status: 'cloned' })
      }
      st.fetchedAt = now.toISOString()
      st.commit = git(['rev-parse', 'HEAD'], dir)
      delete st.error
      delete st.snapshot
    } catch (err) {
      st.error = (err as Error).message
      if (!existsSync(dir) && ref.snapshot && existsSync(ref.snapshot)) placeSnapshot(dir, ref.snapshot)
      // Не клон, но папка есть — снимок комплекта (положил старт комплекта или прошлый вызов): работает без сети.
      if (!cloned && existsSync(dir)) st.snapshot = true
      results.push({ id: ref.id, status: 'failed', error: st.error })
    }
    state[ref.id] = st
  }
  for (const old of file.registries) {
    if (!refs.some((r) => r.id === old.id)) rmSync(registryDir(layer, old.id), { recursive: true, force: true })
  }
  writeRegistries(layer, { registries: [...refs], state })
  return results
}

/**
 * Снимок реестра из комплекта продукта (Pix, §11 п.2): реестр работает без сети. Клон уже есть — не трогается (он
 * свежее, обновляет его `syncRegistries`); нет клона — папка снимка кладётся заново (новая версия комплекта — новый
 * снимок). Реестра нет в списке подключённых — встаёт первым.
 */
export function seedRegistry(layer: string, ref: RegistryRef & { snapshot: string }): 'kept' | 'seeded' {
  ensureLayer(layer)
  const dir = registryDir(layer, ref.id)
  const file = readRegistries(layer)
  if (!file.registries.some((r) => r.id === ref.id)) file.registries.unshift({ id: ref.id, ...(ref.url ? { url: ref.url } : {}), ...(ref.title ? { title: ref.title } : {}) })
  const cloned = existsSync(join(dir, '.git')) && isGitDir(dir)
  if (!cloned) {
    placeSnapshot(dir, ref.snapshot)
    file.state[ref.id] = { ...(file.state[ref.id] ?? {}), snapshot: true }
  }
  writeRegistries(layer, file)
  return cloned ? 'kept' : 'seeded'
}

/** Подключённые реестры с содержимым — в порядке каскада; папки нет — мимо. */
export function connectedRegistries(layer: string): Array<RegistryContent & { ref: RegistryRef; state: RegistryState }> {
  const file = readRegistries(layer)
  const out: Array<RegistryContent & { ref: RegistryRef; state: RegistryState }> = []
  for (const ref of file.registries) {
    const dir = registryDir(layer, ref.id)
    if (!isDir(dir)) continue
    const content = readRegistry(dir, ref.id)
    if (ref.title) content.info.title = ref.title
    out.push({ ...content, ref, state: file.state[ref.id] ?? {} })
  }
  return out
}

/** Каркас пустого реестра (новая репа). */
export function scaffoldRegistry(dir: string, title: string, description = ''): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'registry.mdz'), renderHeader([['title', title], ['description', description || undefined], ['schema', String(REGISTRY_SCHEMA)]], 'Реестр плагинов nrchat (plugin-registry-spec §6). Опубликовать = добавить файл и запушить (runz plugins publish).'))
  for (const d of ['entries', 'plugins', 'skills', 'skins', 'icon-packs', 'distributions']) {
    mkdirSync(join(dir, d), { recursive: true })
    if (names(join(dir, d)).length === 0) writeFileSync(join(dir, d, '.gitkeep'), '')
  }
}

/** Текст записи `entries/<id>.mdz`. */
export function entryText(e: Omit<RegistryEntry, 'file'>): string {
  return renderHeader(
    [
      ['id', e.id],
      ['title', e.title],
      ['description', e.description],
      ['url', e.url],
      ['tag', e.tag],
      ['weight', e.weight],
      ['api', e.api],
      ['places', e.places],
      ['handles', e.handles],
      ['icon', e.icon],
    ],
    'Плагин в своей репе (plugin-registry-spec §6). Ставится: runz plugins install <url>#<tag> или «Установить» в списке плагинов.',
  )
}

export interface PublishOpts {
  /** Реестр: ссылка на git (клон во временную папку) или рабочая копия. */
  registry: string
  /** Что публикуется: ссылка `url#тег` (запись `entries/`) или путь к файлу / папке плагина (в `plugins/`). */
  source: string
  /** Сообщение коммита. */
  message?: string
  /** Без push (тесты, сухой прогон). */
  noPush?: boolean
}

export interface PublishResult {
  id: string
  file: string
  commit: string
  pushed: boolean
}

/**
 * Опубликовать в реестр: файл записи или плагина + коммит + push. Ссылку — записью `entries/<id>.mdz` (манифест
 * читается из клона на теге), путь — копией в `plugins/`.
 */
export function publishEntry(opts: PublishOpts): PublishResult {
  const isUrl = /^(https?|ssh|git|file):\/\//.test(opts.registry) || /^[\w.-]+@[\w.-]+:/.test(opts.registry)
  const tmp = mkdtempSync(join(tmpdir(), 'nr-publish-'))
  try {
    const repo = isUrl ? join(tmp, 'registry') : opts.registry
    if (isUrl) git(['clone', '--quiet', opts.registry, repo])
    if (!isGitDir(repo)) throw new PluginError(`${repo}: не git-репа реестра`, 'bad_request')
    if (!existsSync(join(repo, 'registry.mdz'))) scaffoldRegistry(repo, basename(repo))
    let id: string
    let rel: string
    const looksUrl = /^(https?|ssh|git|file):\/\//.test(splitRef(opts.source).url) || /^[\w.-]+@[\w.-]+:/.test(opts.source)
    if (looksUrl) {
      const { url, tag } = splitRef(opts.source)
      const probe = join(tmp, 'plugin')
      git(['clone', '--quiet', url, probe])
      if (tag) git(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', `refs/tags/${tag}`], probe)
      const m = dirManifest(probe, repoName(url))
      if (!m) throw new PluginError(`${url}: не плагин`, 'not_plugin')
      if (m.weight === 'code' && !m.built) throw new PluginError(`плагин не собран: в ${url}${tag ? `#${tag}` : ''} нет dist/index.js`, 'not_built')
      id = m.id
      rel = join('entries', `${id}.mdz`)
      mkdirSync(join(repo, 'entries'), { recursive: true })
      writeFileSync(
        join(repo, rel),
        entryText({ id, url, ...(tag ? { tag } : {}), weight: m.weight, ...(m.title ? { title: m.title } : {}), ...(m.description ? { description: m.description } : {}), ...(m.api ? { api: m.api } : {}), ...(m.places ? { places: m.places } : {}), ...(m.handles ? { handles: m.handles } : {}), ...(m.icon ? { icon: m.icon } : {}) }),
      )
    } else {
      const src = opts.source
      const m = isDir(src) ? dirManifest(src) : fileManifest(src)
      if (!m) throw new PluginError(`${src}: не плагин-файл и не артефакт`, 'not_plugin')
      if (m.weight === 'code') throw new PluginError('плагин со сборкой публикуется ссылкой на его репу (url#тег) — в реестр кладётся запись entries/', 'bad_request')
      id = m.id
      rel = join('plugins', basename(src))
      const dst = join(repo, rel)
      rmSync(dst, { recursive: true, force: true })
      mkdirSync(join(repo, 'plugins'), { recursive: true })
      cpSync(src, dst, { recursive: true, filter: (p) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(p) })
    }
    git(['add', '--all', '--', rel], repo)
    if (git(['status', '--porcelain', '--', rel], repo) === '') {
      return { id, file: join(repo, rel), commit: git(['rev-parse', 'HEAD'], repo), pushed: false }
    }
    git(['commit','--quiet', '-m', opts.message ?? `publish ${id}`, '--', rel], repo)
    const commit = git(['rev-parse', 'HEAD'], repo)
    if (!opts.noPush) git(['push', '--quiet', 'origin', 'HEAD'], repo)
    return { id, file: isUrl ? rel : join(repo, rel), commit, pushed: !opts.noPush }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
