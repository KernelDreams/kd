// Conformance — JSON5-объект как значение атрибута (format-spec §3, §7.2;
// docs/specs/json5-scalar-spec.md)..
//
// Канон: детекция по форме, строгая. Значение начинается `{` И кончается `}` →
// обязано быть валидным однострочным JSON5-объектом; битое → ошибка с номером
// строки, НЕ молчаливый откат в строку.
import { describe, it, expect } from 'vitest'
import { parse } from '../../src/core/index.js'
import { serialize } from '../../src/core/index.js'
import { resolve } from '../../src/core/resolve.js'
import { resolveBlockValue } from '../../src/core/document.js'
import { Json5ParseError } from '../../src/core/index.js'

const attr = (src: string) => parse(src).root.attrs[0].value

describe('conformance: JSON5-скаляр — детекция по форме (§3)', () => {
  it('значение целиком в фигурных → объект', () => {
    expect(attr("$json: {model: 'gpt', retries: 2}")).toEqual({ model: 'gpt', retries: 2 })
  })

  it('пустой объект', () => {
    expect(attr('$json: {}')).toEqual({})
  })

  it('вложенность внутри JSON5 легитимна (это JSON5, не flow)', () => {
    expect(attr("$json: {a: {b: [1, 2]}, c: null}")).toEqual({ a: { b: [1, 2] }, c: null })
  })

  it('полный JSON5-2018: голые ключи, одинарные кавычки, хвостовая запятая', () => {
    expect(attr("$json: {a: 'x', b: .5, c: 0xFF,}")).toEqual({ a: 'x', b: 0.5, c: 255 })
  })

  it('двойные кавычки внутри — обычный JSON тоже валидный JSON5', () => {
    expect(attr('$json: {"model": "gpt"}')).toEqual({ model: 'gpt' })
  })

  it('`{` без замыкающей `}` в конце → проза, конфликта нет', () => {
    expect(attr('$msg: {name} says hi')).toBe('{name} says hi')
  })

  it('`{` в середине значения → строка', () => {
    expect(attr('$msg: hi {name}')).toBe('hi {name}')
  })
})

describe('conformance: JSON5-скаляр — строгость (§3, решение 2)', () => {
  it('битый JSON5 в форме `{...}` → ошибка, НЕ откат в строку', () => {
    expect(() => parse('$json: {model: }')).toThrow(Json5ParseError)
  })

  it('ошибка несёт номер строки документа и ключ', () => {
    const src = ['# $b', '$ok: 1', '$json: {model: }'].join('\n')
    try {
      parse(src)
      expect.unreachable('должна быть ошибка')
    } catch (e) {
      expect(e).toBeInstanceOf(Json5ParseError)
      const err = e as Json5ParseError
      expect(err.line).toBe(3)
      expect(err.key).toBe('json')
      expect(err.message).toContain('line 3')
      expect(err.message).toContain('$json')
    }
  })

  it('незакрытая кавычка внутри формы → ошибка', () => {
    expect(() => parse("$json: {a: 'x}")).toThrow(Json5ParseError)
  })
})

describe('conformance: JSON5-скаляр — форсирование строки (§2.5, §3)', () => {
  it('эскейп `\\{` → строка целиком в фигурных', () => {
    expect(attr('$k: \\{literal}')).toBe('{literal}')
  })

  it('эскейп гасит и битый JSON5 — ошибки нет', () => {
    expect(attr('$k: \\{model: }')).toBe('{model: }')
  })

  it('кавычки главнее детекции (кавычки форсируют строку)', () => {
    expect(attr('$k: "{a: 1}"')).toBe('{a: 1}')
  })
})

