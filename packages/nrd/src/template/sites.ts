// Реестр site-плагинов ntpl. Ядро своих сайтов не держит: конкретные площадки регистрируются снаружи
// (`registerSite(plugin)` в точке входа приложения), локальные — файлами `.ntpl/sites/` (Node-слой).
// Реестр живёт на globalThis под Symbol.for — один на процесс, даже если пакет попал в бандл дважды.

import type { SitePlugin } from './route.js'

const KEY = Symbol.for('kerneldreams.nrd.template.sites')

function registry(): SitePlugin[] {
  const g = globalThis as unknown as Record<symbol, SitePlugin[] | undefined>
  return (g[KEY] ??= [])
}

/** Зарегистрировать site-плагин. Повтор с тем же `name` заменяет прежний. Возвращает отмену. */
export function registerSite(site: SitePlugin): () => void {
  const list = registry()
  const i = site.name ? list.findIndex((s) => s.name === site.name) : -1
  if (i >= 0) list[i] = site
  else list.push(site)
  return () => {
    const j = list.indexOf(site)
    if (j >= 0) list.splice(j, 1)
  }
}

/** Зарегистрированные site-плагины в порядке регистрации (порядок = приоритет матчинга). */
export function registeredSites(): SitePlugin[] {
  return [...registry()]
}
