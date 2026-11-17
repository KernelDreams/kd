import { describe, it, expect } from 'vitest'
import { scanPlaceholders, parseExpr } from '../../../src/contracts/eval/placeholder.js'

describe('${} recognition (§7)', () => {
  it('finds simple path placeholder', () => {
    const ph = scanPlaceholders('hello ${name}')
    expect(ph).toHaveLength(1)
    expect(ph[0].raw).toBe('name')
    expect(ph[0].start).toBe(6)
    expect(ph[0].end).toBe(13)
    expect(ph[0].expr).toEqual({
      kind: 'path',
      segments: [{ kind: 'name', value: 'name' }],
    })
  })

  it('parses dotted path with numeric index', () => {
    const ph = scanPlaceholders('${a.b.0}')
    expect(ph[0].expr).toEqual({
      kind: 'path',
      segments: [
        { kind: 'name', value: 'a' },
        { kind: 'name', value: 'b' },
        { kind: 'index', value: 0 },
      ],
    })
  })

  it('parses call expression', () => {
    const ph = scanPlaceholders('${fn(a, b, "c")}')
    expect(ph[0].expr).toEqual({
      kind: 'call',
      name: 'fn',
      args: [
        { kind: 'path', segments: [{ kind: 'name', value: 'a' }] },
        { kind: 'path', segments: [{ kind: 'name', value: 'b' }] },
        { kind: 'literal', value: 'c' },
      ],
    })
  })

  it('parses call with numeric/bool/null literals', () => {
    const ph = scanPlaceholders('${fn(1, 2.5, true, false, null)}')
    expect(ph[0].expr).toEqual({
      kind: 'call',
      name: 'fn',
      args: [
        { kind: 'literal', value: 1 },
        { kind: 'literal', value: 2.5 },
        { kind: 'literal', value: true },
        { kind: 'literal', value: false },
        { kind: 'literal', value: null },
      ],
    })
  })

  it('supports nested ${} in path segment', () => {
    const ph = scanPlaceholders('${a.${b}}')
    const expr = ph[0].expr
    expect(expr.kind).toBe('path')
    if (expr.kind === 'path') {
      expect(expr.segments[0]).toEqual({ kind: 'name', value: 'a' })
      expect(expr.segments[1].kind).toBe('placeholder')
      if (expr.segments[1].kind === 'placeholder') {
        expect(expr.segments[1].value.raw).toBe('b')
      }
    }
  })

  it('supports nested ${} as call argument', () => {
    const ph = scanPlaceholders('${fn(${x})}')
    expect(ph[0].expr).toMatchObject({
      kind: 'call',
      name: 'fn',
      args: [
        {
          kind: 'placeholder',
          value: {
            raw: 'x',
            expr: { kind: 'path', segments: [{ kind: 'name', value: 'x' }] },
          },
        },
      ],
    })
  })

  it('treats \\${ as literal — no placeholder', () => {
    const ph = scanPlaceholders('hello \\${world}')
    expect(ph).toEqual([])
  })

  it('mixes literal \\${ with real ${}', () => {
    const ph = scanPlaceholders('a \\${lit} b ${real}')
    expect(ph).toHaveLength(1)
    expect(ph[0].raw).toBe('real')
  })

  it('finds multiple placeholders in order', () => {
    const ph = scanPlaceholders('${a} and ${b}')
    expect(ph.map((p) => p.raw)).toEqual(['a', 'b'])
  })

  it('\\. escape inside ${} produces literal dot in segment', () => {
    const ph = scanPlaceholders('${site\\.ru}')
    expect(ph[0].expr).toEqual({
      kind: 'path',
      segments: [{ kind: 'name', value: 'site.ru' }],
    })
  })

  it('exposes parseExpr directly', () => {
    expect(parseExpr('a.b').kind).toBe('path')
    expect(parseExpr('f(x)').kind).toBe('call')
  })

  it('bare braces outside ${} are plain text (§7.1: grammar has no bare braces)', () => {
    const ph = scanPlaceholders('a ${ref} b {unrelated} c')
    expect(ph.map((p) => p.raw)).toEqual(['ref'])
  })

  it('strings inside call args support escapes', () => {
    const ph = scanPlaceholders('${fn("a\\nb")}')
    expect(ph[0].expr).toMatchObject({
      kind: 'call',
      name: 'fn',
      args: [{ kind: 'literal', value: 'a\nb' }],
    })
  })
})
