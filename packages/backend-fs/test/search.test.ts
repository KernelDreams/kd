/**
 * search (протокол v1.28) и mountWorkspaces: оба пути поиска (rg из
 * PATH и обход на node) отвечают одинаково — regex, регистр, glob, игнор.
 */

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileBadRequestError } from '@kerneldreams/ui-protocol'
import { createFsWorkspace, findRg, mountWorkspaces, type FsWorkspace, type FsWorkspaceOpts } from '../src/index.js'

const opened: FsWorkspace[] = []
afterEach(() => {
  for (const ws of opened.splice(0)) ws.close()
})

function tree(files: Record<string, string | Uint8Array>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'backend-fs-search-')))
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, ...path.split('/'))
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  return dir
}

function open(dir: string, opts: FsWorkspaceOpts = {}): FsWorkspace {
  const ws = createFsWorkspace(dir, { warn: () => {}, watch: false, ...opts })
  opened.push(ws)
  return ws
}

const FILES = {
  'README.md': '# Readme\nprune the tree\nnothing\n',
  'docs/a.md': 'line one\nPrune with case\n',
  'docs/b.mdz': '## $step\n$prune: true\n',
  'src/x.ts': 'const prune = 1\n',
  'node_modules/dep/index.js': 'prune in deps\n',
  '.git/HEAD': 'prune in git\n',
  '.gitignore': 'build/\n*.log\n',
  'build/out.js': 'prune built\n',
  'debug.log': 'prune log\n',
  '.nr-trash/old.md': 'prune trashed\n',
  'bin.dat': new Uint8Array([0, 1, 2, 112, 114, 117, 110, 101]),
}

const modes: Array<[string, FsWorkspaceOpts['search']]> = [['node', { rg: false }]]
if (findRg()) modes.push(['rg', true])

describe.each(modes)('search (%s)', (_name, search) => {
  it('подстрока без регистра; игнор: .git, node_modules, .gitignore, корзина, бинарное', async () => {
    const ws = open(tree(FILES), { search })
    expect(ws.capability.search).toBe(true)
    const hits = await ws.search!({ query: 'prune' })
    expect(hits.map((h) => `${h.path}:${h.line}`)).toEqual(['README.md:2', 'docs/a.md:2', 'docs/b.mdz:2', 'src/x.ts:1'])
    expect(hits[0]).toMatchObject({ text: 'prune the tree', column: 1 })
  })
  it('case, regex, glob, limit', async () => {
    const ws = open(tree(FILES), { search })
    expect((await ws.search!({ query: 'Prune', case: true })).map((h) => h.path)).toEqual(['docs/a.md'])
    expect((await ws.search!({ query: '^\\$prune:\\s', regex: true })).map((h) => h.path)).toEqual(['docs/b.mdz'])
    expect((await ws.search!({ query: 'prune', glob: '*.md' })).map((h) => h.path)).toEqual(['README.md', 'docs/a.md'])
    expect((await ws.search!({ query: 'prune', glob: 'docs/*' })).map((h) => h.path)).toEqual(['docs/a.md', 'docs/b.mdz'])
    expect(await ws.search!({ query: 'prune', limit: 2 })).toHaveLength(2)
  })
  it('JS-regex, которого нет в диалекте rg (lookbehind), — тот же ответ', async () => {
    const ws = open(tree(FILES), { search })
    expect((await ws.search!({ query: '(?<=const )prune', regex: true })).map((h) => h.path)).toEqual(['src/x.ts'])
  })
  it('битый regex и пустой запрос — bad_request', async () => {
    const ws = open(tree(FILES), { search })
    await expect(ws.search!({ query: '(', regex: true })).rejects.toBeInstanceOf(FileBadRequestError)
    await expect(ws.search!({ query: '' })).rejects.toBeInstanceOf(FileBadRequestError)
  })
})

describe.each(modes)('вложенная репа под .gitignore родителя (%s, ABC-295)', (_name, search) => {
  it('не игнорируется: в дереве, в поиске; её свои правила — действуют', async () => {
    const dir = tree({
      '.gitignore': '/pkg/\n',
      'pkg/.git/HEAD': 'ref\n',
      'pkg/.gitignore': 'dist/\n',
      'pkg/src/a.ts': 'const prune = 1\n',
      'pkg/dist/a.js': 'prune built\n',
      'junk/.gitignore': '',
    })
    const ws = open(dir, { search })
    expect((await ws.list()).find((e) => e.path === 'pkg')?.ignored).toBeUndefined()
    expect((await ws.search!({ query: 'prune' })).map((h) => h.path)).toEqual(['pkg/src/a.ts'])
  })
})

describe('search: гейт', () => {
  it('search: false — ни метода, ни флага', () => {
    const ws = open(tree({ 'a.md': 'x' }), { search: false })
    expect(ws.search).toBeUndefined()
    expect(ws.capability.search).toBeUndefined()
  })
})

describe('mountWorkspaces', () => {
  function pair(): FsWorkspace {
    const main = open(tree({ 'README.md': 'prune main\n', 'ctx/shadowed.md': 'x' }))
    const ctx = open(tree({ 'HANDOFF.md': '# Handoff\nprune ctx\n', 'specs/s.md': 'see [[core]]\n' }))
    return mountWorkspaces(main, { ctx })
  }
  it('подключение — папка в корне, перекрывает одноимённую', async () => {
    const ws = pair()
    const root = await ws.list()
    expect(root.map((e) => `${e.kind}:${e.path}`)).toEqual(['dir:ctx', 'file:README.md'])
    expect((await ws.list('ctx')).map((e) => e.path)).toEqual(['ctx/specs', 'ctx/HANDOFF.md'])
    expect((await ws.read('ctx/HANDOFF.md')).path).toBe('ctx/HANDOFF.md')
    expect(await ws.stat!('ctx')).toMatchObject({ kind: 'dir', path: 'ctx' })
  })
  it('запись — в своё пространство; корень подключения и перенос между корнями — bad_request', async () => {
    const ws = pair()
    const read = await ws.read('ctx/HANDOFF.md')
    await ws.write!('ctx/HANDOFF.md', 'new', { revision: read.revision })
    expect((await ws.read('ctx/HANDOFF.md')).content).toBe('new')
    await expect(ws.delete!('ctx')).rejects.toBeInstanceOf(FileBadRequestError)
    await expect(ws.rename!('README.md', 'ctx/README.md')).rejects.toBeInstanceOf(FileBadRequestError)
  })
  it('поиск по всем корням с префиксами; glob с / — по пути пространства', async () => {
    const ws = pair()
    expect((await ws.search!({ query: 'prune' })).map((h) => h.path)).toEqual(['README.md', 'ctx/HANDOFF.md'])
    expect((await ws.search!({ query: 'prune', glob: 'ctx/*.md' })).map((h) => h.path)).toEqual(['ctx/HANDOFF.md'])
    expect((await ws.search!({ query: '[[core]]' })).map((h) => h.path)).toEqual(['ctx/specs/s.md'])
  })
})
