/**
 * Ядро kd: объявление (§2), порядок слов (§5), одна нормализация (§9.6), справка и ToolDef.
 */

import { describe, expect, it } from 'vitest'
import * as nrd from '@kerneldreams/nrd'
import { declFromMdz, declFromObject, formatCommand, helpOf, isKdError, KdError, missingError, normalize, parseParamsText, splitWords, tokenize, toolDefOf, type RawCall, type ToolDecl } from '../src/core/index.js'

const BOT = (def = 'publish') => `$description: боты на площадки
$action_arg: cmd
$needs: $[net]
$lang: ru

## $form
$url: string? $pos=1 $kind=url $for=play,publish // Адрес бота
$persona: string? $for=play // Персона
$lang: select ru, en // Язык
$tags: string[]? // Теги
$dry: checkbox // Всухую
$count: number? 1..10 // Сколько

## $action publish
$title: опубликовать
${def === 'publish' ? '$default: true' : ''}

## $action play
$title: сыграть
${def === 'play' ? '$default: true' : ''}
`

const AGENT = `$description: агент

## $form
$task: text? $rest // Задача
$file: string? $pos=1 $kind=file $for=review // Файл
$check: string? // Проверка

## $action run
$default: true

## $action review
$title: ревью файла
`

const decl = (text: string, name = 'bot'): ToolDecl => declFromMdz(nrd, name, text)!
const kindOf = (w: string): string[] => (/^https?:\/\//.test(w) ? ['url'] : /\.\w+$/.test(w) ? ['file'] : [])
const cli = (d: ToolDecl, argv: string[]): RawCall => splitWords(d, tokenize(argv, d), { kindOf })
const err = (fn: () => unknown): KdError => {
  try {
    fn()
  } catch (e) {
    if (isKdError(e)) return e
    throw e
  }
  throw new Error('нет ошибки')
}

describe('§2 объявление — одно на справку, форму и ToolDef', () => {
  it('разбор: действия, поля, пометки, умолчания', () => {
    const d = decl(BOT())
    expect(d.actions.map((a) => a.name)).toEqual(['publish', 'play'])
    expect(d.actionArg).toBe('cmd')
    expect(d.needs).toEqual(['net'])
    expect(d.fields.find((f) => f.name === 'url')!.schema['x-ui']).toMatchObject({ pos: 1, kind: 'url', for: ['play', 'publish'] })
    expect(d.form!.properties.lang!.default).toBe('ru')
  })
  it('правка умолчания в объявлении меняет справку, форму и ToolDef', () => {
    const a = decl(BOT())
    const b = decl(BOT().replace('$lang: ru', '$lang: en'))
    expect(helpOf(a)).toContain('по умолчанию ru')
    expect(helpOf(b)).toContain('по умолчанию en')
    expect(a.form!.properties.lang!.default).toBe('ru')
    expect(b.form!.properties.lang!.default).toBe('en')
    const pa = toolDefOf(a).parameters as { properties: Record<string, { default?: unknown }> }
    const pb = toolDefOf(b).parameters as { properties: Record<string, { default?: unknown }> }
    expect(pa.properties.lang!.default).toBe('ru')
    expect(pb.properties.lang!.default).toBe('en')
    // действие по умолчанию — тоже из объявления
    expect((toolDefOf(decl(BOT('play'))).parameters as { properties: { action: { default: string } } }).properties.action.default).toBe('play')
  })
  it('ToolDef без объединений типов', () => {
    const s = JSON.stringify(toolDefOf(decl(BOT())))
    expect(s).not.toMatch(/anyOf|oneOf|"type":\[/)
  })
  it('объект .ts-тула — то же объявление', () => {
    const d = declFromObject('bot', { description: 'x', fields: { url: 'string? $pos=1 $kind=url // Адрес' }, defaults: {}, actions: { play: { default: true } } })
    expect(normalize(d, cli(d, ['https://a.b/c'])).call).toEqual({ tool: 'bot', action: 'play', params: { url: 'https://a.b/c' } })
  })
  it('битое объявление — громко', () => {
    expect(() => decl('## $form\n$x: string $for=nope\n\n## $action a\n')).toThrow(/nope/)
    expect(() => decl('## $action a\n$default: true\n\n## $action b\n$default: true\n')).toThrow(/default/)
  })
})

describe('§5 порядок слов', () => {
  const d = decl(BOT())
  it('действие первым или последним словом — один вызов', () => {
    const a = normalize(d, cli(d, ['https://bots.ai/x', 'play'])).call
    const b = normalize(d, cli(d, ['play', 'https://bots.ai/x'])).call
    expect(a).toEqual(b)
    expect(a).toMatchObject({ action: 'play', params: { url: 'https://bots.ai/x' } })
  })
  it('нет действия — $default', () => {
    expect(normalize(d, cli(d, ['https://bots.ai/x'])).call.action).toBe('publish')
  })
  it('опечатка действия — код 2 с подсказкой', () => {
    const e = err(() => cli(d, ['https://bots.ai/x', 'pubish']))
    expect(e.code).toBe(2)
    expect(e.info.hint).toMatch(/publish/)
  })
  it('слово в середине действием не считается', () => {
    const e = err(() => cli(d, ['a', 'play', 'b']))
    expect(e.code).toBe(2)
  })
  it('--key=value и --key value равны; --no-key; список повтором и через запятую', () => {
    const x = normalize(d, cli(d, ['play', 'https://a/b', '--persona', 'me', '--no-dry', '--tags=a,b', '--tags', 'c'])).call
    const y = normalize(d, cli(d, ['play', 'https://a/b', '--persona=me', '--dry=false', '--tags=a', '--tags=b,c'])).call
    expect(x).toEqual(y)
    expect(x.params).toMatchObject({ persona: 'me', dry: false, tags: ['a', 'b', 'c'] })
  })
  it('значение, совпавшее с именем действия, — после --', () => {
    const c = normalize(d, cli(d, ['publish', '--', 'play'])).call
    expect(c).toMatchObject({ action: 'publish', params: { url: 'play' } })
  })
  it('у тула с $rest действие только первым словом', () => {
    const a = decl(AGENT, 'agent')
    expect(normalize(a, cli(a, ['fix', 'the', 'tests', 'and', 'review'])).call).toMatchObject({ action: 'run', params: { task: 'fix the tests and review' } })
    expect(normalize(a, cli(a, ['review this file'])).call).toMatchObject({ action: 'run', params: { task: 'review this file' } })
    expect(normalize(a, cli(a, ['--', 'review', 'this', 'file'])).call).toMatchObject({ action: 'run', params: { task: 'review this file' } })
    expect(normalize(a, cli(a, ['review', 'file.ts'])).call).toMatchObject({ action: 'review', params: { file: 'file.ts' } })
  })
})

describe('§9.6 одна нормализация — три формы дают один объект', () => {
  const d = decl(BOT())
  const cases: Array<{ name: string; native: RawCall; mdz: string; json: string; argv: string[] }> = [
    {
      name: 'флаги, списки, числа',
      native: { tool: 'bot', action: 'play', params: { url: 'https://a/b', tags: ['x', 'y'], dry: true, count: 3 } },
      mdz: '$action: play\n$url: https://a/b\n$tags: $[x, y]\n$dry: true\n$count: 3\n',
      json: '{"action":"play","params":{"url":"https://a/b","tags":["x","y"],"dry":true,"count":3}}',
      argv: ['play', 'https://a/b', '--tags=x,y', '--dry', '--count=3'],
    },
    {
      name: 'пустая строка, отсутствующее поле, null',
      native: { tool: 'bot', action: 'play', params: { persona: '', url: null } },
      mdz: "$action: play\n$persona: ''\n$url: null\n",
      json: '{"action":"play","persona":"","url":null}',
      argv: ['play', '--persona='],
    },
    {
      name: 'грязный текст: кавычки, слеши, код',
      native: { tool: 'bot', action: 'play', params: { persona: 'a "q" \\ b `c` $x' } },
      mdz: '$action: play\n\n## $persona\n````\na "q" \\ b `c` $x\n````\n',
      json: JSON.stringify({ action: 'play', params: { persona: 'a "q" \\ b `c` $x' } }),
      argv: ['play', '--persona=a "q" \\ b `c` $x'],
    },
  ]
  for (const c of cases) {
    it(c.name, () => {
      const viaNative = normalize(d, c.native)
      const viaMdz = normalize(d, { tool: 'bot', ...parseParamsText(nrd, c.mdz) })
      const viaJson = normalize(d, { tool: 'bot', ...parseParamsText(nrd, c.json) })
      const viaCli = normalize(d, cli(d, c.argv))
      expect(viaMdz).toEqual(viaNative)
      expect(viaJson).toEqual(viaNative)
      expect(viaCli).toEqual(viaNative)
    })
  }
  it('текст, похожий на разметку, — в фенсе секции', () => {
    const p = parseParamsText(nrd, '## $persona\n````\n## $not\n$x: y\n```js\ncode\n```\n````\n')
    expect(p.params.persona).toBe('## $not\n$x: y\n```js\ncode\n```')
  })
  it('неверный тип, лишнее поле, чужое действие — код 2', () => {
    expect(err(() => normalize(d, { tool: 'bot', params: { count: 'many' } })).code).toBe(2)
    expect(err(() => normalize(d, { tool: 'bot', params: { persna: 'x' } })).info.hint).toMatch(/persona/)
    expect(err(() => normalize(d, { tool: 'bot', action: 'publish', params: { persona: 'x' } })).code).toBe(2)
    expect(err(() => normalize(d, { tool: 'bot', params: { lang: 'de' } })).code).toBe(2)
  })
})

describe('недостающее поле и исправленная команда', () => {
  it('обязательное без значения — missing, ошибка с командой целиком', () => {
    const d = decl('## $form\n$url: string $pos=1 // Адрес\n$name: string? // Имя\n')
    const n = normalize(d, { tool: 'bot', params: { name: 'Кот' } })
    expect(n.missing).toEqual(['url'])
    const e = missingError(d, n)
    expect(e.code).toBe(2)
    expect(e.info.fix).toBe("kd bot --name=Кот --url=<Адрес>")
  })
  it('formatCommand: позиционные словами, остальное флагами', () => {
    const d = decl(BOT())
    expect(formatCommand(d, { action: 'play', params: { url: 'https://a/b c', persona: 'me' } })).toBe("kd bot play 'https://a/b c' --persona=me")
  })
})

describe('тул без объявления — по-старому', () => {
  it('слова в $_, флаги как есть', () => {
    const d = { ...decl(BOT()), legacy: true, fields: [], actions: [] }
    expect(normalize(d, splitWords(d, tokenize(['a', 'b', '--x=1']))).call.params).toEqual({ _: ['a', 'b'], x: '1' })
  })
})

describe('документы рецептов — не объявления', () => {
  it('блоки кода ## $action и пульт ## $form без пометок — тул по-старому', () => {
    const recipe = ['$run: run', '', '## $form agent', '$model: model // Модель', '', '## $action run', '$nr-title: Прогон', '```ts', 'export default async () => ({})', '```', ''].join('\n')
    expect(declFromMdz(nrd, 'r', recipe)).toBeNull()
  })
  it('код без фенса в ## $action (старые рецепты runz) — тоже блок кода, не объявление', () => {
    const recipe = ['$x: 1', '', '## $form fix', '$model_fix: model', '', '## $action go', 'return 1', '', '## $@', ''].join('\n')
    expect(declFromMdz(nrd, 'r', recipe)).toBeNull()
    const decl = ['## $action show', '$title: показать', '$effects: $[net,', '  fs]', '// комментарий', '$default: true', ''].join('\n')
    expect(declFromMdz(nrd, 'r', decl)!.actions.map((a) => a.name)).toEqual(['show'])
  })
  it('действие без кода рядом с блоками кода — объявление только из него', () => {
    const d = declFromMdz(nrd, 'r', ['## $action go', '$default: true', '', '## $action body', '```ts', 'export default 1', '```', ''].join('\n'))!
    expect(d.actions.map((a) => a.name)).toEqual(['go'])
  })
})
