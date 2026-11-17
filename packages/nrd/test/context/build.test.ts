import { describe, it, expect } from 'vitest'
import { buildContext } from '../../src/context/index.js'

// Конфиги собираем join('\n') — чтобы `${...}` НЕ интерполировался тест-файлом
// преждевременно (одинарные кавычки в массиве строк).
function cfg(...lines: string[]): string {
  return lines.join('\n')
}

describe('buildContext — inline / env', () => {
  it('inline mdz: данные в $-атрибутах блока', async () => {
    const chain = await buildContext(
      cfg('## $source config', '$nr-type: inline', '$nr-parse: mdz', '', '$model: gpt-4o', '$provider: openrouter'),
    )
    expect(chain.get(['config', 'model'])).toBe('gpt-4o')
    expect(chain.get(['config', 'provider'])).toBe('openrouter')
    // верхнеуровневый merge-доступ (§3.3)
    expect(chain.get(['model'])).toBe('gpt-4o')
  })

  it('inline mdd: тело блока с @-сигилом', async () => {
    const chain = await buildContext(
      cfg('## $source card', '$nr-type: inline', '$nr-parse: mdd', '', '@name: Sophie', '@mood: nervous'),
    )
    expect(chain.get(['card', 'name'])).toBe('Sophie')
    expect(chain.get(['card', 'mood'])).toBe('nervous')
  })

  it('inline text: content', async () => {
    const chain = await buildContext(
      cfg('## $source note', '$nr-type: inline', '$nr-parse: text', '', 'hello world'),
    )
    expect(chain.get(['note', 'content'])).toBe('hello world')
  })

  it('env source: $keys → process.env', async () => {
    process.env.NRD_CTX_TEST = 'xyz-42'
    const chain = await buildContext(cfg('## $source e', '$nr-type: env', '$keys: NRD_CTX_TEST, NRD_MISSING'))
    expect(chain.get(['e', 'NRD_CTX_TEST'])).toBe('xyz-42')
    expect(chain.get(['e', 'NRD_MISSING'])).toBeUndefined()
    delete process.env.NRD_CTX_TEST
  })
})

describe('buildContext — params', () => {
  const config = cfg(
    '$model: root-model',
    '## $source c',
    '$nr-type: inline',
    '$nr-parse: mdz',
    '$picked: ${model}',
  )

  it('корневой атрибут как параметр', async () => {
    const chain = await buildContext(config)
    expect(chain.get(['c', 'picked'])).toBe('root-model')
  })

  it('opts.params перекрывает корневые', async () => {
    const chain = await buildContext(config, { params: { model: 'override' } })
    expect(chain.get(['c', 'picked'])).toBe('override')
  })

  it('env как fallback для ${}', async () => {
    process.env.NRD_FALLBACK = 'from-env'
    const chain = await buildContext(
      cfg('## $source c', '$nr-type: inline', '$nr-parse: mdz', '$v: ${NRD_FALLBACK}'),
    )
    expect(chain.get(['c', 'v'])).toBe('from-env')
    delete process.env.NRD_FALLBACK
  })

  it('$required: отсутствует → ошибка', async () => {
    const c = cfg('$required: profile', '## $source x', '$nr-type: inline', '$nr-parse: mdz', '$a: 1')
    await expect(buildContext(c)).rejects.toThrow(/profile/)
  })

  it('$required: присутствует (opts.params) → ok', async () => {
    const c = cfg('$required: profile', '## $source x', '$nr-type: inline', '$nr-parse: mdz', '$a: 1')
    const chain = await buildContext(c, { params: { profile: 'alice' } })
    expect(chain.get(['x', 'a'])).toBe(1)
  })
})

describe('buildContext — $nr-type / $type fallback (§4.6)', () => {
  it('$nr-type первым', async () => {
    const chain = await buildContext(cfg('## $source c', '$nr-type: inline', '$nr-parse: mdz', '$x: 1'))
    expect(chain.get(['c', 'x'])).toBe(1)
  })

  it('fallback на $type', async () => {
    const chain = await buildContext(cfg('## $source c', '$type: inline', '$nr-parse: mdz', '$x: 7'))
    expect(chain.get(['c', 'x'])).toBe(7)
  })
})

describe('buildContext — chain priority / $chain override / first-wins', () => {
  const two = cfg(
    '## $source a',
    '$nr-type: inline',
    '$nr-parse: mdz',
    '$shared: from-a',
    '$only_a: 1',
    '',
    '## $source b',
    '$nr-type: inline',
    '$nr-parse: mdz',
    '$shared: from-b',
    '$only_b: 2',
  )

  it('порядок блоков = приоритет (first-wins)', async () => {
    const chain = await buildContext(two)
    expect(chain.get(['shared'])).toBe('from-a') // a раньше b
    expect(chain.get(['a', 'shared'])).toBe('from-a')
    expect(chain.get(['b', 'shared'])).toBe('from-b')
    expect(chain.get(['only_a'])).toBe(1)
    expect(chain.get(['only_b'])).toBe(2)
  })

  it('$chain переопределяет порядок (корневой атрибут)', async () => {
    const chain = await buildContext('$chain: b, a\n\n' + two)
    expect(chain.get(['shared'])).toBe('from-b') // b теперь раньше
  })
})
