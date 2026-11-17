// Поиск картинок — DDG без ключа (токен vqd → i.js), SearXNG первым, если задан.
import { describe, expect, it } from 'vitest'
import { ok } from '@kerneldreams/nrd'
import type { Http } from '../src/http.js'
import { ddgVqd, imageSearch, parseDdgImages, parseSearxngImages } from '../src/search/images.js'

const body = (v: unknown, status = 200) => ok({ status, headers: {}, body: new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v)) })

describe('поиск картинок', () => {
  it('токен vqd во всех трёх записях страницы', () => {
    expect(ddgVqd('... vqd="4-1234-5678" ...')).toBe('4-1234-5678')
    expect(ddgVqd("vqd='4-99'")).toBe('4-99')
    expect(ddgVqd('&vqd=4-77&p=1')).toBe('4-77')
    expect(ddgVqd('<html>')).toBeUndefined()
  })

  it('разбор DDG и SearXNG: без адреса картинки — мимо, размеры числом', () => {
    expect(parseDdgImages({ results: [{ image: 'https://a/x.jpg', thumbnail: 'https://t/x', title: 'A &amp; B', url: 'https://a/', width: 800, height: 600 }, { title: 'нет картинки' }] })).toEqual([
      { image: 'https://a/x.jpg', thumb: 'https://t/x', title: 'A & B', page: 'https://a/', width: 800, height: 600, via: 'ddg' },
    ])
    expect(parseSearxngImages({ results: [{ img_src: 'https://s/i.png', thumbnail_src: '', title: 'S', url: 'https://s/', resolution: '1024 x 768' }] })).toEqual([
      { image: 'https://s/i.png', thumb: 'https://s/i.png', title: 'S', page: 'https://s/', width: 1024, height: 768, via: 'searxng' },
    ])
    expect(parseDdgImages(null)).toEqual([])
  })

  it('DDG: страница → токен → i.js с запросом и токеном', async () => {
    const seen: string[] = []
    const http: Http = async (req) => {
      seen.push(req.url)
      if (req.url.startsWith('https://duckduckgo.com/?')) return body('<script>vqd="4-42"</script>')
      return body({ results: [{ image: 'https://cdn/venti.png', thumbnail: 'https://t/1', title: 'Venti', url: 'https://wiki/' }] })
    }
    const r = await imageSearch({ query: 'Venti Genshin' }, { http, env: {} })
    expect(r.ok && r.value.map((h) => h.image)).toEqual(['https://cdn/venti.png'])
    expect(seen[1]).toContain('vqd=4-42')
    expect(seen[1]).toContain('q=Venti+Genshin')
  })

  it('SearXNG задан — первым; пусто — DDG; оба мимо — ошибка с причиной каждого', async () => {
    const http: Http = async (req) => {
      if (req.url.startsWith('http://searx.lan/')) return body({ results: [] })
      if (req.url.startsWith('https://duckduckgo.com/?')) return body('<html>без токена</html>')
      return body('', 500)
    }
    const r = await imageSearch({ query: 'q' }, { http, env: { SEARXNG_URL: 'http://searx.lan' } })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.message).toMatch(/searxng: пусто; ddg: .*vqd/)
    expect((await imageSearch({ query: '  ' }, { http, env: {} })).ok).toBe(false)
  })
})
