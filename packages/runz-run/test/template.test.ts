import { describe, expect, it } from 'vitest'
import { asText, objectContext, parseDocument, resolve, resolveValue } from '@kerneldreams/nrd'
import type { IArray } from '@kerneldreams/nrd'
import { materialize, nrdString, valueBlock } from '../src/index.js'

describe('materialize', () => {
  it('блок значений встаёт перед первой секцией; без секций — в конец', () => {
    const t = '$type: comfy\n$prompt: default\n\n## $seed\n1\n'
    expect(materialize(t, { prompt: 'x', seed: 5 })).toBe('$type: comfy\n$prompt: default\n\n$prompt: "x"\n$seed: 5\n\n## $seed\n1\n')
    expect(materialize('$type: comfy\n', { a: true })).toBe('$type: comfy\n\n$a: true\n')
  })

  it('ключ вне NRD-имени — ошибка без префикса пакета', () => {
    expect(() => valueBlock({ 'bad key': 'x' })).toThrow(/^bad template key "bad key"$/)
  })

  it('последнее значение перекрывает дефолт шаблона (last-wins), секции ## не трогаются', () => {
    const t = '$type: vision\n$ref:\n\n## $prompt\nDescribe ${ref}\n## $@\n\n---\n${ref}\n'
    const doc = parseDocument(materialize(t, { ref: '/tmp/a b.png' }), { sigil: '$' })
    expect(asText(doc.get(['ref']))).toBe('/tmp/a b.png')
  })

  it('round-trip через nrd: кавычки, переносы, слэши, Windows-пути, ${ не интерполируется', () => {
    const cases = ['a ${seed} b', 'C:\\x\\y "q"\nline2', 'tab\there', 'plain', '<image1> и <image2>', '']
    for (const s of cases) {
      const doc = parseDocument(`$prompt: ${nrdString(s)}\n$seed: 5\n`)
      const rec: Record<string, unknown> = {}
      for (const a of doc.cast('attrs').iterate()) {
        const v = a.get(['value'])
        rec[a.get(['key']) as string] = asText(v) ?? (v as { get?: (p: string[]) => unknown })?.get?.(['raw'])
      }
      expect(resolve('${prompt}', objectContext(rec))).toBe(s)
    }
  })

  it('список → $[…]: запятая, скобка, кавычка, ${ в элементе — круг через parseDocument даёт те же строки', () => {
    const items = ['a, b', 'c]d [e', 'q"t', 'x ${seed} y', 'C:\\x', 'plain', '']
    const block = valueBlock({ m: items, n: [3, true], e: [] })
    expect(block.split('\n')[1]).toBe('$n: $[3, true]')
    expect(block.split('\n')[2]).toBe('$e: $[]')
    const doc = parseDocument(`${block}\n$seed: 5\n`, { sigil: '$' })
    const back = [...(doc.get(['m']) as IArray).iterate()].map((v) => resolveValue(v as string, doc))
    expect(back).toEqual(items)
    expect([...(doc.get(['n']) as IArray).iterate()]).toEqual([3, true])
    expect([...(doc.get(['e']) as IArray).iterate()]).toEqual([])
  })

  it('скаляры рядом со списком — как раньше', () => {
    expect(valueBlock({ a: 'x', b: 2, c: false })).toBe('$a: "x"\n$b: 2\n$c: false')
  })
})
