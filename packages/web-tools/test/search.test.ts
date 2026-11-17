/** web_search: порядок провайдеров, фолбэк, brave/searxng на стабах (спека §1). */

import { describe, it, expect } from 'vitest'
import { ok, err } from '@kerneldreams/nrd'
import type { WebRequest } from '@kerneldreams/web'
import { clampLimit, providerOrder, webSearch } from '../src/search/index.js'
import { brave, parseBrave } from '../src/search/brave.js'
import { searxng, parseSearxng } from '../src/search/searxng.js'
import { webError, type WebError } from '../src/errors.js'
import type { Http } from '../src/http.js'
import type { SearchHit, SearchProvider } from '../src/search/types.js'

const noHttp: Http = async () => err(new Error('сеть в юнитах запрещена'))

function fake(name: string, result: SearchHit[] | WebError, needs?: string): SearchProvider & { calls: number } {
  const p = {
    name,
    calls: 0,
    unconfigured: (env: Record<string, string | undefined>) => (needs && !env[needs] ? `не задан ${needs}` : undefined),
    async search() {
      p.calls++
      return result instanceof Error ? err(result) : ok(result)
    },
  }
  return p
}

const hit = (url: string): SearchHit => ({ title: url, url, snippet: '' })

describe('providerOrder / clampLimit', () => {
  it('по умолчанию searxng,brave,ddg; список через запятую, без дублей и пустых', () => {
    expect(providerOrder({})).toEqual(['searxng', 'brave', 'ddg'])
    expect(providerOrder({ NR_WEB_SEARCH: ' Brave, ddg,,brave ' })).toEqual(['brave', 'ddg'])
  })

  it('limit: default 5, в [1, 10]', () => {
    expect(clampLimit(undefined)).toBe(5)
    expect(clampLimit(0)).toBe(1)
    expect(clampLimit(50)).toBe(10)
    expect(clampLimit(3.7)).toBe(3)
  })
})

describe('webSearch', () => {
  it('пустой query — bad_request, провайдеры не зовутся', async () => {
    const a = fake('a', [])
    const r = await webSearch({ query: '  ' }, { http: noHttp, env: { NR_WEB_SEARCH: 'a' }, providers: { a } })
    expect(!r.ok && (r.error as WebError).code).toBe('bad_request')
    expect(a.calls).toBe(0)
  })

  it('ненастроенный провайдер пропускается, следующий отвечает', async () => {
    const b = fake('b', [hit('https://b/')], 'B_KEY')
    const c = fake('c', [hit('https://c/')])
    const r = await webSearch({ query: 'q' }, { http: noHttp, env: { NR_WEB_SEARCH: 'b,c' }, providers: { b, c } })
    expect(r.ok && r.value).toEqual([hit('https://c/')])
    expect(b.calls).toBe(0)
  })

  it('упавший провайдер — фолбэк на следующий', async () => {
    const a = fake('a', webError('blocked', 'капча'))
    const c = fake('c', [hit('https://c/')])
    const r = await webSearch({ query: 'q' }, { http: noHttp, env: { NR_WEB_SEARCH: 'a,c' }, providers: { a, c } })
    expect(r.ok).toBe(true)
    expect(a.calls).toBe(1)
  })

  it('все осеклись — ошибка с причиной по каждому', async () => {
    const a = fake('a', webError('blocked', 'капча'))
    const b = fake('b', [], 'B_KEY')
    const r = await webSearch({ query: 'q' }, { http: noHttp, env: { NR_WEB_SEARCH: 'a,b,zzz' }, providers: { a, b } })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect((r.error as WebError).code).toBe('network')
      expect(r.error.message).toContain('a: [blocked] капча')
      expect(r.error.message).toContain('b: [unconfigured] не задан B_KEY')
      expect(r.error.message).toContain('zzz: [unconfigured] неизвестный провайдер')
    }
  })

  it('ни один не настроен — config', async () => {
    const b = fake('b', [], 'B_KEY')
    const r = await webSearch({ query: 'q' }, { http: noHttp, env: { NR_WEB_SEARCH: 'b' }, providers: { b } })
    expect(!r.ok && (r.error as WebError).code).toBe('config')
  })
})

describe('brave', () => {
  it('без ключа не настроен', () => {
    expect(brave.unconfigured({})).toContain('BRAVE_API_KEY')
    expect(brave.unconfigured({ BRAVE_API_KEY: 'test-key-1' })).toBeUndefined()
  })

  it('запрос с ключом в заголовке, <strong> из описаний срезан', async () => {
    let seen: WebRequest | undefined
    const http: Http = async (req) => {
      seen = req
      const body = { web: { results: [{ title: 'A &amp; B', url: 'https://a/', description: 'x <strong>y</strong>' }, { title: 'no url' }] } }
      return ok({ status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) })
    }
    const r = await brave.search('q w', { limit: 3, lang: 'en', http, env: { BRAVE_API_KEY: 'test-key-1' } })
    expect(r.ok && r.value).toEqual([{ title: 'A & B', url: 'https://a/', snippet: 'x y' }])
    expect(seen?.headers?.['x-subscription-token']).toBe('test-key-1')
    expect(seen?.url).toBe('https://api.search.brave.com/res/v1/web/search?q=q+w&count=3&search_lang=en')
  })

  it('битый JSON — parse', async () => {
    const http: Http = async () => ok({ status: 200, headers: {}, body: new TextEncoder().encode('<html>') })
    const r = await brave.search('q', { limit: 3, http, env: { BRAVE_API_KEY: 'test-key-1' } })
    expect(!r.ok && (r.error as WebError).code).toBe('parse')
  })

  it('parseBrave терпит чужую форму', () => {
    expect(parseBrave(null)).toEqual([])
    expect(parseBrave({ web: {} })).toEqual([])
  })
})

describe('searxng', () => {
  it('url инстанса с путём и слэшем, format=json', async () => {
    let url = ''
    const http: Http = async (req) => {
      url = req.url
      const body = { results: [{ title: 'T', url: 'https://t/', content: 'c' }] }
      return ok({ status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) })
    }
    const r = await searxng.search('q', { limit: 5, lang: 'ru', http, env: { SEARXNG_URL: 'http://searx.test/sub/' } })
    expect(r.ok && r.value).toEqual([{ title: 'T', url: 'https://t/', snippet: 'c' }])
    expect(url).toBe('http://searx.test/sub/search?q=q&format=json&language=ru')
  })

  it('без адреса не настроен; кривой адрес — config', async () => {
    expect(searxng.unconfigured({})).toContain('SEARXNG_URL')
    const r = await searxng.search('q', { limit: 5, http: noHttp, env: { SEARXNG_URL: 'not a url' } })
    expect(!r.ok && (r.error as WebError).code).toBe('config')
  })

  it('403 (JSON-формат выключен на инстансе) — config', async () => {
    const http: Http = async () => ok({ status: 403, headers: {}, body: new Uint8Array() })
    const r = await searxng.search('q', { limit: 5, http, env: { SEARXNG_URL: 'http://searx.test' } })
    expect(!r.ok && (r.error as WebError).code).toBe('config')
  })

  it('parseSearxng терпит чужую форму', () => {
    expect(parseSearxng({ results: 'nope' })).toEqual([])
  })
})
