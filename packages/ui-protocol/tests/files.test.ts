import { describe, it, expect } from 'vitest'
import {
  DEFAULT_FILE_READ_MAX_BYTES,
  FILE_SEARCH_LINE_MAX,
  MAX_FILE_SEARCH_LIMIT,
  compileFileSearch,
  FileBadRequestError,
  FileConflictError,
  FileNotFoundError,
  WORKSPACE_TRASH_DIR,
  checkFileReadSize,
  decodeFileContent,
  fileContent,
  fileMime,
  isIgnoredPath,
  isTrashPath,
  isWorkspaceUpdateEvent,
  matchGitignore,
  normalizeFilePath,
  parentFilePath,
  parseGitignore,
  parseWorkspaceEvent,
  serializeWorkspaceEvent,
} from '../src/index.js'
import type { Capabilities, FileEntry, ProtocolBackend, WorkspaceFilesOps, WorkspaceUpdateEvent } from '../src/index.js'

const utf8 = (s: string) => new TextEncoder().encode(s)

// ────────────────────────────────────────────────────────────────────────────
// Пути (workspace-files-spec §1)
// ────────────────────────────────────────────────────────────────────────────

describe('normalizeFilePath', () => {
  it('корень: undefined, пусто, точка, слэши-хвосты', () => {
    expect(normalizeFilePath(undefined)).toBe('')
    expect(normalizeFilePath('')).toBe('')
    expect(normalizeFilePath('.')).toBe('')
    expect(normalizeFilePath('./')).toBe('')
  })

  it('нормальная форма: без ./, пустых сегментов и хвостового слэша', () => {
    expect(normalizeFilePath('a/b.md')).toBe('a/b.md')
    expect(normalizeFilePath('./a//b/./c/')).toBe('a/b/c')
    expect(normalizeFilePath('.nr-trash/x')).toBe('.nr-trash/x')
    expect(normalizeFilePath('...')).toBe('...')
  })

  it('.. в любом месте — bad_request, даже «сокращаемый»', () => {
    for (const p of ['..', '../x', 'a/../b', 'a/..']) {
      expect(() => normalizeFilePath(p)).toThrow(FileBadRequestError)
    }
  })

  it('абсолютные, обратный слэш, NUL — bad_request', () => {
    for (const p of ['/etc/passwd', 'C:/x', 'c:x', 'a\\b', '..\\x', 'a\0b']) {
      expect(() => normalizeFilePath(p), p).toThrow(FileBadRequestError)
    }
    try {
      normalizeFilePath('/x')
    } catch (err) {
      expect((err as FileBadRequestError).code).toBe('bad_request')
    }
  })

  it('не строка — bad_request', () => {
    expect(() => normalizeFilePath(42 as unknown as string)).toThrow(FileBadRequestError)
  })

  it('parentFilePath и isTrashPath', () => {
    expect(parentFilePath('a/b/c.md')).toBe('a/b')
    expect(parentFilePath('c.md')).toBe('')
    expect(parentFilePath('')).toBe('')
    expect(isTrashPath(WORKSPACE_TRASH_DIR)).toBe(true)
    expect(isTrashPath('.nr-trash/a.md')).toBe(true)
    expect(isTrashPath('.nr-trashy')).toBe(false)
    expect(isTrashPath('a/.nr-trash')).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Типы и содержимое
// ────────────────────────────────────────────────────────────────────────────

describe('fileMime', () => {
  it('по расширению, исходники без своего mime — text/plain, неизвестное — нет', () => {
    expect(fileMime('README.md')).toBe('text/markdown')
    expect(fileMime('a/b/data.JSON')).toBe('application/json')
    expect(fileMime('src/main.ts')).toBe('text/typescript')
    expect(fileMime('lib.rs')).toBe('text/plain')
    expect(fileMime('Dockerfile')).toBe('text/plain')
    expect(fileMime('logo.png')).toBe('image/png')
    expect(fileMime('blob.bin')).toBeUndefined()
    expect(fileMime('.env')).toBe('text/plain')
    expect(fileMime('dir.d/')).toBeUndefined()
  })
})

describe('fileContent / decodeFileContent', () => {
  it('UTF-8 — текстом, mime и revision на месте', () => {
    const c = fileContent({ path: 'notes/a.md', data: utf8('# Привет'), revision: '14:1' })
    expect(c).toEqual({
      path: 'notes/a.md',
      content: '# Привет',
      encoding: 'utf8',
      size: utf8('# Привет').byteLength,
      mime: 'text/markdown',
      revision: '14:1',
    })
  })

  it('BOM сохраняется — сохранение вернёт файл байт в байт', () => {
    const data = new Uint8Array([0xef, 0xbb, 0xbf, 0x61])
    const c = fileContent({ path: 'a.txt', data, revision: 'r' })
    expect(c.encoding).toBe('utf8')
    expect(decodeFileContent(c.content, c.encoding)).toEqual(data)
  })

  it('NUL или битый UTF-8 — base64, туда-обратно без потерь', () => {
    const bin = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe])
    const c = fileContent({ path: 'x.png', data: bin, revision: 'r' })
    expect(c.encoding).toBe('base64')
    expect(c.mime).toBe('image/png')
    expect(decodeFileContent(c.content, 'base64')).toEqual(bin)

    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9])
    expect(fileContent({ path: 'x.txt', data: latin1, revision: 'r' }).encoding).toBe('base64')
  })

  it('большие байты — base64 кусками, без переполнения стека', () => {
    const big = new Uint8Array(300_000).map((_, i) => (i * 7) % 256)
    const c = fileContent({ path: 'big.bin', data: big, revision: 'r' })
    expect(c.encoding).toBe('base64')
    expect(decodeFileContent(c.content, 'base64')).toEqual(big)
  })

  it('явный mime перекрывает расширение', () => {
    expect(fileContent({ path: 'a', data: utf8('x'), revision: 'r', mime: 'text/x-custom' }).mime).toBe('text/x-custom')
    expect(fileContent({ path: 'a.unknownext', data: utf8('x'), revision: 'r' }).mime).toBeUndefined()
  })

  it('decode: utf8 по умолчанию, битый base64 и чужая кодировка — bad_request', () => {
    expect(decodeFileContent('ё')).toEqual(utf8('ё'))
    expect(decodeFileContent('aGk=\n', 'base64')).toEqual(utf8('hi'))
    expect(() => decodeFileContent('не base64!', 'base64')).toThrow(FileBadRequestError)
    expect(() => decodeFileContent('abc', 'base64')).toThrow(FileBadRequestError)
    expect(() => decodeFileContent('x', 'latin1' as 'utf8')).toThrow(FileBadRequestError)
  })

  it('checkFileReadSize: лимит по умолчанию 2 МБ, сообщение с размером', () => {
    expect(() => checkFileReadSize('a', DEFAULT_FILE_READ_MAX_BYTES)).not.toThrow()
    expect(() => checkFileReadSize('big.log', DEFAULT_FILE_READ_MAX_BYTES + 1)).toThrow(/2000001 байт/)
    expect(() => checkFileReadSize('a', 11, 10)).toThrow(FileBadRequestError)
  })

  it('ошибки несут коды провода', () => {
    expect(new FileNotFoundError('a.md').code).toBe('not_found')
    expect(new FileNotFoundError('a.md').message).toContain('a.md')
    expect(new FileConflictError('x').code).toBe('conflict')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// .gitignore → ignored
// ────────────────────────────────────────────────────────────────────────────

describe('parseGitignore / matchGitignore', () => {
  const m = (text: string, path: string, isDir = false) => matchGitignore(parseGitignore(text), path, isDir)

  it('имя без слэша — на любой глубине; комментарии и пустые строки мимо', () => {
    const text = '# коммент\n\n*.log\n'
    expect(m(text, 'a.log')).toBe(true)
    expect(m(text, 'deep/x/a.log')).toBe(true)
    expect(m(text, 'a.txt')).toBeUndefined()
  })

  it('/ в начале или середине — якорь к каталогу .gitignore', () => {
    expect(m('/dist', 'dist', true)).toBe(true)
    expect(m('/dist', 'pkg/dist', true)).toBeUndefined()
    expect(m('docs/gen', 'docs/gen', true)).toBe(true)
    expect(m('docs/gen', 'x/docs/gen', true)).toBeUndefined()
  })

  it('/ в конце — только каталоги', () => {
    expect(m('build/', 'build', true)).toBe(true)
    expect(m('build/', 'build', false)).toBeUndefined()
  })

  it('отрицание: последнее совпавшее побеждает', () => {
    const text = '*.env\n!example.env'
    expect(m(text, 'prod.env')).toBe(true)
    expect(m(text, 'example.env')).toBe(false)
  })

  it('**, ?, классы, экранирование', () => {
    expect(m('**/cache', 'a/b/cache', true)).toBe(true)
    expect(m('**/cache', 'cache', true)).toBe(true)
    expect(m('logs/**', 'logs/a/b.txt')).toBe(true)
    expect(m('logs/**', 'logs', true)).toBeUndefined()
    expect(m('a/**/z', 'a/z')).toBe(true)
    expect(m('a/**/z', 'a/b/c/z')).toBe(true)
    expect(m('file?.txt', 'file1.txt')).toBe(true)
    expect(m('file?.txt', 'file10.txt')).toBeUndefined()
    expect(m('[ab].md', 'b.md')).toBe(true)
    expect(m('[!ab].md', 'b.md')).toBeUndefined()
    expect(m('[!ab].md', 'c.md')).toBe(true)
    expect(m('\\#hash', '#hash')).toBe(true)
    expect(m('a.b', 'axb')).toBeUndefined()
  })
})

describe('isIgnoredPath', () => {
  const tree: Record<string, string> = {
    '': 'dist/\n*.log\n!keep.log\nsecret.txt',
    pkg: '!secret.txt\ngenerated/',
  }
  const rulesOf = (dir: string) => (tree[dir] !== undefined ? parseGitignore(tree[dir]!) : undefined)
  const ign = (p: string, isDir = false) => isIgnoredPath(p, isDir, rulesOf)

  it('.git, node_modules на любой глубине и корзина в корне — всегда', () => {
    expect(ign('.git', true)).toBe(true)
    expect(ign('.git/HEAD')).toBe(true)
    expect(ign('pkg/node_modules/x/index.js')).toBe(true)
    expect(ign('.nr-trash', true)).toBe(true)
    expect(ign('.nr-trash/a.md')).toBe(true)
    expect(isIgnoredPath('src/a.ts', false, () => undefined)).toBe(false)
  })

  it('содержимое игнорируемого каталога — тоже, отрицание внутрь не пробивается', () => {
    expect(ign('dist', true)).toBe(true)
    expect(ign('dist/keep.log')).toBe(true)
    expect(ign('app.log')).toBe(true)
    expect(ign('keep.log')).toBe(false)
  })

  it('вложенный .gitignore перекрывает корневой в своём поддереве', () => {
    expect(ign('secret.txt')).toBe(true)
    expect(ign('pkg/secret.txt')).toBe(false)
    expect(ign('other/secret.txt')).toBe(true)
    expect(ign('pkg/generated', true)).toBe(true)
    expect(ign('pkg/generated/a.ts')).toBe(true)
    expect(ign('generated', true)).toBe(false)
  })

  it('корень не игнорируется', () => {
    expect(ign('', true)).toBe(false)
  })

  it('вложенная репа (свой .git) — правила родителей на неё не действуют (ABC-295)', () => {
    const umbrella: Record<string, string> = { '': '/backend-fs/\n*.log\n', 'backend-fs': 'dist/\n' }
    const rules = (dir: string) => (umbrella[dir] !== undefined ? parseGitignore(umbrella[dir]!) : undefined)
    const repo = (dir: string) => dir === 'backend-fs'
    const ig = (p: string, isDir = false) => isIgnoredPath(p, isDir, rules, repo)
    expect(ig('backend-fs', true)).toBe(false)
    expect(ig('backend-fs/src/a.ts')).toBe(false)
    expect(ig('backend-fs/x.log')).toBe(false)
    expect(ig('backend-fs/dist/a.js')).toBe(true)
    expect(ig('backend-fs/node_modules/m/a.js')).toBe(true)
    expect(ig('y.log')).toBe(true)
    expect(isIgnoredPath('backend-fs/src/a.ts', false, rules)).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// workspace_update на проводе
// ────────────────────────────────────────────────────────────────────────────

describe('workspace_update', () => {
  it('SSE туда-обратно', () => {
    const ev: WorkspaceUpdateEvent = { type: 'workspace_update', paths: ['a.md', 'src'] }
    const frame = serializeWorkspaceEvent(ev)
    expect(frame).toBe('event: workspace_update\ndata: {"type":"workspace_update","paths":["a.md","src"]}\n\n')
    expect(parseWorkspaceEvent(frame)).toEqual(ev)
  })

  it('чужие и битые кадры — null; guard проверяет форму', () => {
    expect(parseWorkspaceEvent('event: run_start\ndata: {"type":"run_start","runId":"r"}\n\n')).toBeNull()
    expect(parseWorkspaceEvent(': ping\n\n')).toBeNull()
    expect(parseWorkspaceEvent('data: {"type":"workspace_update","paths":[1]}\n\n')).toBeNull()
    expect(isWorkspaceUpdateEvent({ type: 'workspace_update', paths: [''] })).toBe(true)
    expect(isWorkspaceUpdateEvent({ type: 'workspace_update' })).toBe(false)
    expect(isWorkspaceUpdateEvent(null)).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Контракт на уровне типов
// ────────────────────────────────────────────────────────────────────────────

describe('WorkspaceFilesOps', () => {
  it('только чтение — валидные ops; capability несёт write/watch', async () => {
    const entry: FileEntry = { name: 'a.md', path: 'a.md', kind: 'file', size: 1, mime: 'text/markdown' }
    const readOnly: WorkspaceFilesOps = {
      list: async () => [entry],
      read: async (path) => fileContent({ path, data: utf8('x'), revision: '1:0' }),
    }
    const backend: ProtocolBackend = {
      capabilities: async (): Promise<Capabilities> => ({ protocol: 1, workspace: { files: {} } }),
      sessions: { list: async () => [], create: async () => ({ id: 's' }), get: async (id) => ({ id }), delete: async () => {} },
      history: async () => ({ messages: [], version: '' }),
      run: async function* () {},
      cancel: async () => {},
      workspace: {
        current: async () => ({ id: 'w', name: 'w' }),
        list: async () => [],
        files: readOnly,
      },
    }
    expect(backend.workspace!.files!.write).toBeUndefined()
    expect(backend.workspace!.files!.watch).toBeUndefined()
    expect((await backend.workspace!.files!.read('a.md')).content).toBe('x')

    const caps: Capabilities = { protocol: 1, workspace: { switch: true, files: { write: true, watch: true } } }
    expect(caps.workspace?.files?.watch).toBe(true)
  })
})

describe('compileFileSearch (v1.28, ABC-295)', () => {
  it('подстрока без регистра по умолчанию, с case — с ним', () => {
    expect(compileFileSearch({ query: 'Prune' }).match('auto prune here')).toBe(5)
    expect(compileFileSearch({ query: 'Prune', case: true }).match('auto prune here')).toBe(-1)
    expect(compileFileSearch({ query: 'Prune', case: true }).match('x Prune')).toBe(2)
  })
  it('regex: флаги, битый regex — bad_request', () => {
    expect(compileFileSearch({ query: 'p.u?ne', regex: true }).match('PRNE')).toBe(0)
    expect(() => compileFileSearch({ query: '(', regex: true })).toThrow(FileBadRequestError)
    expect(() => compileFileSearch({ query: '' })).toThrow(FileBadRequestError)
    expect(() => compileFileSearch({ query: 'x', limit: 0 })).toThrow(FileBadRequestError)
  })
  it('glob: без / — по имени, с / — от корня, {a,b} и запятая', () => {
    const md = compileFileSearch({ query: 'x', glob: '*.md' })
    expect(md.accepts('a/b/c.md')).toBe(true)
    expect(md.accepts('a/b/c.ts')).toBe(false)
    const docs = compileFileSearch({ query: 'x', glob: 'docs/**/*.{md,mdz}' })
    expect(docs.accepts('docs/a/b.mdz')).toBe(true)
    expect(docs.accepts('docs/b.md')).toBe(true)
    expect(docs.accepts('x/docs/b.md')).toBe(false)
    const two = compileFileSearch({ query: 'x', glob: '*.ts, *.tsx' })
    expect(two.accepts('src/a.tsx')).toBe(true)
    expect(two.accepts('src/a.css')).toBe(false)
  })
  it('limit — с потолком; длинная строка обрезается вокруг совпадения', () => {
    expect(compileFileSearch({ query: 'x', limit: 10 ** 9 }).limit).toBe(MAX_FILE_SEARCH_LIMIT)
    const m = compileFileSearch({ query: 'needle' })
    const line = 'a'.repeat(5000) + 'needle' + 'b'.repeat(100)
    const hit = m.hit('f.js', 3, line, m.match(line))
    expect(hit.text.length).toBeLessThanOrEqual(FILE_SEARCH_LINE_MAX + 1)
    expect(hit.text.slice(hit.column! - 1, hit.column! - 1 + 6)).toBe('needle')
    expect(hit).toMatchObject({ path: 'f.js', line: 3 })
  })
})
