/**
 * Раскладка кубиков в сессии: платформа играет раскладку напрямую — куски ложатся на блоки бота `nr`
 * (справочник наверху, форма в хвосте, гритинги), «каждый N-й ход» — заметкой, событие — записью лорбука `once`
 * со сроком; всё ходовое — после истории.
 */
import { describe, expect, it } from 'vitest'
import { botTypeOf, chatNotes, layoutOf, layoutParts, nrBotFields } from '../src/assembly/index.js'
import { loreBooks, selectLoreV2, type LorePin } from '../src/assembly/lore-v2.js'
import type { Message } from '../src/model.js'

const LAYOUT = {
  builder: 'gemma',
  pieces: [
    { id: 'card-bree', text: '# Бри\nf | 21', place: 'top', when: { kind: 'start' }, from: ['trio/bree'] },
    { id: 'scenario', text: 'Сейчас: договор работает', place: 'top', when: { kind: 'start' } },
    { id: 'core', text: 'Ядро формы: Бри — громкая', place: 'tail', when: { kind: 'turn' } },
    { id: 'nudge', text: 'Напомни о погоде', place: 'tail', when: { kind: 'every', every: 3 } },
    { id: 'lore-codex', text: 'Кодекс: как это телесно', place: 'tail', when: { kind: 'event', event: 'lore', turns: 3, keys: ['лиж'] }, title: 'codex' },
    { id: 'greeting-g1-1', text: 'Привет!', place: 'greeting', when: { kind: 'start' } },
    { id: 'greeting-g1-2', text: 'Здравствуй.', place: 'greeting', when: { kind: 'start' } },
    { id: 'persona-me', text: 'игрок', place: 'persona', when: { kind: 'start' } },
  ],
}
const card = { name: 'Tumbleweed', extensions: { nrchat: { layout: LAYOUT } } }

const msg = (id: string, role: 'user' | 'assistant', text: string): Message => ({ id, role, parts: [{ type: 'text', text }] })

describe('раскладка кубиков (ABC-838)', () => {
  it('карта с раскладкой — бот nr: справочник наверху, форма в хвосте, гритинги свайпами, персона не идёт', () => {
    expect(layoutOf(card)?.pieces).toHaveLength(8)
    expect(botTypeOf(card)).toBe('nr')
    const f = nrBotFields(card)
    expect(f.reference).toBe('# Бри\nf | 21\n\nСейчас: договор работает')
    expect(f.form).toBe('Ядро формы: Бри — громкая')
    expect(f.greetings.map((g) => g.text)).toEqual(['Привет!', 'Здравствуй.'])
    expect(f.reference + f.form).not.toContain('игрок')
  })

  it('каждый N-й ход — заметка «этот бот» в хвосте раз в N ходов игрока', () => {
    const path = (n: number): Message[] => Array.from({ length: n }, (_, i) => msg(`u${i}`, 'user', 'ход'))
    expect(chatNotes({ meta: {}, card, agent: {}, path: path(2) }).map((n) => n.text)).toEqual([])
    expect(chatNotes({ meta: {}, card, agent: {}, path: path(3) }).map((n) => [n.text, n.slot, n.scope])).toEqual([['Напомни о погоде', 'tail', 'bot']])
  })

  it('событие на 3 хода: появляется на ходу с ключом, держится ещё два хода игрока и уходит', () => {
    const parts = layoutParts(layoutOf(card)!)
    expect(parts.book?.entries).toHaveLength(1)
    const books = loreBooks({ chars: [{ id: 'bot', card }] })
    expect(books.map((b) => b.id)).toContain('layout:bot')
    // История: ход игрока с ключом — i, потом ответы и ходы без ключа.
    const turns = ['привет', 'ну и?', 'он лижет её', 'дальше', 'ещё', 'и ещё', 'конец']
    const pins: Record<number, LorePin[]> = {}
    const shown: boolean[] = []
    for (let t = 0; t < turns.length; t++) {
      const history = turns.slice(0, t + 1).flatMap((txt, i) => {
        const u = { id: `u${i}`, role: 'user' as const, text: txt, ...(pins[i] ? { once: pins[i] } : {}) }
        return i < t ? [u, { id: `a${i}`, role: 'assistant' as const, text: 'ответ' }] : [u]
      })
      const sel = selectLoreV2({ books, history })
      shown.push(sel.once.some((f) => f.content === 'Кодекс: как это телесно'))
      if (sel.oncePins.length) pins[t] = sel.oncePins
    }
    // ход 2 — ключ, ходы 3 и 4 — держится, дальше нет
    expect(shown).toEqual([false, false, true, true, true, false, false])
  })
})