describe('conformance: JSON5-скаляр — границы позиции (§4, §5)', () => {
  it('элемент flow-литерала НЕ коэрсится в объект (§4: только скаляры)', () => {
    expect(attr('$xs: $[{a: 1}, b]')).toEqual(['{a: 1}', 'b'])
  })

  it('битый JSON5 во flow — не ошибка, обычная строка', () => {
    expect(attr('$xs: $[{model: }, b]')).toEqual(['{model: }', 'b'])
  })

  it('тело блока не трогается детекцией (§6: тело — сырая строка)', () => {
    const doc = parse(['# $b', '', '{model: }'].join('\n'))
    expect(doc.root.children[0].body).toBe('{model: }')
  })

  // Детекция — только атрибутный путь. Тело остаётся текстом и через резолв:
  // ни объектом не становится, ни ошибкой не падает, даже будучи формой.
  it('тело через resolveBlockValue — текст, не объект (даже валидный JSON5)', () => {
    const block = parse(['## $b', '', "{model: 'gpt'}"].join('\n')).root.children[0]
    const r = resolveBlockValue(block, 'body')
    expect(r).toBe("{model: 'gpt'}")
    expect(typeof r).toBe('string')
  })

  it('тело-битый-JSON5 через resolveBlockValue — не ошибка, текст', () => {
    const block = parse(['## $b', '', '{model: }'].join('\n')).root.children[0]
    expect(resolveBlockValue(block, 'body')).toBe('{model: }')
  })
})

describe('conformance: JSON5-скаляр — две точки коэрсии (§7.2)', () => {
  it('точка 1 — parse-time: значение без ${} → объект сразу', () => {
    expect(attr("$json: {model: 'gpt'}")).toEqual({ model: 'gpt' })
  })

  it('значение с ${} на выходе парсера — InterpolatedValue, ещё не объект', () => {
    const v = attr("$json: {model: '${model}'}")
    expect(v).toHaveProperty('raw')
    expect(v).toHaveProperty('placeholders')
  })

  it('точка 2 — post-resolve: шаблонизированный объект легитимен', () => {
    const block = parse(
      ['## $p', '$model: gpt', "$json: {model: '${self.model}', retries: 2}"].join('\n'),
    ).root.children[0]
    expect(resolveBlockValue(block, 'json')).toEqual({ model: 'gpt', retries: 2 })
  })

  it('post-resolve коэрсит ТОЛЬКО JSON5: скаляр остаётся строкой (не NTS-231)', () => {
    const block = parse(['## $p', '$x: 42', '$n: ${self.x}'].join('\n')).root.children[0]
    expect(resolveBlockValue(block, 'n')).toBe('42')
  })

  // Eligibility по СЫРОЙ форме (п.7 финализирован 16.07): право на детекцию
  // определяется raw ДО резолва. Не object-shaped raw не детектится НИКОГДА —
  // чем бы резолв ни обернулся.
  it('eligibility по raw: `${x}` с объектоподобной строкой НЕ становится объектом', () => {
    const block = parse(['## $p', '$x: "{a: 1}"', '$n: ${self.x}'].join('\n')).root.children[0]
    const r = resolveBlockValue(block, 'n')
    expect(r).toBe('{a: 1}') // строка, не объект
    expect(typeof r).toBe('string')
  })

  it('eligibility по raw: подстановка объекта целиком в не-форму — строка', () => {
    // $copy: ${json} — raw `${self.json}` не форма → результат остаётся текстом.
    const block = parse(['## $p', "$json: {model: 'gpt'}", '$copy: ${self.json}'].join('\n'))
      .root.children[0]
    expect(resolveBlockValue(block, 'copy')).toBe("{model: 'gpt'}")
  })

  it('eligibility по raw: форма в raw → детекция, даже если ${} внутри строки', () => {
    const block = parse(['## $p', '$m: gpt', "$json: {model: '${self.m}'}"].join('\n'))
      .root.children[0]
    expect(resolveBlockValue(block, 'json')).toEqual({ model: 'gpt' })
  })

  it('eligible-значение обязано быть валидным JSON5: битое после резолва → ошибка', () => {
    const block = parse(['## $p', '$bad: }', '$json: {a: ${self.bad}}'].join('\n'))
      .root.children[0]
    expect(() => resolveBlockValue(block, 'json')).toThrow(Json5ParseError)
  })

  it('lenient: неразрешённый плейсхолдер внутри формы → ошибка (битое = ошибка)', () => {
    const block = parse(['## $p', '$json: {a: ${missing}}'].join('\n')).root.children[0]
    expect(() => resolveBlockValue(block, 'json')).toThrow(Json5ParseError)
  })

  it('подстановка внутрь неквотированной позиции JSON5 даёт типизированное поле', () => {
    const block = parse(['## $p', '$think: false', '$json: {no_think: ${self.think}}'].join('\n'))
      .root.children[0]
    expect(resolveBlockValue(block, 'json')).toEqual({ no_think: false })
  })

  it('resolve() остаётся текстовым уровнем: string → string (B2 не задет)', () => {
    expect(resolve("{model: '${model}'}", { model: 'gpt' })).toBe("{model: 'gpt'}")
  })

  it('${attr} на объекте разворачивается в канонический relaxed текст (§5)', () => {
    // Не литерал `${self.json}` (ветка valueToText) — но и не объект: алиас
    // объекта даёт ТЕКСТ, потому что raw `${self.json}` не форма (§7.2).
    // Объект целиком доступен через контекст (self.get), не через текст.
    const block = parse(['## $p', "$json: {model: 'gpt'}", '$copy: ${self.json}'].join('\n'))
      .root.children[0]
    expect(resolveBlockValue(block, 'copy')).toBe("{model: 'gpt'}")
  })

  // Регрессия (поймано e2e 16.07): точка 2 применялась к ЛЮБОМУ значению, а не
  // только к пропустившим точку 1. Эскейп/кавычки съедаются в точке 1, и строка
  // `{...}` второй раз выглядела формой: `\{not json}` падал ошибкой, а
  // `"{a: 1}"` молча становился объектом. Точка 2 — только InterpolatedValue.
  it('точка 2 НЕ трогает строку, коэрснутую точкой 1: эскейп доживает до резолва', () => {
    const block = parse(['## $p', '$lit: \\{not json}'].join('\n')).root.children[0]
    expect(resolveBlockValue(block, 'lit')).toBe('{not json}')
  })

  it('точка 2 НЕ трогает quoted-строку: кавычки доживают до резолва', () => {
    const block = parse(['## $p', '$k: "{a: 1}"'].join('\n')).root.children[0]
    expect(resolveBlockValue(block, 'k')).toBe('{a: 1}')
  })

  it('эскейп доживает и в наследовании через $nr-extends', () => {
    const load = (p: string) => {
      if (p === 'b.mdz') return '$lit: \\{not json}'
      throw new Error(`unknown ${p}`)
    }
    const block = parse(['## $p', '$nr-extends: b.mdz'].join('\n')).root.children[0]
    expect(resolveBlockValue(block, 'lit', { load })).toBe('{not json}')
  })

  it('путь внутрь объекта — фаза 1.1: в v1 undefined (lenient)', () => {
    const block = parse(['## $p', "$json: {model: 'gpt'}", '$m: ${self.json.model}'].join('\n'))
      .root.children[0]
    expect(resolveBlockValue(block, 'm')).toBe('${self.json.model}') // не разрешено → литерал
  })
})

