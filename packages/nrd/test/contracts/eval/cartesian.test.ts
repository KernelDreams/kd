import { describe, it, expect } from 'vitest'
import { cartesian } from '../../../src/contracts/eval/cartesian.js'
import { arrayValue, objectContext } from '../../../src/contracts/eval/contexts.js'
import type { IArray, IContext } from '../../../src/contracts/context.js'
import { resolve } from '../../../src/contracts/eval/resolve.js'

function arr(...items: unknown[]): IArray {
  return arrayValue(items)
}

function collect(combos: IContext[], key: string): unknown[] {
  return combos.map(c => c.get([key]))
}

describe('cartesian', () => {
  it('2×3 = 6 combos in correct order', () => {
    const collections = new Map([
      ['color', arr('red', 'blue')],
      ['size', arr('S', 'M', 'L')],
    ])
    const combos = cartesian(collections)
    expect(combos).toHaveLength(6)
    // Default: insertion order. color = outer (slow), size = inner (fast)
    expect(collect(combos, 'color')).toEqual(['red', 'red', 'red', 'blue', 'blue', 'blue'])
    expect(collect(combos, 'size')).toEqual(['S', 'M', 'L', 'S', 'M', 'L'])
  })

  it('order reverses nesting', () => {
    const collections = new Map([
      ['color', arr('red', 'blue')],
      ['size', arr('S', 'M', 'L')],
    ])
    const combos = cartesian(collections, { order: ['size', 'color'] })
    expect(combos).toHaveLength(6)
    // size = outer (slow), color = inner (fast)
    expect(collect(combos, 'size')).toEqual(['S', 'S', 'M', 'M', 'L', 'L'])
    expect(collect(combos, 'color')).toEqual(['red', 'blue', 'red', 'blue', 'red', 'blue'])
  })

  it('empty collection → 0 combos', () => {
    const collections = new Map([
      ['a', arr('x', 'y')],
      ['b', arr()],
    ])
    expect(cartesian(collections)).toHaveLength(0)
  })

  it('zero collections → one empty combo', () => {
    const combos = cartesian(new Map())
    expect(combos).toHaveLength(1)
    expect(combos[0].get(['anything'])).toBeUndefined()
  })

  it('single collection → N combos of 1 value each', () => {
    const combos = cartesian(new Map([['x', arr(1, 2, 3)]]))
    expect(combos).toHaveLength(3)
    expect(collect(combos, 'x')).toEqual([1, 2, 3])
  })

  it('IContext elements survive into combo (tbl rows)', () => {
    const row1 = objectContext({ name: 'pinup', strength: 1.0 })
    const row2 = objectContext({ name: 'anime', strength: 0.8 })
    const combos = cartesian(new Map([
      ['lora', arr(row1, row2)],
      ['seed', arr(42, 99)],
    ]))
    expect(combos).toHaveLength(4)
    // First combo: lora=row1, seed=42. Walk through lora.name should work.
    const first = combos[0]
    const lora = first.get(['lora']) as IContext
    expect(lora.get(['name'])).toBe('pinup')
    expect(first.get(['seed'])).toBe(42)
  })

  it('works with resolve through chainContext', () => {
    const collections = new Map([
      ['actor', arr('Zendaya', 'Emma')],
      ['seed', arr(1001)],
    ])
    const combos = cartesian(collections)
    expect(combos).toHaveLength(2)
    const result = resolve('${actor} seed=${seed}', combos[0])
    expect(result).toBe('Zendaya seed=1001')
  })

  it('order with partial keys — unlisted keys appended', () => {
    const collections = new Map([
      ['a', arr(1, 2)],
      ['b', arr(3, 4)],
      ['c', arr(5, 6)],
    ])
    // Only specify 'c' as outer — a,b follow insertion order
    const combos = cartesian(collections, { order: ['c'] })
    expect(combos).toHaveLength(8)
    // c is outermost (slowest): first 4 have c=5, next 4 have c=6
    expect(collect(combos, 'c')).toEqual([5, 5, 5, 5, 6, 6, 6, 6])
  })
})
