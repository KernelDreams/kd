// Conformance — self (композитный) + $nr-extends (core-hardening-spec §C2/§C3).
import { describe, it, expect } from 'vitest'
import { parse } from '../../src/core/index.js'
import { parseDocument, resolveBlockValue, blockSelf } from '../../src/core/document.js'
import { funcContext, objectContext } from '../../src/core/contexts.js'

describe('conformance: self — композитный корень путей (§C2)', () => {
  it('self.x из блока — ссылка на составную единицу', () => {
    const block = parse('# $b\n$x: hi\n$msg: ${self.x}!').root.children[0]
    expect(resolveBlockValue(block, 'msg')).toBe('hi!')
  })

  it('self из root — сам документ', () => {
    const root = parse('$name: doc\n$greeting: привет, ${self.name}').root
    expect(resolveBlockValue(root, 'greeting')).toBe('привет, doc')
  })

  it('bare ${x} — свободная переменная, заполняет reader (C1)', () => {
    const block = parse('# $b\n$msg: ${x} и ${self.y}\n$y: mine').root.children[0]
    const reader = objectContext({ x: 'free' })
    expect(resolveBlockValue(block, 'msg', { reader })).toBe('free и mine')
  })

  it('цикл $a: ${self.a} → ошибка (cycle guard)', () => {
    const block = parse('# $b\n$a: ${self.a}').root.children[0]
    expect(() => resolveBlockValue(block, 'a')).toThrow(/cyclic/)
  })

  // без reader голый `${name}` не резолвился, undefined уезжал
  // аргументом в функцию и возвращался пустой строкой — ни ошибки, ни литерала.
  it('reader по умолчанию — сам блок: ${upper(name)} без reader работает', () => {
    const functions = funcContext({
      upper: (args) => String(args[0] ?? '').toUpperCase(),
    })
    const block = parse('# $person carly\n$name: carly\n$greeting: ${upper(name)}')
      .root.children[0]
    expect(resolveBlockValue(block, 'greeting', { functions })).toBe('CARLY')
    // Голый путь — тоже из блока, а не пустая строка.
    const b2 = parse('# $b\n$name: bob\n$msg: привет, ${name}').root.children[0]
    expect(resolveBlockValue(b2, 'msg')).toBe('привет, bob')
  })

  it('явный reader сильнее дефолта (C1 сохранена)', () => {
    const block = parse('# $b\n$x: mine\n$msg: ${x}').root.children[0]
    expect(resolveBlockValue(block, 'msg', { reader: objectContext({ x: 'free' }) }))
      .toBe('free')
  })

  it('голый цикл $a: ${a} ловится тем же гвардом', () => {
    const block = parse('# $b\n$a: ${a}').root.children[0]
    expect(() => resolveBlockValue(block, 'a')).toThrow(/cyclic/)
  })
})

