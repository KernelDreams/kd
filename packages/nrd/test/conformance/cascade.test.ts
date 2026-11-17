// Conformance — каскад блоков (format-spec §8).
// Канон: повтор блока по id → last-wins; коллекция по name; смешанно (часть с
// id, часть без) — валидная коллекция. Фиксирует getAttr / resolveName /
// resolveBlockName исполняемо.
import { describe, it, expect } from 'vitest'
import { parseDocument, asText, isArray } from '../../src/core/index.js'

describe('conformance: каскад блоков (§8)', () => {
  it('повтор блока по id в root → последний побеждает целиком', () => {
    const doc = parseDocument(
      ['## $provider main', '$url: a', '$only1: x', '## $provider main', '$url: b'].join('\n'),
    )
    // last-wins: последний блок, атрибуты первого невидимы (нет merge).
    expect(asText(doc.get(['provider', 'main', 'url']))).toBe('b')
    expect(doc.get(['provider', 'main', 'only1'])).toBeUndefined()
  })

  it('id-less повтор блока → скалярный путь делегирует последнему', () => {
    const doc = parseDocument(['## $cfg', '$x: 1', '## $cfg', '$x: 2'].join('\n'))
    expect(doc.get(['cfg', 'x'])).toBe(2)
  })

  it('коллекция по name → все элементы сохранены (array access)', () => {
    const doc = parseDocument(['## $item', '$v: 1', '## $item', '$v: 2', '## $item', '$v: 3'].join('\n'))
    const coll = doc.get(['item'])
    expect(isArray(coll)).toBe(true)
    expect((coll as any).length()).toBe(3)
    expect((coll as any).at(2).get(['v'])).toBe(3)
  })

  it('смешанно (часть с id, часть без) — валидная коллекция', () => {
    const doc = parseDocument(['## $item one', '$v: 1', '## $item', '$v: 2'].join('\n'))
    const coll = doc.get(['item'])
    expect(isArray(coll)).toBe(true)
    expect((coll as any).length()).toBe(2)
    // адресация по id находит именованный
    expect(asText(doc.get(['item', 'one', 'v']))).toBe('1')
  })

  it('вложенный каскад: id-lookup внутри блока берёт последний (resolveBlockName)', () => {
    const doc = parseDocument(
      ['## $server main', '### $route api', '$path: /v1', '### $route api', '$path: /v2'].join('\n'),
    )
    expect(asText(doc.get(['server', 'main', 'route', 'api', 'path']))).toBe('/v2')
  })

  it('getAttr на уровне блока — повтор ключа last-wins', () => {
    const doc = parseDocument(['## $b', '$k: one', '$k: two'].join('\n'))
    expect(doc.get(['b', 'k'])).toBe('two')
  })
})
