/**
 * Сетевой тест на настоящий DuckDuckGo (спека §3) — `live`, по умолчанию
 * пропускается. Запуск: `npm run test:live` (NR_WEB_LIVE=1).
 *
 * Ловит то, что фикстура поймать не может: DDG поменял вёрстку или начал
 * отдавать капчу на форму. Падение здесь — сигнал обновить фикстуру и парсер,
 * а не баг сети.
 */

import { describe, it, expect } from 'vitest'
import { ddg } from '../src/search/ddg.js'
import { defaultHttp } from '../src/http.js'

describe.skipIf(!process.env.NR_WEB_LIVE)('live: DuckDuckGo', () => {
  it('реальная выдача парсится в непустой список', async () => {
    const r = await ddg.search('typescript result type', { limit: 5, http: defaultHttp(), env: {} })
    if (!r.ok) throw r.error
    expect(r.value.length).toBeGreaterThan(0)
    for (const hit of r.value) {
      expect(hit.url).toMatch(/^https?:\/\//)
      expect(hit.title).not.toBe('')
    }
  })
})
