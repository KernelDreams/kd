/** маршрутизатор с остыванием, fetch через браузер, карточка товара, вид страницы, конфиг машины. */

import { describe, it, expect } from 'vitest'
import { ok, err } from '@kerneldreams/nrd'
import { routeSearch, routeLine } from '../src/search/index.js'
import { webError, type WebError } from '../src/errors.js'
import { createWebTools, wantsBrowser } from '../src/tools.js'
import { isChallenge, browserPort } from '../src/browser.js'
import { cardFromPage, formatCard, productFromHtml } from '../src/product.js'
import { PAY_RE, renderLook } from '../src/tools-browser.js'
import { parseWebBlock } from '../src/machine.js'
import type { Http } from '../src/http.js'
import type { SearchHit, SearchProvider } from '../src/search/types.js'

const noHttp: Http = async () => err(new Error('сеть в юнитах запрещена'))
const hit = (url: string): SearchHit => ({ title: url, url, snippet: '' })

function fake(name: string, result: SearchHit[] | WebError | 'hang'): SearchProvider & { calls: number } {
  const p = {
    name,
    calls: 0,
    unconfigured: () => undefined,
    async search(_q: string, o: { signal?: AbortSignal }) {
      p.calls++
      if (result === 'hang') {
        return new Promise<never>((_, reject) => o.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
          .catch(() => err(webError('aborted', 'отменён')))
      }
      return result instanceof Error ? err(result) : ok(result)
    },
  }
  return p
}

describe('routeSearch', () => {
  it('анти-бот — переключение, итог с именем ответившего и попытками', async () => {
    const ddg = fake('ddg', webError('blocked', 'ddg: HTTP 202', 202))
    const sx = fake('searxng', [hit('https://x/')])
    const r = await routeSearch({ query: 'q' }, { http: noHttp, env: { NR_WEB_SEARCH: 'ddg,searxng' }, providers: { ddg, searxng: sx }, cooldowns: new Map() })
    expect(r.ok && r.value.provider).toBe('searxng')
    expect(r.ok && r.value.attempts.map((a) => `${a.provider}:${a.result}`)).toEqual(['ddg:blocked', 'searxng:ok'])
    expect(r.ok && routeLine(r.value)).toBe('[search via searxng; ddg: blocked]')
  })

  it('осёкшийся остывает: повтор того же запроса его не зовёт', async () => {
    const cooldowns = new Map()
    let t = 1_000_000
    const ddg = fake('ddg', webError('rate_limited', 'ddg: HTTP 429', 429))
    const sx = fake('searxng', [hit('https://x/')])
    const deps = { http: noHttp, env: { NR_WEB_SEARCH: 'ddg,searxng' }, providers: { ddg, searxng: sx }, cooldowns, now: () => t }
    await routeSearch({ query: 'q' }, deps)
    const again = await routeSearch({ query: 'q' }, deps)
    expect(ddg.calls).toBe(1)
    expect(again.ok && again.value.attempts[0]).toMatchObject({ provider: 'ddg', result: 'skipped' })
    t += 6 * 60_000 // остывание 429 — 5 мин
    await routeSearch({ query: 'q' }, deps)
    expect(ddg.calls).toBe(2)
  })

  it('остыли все — пробуются все, а не отказ без попытки', async () => {
    const cooldowns = new Map([['ddg', { until: Number.MAX_SAFE_INTEGER, why: 'blocked' }]])
    const ddg = fake('ddg', [hit('https://d/')])
    const r = await routeSearch({ query: 'q' }, { http: noHttp, env: { NR_WEB_SEARCH: 'ddg' }, providers: { ddg }, cooldowns })
    expect(r.ok && r.value.provider).toBe('ddg')
    expect(cooldowns.has('ddg')).toBe(false)
  })

  it('провайдер висит — таймаут провайдера, следующий отвечает', async () => {
    const slow = fake('searxng', 'hang')
    const ddg = fake('ddg', [hit('https://d/')])
    const r = await routeSearch({ query: 'q' }, { http: noHttp, env: { NR_WEB_SEARCH: 'searxng,ddg' }, providers: { searxng: slow, ddg }, cooldowns: new Map(), providerTimeoutMs: 50 })
    expect(r.ok && r.value.attempts.map((a) => a.result)).toEqual(['timeout', 'ok'])
  })

  it('пустая выдача — следующий; пусто у всех — пустой ok от первого', async () => {
    const a = fake('searxng', [])
    const b = fake('ddg', [hit('https://d/')])
    const r = await routeSearch({ query: 'q' }, { http: noHttp, env: { NR_WEB_SEARCH: 'searxng,ddg' }, providers: { searxng: a, ddg: b }, cooldowns: new Map() })
    expect(r.ok && r.value.provider).toBe('ddg')
    const none = await routeSearch({ query: 'q' }, { http: noHttp, env: { NR_WEB_SEARCH: 'searxng' }, providers: { searxng: fake('searxng', []) }, cooldowns: new Map() })
    expect(none.ok && none.value).toMatchObject({ hits: [], provider: 'searxng' })
  })

  it('порядок по умолчанию: ненастроенные молча пропущены', async () => {
    const sx = { ...fake('searxng', [hit('https://x/')]), unconfigured: (env: Record<string, string | undefined>) => (env.SEARXNG_URL ? undefined : 'нет') }
    const ddg = fake('ddg', [hit('https://d/')])
    const r = await routeSearch({ query: 'q' }, { http: noHttp, env: {}, providers: { searxng: sx, ddg }, cooldowns: new Map() })
    expect(r.ok && r.value.provider).toBe('ddg')
    expect(r.ok && r.value.attempts).toEqual([{ provider: 'ddg', result: 'ok', ms: expect.any(Number) }])
  })
})

const LD = `<html><head><title>Seago SG-977</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Seago SG-977","brand":{"@type":"Brand","name":"Seago"},"gtin13":"6970000000017","sku":"SG977","offers":{"@type":"Offer","price":"89.99","priceCurrency":"PLN","availability":"https://schema.org/InStock","seller":{"@type":"Organization","name":"Seago Store"}}}</script></head><body><p>Szczoteczka</p></body></html>`

describe('карточка товара', () => {
  it('JSON-LD Product → поля', () => {
    const c = productFromHtml(LD, 'https://shop/p', new Date('2026-11-02T18:00:00Z'))
    expect(c).toMatchObject({ name: 'Seago SG-977', brand: 'Seago', ean: '6970000000017', sku: 'SG977', price: 89.99, currency: 'PLN', availability: 'InStock', seller: 'Seago Store', source: 'json-ld' })
    expect(formatCard(c!)).toContain('EAN 6970000000017')
  })

  it('Amazon по DOM: цена «89,99 zł» → 89.99 PLN, ASIN, EAN из деталей', () => {
    const c = cardFromPage({ url: 'https://www.amazon.pl/dp/B0TEST1234', ld: [], amazon: { name: 'Seago SG-977', asin: 'B0TEST1234', price: '89,99 zł', seller: 'Amazon', ean: '6970000000017' } })
    expect(c).toMatchObject({ asin: 'B0TEST1234', price: 89.99, currency: 'PLN', seller: 'Amazon', ean: '6970000000017', source: 'amazon' })
  })

  it('нет товара — undefined', () => {
    expect(productFromHtml('<html><p>blog</p></html>', 'https://b/')).toBeUndefined()
  })
})

describe('web_fetch через браузер', () => {
  const blocked: Http = async () => ok({ status: 403, headers: { 'content-type': 'text/html' }, body: new TextEncoder().encode('<title>Access denied</title>') })
  const lookup = async () => ['93.184.216.34']
  const fetchTool = (http: Http, env: Record<string, string>, page: { html: string; challenge?: boolean }, calls: string[] = []) =>
    createWebTools({
      http,
      lookup,
      env: () => env,
      browserGet: async (port, url) => {
        calls.push(`${port} ${url}`)
        return { url, title: 'x', html: page.html, challenge: page.challenge ?? false }
      },
    }).find((t) => t.name === 'web_fetch')!

  it('403 → страница браузером профиля, с пометкой и карточкой', async () => {
    const calls: string[] = []
    const r = await fetchTool(blocked, { NR_WEB_BROWSER_CDP: '9303' }, { html: LD }, calls).execute({ url: 'https://allegro.pl/oferta/1' })
    expect(r.isError).toBeUndefined()
    expect(calls).toEqual(['9303 https://allegro.pl/oferta/1'])
    expect(r.text).toMatch(/^\[via browser/)
    expect(r.text).toContain('Product: Seago SG-977')
    expect(r.details).toMatchObject({ via: 'browser', product: { ean: '6970000000017' } })
  })

  it('капча осталась и в браузере — честная ошибка «нужен человек» с окном', async () => {
    const r = await fetchTool(blocked, { NR_WEB_BROWSER_CDP: '9303', NR_WEB_BROWSER_WINDOW: 'http://server:8083' }, { html: '', challenge: true }).execute({ url: 'https://allegro.pl/x' })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/blocked.*руками в окне профиля \(окно браузера: http:\/\/server:8083\)/)
  })

  it('без браузера — исходная ошибка с честным кодом', async () => {
    const r = await fetchTool(blocked, {}, { html: '' }).execute({ url: 'https://allegro.pl/x' })
    expect(r.text).toMatch(/^web_fetch failed \[blocked\]: .*HTTP 403/)
  })

  it('200 с заглушкой Cloudflare — тоже blocked → браузер', async () => {
    const cf: Http = async () => ok({ status: 200, headers: { 'content-type': 'text/html' }, body: new TextEncoder().encode('<title>Just a moment...</title><div id="cf-chl-widget"></div>') })
    const calls: string[] = []
    await fetchTool(cf, { NR_WEB_BROWSER_CDP: 'http://127.0.0.1:9303' }, { html: LD }, calls).execute({ url: 'https://shop.example/p' })
    expect(calls).toHaveLength(1)
  })

  it('в браузер не идут: 404 и частный адрес', async () => {
    expect(wantsBrowser(webError('http_error', 'x', 404))).toBe(false)
    expect(wantsBrowser(webError('blocked', 'x', 403))).toBe(true)
    const calls: string[] = []
    const t = createWebTools({ http: blocked, lookup: async () => ['10.0.0.5'], env: () => ({ NR_WEB_BROWSER_CDP: '9303' }), browserGet: async () => (calls.push('x'), { url: '', title: '', html: '', challenge: false }) })
    await t.find((x) => x.name === 'web_fetch')!.execute({ url: 'https://intranet.example/' })
    expect(calls).toEqual([])
  })
})

describe('браузер: мелочи', () => {
  it('заглушки анти-бота узнаются, обычная страница — нет', () => {
    expect(isChallenge('Just a moment...', '')).toBe(true)
    expect(isChallenge('allegro.pl', '<iframe src="https://geo.captcha-delivery.com/x">')).toBe(true)
    expect(isChallenge('Amazon.pl : szczoteczka', '<div>wyniki</div>')).toBe(false)
  })

  it('порт CDP из числа и из url', () => {
    expect(browserPort({ NR_WEB_BROWSER_CDP: '9303' })).toBe(9303)
    expect(browserPort({ NR_WEB_BROWSER_CDP: 'http://127.0.0.1:9303/' })).toBe(9303)
    expect(browserPort({})).toBeUndefined()
  })

  it('кнопки оплаты и окончательного заказа узнаются, корзина — нет', () => {
    for (const s of ['Kupuję i płacę', 'Kup teraz', 'Złóż zamówienie', 'Place your order', 'Zamawiam i płacę']) expect(PAY_RE.test(s)).toBe(true)
    for (const s of ['Dodaj do koszyka', 'Przejdź do kasy', 'Dostawa kurierem']) expect(PAY_RE.test(s)).toBe(false)
  })

  it('без браузера тулы browser_* отвечают ошибкой config, и они opt-in', async () => {
    const tools = createWebTools({ http: noHttp, env: () => ({}), browser: true })
    const b = tools.filter((t) => t.name.startsWith('browser_'))
    expect(b.map((t) => t.name)).toEqual(['browser_open', 'browser_look', 'browser_click', 'browser_fill', 'browser_extract'])
    expect(b.every((t) => t.optIn)).toBe(true)
    const r = await b[1]!.execute({})
    expect(r.text).toMatch(/^browser_look failed \[config\]/)
    expect(createWebTools({ http: noHttp, env: () => ({}) }).map((t) => t.name)).toEqual(['web_search', 'web_fetch'])
  })
})

describe('вид страницы', () => {
  const raw = { url: 'https://a/', title: 'T', lines: ['# Wyniki', 'Seago SG-977 szczoteczka', '89,99 zł', '[r1] button "Dodaj do koszyka"', 'Philips Sonicare', '149 zł', '[r2] button "Dodaj do koszyka"'] }

  it('find — совпадения с соседями', () => {
    const t = renderLook(raw, { find: 'seago' })
    expect(t).toContain('Seago SG-977')
    expect(t).toContain('[r1]')
  })

  it('потолок и подсказка offset', () => {
    const t = renderLook(raw, { maxChars: 40 })
    expect(t).toMatch(/\[ещё \d+ строк: browser_look с offset=\d+/)
    const next = renderLook(raw, { offset: 5 })
    expect(next).toContain('149 zł')
    expect(next).not.toContain('# Wyniki')
  })

  it('не нашлось — так и сказано', () => {
    expect(renderLook(raw, { find: 'oral-b' })).toContain('не найдено')
  })
})

describe('конфиг машины', () => {
  it('блок ## $web → переменные, списки и кавычки', () => {
    const env = parseWebBlock('## $voice\n$provider: x\n\n## $web\n$provider: searxng,ddg\n$searxng_url: "http://127.0.0.1:8888"\n$browser_cdp: 9303\n$allow_hosts: $[a.lan, b.lan]\n\n## $other\n$browser_cdp: 1')
    expect(env).toEqual({ NR_WEB_SEARCH: 'searxng,ddg', SEARXNG_URL: 'http://127.0.0.1:8888', NR_WEB_BROWSER_CDP: '9303', NR_WEB_FETCH_ALLOW_HOSTS: 'a.lan,b.lan' })
  })
})
