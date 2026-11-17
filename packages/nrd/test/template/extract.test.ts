import { describe, it, expect } from 'vitest'
import { extractNrd } from '../../src/template/extract.js'

describe('extractNrd', () => {
  it('блок есть → возвращает nrdBlock и body без блока', () => {
    const tpl = [
      '<{ nrd }>',
      '$required: character',
      '$profile: alice-example',
      '<{ endnrd }>',
      '# << bot.name >>',
      'Stars: << bot.starCount >>',
    ].join('\n')

    const { nrdBlock, body } = extractNrd(tpl)
    expect(nrdBlock).toBe('$required: character\n$profile: alice-example')
    expect(body).toBe('# << bot.name >>\nStars: << bot.starCount >>')
  })

  it('блока нет → nrdBlock null, body = шаблон как есть', () => {
    const tpl = '# << title >>\n<< body >>'
    const { nrdBlock, body } = extractNrd(tpl)
    expect(nrdBlock).toBeNull()
    expect(body).toBe(tpl)
  })

  it('терпит пробелы внутри тегов `<{  nrd  }>`', () => {
    const tpl = '<{  nrd  }>\n$x: 1\n<{  endnrd  }>\nbody'
    const { nrdBlock, body } = extractNrd(tpl)
    expect(nrdBlock).toBe('$x: 1')
    expect(body).toBe('body')
  })

  it('тело без NRD сохраняется при наличии блока', () => {
    const tpl = '<{ nrd }>\n$a: 1\n<{ endnrd }>\nline one\nline two'
    const { body } = extractNrd(tpl)
    expect(body).toBe('line one\nline two')
  })
})
