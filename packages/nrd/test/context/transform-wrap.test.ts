import { describe, it, expect } from 'vitest'
import { objectContext, parseDocument, type IContext } from '../../src/core/index.js'
import { buildContext, wrapContext, type TransformPlugin } from '../../src/context/index.js'

function cfg(...lines: string[]): string {
  return lines.join('\n')
}

// Transform-плагин: добавляет к входу поле `tag` и пробрасывает прочитанное `seen`.
function tagger(seen: { input?: IContext }): TransformPlugin {
  return {
    name: 'tagger',
    async transform(input, attrs) {
      seen.input = input
      return objectContext({ tag: String(attrs['value'] ?? 'tagged'), echo: input.get(['name']) })
    },
  }
}

describe('transform', () => {
  it('$input указан → трансформит конкретный источник', async () => {
    const seen: { input?: IContext } = {}
    const chain = await buildContext(
      cfg(
        '## $source bot',
        '$nr-type: inline',
        '$nr-parse: mdz',
        '$name: Luna',
        '',
        '## $transform t',
        '$nr-type: tagger',
        '$input: bot',
        '$value: hero',
      ),
      { transforms: { tagger: tagger(seen) } },
    )
    // источник bot заменён результатом трансформа
    expect(chain.get(['bot', 'tag'])).toBe('hero')
    expect(chain.get(['bot', 'echo'])).toBe('Luna')
    // на вход пришёл именно raw-контекст источника bot
    expect(seen.input?.get(['name'])).toBe('Luna')
  })

  it('$input не указан → получает весь chain', async () => {
    const seen: { input?: IContext } = {}
    const chain = await buildContext(
      cfg(
        '## $source bot',
        '$nr-type: inline',
        '$nr-parse: mdz',
        '$name: Luna',
        '',
        '## $transform t',
        '$nr-type: tagger',
        '$value: global',
      ),
      { transforms: { tagger: tagger(seen) } },
    )
    // весь chain виден трансформу: name берётся из bot через merge-доступ
    expect(seen.input?.get(['name'])).toBe('Luna')
    expect(seen.input?.get(['bot', 'name'])).toBe('Luna')
    // результат — глобальное звено высшего приоритета
    expect(chain.get(['tag'])).toBe('global')
    expect(chain.get(['echo'])).toBe('Luna')
  })
})

describe('wrapContext', () => {
  const doc = parseDocument(
    [
      '$title: Hello',
      '$count: 3',
      '',
      '## $item a',
      '$label: first',
      '',
      '## $item b',
      '$label: second',
    ].join('\n'),
    { sigil: '$' },
  )

  it('property access', () => {
    const obj = wrapContext(doc) as Record<string, unknown>
    expect(obj.title).toBe('Hello')
    expect(obj.count).toBe(3)
  })

  it('вложенность и массивы', () => {
    const obj = wrapContext(doc) as Record<string, any>
    // коллекция блоков `item` → массив
    expect(Array.isArray(obj.item)).toBe(true)
    expect(obj.item[0].label).toBe('first')
    expect(obj.item[1].label).toBe('second')
  })

  it('Object.keys (ownKeys через cast keys)', () => {
    const obj = wrapContext(doc)
    expect(Object.keys(obj)).toEqual(expect.arrayContaining(['title', 'count']))
  })

  it('Object.keys для objectContext → точный список ключей', () => {
    const obj = wrapContext(objectContext({ a: 1, b: 2 }))
    expect(Object.keys(obj)).toEqual(['a', 'b'])
  })

  it('toString → текст контекста', () => {
    const body = parseDocument('some body text', { sigil: '$' })
    const obj = wrapContext(body)
    expect(String(obj)).toBe('some body text')
  })

  it('has / in оператор', () => {
    const obj = wrapContext(doc)
    expect('title' in obj).toBe(true)
    expect('nope' in obj).toBe(false)
  })
})
