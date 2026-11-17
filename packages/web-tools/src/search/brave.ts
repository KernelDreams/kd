/**
 * Brave Search API (спека §1): ключ `BRAVE_API_KEY`, включается, только если
 * ключ есть и провайдер выбран в `NR_WEB_SEARCH`.
 *
 * Ответ: `web.results[] { title, url, description }`; в `description` Brave
 * кладёт `<strong>` вокруг совпадений — срезаются.
 */

import { type AsyncResult, ok, err } from '@kerneldreams/nrd'
import { asJson } from '@kerneldreams/web'
import { statusError, webError } from '../errors.js'
import { inlineText } from '../html.js'
import { request } from '../http.js'
import type { SearchHit, SearchProvider } from './types.js'

export const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search'

interface BraveResponse {
  web?: { results?: Array<{ title?: unknown; url?: unknown; description?: unknown }> }
}

export function parseBrave(json: unknown): SearchHit[] {
  const results = (json as BraveResponse | null)?.web?.results
  if (!Array.isArray(results)) return []
  return results.flatMap((r) =>
    typeof r.url === 'string' && typeof r.title === 'string'
      ? [{ title: inlineText(r.title), url: r.url, snippet: typeof r.description === 'string' ? inlineText(r.description) : '' }]
      : [],
  )
}

export const brave: SearchProvider = {
  name: 'brave',
  unconfigured: (env) => (env.BRAVE_API_KEY ? undefined : 'не задан BRAVE_API_KEY'),

  async search(query, opts): AsyncResult<SearchHit[]> {
    const url = new URL(BRAVE_URL)
    url.searchParams.set('q', query)
    url.searchParams.set('count', String(opts.limit))
    if (opts.lang) url.searchParams.set('search_lang', opts.lang)

    const res = await request(
      opts.http,
      {
        method: 'GET',
        url: url.href,
        headers: { accept: 'application/json', 'x-subscription-token': opts.env.BRAVE_API_KEY ?? '' },
      },
      opts.signal,
    )
    if (!res.ok) return res
    if (res.value.status !== 200) return err(statusError('brave', res.value.status))

    const json = asJson(res.value)
    if (!json.ok) return err(webError('parse', `brave: ответ не JSON — ${json.error.message}`))
    return ok(parseBrave(json.value).slice(0, opts.limit))
  },
}
