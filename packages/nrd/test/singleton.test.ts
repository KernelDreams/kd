import { describe, it, expect } from 'vitest'
import { parseDocument } from '../src/core/document.js'
import { resolve } from '../src/core/resolve.js'

describe('singleton auto-unwrap', () => {
  it('${cfg.x} reaches attr of a single block without .at(0)', () => {
    const doc = parseDocument('## $cfg\n$x: 42', { sigil: '$' })
    const result = resolve('value is ${cfg.x}', doc)
    expect(result).toBe('value is 42')
  })

  it('${cfg.x} with multiple blocks uses id lookup', () => {
    const doc = parseDocument('## $cfg first\n$x: 1\n## $cfg second\n$x: 2', { sigil: '$' })
    const result = resolve('${cfg.first.x}', doc)
    expect(result).toBe('1')
  })

  it('singleton unwrap does not fire when id matches', () => {
    const doc = parseDocument('## $item alpha\n$v: A\n## $item beta\n$v: B', { sigil: '$' })
    const result = resolve('${item.beta.v}', doc)
    expect(result).toBe('B')
  })
})
