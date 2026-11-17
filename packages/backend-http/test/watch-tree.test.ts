import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { watchTree } from '../src/watch-tree.js'
import { createWatchPool } from '../src/watch.js'

const tick = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('watchTree', () => {
  it('видит файл глубоко и в новой папке, пропускает node_modules, close глушит', async () => {
    const root = mkdtempSync(join(tmpdir(), 'watch-tree-'))
    mkdirSync(join(root, 'a/b'), { recursive: true })
    mkdirSync(join(root, 'node_modules/x'), { recursive: true })
    const got: string[] = []
    const w = watchTree(root, (n) => got.push(n))
    await tick()
    writeFileSync(join(root, 'a/b/f.mdz'), '1')
    writeFileSync(join(root, 'node_modules/x/f.mdz'), '1')
    await tick()
    expect(got).toContain('a/b/f.mdz')
    expect(got.some((n) => n.includes('node_modules/x'))).toBe(false)
    mkdirSync(join(root, 'c'))
    await tick()
    writeFileSync(join(root, 'c/g.mdz'), '1')
    await tick()
    expect(got).toContain('c/g.mdz')
    w.close()
    got.length = 0
    writeFileSync(join(root, 'a/b/h.mdz'), '1')
    await tick()
    expect(got).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })

  it('пул: рекурсивный наблюдатель в потоке видит файл глубоко и новую папку, пропускает node_modules', async () => {
    const root = mkdtempSync(join(tmpdir(), 'watch-pool-'))
    mkdirSync(join(root, 'a/b'), { recursive: true })
    mkdirSync(join(root, 'node_modules/x'), { recursive: true })
    const got: string[] = []
    const pool = createWatchPool()
    const h = pool.open(root, true, { onEvent: (n) => got.push(n), onError: () => {} })
    await h.ready
    await tick()
    writeFileSync(join(root, 'a/b/f.mdz'), '1')
    writeFileSync(join(root, 'node_modules/x/f.mdz'), '1')
    mkdirSync(join(root, 'c'))
    await tick(200)
    writeFileSync(join(root, 'c/g.mdz'), '1')
    await tick(200)
    expect(got).toContain('a/b/f.mdz')
    expect(got).toContain('c/g.mdz')
    expect(got.some((n) => n.includes('node_modules/x'))).toBe(false)
    h.close()
    await pool.close()
    rmSync(root, { recursive: true, force: true })
  })
})