describe('conformance: $nr-extends — блочное наследование (§C3)', () => {
  const base = [
    '$model: default-model',
    '$think: false',
    '$json: {"model": "${self.model}", "no_think": ${if_else(self.think, false, true)}}',
  ].join('\n')
  const load = (path: string) => {
    if (path === 'base.mdz') return base
    throw new Error(`unknown ${path}`)
  }

  // (16.07): значение `{...}` — JSON5-объект, не строка. Virtual dispatch
  // не изменился, изменился ТИП результата: post-resolve JSON5-детекция (§7.2).
  it('own-wins: наследник переопределяет model/think (virtual dispatch)', () => {
    const block = parse(
      ['## $preset server-x', '$nr-extends: base.mdz', '$model: gpt', '$think: true'].join('\n'),
    ).root.children[0]
    // json унаследован из базы, но ${self.model}/${self.think} видят наследника.
    expect(resolveBlockValue(block, 'json', { load })).toEqual({
      model: 'gpt',
      no_think: false,
    })
  })

  it('база = дефолты: без переопределения берутся значения базы', () => {
    const block = parse(['## $preset plain', '$nr-extends: base.mdz'].join('\n')).root.children[0]
    expect(resolveBlockValue(block, 'json', { load })).toEqual({
      model: 'default-model',
      no_think: true,
    })
  })

  // Тип пришёл из детекции, а не из JSON-подобного текста: значение,
  // которое НЕ является формой `{...}`, после резолва остаётся строкой.
  it('post-resolve коэрсится только JSON5 — скаляр остаётся строкой', () => {
    const block = parse(
      ['## $preset s', '$nr-extends: base.mdz', '$model: gpt', '$echo: ${self.model}'].join('\n'),
    ).root.children[0]
    expect(resolveBlockValue(block, 'echo', { load })).toBe('gpt')
  })

  it('own-атрибут виден напрямую поверх базы', () => {
    const block = parse(
      ['## $preset p', '$nr-extends: base.mdz', '$model: mine'].join('\n'),
    ).root.children[0]
    const self = blockSelf(block, '', load)
    expect(self.get(['model'])).toBe('mine') // own-wins
    expect(self.get(['think'])).toBe(false) // из базы
  })

  it('отсутствующий/битый файл — fail loud', () => {
    const block = parse(['## $preset q', '$nr-extends: missing.mdz'].join('\n')).root.children[0]
    expect(() => resolveBlockValue(block, 'json', { load })).toThrow(/nr-extends/)
  })

  it('нет загрузчика при наличии $nr-extends — ошибка', () => {
    const block = parse(['## $preset r', '$nr-extends: base.mdz'].join('\n')).root.children[0]
    expect(() => resolveBlockValue(block, 'json')).toThrow(/загрузчик/)
  })

  it('база грузится максимум один раз на вызов (даже при унаследованном теле)', () => {
    let calls = 0
    const counting = () => {
      calls++
      return [base, '', 'тело базы: ${self.model}'].join('\n')
    }
    const block = parse(
      ['## $preset p', '$nr-extends: base.mdz', '$model: gpt'].join('\n'),
    ).root.children[0]
    // Тело унаследовано → self и bodyRaw оба нуждаются в базе, но грузим её раз.
    expect(resolveBlockValue(block, 'body', { load: counting })).toBe('тело базы: gpt')
    expect(calls).toBe(1)
  })

  it('кэша в ядре нет: каждый вызов грузит базу заново (кэш — дело загрузчика)', () => {
    let calls = 0
    const counting = () => {
      calls++
      return base
    }
    const mk = (id: string) =>
      parse([`## $preset ${id}`, '$nr-extends: base.mdz'].join('\n')).root.children[0]
    resolveBlockValue(mk('a'), 'json', { load: counting })
    resolveBlockValue(mk('b'), 'json', { load: counting })
    expect(calls).toBe(2)
  })

  it('одинаковый путь из разных документов не коллизирует (ключ-путь не глобален)', () => {
    // Раньше глобальный кэш по сырому пути отдавал бы базу первого документа.
    const loadA = (p: string) => (p === 'base.mdz' ? '$model: from-a' : '')
    const loadB = (p: string) => (p === 'base.mdz' ? '$model: from-b' : '')
    const mk = () =>
      parse(['## $preset p', '$nr-extends: base.mdz', '$msg: ${self.model}'].join('\n')).root
        .children[0]
    expect(resolveBlockValue(mk(), 'msg', { load: loadA })).toBe('from-a')
    expect(resolveBlockValue(mk(), 'msg', { load: loadB })).toBe('from-b')
  })
})

describe('conformance: nr- конвенция (§C4)', () => {
  it("cast('keys') НЕ фильтрует nr-* — данные видны, фильтрация = дело потребителя", () => {
    const doc = parseDocument(['$nr-scope: sys', '$model: m'].join('\n'))
    expect(doc.cast('keys')).toEqual(['nr-scope', 'model'])
  })

  it("cast('attrs') отдаёт и nr-* атрибуты", () => {
    const doc = parseDocument(['$nr-scope: sys', '$model: m'].join('\n'))
    const attrs = doc.cast('attrs') as any
    const keys: string[] = []
    for (let i = 0; i < attrs.length(); i++) keys.push(attrs.at(i).get(['key']))
    expect(keys).toEqual(['nr-scope', 'model'])
  })

  it('get(nr-*) достаёт значение как обычный атрибут', () => {
    const doc = parseDocument(['$nr-scope: sys'].join('\n'))
    expect(doc.get(['nr-scope'])).toBe('sys')
  })
})
