/**
 * watch (workspace-files-spec §1–2): настоящий `fs.watch` рекурсивно. Правки
 * мимо пространства (так пишет агент) видны так же, как свои; шум — свёрнут.
 */

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkspaceUpdateEvent } from '@kerneldreams/ui-protocol'
import { createFsWorkspace, type FsWorkspace, type FsWorkspaceOpts } from '../src/index.js'

const opened: FsWorkspace[] = []
afterEach(() => {
  for (const ws of opened.splice(0)) ws.close()
})

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'backend-fs-watch-')))
}

function open(dir: string, opts: FsWorkspaceOpts = {}): FsWorkspace {
  const ws = createFsWorkspace(dir, { warn: () => {}, ...opts })
  opened.push(ws)
  return ws
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Подписка, копящая события; `settle` — дать FSEvents подняться до первой правки. */
async function subscribe(ws: FsWorkspace): Promise<{ events: WorkspaceUpdateEvent[]; off: () => void; paths: () => string[] }> {
  const events: WorkspaceUpdateEvent[] = []
  const off = ws.watch!((ev) => events.push(ev))
  await delay(150)
  return { events, off, paths: () => [...new Set(events.flatMap((e) => e.paths))] }
}

/** Ждать, пока условие станет истинным (события приходят с задержкой ОС + окно). */
async function until(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('не дождались события watch')
    await delay(25)
  }
}

describe('watch', () => {
  it('правка мимо пространства (как пишет агент) → workspace_update с путём', async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'src'))
    const ws = open(dir)
    const sub = await subscribe(ws)

    writeFileSync(join(dir, 'src', 'agent.ts'), 'export const x = 1\n')
    await until(() => sub.paths().includes('src/agent.ts'))
    expect(sub.events[0]!.type).toBe('workspace_update')
  })

  it('своя атомарная запись: путь есть, временного файла — нет', async () => {
    const dir = tmp()
    const ws = open(dir)
    const sub = await subscribe(ws)

    await ws.write!('notes/a.md', 'x')
    await until(() => sub.paths().includes('notes/a.md'))
    await delay(300)
    expect(sub.paths().some((p) => p.includes('.nr-tmp-'))).toBe(false)
  })

  it('пачка правок за окно — одно событие', async () => {
    const dir = tmp()
    const ws = open(dir, { debounceMs: 300 })
    const sub = await subscribe(ws)

    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `f${i}.txt`), String(i))
    await until(() => sub.paths().includes('f4.txt'))
    await delay(400)
    expect(sub.events).toHaveLength(1)
    expect(sub.events[0]!.paths).toEqual(expect.arrayContaining(['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt']))
  })

  it('.git — не событие; внутри node_modules и .gitignore-каталогов — сам каталог', async () => {
    const dir = tmp()
    mkdirSync(join(dir, '.git'))
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
    mkdirSync(join(dir, 'dist'))
    writeFileSync(join(dir, '.gitignore'), 'dist/\n')
    const ws = open(dir)
    const sub = await subscribe(ws)

    writeFileSync(join(dir, '.git', 'index'), 'x')
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'x')
    writeFileSync(join(dir, 'dist', 'out.js'), 'x')
    writeFileSync(join(dir, 'visible.md'), 'x')
    await until(() => sub.paths().includes('visible.md'))
    await delay(300)

    const paths = sub.paths()
    expect(paths.some((p) => p === '.git' || p.startsWith('.git/'))).toBe(false)
    expect(paths).not.toContain('node_modules/pkg/index.js')
    expect(paths).not.toContain('dist/out.js')
    expect(paths.filter((p) => p.startsWith('node_modules')).every((p) => p === 'node_modules')).toBe(true)
    expect(paths.filter((p) => p.startsWith('dist')).every((p) => p === 'dist')).toBe(true)
  })

  it('больше maxWatchPaths путей — [\'\']', async () => {
    const dir = tmp()
    const ws = open(dir, { maxWatchPaths: 3, debounceMs: 300 })
    const sub = await subscribe(ws)

    for (let i = 0; i < 10; i++) writeFileSync(join(dir, `many${i}.txt`), 'x')
    await until(() => sub.events.length > 0)
    expect(sub.events[0]!.paths).toEqual([''])
  })

  it('удаление в корзину видно: исходный путь и корзина свёрнутой', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'gone.md'), 'x')
    const ws = open(dir)
    const sub = await subscribe(ws)

    await ws.delete!('gone.md')
    await until(() => sub.paths().includes('gone.md'))
    await delay(300)
    expect(sub.paths().filter((p) => p.startsWith('.nr-trash')).every((p) => p === '.nr-trash')).toBe(true)
  })

  it('отписка последнего — событий больше нет; подписчики независимы', async () => {
    const dir = tmp()
    const ws = open(dir)
    const a = await subscribe(ws)
    const b = await subscribe(ws)

    a.off()
    a.off() // повторная отписка — no-op
    writeFileSync(join(dir, 'one.txt'), 'x')
    await until(() => b.paths().includes('one.txt'))
    expect(a.events).toHaveLength(0)

    b.off()
    writeFileSync(join(dir, 'two.txt'), 'x')
    await delay(500)
    expect(b.paths()).not.toContain('two.txt')

    // После полной отписки watch поднимается заново.
    const c = await subscribe(ws)
    writeFileSync(join(dir, 'three.txt'), 'x')
    await until(() => c.paths().includes('three.txt'))
  })

  it('упавший подписчик не мешает остальным', async () => {
    const dir = tmp()
    const warns: string[] = []
    const ws = open(dir, { warn: (m) => warns.push(m) })
    ws.watch!(() => {
      throw new Error('кривой подписчик')
    })
    const sub = await subscribe(ws)

    writeFileSync(join(dir, 'x.txt'), 'x')
    await until(() => sub.paths().includes('x.txt'))
    expect(warns.some((w) => w.includes('кривой подписчик'))).toBe(true)
  })

  it('close — отписывает всех, новый watch после close — throw', async () => {
    const dir = tmp()
    const ws = open(dir)
    const sub = await subscribe(ws)
    ws.close()
    writeFileSync(join(dir, 'after.txt'), 'x')
    await delay(500)
    expect(sub.events).toHaveLength(0)
    expect(() => ws.watch!(() => {})).toThrow(/закрыто/)
    // Операции после close работают — закрывается только watch.
    expect((await ws.list()).map((e) => e.name)).toEqual(['after.txt'])
  })
})
