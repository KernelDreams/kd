import { describe, it, expect } from 'vitest'
import { parseDocument } from '../src/core/document.js'
import { resolve } from '../src/core/resolve.js'
import { chainContext, funcContext } from '../src/core/contexts.js'
import type { IArray, IContext } from '../src/core/icontext.js'

describe('NRDocument get routing (§6)', () => {
  const src = [
    '$title: My Doc',
    '$tag: a',
    '$tag: b',
    '',
    '## $char alice',
    '$name: Alice',
    '$mood: happy',
    '',
    '## $char bob',
    '$name: Bob',
  ].join('\n')
  const doc = parseDocument(src)

  it('root attribute', () => {
    expect(doc.get(['title'])).toBe('My Doc')
  })

  it('repeated attribute → collection (last-wins on resolve)', () => {
    expect(resolve('${tag}', doc)).toBe('b')
  })

  it('record by id', () => {
    const alice = doc.get(['alice']) as IContext
    expect(alice.get(['name'])).toBe('Alice')
  })

  it('type collection', () => {
    const chars = doc.get(['char']) as IArray
    expect(chars.length()).toBe(2)
  })

  it('type + id + attr via multi-segment get', () => {
    expect(doc.get(['char', 'bob', 'name'])).toBe('Bob')
  })

  it('resolve path through doc: type.id.attr', () => {
    expect(resolve('${char.alice.mood}', doc)).toBe('happy')
  })

  it('func is undefined; functions come via chain', () => {
    expect(doc.func('x', [])).toBeUndefined()
    const ctx = chainContext(funcContext({ up: (a) => String(a[0]).toUpperCase() }), doc)
    expect(resolve('${up(title)}', ctx)).toBe('MY DOC')
  })
})

describe('NRDocument casts (§6)', () => {
  const src = [
    'Intro line one',
    '# heading decoration',
    '* disabled item',
    'real prompt',
    '',
    'second paragraph',
    '',
    '## $note',
    '$k: v',
  ].join('\n')
  const doc = parseDocument(src)

  it('NRDocument identity cast', () => {
    expect(doc.cast('NRDocument')).toBe(doc)
  })

  it('text — body as-is incl. decoration', () => {
    const text = doc.cast('text') as string
    expect(text).toContain('# heading decoration')
    expect(text).toContain('Intro line one')
  })

  it('raw — original source', () => {
    expect(doc.cast('raw')).toBe(src)
  })

  it('lines — all body lines unfiltered', () => {
    const lines = doc.cast('lines') as IArray
    expect([...lines.iterate()]).toContain('# heading decoration')
    expect([...lines.iterate()]).toContain('* disabled item')
  })

  it('prompts — decoration + blank lines dropped', () => {
    const prompts = doc.cast('prompts') as IArray
    const arr = [...prompts.iterate()]
    expect(arr).toContain('Intro line one')
    expect(arr).toContain('real prompt')
    expect(arr).not.toContain('# heading decoration')
    expect(arr).not.toContain('* disabled item')
  })

  it('records — child blocks (excl. root)', () => {
    const records = doc.cast('records') as IArray
    expect(records.length()).toBe(1)
    const note = records.at(0) as IContext
    expect(note.get(['k'])).toBe('v')
  })

  it('attrs — root attributes as key/value contexts', () => {
    const d2 = parseDocument('$a: 1\n$b: two')
    const attrs = d2.cast('attrs') as IArray
    expect(attrs.length()).toBe(2)
    const first = attrs.at(0) as IContext
    expect(first.get(['key'])).toBe('a')
    expect(first.get(['value'])).toBe(1)
  })

  it('tbl is a stub (undefined for now)', () => {
    expect(doc.cast('tbl')).toBeUndefined()
  })
})

describe('NRDocument + resolver recursion (§3.3)', () => {
  it('attribute reference chain through the document', () => {
    const doc = parseDocument(['$greeting: Hello ${name}', '$name: World'].join('\n'))
    expect(resolve('${greeting}', doc)).toBe('Hello World')
  })

  it('cycle in attributes throws', () => {
    const doc = parseDocument(['$a: ${b}', '$b: ${a}'].join('\n'))
    expect(() => resolve('${a}', doc)).toThrow(/cyclic/)
  })

  it('opt-out attribute stays literal', () => {
    const doc = parseDocument(['$a: \\${x}', '$x: Y'].join('\n'))
    expect(resolve('${a}', doc)).toBe('${x}')
  })
})
