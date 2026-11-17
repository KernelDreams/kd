import { describe, it, expect } from 'vitest'
import { memoryStorage } from '../../src/web/index.js'
import { buildContext, chainSources } from '../../src/context/index.js'
import { fileSource } from '../../src/context/builtins/index.js'

function cfg(...lines: string[]): string {
  return lines.join('\n')
}

function storageWith(files: Record<string, string>) {
  const s = memoryStorage()
  return { storage: s, ready: Promise.all(Object.entries(files).map(([p, c]) => s.write(p, c))) }
}

describe('file source', () => {
  it('mdd parse, $path относительно baseDir (storage)', async () => {
    const { storage, ready } = storageWith({ 'bots/luna.mdd': '@name: Luna\n@mood: warm' })
    await ready
    const chain = await buildContext(
      cfg('## $source bot', '$nr-type: file', '$path: bots/luna.mdd', '$nr-parse: mdd'),
      { storage },
    )
    expect(chain.get(['bot', 'name'])).toBe('Luna')
    expect(chain.get(['bot', 'mood'])).toBe('warm')
  })

  it('mdz parse', async () => {
    const { storage, ready } = storageWith({ 'world.mdz': '$realm: Eldoria\n$era: third' })
    await ready
    const chain = await buildContext(
      cfg('## $source lore', '$nr-type: file', '$path: world.mdz', '$nr-parse: mdz'),
      { storage },
    )
    expect(chain.get(['lore', 'realm'])).toBe('Eldoria')
  })

  it('json parse', async () => {
    const { storage, ready } = storageWith({ 'cfg.json': JSON.stringify({ model: 'gpt', n: 3 }) })
    await ready
    const chain = await buildContext(
      cfg('## $source c', '$nr-type: file', '$path: cfg.json', '$nr-parse: json'),
      { storage },
    )
    expect(chain.get(['c', 'model'])).toBe('gpt')
    expect(chain.get(['c', 'n'])).toBe(3)
  })

  it('text parse (default)', async () => {
    const { storage, ready } = storageWith({ 'note.txt': 'raw content here' })
    await ready
    const chain = await buildContext(cfg('## $source t', '$nr-type: file', '$path: note.txt'), { storage })
    expect(chain.get(['t', 'content'])).toBe('raw content here')
  })

  it('json source (shorthand)', async () => {
    const { storage, ready } = storageWith({ 'c.json': JSON.stringify({ a: 1 }) })
    await ready
    const chain = await buildContext(cfg('## $source c', '$nr-type: json', '$path: c.json'), { storage })
    expect(chain.get(['c', 'a'])).toBe(1)
  })

  it('$path с ${param}', async () => {
    const { storage, ready } = storageWith({ 'bots/alice.mdd': '@name: Alice' })
    await ready
    const chain = await buildContext(
      cfg('$who: alice', '## $source bot', '$nr-type: file', '$path: bots/${who}.mdd', '$nr-parse: mdd'),
      { storage },
    )
    expect(chain.get(['bot', 'name'])).toBe('Alice')
  })

  it('без storage в ctx → понятная ошибка', async () => {
    const c = cfg('## $source bot', '$nr-type: file', '$path: x.mdd', '$nr-parse: mdd')
    await expect(buildContext(c)).rejects.toThrow(/storage/)
  })
})

describe('chainSources — программная сборка (§5.4)', () => {
  it('плагины и attrs передаются кодом', async () => {
    const { storage, ready } = storageWith({ 'bot.mdd': '@name: Code' })
    await ready
    const chain = await chainSources(
      [{ name: 'bot', plugin: fileSource, attrs: { 'nr-type': 'file', path: 'bot.mdd', 'nr-parse': 'mdd' } }],
      { storage },
    )
    expect(chain.get(['bot', 'name'])).toBe('Code')
  })
})
