/**
 * Каскад источников плагинов (plugin-registry-spec §5–6): подключённые реестры (порядок списка; у Pix первый — снимок
 * открытого реестра комплекта) → папка пользователя (клоны по ссылке и свои файлы / папки). Папка пользователя
 * перекрывает реестры по id молча — это правка-копия или явная установка. Одинаковый id из двух реестров молча не
 * выбирается: без выбора в `$choose` плагин не работает, в списке — происхождение обоих и «выбрать».
 *
 * Итог — каталог для списка (тип объекта «плагин» в collection) и наборы того, что работает: файлы форм (вес 1),
 * коллекции артефактов со скрытыми папками (вес 2), папки код-плагинов (вес 3).
 */

import { readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { dirManifest, fileManifest, type PluginManifest, type PluginWeight } from './manifest.js'
import { LAYER_FILE, readLayer, readLock, writeLayer, type LockEntry } from './layer.js'
import { connectedRegistries, type RegistryEntry } from './registry.js'

export interface CatalogSource {
  /** `registry:<id>` — плагин лежит в реестре; `git` — клон по ссылке; `user` — свой файл / папка. */
  source: string
  /** Словами: «реестр NR Plugins», «папка пользователя», «git …@v1.2». */
  origin: string
  path: string
  manifest: PluginManifest
}

export interface CatalogItem {
  id: string
  title: string
  description?: string
  weight: PluginWeight
  api?: string
  places?: string[]
  handles?: string[]
  icon?: string
  version?: string
  /** Работает ли сейчас (поставлен и выбран). Запись реестра без установки — нет. */
  active: boolean
  /** Действующий источник; нет — плагин не работает (конфликт без выбора или только запись реестра). */
  source?: string
  origin?: string
  path?: string
  /** Установлен по ссылке — запись замка. */
  installed?: LockEntry
  /** Своя копия в папке пользователя поверх плагина реестра (`shadows` — чей). */
  edited?: boolean
  shadows?: string
  /** Запись реестра (`entries/`): откуда ставить и последний тег. */
  entry?: RegistryEntry & { registry: string; registryTitle: string }
  /** Одинаковый id из двух и больше реестров (§6): кандидаты, выбор — `chosen`. */
  candidates?: Array<Pick<CatalogSource, 'source' | 'origin' | 'path'>>
  chosen?: string
  /** Код-плагин без сборки и т.п. — словами. */
  error?: string
}

export interface ResolvedPlugins {
  items: CatalogItem[]
  /** `.mdz` плагинов-файлов, которые работают (порядок каскада). */
  forms: string[]
  /** Коллекции артефактов: папки `plugins/` реестров и сам слой; `hidden` — папки, перекрытые или без выбора. */
  artifacts: { collections: string[]; hidden: string[] }
  /** Папки код-плагинов (вес 3), которые работают. */
  code: string[]
  registries: Array<{ id: string; title: string; description?: string; url?: string; dir: string; fetchedAt?: string; commit?: string; error?: string; snapshot?: boolean; entries: number; plugins: number }>
}

const names = (dir: string): string[] => {
  try {
    return readdirSync(dir).sort()
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

/** Свои плагины слоя: клоны по замку, `.mdz` с формой в корне, папки с манифестом. */
function userSources(layer: string, lock: Record<string, LockEntry>): CatalogSource[] {
  const out: CatalogSource[] = []
  for (const n of names(layer)) {
    if (n.startsWith('.') || n.startsWith('_') || n === LAYER_FILE) continue
    const path = join(layer, n)
    if (isDir(path)) {
      const m = dirManifest(path)
      if (!m) continue
      const l = lock[n]
      out.push(l ? { source: 'git', origin: `git ${l.url}${l.tag ? `@${l.tag}` : ` @${l.commit.slice(0, 8)}`}`, path, manifest: { ...m, id: n } } : { source: 'user', origin: 'папка пользователя', path, manifest: m })
    } else if (extname(n).toLowerCase() === '.mdz') {
      const m = fileManifest(path)
      if (m) out.push({ source: 'user', origin: 'папка пользователя', path, manifest: m })
    }
  }
  return out
}

function itemOf(src: CatalogSource): Omit<CatalogItem, 'active'> {
  const m = src.manifest
  return {
    id: m.id,
    title: m.title ?? m.id,
    weight: m.weight,
    ...(m.description ? { description: m.description } : {}),
    ...(m.api ? { api: m.api } : {}),
    ...(m.places ? { places: m.places } : {}),
    ...(m.handles ? { handles: m.handles } : {}),
    ...(m.icon ? { icon: m.icon } : {}),
    ...(m.version ? { version: m.version } : {}),
    source: src.source,
    origin: src.origin,
    path: src.path,
    ...(m.weight === 'code' && !m.built ? { error: 'плагин не собран: нет dist/index.js' } : {}),
  }
}

export function resolvePlugins(layer: string): ResolvedPlugins {
  const lock = readLock(layer).plugins
  const { choose } = readLayer(layer)
  const regs = connectedRegistries(layer)
  const regSources = new Map<string, CatalogSource[]>()
  const entries = new Map<string, Array<RegistryEntry & { registry: string; registryTitle: string }>>()
  for (const r of regs) {
    for (const p of r.plugins) {
      const list = regSources.get(p.manifest.id) ?? []
      list.push({ source: `registry:${r.info.id}`, origin: `реестр ${r.info.title}`, path: p.path, manifest: p.manifest })
      regSources.set(p.manifest.id, list)
    }
    for (const e of r.entries) {
      const list = entries.get(e.id) ?? []
      list.push({ ...e, registry: r.info.id, registryTitle: r.info.title })
      entries.set(e.id, list)
    }
  }
  const user = new Map(userSources(layer, lock).map((s) => [s.manifest.id, s]))
  const ids = [...new Set([...regSources.keys(), ...entries.keys(), ...user.keys()])]

  const items: CatalogItem[] = []
  const forms: string[] = []
  const code: string[] = []
  const hidden: string[] = []
  const hideArtifacts = (list: readonly CatalogSource[], except?: CatalogSource): void => {
    for (const s of list) if (s !== except && s.manifest.weight === 'artifact') hidden.push(s.path)
  }
  const activate = (s: CatalogSource): void => {
    if (s.manifest.weight === 'file') forms.push(...(s.manifest.files ?? [s.path]))
    if (s.manifest.weight === 'code' && s.manifest.built) code.push(s.path)
  }

  for (const id of ids) {
    const regs = regSources.get(id) ?? []
    const ent = entries.get(id)
    const own = user.get(id)
    const entry = ent?.find((e) => own?.source === 'git' && lock[id]?.registry === e.registry) ?? ent?.[0]
    const candidates = regs.length > 1 ? regs.map(({ source, origin, path }) => ({ source, origin, path })) : undefined
    if (own) {
      activate(own)
      hideArtifacts(regs)
      const shadowed = regs.find((s) => s.source === choose[id]) ?? regs[0]
      items.push({
        ...itemOf(own),
        active: true,
        ...(own.source === 'git' ? { installed: lock[id]! } : {}),
        ...(own.source === 'user' && shadowed ? { edited: true, shadows: shadowed.source } : {}),
        ...(entry ? { entry } : {}),
      })
      continue
    }
    if (regs.length === 1) {
      activate(regs[0]!)
      items.push({ ...itemOf(regs[0]!), active: true, ...(entry ? { entry } : {}) })
      continue
    }
    if (regs.length > 1) {
      const pick = regs.find((s) => s.source === choose[id])
      if (pick) activate(pick)
      hideArtifacts(regs, pick)
      const { source: _s, origin: _o, path: _p, ...base } = itemOf(pick ?? regs[0]!)
      items.push({ ...base, ...(pick ? { source: pick.source, origin: pick.origin, path: pick.path, chosen: pick.source } : {}), active: !!pick, candidates: candidates!, ...(entry ? { entry } : {}) })
      continue
    }
    if (entry) {
      items.push({
        id,
        title: entry.title ?? id,
        weight: entry.weight ?? 'file',
        ...(entry.description ? { description: entry.description } : {}),
        ...(entry.api ? { api: entry.api } : {}),
        ...(entry.places ? { places: entry.places } : {}),
        ...(entry.handles ? { handles: entry.handles } : {}),
        ...(entry.icon ? { icon: entry.icon } : {}),
        active: false,
        entry,
        ...(ent!.length > 1 && new Set(ent!.map((e) => e.url)).size > 1
          ? { candidates: ent!.map((e) => ({ source: `entry:${e.registry}`, origin: `реестр ${e.registryTitle}: ${e.url}`, path: e.file })) }
          : {}),
      })
    }
  }

  return {
    items,
    forms,
    artifacts: { collections: [...regs.map((r) => join(r.info.dir, 'plugins')).filter(isDir), layer], hidden },
    code,
    registries: regs.map((r) => ({
      id: r.info.id,
      title: r.info.title,
      ...(r.info.description ? { description: r.info.description } : {}),
      ...(r.ref.url ? { url: r.ref.url } : {}),
      dir: r.info.dir,
      ...(r.state.fetchedAt ? { fetchedAt: r.state.fetchedAt } : {}),
      ...(r.state.commit ? { commit: r.state.commit } : {}),
      ...(r.state.error ? { error: r.state.error } : {}),
      ...(r.state.snapshot ? { snapshot: true } : {}),
      entries: r.entries.length,
      plugins: r.plugins.length,
    })),
  }
}

/** Запомнить выбор источника одинакового id (`registry:<id>`); пусто — забыть. */
export function choosePlugin(layer: string, id: string, source: string | null): void {
  const choose = { ...readLayer(layer).choose }
  if (source) choose[id] = source
  else delete choose[id]
  writeLayer(layer, { choose })
}
