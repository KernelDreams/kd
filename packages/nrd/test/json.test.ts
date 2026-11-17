import { describe, it, expect } from 'vitest'
import { parse, serialize } from '../src/md/index.js'
import { toJson, fromJson } from '../src/core/json.js'
import { parseDocument } from '../src/core/document.js'
import * as root from '../src/index.js'
import * as format from '../src/format/index.js'

// Круговой обход через строку — ровно так, как state едет внутри гритинга.
const wire = (text: string, sigil: '@' | '$' = '@') => {
  const doc = parse(text, { sigil })
  const line = JSON.stringify(toJson(doc))
  return { doc, line, back: fromJson(JSON.parse(line)) }
}

const STATE = [
  '@title: Стартовое состояние',
  '@day: 3',
  '@hp: 72.5',
  '@delta: -0.25',
  '@tags: @[утро, дом, "a, b", 42]',
  '@alive: true',
  '@nothing: null',
  '@geo.city: Москва',
  '@greeting: Привет, ${user.name}!',
  '@meta: {mood: "calm", level: 2, list: [1, "x"]}',
  '',
  '## @char алиса',
  '@name: Алиса',
  '@trust: 0.75',
  '',
  'Тело блока: строка первая.',
  'Вторая строка с ${char.name}.',
  '',
  '### @item ключ-1',
  '@count: 2',
  '',
  '#### @note',
  'глубоко',
  '',
  '## @char боб',
  '@name: Боб',
  '@tags: @[]',
].join('\n')

describe('toJson/fromJson — round-trip (json-spec)', () => {
  it('вложенные блоки, тела, числа, дроби, списки, кириллические id', () => {
    const { doc, line, back } = wire(STATE)
    expect(back).toEqual(doc)
    expect(line).not.toContain('\n')
    expect(serialize(back)).toBe(serialize(doc))

    const alice = back.root.children[0]
    expect(alice.id).toBe('алиса')
    expect(alice.children[0].id).toBe('ключ-1')
    expect(alice.children[0].children[0].body).toBe('глубоко')
    const attr = (k: string) => back.root.attrs.find((a) => a.key.join('.') === k)!.value
    expect(attr('hp')).toBe(72.5)
    expect(attr('delta')).toBe(-0.25)
    expect(attr('day')).toBe(3)
    expect(attr('tags')).toEqual(['утро', 'дом', 'a, b', 42])
    expect(attr('geo.city')).toBe('Москва')
  })

  it('документ без блоков — только атрибуты корня', () => {
    const { doc, back } = wire('@a: 1\n@b: текст\n')
    expect(back.root.children).toEqual([])
    expect(back).toEqual(doc)
  })

  it('пустой документ', () => {
    const { doc, line, back } = wire('')
    expect(back).toEqual(doc)
    expect(JSON.parse(line)).toEqual({ v: 1, sigil: '@', root: { name: '', level: 0 } })
  })

  it('сигил mdz сохраняется', () => {
    const { doc, back } = wire('$x: 1\n\n# $blk id\n$y: 2\n', '$')
    expect(back.sigil).toBe('$')
    expect(back).toEqual(doc)
  })

  it('тело корня без блоков', () => {
    const { doc, back } = wire('просто текст\nв две строки')
    expect(back).toEqual(doc)
  })

  it('fromJson принимает и строку', () => {
    const { doc, line } = wire(STATE)
    expect(fromJson(line)).toEqual(doc)
  })
})

describe('fromJson — устойчивость формы', () => {
  it('неизвестные поля на всех уровнях не роняют', () => {
    const json = {
      v: 1,
      sigil: '@',
      future: { x: 1 },
      root: {
        name: '',
        level: 0,
        extra: 'x',
        attrs: [[['a'], 1, 'лишний элемент пары']],
        children: [{ name: 'char', id: 'я', level: 1, color: 'red', body: 'тело' }],
      },
    }
    const doc = fromJson(json)
    expect(doc.root.attrs).toEqual([{ key: ['a'], value: 1 }])
    expect(doc.root.children[0]).toEqual({ name: 'char', id: 'я', level: 1, attrs: [], body: 'тело', children: [] })
    expect(fromJson({ ...json, v: 99 }).root.attrs).toHaveLength(1)
  })

  it('опущенные поля — дефолты (level из вложенности, ключ-строка)', () => {
    const doc = fromJson({ root: { attrs: [['k', 'v']], children: [{ name: 'b', children: [{ name: 'c' }] }] } })
    expect(doc.sigil).toBe('@')
    expect(doc.root.attrs[0].key).toEqual(['k'])
    expect(doc.root.children[0].level).toBe(1)
    expect(doc.root.children[0].children[0].level).toBe(2)
  })

  it('нарушение формы — TypeError', () => {
    expect(() => fromJson(null)).toThrow(TypeError)
    expect(() => fromJson({ sigil: '#' })).toThrow(TypeError)
    expect(() => fromJson({ root: { attrs: [['a', { weird: 1 }]] } })).toThrow(TypeError)
    expect(() => fromJson({ root: { children: 'x' } })).toThrow(TypeError)
  })
})

describe('toJson — границы JSON', () => {
  it('не-конечное число в JSON5-объекте — TypeError', () => {
    const doc = parse('@m: {x: Infinity}', { sigil: '@' })
    expect(() => toJson(doc)).toThrow(TypeError)
  })
})

describe('toJson — форма аргумента (ABC-100 §3)', () => {
  const text = '@a: 1\n\n## @b x\n@c: 2\n'

  it('Document и NRDocument дают одно и то же', () => {
    const nr = parseDocument(text)
    expect(toJson(nr)).toEqual(toJson(nr.doc))
    expect(toJson(nr)).toEqual(toJson(parse(text)))
  })

  it.each([
    [undefined, 'undefined'],
    [null, 'null'],
    ['@a: 1', 'string'],
    [42, 'number'],
    [[], 'array'],
    [{}, 'object'],
    [{ doc: {} }, 'object'],
    [new Map(), 'Map'],
  ])('мусор %j — TypeError с типом', (bad, kind) => {
    expect(() => toJson(bad as never)).toThrow(TypeError)
    expect(() => toJson(bad as never)).toThrow(`toJson: expected Document or NRDocument, got ${kind}`)
  })
})

describe('экспорт', () => {
  it('корень и nrd/format', () => {
    expect(root.toJson).toBe(toJson)
    expect(root.fromJson).toBe(fromJson)
    expect(format.toJson).toBe(toJson)
    expect(format.fromJson).toBe(fromJson)
  })
})
