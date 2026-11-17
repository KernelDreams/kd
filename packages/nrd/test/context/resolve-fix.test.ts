// resolve-fix-spec §1.1–§1.6 — каскад, зависимые источники, `${}` в телах,
// baseDir функций. Дефекты найдены зондами rz (DEBT 08.08), здесь они закрыты
// на уровне пакета; сквозная приёмка — в тестах rz на самих зондах.

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryStorage } from '../../src/web/index.js'
import { objectContext } from '../../src/core/index.js'
import type { IContext } from '../../src/contracts/index.js'
import { buildContext } from '../../src/context/index.js'
// fs-функции ${loadMDD}/${loadJSON} живут на node-ступени (nrd-merge §2.5) и
// приезжают в ядро через opts.privilegedFunctions — корень их больше не импортит.
import { builtinFunctions } from '../../src/node/index.js'

// Конфиги собираем join('\n') — чтобы `${...}` не интерполировался тест-файлом.
function cfg(...lines: string[]): string {
  return lines.join('\n')
}

function storageWith(files: Record<string, string>) {
  const s = memoryStorage()
  return { storage: s, ready: Promise.all(Object.entries(files).map(([p, c]) => s.write(p, c))) }
}

describe('§1.1 — каскад CLI > документ > конфиг > env', () => {
  const doc = cfg('$slug: from-doc', '## $source s', '$nr-type: inline', '$nr-parse: mdz', '$picked: ${slug}')
  const docless = cfg('## $source s', '$nr-type: inline', '$nr-parse: mdz', '$picked: ${slug}')

  const cli: IContext = objectContext({ slug: 'from-cli' })
  const conf: IContext = objectContext({ slug: 'from-config' })

  it('полный каскад на одном ключе', async () => {
    process.env.NRD_CASCADE_SLUG = 'from-env'
    const envLayer = objectContext({ slug: process.env.NRD_CASCADE_SLUG })
    try {
      // 1. все четыре слоя → CLI
      expect(
        (await buildContext(doc, { strongChain: cli, weakChain: conf })).get(['s', 'picked']),
      ).toBe('from-cli')

      // 2. без CLI → документ (раньше здесь побеждал конфиг — это и был дефект)
      expect((await buildContext(doc, { weakChain: conf })).get(['s', 'picked'])).toBe('from-doc')

      // 3. без документа → конфиг
      expect((await buildContext(docless, { weakChain: conf })).get(['s', 'picked'])).toBe(
        'from-config',
      )

      // 4. без конфига → env
      expect((await buildContext(docless, { weakChain: envLayer })).get(['s', 'picked'])).toBe(
        'from-env',
      )
    } finally {
      delete process.env.NRD_CASCADE_SLUG
    }
  })

  it('env из окружения не перебивает атрибут документа', async () => {
    process.env.slug = 'from-env'
    try {
      expect((await buildContext(doc)).get(['s', 'picked'])).toBe('from-doc')
    } finally {
      delete process.env.slug
    }
  })

  it('opts.params сильнее всех слоёв', async () => {
    const chain = await buildContext(doc, {
      strongChain: cli,
      weakChain: conf,
      params: { slug: 'explicit' },
    })
    expect(chain.get(['s', 'picked'])).toBe('explicit')
  })

  it('paramsChain (deprecated) = strongChain: прежнее поведение сохранено', async () => {
    const chain = await buildContext(doc, { paramsChain: cli })
    expect(chain.get(['s', 'picked'])).toBe('from-cli')
  })
})

describe('§1.2 — источник видит предыдущий источник', () => {
  it('путь звена берётся из поля предыдущего звена', async () => {
    const { storage, ready } = storageWith({
      'registry.md': '@active: alice',
      'bots/alice.md': '@name: Alice\n@voice: alto',
    })
    await ready
    const chain = await buildContext(
      cfg(
        '## $source registry',
        '$nr-type: file',
        '$nr-parse: mdd',
        '$path: registry.md',
        '## $source bot',
        '$nr-type: file',
        '$nr-parse: mdd',
        '$path: bots/${registry.active}.md',
      ),
      { storage },
    )
    expect(chain.get(['registry', 'active'])).toBe('alice')
    expect(chain.get(['bot', 'name'])).toBe('Alice')
  })

  it('ссылка ВПЕРЁД — громкая ошибка с именем звена', async () => {
    const { storage, ready } = storageWith({ 'registry.md': '@active: alice' })
    await ready
    await expect(
      buildContext(
        cfg(
          '## $source label',
          '$nr-type: inline',
          '$nr-parse: mdz',
          '$text: ${registry.active}',
          '## $source registry',
          '$nr-type: file',
          '$nr-parse: mdd',
          '$path: registry.md',
        ),
        { storage },
      ),
    ).rejects.toThrow(/source "label" ссылается на "registry", объявленный НИЖЕ/)
  })

  it('ссылка вперёд ловится и внутри аргумента функции', async () => {
    await expect(
      buildContext(
        cfg(
          '## $source a',
          '$nr-type: inline',
          '$nr-parse: mdz',
          '$x: ${readFile(later.path)}',
          '## $source later',
          '$nr-type: inline',
          '$nr-parse: mdz',
          '$path: ./nope',
        ),
      ),
    ).rejects.toThrow(/объявленный НИЖЕ/)
  })

  it('transform видит накопленные звенья в своих атрибутах', async () => {
    const chain = await buildContext(
      cfg(
        '## $source src',
        '$nr-type: inline',
        '$nr-parse: mdz',
        '$who: мир',
        '## $transform t',
        '$nr-type: tag',
        '$label: привет ${src.who}',
      ),
      {
        transforms: {
          tag: {
            name: 'tag',
            async transform(input, attrs) {
              return objectContext({ label: attrs['label'] })
            },
          },
        },
      },
    )
    // transform без `$input` кладётся в цепочку не namespaced (§: результат —
    // глобальное звено высшего приоритета), поэтому ключ верхнеуровневый.
    expect(chain.get(['label'])).toBe('привет мир')
  })
})

