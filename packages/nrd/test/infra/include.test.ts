import { describe, it, expect } from 'vitest'
import { fileIncludeResolver } from '../../src/infra/include.js'
import { memoryStorage } from '../../src/web/storage.js'

describe('fileIncludeResolver', () => {
  it('относительно fromPath', async () => {
    const s = memoryStorage()
    await s.write('docs/a.md', 'A')
    await s.write('docs/b.md', 'B')
    const r = fileIncludeResolver({ storage: s })
    expect(await r.resolve('b.md', 'docs/a.md')).toBe('B')
  })

  it('поиск в roots', async () => {
    const s = memoryStorage()
    await s.write('vault/notes/x.md', 'X')
    const r = fileIncludeResolver({ storage: s, roots: ['vault/notes'] })
    expect(await r.resolve('x.md')).toBe('X')
  })

  it('автодобавление расширения', async () => {
    const s = memoryStorage()
    await s.write('vault/page.mdd', 'PAGE')
    const r = fileIncludeResolver({
      storage: s,
      roots: ['vault'],
      extensions: ['.md', '.mdd'],
    })
    expect(await r.resolve('page')).toBe('PAGE')
  })

  it('rootMarkers — поиск рута вверх по дереву', async () => {
    const s = memoryStorage()
    await s.write('proj/.obsidian/config', '')
    await s.write('proj/shared/lib.md', 'LIB')
    const r = fileIncludeResolver({
      storage: s,
      rootMarkers: ['.obsidian'],
    })
    // из глубоко вложенного файла находим маркер вверху и резолвим от него
    expect(await r.resolve('shared/lib.md', 'proj/deep/nested/note.md')).toBe('LIB')
  })

  it('относительный путь приоритетнее roots', async () => {
    const s = memoryStorage()
    await s.write('docs/target.md', 'LOCAL')
    await s.write('root/target.md', 'ROOT')
    const r = fileIncludeResolver({ storage: s, roots: ['root'] })
    expect(await r.resolve('target.md', 'docs/note.md')).toBe('LOCAL')
  })

  it('не найден → undefined', async () => {
    const s = memoryStorage()
    const r = fileIncludeResolver({ storage: s, roots: ['x'], extensions: ['.md'] })
    expect(await r.resolve('ghost')).toBeUndefined()
  })

  it('.. в относительном пути', async () => {
    const s = memoryStorage()
    await s.write('docs/shared.md', 'SHARED')
    await s.write('docs/sub/note.md', 'N')
    const r = fileIncludeResolver({ storage: s })
    expect(await r.resolve('../shared.md', 'docs/sub/note.md')).toBe('SHARED')
  })
})
