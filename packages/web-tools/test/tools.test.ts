/**
 * `createWebTools` — тулы (библиотечный экспорт `./tools`):
 * те же описания и схемы, что у расширения; результат и ошибка — `{text, isError}`.
 */

import { describe, it, expect } from 'vitest'
import { ok, err } from '@kerneldreams/nrd'
import { createWebTools, WEB_SEARCH_PARAMETERS } from '../src/tools.js'

const searxEnv = { NR_WEB_SEARCH: 'searxng', SEARXNG_URL: 'http://searx.test' }
const json = (value: unknown) => ok({ status: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(value)) })

describe('createWebTools', () => {
  it('две тулзы с JSON Schema; поиск форматирует hits', async () => {
    const tools = createWebTools({
      http: async () => json({ results: [{ title: 'T', url: 'https://a.test/', content: 'snip' }] }),
      lookup: async () => ['93.184.216.34'],
      env: () => searxEnv,
    })
    expect(tools.map((t) => t.name)).toEqual(['web_search', 'web_fetch'])
    expect(tools[0]!.parameters).toBe(WEB_SEARCH_PARAMETERS)
    const res = await tools[0]!.execute({ query: 'x' })
    expect(res.isError).toBeUndefined()
    expect(res.text).toContain('https://a.test/')
  })

  it('ошибка — результатом с isError, не исключением', async () => {
    const tools = createWebTools({ http: async () => err(new Error('offline')), lookup: async () => ['93.184.216.34'], env: () => searxEnv })
    const res = await tools[1]!.execute({ url: 'http://localhost/' })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/^web_fetch failed/)
  })
})
