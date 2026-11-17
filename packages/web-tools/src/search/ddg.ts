/**
 * DuckDuckGo html-выдача — без ключа, хрупко к вёрстке (спека §1).
 *
 * Запрос — POST-формой на `html.duckduckgo.com/html/`, а не GET `?q=`: на GET
 * без браузерных кук DDG отдаёт анти-бот капчу («bots use DuckDuckGo too»),
 * форма проходит (замер 13.09.2026). Капча распознаётся и уходит ошибкой
 * `blocked`, а не пустой выдачей — модель должна понять, что поиск не сработал,
 * а не что ничего не нашлось.
 *
 * Разбор: каждый `a.result__a` — заголовок и ссылка, ближайший за ним
 * `.result__snippet` до следующего результата — сниппет. Реклама
 * (`result--ad`, ссылки на `duckduckgo.com/y.js`) пропускается. Ссылки вида
 * `//duckduckgo.com/l/?uddg=<url>` разворачиваются в целевой url.
 */

import { type AsyncResult, ok, err } from '@kerneldreams/nrd'
import { asText } from '@kerneldreams/web'
import { statusError, webError } from '../errors.js'
import { inlineText, decodeEntities } from '../html.js'
import { USER_AGENT, request } from '../http.js'
import type { SearchHit, SearchProvider } from './types.js'

export const DDG_URL = 'https://html.duckduckgo.com/html/'

/** `lang` → регион DDG (`kl`): `ru` → `ru-ru`, `en` → `us-en`; `xx-yy` — как есть. */
export function ddgRegion(lang: string | undefined): string | undefined {
  if (!lang) return undefined
  const l = lang.trim().toLowerCase()
  if (l === '') return undefined
  if (l.includes('-')) return l
  if (l === 'en') return 'us-en'
  return `${l}-${l}`
}

/** href результата → целевой url; редирект-обёртка DDG разворачивается. */
export function unwrapDdgHref(href: string): string | undefined {
  const raw = decodeEntities(href)
  let url: URL
  try {
    url = new URL(raw, 'https://duckduckgo.com')
  } catch {
    return undefined
  }
  if (url.hostname.endsWith('duckduckgo.com')) {
    if (url.pathname === '/l/') return url.searchParams.get('uddg') ?? undefined
    return undefined // y.js (реклама) и прочие внутренние ссылки
  }
  return url.href
}

/** Страница — анти-бот заглушка, а не выдача. */
export function isDdgChallenge(html: string): boolean {
  return /bots use DuckDuckGo too|anomaly-modal|challenge-form/i.test(html)
}

export function parseDdgHtml(html: string): SearchHit[] {
  const hits: SearchHit[] = []
  const anchor = /<a\b([^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi
  const matches = [...html.matchAll(anchor)]

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!
    const start = m.index
    const end = matches[i + 1]?.index ?? html.length

    // Реклама размечена на обёртке результата — ищем ближайший открывающий
    // `div.result` перед заголовком.
    const before = html.slice(Math.max(0, start - 600), start)
    const wrapper = [...before.matchAll(/<div\b[^>]*\bclass="([^"]*\bresult\b[^"]*)"/gi)].pop()
    if (wrapper && /\bresult--ad\b/.test(wrapper[1]!)) continue

    const href = /\bhref="([^"]*)"/i.exec(m[1]!)?.[1]
    const url = href ? unwrapDdgHref(href) : undefined
    if (!url) continue

    const segment = html.slice(start, end)
    const snippetMatch = /<(?:a|div|td)\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i.exec(
      segment,
    )
    hits.push({
      title: inlineText(m[2]!),
      url,
      snippet: snippetMatch ? inlineText(snippetMatch[1]!) : '',
    })
  }
  return hits
}

export const ddg: SearchProvider = {
  name: 'ddg',
  unconfigured: () => undefined,

  async search(query, opts): AsyncResult<SearchHit[]> {
    const form = new URLSearchParams({ q: query, b: '' })
    const region = ddgRegion(opts.lang)
    if (region) form.set('kl', region)

    const res = await request(
      opts.http,
      {
        method: 'POST',
        url: DDG_URL,
        headers: {
          'user-agent': USER_AGENT,
          'content-type': 'application/x-www-form-urlencoded',
          referer: 'https://html.duckduckgo.com/',
        },
        body: form.toString(),
      },
      opts.signal,
    )
    if (!res.ok) return res
    if (res.value.status !== 200) return err(statusError('ddg', res.value.status))

    const html = asText(res.value)
    const hits = parseDdgHtml(html)
    if (hits.length === 0 && isDdgChallenge(html)) {
      return err(webError('blocked', 'ddg: вместо выдачи анти-бот капча — попробуйте позже или другой провайдер (NR_WEB_SEARCH)'))
    }
    return ok(hits.slice(0, opts.limit))
  },
}
