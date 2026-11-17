// Cascade semantics — format-spec §8: concatenation + last-wins.
// Any block group is a collection; scalar access = LAST element; array access = all.
import { describe, it, expect } from 'vitest'
import { parseDocument, resolve, asText, isArray } from '../src/core/index.ts'

const layerGlobal = [
  '$model: base',
  '',
  '## $provider main',
  '$url: http://global',
  '$secret: only-in-global',
  '',
  '## $config',
  '$debug: false',
].join('\n')

const layerUser = [
  '$model: user-override',
  '',
  '## $provider main',
  '$url: http://user',
  '$key: added-by-user',
  '',
  '## $config',
  '$debug: true',
].join('\n')

// Layers are joined with an explicit block-close `## $@`: without it, the upper
// layer's root attrs would attach to the lower layer's last open block (§2.2).
const stacked = layerGlobal + '\n\n## $@\n\n' + layerUser + '\n'

describe('cascade §8: last-wins', () => {
  const doc = parseDocument(stacked, { sigil: '$' })

  it('attr repeat → last value', () => {
    expect(asText(doc.get(['model']))).toBe('user-override')
  })

  it('block (name+id) repeat → LAST block wins entirely', () => {
    expect(asText(doc.get(['provider', 'main', 'url']))).toBe('http://user')
    expect(asText(doc.get(['provider', 'main', 'key']))).toBe('added-by-user')
  })

  it('no attr merge: first block attrs invisible after override', () => {
    expect(doc.get(['provider', 'main', 'secret'])).toBeUndefined()
  })

  it('id-less block repeat → scalar path delegates to LAST element', () => {
    expect(asText(doc.get(['config', 'debug']))).toBe('true')
  })

  it('array access preserves ALL elements (collection intact)', () => {
    const coll = doc.get(['provider'])
    expect(isArray(coll)).toBe(true)
    expect((coll as any).length()).toBe(2)
    expect(asText((coll as any).at(0).get(['url']))).toBe('http://global')
    expect(asText((coll as any).at(1).get(['url']))).toBe('http://user')
  })

  it('positional index untouched', () => {
    expect(asText(doc.get(['provider', 0, 'url']))).toBe('http://global')
  })

  it('resolve ${} follows cascade (last)', async () => {
    const out = await resolve('${provider.main.url} / ${model}', doc)
    expect(out).toBe('http://user / user-override')
  })

  it('nested children: id-lookup inside a block takes last', () => {
    const nested = [
      '## $server main',
      '### $route api',
      '$path: /v1',
      '### $route api',
      '$path: /v2',
    ].join('\n')
    const d = parseDocument(nested, { sigil: '$' })
    expect(asText(d.get(['server', 'main', 'route', 'api', 'path']))).toBe('/v2')
  })

  it('singleton unchanged: single block scalar path still unwraps', () => {
    const d = parseDocument('## $cfg\n$x: 1\n', { sigil: '$' })
    expect(d.get(['cfg', 'x'])).toBe(1)
  })
})
