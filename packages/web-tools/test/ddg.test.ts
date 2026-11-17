/**
 * Парсер DDG на сохранённой выдаче (спека §3). Фикстура — настоящий ответ
 * html.duckduckgo.com на запрос «typescript result type» (13.09.2026): первый
 * результат в ней — реклама, её в выдаче быть не должно.
 */

import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { ddg, ddgRegion, isDdgChallenge, parseDdgHtml, unwrapDdgHref, DDG_URL } from '../src/search/ddg.js'
import type { Http } from '../src/http.js'
import type { WebError } from '../src/errors.js'

const html = readFileSync(new URL('./fixtures/ddg-results.html', import.meta.url), 'utf-8')

describe('parseDdgHtml', () => {
  const hits = parseDdgHtml(html)

  it('органическая выдача без рекламы', () => {
    expect(hits.length).toBe(10)
    expect(hits.every((h) => !h.url.includes('duckduckgo.com'))).toBe(true)
    expect(hits.map((h) => h.title)).not.toContain('JavaScript and TypeScript IDE - WebStorm, a JetBrains IDE')
  })

  it('заголовок, url и сниппет первого результата', () => {
    expect(hits[0]).toEqual({
      title: 'TypeScript Result',
      url: 'https://www.typescript-result.dev/',
      snippet:
        'Supercharge your TypeScript error handling with a powerful Result type that transforms chaotic try-catch blocks into elegant, type-safe code.',
    })
  })

  it('сущности в сниппетах декодированы, тегов нет', () => {
    const imhoff = hits.find((h) => h.url === 'https://imhoff.blog/posts/using-results-in-typescript')
    expect(imhoff?.snippet).toContain("We also haven't covered asynchronous code")
    // `<` бывает законным текстом (`Result<T, E>` из `&lt;`) — проверяем именно теги.
    expect(hits.every((h) => !/<\/?(b|a|span)\b/.test(h.title + h.snippet))).toBe(true)
  })

  it('пустая страница — пустая выдача', () => {
    expect(parseDdgHtml('<html><body><div class="no-results">No results.</div></body></html>')).toEqual([])
  })
})

describe('unwrapDdgHref / ddgRegion / isDdgChallenge', () => {
  it('редирект-обёртка разворачивается, реклама отбрасывается', () => {
    expect(unwrapDdgHref('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&amp;rut=x')).toBe('https://example.com/a?b=1')
    expect(unwrapDdgHref('https://duckduckgo.com/y.js?ad_domain=x')).toBeUndefined()
    expect(unwrapDdgHref('https://example.com/')).toBe('https://example.com/')
  })

  it('регион из языка', () => {
    expect(ddgRegion('ru')).toBe('ru-ru')
    expect(ddgRegion('en')).toBe('us-en')
    expect(ddgRegion('de-DE')).toBe('de-de')
    expect(ddgRegion('')).toBeUndefined()
  })

  it('капча распознаётся, выдача — нет', () => {
    expect(isDdgChallenge('<p>Unfortunately, bots use DuckDuckGo too.</p>')).toBe(true)
    expect(isDdgChallenge(html)).toBe(false)
  })
})

describe('ddg.search', () => {
  const respond =
    (status: number, body: string, seen: Array<{ url: string; body: unknown }> = []): Http =>
    async (req) => {
      seen.push({ url: req.url, body: req.body })
      return { ok: true, value: { status, headers: { 'content-type': 'text/html' }, body: new TextEncoder().encode(body) } }
    }

  it('POST-форма с q и kl, limit режет выдачу', async () => {
    const seen: Array<{ url: string; body: unknown }> = []
    const r = await ddg.search('typescript result type', { limit: 3, lang: 'ru', http: respond(200, html, seen), env: {} })
    expect(r.ok && r.value.length).toBe(3)
    expect(seen[0]?.url).toBe(DDG_URL)
    expect(String(seen[0]?.body)).toBe('q=typescript+result+type&b=&kl=ru-ru')
  })

  it('капча — ошибка blocked, а не пустая выдача', async () => {
    const r = await ddg.search('x', { limit: 5, http: respond(200, '<form id="challenge-form">bots use DuckDuckGo too</form>'), env: {} })
    expect(r.ok).toBe(false)
    if (!r.ok) expect((r.error as WebError).code).toBe('blocked')
  })

  it('202 и 403 — blocked (анти-бот DDG), 429 — rate_limited, 500 — http_error', async () => {
    for (const [status, code] of [[202, 'blocked'], [403, 'blocked'], [429, 'rate_limited'], [500, 'http_error']] as const) {
      const r = await ddg.search('x', { limit: 5, http: respond(status, ''), env: {} })
      expect(!r.ok && (r.error as WebError).code).toBe(code)
      expect(!r.ok && (r.error as WebError).status).toBe(status)
    }
  })
})
