/**
 * createFsWorkspace (workspace-files-spec §1–2) против настоящих временных
 * каталогов: пути и симлинки, list/read/write/delete/rename/stat, ревизии,
 * корзина, гейты capability.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_FILE_READ_MAX_BYTES, FileBadRequestError, FileConflictError, FileNotFoundError } from '@kerneldreams/ui-protocol'
import { createFsWorkspace, type FsWorkspace, type FsWorkspaceOpts } from '../src/index.js'

const opened: FsWorkspace[] = []
afterEach(() => {
  for (const ws of opened.splice(0)) ws.close()
})

function tmp(tag = 'ws'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `backend-fs-${tag}-`)))
}

/** Каталог с файлами: `{путь: содержимое}`; путь с `/` в конце — пустой каталог. */
function tree(files: Record<string, string | Uint8Array>, dir = tmp()): string {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, ...path.split('/'))
    if (path.endsWith('/')) {
      mkdirSync(abs, { recursive: true })
      continue
    }
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  return dir
}

function open(dir: string, opts: FsWorkspaceOpts = {}): FsWorkspace {
  const ws = createFsWorkspace(dir, { warn: () => {}, ...opts })
  opened.push(ws)
  return ws
}

const errOf = (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e)

// ────────────────────────────────────────────────────────────────────────────
// Сборка и гейты
// ────────────────────────────────────────────────────────────────────────────