/** Прогон ходов: `turns[t]` — реплика игрока хода t, `replies[t]` — ответ модели на неё; гритинг первым. Что стояло на каждом ходу. */
function play(scan: 'model' | 'both' | undefined, turns: string[], replies: string[], greeting = 'Привет! лижет'): boolean[] {
  const lay = { pieces: [{ id: 'lore-codex', text: 'Кодекс', place: 'tail', when: { kind: 'event', event: 'lore', turns: 3, keys: ['лиж'], ...(scan ? { scan } : {}) } }] }
  const books = loreBooks({ chars: [{ id: 'bot', card: { name: 'B', extensions: { nrchat: { layout: lay } } } }] })
  const pins: Record<number, LorePin[]> = {}
  const shown: boolean[] = []
  for (let t = 0; t < turns.length; t++) {
    const history = [
      { id: 'g', role: 'assistant' as const, text: greeting },
      ...turns.slice(0, t + 1).flatMap((txt, i) => {
        const u = { id: 'u' + i, role: 'user' as const, text: txt, ...(pins[i] ? { once: pins[i] } : {}) }
        return i < t ? [u, { id: 'a' + i, role: 'assistant' as const, text: replies[i] ?? 'ответ' }] : [u]
      }),
    ]
    const sel = selectLoreV2({ books, history })
    shown.push(sel.once.some((f) => f.content === 'Кодекс'))
    if (sel.oncePins.length) pins[t] = sel.oncePins
  }
  return shown
}

describe('событие: ключ в посте модели (ABC-846)', () => {
  const turns = ['привет', 'ну и?', 'дальше', 'ещё', 'и ещё', 'конец', 'всё']

  it('ключ только в посте модели: запись на следующем ходу и два дальше, потом уходит; у игрока — не ищется; гритинг не сканируется', () => {
    const replies = ['ответ', 'она лижет его', 'ответ', 'ответ', 'ответ', 'ответ']
    expect(play('model', turns, replies)).toEqual([false, false, true, true, true, false, false])
    // по умолчанию (игрок) ключ модели не видит — как
    expect(play(undefined, turns, replies)).toEqual([false, false, false, false, false, false, false])
    // ключ у игрока при scan model не срабатывает
    expect(play('model', ['он лижет', ...turns.slice(1)], [])).toEqual([false, false, false, false, false, false, false])
  })

  it('повтор ключа, пока запись держится, продлевает срок — записи одна, не две', () => {
    const replies = ['ответ', 'лижет', 'ответ', 'снова лижет', 'ответ', 'ответ']
    const shown = play('model', turns, replies)
    // срабатывание на ходу 2, повтор в ответе хода 3 → заново с хода 4: 4, 5, 6
    expect(shown).toEqual([false, false, true, true, true, true, true])
  })

  it('both: ключ у игрока — на этом ходу, ключ в посте модели — на следующем', () => {
    expect(play('both', ['привет', 'он лижет', 'а', 'б', 'в', 'г'], [])).toEqual([false, true, true, true, false, false])
    expect(play('both', turns.slice(0, 6), ['лижет'])).toEqual([false, true, true, true, false, false])
  })

  it('неизвестное «где искать» — громкая ошибка, player — как без поля', () => {
    const c = (scan: unknown) => ({ extensions: { nrchat: { layout: { pieces: [{ id: 'x', text: 't', when: { kind: 'event', keys: ['k'], scan } }] } } } })
    expect(() => layoutOf(c('npc'))).toThrow(/player \| model \| both/)
    expect(layoutOf(c('player'))!.pieces[0]!.when.scan).toBeUndefined()
    expect(layoutParts(layoutOf(c('both'))!).book!.entries[0]!.extensions).toMatchObject({ nr: { scan_by: 'both', renew: true } })
  })
})
