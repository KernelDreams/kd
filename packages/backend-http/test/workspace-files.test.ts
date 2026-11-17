/**
 * Файлы пространства (workspace-files-spec §1–2): memory-FS store-backend и провод.
 *
 * memory-FS обязана отвечать как backend-fs на диске (фикстура e2e nrchat);
 * провод — `GET/PUT/DELETE /workspace/file`, `GET /workspace/files`,
 * `POST /workspace/file/rename`, `GET /workspace/file/stat`, SSE
 * `GET /workspace/events` с переподключением клиента.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import { FileBadRequestError, FileConflictError, FileNotFoundError, NotSupportedError } from '@kerneldreams/ui-protocol'
import type { ProtocolBackend, WorkspaceFilesOps, WorkspaceUpdateEvent } from '@kerneldreams/ui-protocol'
import { serveBackend, type ServeHandle } from '../src/serve.js'
import { BackendError, createHttpBackend, type HttpBackendOpts } from '../src/client.js'
import { createStoreBackend } from '../src/store-backend.js'
import { createMemoryFiles } from '../src/memory-files.js'
import { createMemoryProjects } from '../src/projects.js'
import { noGen } from './store-harness.js'

const errOf = (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e)
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error('не дождались условия')
    await delay(25)
  }
}

// ────────────────────────────────────────────────────────────────────────────
// memory-FS (workspace-files-spec §2)
// ────────────────────────────────────────────────────────────────────────────

describe('createMemoryFiles', () => {
  const fixture = () =>
    createMemoryFiles({
      'README.md': '# fx',
      'src/index.ts': 'export {}',
      'docs/': '',
      'img/logo.png': new Uint8Array([0x89, 0x50, 0, 1]),
      '.gitignore': 'dist/\n*.log\n',
      'dist/out.js': '',
      'debug.log': '',
      'node_modules/x/index.js': '',
    })

  it('list: один уровень, каталоги первыми, поля и ignored как у backend-fs', async () => {
    const fs = fixture()
    const list = await fs.list()
    expect(list.map((e) => e.name)).toEqual(['dist', 'docs', 'img', 'node_modules', 'src', '.gitignore', 'README.md', 'debug.log'])
    expect(list.find((e) => e.name === 'README.md')).toMatchObject({ path: 'README.md', kind: 'file', size: 4, mime: 'text/markdown' })
    expect(list.filter((e) => e.ignored).map((e) => e.name)).toEqual(['dist', 'node_modules', 'debug.log'])
    expect(await fs.list('docs')).toEqual([])
    expect(await fs.list('src')).toMatchObject([{ name: 'index.ts', path: 'src/index.ts' }])
    expect(await errOf(fs.list('нет'))).toBeInstanceOf(FileNotFoundError)
    expect(await errOf(fs.list('README.md'))).toBeInstanceOf(FileBadRequestError)
    expect(await errOf(fs.list('../x'))).toBeInstanceOf(FileBadRequestError)
  })

  it('read: текст, байты base64, лимит, каталог', async () => {
    const fs = fixture()
    expect(await fs.read('README.md')).toMatchObject({ content: '# fx', encoding: 'utf8', size: 4, mime: 'text/markdown' })
    const png = await fs.read('img/logo.png')
    expect(png.encoding).toBe('base64')
    expect([...Buffer.from(png.content, 'base64')]).toEqual([0x89, 0x50, 0, 1])
    expect(png.revision).toMatch(/^4:\d+$/)
    expect(await errOf(fs.read('README.md', { maxBytes: 3 }))).toBeInstanceOf(FileBadRequestError)
    expect(await errOf(fs.read('src'))).toBeInstanceOf(FileBadRequestError)
    expect(await errOf(fs.read('нет.md'))).toBeInstanceOf(FileNotFoundError)
  })

  it('write: создать, revision, conflict, родители, запреты', async () => {
    const fs = fixture()
    const { revision } = await fs.write('notes/deep/a.md', 'раз', { revision: null })
    expect((await fs.read('notes/deep/a.md')).revision).toBe(revision)
    expect((await fs.list('notes')).map((e) => [e.name, e.kind])).toEqual([['deep', 'dir']])
    expect(await errOf(fs.write('notes/deep/a.md', 'x', { revision: null }))).toBeInstanceOf(FileConflictError)

    // Та же длина, та же миллисекунда — ревизия всё равно новая.
    const r2 = await fs.write('notes/deep/a.md', 'два', { revision })
    expect(r2.revision).not.toBe(revision)
    expect(await errOf(fs.write('notes/deep/a.md', 'три', { revision }))).toBeInstanceOf(FileConflictError)
    expect((await fs.read('notes/deep/a.md')).content).toBe('два')

    await fs.write('bin.dat', Buffer.from([0, 255]).toString('base64'), { encoding: 'base64' })
    expect((await fs.read('bin.dat')).encoding).toBe('base64')

    for (const [path, why] of [['src', 'каталог'], ['', 'корень'], ['.nr-trash/a', 'корзина'], ['README.md/x', 'файл как каталог']] as const) {
      expect(await errOf(fs.write(path, 'x')), why).toBeInstanceOf(FileBadRequestError)
    }
  })

  it('delete: в корзину с путём, повтор с суффиксом; revision удалённого — conflict', async () => {
    const fs = fixture()
    const { revision } = await fs.read('src/index.ts')
    await fs.delete('src/index.ts')
    expect(await errOf(fs.read('src/index.ts'))).toBeInstanceOf(FileNotFoundError)
    expect((await fs.read('.nr-trash/src/index.ts')).content).toBe('export {}')
    expect(await errOf(fs.write('src/index.ts', 'x', { revision }))).toBeInstanceOf(FileConflictError)

    await fs.write('src/index.ts', 'второй')
    await fs.delete('src/index.ts')
    const trashed = (await fs.list('.nr-trash/src')).map((e) => e.name)
    expect(trashed).toHaveLength(2)
    expect(trashed.some((n) => /^index\.ts\..+/.test(n))).toBe(true)

    await fs.delete('docs')
    expect((await fs.list()).find((e) => e.name === '.nr-trash')).toMatchObject({ kind: 'dir', ignored: true })
    expect(await errOf(fs.delete('нет'))).toBeInstanceOf(FileNotFoundError)
    expect(await errOf(fs.delete(''))).toBeInstanceOf(FileBadRequestError)
  })

  it('rename: поддерево целиком, занятая цель, внутрь себя', async () => {
    const fs = fixture()
    await fs.rename('src', 'lib/core')
    expect((await fs.read('lib/core/index.ts')).content).toBe('export {}')
    expect(await errOf(fs.list('src'))).toBeInstanceOf(FileNotFoundError)
    expect(await errOf(fs.rename('README.md', 'debug.log'))).toBeInstanceOf(FileConflictError)
    expect(await errOf(fs.rename('lib', 'lib/inner'))).toBeInstanceOf(FileBadRequestError)
    expect(await errOf(fs.rename('нет', 'x'))).toBeInstanceOf(FileNotFoundError)
    expect(await errOf(fs.rename('README.md', '.nr-trash/r.md'))).toBeInstanceOf(FileBadRequestError)
  })

  it('stat: файл, каталог, корень под именем опции', async () => {
    const fs = createMemoryFiles({ 'a/b.md': 'x' }, { rootName: 'фикстура' })
    expect(await fs.stat('a/b.md')).toMatchObject({ name: 'b.md', kind: 'file', size: 1 })
    expect(await fs.stat('a')).toMatchObject({ name: 'a', kind: 'dir' })
    expect(await fs.stat('')).toMatchObject({ name: 'фикстура', path: '', kind: 'dir' })
  })

  it('watch — эмуляция на мутациях: write, delete (+корзина), rename; отписка', async () => {
    const fs = fixture()
    const events: WorkspaceUpdateEvent[] = []
    const off = fs.watch((ev) => events.push(ev))

    await fs.write('a.md', 'x')
    await fs.delete('debug.log')
    await fs.rename('README.md', 'docs/README.md')
    await delay(0)
    expect(events.map((e) => e.paths)).toEqual([['a.md'], ['.nr-trash', 'debug.log'], ['README.md', 'docs/README.md']])

    off()
    await fs.write('b.md', 'x')
    await delay(0)
    expect(events).toHaveLength(3)
  })
})

describe('createStoreBackend { files }', () => {
  it('опция — capability workspace.files {write, watch} и ops', async () => {
    const backend = createStoreBackend({ store: createMemoryStore(), generate: noGen, files: { 'a.md': 'x' } })
    expect((await backend.capabilities()).workspace).toEqual({ files: { write: true, watch: true, search: true } })
    expect((await backend.workspace!.files!.read('a.md')).content).toBe('x')
    expect((await backend.workspace!.files!.stat!('')).name).toBe('memory')
  })

  it('без опции — файлов нет ни в capability, ни в ops', async () => {
    const backend = createStoreBackend({ store: createMemoryStore(), generate: noGen })
    expect((await backend.capabilities()).workspace).toEqual({})
    expect(backend.workspace!.files).toBeUndefined()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Провод
// ────────────────────────────────────────────────────────────────────────────

describe('провод workspace.files', () => {
  let srv: ServeHandle | undefined
  let client: ProtocolBackend | undefined
  let backend: ProtocolBackend | undefined

  afterEach(async () => {
    await client?.close?.()
    await srv?.close()
    srv = client = backend = undefined
  })

  async function loopback(files: Record<string, string> = {}, clientOpts?: HttpBackendOpts): Promise<WorkspaceFilesOps> {
    backend = createStoreBackend({ store: createMemoryStore(), generate: noGen, name: 'fx', files })
    srv = await serveBackend(backend)
    client = createHttpBackend(srv.url, clientOpts)
    return client.workspace!.files!
  }

  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${srv!.url}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  it('все операции доезжают туда и обратно', async () => {
    const files = await loopback({ 'README.md': '# fx', 'src/index.ts': 'export {}' })

    expect((await client!.capabilities()).workspace).toEqual({ files: { write: true, watch: true, search: true } })
    expect((await files.list()).map((e) => e.path)).toEqual(['src', 'README.md'])
    expect(await files.list('src')).toEqual(await backend!.workspace!.files!.list('src'))

    const readme = await files.read('README.md')
    expect(readme).toEqual(await backend!.workspace!.files!.read('README.md'))
    const { revision } = await files.write!('README.md', '# новое', { revision: readme.revision })
    expect((await files.read('README.md')).revision).toBe(revision)

    await files.write!('new.md', 'x', { revision: null })
    await files.rename!('new.md', 'docs/new.md')
    expect((await files.stat!('docs/new.md')).kind).toBe('file')
    await files.delete!('docs/new.md')
    expect((await files.read('.nr-trash/docs/new.md')).content).toBe('x')

    await files.write!('bin.dat', Buffer.from([0, 1, 255]).toString('base64'), { encoding: 'base64' })
    expect((await files.read('bin.dat')).content).toBe(Buffer.from([0, 1, 255]).toString('base64'))
  })

  it('экзотика в путях: пробелы, кириллица, #, ?, &, %', async () => {
    const files = await loopback()
    const path = 'заметки/a b#1?x=&y%.md'
    await files.write!(path, 'ок')
    expect((await files.read(path)).content).toBe('ок')
    expect((await files.list('заметки')).map((e) => e.name)).toEqual(['a b#1?x=&y%.md'])
    expect((await files.stat!(path)).path).toBe(path)
    await files.delete!(path)
  })

  it('ошибки бэкенда — кодом и статусом: conflict 409, not_found 404, bad_request 400', async () => {
    const files = await loopback({ 'a.md': 'x' })
    const conflict = await errOf(files.write!('a.md', 'y', { revision: null }))
    expect(conflict).toBeInstanceOf(BackendError)
    expect(conflict).toMatchObject({ code: 'conflict', status: 409 })
    expect(await errOf(files.write!('a.md', 'y', { revision: 'stale' }))).toMatchObject({ code: 'conflict' })
    expect(await errOf(files.read('нет.md'))).toMatchObject({ code: 'not_found', status: 404 })
    expect(await errOf(files.read('../etc/passwd'))).toMatchObject({ code: 'bad_request', status: 400 })
    expect(await errOf(files.list('../'))).toMatchObject({ code: 'bad_request' })
    expect(await errOf(files.read('a.md', { maxBytes: 0 }))).toMatchObject({ code: 'bad_request' })
  })

  it('кривой вход — 400 до бэкенда', async () => {
    await loopback({ 'a.md': 'x' })
    const cases: Array<[string, string, unknown?]> = [
      ['GET', '/workspace/file'],
      ['GET', '/workspace/file?path='],
      ['GET', '/workspace/file?path=a.md&maxBytes=-1'],
      ['GET', '/workspace/file?path=a.md&maxBytes=abc'],
      ['DELETE', '/workspace/file'],
      ['PUT', '/workspace/file', { content: 'x' }],
      ['PUT', '/workspace/file', { path: 'a.md', content: 42 }],
      ['PUT', '/workspace/file', { path: 'a.md', content: 'x', encoding: 'latin1' }],
      ['PUT', '/workspace/file', { path: 'a.md', content: 'x', revision: 7 }],
      ['POST', '/workspace/file/rename', { from: 'a.md' }],
    ]
    for (const [method, path, body] of cases) {
      const res = await send(method, path, body)
      expect(res.status, `${method} ${path}`).toBe(400)
      expect(await res.json()).toMatchObject({ ok: false, code: 'bad_request' })
    }
    expect((await send('PATCH', '/workspace/file?path=a.md')).status).toBe(405)
  })

  it('без файлов — not_supported на каждый роут, capability workspace {}', async () => {
    const files = await loopback()
    backend = createStoreBackend({ store: createMemoryStore(), generate: noGen })
    await srv!.close()
    srv = await serveBackend(backend)
    await client!.close!()
    client = createHttpBackend(srv.url)
    const bare = client.workspace!.files!

    expect((await client.capabilities()).workspace).toEqual({})
    expect(files).toBeDefined()
    await expect(bare.list()).rejects.toBeInstanceOf(NotSupportedError)
    await expect(bare.read('a.md')).rejects.toBeInstanceOf(NotSupportedError)
    await expect(bare.write!('a.md', 'x')).rejects.toBeInstanceOf(NotSupportedError)
    await expect(bare.delete!('a.md')).rejects.toBeInstanceOf(NotSupportedError)
    await expect(bare.rename!('a.md', 'b.md')).rejects.toBeInstanceOf(NotSupportedError)
    await expect(bare.stat!('a.md')).rejects.toBeInstanceOf(NotSupportedError)
    const res = await send('GET', '/workspace/events')
    expect(res.status).toBe(501)
    expect(await res.json()).toMatchObject({ code: 'not_supported' })
  })

  it('GET /workspace/events — SSE: комментарий на подключение, кадр workspace_update на запись', async () => {
    await loopback({ 'a.md': 'x' })
    const ac = new AbortController()
    const res = await fetch(`${srv!.url}/workspace/events`, { signal: ac.signal })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (!text.includes(': workspace events')) text += decoder.decode((await reader.read()).value)

    await backend!.workspace!.files!.write!('a.md', 'y')
    while (!text.includes('event: workspace_update')) text += decoder.decode((await reader.read()).value)
    expect(text).toContain('data: {"type":"workspace_update","paths":["a.md"]}')
    ac.abort()
    await reader.cancel().catch(() => {})
  })

  it('client.watch: события правок, отписка закрывает поток', async () => {
    const files = await loopback()
    const events: WorkspaceUpdateEvent[] = []
    const off = files.watch!((ev) => events.push(ev))

    // Канал поднимается фоном: пробуем, пока первое событие не доехало.
    let n = 0
    await until(async () => {
      await backend!.workspace!.files!.write!('probe.txt', String(n++))
      return events.length > 0
    })
    await backend!.workspace!.files!.write!('agent-edit.md', 'правка мимо клиента')
    await until(() => events.some((e) => e.paths.includes('agent-edit.md')))
    expect(events.every((e) => e.type === 'workspace_update')).toBe(true)

    off()
    const seen = events.length
    await delay(100)
    await backend!.workspace!.files!.write!('after.md', 'x')
    await delay(200)
    expect(events).toHaveLength(seen)
  })

  it('client.watch: сервер ушёл и вернулся — переподключение и [\'\'] («перечитай всё»)', async () => {
    const files = await loopback()
    const port = srv!.port
    const events: WorkspaceUpdateEvent[] = []
    files.watch!((ev) => events.push(ev))

    let n = 0
    await until(async () => {
      await backend!.workspace!.files!.write!('probe.txt', String(n++))
      return events.length > 0
    })

    await srv!.close()
    srv = await serveBackend(backend!, { port })
    await until(() => events.some((e) => e.paths.length === 1 && e.paths[0] === ''), 6000)

    await backend!.workspace!.files!.write!('after-restart.md', 'x')
    await until(() => events.some((e) => e.paths.includes('after-restart.md')))
  })

  it('client.watch против бэкенда без watch: один запрос, без ретраев', async () => {
    const calls: string[] = []
    const counting: typeof fetch = (input, init) => {
      calls.push(String(input))
      return fetch(input, init)
    }
    backend = createStoreBackend({ store: createMemoryStore(), generate: noGen })
    srv = await serveBackend(backend)
    client = createHttpBackend(srv.url, { fetch: counting })

    const off = client.workspace!.files!.watch!(() => {})
    await delay(1200)
    expect(calls.filter((u) => u.endsWith('/workspace/events'))).toHaveLength(1)
    off()
  })

  it('client.close() гасит watch', async () => {
    const files = await loopback()
    const events: WorkspaceUpdateEvent[] = []
    files.watch!((ev) => events.push(ev))
    let n = 0
    await until(async () => {
      await backend!.workspace!.files!.write!('probe.txt', String(n++))
      return events.length > 0
    })
    await client!.close!()
    const seen = events.length
    await backend!.workspace!.files!.write!('x.md', 'x')
    await delay(200)
    expect(events).toHaveLength(seen)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Поиск (v1.28) и файлы проекта
// ────────────────────────────────────────────────────────────────────────────

describe('workspace.files.search', () => {
  let srv: ServeHandle | undefined
  let client: ProtocolBackend | undefined
  afterEach(async () => {
    await client?.close?.()
    await srv?.close()
    srv = client = undefined
  })

  it('memory-FS: игнор и бинарное мимо, порядок путей; провод POST /workspace/files/search', async () => {
    const backend = createStoreBackend({
      store: createMemoryStore(),
      generate: noGen,
      files: {
        'b.md': 'x\nprune b\n',
        'a.md': 'Prune a',
        '.gitignore': 'dist/\n',
        'dist/x.md': 'prune',
        'node_modules/m/i.js': 'prune',
        'bin.dat': new Uint8Array([0, 112, 114, 117, 110, 101]) as unknown as string,
      },
    })
    srv = await serveBackend(backend)
    client = createHttpBackend(srv.url)
    const hits = await client.workspace!.files!.search!({ query: 'prune' })
    expect(hits).toEqual([
      { path: 'a.md', line: 1, text: 'Prune a', column: 1 },
      { path: 'b.md', line: 2, text: 'prune b', column: 1 },
    ])
    expect((await client.workspace!.files!.search!({ query: 'P', case: true })).map((h) => h.path)).toEqual(['a.md'])
    expect(await errOf(client.workspace!.files!.search!({ query: '(', regex: true }))).toMatchObject({ code: 'bad_request' })
  })

  it('без search у пространства — not_supported', async () => {
    const backend = createStoreBackend({ store: createMemoryStore(), generate: noGen })
    srv = await serveBackend(backend)
    client = createHttpBackend(srv.url)
    expect(await errOf(client.workspace!.files!.search!({ query: 'x' }))).toMatchObject({ code: 'not_supported' })
  })
})

describe('createStoreBackend { projectFiles }', () => {
  it('файлы — текущего проекта процесса; switch — workspace_update [""] и новое пространство', async () => {
    const made: string[] = []
    const backend = createStoreBackend({
      store: createMemoryStore(),
      generate: noGen,
      projects: createMemoryProjects({ root: '/work/default', projects: [{ id: 'p1', name: 'p1', root: '/work/p1' }] }),
      projectFiles: (p) => {
        made.push(p.id)
        const fs = createMemoryFiles({ [`${p.id}.md`]: `prune ${p.id}` })
        return { ...fs, capability: { write: true, watch: true, search: true } }
      },
    })
    expect((await backend.capabilities()).workspace?.files).toEqual({ write: true, watch: true, search: true })
    const files = backend.workspace!.files!
    expect((await files.list()).map((e) => e.path)).toEqual(['default.md'])
    const events: WorkspaceUpdateEvent[] = []
    const off = files.watch!((ev) => events.push(ev))
    await backend.workspace!.switch!('p1')
    await until(() => events.length > 0)
    expect(events[0]!.paths).toEqual([''])
    expect((await files.search!({ query: 'prune' })).map((h) => h.path)).toEqual(['p1.md'])
    // Подписка переехала: запись в новом пространстве — событие.
    await files.write!('n.md', 'x')
    await until(() => events.some((e) => e.paths.includes('n.md')))
    off()
    // Пространства кэшируются: обратно — без новой сборки.
    await backend.workspace!.switch!('default')
    await files.list()
    expect(made).toEqual(['default', 'p1'])
  })
})

describe('files.at(ws) — файлы проекта вкладки (v1.33, ABC-310)', () => {
  let srv: ServeHandle | undefined
  let client: ProtocolBackend | undefined
  afterEach(async () => {
    await client?.close?.()
    await srv?.close()
    srv = client = undefined
  })

  it('две вкладки в разных проектах: дерево и поиск каждой — свои, процесс не переключается; по проводу ?workspace=', async () => {
    const backend = createStoreBackend({
      store: createMemoryStore(),
      generate: noGen,
      projects: createMemoryProjects({ root: '/work/default', projects: [{ id: 'p1', name: 'p1', root: '/work/p1' }] }),
      projectFiles: (p) => ({ ...createMemoryFiles({ [`${p.id}.md`]: `prune ${p.id}` }), capability: { write: true, watch: true, search: true } }),
    })
    const files = backend.workspace!.files!
    expect((await files.at!('p1').list()).map((e) => e.path)).toEqual(['p1.md'])
    expect((await files.list()).map((e) => e.path)).toEqual(['default.md'])
    expect((await backend.workspace!.current()).id).toBe('default')
    srv = await serveBackend(backend)
    client = createHttpBackend(srv.url)
    const cf = client.workspace!.files!
    expect((await cf.at!('p1').search!({ query: 'prune' })).map((h) => h.path)).toEqual(['p1.md'])
    expect((await cf.at!('default').search!({ query: 'prune' })).map((h) => h.path)).toEqual(['default.md'])
    await cf.at!('p1').write!('n.md', 'x')
    expect((await files.at!('p1').list()).map((e) => e.path).sort()).toEqual(['n.md', 'p1.md'])
    expect(await errOf(cf.at!('nope').list())).toMatchObject({ code: 'not_found' })
  })
})
