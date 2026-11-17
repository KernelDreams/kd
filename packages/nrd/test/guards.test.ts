import { describe, it, expect } from 'vitest'
import { isScalar, isContext, isArray, asText, toText } from '../src/core/icontext.js'
import { objectContext, arrayValue, emptyContext } from '../src/core/contexts.js'

describe('guards (§2)', () => {
  it('isScalar', () => {
    expect(isScalar('x')).toBe(true)
    expect(isScalar(42)).toBe(true)
    expect(isScalar(true)).toBe(true)
    expect(isScalar(null)).toBe(false)
    expect(isScalar(undefined)).toBe(false)
    expect(isScalar({})).toBe(false)
    expect(isScalar([])).toBe(false)
  })

  it('isContext (duck: get + cast)', () => {
    expect(isContext(emptyContext)).toBe(true)
    expect(isContext(objectContext({ a: 1 }))).toBe(true)
    expect(isContext(arrayValue([1]))).toBe(false) // has at, not get
    expect(isContext({ get: 'x' })).toBe(false)
    expect(isContext(null)).toBe(false)
    expect(isContext('hello')).toBe(false)
  })

  it('isContext НЕ ловит Map (нативный get без cast)', () => {
    expect(isContext(new Map([['k', 1]]))).toBe(false)
    expect(isContext({ get: () => 1 })).toBe(false) // get есть, cast нет
  })

  it('isArray (duck: at + cast)', () => {
    expect(isArray(arrayValue([1, 2]))).toBe(true)
    expect(isArray(objectContext({ a: 1 }))).toBe(false)
    expect(isArray(null)).toBe(false)
  })

  it('isArray НЕ ловит нативный массив (Array.prototype.at без cast)', () => {
    expect(isArray([1, 2])).toBe(false)
    expect(isArray({ at: () => 1 })).toBe(false) // at есть, cast нет
  })

  it('toText — скаляры как есть, объект → json5 (text-cast-spec §2.1)', () => {
    expect(toText('hi')).toBe('hi')
    expect(toText(42)).toBe('42')
    expect(toText(false)).toBe('false')
    expect(toText({})).toBe('{}') // объект дампится, а не молчит
    expect(toText({ a: 1, b: 'x' })).toBe("{a: 1, b: 'x'}")
    expect(toText(null)).toBeUndefined()
    expect(toText([1, 2])).toBe('2') // массив в текстовой позиции — last-wins (§3.4)
    expect(toText([])).toBe('[]')
    expect(toText(new Map())).toBeUndefined() // не значение формата, не TypeError на .cast
  })

  it('asText — сужающий аксессор: контейнер без текста молчит (регресс NTS-317)', () => {
    expect(asText('hi')).toBe('hi')
    expect(asText(42)).toBe('42')
    expect(asText({ api_key: 'sk-SECRET' })).toBeUndefined() // НЕ дамп: секрет не течёт
    expect(asText(objectContext({ api_key: 'sk-SECRET' }))).toBeUndefined()
    expect(asText(null)).toBeUndefined()
  })
})
