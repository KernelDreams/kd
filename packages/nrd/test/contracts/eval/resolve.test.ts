import { describe, it, expect } from 'vitest'
import { resolve, resolveValue, get, unescapeOptOut } from '../../../src/contracts/eval/resolve.js'
import { objectContext, chainContext, funcContext } from '../../../src/contracts/eval/contexts.js'

describe('resolve (§3)', () => {
  it('simple substitution', () => {
    expect(resolve('Hello ${name}!', { name: 'World' })).toBe('Hello World!')
  })

  it('numeric / boolean values stringify', () => {
    expect(resolve('${n} ${b}', { n: 42, b: true })).toBe('42 true')
  })

  it('dotted path', () => {
    expect(resolve('${user.email}', { user: { email: 'a@b' } })).toBe('a@b')
  })

  it('array index path + last-wins for bare array ref', () => {
    expect(resolve('${tags.1}', { tags: ['x', 'y', 'z'] })).toBe('y')
    expect(resolve('${tags}', { tags: ['x', 'y', 'z'] })).toBe('z') // §3.4 last
  })

  it('reference chain — recursion kind 1', () => {
    const ctx = objectContext({ x: '${y}', y: '${z}', z: 'hello' })
    expect(resolve('${x}', ctx)).toBe('hello')
  })

  it('function result with ${} — recursion kind 2', () => {
    const ctx = chainContext(
      funcContext({ greet: () => 'Hi ${name}' }),
      objectContext({ name: 'Ada' }),
    )
    expect(resolve('${greet()}', ctx)).toBe('Hi Ada')
  })

  it('function receives resolved args', () => {
    const ctx = chainContext(
      funcContext({ upper: (args) => String(args[0]).toUpperCase() }),
      objectContext({ who: 'bob' }),
    )
    expect(resolve('${upper(who)}', ctx)).toBe('BOB')
    expect(resolve('${upper("lit")}', ctx)).toBe('LIT')
  })

  it('\\${ opt-out — placeholder left literal', () => {
    // Actual chars: \ $ { x } → output ${x}, x NOT resolved.
    expect(resolve('\\${x}', { x: 'Y' })).toBe('${x}')
  })

  it('\\${ opt-out survives recursion (kind 1)', () => {
    // a holds an opt-out template; resolving ${a} must keep ${x} literal.
    const ctx = objectContext({ a: '\\${x}', x: 'Y' })
    expect(resolve('${a}', ctx)).toBe('${x}')
  })

  it('\\${ opt-out survives recursion (kind 2, function result)', () => {
    const ctx = chainContext(
      funcContext({ tpl: () => 'keep \\${x}' }),
      objectContext({ x: 'Y' }),
    )
    expect(resolve('${tpl()}', ctx)).toBe('keep ${x}')
  })

  it('escaped backslash before a live placeholder is not opt-out', () => {
    // \ \ $ { x } → backslash + resolved x.
    expect(resolve('\\\\${x}', { x: 'Y' })).toBe('\\\\Y')
  })

  it('cycle detection throws (lenient)', () => {
    const ctx = objectContext({ a: '${b}', b: '${a}' })
    expect(() => resolve('${a}', ctx)).toThrow(/cyclic reference/)
  })

  it('self-reference cycle throws', () => {
    const ctx = objectContext({ a: '${a}' })
    expect(() => resolve('${a}', ctx)).toThrow(/cyclic/)
  })

  it('repeated sibling refs are not a cycle', () => {
    expect(resolve('${a} ${a}', { a: 'x' })).toBe('x x')
  })

  it('lenient: unresolved → literal', () => {
    expect(resolve('${missing}', {})).toBe('${missing}')
  })

  it('strict: unresolved → throws', () => {
    expect(() => resolve('${missing}', {}, { mode: 'strict' })).toThrow(/unresolved/)
  })

  it('nested ${} as a path segment', () => {
    const ctx = objectContext({ key: 'email', user: { email: 'z@z' } })
    expect(resolve('${user.${key}}', ctx)).toBe('z@z')
  })
})

describe('get convenience (§8.1)', () => {
  it('parses string path and wraps Record', () => {
    expect(get('user.email', { user: { email: 'a@b' } })).toBe('a@b')
  })

  it('accepts segment array', () => {
    expect(get(['tags', 0], { tags: ['first'] })).toBe('first')
  })

  it('missing → undefined', () => {
    expect(get('nope', {})).toBeUndefined()
  })
})

describe('нативные типы не проходят duck-guard (NTS-231 §1)', () => {
  it('name-сегмент на нативном массиве: lenient → literal, НЕ TypeError', () => {
    expect(resolve('${a.x}', { a: [1, 2] })).toBe('${a.x}')
  })

  it('name-сегмент на нативном массиве: strict → осмысленный throw, НЕ TypeError', () => {
    let err: unknown
    try {
      resolve('${a.x}', { a: [1, 2] }, { mode: 'strict' })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toContain('is not a function')
    expect((err as Error).message).toMatch(/segment/)
  })

  it('число-сегмент на нативном массиве работает (wrapValue → arrayValue)', () => {
    expect(resolve('${a.1}', { a: ['x', 'y'] })).toBe('y')
  })

  it('Map — не IContext: get() возвращает undefined, а не мусор', () => {
    expect(get('m.k', { m: new Map([['k', 1]]) })).toBeUndefined()
  })

  it('вложенный нативный массив: элементы обходятся через wrapValue', () => {
    expect(resolve('${a.0.name}', { a: [{ name: 'n' }] })).toBe('n')
  })
})

// значение, которое ложится обратно в контекст, держит opt-out живым;
// сворачивают только выходы (resolve / resolveValue / get).
describe('keepOptOut (§3.1, ABC-162)', () => {
  const ctx = { b: 'SUBST' }

  it('resolve/resolveValue с keepOptOut оставляют `\\${`, живые плейсхолдеры подставлены', () => {
    expect(resolve('a ${b} \\${b}', ctx, { keepOptOut: true })).toBe('a SUBST \\${b}')
    expect(resolveValue('a \\${b} c', ctx, { keepOptOut: true })).toBe('a \\${b} c')
    expect(resolveValue('${u}', { u: 'a \\${b} c' }, { keepOptOut: true })).toBe('a \\${b} c')
  })

  it('сохранённое с keepOptOut не оживает на следующем звене рекурсии', () => {
    const u = resolve('a \\${b} c', ctx, { keepOptOut: true })
    expect(resolve('${u}', { ...ctx, u })).toBe('a ${b} c')
    // без keepOptOut — ровно баг: свёрнутое значение оживает
    const folded = resolve('a \\${b} c', ctx)
    expect(resolve('${u}', { ...ctx, u: folded })).toBe('a SUBST c')
  })

  it('get() — выход: строка со свёрнутым opt-out, не-строки как есть', () => {
    expect(get('u', { u: 'a \\${b} c' })).toBe('a ${b} c')
    expect(get('n', { n: 3 })).toBe(3)
  })

  it('unescapeOptOut: `\\\\${` (эскейп слэша + живой) не трогается', () => {
    expect(unescapeOptOut('a \\${b}')).toBe('a ${b}')
    expect(unescapeOptOut('a \\\\${b}')).toBe('a \\\\${b}')
  })
})
