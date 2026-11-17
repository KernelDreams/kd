import { describe, it, expect } from 'vitest'
import {
  objectContext,
  arrayValue,
  chainContext,
  ChainContext,
  emptyContext,
  funcContext,
} from '../../../src/contracts/eval/contexts.js'

describe('objectContext (§8)', () => {
  it('flat + nested get', () => {
    const ctx = objectContext({ a: 1, b: { c: 'deep' } })
    expect(ctx.get(['a'])).toBe(1)
    expect(ctx.get(['b', 'c'])).toBe('deep')
    expect(ctx.get(['missing'])).toBeUndefined()
  })

  it('func / cast are inert', () => {
    const ctx = objectContext({ a: 1 })
    expect(ctx.func('x', [])).toBeUndefined()
    expect(ctx.cast('text')).toBeUndefined()
  })
})

describe('arrayValue (§8)', () => {
  it('length / at / iterate', () => {
    const arr = arrayValue(['a', 'b', 'c'])
    expect(arr.length()).toBe(3)
    expect(arr.at(1)).toBe('b')
    expect(arr.at(9)).toBeUndefined()
    expect([...arr.iterate()]).toEqual(['a', 'b', 'c'])
  })
})

describe('funcContext (§8)', () => {
  it('first-hit on registered function', () => {
    const ctx = funcContext({ add: (args) => Number(args[0]) + Number(args[1]) })
    expect(ctx.func('add', [2, 3])).toBe(5)
    expect(ctx.func('nope', [])).toBeUndefined()
    expect(ctx.get(['x'])).toBeUndefined()
  })
})

describe('ChainContext (§5)', () => {
  it('first-hit get', () => {
    const chain = chainContext(objectContext({ a: 1 }), objectContext({ a: 2, b: 3 }))
    expect(chain.get(['a'])).toBe(1) // first wins
    expect(chain.get(['b'])).toBe(3) // falls through
  })

  it('first-hit func', () => {
    const chain = chainContext(
      funcContext({ f: () => 'first' }),
      funcContext({ f: () => 'second', g: () => 'g' }),
    )
    expect(chain.func('f', [])).toBe('first')
    expect(chain.func('g', [])).toBe('g')
  })

  it('first-hit cast (non-serialization)', () => {
    const a = { ...emptyContext, cast: ((n: string) => (n === 'foo' ? 'A' : undefined)) as any }
    const b = { ...emptyContext, cast: ((n: string) => (n === 'foo' ? 'B' : undefined)) as any }
    expect(chainContext(a, b).cast('foo')).toBe('A')
  })

  it('serialization casts text/raw → undefined', () => {
    const link = {
      ...emptyContext,
      cast: ((n: string) => (n === 'text' ? 'link-text' : undefined)) as any,
    }
    const chain = new ChainContext([link])
    expect(chain.cast('text')).toBeUndefined()
    expect(chain.cast('raw')).toBeUndefined()
    // but the link itself still yields text
    expect(link.cast('text')).toBe('link-text')
  })
})
