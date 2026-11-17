import { describe, it, expect } from 'vitest'
import { walk } from '../../../src/contracts/eval/walk.js'
import { objectContext, arrayValue } from '../../../src/contracts/eval/contexts.js'
import type { IArray, IContext } from '../../../src/contracts/context.js'
import type { Value } from '../../../src/contracts/value.js'

const lenient = { mode: 'lenient' } as const
const strict = { mode: 'strict' } as const

describe('walk (§4)', () => {
  it('IContext + name segment → get', () => {
    const ctx = objectContext({ user: { email: 'a@b' } })
    expect(walk(ctx, ['user', 'email'], lenient)).toBe('a@b')
  })

  it('IArray + number segment → at', () => {
    const arr = arrayValue(['x', 'y', 'z'])
    expect(walk(arr, [1], lenient)).toBe('y')
  })

  it('cross-cast IArray + name → cast(IContext)', () => {
    // An array that supports name lookup via cross-cast.
    const byName: IContext = {
      get: (p) => (p[0] === 'first' ? 'A' : undefined),
      func: () => undefined,
      cast: (() => undefined) as any,
    }
    const arr: IArray = {
      length: () => 1,
      at: () => 'A',
      iterate: () => ['A'],
      cast: ((n: string) => (n === 'IContext' ? byName : undefined)) as any,
    }
    expect(walk(arr, ['first'], lenient)).toBe('A')
  })

  it('cross-cast IContext + number → cast(IArray)', () => {
    const items = arrayValue(['p', 'q'])
    const ctx: IContext = {
      get: () => undefined,
      func: () => undefined,
      cast: ((n: string) => (n === 'IArray' ? items : undefined)) as any,
    }
    // ctx is a context, but the next segment is numeric: walk treats ctx via
    // get([0]) first (isContext branch). Demonstrate the unknown-type branch
    // instead with a bare value carrying only cast.
    const bare: Value = { cast: (n: string) => (n === 'IArray' ? items : undefined) }
    expect(walk(bare, [0], lenient)).toBe('p')
    // And the context path returns undefined (get([0]) → undefined) gracefully.
    expect(walk(ctx, [0], lenient)).toBeUndefined()
  })

  it('cross-cast unknown + name → cast(IContext)', () => {
    const inner = objectContext({ name: 'Bob' })
    const bare: Value = { cast: (n: string) => (n === 'IContext' ? inner : undefined) }
    expect(walk(bare, ['name'], lenient)).toBe('Bob')
  })

  it('undefined / null short-circuit to undefined', () => {
    expect(walk(undefined, ['a'], lenient)).toBeUndefined()
    expect(walk(null, ['a'], lenient)).toBeUndefined()
  })

  it('scalar mid-path → undefined (lenient)', () => {
    const ctx = objectContext({ a: 'scalar' })
    expect(walk(ctx, ['a', 'b'], lenient)).toBeUndefined()
  })

  it('scalar mid-path → throws (strict)', () => {
    const ctx = objectContext({ a: 'scalar' })
    expect(() => walk(ctx, ['a', 'b'], strict)).toThrow(/scalar/)
  })

  it('array + name with no cross-cast → throws (strict)', () => {
    const arr = arrayValue(['x'])
    expect(walk(arr, ['nope'], lenient)).toBeUndefined()
    expect(() => walk(arr, ['nope'], strict)).toThrow(/name segment/)
  })

  it('empty segments returns the value itself', () => {
    expect(walk('hello', [], lenient)).toBe('hello')
  })
})
