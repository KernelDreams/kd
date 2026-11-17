import { describe, it, expect } from 'vitest'
import { ok, err, isOk, isErr, type Result } from '../../src/infra/result.js'

describe('result', () => {
  it('ok() создаёт успешный результат', () => {
    const r = ok(42)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(42)
  })

  it('err() создаёт результат с ошибкой', () => {
    const e = new Error('boom')
    const r = err(e)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(e)
  })

  it('isOk / isErr — взаимоисключающие type guards', () => {
    const a: Result<number> = ok(1)
    const b: Result<number> = err(new Error('x'))
    expect(isOk(a)).toBe(true)
    expect(isErr(a)).toBe(false)
    expect(isOk(b)).toBe(false)
    expect(isErr(b)).toBe(true)
  })

  it('isOk сужает тип до value', () => {
    const r: Result<string> = ok('hello')
    if (isOk(r)) expect(r.value.length).toBe(5)
    else throw new Error('unreachable')
  })
})
