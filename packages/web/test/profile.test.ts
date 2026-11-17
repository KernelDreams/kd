import { describe, it, expect } from 'vitest'
import type { Document } from '@kerneldreams/nrd'
import { readProfileFields } from '../src/adapter/profile.js'

// (nrd-core 2.0): AttributeValue пополнился Json5Object — это САМ
// распарсенный plain-объект (пользовательские ключи прямо в нём), не обёртка.
// attrText обязан отдавать undefined: объект — не текст профиля. Guard
// isJson5Object стоит ДО ветки 'raw' in v, потому что ключ raw в JSON5-объекте —
// пользовательские данные, а не текст InterpolatedValue ({raw, placeholders}).

function docWith(value: unknown): Document {
  return {
    root: {
      name: '',
      attrs: [{ key: ['token'], value }],
      children: [],
    },
  } as unknown as Document
}

describe('profile attrText × Json5Object (NTS-261)', () => {
  it('InterpolatedValue ({raw, placeholders}) → его текст', () => {
    const fields = readProfileFields(docWith({ raw: 'sk-${env}', placeholders: [] }))
    expect(fields.token).toBe('sk-${env}')
  })

  it('Json5Object (plain-объект) → undefined, не "[object Object]"', () => {
    const fields = readProfileFields(docWith({ a: 1, nested: { b: 2 } }))
    expect(fields.token).toBeUndefined()
  })

  it('Json5Object с пользовательским ключом raw → undefined, чужой raw не утёк как текст', () => {
    const fields = readProfileFields(docWith({ raw: 'user-data', other: 1 }))
    expect(fields.token).toBeUndefined()
  })

  it('обычная строка — как раньше', () => {
    const fields = readProfileFields(docWith('sk-plain'))
    expect(fields.token).toBe('sk-plain')
  })
})
