// Проба как фикстуры (spec §10 E2): эталоны и выходы агентов (3 модели × 4 формата ×
// fate/ccv3/campaign + первый проход кампании и правка) проходят check пакета так же, как
// валидатор пробы (`check.mjs`, PROBE_HELPERS=1): без ошибок ⇔ без ошибок. Фикстуры —
// `scripts/probe-fixtures.mjs`, блоки row/tabs переведены на $row/$tab.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { baseWidgets, ccv3Widgets, check, createCatalog, fateWidgets, formatIssue, parseEditor } from '../src/editor/index.js'
import { loadFixture } from './probe/load.js'

const DIR = join(__dirname, 'fixtures', 'probe')
const expected = JSON.parse(readFileSync(join(DIR, 'expected.json'), 'utf8')) as Record<string, { ok: boolean; errors: string[] }>
const catalog = createCatalog([...baseWidgets, ...fateWidgets, ...ccv3Widgets])

describe('проба ABC-485: check пакета = валидатор пробы', () => {
  it('фикстур столько, сколько у пробы', () => {
    expect(Object.keys(expected).length).toBe(64)
  })
  for (const [file, want] of Object.entries(expected)) {
    it(`${file}: ${want.ok ? 'чисто' : 'ошибка'}`, () => {
      const { def, issues } = parseEditor(loadFixture(join(DIR, file)))
      const parseErrors = issues.filter((i) => i.code.startsWith('E_'))
      const r = check(def, catalog)
      const errors = [...parseErrors, ...r.errors].map(formatIssue)
      if (want.ok) expect(errors).toEqual([])
      else expect(errors.length, `проба: ${want.errors.join(' | ')}`).toBeGreaterThan(0)
    })
  }
})
