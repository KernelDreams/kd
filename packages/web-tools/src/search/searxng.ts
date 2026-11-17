/**
 * SearXNG (спека §1): свой инстанс по `SEARXNG_URL`, `/search?format=json`.
 * Ключа нет; инстанс обязан разрешать JSON-формат (`search.formats` в его
 * settings.yml), иначе ответит 403.
 *
 * Адрес — конфигурация владельца машины, не ввод модели, поэтому SSRF-стоп
 * web_fetch сюда не применяется: инстанс вполне может жить в локальной сети.
 */

import { type AsyncResult, ok, err } from '@kerneldreams/nrd'
import { asJson } from '@kerneldreams/web'
import { statusError, webError } from '../errors.js'
import { inlineText } from '../html.js'
import { request } from '../http.js'
import type { SearchHit, SearchProvider } from './types.js'

interface SearxngResponse {
  results?: Array<{ title?: unknown; url?: unknown; content?: unknown }>
}

export function parseSearxng(json: unknown): SearchHit[] {
  const results = (json as SearxngResponse | null)?.results
  if (!Array.isArray(results)) return []
  return results.flatMap((r) =>
    typeof r.url === 'string' && typeof r.title === 'string'
      ? [{ title: inlineText(r.title), url: r.url, snippet: typeof r.content === 'string' ? inlineText(r.content) : '' }]
      : [],
  )
}

export const searxng: SearchProvider = {
  name: 'searxng',
  unconfigured: (env) => (env.SEARXNG_URL ? undefined : 'не задан SEARXNG_URL'),

  async search(query, opts): AsyncResult<SearchHit[]> {
    let url: URL
    try {
      url = new URL('search', (opts.env.SEARXNG_URL ?? '').replace(/\/*$/, '/'))
    } catch {
      return err(webError('config', `searxng: некорректный SEARXNG_URL "${opts.env.SEARXNG_URL}"`))
    }
    url.searchParams.set('q', query)
    url.searchParams.set('format', 'json')
    if (opts.lang) url.searchParams.set('language', opts.lang)

    const res = await request(opts.http, { method: 'GET', url: url.href, headers: { accept: 'application/json' } }, opts.signal)
    if (!res.ok) return res
    if (res.value.status === 403) return err(webError('config', 'searxng: HTTP 403 — у инстанса выключен JSON-формат (search.formats в settings.yml)', 403))
    if (res.value.status !== 200) return err(statusError('searxng', res.value.status))

    const json = asJson(res.value)
    if (!json.ok) return err(webError('parse', `searxng: ответ не JSON — ${json.error.message}`))
    return ok(parseSearxng(json.value).slice(0, opts.limit))
  },
}