describe('§1.3 — ${} в теле источника резолвится', () => {
  const both = cfg(
    '$who: мир',
    '## $source a',
    '$nr-type: inline',
    '$nr-parse: mdd',
    '',
    '@text: привет ${who}',
    '## $source b',
    '$nr-type: inline',
    '$text: привет ${who}',
  )

  it('инвариант: телесная и атрибутная формы дают одинаковый результат', async () => {
    const chain = await buildContext(both)
    expect(chain.get(['a', 'text'])).toBe('привет мир')
    expect(chain.get(['b', 'text'])).toBe(chain.get(['a', 'text']))
  })

  it('значение не утекает объектом (было [object Object] / {})', async () => {
    const chain = await buildContext(both)
    const v = chain.get(['a', 'text'])
    expect(typeof v).toBe('string')
    expect(JSON.stringify(v)).toBe('"привет мир"')
  })

  it('тело видит предыдущее звено', async () => {
    const chain = await buildContext(
      cfg(
        '## $source registry',
        '$nr-type: inline',
        '$nr-parse: mdz',
        '$active: alice',
        '## $source label',
        '$nr-type: inline',
        '$nr-parse: mdd',
        '',
        '@text: активен ${registry.active}',
      ),
    )
    expect(chain.get(['label', 'text'])).toBe('активен alice')
  })

  it('file-источник: конфиг с ${} резолвится об внешнюю цепочку', async () => {
    const { storage, ready } = storageWith({ 'conf.mdz': '$greeting: привет ${who}' })
    await ready
    const chain = await buildContext(
      cfg('$who: мир', '## $source c', '$nr-type: file', '$nr-parse: mdz', '$path: conf.mdz'),
      { storage },
    )
    expect(chain.get(['c', 'greeting'])).toBe('привет мир')
  })

  it('собственный ключ документа сильнее внешнего', async () => {
    const chain = await buildContext(
      cfg(
        '$who: снаружи',
        '## $source a',
        '$nr-type: inline',
        '$nr-parse: mdd',
        '',
        '@who: изнутри',
        '@text: привет ${who}',
      ),
    )
    expect(chain.get(['a', 'text'])).toBe('привет изнутри')
  })
})

describe('§1.5/§1.6 — функции: baseDir, дерево, path после вызова', () => {
  let dir: string
  const files = () => {
    dir = mkdtempSync(join(tmpdir(), 'nrd-fn-'))
    writeFileSync(join(dir, 'preset.json'), JSON.stringify({ temperature: 0.9, style: 'json' }))
    writeFileSync(join(dir, 'lore.md'), '@city: Мидленд')
    return dir
  }

  it('относительный путь резолвится от baseDir документа, не от cwd', async () => {
    const base = files()
    try {
      const chain = await buildContext(
        cfg('## $source bot', '$nr-type: inline', '$nr-parse: mdz', "$lore: ${loadMDD('./lore.md')}"),
        { baseDir: base, privilegedFunctions: builtinFunctions },
      )
      expect(chain.get(['bot', 'lore', 'city'])).toBe('Мидленд')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('дерево из функции не схлопывается в строку, поле адресуется', async () => {
    const base = files()
    try {
      const chain = await buildContext(
        cfg(
          '## $source bot',
          '$nr-type: inline',
          '$nr-parse: mdz',
          "$preset: ${loadJSON('./preset.json')}",
          "$temp: ${loadJSON('./preset.json').temperature}",
        ),
        { baseDir: base, privilegedFunctions: builtinFunctions },
      )
      expect(chain.get(['bot', 'preset', 'temperature'])).toBe(0.9)
      expect(chain.get(['bot', 'preset', 'style'])).toBe('json')
      expect(chain.get(['bot', 'temp'])).toBe('0.9')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('функции доступны и в ТЕЛЕ звена, и в корневом атрибуте', async () => {
    const base = files()
    try {
      const chain = await buildContext(
        cfg(
          "$city: ${loadMDD('./lore.md').city}",
          '## $source bot',
          '$nr-type: inline',
          '$nr-parse: mdz',
          '',
          "$preset: ${loadJSON('./preset.json')}",
        ),
        { baseDir: base, privilegedFunctions: builtinFunctions },
      )
      expect(chain.get(['bot', 'preset', 'temperature'])).toBe(0.9)
      expect(chain.get(['city'])).toBeUndefined() // корневые атрибуты не в chain…
      const withParam = await buildContext(
        cfg("$city: ${loadMDD('./lore.md').city}", '## $source s', '$nr-type: inline', '$nr-parse: mdz', '$c: ${city}'),
        { baseDir: base, privilegedFunctions: builtinFunctions },
      )
      expect(withParam.get(['s', 'c'])).toBe('Мидленд') // …но как параметр — да
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('untrusted не получает FS-функций', async () => {
    const base = files()
    try {
      const chain = await buildContext(
        cfg('## $source bot', '$nr-type: inline', '$nr-parse: mdz', "$lore: ${loadMDD('./lore.md')}"),
        { baseDir: base, trusted: false, privilegedFunctions: builtinFunctions },
      )
      expect(chain.get(['bot', 'lore', 'city'])).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
