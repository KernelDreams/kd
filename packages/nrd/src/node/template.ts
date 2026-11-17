// nrd/node — ntpl-слой: загрузка шаблонов с диска (бывший @kerneldreams/nrd/node).
//
// Ступень `nrd/node` (тянет node:fs). Браузерный бандл его не импортит — ядро
// (extract/engine/helpers/route) остаётся на ступени `nrd/template`. Реш. B/C/D.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type nunjucks from 'nunjucks'
import type { SitePlugin } from '../template/route.js'
import { registeredSites } from '../template/sites.js'

// Готовый Node-комплект capabilities (fs/exec/http) — re-export для одной строки
// в CLI/forge: `buildContext(nrdBlock, { ...nodeCapabilities(), params })`.
export { nodeCapabilities } from './capabilities.js'

const STOP_MARKERS = ['.git', '.obsidian', '.server']
const MAX_DEPTH = 20
const TEMPLATE_EXTS = ['', '.ntpl', '.md']
const PLUGIN_EXTS = ['.ts', '.js', '.mjs', '.cjs']


/** Директории от startDir вверх до stop-маркера (.git/.obsidian/.server) или корня. */
export function upwardDirs(startDir: string): string[] {
  const dirs: string[] = []
  let current = path.resolve(startDir)
  for (let i = 0; i < MAX_DEPTH; i++) {
    dirs.push(current)
    if (STOP_MARKERS.some((m) => fs.existsSync(path.join(current, m)))) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return dirs
}

/**
 * Директории поиска шаблонов: `.ntpl/templates/` вверх от startDir + каталоги зарегистрированных
 * site-плагинов (`templatesDir`, см. `registerSite`). First-wins — локальный перекрывает сайтовый (spec §6).
 */
export function searchDirs(startDir: string = process.cwd()): string[] {
  const dirs = upwardDirs(startDir).map((d) => path.join(d, '.ntpl', 'templates'))
  for (const s of registeredSites()) if (s.templatesDir && !dirs.includes(s.templatesDir)) dirs.push(s.templatesDir)
  return dirs
}

/**
 * Найти файл шаблона по логическому имени (`example/page`) или пути.
 *
 * Порядок: существующий файл-путь напрямую → поиск по dirs с расширениями
 * `''`/`.ntpl`/`.md`. First-hit wins. Бросает, если не найден.
 */
export function findTemplate(name: string, dirs: string[] = searchDirs()): string {
  // прямой путь к файлу
  if (fs.existsSync(name) && fs.statSync(name).isFile()) return path.resolve(name)

  for (const dir of dirs) {
    for (const ext of TEMPLATE_EXTS) {
      const p = path.join(dir, name + ext)
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
    }
  }
  throw new Error(`ntpl: шаблон не найден: "${name}" (искал в ${dirs.length} директориях)`)
}

/**
 * Nunjucks-loader для `<{ include }>`/`<{ extends }>` — FileSystemLoader поверх
 * `.ntpl/templates/` upward + встроенных. Инъектируется в `createEnv({ loader })`.
 */
export async function nodeLoader(dirs: string[] = searchDirs()): Promise<nunjucks.FileSystemLoader> {
  // nunjucks — optional peer (§2.4): грузим лениво, ошибка — по вызову.
  const nj = ((await import('nunjucks')) as unknown as { default?: typeof nunjucks })
  const mod = (nj.default ?? (nj as unknown as typeof nunjucks))
  return new mod.FileSystemLoader(dirs, { noCache: true })
}

/** Локальные site-плагины из `.ntpl/sites/` (по одному файлу на сайт). */
function localSiteFiles(startDir: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const d of upwardDirs(startDir)) {
    const sitesDir = path.join(d, '.ntpl', 'sites')
    if (!fs.existsSync(sitesDir)) continue
    for (const entry of fs.readdirSync(sitesDir)) {
      const ext = path.extname(entry)
      if (!PLUGIN_EXTS.includes(ext)) continue
      const base = entry.slice(0, -ext.length)
      if (seen.has(base)) continue // first-wins (ближе к startDir)
      seen.add(base)
      out.push(path.join(sitesDir, entry))
    }
  }
  return out
}

function toSitePlugin(mod: Record<string, unknown>, fallbackName: string): SitePlugin {
  const candidate = (mod.default ?? mod) as Record<string, unknown>
  return {
    name: (candidate.name as string) ?? fallbackName,
    hostname: candidate.hostname as SitePlugin['hostname'],
    parseUrl: candidate.parseUrl as SitePlugin['parseUrl'],
    matchShorthand: candidate.matchShorthand as SitePlugin['matchShorthand'],
    defaultTemplates: candidate.defaultTemplates as SitePlugin['defaultTemplates'],
    accounts: candidate.accounts as SitePlugin['accounts'],
    defaultAccount: candidate.defaultAccount as SitePlugin['defaultAccount'],
    templatesDir: candidate.templatesDir as SitePlugin['templatesDir'],
  }
}

/**
 * Собрать site-плагины: локальные (`.ntpl/sites/`, ближе к startDir — раньше) +
 * зарегистрированные `registerSite`. Порядок = приоритет матчинга в resolveRoute (first-wins).
 */
export async function discoverSites(startDir: string = process.cwd()): Promise<SitePlugin[]> {
  const sites: SitePlugin[] = []
  for (const file of localSiteFiles(startDir)) {
    try {
      const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>
      sites.push(toSitePlugin(mod, path.basename(file).replace(/\.[^.]+$/, '')))
    } catch {
      // битый плагин пропускаем
    }
  }
  sites.push(...registeredSites())
  return sites
}
