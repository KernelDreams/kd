// Conformance — last-wins по ленте (format-spec §2.4, §8).
// Канон: повтор $key = переприсваивание, побеждает последний по ленте;
// позиция атрибута в ленте свободна.
import { describe, it, expect } from 'vitest'
import { parse } from '../../src/core/index.js'
import { NRDocument } from '../../src/core/document.js'

describe('conformance: last-wins по ленте (§2.4)', () => {
  it('повтор $key в root — побеждает последний', () => {
    const doc = new NRDocument(parse('$k: first\n$k: second\n$k: third'))
    expect(doc.get(['k'])).toBe('third')
  })

  it('повтор $key внутри блока — побеждает последний', () => {
    const doc = new NRDocument(parse('# $b\n$model: a\n$x: 1\n$model: b'))
    expect(doc.get(['b', 'model'])).toBe('b')
  })

  it('позиция атрибута свободна — после тела, между строфами', () => {
    // Атрибут после строки тела всё равно принадлежит блоку (§2.2).
    const doc = new NRDocument(parse('# $b\n$k: one\nбоди строка\n$k: two'))
    expect(doc.get(['b', 'k'])).toBe('two')
  })

  it('last-wins различает root и блок (разные ленты)', () => {
    const doc = new NRDocument(parse('$k: root-1\n$k: root-2\n# $b\n$k: blk-1\n$k: blk-2'))
    expect(doc.get(['k'])).toBe('root-2')
    expect(doc.get(['b', 'k'])).toBe('blk-2')
  })

  it('одиночный ключ — значение как есть (без коллекции)', () => {
    const doc = new NRDocument(parse('$k: only'))
    expect(doc.get(['k'])).toBe('only')
  })
})
