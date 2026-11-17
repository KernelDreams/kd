/**
 * Установка по ссылке на git (plugin-registry-spec §5): клон в слой пользователя (`<слой>/<id>`), строка в `$plugins`,
 * запись замка (ссылка, тег, закреплённый коммит, реестр). На машине ничего не собирается и `npm install` не
 * запускается: плагин со сборкой без `dist/index.js` в репе — отказ «плагин не собран». Обновление — явной командой на
 * новый тег; откат — прошлая запись замка; удаление — папка и записи.
 */

import { cpSync, existsSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { commitOf, git, isClean, localTags, remoteTags, splitRef } from './git.js'
import { latestTag } from './semver.js'
import { PLUGIN_ID, PluginError, dirManifest, readManifest, type PluginManifest } from './manifest.js'
import { ensureLayer, readLayer, readLock, writeLayer, writeLock, type LockEntry, type LockPoint } from './layer.js'

export interface InstallOpts {
  /** Реестр, из записи которого ставится (в замок). */
  registry?: string
  /** Перезаписать уже стоящий этот же id (переустановка). */
  force?: boolean
  /** Часы: default — сейчас (тесты). */
  now?: () => Date
}

export interface InstallResult {
  id: string
  manifest: PluginManifest
  dir: string
  entry: LockEntry
  /** Код-плагин подхватывается перезапуском стенда / приложения. */
  restart: boolean
}

const nowIso = (o: { now?: () => Date }): string => (o.now?.() ?? new Date()).toISOString()

/** Имя репы из ссылки: `…/nrp-gray.git` → `nrp-gray`. */
export function repoName(url: string): string {
  return basename(url.replace(/[#?].*$/, '').replace(/\/+$/, '')).replace(/\.git$/, '') || 'plugin'
}

function checkBuilt(m: PluginManifest, url: string): void {
  if (m.weight === 'code' && !m.built) throw new PluginError(`плагин не собран: в репе ${url} нет dist/index.js (сборку кладёт автор, на машине ничего не собирается)`, 'not_built')
}

function detach(dir: string, commit: string): void {
  git(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--force', '--detach', commit], dir)
}

/** Тег → коммит в клоне; нет тега — отказ словами. */
function tagCommit(dir: string, tag: string, url: string): string {
  try {
    return commitOf(dir, `refs/tags/${tag}`)
  } catch {
    throw new PluginError(`в ${url} нет тега ${tag}`, 'not_found')
  }
}

/**
 * Поставить плагин по ссылке `url[#тег]`. Тега нет — самый новый тег-версия репы; тегов нет совсем — закрепляется
 * HEAD ветки по умолчанию (тег в замке пустой).
 */
export function installFromGit(layer: string, ref: string, opts: InstallOpts = {}): InstallResult {
  const { url, tag: wanted } = splitRef(ref)
  if (!url) throw new PluginError('нет ссылки на git', 'bad_request')
  ensureLayer(layer)
  const tmp = mkdtempSync(join(layer, '.install-'))
  try {
    const clone = join(tmp, 'repo')
    git(['clone', '--quiet', url, clone])
    const tag = wanted || latestTag(localTags(clone)) || ''
    const commit = tag ? tagCommit(clone, tag, url) : commitOf(clone, 'HEAD')
    detach(clone, commit)
    const m = dirManifest(clone, repoName(url))
    if (!m) throw new PluginError(`${url}: не плагин — нет package.json с полем nrchat, meta.mdz / index.html или .mdz с ## $form`, 'not_plugin')
    if (!PLUGIN_ID.test(m.id)) throw new PluginError(`id «${m.id}» — только буквы, цифры, «-», «_», «.»`, 'bad_id')
    checkBuilt(m, url)
    const dir = join(layer, m.id)
    const lock = readLock(layer)
    const had = lock.plugins[m.id]
    if (existsSync(dir)) {
      if (!had) throw new PluginError(`папка ${dir} уже занята своим плагином (не из замка) — удалите или переименуйте её`, 'exists')
      if (!opts.force && had.url === url && had.commit === commit) return { id: m.id, manifest: m, dir, entry: had, restart: false }
      rmSync(dir, { recursive: true, force: true })
    }
    renameSync(clone, dir)
    const point: LockPoint = { tag, commit, at: nowIso(opts) }
    const history = had ? [...had.history, { tag: had.tag, commit: had.commit, at: had.at }] : []
    const entry: LockEntry = { url, weight: m.weight, ...(opts.registry ? { registry: opts.registry } : {}), ...point, history }
    lock.plugins[m.id] = entry
    writeLock(layer, lock)
    const l = readLayer(layer)
    if (!l.plugins.includes(m.id)) writeLayer(layer, { plugins: [...l.plugins, m.id] })
    return { id: m.id, manifest: dirManifest(dir, m.id) ?? m, dir, entry, restart: m.weight === 'code' }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function installed(layer: string, id: string): { dir: string; entry: LockEntry } {
  const entry = readLock(layer).plugins[id]
  if (!entry) throw new PluginError(`«${id}» не установлен по ссылке (нет в замке ${join(layer, 'plugins.lock.json')})`, 'not_found')
  const dir = join(layer, id)
  if (!existsSync(dir)) throw new PluginError(`нет папки ${dir} — переустановите: runz plugins install ${entry.url}`, 'not_found')
  return { dir, entry }
}

/** Новые теги в клоне (fetch) и самый новый. */
export function availableTags(layer: string, id: string): { tags: string[]; latest: string | null } {
  const { dir } = installed(layer, id)
  git(['fetch', '--quiet', '--tags', '--force', 'origin'], dir)
  const tags = localTags(dir)
  return { tags, latest: latestTag(tags) }
}

/** Самый новый тег удалённой репы без клона (для «есть обновление» в списке). */
export function latestRemoteTag(url: string): string | null {
  return latestTag(remoteTags(url))
}

function moveTo(layer: string, id: string, point: Omit<LockPoint, 'at'>, history: LockPoint[], opts: InstallOpts): InstallResult {
  const { dir, entry } = installed(layer, id)
  if (!isClean(dir)) throw new PluginError(`в ${dir} есть свои правки — сохраните их копией (правка = копия в папку пользователя) или удалите, потом обновляйте`, 'dirty')
  const prev = git(['rev-parse', 'HEAD'], dir)
  detach(dir, point.commit)
  const m = dirManifest(dir, id)
  try {
    if (!m) throw new PluginError(`${entry.url}@${point.tag || point.commit.slice(0, 8)}: больше не плагин`, 'not_plugin')
    checkBuilt(m, `${entry.url}@${point.tag}`)
  } catch (err) {
    detach(dir, prev)
    throw err
  }
  const lock = readLock(layer)
  const next: LockEntry = { ...entry, ...point, at: nowIso(opts), history }
  lock.plugins[id] = next
  writeLock(layer, lock)
  return { id, manifest: m!, dir, entry: next, restart: m!.weight === 'code' }
}

/** Обновить на тег (нет — самый новый). Тот же коммит — без изменений. */
export function updatePlugin(layer: string, id: string, tag?: string, opts: InstallOpts = {}): InstallResult {
  const { dir, entry } = installed(layer, id)
  git(['fetch', '--quiet', '--tags', '--force', 'origin'], dir)
  const target = tag || latestTag(localTags(dir))
  if (!target) throw new PluginError(`у ${entry.url} нет тегов-версий — обновлять не на что`, 'not_found')
  const commit = tagCommit(dir, target, entry.url)
  if (commit === entry.commit) return { id, manifest: dirManifest(dir, id)!, dir, entry, restart: false }
  return moveTo(layer, id, { tag: target, commit }, [...entry.history, { tag: entry.tag, commit: entry.commit, at: entry.at }], opts)
}

/** Откат на прошлую запись замка; её снимает из истории. */
export function rollbackPlugin(layer: string, id: string, opts: InstallOpts = {}): InstallResult {
  const { entry } = installed(layer, id)
  const prev = entry.history[entry.history.length - 1]
  if (!prev) throw new PluginError(`у «${id}» нет прошлой записи в замке — откатывать некуда`, 'no_history')
  return moveTo(layer, id, { tag: prev.tag, commit: prev.commit }, entry.history.slice(0, -1), opts)
}

/** Удалить установленный по ссылке: папка, замок, `$plugins`. Свой (не из замка) — удаляется только `own: true`. */
export function removePlugin(layer: string, id: string, opts: { own?: boolean } = {}): { removed: string } {
  const lock = readLock(layer)
  const dir = join(layer, id)
  if (!lock.plugins[id] && !opts.own) throw new PluginError(`«${id}» не установлен по ссылке`, 'not_found')
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  if (opts.own && existsSync(dir + '.mdz')) rmSync(dir + '.mdz', { force: true })
  delete lock.plugins[id]
  writeLock(layer, lock)
  const l = readLayer(layer)
  const choose = { ...l.choose }
  delete choose[id]
  writeLayer(layer, { plugins: l.plugins.filter((p) => p !== id), choose })
  return { removed: dir }
}

/**
 * Правка плагина из реестра или комплекта = копия в папку пользователя (§6): файл → `<слой>/<имя>.mdz`, папка →
 * `<слой>/<id>/`. Обновление реестра её не трогает; одноимённая копия перекрывает источник. Уже есть — не затирается.
 */
export function copyToUser(layer: string, source: string, id?: string): { path: string; existed: boolean } {
  ensureLayer(layer)
  const st = statSync(source)
  const name = st.isDirectory() ? (id ?? basename(source)) : basename(source)
  const dst = join(layer, name)
  if (existsSync(dst)) return { path: dst, existed: true }
  if (realpathSync(source).startsWith(realpathSync(layer) + '/') && !source.includes('/.registries/')) return { path: source, existed: true }
  cpSync(source, dst, { recursive: true, filter: (p) => !/[\\/]\.git([\\/]|$)/.test(p) })
  return { path: dst, existed: false }
}

/** Манифест уже установленного (для списка). */
export function installedManifest(layer: string, id: string): PluginManifest | null {
  return readManifest(join(layer, id), id)
}
