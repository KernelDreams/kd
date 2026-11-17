/**
 * Палитры (§6): тот же каталог и те же правила объектов, что у командной строки — тулы с формами,
 * действия объекта по вставленному адресу с планом вызова, форма действия по `$for`, команда задачи.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { formFor } from '../src/core/describe.js'
import { loadCatalog, type Catalog } from '../src/node/catalog.js'
import { loadLayers, type Layers } from '../src/node/layers.js'
import { loadRules } from '../src/node/objects.js'
import { jobCommand, objectJobCommand, paletteCatalog, paletteMatch, planTool } from '../src/node/palette.js'
import type { LinkRules } from '@kerneldreams/ui-protocol'

let root: string
let work: string
let l: Layers
let c: Catalog
let r: LinkRules

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kd-palette-'))
  work = join(root, 'w')
  const d = join(work, '.kd')
  mkdirSync(join(d, 'tools'), { recursive: true })
  writeFileSync(
    join(d, 'tools', 'bot.mdz'),
    [
      '$description: бот',
      '$lang: ru',
      '',
      '## $form',
      '$url: string $pos=1 $kind=bot // Адрес бота',
      '$lang: select ru, en $for=play // Язык',
      '$name: string? $for=fork // Имя копии',
      '',
      '## $action show',
      '$title: показать',
      '$default: true',
      '',
      '## $action play',
      '$title: сыграть',
      '',
      '## $action fork',
      '$title: форк',
    ].join('\n'),
  )
  writeFileSync(join(d, 'tools', 'old.mdz'), ['$description: старый рецепт', '$handler: x'].join('\n'))
  writeFileSync(
    join(d, 'links.mdz'),
    [
      '## $link bot',
      "$pattern: 'https://bots\\.example/[\\w-]+'",
      '$kind: bot',
      '',
      '## $action bot.play',
      '$for: bot',
      '$title: сыграть с ботом',
      '$run: kd',
      '$cmd: bot play ${text}',
      '',
      '## $action bot.fork',
      '$for: bot',
      '$title: форк бота',
      '$run: kd',
      '$cmd: bot fork ${text}',
      '',
      '## $action bot.open',
      '$for: bot',
      '$run: exec',
      '$cmd: echo ${text}',
    ].join('\n'),
  )
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), KD_HOME: join(root, 'home', '.kd') }
  l = loadLayers(work, env)
  c = loadCatalog(l)
  r = loadRules(l, c)
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('палитры на каталоге kd', () => {
  it('каталог: тул с объявлением — действия и форма; без объявления — поле «как в командной строке»', async () => {
    const cat = await paletteCatalog(c)
    const bot = cat.find((t) => t.name === 'bot')!
    expect(bot.legacy).toBe(false)
    expect(bot.actions.map((a) => a.name)).toEqual(['show', 'play', 'fork'])
    expect(Object.keys(bot.schema.properties)).toEqual(['url', 'lang', 'name'])
    expect(bot.fields).toEqual({ show: ['url'], play: ['url', 'lang'], fork: ['url', 'name'] })
    const old = cat.find((t) => t.name === 'old')!
    expect(old.legacy).toBe(true)
    expect(Object.keys(old.schema.properties)).toEqual(['args'])
  })

  it('форма действия — только его поля ($for)', async () => {
    const bot = (await paletteCatalog(c)).find((t) => t.name === 'bot')!
    expect(Object.keys(formFor(bot.schema, 'play').properties)).toEqual(['url', 'lang'])
    expect(Object.keys(formFor(bot.schema, 'fork').properties)).toEqual(['url', 'name'])
    expect(Object.keys(formFor(bot.schema, 'show').properties)).toEqual(['url'])
    expect(formFor(bot.schema, 'fork').required).toEqual(['url'])
  })

  it('вставленный адрес → действия объекта с планом: поле из адреса, форма действия', async () => {
    const m = (await paletteMatch(l, c, r, '  https://bots.example/cat ', work))!
    expect(m.kind).toBe('bot')
    expect(m.actions.map((a) => a.word)).toEqual(['play', 'fork', 'open'])
    const play = m.actions[0]!
    expect(play.title).toBe('сыграть с ботом')
    expect(play.plan).toMatchObject({ tool: 'bot', action: 'play', params: { url: 'https://bots.example/cat', lang: 'ru' }, missing: [] })
    expect(Object.keys(play.plan!.schema.properties)).toEqual(['url', 'lang'])
    expect(play.plan!.schema.properties.url!.default).toBe('https://bots.example/cat')
    // exec-действие — без плана, задачей «kd <объект> <слово>»
    expect(m.actions[2]).toMatchObject({ run: 'exec', argv: ['https://bots.example/cat', 'open'] })
    expect(m.actions[2]!.plan).toBeUndefined()
  })

  it('не объект — null: имя тула, текст с пробелами, незнакомое слово', async () => {
    expect(await paletteMatch(l, c, r, 'bot', work)).toBeNull()
    expect(await paletteMatch(l, c, r, 'сыграть с ботом', work)).toBeNull()
    expect(await paletteMatch(l, c, r, 'qwerty', work)).toBeNull()
  })

  it('план тула и недостающее', async () => {
    const p = await planTool(l, c, r, ['bot', 'fork'], work)
    expect(p.action).toBe('fork')
    expect(p.missing).toEqual(['url'])
  })

  it('команда задачи: действие явно, поля флагами, умолчания не пишутся', async () => {
    const opts = { node: 'node', bin: '/k/kd.mjs' }
    expect(await jobCommand(c, { tool: 'bot', action: 'play', params: { url: 'https://bots.example/cat', lang: 'ru' } }, opts)).toBe('node /k/kd.mjs bot play https://bots.example/cat')
    expect(await jobCommand(c, { tool: 'bot', action: 'show', params: { url: 'https://bots.example/c a' } }, opts)).toBe("node /k/kd.mjs bot show 'https://bots.example/c a'")
    expect(await jobCommand(c, { tool: 'bot', action: 'play', params: { url: 'u', lang: 'en', junk: 'x' } }, opts)).toBe('node /k/kd.mjs bot play u --lang=en')
    expect(await jobCommand(c, { tool: 'old', params: { args: "a --b='c d'" } }, opts)).toBe("node /k/kd.mjs old a '--b=c d'")
    await expect(jobCommand(c, { tool: 'bot', action: 'nope', params: {} }, opts)).rejects.toThrow(/нет действия/)
    expect(objectJobCommand('https://bots.example/cat', 'open', opts)).toBe('node /k/kd.mjs https://bots.example/cat open')
  })
})
