import { describe, it, expect } from 'vitest'
import { objectContext } from '../../src/core/index.js'
import { createEnv, render } from '../../src/template/index.js'

const env = await createEnv()

describe('render — переменные и вложенность', () => {
  it('<< var >>', () => {
    const ctx = objectContext({ name: 'Sophie' })
    expect(render(env, '<< name >>', ctx)).toBe('Sophie')
  })

  it('вложенность << bot.name >>', () => {
    const ctx = objectContext({ bot: { name: 'Dead Wood', starCount: 42 } })
    expect(render(env, '# << bot.name >>\nStars: << bot.starCount >>', ctx)).toBe(
      '# Dead Wood\nStars: 42',
    )
  })

  it('<{ if }> — ветвление', () => {
    const tpl = '<{ if bot.tagline }>T: << bot.tagline >><{ endif }>'
    expect(render(env, tpl, objectContext({ bot: { tagline: 'a hero' } }))).toBe('T: a hero')
    expect(render(env, tpl, objectContext({ bot: {} }))).toBe('')
  })

  it('<{ for }> — цикл по массиву', () => {
    const ctx = objectContext({ bot: { greetings: ['hi', 'hey', 'yo'] } })
    const tpl = '<{ for g in bot.greetings }>- << g >>\n<{ endfor }>'
    expect(render(env, tpl, ctx)).toBe('- hi\n- hey\n- yo\n')
  })
})

describe('render — кастомные делимитеры (Handlebars сквозь)', () => {
  it('{{user}} в данных проходит нетронутым', () => {
    const ctx = objectContext({ greeting: 'Hello {{user}}, I am {{char}}.' })
    expect(render(env, '<< greeting >>', ctx)).toBe('Hello {{user}}, I am {{char}}.')
  })

  it('{{...}} в самом теле шаблона — литерал, не интерпретируется', () => {
    const ctx = objectContext({ name: 'X' })
    expect(render(env, 'name={{name}} real=<< name >>', ctx)).toBe('name={{name}} real=X')
  })

  it('<# comment #> вырезается', () => {
    expect(render(env, 'a<# скрытое #>b', objectContext({}))).toBe('ab')
  })
})

describe('render — готовый IContext без nrd-context pipeline', () => {
  it('objectContext напрямую', () => {
    const chain = objectContext({ title: 'Doc', meta: { author: 'DV' } })
    expect(render(env, '# << title >> by << meta.author >>', chain)).toBe('# Doc by DV')
  })

  it('plain-object тоже принимается (chat2/custom путь)', () => {
    expect(render(env, '<< x >>', { x: 'plain' } as object)).toBe('plain')
  })
})
