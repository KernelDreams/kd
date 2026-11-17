// Stdlib чистых функций (core-hardening-spec §C5).
import { describe, it, expect } from 'vitest'
import { coreFunctions } from '../../../src/contracts/eval/functions.js'
import { resolve } from '../../../src/contracts/eval/resolve.js'
import { chainContext, funcContext, objectContext } from '../../../src/contracts/eval/contexts.js'

const fns = funcContext(coreFunctions)
const ctx = (data: Record<string, unknown> = {}) => chainContext(objectContext(data), fns)

describe('coreFunctions — прямой вызов', () => {
  it('if_else: truthy → a, иначе b', () => {
    expect(coreFunctions.if_else([true, 'a', 'b'], undefined as never)).toBe('a')
    expect(coreFunctions.if_else([false, 'a', 'b'], undefined as never)).toBe('b')
    expect(coreFunctions.if_else(['', 'a', 'b'], undefined as never)).toBe('b')
    expect(coreFunctions.if_else([null, 'a', 'b'], undefined as never)).toBe('b')
    expect(coreFunctions.if_else([0, 'a', 'b'], undefined as never)).toBe('a') // 0 truthy по конвенции
  })
  it('not: отрицание по truthy-конвенции', () => {
    expect(coreFunctions.not([false], undefined as never)).toBe(true)
    expect(coreFunctions.not([''], undefined as never)).toBe(true)
    expect(coreFunctions.not(['x'], undefined as never)).toBe(false)
  })
  it('eq: строгое равенство без коэрции', () => {
    expect(coreFunctions.eq(['a', 'a'], undefined as never)).toBe(true)
    expect(coreFunctions.eq([1, 1], undefined as never)).toBe(true)
    expect(coreFunctions.eq(['1', 1], undefined as never)).toBe(false) // без коэрции
  })
  it('default: null/undefined → fallback', () => {
    expect(coreFunctions.default([undefined, 'fb'], undefined as never)).toBe('fb')
    expect(coreFunctions.default([null, 'fb'], undefined as never)).toBe('fb')
    expect(coreFunctions.default(['x', 'fb'], undefined as never)).toBe('x')
    expect(coreFunctions.default([0, 'fb'], undefined as never)).toBe(0)
  })
})

describe('coreFunctions — через резолвер', () => {
  it('if_else с путём и литералами', () => {
    expect(resolve('${if_else(flag, "yes", "no")}', ctx({ flag: true }))).toBe('yes')
    expect(resolve('${if_else(flag, "yes", "no")}', ctx({ flag: false }))).toBe('no')
  })
  it('not(x)', () => {
    expect(resolve('${not(flag)}', ctx({ flag: false }))).toBe('true')
  })
  it('eq(mode, "a")', () => {
    expect(resolve('${eq(mode, "a")}', ctx({ mode: 'a' }))).toBe('true')
    expect(resolve('${eq(mode, "a")}', ctx({ mode: 'b' }))).toBe('false')
  })
  it('default(missing, "fb")', () => {
    expect(resolve('${default(missing, "fb")}', ctx({}))).toBe('fb')
  })
  it('вложенность ${if_else(eq(mode,"a"), 1, 0)}', () => {
    expect(resolve('${if_else(eq(mode, "a"), 1, 0)}', ctx({ mode: 'a' }))).toBe('1')
    expect(resolve('${if_else(eq(mode, "a"), 1, 0)}', ctx({ mode: 'x' }))).toBe('0')
  })
})
