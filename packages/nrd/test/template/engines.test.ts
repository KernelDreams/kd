// TemplateEngine: nunjucksEngine (backward compat) + handlebarsEngine ( §4.5).

import { describe, it, expect } from 'vitest'
import { objectContext } from '../../src/core/index.js'
import { nunjucksEngine, handlebarsEngine } from '../../src/template/index.js'

// Фабрики движков асинхронны (nrd-merge §2.4: optional peers грузятся лениво).
// Top-level await — тест-файл ESM.
const nj = await nunjucksEngine()
const hb = await handlebarsEngine()

describe('nunjucksEngine — обёртка (backward compat)', () => {
  const eng = nj

  it('name', () => {
    expect(eng.name).toBe('nunjucks')
  })

  it('<< var >>', () => {
    expect(eng.render('<< name >>', objectContext({ name: 'Sophie' }))).toBe('Sophie')
  })

  it('вложенность << bot.name >>', () => {
    const ctx = objectContext({ bot: { name: 'Dead Wood', starCount: 42 } })
    expect(eng.render('# << bot.name >>\nStars: << bot.starCount >>', ctx)).toBe(
      '# Dead Wood\nStars: 42',
    )
  })

  it('<{ for }> по массиву', () => {
    const ctx = objectContext({ bot: { greetings: ['hi', 'hey', 'yo'] } })
    expect(eng.render('<{ for g in bot.greetings }>- << g >>\n<{ endfor }>', ctx)).toBe(
      '- hi\n- hey\n- yo\n',
    )
  })

  it('<< bot | json >> разворачивает объект (ключи видны)', () => {
    const ctx = objectContext({ bot: { name: 'Dead Wood', stars: 42 } })
    const out = eng.render('<< bot | json >>', ctx)
    expect(out).toContain('name')
    expect(out).toContain('Dead Wood')
    expect(out).toContain('stars')
  })
})

describe('handlebarsEngine', () => {
  const eng = hb

  it('name', () => {
    expect(eng.name).toBe('handlebars')
  })

  it('{{name}} → значение', () => {
    expect(eng.render('{{name}}', objectContext({ name: 'Sophie' }))).toBe('Sophie')
  })

  it('{{bot.name}} → вложенное', () => {
    const ctx = objectContext({ bot: { name: 'Dead Wood' } })
    expect(eng.render('{{bot.name}}', ctx)).toBe('Dead Wood')
  })

  it('{{#if bot.tagline}}...{{/if}}', () => {
    const tpl = '{{#if bot.tagline}}T: {{bot.tagline}}{{/if}}'
    expect(eng.render(tpl, objectContext({ bot: { tagline: 'a hero' } }))).toBe('T: a hero')
    expect(eng.render(tpl, objectContext({ bot: {} }))).toBe('')
  })

  it('{{#each bot.greetings}}...{{/each}}', () => {
    const ctx = objectContext({ bot: { greetings: ['hi', 'hey', 'yo'] } })
    expect(eng.render('{{#each bot.greetings}}- {{this}}\n{{/each}}', ctx)).toBe(
      '- hi\n- hey\n- yo\n',
    )
  })

  it('{{#each obj}} обходит ключи контекста (cast keys → Object.keys)', () => {
    const ctx = objectContext({ a: 1, b: 2 })
    expect(eng.render('{{#each this}}<{{@key}}={{this}}>{{/each}}', ctx)).toBe('<a=1><b=2>')
  })
})

describe('оба движка — один IContext, разный синтаксис', () => {
  const ctx = objectContext({ bot: { name: 'Dead Wood' } })

  it('nunjucks << >> и handlebars {{ }} дают одно значение', () => {
    expect(nj.render('<< bot.name >>', ctx)).toBe('Dead Wood')
    expect(hb.render('{{bot.name}}', ctx)).toBe('Dead Wood')
  })
})
