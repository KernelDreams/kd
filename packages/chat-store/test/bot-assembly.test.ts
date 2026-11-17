/** (bot-assembly-spec): переменные пресета, заметки, тип бота, формат имён, контракт блоков. */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Message, Persona } from '../src/model.js'
import { buildMdsTemplate, type BuildInput } from '../src/builder/index.js'
import { botTemplateRef, botTypeOf, estimateTokens, greetingForVars, presetVarsOf, resolveVars, textOf } from '../src/assembly/index.js'

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'builder')
const RP = readFileSync(join(FIX, 'rp.mds'), 'utf8')
const NR = readFileSync(join(FIX, 'bot-nr.mds'), 'utf8')
const RAW = readFileSync(join(FIX, 'bot-raw.mds'), 'utf8')

const msg = (id: string, role: string, text: string, meta?: Message['meta']): Message => ({ id, role, parts: [{ type: 'text', text }], ...(meta ? { meta } : {}) })
const me = { id: 'me', kind: 'user', name: 'Ann' } as Persona
const VARS = {
  language: { label: 'Язык', default: 'en', values: { ru: 'Пиши по-русски.', en: 'Write in English.' } },
  person: { label: 'Лицо', default: '3', values: { '1': 'Рассказ от первого лица.', '3': 'Рассказ от третьего лица.' } },
  rating: { label: 'Рейтинг', default: 'pg', values: { pg: 'Без откровенных сцен.', nsfw: 'Откровенные сцены разрешены.' } },
}
const card = { name: 'Scarlett', description: 'Наёмница.', post_history_instructions: 'PHI карты.' }
const bot = (over: Record<string, unknown> = {}): Persona => ({ id: 'bot', kind: 'char', name: 'Scarlett', card: { ...card, ...over } }) as Persona

function input(o: { template?: string; personas?: Persona[]; path?: Message[]; meta?: Record<string, unknown>; extra?: Record<string, string>; budget?: BuildInput['budget'] } = {}): BuildInput {
  return {
    session: { id: 's1' },
    document: { path: o.path ?? [msg('g', 'assistant', 'Привет.', { greeting: 0 }), msg('u1', 'user', 'Налей.')], meta: o.meta ?? {}, personas: o.personas ?? [bot(), me], userId: 'me' },
    model: { id: 'm' },
    base: [],
    tools: [],
    ...(o.budget ? { budget: o.budget } : {}),
    agent: { id: 'rp', name: 'RP', prompt: { post: 'Пост агента.' }, template: o.template ?? RP, includes: {}, extra: { vars: JSON.stringify(VARS), ...(o.extra ?? {}) } },
  }
}
const tailText = (out: Awaited<ReturnType<typeof buildMdsTemplate>>) => textOf(out.nodes.at(-1)!)

