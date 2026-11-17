/**
 * Слои `kd` (kd-cli-spec §3, §10): комплект → студийный профиль (`$layers` из `~/.kd/settings.mdz`)
 * → общий слой `~/.kd` (тулы пользователя, регистрации сборок `apps/*.mdz`) → данные своей сборки →
 * проект `.kd/`. Проект тулы добавляет, но не перекрывает (совпало имя — громкая ошибка).
 */

import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { copyInfo, expandHome, KIT_ROOT, projectDir, readAttrs, strList, type CopyInfo } from './home.js'

/** Версия формата документов общего слоя, которую понимает эта копия. */
export const SHARED_FORMAT = 1

export type LayerId = 'kit' | 'studio' | 'shared' | 'app' | 'data' | 'project'

export interface Layer {
  id: LayerId
  /** Имя для сообщений (`app:pix`). */
  label: string
  toolDirs: string[]
  linkFiles: string[]
  /** Конфиги runz студийного профиля (`~/.runz/config.md`). */
  configFiles: string[]
}

export interface Layers {
  copy: CopyInfo
  layers: Layer[]
  /** Настройки, сведённые по слоям (сильный поверх). */
  settings: Record<string, unknown>
  /** Папка пользовательского слоя runz для прогона (`RUNZ_GLOBAL_DIR`). */
  runzDir: string
  /** Проект, если есть. */
  project: string | null
  /** Что не так со слоями (регистрация битая, сборки нет, формат новее). */
  warnings: string[]
  /**
   * Файлы настроек, из которых собраны слои и `settings` (`settings.mdz` общего слоя, сборки, проекта,
   * файлы `$layers`, регистрации `apps/*.mdz`): от их времени правки и размера зависит кэш каталога.
   */
  settingsFiles: string[]
}

const rel = (base: string, p: string): string => {
  const e = expandHome(p)
  return isAbsolute(e) ? e : resolve(base, e)
}

function studioLayer(paths: string[], base: string, warnings: string[]): { layer: Layer; runzDir?: string } {
  const layer: Layer = { id: 'studio', label: 'studio', toolDirs: [], linkFiles: [], configFiles: [] }
  let runzDir: string | undefined
  for (const raw of paths) {
    const p = rel(base, raw)
    if (!existsSync(p)) {
      warnings.push(`$layers: ${p} — нет такого пути, слой пропущен`)
      continue
    }
    if (!/\.(md|mdz)$/i.test(p)) {
      layer.toolDirs.push(p)
      continue
    }
    layer.configFiles.push(p)
    if (basename(p) === 'config.md' && !runzDir) runzDir = dirname(p)
    const attrs = readAttrs(p) ?? {}
    for (const d of strList(attrs.paths)) layer.toolDirs.push(rel(dirname(p), d))
    for (const f of strList(attrs.links)) layer.linkFiles.push(rel(dirname(p), f))
  }
  return { layer, ...(runzDir ? { runzDir } : {}) }
}

/** Регистрации сборок `~/.kd/apps/<id>.mdz`: битая или без сборки — пропуск с сообщением. */
function appLayers(home: string, warnings: string[]): { layers: Layer[]; files: string[] } {
  const dir = join(home, 'apps')
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.mdz')).sort()
  } catch {
    return { layers: [], files: [] }
  }
  const out: Layer[] = []
  const files: string[] = []
  for (const n of names) {
    const file = join(dir, n)
    files.push(file)
    try {
      const a = readAttrs(file) ?? {}
      const fmt = Number(a.format ?? 1)
      if (fmt > SHARED_FORMAT) warnings.push(`${file}: формат ${fmt}, эта копия понимает ${SHARED_FORMAT} — читаю, что понимаю`)
      const root = typeof a.path === 'string' ? rel(dir, a.path) : ''
      if (!root || !existsSync(root)) {
        warnings.push(`${file}: сборки по пути «${root || '—'}» нет — регистрация пропущена`)
        continue
      }
      out.push({ id: 'app', label: `app:${n.replace(/\.mdz$/, '')}`, toolDirs: strList(a.tools).map((d) => rel(root, d)), linkFiles: strList(a.links).map((f) => rel(root, f)), configFiles: [] })
    } catch (err) {
      warnings.push(`${file}: не читается — ${(err as Error).message}; регистрация пропущена`)
    }
  }
  return { layers: out, files }
}

/** Собрать слои для папки `cwd`. */
export function loadLayers(cwd: string, env: NodeJS.ProcessEnv = process.env): Layers {
  const copy = copyInfo(env)
  const warnings: string[] = []
  const layers: Layer[] = [{ id: 'kit', label: 'kit', toolDirs: [join(KIT_ROOT, 'dist', 'tools'), join(KIT_ROOT, 'tools')], linkFiles: [join(KIT_ROOT, 'links.mdz')], configFiles: [] }]
  let settings: Record<string, unknown> = {}
  let runzDir = join(copy.dataDir, 'runz')
  const settingsFiles: string[] = []
  if (copy.readsShared) {
    settingsFiles.push(join(copy.sharedHome, 'settings.mdz'), join(copy.sharedHome, 'apps'))
    const shared = readAttrs(join(copy.sharedHome, 'settings.mdz')) ?? {}
    const fmt = Number(shared.format ?? 1)
    if (fmt > SHARED_FORMAT) warnings.push(`${join(copy.sharedHome, 'settings.mdz')}: формат ${fmt}, эта копия понимает ${SHARED_FORMAT}`)
    const st = studioLayer(strList(shared.layers), copy.sharedHome, warnings)
    if (st.layer.toolDirs.length || st.layer.configFiles.length || st.layer.linkFiles.length) layers.push(st.layer)
    if (st.runzDir) runzDir = st.runzDir
    settingsFiles.push(...st.layer.configFiles)
    settings = { ...settings, ...shared }
    layers.push({ id: 'shared', label: 'shared', toolDirs: [join(copy.sharedHome, 'tools')], linkFiles: [join(copy.sharedHome, 'links.mdz')], configFiles: [] })
    const apps = appLayers(copy.sharedHome, warnings)
    layers.push(...apps.layers)
    settingsFiles.push(...apps.files)
  }
  if (copy.mode !== 'system') {
    layers.push({ id: 'data', label: 'data', toolDirs: [join(copy.dataDir, 'tools')], linkFiles: [join(copy.dataDir, 'links.mdz')], configFiles: [] })
    settings = { ...settings, ...(readAttrs(join(copy.dataDir, 'settings.mdz')) ?? {}) }
    settingsFiles.push(join(copy.dataDir, 'settings.mdz'))
  }
  const project = projectDir(cwd)
  if (project) {
    layers.push({ id: 'project', label: 'project', toolDirs: [join(project, 'tools')], linkFiles: [join(project, 'links.mdz')], configFiles: [] })
    // Проект добавляет настройки, но не меняет слои и пути: `$layers` проекта не читается.
    settingsFiles.push(join(project, 'settings.mdz'))
    const { layers: _l, ...own } = readAttrs(join(project, 'settings.mdz')) ?? {}
    settings = { ...settings, ...own }
  }
  return { copy, layers, settings, runzDir, project, warnings, settingsFiles }
}