describe('conformance: JSON5-скаляр — каскад атомарен (§8, решение 4)', () => {
  it('last-wins заменяет JSON5-значение ЦЕЛИКОМ, без deep-merge', () => {
    const doc = parse(['$json: {a: 1, b: 2}', '$json: {a: 9}'].join('\n'))
    const attrs = doc.root.attrs.filter((a) => a.key[0] === 'json')
    expect(attrs[attrs.length - 1].value).toEqual({ a: 9 }) // b НЕ пережил
  })
})

describe('conformance: JSON5-скаляр — сериализация (§5)', () => {
  it('эмит — канонический relaxed одной строкой', () => {
    const doc = parse('$json: {"model": "gpt", "retries": 2}')
    expect(serialize(doc)).toBe("$json: {model: 'gpt', retries: 2}")
  })

  it('round-trip канонического объекта байт-точен', () => {
    const src = "$json: {model: 'gpt', deep: {a: [1, 2]}}"
    expect(serialize(parse(src))).toBe(src)
  })

  it('round-trip: строка-в-фигурных переживает эмит через эскейп', () => {
    const doc = parse('$k: \\{literal}')
    const out = serialize(doc)
    expect(out).toBe('$k: \\{literal}')
    expect(parse(out).root.attrs[0].value).toBe('{literal}') // строкой, не объектом
  })

  it('идемпотентность повторной сериализации', () => {
    const src = "$json: {a: 1}\n$k: \\{literal}"
    const once = serialize(parse(src))
    expect(serialize(parse(once))).toBe(once)
  })
})
