// Conformance — $nr-extends прозрачен в ШТАТНОМ лукапе (nr-extends-transparent-spec §1/§4/§5).
// Ключевое отличие от self-extends.test.ts: здесь всё через doc.get(...) / resolve(),
// а НЕ через resolveBlockValue/blockSelf (explicit-API).
import { describe, it, expect } from 'vitest'
import { parseDocument } from '../../src/core/document.js'
import type { ExtendsLoader } from '../../src/core/document.js'
import { resolve } from '../../src/core/resolve.js'
import { chainContext, funcContext } from '../../src/core/contexts.js'
import { coreFunctions } from '../../src/core/functions.js'

const FILES: Record<string, string> = {
  'base.mdz': ['$model: default-model', '$think: false', '$temp: 0.7'].join('\n'),
  // Цепочка: mid наследует base и переопределяет model.
  'mid.mdz': ['$nr-extends: base.mdz', '$model: mid-model'].join('\n'),
  // Циклы.
  'cyc-a.mdz': ['$nr-extends: cyc-b.mdz', '$x: a'].join('\n'),
  'cyc-b.mdz': ['$nr-extends: cyc-a.mdz', '$y: b'].join('\n'),
  // База с телом (наследование тела блоком без своего тела).
  'body.mdz': ['$model: m', '', 'Тело базы.'].join('\n'),
}

const load: ExtendsLoader = (path) => {
  const text = FILES[path]
  if (text === undefined) throw new Error(`no such file: ${path}`)
  return text
}

const DOC = [
  '## $preset fast',
  '$nr-extends: base.mdz',
  '$model: gpt', // оверрайд базы
  '## $@',
].join('\n')

describe('conformance: $nr-extends — прозрачность штатного лукапа (§1)', () => {
  it('own-wins: свой атрибут бьёт базу', () => {
    const doc = parseDocument(DOC, undefined, load)
    expect(doc.get(['preset', 'fast', 'model'])).toBe('gpt')
  })

  it('база = дефолты: не переопределённый ключ проваливается в базу', () => {
    const doc = parseDocument(DOC, undefined, load)
    expect(doc.get(['preset', 'fast', 'think'])).toBe(false)
    expect(doc.get(['preset', 'fast', 'temp'])).toBe(0.7)
  })

  it('ключа нет ни в own, ни в базе → undefined (не ошибка)', () => {
    const doc = parseDocument(DOC, undefined, load)
    expect(doc.get(['preset', 'fast', 'nope'])).toBeUndefined()
  })

  it('$nr-extends остаётся видимым атрибутом (dry/debug)', () => {
    const doc = parseDocument(DOC, undefined, load)
    expect(doc.get(['preset', 'fast', 'nr-extends'])).toBe('base.mdz')
  })

  it('через ${}-резолв об документ — путь видит унаследованное', () => {
    const doc = parseDocument(DOC, undefined, load)
    const scope = chainContext(doc, funcContext(coreFunctions))
    expect(resolve('${preset.fast.model}/${preset.fast.temp}', scope, { mode: 'lenient' })).toBe(
      'gpt/0.7',
    )
  })

  it('наследуют ЛЮБЫЕ блочные данные, не только пресеты (эндпоинт, нода)', () => {
    const text = ['## $node n1', '$nr-extends: base.mdz', '## $@'].join('\n')
    const doc = parseDocument(text, undefined, load)
    expect(doc.get(['node', 'n1', 'model'])).toBe('default-model')
  })

  it('вложенный блок наследует (не только дети root)', () => {
    const text = [
      '## $group g',
      '### $preset inner',
      '$nr-extends: base.mdz',
      '$model: inner-model',
    ].join('\n')
    const doc = parseDocument(text, undefined, load)
    expect(doc.get(['g', 'inner', 'model'])).toBe('inner-model') // own
    expect(doc.get(['g', 'inner', 'think'])).toBe(false) // база
  })

  it('коллекция: элемент по индексу/итерации тоже наследует', () => {
    const text = ['## $preset a', '$nr-extends: base.mdz', '## $preset b', '$model: own'].join('\n')
    const doc = parseDocument(text, undefined, load)
    const coll = doc.get(['preset']) as any
    expect(coll.at(0).get(['temp'])).toBe(0.7) // из базы
    expect(coll.iterate()[1].get(['model'])).toBe('own')
  })

  it('цепочка extends: наследник → mid → base', () => {
    const text = ['## $preset p', '$nr-extends: mid.mdz', '$think: true'].join('\n')
    const doc = parseDocument(text, undefined, load)
    expect(doc.get(['preset', 'p', 'think'])).toBe(true) // own
    expect(doc.get(['preset', 'p', 'model'])).toBe('mid-model') // mid бьёт base
    expect(doc.get(['preset', 'p', 'temp'])).toBe(0.7) // из base через mid
  })

  it('цикл в цепочке extends → ошибка, не зависание', () => {
    const text = ['## $preset p', '$nr-extends: cyc-a.mdz'].join('\n')
    const doc = parseDocument(text, undefined, load)
    expect(() => doc.get(['preset', 'p', 'zzz'])).toThrow(/цикл/)
  })

  it('тело наследуется, если своего нет; своё тело бьёт базу', () => {
    const text = [
      '## $preset heir',
      '$nr-extends: body.mdz',
      '## $preset own-body',
      '$nr-extends: body.mdz',
      '',
      'Своё тело.',
    ].join('\n')
    const doc = parseDocument(text, undefined, load)
    const heir = doc.get(['heir']) as any
    const ownBody = doc.get(['own-body']) as any
    expect(heir.cast('text').trim()).toBe('Тело базы.')
    expect(ownBody.cast('text').trim()).toBe('Своё тело.')
  })

  it('база грузится лениво: own-ключ читается без обращения к загрузчику', () => {
    let calls = 0
    const counting: ExtendsLoader = (p) => {
      calls++
      return load(p)
    }
    const doc = parseDocument(DOC, undefined, counting)
    expect(doc.get(['preset', 'fast', 'model'])).toBe('gpt')
    expect(calls).toBe(0) // own ответил — IO не понадобилось
    expect(doc.get(['preset', 'fast', 'think'])).toBe(false)
    expect(calls).toBe(1)
  })
})

describe('conformance: $nr-extends — untrusted / fail loud (§4, §5)', () => {
  it('загрузчик не передан → чтение унаследованного ключа = ошибка, не тишина', () => {
    const doc = parseDocument(DOC) // untrusted: load не передан
    expect(() => doc.get(['preset', 'fast', 'think'])).toThrow(/загрузчик не передан/)
  })

  it('загрузчик не передан → own-ключи и сам $nr-extends читаются как обычно', () => {
    const doc = parseDocument(DOC)
    expect(doc.get(['preset', 'fast', 'model'])).toBe('gpt')
    expect(doc.get(['preset', 'fast', 'nr-extends'])).toBe('base.mdz')
  })

  it('чужой документ с абсолютным путём файл не читает (нет загрузчика — нет IO)', () => {
    const text = ['## $preset evil', '$nr-extends: C:/secret/keys.mdz'].join('\n')
    const doc = parseDocument(text)
    expect(() => doc.get(['preset', 'evil', 'api_key'])).toThrow(/загрузчик не передан/)
  })

  it('битый/отсутствующий файл базы → fail loud', () => {
    const text = ['## $preset p', '$nr-extends: missing.mdz'].join('\n')
    const doc = parseDocument(text, undefined, load)
    expect(() => doc.get(['preset', 'p', 'x'])).toThrow(/nr-extends/)
  })
})