describe('переменные пресета (§5)', () => {
  it('без объявленных переменных шаблон даёт прежний промпт', async () => {
    const plain = await buildMdsTemplate({ ...input(), agent: { ...input().agent, extra: {} } })
    expect(tailText(plain)).toBe('PHI карты.')
    expect(plain.recipe.systemBlocks.map((b) => b.source)).not.toContain('vars.top')
  })
  it('по умолчанию агента: форма в хвосте до поста, рейтинг наверху; PHI карты — после формы', async () => {
    const out = await buildMdsTemplate(input())
    expect(out.recipe.systemBlocks.find((b) => b.source === 'vars.top')!.text).toBe('Без откровенных сцен.')
    expect(tailText(out)).toBe('Write in English.\nРассказ от третьего лица.\n\nPHI карты.')
  })
  it('каскад: чип (реплика хода) → персона → бот; язык игрока — жёсткий, после PHI', async () => {
    const persona = { ...me, card: { extensions: { nrchat: { vars: { person: '1' } } } } } as Persona
    const b = bot({ extensions: { nrchat: { vars: { language: 'ru', rating: 'nsfw' } } } })
    const out = await buildMdsTemplate(input({ personas: [b, persona] }))
    // Язык выбрал бот (не игрок) — не жёсткий; лицо — персона.
    expect(tailText(out)).toBe('Пиши по-русски.\nРассказ от первого лица.\n\nPHI карты.')
    expect(out.recipe.systemBlocks.find((x) => x.source === 'vars.top')!.text).toBe('Откровенные сцены разрешены.')
    const chip = await buildMdsTemplate(input({ personas: [b, persona], path: [msg('g', 'assistant', 'Привет.'), msg('u1', 'user', 'Налей.', { vars: { language: 'en' } })] }))
    expect(tailText(chip)).toBe('Рассказ от первого лица.\n\nPHI карты.\n\nWrite in English.')
  })
  it('значение не из вариантов — слой пропускается; resolveVars отдаёт слой', () => {
    const r = resolveVars(presetVarsOf({ extra: { vars: JSON.stringify(VARS) } }), { chip: { language: 'klingon' }, bot: { language: 'ru' } })
    expect(r.find((x) => x.id === 'language')).toMatchObject({ value: 'ru', layer: 'bot', slot: 'tail' })
  })
  it('условие шаблона по значению (vars.person)', async () => {
    const out = await buildMdsTemplate(input({ template: '%system\n<{ if vars.person == "3" }>третье<{ endif }>\n<{ history }><{ endhistory }>' }))
    expect(out.recipe.systemBlocks[0]!.text).toBe('третье')
  })
  it('impersonate читает те же переменные — в той же реплике-инструкции, последней', async () => {
    const out = await buildMdsTemplate({ ...input(), turn: { impersonate: true, input: '' } })
    const last = textOf(out.nodes.at(-1)!)
    expect(last).toContain('Write in English.')
    expect(last).toMatch(/next reply[\s\S]*Write in English\./)
  })
  it('два хода подряд: верх побайтно совпадает (переменные и заметки — в хвосте)', async () => {
    const meta = { notes: [{ text: 'Заметка.', every: 1 }] }
    const a = await buildMdsTemplate(input({ meta }))
    const b = await buildMdsTemplate(input({ meta, path: [msg('g', 'assistant', 'Привет.'), msg('u1', 'user', 'Налей.'), msg('a1', 'assistant', 'Держи.'), msg('u2', 'user', 'Ещё.', { vars: { language: 'ru' } })] }))
    expect(textOf(b.nodes[0]!)).toBe(textOf(a.nodes[0]!))
  })
})

describe('заметки чата (§11) и заметка формы (§13 п. 4)', () => {
  it('three scopes, every N, depth', async () => {
    const meta = { notes: [{ text: 'Чат каждый ход.' }, { text: 'Раз в два хода.', every: 2 }, { text: 'На глубине.', slot: 'depth 1' }] }
    const b = bot({ extensions: { nrchat: { notes: [{ text: 'Бот везде.' }], form_note: 'Говорит коротко, рублено.' } } })
    const out = await buildMdsTemplate(input({ meta, personas: [b, me], extra: { notes: JSON.stringify([{ text: 'Пресет.' }]) } }))
    const tail = tailText(out)
    expect(tail).toContain('Чат каждый ход.\n\nБот везде.\n\nПресет.')
    expect(tail).not.toContain('Раз в два хода.')
    expect(tail).toContain('Говорит коротко, рублено.')
    expect(out.recipe.injections.some((i) => i.source === 'note:chat @1' && i.text === 'На глубине.')).toBe(true)
    const turn2 = await buildMdsTemplate(input({ meta, personas: [b, me], path: [msg('g', 'assistant', 'Привет.'), msg('u1', 'user', 'a'), msg('a1', 'assistant', 'b'), msg('u2', 'user', 'c')] }))
    expect(tailText(turn2)).toContain('Раз в два хода.')
  })
})