describe('createFsWorkspace', () => {
  it('по умолчанию — всё: write, watch и search, методы на месте', () => {
    const ws = open(tmp())
    expect(ws.capability).toEqual({ write: true, watch: true, search: true })
    for (const m of ['list', 'read', 'stat', 'write', 'delete', 'rename', 'watch', 'search'] as const) {
      expect(typeof ws[m], m).toBe('function')
    }
  })

  it('write:false — мутаций нет ни в capability, ни методами', () => {
    const ws = open(tmp(), { write: false })
    expect(ws.capability).toEqual({ watch: true, search: true })
    expect(ws.write).toBeUndefined()
    expect(ws.delete).toBeUndefined()
    expect(ws.rename).toBeUndefined()
  })

  it('watch:false — метода watch нет', () => {
    const ws = open(tmp(), { watch: false, write: false, search: false })
    expect(ws.capability).toEqual({})
    expect(ws.watch).toBeUndefined()
  })

  it('корень — настоящий путь; нет каталога или это файл — throw', () => {
    const dir = tmp()
    expect(open(dir).root).toBe(dir)
    expect(() => createFsWorkspace(join(dir, 'нет'))).toThrow(/корня пространства/)
    writeFileSync(join(dir, 'f'), 'x')
    expect(() => createFsWorkspace(join(dir, 'f'))).toThrow(/не каталог/)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Пути и симлинки — SSRF-подобные проверки
// ────────────────────────────────────────────────────────────────────────────

describe('пути', () => {
  it('.., абсолютные, обратный слэш — bad_request во всех операциях', async () => {
    const ws = open(tree({ 'a.md': 'x' }))
    for (const bad of ['../x', '/etc/passwd', 'a\\b', 'x/../../y']) {
      expect(await errOf(ws.list(bad)), bad).toBeInstanceOf(FileBadRequestError)
      expect(await errOf(ws.read(bad)), bad).toBeInstanceOf(FileBadRequestError)
      expect(await errOf(ws.stat!(bad)), bad).toBeInstanceOf(FileBadRequestError)
      expect(await errOf(ws.write!(bad, 'x')), bad).toBeInstanceOf(FileBadRequestError)
      expect(await errOf(ws.delete!(bad)), bad).toBeInstanceOf(FileBadRequestError)
      expect(await errOf(ws.rename!('a.md', bad)), bad).toBeInstanceOf(FileBadRequestError)
    }
  })

  it('симлинк на файл снаружи — bad_request на read/stat/write, в list его нет', async () => {
    const outside = tree({ 'secret.txt': 'ТАЙНА' }, tmp('outside'))
    const dir = tree({ 'a.md': 'x' })
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'leak.txt'))
    const ws = open(dir)

    expect(await errOf(ws.read('leak.txt'))).toBeInstanceOf(FileBadRequestError)
    expect(await errOf(ws.stat!('leak.txt'))).toBeInstanceOf(FileBadRequestError)
    expect(await errOf(ws.write!('leak.txt', 'перезаписал'))).toBeInstanceOf(FileBadRequestError)
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('ТАЙНА')
    expect((await ws.list()).map((e) => e.name)).toEqual(['a.md'])
  })

  it('симлинк на каталог снаружи — ни list, ни read, ни запись внутрь', async () => {
    const outside = tree({ 'x.txt': 'x' }, tmp('outside'))
    const dir = tmp()
    symlinkSync(outside, join(dir, 'ext'))
    const ws = open(dir)

    expect(await errOf(ws.list('ext'))).toBeInstanceOf(FileBadRequestError)
    expect(await errOf(ws.read('ext/x.txt'))).toBeInstanceOf(FileBadRequestError)
    expect(await errOf(ws.write!('ext/new.txt', 'x'))).toBeInstanceOf(FileBadRequestError)
    expect(existsSync(join(outside, 'new.txt'))).toBe(false)
    expect(await ws.list()).toEqual([])
  })

  it('битая ссылка наружу — запись сквозь неё bad_request, файл снаружи не появился', async () => {
    const outside = tmp('outside')
    const dir = tmp()
    symlinkSync(join(outside, 'будет.txt'), join(dir, 'dangling.txt'))
    symlinkSync(join(outside, 'нет-каталога'), join(dir, 'dangling-dir'))
    const ws = open(dir)

    expect(await errOf(ws.write!('dangling.txt', 'x'))).toBeInstanceOf(FileBadRequestError)
    expect(await errOf(ws.write!('dangling-dir/a.txt', 'x'))).toBeInstanceOf(FileBadRequestError)
    expect(await errOf(ws.read('dangling.txt'))).toBeInstanceOf(FileBadRequestError)
    expect(readdirSync(outside)).toEqual([])
  })

  it('симлинки внутри пространства работают: чтение и запись в цель', async () => {
    const dir = tree({ 'real/doc.md': 'оригинал' })
    symlinkSync(join(dir, 'real'), join(dir, 'alias'))
    symlinkSync(join(dir, 'real', 'doc.md'), join(dir, 'doc-link.md'))
    const ws = open(dir)

    expect((await ws.read('alias/doc.md')).content).toBe('оригинал')
    const { revision } = await ws.read('doc-link.md')
    await ws.write!('doc-link.md', 'правка', { revision })
    expect(readFileSync(join(dir, 'real', 'doc.md'), 'utf8')).toBe('правка')
    await ws.write!('alias/new.md', 'новый')
    expect(readFileSync(join(dir, 'real', 'new.md'), 'utf8')).toBe('новый')
    expect((await ws.list()).map((e) => [e.name, e.kind])).toEqual([
      ['alias', 'dir'],
      ['real', 'dir'],
      ['doc-link.md', 'file'],
    ])
  })
})

// ────────────────────────────────────────────────────────────────────────────
// list / stat
// ────────────────────────────────────────────────────────────────────────────

describe('list', () => {
  it('один уровень, каталоги первыми, поля узлов', async () => {
    const dir = tree({ 'b.md': '# b', 'a.ts': 'x', 'src/index.ts': '', 'empty/': '' })
    const ws = open(dir)
    const list = await ws.list()

    expect(list.map((e) => e.path)).toEqual(['empty', 'src', 'a.ts', 'b.md'])
    const b = list.find((e) => e.name === 'b.md')!
    expect(b).toMatchObject({ name: 'b.md', path: 'b.md', kind: 'file', size: 3, mime: 'text/markdown' })
    expect(new Date(b.mtime!).getTime()).toBeCloseTo(statSync(join(dir, 'b.md')).mtimeMs, -2)
    const src = list.find((e) => e.name === 'src')!
    expect(src.kind).toBe('dir')
    expect(src.size).toBeUndefined()
    expect(src.ignored).toBeUndefined()

    expect(await ws.list('src')).toMatchObject([{ name: 'index.ts', path: 'src/index.ts', kind: 'file' }])
    expect(await ws.list('./src/')).toEqual(await ws.list('src'))
  })

  it('ignored: .git, node_modules, .gitignore корня и вложенный; узлы в списке есть', async () => {
    const dir = tree({
      '.gitignore': 'dist/\n*.log\n!keep.log\n',
      '.git/HEAD': 'ref',
      'node_modules/x/index.js': '',
      'dist/out.js': '',
      'app.log': '',
      'keep.log': '',
      'pkg/.gitignore': 'gen/',
      'pkg/gen/a.ts': '',
      'pkg/src.ts': '',
    })
    const ws = open(dir)
    const flags = Object.fromEntries((await ws.list()).map((e) => [e.name, e.ignored === true]))
    expect(flags).toEqual({
      '.git': true,
      dist: true,
      node_modules: true,
      pkg: false,
      '.gitignore': false,
      'app.log': true,
      'keep.log': false,
    })
    expect(Object.fromEntries((await ws.list('pkg')).map((e) => [e.name, e.ignored === true]))).toEqual({
      gen: true,
      '.gitignore': false,
      'src.ts': false,
    })
    expect((await ws.list('dist'))[0]).toMatchObject({ path: 'dist/out.js', ignored: true })
  })

  it('.gitignore перечитывается после правки', async () => {
    const dir = tree({ '.gitignore': '', 'a.log': '' })
    const ws = open(dir)
    expect((await ws.list()).find((e) => e.name === 'a.log')!.ignored).toBeUndefined()
    await ws.write!('.gitignore', '*.log\n')
    expect((await ws.list()).find((e) => e.name === 'a.log')!.ignored).toBe(true)
  })

  it('нет каталога — not_found, файл — bad_request', async () => {
    const ws = open(tree({ 'a.md': 'x' }))
    expect(await errOf(ws.list('нет'))).toBeInstanceOf(FileNotFoundError)
    expect(await errOf(ws.list('a.md'))).toBeInstanceOf(FileBadRequestError)
  })
})

describe('stat', () => {
  it('файл, каталог, корень', async () => {
    const dir = tree({ 'docs/a.md': 'hello' })
    const ws = open(dir)
    expect(await ws.stat!('docs/a.md')).toMatchObject({ name: 'a.md', path: 'docs/a.md', kind: 'file', size: 5 })
    expect(await ws.stat!('docs')).toMatchObject({ name: 'docs', path: 'docs', kind: 'dir' })
    expect(await ws.stat!('')).toMatchObject({ name: basename(dir), path: '', kind: 'dir' })
    expect(await errOf(ws.stat!('нет.md'))).toBeInstanceOf(FileNotFoundError)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// read
// ────────────────────────────────────────────────────────────────────────────

describe('read', () => {
  it('текст UTF-8: content, size, mime, revision = size:mtimeMs', async () => {
    const dir = tree({ 'notes/привет.md': '# Привет' })
    const ws = open(dir)
    const st = statSync(join(dir, 'notes', 'привет.md'))
    expect(await ws.read('notes/привет.md')).toEqual({
      path: 'notes/привет.md',
      content: '# Привет',
      encoding: 'utf8',
      size: st.size,
      mime: 'text/markdown',
      revision: `${st.size}:${st.mtimeMs}`,
    })
  })

  it('бинарь — base64', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255])
    const ws = open(tree({ 'img.png': bytes }))
    const c = await ws.read('img.png')
    expect(c.encoding).toBe('base64')
    expect(Buffer.from(c.content, 'base64')).toEqual(Buffer.from(bytes))
    expect(c.mime).toBe('image/png')
  })

  it('больше лимита — bad_request с размером; лимит по умолчанию 2 МБ', async () => {
    const ws = open(tree({ 'big.txt': 'x'.repeat(DEFAULT_FILE_READ_MAX_BYTES + 1), 'small.txt': 'x'.repeat(11) }))
    const err = await errOf(ws.read('big.txt'))
    expect(err).toBeInstanceOf(FileBadRequestError)
    expect((err as Error).message).toContain(String(DEFAULT_FILE_READ_MAX_BYTES + 1))
    expect(await errOf(ws.read('small.txt', { maxBytes: 10 }))).toBeInstanceOf(FileBadRequestError)
    expect((await ws.read('small.txt', { maxBytes: 11 })).size).toBe(11)
    expect(await errOf(ws.read('small.txt', { maxBytes: -1 }))).toBeInstanceOf(FileBadRequestError)
  })

  it('каталог — bad_request, нет файла — not_found', async () => {
    const ws = open(tree({ 'd/a.md': '' }))
    expect(await errOf(ws.read('d'))).toBeInstanceOf(FileBadRequestError)
    expect(await errOf(ws.read('d/нет.md'))).toBeInstanceOf(FileNotFoundError)
    expect(await errOf(ws.read(''))).toBeInstanceOf(FileBadRequestError)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// write
// ────────────────────────────────────────────────────────────────────────────

describe('write', () => {
  it('revision:null — создать; уже есть — conflict', async () => {
    const dir = tmp()
    const ws = open(dir)
    const { revision } = await ws.write!('new/deep/a.md', 'раз', { revision: null })
    expect(readFileSync(join(dir, 'new', 'deep', 'a.md'), 'utf8')).toBe('раз')
    expect(revision).toBe((await ws.read('new/deep/a.md')).revision)

    const err = await errOf(ws.write!('new/deep/a.md', 'два', { revision: null }))
    expect(err).toBeInstanceOf(FileConflictError)
    expect((err as FileConflictError).code).toBe('conflict')
    expect(readFileSync(join(dir, 'new', 'deep', 'a.md'), 'utf8')).toBe('раз')
  })

  it('revision из read: совпал — запись и новая ревизия; разошёлся — conflict', async () => {
    const dir = tree({ 'a.md': 'v1' })
    const ws = open(dir)
    const read1 = await ws.read('a.md')
    const { revision: rev2 } = await ws.write!('a.md', 'v2 длиннее', { revision: read1.revision })
    expect(rev2).not.toBe(read1.revision)

    // Клиент со старой ревизией не затирает чужую правку.
    expect(await errOf(ws.write!('a.md', 'затёр', { revision: read1.revision }))).toBeInstanceOf(FileConflictError)
    expect(readFileSync(join(dir, 'a.md'), 'utf8')).toBe('v2 длиннее')

    // Правка мимо пространства (агент, редактор) — тоже conflict.
    writeFileSync(join(dir, 'a.md'), 'снаружи, другой длины')
    expect(await errOf(ws.write!('a.md', 'затёр', { revision: rev2 }))).toBeInstanceOf(FileConflictError)
  })

  it('revision, а файла больше нет — conflict', async () => {
    const dir = tree({ 'a.md': 'x' })
    const ws = open(dir)
    const { revision } = await ws.read('a.md')
    await ws.delete!('a.md')
    expect(await errOf(ws.write!('a.md', 'y', { revision }))).toBeInstanceOf(FileConflictError)
  })

  it('без revision — пишет как есть; base64 — байтами', async () => {
    const dir = tree({ 'a.md': 'old' })
    const ws = open(dir)
    await ws.write!('a.md', 'new')
    expect(readFileSync(join(dir, 'a.md'), 'utf8')).toBe('new')
    await ws.write!('bin/x.bin', Buffer.from([0, 1, 254]).toString('base64'), { encoding: 'base64' })
    expect([...readFileSync(join(dir, 'bin', 'x.bin'))]).toEqual([0, 1, 254])
    expect(await errOf(ws.write!('c.bin', '%%%', { encoding: 'base64' }))).toBeInstanceOf(FileBadRequestError)
  })

  it('атомарно: временных файлов не остаётся, права файла сохраняются', async () => {
    const dir = tree({ 'run.sh': '#!/bin/sh\n' })
    chmodSync(join(dir, 'run.sh'), 0o755)
    const ws = open(dir)
    await ws.write!('run.sh', '#!/bin/sh\necho hi\n')
    expect(statSync(join(dir, 'run.sh')).mode & 0o777).toBe(0o755)
    expect(readdirSync(dir)).toEqual(['run.sh'])
  })

  it('параллельные записи с одной ревизией: одна проходит, вторая conflict', async () => {
    const dir = tree({ 'a.md': 'base' })
    const ws = open(dir)
    const { revision } = await ws.read('a.md')
    const results = await Promise.all([
      errOf(ws.write!('a.md', 'первый клиент', { revision })),
      errOf(ws.write!('a.md', 'второй клиент — длиннее', { revision })),
    ])
    expect(results.filter((r) => r === null)).toHaveLength(1)
    expect(results.filter((r) => r instanceof FileConflictError)).toHaveLength(1)
  })

  it('каталог, корень, корзина, файл вместо каталога — bad_request', async () => {
    const ws = open(tree({ 'd/a.md': '', 'f.md': '' }))
    expect(await errOf(ws.write!('d', 'x'))).toBeInstanceOf(FileBadRequestError)
    expect(await errOf(ws.write!('', 'x'))).toBeInstanceOf(FileBadRequestError)
    expect(await errOf(ws.write!('.nr-trash/a.md', 'x'))).toBeInstanceOf(FileBadRequestError)
    expect(await errOf(ws.write!('f.md/x.md', 'x'))).toBeInstanceOf(FileBadRequestError)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// delete / rename
// ────────────────────────────────────────────────────────────────────────────

describe('delete', () => {
  it('в .nr-trash с сохранением пути; повтор — с суффиксом времени', async () => {
    const dir = tree({ 'docs/a.md': 'раз' })
    const ws = open(dir)
    await ws.delete!('docs/a.md')
    expect(existsSync(join(dir, 'docs', 'a.md'))).toBe(false)
    expect(readFileSync(join(dir, '.nr-trash', 'docs', 'a.md'), 'utf8')).toBe('раз')

    await ws.write!('docs/a.md', 'два')
    await ws.delete!('docs/a.md')
    const trashed = readdirSync(join(dir, '.nr-trash', 'docs')).sort()
    expect(trashed).toHaveLength(2)
    expect(trashed[0]).toBe('a.md')
    expect(trashed[1]).toMatch(/^a\.md\.\d{4}-/)
  })

  it('каталог целиком; корзина видна в list помеченной', async () => {
    const dir = tree({ 'src/a.ts': '', 'src/b.ts': '' })
    const ws = open(dir)
    await ws.delete!('src')
    expect(readdirSync(join(dir, '.nr-trash', 'src')).sort()).toEqual(['a.ts', 'b.ts'])
    expect(await ws.list()).toMatchObject([{ name: '.nr-trash', kind: 'dir', ignored: true }])
  })

  it('путь упёрся в файл корзины — отдельный каталог времени', async () => {
    const dir = tree({ a: 'файл', 'x/y.md': '' })
    const ws = open(dir)
    await ws.delete!('a')
    await ws.write!('a/b.md', 'внутри')
    await ws.delete!('a/b.md')
    const stamps = readdirSync(join(dir, '.nr-trash')).filter((n) => n !== 'a')
    expect(stamps).toHaveLength(1)
    expect(readFileSync(join(dir, '.nr-trash', stamps[0]!, 'a', 'b.md'), 'utf8')).toBe('внутри')
  })

  it('ссылка удаляется сама, не цель', async () => {
    const dir = tree({ 'real.md': 'цель' })
    symlinkSync(join(dir, 'real.md'), join(dir, 'link.md'))
    const ws = open(dir)
    await ws.delete!('link.md')
    expect(readFileSync(join(dir, 'real.md'), 'utf8')).toBe('цель')
    expect(existsSync(join(dir, 'link.md'))).toBe(false)
  })

  it('нет — not_found; корень и корзина — bad_request', async () => {
    const ws = open(tmp())
    expect(await errOf(ws.delete!('нет.md'))).toBeInstanceOf(FileNotFoundError)
    expect(await errOf(ws.delete!(''))).toBeInstanceOf(FileBadRequestError)
    expect(await errOf(ws.delete!('.nr-trash'))).toBeInstanceOf(FileBadRequestError)
  })
})

describe('rename', () => {
  it('файл и каталог, родители создаются', async () => {
    const dir = tree({ 'a.md': 'a', 'src/x.ts': 'x' })
    const ws = open(dir)
    await ws.rename!('a.md', 'docs/new/b.md')
    expect(readFileSync(join(dir, 'docs', 'new', 'b.md'), 'utf8')).toBe('a')
    await ws.rename!('src', 'lib')
    expect(readFileSync(join(dir, 'lib', 'x.ts'), 'utf8')).toBe('x')
    expect(existsSync(join(dir, 'src'))).toBe(false)
  })

  it('цель занята — conflict, ничего не тронуто', async () => {
    const dir = tree({ 'a.md': 'a', 'b.md': 'b' })
    const ws = open(dir)
    expect(await errOf(ws.rename!('a.md', 'b.md'))).toBeInstanceOf(FileConflictError)
    expect(readFileSync(join(dir, 'b.md'), 'utf8')).toBe('b')
    expect(readFileSync(join(dir, 'a.md'), 'utf8')).toBe('a')
  })

  it('смена регистра имени — не конфликт с самим собой', async () => {
    const dir = tree({ 'readme.md': 'r' })
    const ws = open(dir)
    await ws.rename!('readme.md', 'README.md')
    expect(readdirSync(dir)).toEqual(['README.md'])
  })

  it('нет источника — not_found; внутрь себя, в корзину, корень — bad_request; тот же путь — no-op', async () => {
    const ws = open(tree({ 'd/a.md': '' }))
    expect(await errOf(ws.rename!('нет.md', 'x.md'))).toBeInstanceOf(FileNotFoundError)
    expect(await errOf(ws.rename!('d', 'd/sub'))).toBeInstanceOf(FileBadRequestError)
    expect(await errOf(ws.rename!('d/a.md', '.nr-trash/a.md'))).toBeInstanceOf(FileBadRequestError)
    expect(await errOf(ws.rename!('', 'x'))).toBeInstanceOf(FileBadRequestError)
    await ws.rename!('d/a.md', './d/a.md')
    expect((await ws.list('d')).map((e) => e.name)).toEqual(['a.md'])
  })
})
