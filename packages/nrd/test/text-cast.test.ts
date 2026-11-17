// text-cast-spec §2.1–§2.3 на дереве кодека: тело блока, заголовочный хвост,
// json5-дамп звена и граница «значение → текст».

import { describe, it, expect } from 'vitest'
import { parseDocument } from '../src/core/document.js'
import { resolve, resolveValue } from '../src/core/resolve.js'
import { objectContext } from '../src/core/contexts.js'
import { toText } from '../src/core/icontext.js'
import type { IContext } from '../src/core/icontext.js'

/** Исходник бота в mdd: имя в заголовке, контент — в телах блоков. */
const BOT = [
  '## @name Carly & Rob',
  '',
  '## @personality',
  'тёплая, торопливая',
  '',
  '## @meta',
  '@lang: ru',
  '@nsfw: false',
  '',
  '## @system_prompt',
  '',
].join('\n')

const card = parseDocument(BOT, { sigil: '@' })

describe('текстовая проекция блока (§2.1)', () => {
  it('тело блока доезжает через ${}, а не [object Object]', () => {
    const out = resolve('персона — ${card.personality}', { card })
    expect(out).toBe('персона — тёплая, торопливая')
    expect(out).not.toContain('[object Object]')
  })

  it('блок без тела звучит заголовочным хвостом', () => {
    expect(resolve('${card.name}', { card })).toBe('Carly & Rob')
  })

  it('блок с атрибутами без тела → json5-дамп', () => {
    expect(resolve('${card.meta}', { card })).toBe("{lang: 'ru', nsfw: false}")
  })

  it('пустой блок → пустая строка (паритет с плоским источником)', () => {
    expect(resolve('[${card.system_prompt}]', { card })).toBe('[]')
  })

  it('документ целиком — дамп своих ключей, если тела root нет', () => {
    const dump = String(card)
    expect(dump).not.toContain('[object Object]')
    expect(dump).toContain('personality:')
    expect(dump).toContain("lang: 'ru'")
  })

  it('документ с телом root — тело', () => {
    const doc = parseDocument('$a: 1\n\nтело документа', { sigil: '$' })
    expect(String(doc)).toBe('тело документа')
  })
})

describe('cast(keys) на блоке — самоописание для дампа', () => {
  it('атрибуты + id/name дочерних, порядок документа', () => {
    const meta = card.get(['meta']) as IContext
    expect(toText(meta)).toBe("{lang: 'ru', nsfw: false}")
    // ключ записи — её id, иначе имя блока (прежняя семантика адресации)
    expect(card.cast('keys')).toEqual([
      'Carly & Rob',
      'personality',
      'meta',
      'system_prompt',
    ])
  })

  it('вложенные записи попадают в дамп блока', () => {
    const doc = parseDocument(
      ['## $bot carly', '$lang: ru', '', '### $preset', '$temp: 0.9'].join('\n'),
      { sigil: '$' },
    )
    // `preset` — коллекция записей этого имени, поэтому массив; `carly` —
    // звено с ключами, поэтому дамп, а не заголовочный хвост «carly» (§4.2).
    expect(resolve('${carly}', doc)).toBe("{lang: 'ru', preset: [{temp: 0.9}]}")
  })
})

describe('дерево остаётся деревом (§2.3 — §1.6 NTS-311 не тронут)', () => {
  it('позиция целого значения отдаёт контекст, адресация внутрь работает', () => {
    const whole = resolveValue('${card.meta}', { card })
    expect(typeof whole).toBe('object')
    expect(resolveValue('${card.meta.lang}', { card })).toBe('ru')
    // тот же плейсхолдер внутри строки — уже текст
    expect(resolve('meta: ${card.meta}', { card })).toBe("meta: {lang: 'ru', nsfw: false}")
  })

  it('String() дерева = его интерполяции (§2.2)', () => {
    const whole = resolveValue('${card.personality}', { card }) as IContext
    expect(String(whole)).toBe(resolve('${card.personality}', { card }))
  })
})

describe('коллекция блоков (§3.4 last-wins внутри правила)', () => {
  const doc = parseDocument(
    ['## @greeting', 'первое', '', '## @greeting', 'второе'].join('\n'),
    { sigil: '@' },
  )

  it('в текстовой позиции — последняя запись', () => {
    expect(resolve('${greeting}', doc)).toBe('второе')
    expect(String(doc.get(['greeting']))).toBe('второе')
  })
})

describe('смешанные значения в дампе', () => {
  it('строки, числа и вложенные контексты сериализуются, а не текут', () => {
    // `card.personality` — коллекция блоков этого имени: в СТРУКТУРНОЙ позиции
    // она остаётся коллекцией (массивом), в текстовой звучала бы last-wins.
    const ctx = objectContext({ n: 1, s: 'x', block: card.get(['personality']) })
    expect(toText(ctx)).toBe("{n: 1, s: 'x', block: ['тёплая, торопливая']}")
  })
})
