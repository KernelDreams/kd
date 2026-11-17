// resolve-fix-spec §1.4 / §1.6 / §1.7 — грамматика аргументов, значение-дерево,
// path-доступ после вызова. Дефекты найдены зондами (DEBT 08.08 №4, №6, №7).

import { describe, it, expect } from 'vitest'
import { resolve, resolveValue } from '../../../src/contracts/eval/resolve.js'
import { parseExpr } from '../../../src/contracts/eval/placeholder.js'
import { objectContext, chainContext, funcContext, arrayValue } from '../../../src/contracts/eval/contexts.js'
import type { IContext } from '../../../src/contracts/context.js'

const preset = objectContext({ temperature: 0.9, style: 'из json-пресета' })

function fns(): IContext {
  return funcContext({
    load: (args) => (String(args[0]) === 'preset' ? preset : undefined),
    echo: (args) => String(args[0] ?? ''),
  })
}

describe('§1.4 — аргументы функций в одинарных кавычках', () => {
  it("'...' — такой же строковый литерал, как \"...\"", () => {
    const ctx = chainContext(fns())
    expect(resolve("${echo('привет')}", ctx)).toBe('привет')
    expect(resolve('${echo("привет")}', ctx)).toBe('привет')
  })

  it('одинарные кавычки разбираются в литерал, а не в путь', () => {
    const expr = parseExpr("load('preset')")
    expect(expr.kind).toBe('call')
    if (expr.kind !== 'call') return
    expect(expr.args).toEqual([{ kind: 'literal', value: 'preset' }])
  })

  it('escape внутри одинарных — по правилам двойных', () => {
    const ctx = chainContext(fns())
    expect(resolve("${echo('a\\'b')}", ctx)).toBe("a'b")
    expect(resolve("${echo('a\\nb')}", ctx)).toBe('a\nb')
  })

  it('незакрытый литерал — ошибка про литерал, не про путь', () => {
    expect(() => parseExpr("load('preset)")).toThrow(/Unclosed string literal/)
    expect(() => parseExpr('load("preset)')).toThrow(/Unclosed string literal/)
  })

  it('кавычки разных видов не закрывают друг друга', () => {
    expect(() => parseExpr(`load('preset")`)).toThrow(/Unclosed string literal/)
  })

  it('запятая внутри литерала не делит аргументы', () => {
    const expr = parseExpr("load('a,b', 'c')")
    if (expr.kind !== 'call') throw new Error('ожидался call')
    expect(expr.args).toEqual([
      { kind: 'literal', value: 'a,b' },
      { kind: 'literal', value: 'c' },
    ])
  })
})

describe('§1.7 — path-сегменты после вызова', () => {
  it('грамматика допускает call (. segment)*', () => {
    const expr = parseExpr("load('preset').temperature")
    expect(expr.kind).toBe('call')
    if (expr.kind !== 'call') return
    expect(expr.name).toBe('load')
    expect(expr.path).toEqual([{ kind: 'name', value: 'temperature' }])
  })

  it('резолв достаёт поле из дерева, которое вернул вызов', () => {
    const ctx = chainContext(fns())
    expect(resolve("${load('preset').temperature}", ctx)).toBe('0.9')
    expect(resolve("${load('preset').style}", ctx)).toBe('из json-пресета')
  })

  it('вложенный путь и индекс', () => {
    const deep = objectContext({ a: objectContext({ b: arrayValue(['x', 'y']) }) })
    const ctx = chainContext(funcContext({ load: () => deep }))
    expect(resolve('${load("x").a.b.1}', ctx)).toBe('y')
  })

  it('несуществующее поле — прежняя lenient-семантика (литерал)', () => {
    const ctx = chainContext(fns())
    expect(resolve("${load('preset').missing}", ctx)).toBe("${load('preset').missing}")
  })

  it('вызов без пути не изменился', () => {
    const expr = parseExpr('load("preset")')
    if (expr.kind !== 'call') throw new Error('ожидался call')
    expect(expr.path).toBeUndefined()
  })
})

describe('§1.6 — resolveValue: значение целиком остаётся деревом', () => {
  it('плейсхолдер занимает значение целиком → IContext, а не строка', () => {
    const ctx = chainContext(fns())
    const v = resolveValue("${load('preset')}", ctx)
    expect(typeof v).toBe('object')
    expect((v as IContext).get(['temperature'])).toBe(0.9)
  })

  it('интерполяция в середине строки — по-прежнему строка', () => {
    const ctx = chainContext(fns())
    expect(typeof resolveValue("пресет: ${load('preset')}", ctx)).toBe('string')
  })

  it('скаляр остаётся строкой (коэрсия подстановкой не вводится)', () => {
    expect(resolveValue('${n}', { n: 42 })).toBe('42')
  })

  it('функция вызывается ровно один раз', () => {
    let calls = 0
    const ctx = chainContext(
      funcContext({
        io: () => {
          calls++
          return 'v'
        },
      }),
    )
    expect(resolveValue('${io()}', ctx)).toBe('v')
    expect(calls).toBe(1)
  })

  it('нерезолвнутое: lenient — литерал, strict — ошибка', () => {
    expect(resolveValue('${missing}', {})).toBe('${missing}')
    expect(() => resolveValue('${missing}', {}, { mode: 'strict' })).toThrow(
      /unresolved placeholder/,
    )
  })

  it('IArray тоже дерево', () => {
    const ctx = chainContext(funcContext({ list: () => arrayValue(['a', 'b']) }))
    const v = resolveValue('${list()}', ctx)
    expect(typeof (v as { at?: unknown }).at).toBe('function')
  })
})

describe('§1.5 — funcContext доносит служебный контекст до FuncFn', () => {
  it('второй аргумент FuncFn — переданный контекст', () => {
    const service = objectContext({ $baseDir: '/base' })
    const ctx = chainContext(funcContext({ where: (_a, c) => c.get(['$baseDir']) }, service))
    expect(resolve('${where()}', ctx)).toBe('/base')
  })

  it('без контекста — прежнее поведение (пустой)', () => {
    const ctx = chainContext(funcContext({ where: (_a, c) => c.get(['$baseDir']) }))
    expect(resolve('${where()}', ctx)).toBe('${where()}')
  })
})
