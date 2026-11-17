// text-cast-spec §2.1–§2.2: единое правило приведения к тексту.

import { describe, it, expect } from 'vitest'
import { toText, textView, asText } from '../../src/contracts/text.js'
import { objectContext, arrayValue, chainContext, emptyContext } from '../../src/contracts/eval/contexts.js'
import { resolve, resolveValue } from '../../src/contracts/eval/resolve.js'
import type { IContext, Segment, Value } from '../../src/contracts/context.js'

/** Звено кодека в миниатюре: тело + заголовочный хвост + свои ключи. */
function node(o: {
  text?: string
  id?: string
  keys?: Record<string, Value>
}): IContext {
  const keys = o.keys ?? {}
  return {
    get: (p: Segment[]) => (p.length === 1 ? keys[String(p[0])] : undefined),
    func: () => undefined,
    cast(name: string): any {
      if (name === 'text') return o.text ?? ''
      if (name === 'id') return o.id
      if (name === 'keys') return Object.keys(keys)
      return undefined
    },
  }
}

describe('textView — текстовая проекция звена (§2.1)', () => {
  it('тело', () => {
    expect(textView(node({ text: 'проза' }))).toBe('проза')
  })

  it('тела нет — заголовочный хвост', () => {
    expect(textView(node({ text: '', id: 'Carly & Rob' }))).toBe('Carly & Rob')
  })

  it('тело сильнее заголовка', () => {
    expect(textView(node({ text: 'проза', id: 'заголовок' }))).toBe('проза')
  })

  it('ни того, ни другого — текста нет', () => {
    expect(textView(node({ text: '', keys: { a: 1 } }))).toBeUndefined()
  })
})

describe('toText — текст, иначе json5 (§2.1)', () => {
  it('скаляры', () => {
    expect(toText('hi')).toBe('hi')
    expect(toText(0)).toBe('0')
    expect(toText(true)).toBe('true')
    expect(toText(null)).toBeUndefined()
    expect(toText(undefined)).toBeUndefined()
  })

  it('InterpolatedValue → raw', () => {
    expect(toText({ raw: 'a ${b}', placeholders: [] })).toBe('a ${b}')
  })

  it('звено с телом → тело; без тела, но с ключами → дамп', () => {
    expect(toText(node({ text: 'проза' }))).toBe('проза')
    expect(toText(node({ text: '', keys: { lang: 'ru', nsfw: false } }))).toBe(
      "{lang: 'ru', nsfw: false}",
    )
  })

  it('пустое звено — пустая строка, не {}', () => {
    expect(toText(node({ text: '' }))).toBe('')
  })

  it('objectContext без текстовой проекции → дамп своих ключей', () => {
    expect(toText(objectContext({ a: 1, b: 'x' }))).toBe("{a: 1, b: 'x'}")
  })

  it('вложенное звено внутри дампа — своим текстом', () => {
    const ctx = objectContext({ persona: node({ text: 'проза' }), lang: 'ru' })
    expect(toText(ctx)).toBe("{persona: 'проза', lang: 'ru'}")
  })

  it('коллекция в текстовой позиции — last-wins (§3.4)', () => {
    expect(toText(arrayValue(['a', 'b']))).toBe('b')
    expect(toText(arrayValue([node({ text: '', id: 'Carly & Rob' })]))).toBe('Carly & Rob')
  })

  it('ChainContext — дамп объединённых ключей', () => {
    const ctx = chainContext(objectContext({ a: 1 }), objectContext({ b: 2 }))
    expect(toText(ctx)).toBe('{a: 1, b: 2}')
    expect(toText(emptyContext)).toBe('{}')
  })

  it('не значение формата (Map/Set) — текста нет, а не TypeError', () => {
    expect(toText(new Map([['k', 1]]))).toBeUndefined()
    expect(toText(new Set([1]))).toBeUndefined()
  })

  it('цикл не вешает обход', () => {
    const self: Record<string, Value> = { name: 'x' }
    self.me = objectContext(self)
    expect(toText(objectContext(self))).toBe("{name: 'x', me: {name: 'x'}}")
  })

  it('хук expand доезжает до листьев ДО сериализации', () => {
    const ctx = objectContext({ greet: 'привет ${who}' })
    expect(toText(ctx, { expand: (s) => s.replace('${who}', 'мир') })).toBe("{greet: 'привет мир'}")
  })
})

describe('toString на контекстах (§2.2)', () => {
  it('String() совпадает с интерполяцией', () => {
    const bot = objectContext({ name: 'Carly', lang: 'ru' })
    const viaCode = String(bot)
    const viaTpl = resolve('${bot}', { bot })
    expect(viaCode).toBe("{name: 'Carly', lang: 'ru'}")
    expect(viaTpl).toBe(viaCode)
  })

  it('конкатенация не даёт [object Object]', () => {
    const s = 'бот: ' + objectContext({ a: 1 })
    expect(s).toBe('бот: {a: 1}')
    expect(s).not.toContain('[object Object]')
  })

  it('звено с телом печатается телом', () => {
    expect(String(objectContext({ x: 1 }))).not.toContain('[object Object]')
    expect(`${arrayValue(['a', 'b'])}`).toBe('b')
  })
})

describe('дерево остаётся деревом (§2.3, §1.6 NTS-311)', () => {
  it('целое значение — контекст, он же в строке — текст', () => {
    const card = objectContext({ personality: node({ text: 'проза', keys: { lang: 'ru' } }) })
    const whole = resolveValue('${card.personality}', { card })
    expect(typeof whole).toBe('object')
    expect((whole as IContext).get(['lang'])).toBe('ru')
    expect(resolve('персона — ${card.personality}', { card })).toBe('персона — проза')
  })
})

describe('нерезолвленный плейсхолдер (§2.4)', () => {
  it('lenient — литерал, strict — ошибка', () => {
    const ctx = objectContext({ a: 1 })
    expect(resolve('${missing}', ctx)).toBe('${missing}')
    expect(() => resolve('${missing}', ctx, { mode: 'strict' })).toThrow(/missing/)
    expect(() => resolveValue('${missing}', ctx, { mode: 'strict' })).toThrow(/missing/)
  })
})

// ── регресс-fix: asText — сужающий аксессор, НЕ коэрсия ──────────────
// Прикладной код (426 вызовов в 91 файле) использует undefined как признак
// «это не текст»: asText(a) ?? asText(b), if (!asText(x)). Дамп здесь ломал
// маршрутизацию провайдеров в translate и утекал api_key из блоков конфига.
describe('asText — сужающий контракт', () => {
  it('скаляры и InterpolatedValue — как есть', () => {
    expect(asText('текст')).toBe('текст')
    expect(asText(42)).toBe('42')
    expect(asText(true)).toBe('true')
  })

  it('контейнер без текстовой проекции → undefined, НЕ дамп', () => {
    const ctx = objectContext({ api_key: 'sk-SECRET', base_url: 'https://x' })
    expect(asText(ctx)).toBeUndefined()
  })

  it('секрет из контейнера не утекает в текст', () => {
    const ctx = objectContext({ provider: objectContext({ api_key: 'sk-SECRET' }) })
    expect(String(asText(ctx.get(['provider'])) ?? '')).not.toContain('SECRET')
  })

  it('undefined/null → undefined', () => {
    expect(asText(undefined)).toBeUndefined()
    expect(asText(null)).toBeUndefined()
  })

  it('toText на том же контейнере даёт дамп (правило §2.1 на месте)', () => {
    const ctx = objectContext({ a: 1 })
    expect(toText(ctx)).toBe("{a: 1}")
  })
})
