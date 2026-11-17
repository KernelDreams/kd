// Conformance — quote-семантика (format-spec §3, уточнение B2).
// Канон: "..." имеет силу ТОЛЬКО в позиции скаляр-литерала (значение атрибута
// целиком, аргумент выражения). В произвольном тексте кавычка — просто символ,
// и ${} внутри неё резолвится.
import { describe, it, expect } from 'vitest'
import { parse } from '../../src/core/index.js'
import { serialize } from '../../src/core/index.js'
import { resolve } from '../../src/core/resolve.js'
import { chainContext, funcContext, objectContext } from '../../src/core/contexts.js'

describe('conformance: quote-семантика (§3 / B2)', () => {
  it('кавычки форсируют строку в позиции значения атрибута', () => {
    const doc = parse('# $b\n$k: "42"')
    expect(doc.root.children[0].attrs[0].value).toBe('42') // строка, не число
  })

  it('полностью-quoted значение атрибута с ${} — литерал (скаляр-литерал)', () => {
    // Всё значение = один quoted-скаляр → ${x} внутри литерален, не плейсхолдер.
    const doc = parse('# $b\n$k: "${x}"')
    expect(doc.root.children[0].attrs[0].value).toBe('${x}')
  })

  it('строковый аргумент выражения — кавычки снимаются, содержимое литерально', () => {
    const ctx = chainContext(
      funcContext({ up: (args) => String(args[0]).toUpperCase() }),
      objectContext({}),
    )
    // "lit" — строковый литерал-аргумент: кавычки = грамматика в parseArgs.
    expect(resolve('${up("lit")}', ctx)).toBe('LIT')
  })

  // Живой инцидент 07.07: ${} внутри кавычек в ПРОИЗВОЛЬНОМ тексте (JSON) должен
  // резолвиться — кавычка там не скаляр-литерал, а обычный символ.
  it('B2: ${} внутри кавычек в произвольном тексте резолвится', () => {
    expect(
      resolve('{"model": "${model}", "no_think": ${think}}', { model: 'x', think: false }),
    ).toBe('{"model": "x", "no_think": false}')
  })

  it('B2: одиночный ${} в кавычках посреди прозы резолвится', () => {
    expect(resolve('он сказал "${word}" вслух', { word: 'да' })).toBe('он сказал "да" вслух')
  })

  // §2: coerce срезал крайние кавычки без учёта позиции закрывающей —
  // частично-кавыченное значение калечилось (`"yes" or "no"` → `yes" or "no`).
  it('частично-кавыченное значение атрибута — verbatim', () => {
    const doc = parse('$msg: "yes" or "no"')
    expect(doc.root.attrs[0].value).toBe('"yes" or "no"')
  })

  it('частично-кавыченный элемент flow — verbatim', () => {
    const doc = parse('$xs: $["yes" or "no", "quoted"]')
    expect(doc.root.attrs[0].value).toEqual(['"yes" or "no"', 'quoted'])
  })

  it('round-trip: parse → serialize → parse сохраняет частичные кавычки', () => {
    const src = '$msg: "yes" or "no"'
    const doc = parse(src)
    const out = serialize(doc)
    expect(parse(out).root.attrs[0].value).toBe('"yes" or "no"')
    // и повторная сериализация идемпотентна
    expect(serialize(parse(out))).toBe(out)
  })
})
