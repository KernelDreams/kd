// detect — перенос rz/test/detect.test.ts (rz-merge §3.3): только декларация,
// никогда снифф содержимого.
import { describe, it, expect } from 'vitest'
import { detectKind } from '../../src/node/program.js'
import { isInputKind, sigilOf } from '../../src/program/program.js'

describe('detectKind — расширение и явная декларация', () => {
  it('расширение решает вид входа', () => {
    expect(detectKind('a/b/pipeline.mdz')).toBe('mdz')
    expect(detectKind('notes.md')).toBe('mdz')
    expect(detectKind('card.mdd')).toBe('mdd')
    expect(detectKind('run.mds')).toBe('mds')
  })

  it('регистр расширения не важен', () => {
    expect(detectKind('RUN.MDS')).toBe('mds')
  })

  it('явная декларация сильнее расширения', () => {
    expect(detectKind('run.txt', 'mds')).toBe('mds')
    expect(detectKind('run.mds', 'mdz')).toBe('mdz')
  })

  it('пустая явная декларация не мешает расширению', () => {
    expect(detectKind('run.mds', '')).toBe('mds')
    expect(detectKind('run.mds', undefined)).toBe('mds')
  })

  it('неизвестный тип файла — громкая ошибка, не дефолт', () => {
    expect(() => detectKind('data.json')).toThrow(/неизвестный тип файла/)
    expect(() => detectKind('README')).toThrow(/неизвестный тип файла/)
  })

  it('неизвестная явная декларация — громкая ошибка', () => {
    expect(() => detectKind('run.mds', 'ccv3')).toThrow(/неизвестный вид входа/)
  })

  it('сигил по виду входа', () => {
    expect(sigilOf('mdz')).toBe('$')
    expect(sigilOf('mdd')).toBe('@')
    expect(sigilOf('mds')).toBe('$')
  })

  it('isInputKind — предикат закрытого набора', () => {
    expect(isInputKind('mds')).toBe(true)
    expect(isInputKind('toon')).toBe(false)
  })
})