describe('тип бота (§4)', () => {
  it('тип и шаблон каскадом: свой шаблон экземпляра → тип (если объявлен) → агент', () => {
    expect(botTypeOf({ name: 'x' })).toBe('ccv3')
    expect(botTemplateRef({ name: 'x' })).toBeUndefined()
    expect(botTemplateRef({ data: { extensions: { nrchat: { type: 'nr' } } } })).toEqual({ ref: 'bot-nr.mds', from: 'type' })
    expect(botTemplateRef({ type: 'raw', extensions: { nrchat: { template: '%system\nX' } } })).toEqual({ ref: '%system\nX', from: 'bot' })
  })
  it('nr: справочник наверху, состояние сообщением перед гритингом, форма и правила в хвосте', async () => {
    const nr = { id: 'bot', kind: 'char', name: 'Лея', card: { type: 'nr', name: 'Лея', reference: [{ title: 'Вкусы', text: 'Любит кофе.' }], form: 'Говорит сухо.', rules: 'Не ломай четвёртую стену.', states: [{ id: 'bar', text: 'Лея злится на {{user}}.', ttl: 1 }], greetings: [{ state: 'bar', text: 'Чего тебе?' }], examples: [{ role: 'assistant', text: 'Лея: Отвали.' }], examples_mode: 'turns', examples_ttl: 1 } } as Persona
    const out = await buildMdsTemplate(input({ template: NR, personas: [nr, me] }))
    expect(out.recipe.systemBlocks.find((b) => b.source === 'bot.reference')!.text).toBe('Лея\n## Вкусы\nЛюбит кофе.')
    const rows = out.nodes.map((n) => [n.source, textOf(n)])
    const g = rows.findIndex(([s]) => s === 'history')
    expect(rows.slice(g - 2, g)).toEqual([['bot.examples', 'Лея: Отвали.'], ['bot.state:bar', 'Лея злится на Ann.']])
    expect(tailText(out)).toBe('Лея злится на Ann.\n\nГоворит сухо.\n\nWrite in English.\nРассказ от третьего лица.\n\nПост агента.\n\nНе ломай четвёртую стену.')
    // Второй ход: срок примеров и копии состояния вышел, состояние перед гритингом осталось.
    const two = await buildMdsTemplate(input({ template: NR, personas: [nr, me], path: [msg('g', 'assistant', 'Чего тебе?'), msg('u1', 'user', 'a'), msg('a1', 'assistant', 'b'), msg('u2', 'user', 'c')] }))
    expect(two.nodes.some((n) => n.source === 'bot.examples')).toBe(false)
    expect(two.nodes.some((n) => n.source === 'bot.state:bar')).toBe(true)
    expect(tailText(two)).not.toContain('злится')
  })
  it('nr ансамбль из трёх (§7, §14): форма в хвосте только у упомянутых в последних 5 постах, справочник — у всех наверху', async () => {
    const trio = { id: 'bot', kind: 'char', name: 'Трио', card: { type: 'nr', name: 'Трио', cast: [
      { name: 'Мира', keys: ['Мир'], reference: 'Хозяйка бара.', form: 'Говорит тихо.' },
      { name: 'Грег', reference: 'Вышибала.', form: 'Рубит фразы.' },
      { name: 'Соня', reference: 'Певица.', form: 'Поёт строчками.' },
    ], greetings: ['Бар открыт.'] } } as Persona
    const path = [msg('g', 'assistant', 'Бар открыт.', { greeting: 0 }), msg('u1', 'user', 'Позову Соню.'), msg('a1', 'assistant', 'Соня выходит.'), msg('u2', 'user', 'a'), msg('a2', 'assistant', 'b'), msg('u3', 'user', 'Где Мире налить?')]
    const out = await buildMdsTemplate(input({ template: NR, personas: [trio, me], path }))
    const top = out.recipe.systemBlocks.map((b) => b.text).join('\n')
    for (const r of ['Хозяйка бара.', 'Вышибала.', 'Певица.']) expect(top).toContain(r)
    const tail = tailText(out)
    expect(tail).toContain('Мира: Говорит тихо.')
    expect(tail).toContain('Соня: Поёт строчками.')
    expect(tail).not.toContain('Грег')
    // Соня и Мира ушли за окно 5 постов — их формы больше нет.
    const later = await buildMdsTemplate(input({ template: NR, personas: [trio, me], path: [...path, msg('a3', 'assistant', 'c'), msg('u4', 'user', 'd'), msg('a4', 'assistant', 'e'), msg('u5', 'user', 'f'), msg('a5', 'assistant', 'g'), msg('u6', 'user', 'Грег!')] }))
    expect(tailText(later)).toContain('Грег: Рубит фразы.')
    expect(tailText(later)).not.toContain('Соня')
    expect(tailText(later)).not.toContain('Мира')
  })
  it('raw: одно поле наверху', async () => {
    const raw = { id: 'bot', kind: 'char', name: 'R', card: { type: 'raw', text: 'Дамп персонажа.', greeting: 'Хай.' } } as Persona
    const out = await buildMdsTemplate(input({ template: RAW, personas: [raw, me] }))
    expect(out.recipe.systemBlocks.map((b) => b.text)).toContain('Дамп персонажа.')
  })
  it('гритинг под переменные: рукописный с совпавшими vars побеждает', () => {
    expect(greetingForVars([{ text: 'en' }, { text: 'ru', vars: { language: 'ru' } }], { language: 'ru' })).toBe(1)
    expect(greetingForVars([{ text: 'en' }, { text: 'ru', vars: { language: 'ru' } }], { language: 'en' })).toBeUndefined()
  })
})

