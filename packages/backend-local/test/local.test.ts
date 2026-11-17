/**
 * createLocalBackend на настоящем диске: сессии `.mds`, правки, свайпы, fork,
 * мета в файле, вложения в `.nr/attachments/`, файлы пространства и watch,
 * `run` без генерации (exz-v2-spec §2).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ATTACHMENT_MIMES, DEFAULT_ATTACHMENT_MAX_BYTES, NotSupportedError } from '@kerneldreams/ui-protocol'
import { createMemoryServices, createServicesHost } from '../src/services/index.js'
import type { AnyRunEvent, Message, ProtocolBackend, WorkspaceUpdateEvent } from '@kerneldreams/ui-protocol'
import { createLocalBackend, type GenerateFn, type LocalBackendOpts } from '../src/index.js'

const dirs: string[] = []
const backends: ProtocolBackend[] = []

function tmpRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'backend-local-')))
  dirs.push(dir)
  return dir
}

function open(opts: LocalBackendOpts): ProtocolBackend {
  const b = createLocalBackend({ files: { debounceMs: 30 }, ...opts })
  backends.push(b)
  return b
}

afterEach(async () => {
  for (const b of backends.splice(0)) await b.close?.()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const textOf = (m: Message | undefined): string =>
  (m?.parts ?? []).map((p) => (p.type === 'text' ? (p as { text: string }).text : '')).join('')

const errOf = (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e)

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: таймаут')
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function collect(iter: AsyncIterable<AnyRunEvent>): Promise<AnyRunEvent[]> {
  const out: AnyRunEvent[] = []
  for await (const ev of iter) out.push(ev)
  return out
}

/** Минимальный валидный PNG-заголовок + хвост. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4])

describe('сборка', () => {
  it('корня нет → throw сразу', () => {
    expect(() => createLocalBackend({ root: join(tmpdir(), 'backend-local-нет-такого') })).toThrow(/корня пространства/)
  })

  it('capabilities: сессии, правки, свайпы, fork, вложения, мета, файлы; без cancel, моделей и профилей', async () => {
    const b = open({ root: tmpRoot() })
    expect(await b.capabilities()).toEqual({
      protocol: 1,
      name: 'local',
      client: true,
      edits: { edit: true, delete: true, hide: true, append: true },
      swipes: true,
      fork: 'tree',
      history: { page: true },
      sessions: { archive: true, move: true, page: true },
      attachments: { maxBytes: DEFAULT_ATTACHMENT_MAX_BYTES, mimes: [...ATTACHMENT_MIMES] },
      sessionMeta: true,
      workspace: { files: { write: true, watch: true, search: true } },
    })
    expect(b.models).toBeUndefined()
    expect(b.profiles).toBeUndefined()
    expect(b.respond).toBeUndefined()
  })

  it('files: {write:false, watch:false} — capability и методы честные', async () => {
    const b = open({ root: tmpRoot(), files: { write: false, watch: false } })
    expect((await b.capabilities()).workspace).toEqual({ files: { search: true } })
    expect(b.workspace!.files!.write).toBeUndefined()
    expect(b.workspace!.files!.watch).toBeUndefined()
  })

  it('пространство — сам root: одно, без switch', async () => {
    const root = tmpRoot()
    const b = open({ root })
    const info = { id: root, name: root.split('/').pop(), path: root, kind: 'directory' }
    expect(await b.workspace!.current()).toEqual(info)
    expect(await b.workspace!.list()).toEqual([info])
    expect(b.workspace!.switch).toBeUndefined()
  })
})

describe('сессии на диске', () => {
  it('create / list / rename / get / delete — файлы `<id>.mds` в root', async () => {
    const root = tmpRoot()
    const b = open({ root })

    const s = await b.sessions.create({ title: 'Черновик' })
    await b.messages!.append!(s.id, [{ type: 'text', text: 'первое' }])
    expect(existsSync(join(root, `${s.id}.mds`))).toBe(true)
    expect((await b.sessions.list()).map((x) => x.id)).toEqual([s.id])

    await b.sessions.rename!(s.id, 'Чистовик')
    expect((await b.sessions.get(s.id)).title).toBe('Чистовик')

    await b.sessions.delete(s.id)
    expect(existsSync(join(root, `${s.id}.mds`))).toBe(false)
    expect(await b.sessions.list()).toEqual([])
  })

  it('sessionsDir относительный — от root', async () => {
    const root = tmpRoot()
    const b = open({ root, sessionsDir: 'chats' })
    const s = await b.sessions.create()
    await b.messages!.append!(s.id, [{ type: 'text', text: 'x' }])
    expect(existsSync(join(root, 'chats', `${s.id}.mds`))).toBe(true)
    expect(readdirSync(root).filter((n) => n.endsWith('.mds'))).toEqual([])
  })

  it('append / edit / свайпы / hide / delete / fork — и всё переживает переоткрытие', async () => {
    const root = tmpRoot()
    const b = open({ root })
    const s = await b.sessions.create()
    const m = b.messages!

    const u = await m.append!(s.id, [{ type: 'text', text: 'вопрос' }])
    const a1 = await m.append!(s.id, [{ type: 'text', text: 'ответ 1' }], { role: 'assistant' })
    const a2 = await m.append!(s.id, [{ type: 'text', text: 'ответ 2' }], { swipeOf: a1.id })

    let hist = (await b.history(s.id)).messages
    expect(hist.map(textOf)).toEqual(['вопрос', 'ответ 2'])
    expect(hist[1]!.swipes).toEqual({ active: 1, count: 2 })

    await m.swipe!(s.id, a2.id, { index: 0 })
    hist = (await b.history(s.id)).messages
    expect(textOf(hist[1])).toBe('ответ 1')

    await m.edit!(s.id, u.id, { text: 'вопрос правленый' })
    expect(textOf((await b.history(s.id)).messages[0])).toBe('вопрос правленый')

    const forked = await b.sessions.fork!(s.id)
    expect((await b.history(forked.id)).messages.map(textOf)).toEqual(['вопрос правленый', 'ответ 1'])

    await m.hide!(s.id, u.id, true)
    expect((await b.history(s.id)).messages[0]!.flags).toBeTruthy()

    // другой инстанс над тем же каталогом видит то же
    const again = open({ root })
    expect((await again.history(forked.id)).messages.map(textOf)).toEqual(['вопрос правленый', 'ответ 1'])

    await m.delete!(forked.id, (await b.history(forked.id)).messages[1]!.id)
    expect((await again.history(forked.id)).messages.map(textOf)).toEqual(['вопрос правленый'])
  })

  it('мета сессии живёт в файле', async () => {
    const root = tmpRoot()
    const b = open({ root })
    const s = await b.sessions.create()
    const applied = await b.meta!.patch(s.id, { notes: 'заметка', prompt: { pre: 'будь краток' } })
    expect(applied).toMatchObject({ notes: 'заметка', prompt: { pre: 'будь краток' } })

    const again = open({ root })
    expect(await again.meta!.get(s.id)).toMatchObject({ notes: 'заметка', prompt: { pre: 'будь краток' } })
    // вложенный merge prompt держится
    expect(await again.meta!.patch(s.id, { prompt: { post: 'в конце' } })).toMatchObject({
      prompt: { pre: 'будь краток', post: 'в конце' },
    })
    // `null` снимает ключ: у nr-chat-драйвера есть meta.set (закрыт долг).
    const dropped = await again.meta!.patch(s.id, { notes: null })
    expect(dropped.notes).toBeUndefined()
    expect(dropped).toMatchObject({ prompt: { pre: 'будь краток', post: 'в конце' } })
  })

  it('одна сессия-файл: file относительный от root, правки ложатся в него, fork не заявлен', async () => {
    const root = tmpRoot()
    const seed = open({ root })
    const s = await seed.sessions.create({ title: 'Заметки' })
    await seed.messages!.append!(s.id, [{ type: 'text', text: 'строка 1' }])
    const path = join(root, `${s.id}.mds`)

    const b = open({ root, file: `${s.id}.mds` })
    expect((await b.capabilities()).fork).toBeUndefined()
    const [only] = await b.sessions.list()
    expect(only).toMatchObject({ title: 'Заметки' })
    await b.messages!.append!(only!.id, [{ type: 'text', text: 'строка 2' }])
    expect((await seed.history(s.id)).messages.map(textOf)).toEqual(['строка 1', 'строка 2'])
    expect(readFileSync(path, 'utf8')).toContain('строка 2')
  })
})

describe('run', () => {
  it('без generate — not_supported на первом next, сессия не тронута', async () => {
    const root = tmpRoot()
    const b = open({ root })
    const s = await b.sessions.create()
    await b.messages!.append!(s.id, [{ type: 'text', text: 'было' }])
    const before = readFileSync(join(root, `${s.id}.mds`), 'utf8')

    const err = await errOf(collect(b.run(s.id, { userMessage: 'не пиши меня' })))
    expect((err as { code?: string }).code).toBe('not_supported')
    expect((err as Error).name).toBe('NotSupportedError')
    expect(readFileSync(join(root, `${s.id}.mds`), 'utf8')).toBe(before)
  })

  it('с generate — ран store-backend, ответ в файле, cancel заявлен', async () => {
    const root = tmpRoot()
    const generate: GenerateFn = async function* (req) {
      yield { type: 'text', delta: `эхо: ${textOf(req.messages.at(-1))}` }
      yield { type: 'model', model: 'test-model' }
    }
    const b = open({ root, generate })
    expect((await b.capabilities()).cancel).toBe(true)

    const s = await b.sessions.create()
    const events = await collect(b.run(s.id, { userMessage: 'привет' }))
    expect(events.at(-1)).toMatchObject({ type: 'run_end', status: 'done' })
    const hist = (await b.history(s.id)).messages
    expect(hist.map(textOf)).toEqual(['привет', 'эхо: привет'])
    expect(hist[1]!.meta?.model).toBe('test-model')
  })
})

describe('вложения в .nr/attachments', () => {
  it('put: байты в <root>/.nr/attachments/<hash>-имя, ref от каталога сессий, часть готова', async () => {
    const root = tmpRoot()
    const b = open({ root })
    const s = await b.sessions.create()

    const put = await b.attachments!.put(s.id, 'кадр.png', PNG, 'image/png')
    expect(put.ref).toMatch(/^file:\.nr\/attachments\/[0-9a-f]{16}-кадр\.png$/)
    expect(put.part).toMatchObject({ type: 'image', meta: { ref: put.ref, mime: 'image/png' } })
    const onDisk = join(root, put.ref.slice('file:'.length))
    expect(new Uint8Array(readFileSync(onDisk))).toEqual(PNG)
    expect(readdirSync(root)).not.toContain(`${s.id}.assets`)

    // те же байты — тот же файл
    const again = await b.attachments!.put(s.id, 'кадр.png', PNG, 'image/png')
    expect(again.ref).toBe(put.ref)
    expect(readdirSync(join(root, '.nr', 'attachments'))).toHaveLength(1)

    // в ленту — обычным append; fork и удаление исходной ссылку не рвут
    await b.messages!.append!(s.id, [put.part])
    const forked = await b.sessions.fork!(s.id)
    await b.sessions.delete(s.id)
    const [msg] = (await b.history(forked.id)).messages
    expect(msg!.parts[0]).toMatchObject({ type: 'image', meta: { ref: put.ref } })
    expect(existsSync(onDisk)).toBe(true)
  })

  it('имя с каталогами и мусором — только безопасное базовое имя', async () => {
    const root = tmpRoot()
    const b = open({ root })
    const s = await b.sessions.create()
    const put = await b.attachments!.put(s.id, '../../etc/..pass:wd.png', PNG, 'image/png')
    expect(put.ref).toMatch(/^file:\.nr\/attachments\/[0-9a-f]{16}-pass_wd\.png$/)
    expect(existsSync(join(root, put.ref.slice('file:'.length)))).toBe(true)
  })

  it('sessionsDir вне корня файлов — ref всё равно от каталога сессий', async () => {
    const root = tmpRoot()
    const b = open({ root, sessionsDir: 'chats' })
    const s = await b.sessions.create()
    const put = await b.attachments!.put(s.id, 'a.png', PNG, 'image/png')
    expect(put.ref).toMatch(/^file:\.\.\/\.nr\/attachments\/[0-9a-f]{16}-a\.png$/)
    expect(existsSync(join(root, 'chats', put.ref.slice('file:'.length)))).toBe(true)
  })

  it('сессии нет — отказ, байтов на диске нет', async () => {
    const root = tmpRoot()
    const b = open({ root })
    expect(await errOf(b.attachments!.put('нет', 'a.png', PNG, 'image/png'))).toBeTruthy()
    expect(existsSync(join(root, '.nr'))).toBe(false)
  })

  it('неподдержанный тип — bad_request до записи', async () => {
    const root = tmpRoot()
    const b = open({ root })
    const s = await b.sessions.create()
    const err = await errOf(b.attachments!.put(s.id, 'a.exe', new Uint8Array([0x4d, 0x5a, 0]), 'application/x-msdownload'))
    expect((err as { code?: string }).code).toBe('bad_request')
    expect(existsSync(join(root, '.nr'))).toBe(false)
  })
})

describe('файлы пространства', () => {
  it('list видит сессии и файлы; write/read с ревизией; conflict', async () => {
    const root = tmpRoot()
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'docs', 'readme.md'), '# hi')
    const b = open({ root })
    const s = await b.sessions.create()
    await b.messages!.append!(s.id, [{ type: 'text', text: 'x' }])
    const f = b.workspace!.files!

    expect((await f.list()).map((e) => e.name)).toEqual(['docs', `${s.id}.mds`])
    const read = await f.read('docs/readme.md')
    expect(read).toMatchObject({ content: '# hi', encoding: 'utf8' })
    const { revision } = await f.write!('docs/readme.md', '# hello', { revision: read.revision })
    expect(readFileSync(join(root, 'docs', 'readme.md'), 'utf8')).toBe('# hello')
    expect((await errOf(f.write!('docs/readme.md', 'stale', { revision: read.revision })) as { code?: string }).code).toBe(
      'conflict',
    )
    expect((await f.read('docs/readme.md')).revision).toBe(revision)
  })

  it('watch: внешняя запись и запись сессии приезжают workspace_update; close снимает watch', async () => {
    const root = tmpRoot()
    const b = open({ root })
    const got: WorkspaceUpdateEvent[] = []
    const off = b.workspace!.files!.watch!((ev) => got.push(ev))
    await new Promise((r) => setTimeout(r, 50))

    writeFileSync(join(root, 'outside.txt'), 'от другого процесса')
    await waitFor(() => got.some((e) => e.paths.includes('outside.txt')))

    const s = await b.sessions.create()
    await b.messages!.append!(s.id, [{ type: 'text', text: 'x' }])
    await waitFor(() => got.some((e) => e.paths.includes(`${s.id}.mds`)))

    off()
    await b.close!()
    expect(() => b.workspace!.files!.watch!(() => {})).toThrow(/закрыто/)
  })
})

describe('сервисы плагинов (plugin-services-spec §4)', () => {
  it('createServicesHost композицией: capability, call, stream; плагин без модуля — не в capability', async () => {
    const root = tmpRoot()
    mkdirSync(join(root, 'services'))
    writeFileSync(
      join(root, 'services', 'hello-service.mjs'),
      `export default function (ctx, meta) {
         meta.on('echo', (p) => p)
         meta.on('root', () => meta.root)
         meta.stream('tick', (p, sink) => { for (let i = 1; i <= 3; i++) sink('tick', { i }) })
       }\n`,
    )
    const warnings: string[] = []
    const services = createServicesHost({
      root,
      plugins: { 'hello-service': 'services/hello-service.mjs', ghost: 'services/ghost.mjs' },
      warn: (m) => warnings.push(m),
    })
    const b = open({ root, services })
    expect((await b.capabilities()).services).toEqual({ 'hello-service': { methods: ['echo', 'root'], streams: ['tick'] } })
    expect(warnings.join('\n')).toMatch(/ghost/)
    expect(await b.services!.call('hello-service', 'echo', { x: 'ы' })).toEqual({ x: 'ы' })
    expect(await b.services!.call('hello-service', 'root')).toBe(root)
    const events: unknown[] = []
    for await (const e of b.services!.stream('hello-service', 'tick')) events.push(e)
    expect(events).toHaveLength(3)
    expect(await errOf(b.services!.call('ghost', 'echo'))).toBeInstanceOf(NotSupportedError)
    // сервис — не файл сессии и не ломает sessions.list
    expect(await b.sessions.list()).toEqual([])
  })

  it('без services — ни capability, ни ops', async () => {
    const b = open({ root: tmpRoot() })
    expect((await b.capabilities()).services).toBeUndefined()
    expect(b.services).toBeUndefined()
  })

  it('close() бэкенда закрывает сервисы', async () => {
    const services = createMemoryServices({ p: (_c, meta) => meta.on('m', () => 1) })
    const b = open({ root: tmpRoot(), services })
    expect(await b.services!.call('p', 'm')).toBe(1)
    await b.close!()
    expect(await errOf(b.services!.call('p', 'm'))).toBeInstanceOf(NotSupportedError)
  })
})
