// Site-роутинг (spec §7). Portable: чистое сопоставление arg → шаблон + params.
//
// Загрузку локальных site-плагинов с диска и проверку «arg — это файл?» делает
// Node-слой (`@kerneldreams/nrd/node`); сюда плагины приходят уже массивом. Site
// plugin отвечает за маршрутизацию (URL → какой шаблон), а не за данные —
// данными занимается source-плагин в nrd-context. Разные слои.

import type { Value } from '../core/index.js'

/** Результат разбора URL/shorthand сайтом. */
export interface ParsedUrl {
  resource: string
  path: string
  account?: string
}

/** Контракт site-плагина (sites/<name>.ts). Все поля опциональны, кроме смысла. */
export interface SitePlugin {
  name?: string
  hostname?: string | string[]
  parseUrl?(arg: string): ParsedUrl | null
  matchShorthand?(arg: string): boolean
  defaultTemplates?: Record<string, string>
  accounts?: Record<string, string>
  defaultAccount?: string
  /**
   * Каталог шаблонов сайта (абсолютный путь, Node-слой). `findTemplate`/`nodeLoader` ищут в нём после
   * `.ntpl/templates/` — так сайт-плагин, зарегистрированный снаружи, приносит свои шаблоны.
   */
  templatesDir?: string
}

/** Результат роутинга: какой шаблон взять и какие params положить в контекст. */
export interface RouteResult {
  /** Логическое имя шаблона (например `example/page`). Резолвит findTemplate. */
  template: string
  /** Параметры из URL/shorthand — доступны как `${resource}`, `${path}` в NRD-блоке. */
  params: Record<string, Value>
  /** Имя сматчившего сайта (для логов). */
  site?: string
}

function hostnameList(site: SitePlugin): string[] {
  const h = site.hostname
  if (!h) return []
  return Array.isArray(h) ? h : [h]
}

function stripWww(h: string): string {
  return h.replace(/^www\./, '')
}

/**
 * Сопоставить позиционный аргумент с site-плагином → шаблон + params.
 *
 * Режимы:
 *  - URL (`http(s)://…`) — матч по hostname; нет плагина → ошибка.
 *  - shorthand — первый `matchShorthand(arg)`.
 *  - иначе → `null` (значит: трактовать arg как прямое имя шаблона).
 *
 * Файловый режим (arg — путь к существующему .ntpl) сюда не входит: это fs-логика
 * Node-слоя, который проверяет файл до вызова resolveRoute.
 */
export function resolveRoute(arg: string, sites: SitePlugin[] = []): RouteResult | null {
  // URL mode
  if (/^https?:\/\//i.test(arg)) {
    let host: string
    try {
      host = stripWww(new URL(arg).hostname)
    } catch {
      throw new Error(`ntpl: не удалось разобрать URL "${arg}"`)
    }
    const match = sites.find((s) => hostnameList(s).some((h) => stripWww(h) === host))
    if (!match) throw new Error(`ntpl: нет site-плагина для hostname "${host}"`)
    if (!match.parseUrl) throw new Error(`ntpl: site-плагин "${siteName(match)}" без parseUrl`)
    const parsed = match.parseUrl(arg)
    if (!parsed) throw new Error(`ntpl: site-плагин "${siteName(match)}" не разобрал URL ${arg}`)
    return finishSiteRoute(match, parsed)
  }

  // shorthand mode
  for (const site of sites) {
    if (typeof site.matchShorthand !== 'function' || !site.matchShorthand(arg)) continue
    let parsed: ParsedUrl | null = null
    if (site.parseUrl) {
      try {
        parsed = site.parseUrl(arg)
      } catch {
        parsed = null
      }
    }
    if (!parsed) {
      const slash = arg.indexOf('/')
      if (slash < 0) continue
      parsed = { resource: arg.slice(0, slash), path: arg.slice(slash + 1) }
    }
    return finishSiteRoute(site, parsed)
  }

  // не URL и не shorthand → прямое имя шаблона (решает caller)
  return null
}

function siteName(site: SitePlugin): string {
  return site.name ?? hostnameList(site)[0] ?? 'site'
}

function finishSiteRoute(site: SitePlugin, parsed: ParsedUrl): RouteResult {
  const template = site.defaultTemplates?.[parsed.resource]
  if (!template) {
    throw new Error(
      `ntpl: site "${siteName(site)}" не знает шаблон по умолчанию для ресурса "${parsed.resource}"`,
    )
  }

  const params: Record<string, Value> = {
    resource: parsed.resource,
    path: parsed.path,
  }

  const accountKey = parsed.account ?? site.defaultAccount
  if (accountKey) {
    params.profile = site.accounts?.[accountKey] ?? accountKey
    params.account = accountKey
  }

  return { template, params, site: siteName(site) }
}
