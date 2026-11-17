import { describe, it, expect } from 'vitest'
import { buildContext } from '../../src/context/index.js'
import { nodeCapabilities } from '../../src/node/index.js'
import { extractNrd, createEnv, render } from '../../src/template/index.js'

// Полный путь: шаблон с NRD-блоком → extractNrd → buildContext (nodeCapabilities,
// inline source) → render → ожидаемый текст. inline-source не требует сети — даёт
// детерминированную интеграцию движка с nrd-context.

function tpl(...lines: string[]): string {
  return lines.join('\n')
}

describe('интеграция: NRD-блок → buildContext → render', () => {
  it('inline mdz source → namespaced контекст → рендер тела', async () => {
    const template = tpl(
      '<{ nrd }>',
      '## $source bot',
      '$nr-type: inline',
      '$nr-parse: mdz',
      '',
      '$name: Sophie',
      '$starCount: 42',
      '<{ endnrd }>',
      '# << bot.name >>',
      'Stars: << bot.starCount >>',
      'Flat: << name >>',
    )

    const { nrdBlock, body } = extractNrd(template)
    expect(nrdBlock).not.toBeNull()

    const chain = await buildContext(nrdBlock!, { ...nodeCapabilities() })
    const env = await createEnv()
    const out = render(env, body, chain)

    expect(out).toBe('# Sophie\nStars: 42\nFlat: Sophie')
  })

  it('Handlebars в данных источника проходит сквозь рендер', async () => {
    const template = tpl(
      '<{ nrd }>',
      '## $source card',
      '$nr-type: inline',
      '$nr-parse: mdz',
      '',
      '$greeting: Hello {{user}}, I am {{char}}',
      '<{ endnrd }>',
      '<< card.greeting >>',
    )
    const { nrdBlock, body } = extractNrd(template)
    const chain = await buildContext(nrdBlock!, { ...nodeCapabilities() })
    const out = render(await createEnv(), body, chain)
    expect(out).toBe('Hello {{user}}, I am {{char}}')
  })

  it('без NRD-блока → рендер по params (objectContext)', async () => {
    const template = '# << title >>'
    const { nrdBlock, body } = extractNrd(template)
    expect(nrdBlock).toBeNull()
    // как в CLE: нет блока → контекст из params
    const { objectContext } = await import('../../src/core/index.js')
    const out = render(await createEnv(), body, objectContext({ title: 'Plain' }))
    expect(out).toBe('# Plain')
  })
})