describe('формат сообщений (§8a) и контракт блоков (§2)', () => {
  const two = [bot(), { id: 'bob', kind: 'char', name: 'Bob' } as Persona, me]
  it('names: off — без имён даже при двух персонах; always — с именами у одной; по умолчанию — как было', async () => {
    const path = [msg('a1', 'assistant', 'Я.'), msg('u1', 'user', 'Привет')]
    const dflt = await buildMdsTemplate(input({ personas: two, path }))
    expect(dflt.nodes.some((n) => textOf(n).startsWith('Scarlett: '))).toBe(true)
    const off = await buildMdsTemplate(input({ personas: two, path, extra: { names: 'off' } }))
    expect(off.nodes.some((n) => textOf(n).startsWith('Scarlett: '))).toBe(false)
    const always = await buildMdsTemplate(input({ path, extra: { names: 'always' } }))
    expect(always.nodes.some((n) => textOf(n).startsWith('Scarlett: '))).toBe(true)
  })
  it('stop_user — стоп-строка с именем игрока; id_slot — в sampling', async () => {
    const out = await buildMdsTemplate(input({ extra: { stop_user: 'true', id_slot: '2' } }))
    expect(out.meta.sampling).toEqual({ stop: ['\nAnn:'], id_slot: 2 })
    expect((await buildMdsTemplate(input())).meta.sampling).toBeUndefined()
  })
  it('нестабильный блок наверху — предупреждение в рецепте; не запрещается', async () => {
    const out = await buildMdsTemplate(input({ template: '%system {stable: false}\nВремя: сейчас.\n%system\nСтабильно.\n<{ history }><{ endhistory }>' }))
    expect(out.recipe.warnings).toEqual(['нестабильный блок наверху (рвёт кэш): template:system'])
    expect(out.recipe.injections.some((i) => i.source === 'сборка: предупреждение')).toBe(true)
    expect(out.nodes[0]!.parts).toEqual([{ type: 'text', text: 'Время: сейчас.' }])
  })
  it('evict: при нехватке окна узлы уходят по возрастанию evict', async () => {
    const tpl = '%system\nГлавное.\n%system {evict: 2}\n' + 'длинно '.repeat(400) + '\n%system {evict: 1}\n' + 'ещё '.repeat(400) + '\n<{ history }><{ endhistory }>'
    const roomy = await buildMdsTemplate(input({ template: tpl, budget: { contextWindow: 100000, reserveTokens: 0 } }))
    expect(roomy.nodes).toHaveLength(5)
    const total = roomy.nodes.reduce((n, x) => n + estimateTokens(textOf(x)), 0)
    const tight = await buildMdsTemplate(input({ template: tpl, budget: { contextWindow: total - 10, reserveTokens: 0 } }))
    expect(tight.nodes.map((n) => textOf(n).slice(0, 6))).toEqual(['Главно', 'длинно', 'Привет', 'Налей.'])
    expect(tight.recipe.injections.some((i) => i.source.startsWith('вытеснено 1'))).toBe(true)
  })
})

describe('объявление переменных из .mdz (JSON5 nrd)', () => {
  it("ключи без кавычек и строки в одинарных — разбираются", () => {
    const extra = { vars: "{language: {label: 'Язык', default: 'ru', values: {ru: 'Пиши: по-русски, да.', en: 'It\\'s English'}}, person: {values: {'1': 'Первое.',}}}" }
    const decl = presetVarsOf({ extra })
    expect(decl.map((d) => d.id)).toEqual(['language', 'person'])
    expect(decl[0]!.values.ru!.text).toBe('Пиши: по-русски, да.')
    expect(decl[0]!.values.en!.text).toBe("It's English")
  })
})

