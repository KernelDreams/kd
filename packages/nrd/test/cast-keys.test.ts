// cast('keys') — перечисление ключей верхнего уровня ( часть A).

import { describe, it, expect } from 'vitest'
import {
  objectContext,
  chainContext,
  emptyContext,
  funcContext,
} from '../src/core/contexts.js'
import { parseDocument } from '../src/core/document.js'

describe("cast('keys')", () => {
  it('objectContext → имена верхнего уровня', () => {
    expect(objectContext({ a: 1, b: 2 }).cast('keys')).toEqual(['a', 'b'])
  })

  it('objectContext пустой → []', () => {
    expect(objectContext({}).cast('keys')).toEqual([])
  })

  it('objectContext — только верхний уровень', () => {
    expect(objectContext({ x: { nested: 1 } }).cast('keys')).toEqual(['x'])
  })

  it('chainContext → union, dedup, first-layer-first', () => {
    const chain = chainContext(
      objectContext({ a: 1, c: 3 }),
      objectContext({ b: 2, c: 4 }),
    )
    expect(chain.cast('keys')).toEqual(['a', 'c', 'b'])
  })

  it('emptyContext → []', () => {
    expect(emptyContext.cast('keys')).toEqual([])
  })

  it('funcContext → []', () => {
    expect(funcContext({ f: () => 1 }).cast('keys')).toEqual([])
  })

  it('NRDocument → атрибуты root + дочерние блоки', () => {
    const doc = parseDocument(
      '@name: X\n@mood: warm\n\n## @item a\n@label: first',
      { sigil: '@' },
    )
    const keys = doc.cast('keys') as string[]
    expect(keys).toContain('name')
    expect(keys).toContain('mood')
    // дочерний блок `## @item a` → id 'a' (fallback name 'item')
    expect(keys.includes('a') || keys.includes('item')).toBe(true)
  })
})
