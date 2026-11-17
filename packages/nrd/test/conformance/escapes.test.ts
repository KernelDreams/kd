// Conformance — эскейпы (format-spec §2.5, §3.1, §7.1).
// Канон: \$key: в начале строки тела = литерал; \${ = литеральный ${ (один
// разворот); \. в путях внутри ${}.
import { describe, it, expect } from 'vitest'
import { parse } from '../../src/core/index.js'
import { NRDocument } from '../../src/core/document.js'
import { resolve } from '../../src/core/resolve.js'
import { scanPlaceholders } from '../../src/core/placeholder.js'

describe('conformance: эскейпы (§2.5)', () => {
  it('\\$key: в начале строки тела — литерал, не атрибут', () => {
    // `\$key: value` в теле блока → строка `$key: value`, ключ не появляется.
    const doc = new NRDocument(parse('# $b\n\\$key: value'))
    const block = doc.doc.root.children[0]
    expect(block.attrs).toEqual([]) // не распознан как атрибут
    const body = typeof block.body === 'string' ? block.body : (block.body as any)?.raw
    expect(body).toBe('$key: value') // \$ развёрнут ровно один раз
  })

  it('\\@name в начале строки тела — литерал', () => {
    const doc = new NRDocument(parse('# $b\n\\@name still text'))
    const block = doc.doc.root.children[0]
    const body = typeof block.body === 'string' ? block.body : (block.body as any)?.raw
    expect(body).toBe('@name still text')
  })

  it('\\${ разворачивается ровно один раз (§3.1)', () => {
    // \ $ { x } → ${x}, плейсхолдер НЕ резолвится.
    expect(resolve('\\${x}', { x: 'Y' })).toBe('${x}')
  })

  it('\\${ opt-out держится сквозь рекурсию (значение с плейсхолдером)', () => {
    const ctx = { a: '\\${x}', x: 'Y' }
    expect(resolve('${a}', ctx)).toBe('${x}')
  })

  it('экранированный обратный слеш перед живым плейсхолдером — не opt-out', () => {
    // \ \ $ { x } → литеральный \ + разрешённый x.
    expect(resolve('\\\\${x}', { x: 'Y' })).toBe('\\\\Y')
  })

  it('\\. в сегменте пути внутри ${} → литеральная точка (§7.1)', () => {
    const ph = scanPlaceholders('${site\\.ru}')
    expect(ph[0].expr).toEqual({
      kind: 'path',
      segments: [{ kind: 'name', value: 'site.ru' }],
    })
  })

  it('\\. адресует ключ с точкой при резолве', () => {
    const doc = new NRDocument(parse('# $b\n$site.ru: hit'))
    // потребитель резолвит об документ; ключ с точкой достаётся через \.
    expect(resolve('${b.site\\.ru}', doc)).toBe('hit')
  })
})