describe('шаблон текстом с комментарием сверху (ABC-723 §4)', () => {
  it('isInlineTemplate: %-узел в начале или многострочный с %-узлом; путь — нет', async () => {
    const { isInlineTemplate } = await import('../src/builder/index.js')
    expect(isInlineTemplate('%system\nX')).toBe(true)
    expect(isInlineTemplate('Комментарий.\n\n%system\nX')).toBe(true)
    expect(isInlineTemplate('rp.mds')).toBe(false)
    expect(isInlineTemplate('templates/bot-nr.mds')).toBe(false)
  })
})

describe('наборы значений на язык (§5)', () => {
  const decl = presetVarsOf({ vars: {
    language: { label: 'Язык', default: 'en', values: { ru: 'Пиши по-русски.', en: 'Write in English.' } },
    tense: { label: 'Время', default: 'past', defaults: { ru: 'mixed' }, values: { past: { text: 'Past tense.', lang: { ru: 'Прошедшее время.' } }, mixed: { text: 'Mixed tenses.', lang: { ru: 'Прошедшее и настоящее вперемешку, как в живой прозе.' } } } },
  } })
  it('русский — смешение по умолчанию и русский текст; английский — строгое', () => {
    const ru = resolveVars(decl, { chip: { language: 'ru' } })
    expect(ru.find((r) => r.id === 'tense')).toMatchObject({ value: 'mixed', text: 'Прошедшее и настоящее вперемешку, как в живой прозе.' })
    const en = resolveVars(decl, {})
    expect(en.find((r) => r.id === 'tense')).toMatchObject({ value: 'past', text: 'Past tense.' })
    // Выбор игрока сильнее умолчания по языку; текст — на языке игры.
    expect(resolveVars(decl, { chip: { language: 'ru', tense: 'past' } }).find((r) => r.id === 'tense')).toMatchObject({ value: 'past', text: 'Прошедшее время.' })
  })
})

describe('группа: три раскладки (§9)', () => {
  const a = { id: 'a', kind: 'char', name: 'Ada', card: { name: 'Ada', description: 'Ада — механик.', post_history_instructions: '' } } as Persona
  const b = { id: 'b', kind: 'char', name: 'Bo', card: { name: 'Bo', description: 'Бо — пилот.' } } as Persona
  const build = (layout: string | undefined, who: string) =>
    buildMdsTemplate({ ...input({ template: RP, personas: [a, b, me], extra: layout ? { group_layout: layout } : {} }), turn: { target: who } as never })
  const top = (o: Awaited<ReturnType<typeof buildMdsTemplate>>) => textOf(o.nodes[0]!)
  it('actor (по умолчанию): карта говорящего наверху — верх у актёров разный', async () => {
    const [x, y] = [await build(undefined, 'a'), await build(undefined, 'b')]
    expect(top(x)).toContain('Ада — механик.')
    expect(top(y)).toContain('Бо — пилот.')
    expect(top(x)).not.toBe(top(y))
  })
  it('narrator: все карты наверху, верх побайтно один для разных говорящих', async () => {
    const [x, y] = [await build('narrator', 'a'), await build('narrator', 'b')]
    expect(top(x)).toContain('Ада — механик.')
    expect(top(x)).toContain('Бо — пилот.')
    expect(top(x)).toBe(top(y))
  })
  it('tail: верх без карт и общий, карта говорящего — в хвосте', async () => {
    const [x, y] = [await build('tail', 'a'), await build('tail', 'b')]
    expect(top(x)).not.toContain('механик')
    expect(top(x)).toBe(top(y))
    expect(tailText(x)).toContain('Ада — механик.')
    expect(tailText(y)).toContain('Бо — пилот.')
  })
  it('одиночная сессия: раскладка ничего не меняет', async () => {
    const solo = (layout?: string) => buildMdsTemplate(input({ template: RP, extra: layout ? { group_layout: layout } : {} }))
    expect(top(await solo('tail'))).toBe(top(await solo()))
  })
})
