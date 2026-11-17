/**
 * StoreBackend на mds-драйвере: конформанс-сюита (общая) + mds-специфика,
 * которую не выразить драйверо-нейтрально (битый файл, id≠имя файла, форма ref,
 * сайдкар на диске). Плюс граничные наблюдения (rename) для вердикта слияния.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNrChatStore } from '@kerneldreams/chat-store/nr-chat'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import { createStoreBackend, StoreUnknownModelError, type GenerateFn, type StoreBackendOpts } from '../src/store-backend.js'
import type { ModelInfo } from '@kerneldreams/ui-protocol'
import { storeBackendConformance, type StoreHandle } from './store-conformance.js'
import { noGen, scriptGen } from './store-harness.js'

function mkMds(generate: GenerateFn, name = 'mds'): StoreHandle & { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'store-be-'))
  const store = createNrChatStore({ dir })
  const backend = createStoreBackend({ store, generate, name })
  return { backend, store, dir }
}

// Общая конформанс-сюита — на mds-драйвере (v1).
storeBackendConformance('mds', (generate, name) => mkMds(generate, name))

// ── mds-специфика (не переносима на другой store) ────────────────────────────

describe('regenerate: контекст обрывается на родителе', () => {
  it('свайп-возврат на ветку с детьми ставит лист на глубину ветки, не на sibling', async () => {
    const { backend, store } = mkMds(scriptGen({ chunks: [{ type: 'text', text: 'x' }] }))
    const s = await backend.sessions.create()
    // ветка А с глубиной: user → asst1 → user2 → asst2
    for await (const _ of backend.run(s.id, { userMessage: 'q1' })) { /* drain */ }
    const asst1 = (await store.load(s.id)).nodes.filter((n) => n.role === 'assistant').at(-1)!
    for await (const _ of backend.run(s.id, { userMessage: 'q2' })) { /* drain */ }
    const deepLeaf = (await store.load(s.id)).nodes.filter((n) => n.role === 'assistant').at(-1)!
    // свайп asst1 → новый sibling (ветка Б, лист на нём)
    for await (const _ of backend.run(s.id, { regenerate: { messageId: asst1.id } })) { /* drain */ }
    // свайп-возврат на ветку А (index 0) → лист = ГЛУБИНА ветки (asst2), не asst1
    await backend.messages.swipe!(s.id, asst1.id, { index: 0 })
    const hist = await backend.history(s.id)
    const ids = hist.messages.map((m) => m.id)
    expect(ids).toContain(asst1.id)
    expect(ids.at(-1)).toBe(deepLeaf.id)
  })

  it('старый ответ НЕ едет в промпт свайпа (баг эха: usage.input рос на output старого)', async () => {
    let lastReq: { messages: { id: string; role: string }[] } | undefined
    const gen = scriptGen({
      chunks: [{ type: 'text', text: 'ответ' }],
      onRequest: (req) => { lastReq = req as never },
    })
    const { backend, store } = mkMds(gen)
    const s = await backend.sessions.create()
    // первый ран: user → assistant
    for await (const _ of backend.run(s.id, { userMessage: 'вопрос' })) { /* drain */ }
    const path1 = (await store.load(s.id)).nodes.filter((n) => n.role !== 'meta')
    const oldAssistant = path1.at(-1)!
    expect(oldAssistant.role).toBe('assistant')
    // regenerate старого ответа
    for await (const _ of backend.run(s.id, { regenerate: { messageId: oldAssistant.id } })) { /* drain */ }
    // промпт второго рана: старого ответа в нём НЕТ, последнее — user-родитель
    const ids = lastReq!.messages.map((m) => m.id)
    expect(ids).not.toContain(oldAssistant.id)
    expect(lastReq!.messages.at(-1)!.role).toBe('user')
    // а в дереве — два sibling'а под одним родителем
    const after = (await store.load(s.id)).nodes.filter((n) => n.role === 'assistant')
    expect(after.length).toBe(2)
  })
})

describe('regenerate при disabled-родителе / запоздалый cancel', () => {
  it('родитель регенерируемого disabled → старый ответ и будущая история всё равно НЕ едут в промпт', async () => {
    let lastReq: { messages: { id: string; role: string }[] } | undefined
    const gen = scriptGen({ chunks: [{ type: 'text', text: 'a' }], onRequest: (req) => { lastReq = req as never } })
    const { backend, store } = mkMds(gen)
    const s = await backend.sessions.create()
    // u0 → a0 → u1 → OLD → u2 → a2
    for await (const _ of backend.run(s.id, { userMessage: 'q0' })) { /* drain */ }
    for await (const _ of backend.run(s.id, { userMessage: 'q1' })) { /* drain */ }
    const nodes1 = (await store.load(s.id)).nodes.filter((n) => n.role !== 'meta')
    const u1 = nodes1.at(-2)!
    const OLD = nodes1.at(-1)!
    expect(u1.role).toBe('user')
    expect(OLD.role).toBe('assistant')
    for await (const _ of backend.run(s.id, { userMessage: 'q2' })) { /* drain */ }
    const future = (await store.load(s.id)).nodes.filter((n) => n.role !== 'meta').slice(-2).map((n) => n.id)
    // отключаем родителя OLD
    await backend.messages.hide!(s.id, u1.id, true)
    for await (const _ of backend.run(s.id, { regenerate: { messageId: OLD.id } })) { /* drain */ }
    const ids = lastReq!.messages.map((m) => m.id)
    expect(ids).not.toContain(u1.id)
    expect(ids).not.toContain(OLD.id)
    for (const f of future) expect(ids).not.toContain(f)
    // остаётся только u0 → a0
    expect(ids.length).toBe(2)
    expect(lastReq!.messages.at(-1)!.role).toBe('assistant')
  })

  it('cancel с чужим runId — no-op; со своим — abort', async () => {
    const { backend } = mkMds(scriptGen({ chunks: [{ type: 'text', text: 'x' }], waitAbort: true }))
    const s = await backend.sessions.create()
    const iter = backend.run(s.id, { userMessage: 'q' })[Symbol.asyncIterator]()
    let runId: string | undefined
    while (!runId) {
      const { value } = await iter.next()
      if (value?.type === 'run_start') runId = value.runId
    }
    await backend.cancel(s.id, 'STALE-RUN-ID')
    // ран жив: следующий шаг — не run_end (гонка на 50мс)
    const step = await Promise.race([iter.next(), new Promise<'pending'>((r) => setTimeout(() => r('pending'), 50))])
    expect(step === 'pending' || (step as { value?: { type?: string } }).value?.type !== 'run_end').toBe(true)
    await backend.cancel(s.id, runId)
    let ended = false
    for (let i = 0; i < 20 && !ended; i++) {
      const { value, done } = await iter.next()
      if (done || value?.type === 'run_end') ended = true
    }
    expect(ended).toBe(true)
  })
})

describe('mds-специфика', () => {
  it('битый файл в каталоге не валит list', async () => {
    const { backend, dir } = mkMds(noGen)
    await backend.sessions.create({ title: 'норм' })
    writeFileSync(join(dir, 'bad.mds'), '%user {не: валидный json5\nой', 'utf-8')
    const list = await backend.sessions.list()
    expect(list.map((s) => s.title)).toEqual(['норм'])
  })

  it('%meta.id ≠ имя файла → имя файла побеждает', async () => {
    const { backend, dir } = mkMds(noGen)
    writeFileSync(join(dir, 'real.mds'), "%meta {id: 'other'}\n%user\nx\n", 'utf-8')
    expect((await backend.sessions.get('real')).id).toBe('real')
  })

  it('attachments без assets у драйвера: байты держит память бэкенда (attachments-spec §3)', async () => {
    const mem = createMemoryStore()
    const backend = createStoreBackend({ store: { ...mem, assets: undefined }, generate: noGen, name: 'mem' })
    const s = await backend.sessions.create()

    const { ref, part } = await backend.attachments!.put(s.id, 'a.md', new TextEncoder().encode('текст'), 'text/markdown')
    expect(ref).toMatch(new RegExp(`^mem:${s.id}/[0-9a-f]{12}-a\\.md$`))
    expect(part).toMatchObject({ type: 'file', text: 'текст', meta: { ref } })
    // тот же файл — тот же ref: он от байтов, а не от вызова
    expect((await backend.attachments!.put(s.id, 'a.md', new TextEncoder().encode('текст'), 'text/markdown')).ref).toBe(ref)
    // сессии нет — отказ драйвера, а не вложение в пустоту
    await expect(backend.attachments!.put('nope', 'a.md', new Uint8Array([0x61]))).rejects.toThrow()
    // v1.10: байты назад из памяти, mime из put
    expect(await backend.attachments!.get!(s.id, ref)).toEqual({ ref, content: 'текст', encoding: 'utf8', size: 10, mime: 'text/markdown' })
    await expect(backend.attachments!.get!(s.id, 'mem:чужой')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('картинка-вложение в generate (П-1/П-2): байты data:-URL из .assets, путь файла — attachmentPath; лента без байтов', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-be-img-'))
    const store = createNrChatStore({ dir })
    let seen: unknown
    const generate: GenerateFn = async function* (req) {
      seen = req.messages.at(-1)
      yield { type: 'text', delta: 'вижу' }
    }
    const backend = createStoreBackend({ store, generate, attachmentPath: (sid, ref) => join(dir, ref.replace(/^file:/, '')) })
    const s = await backend.sessions.create()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2])
    const { ref, part } = await backend.attachments!.put(s.id, 'a.png', png, 'image/png')
    for await (const _ of backend.run(s.id, { userMessage: [{ type: 'text', text: 'что тут?' }, part] })) { /* drain */ }
    expect(seen).toMatchObject({ role: 'user', parts: [{ type: 'text' }, { type: 'image', meta: { ref, url: `data:image/png;base64,${Buffer.from(png).toString('base64')}`, path: join(dir, `${s.id}.assets`, 'a.png') } }] })
    // В ленте — ref без байтов и пути.
    const stored = (await backend.history(s.id)).messages.find((m) => m.role === 'user')!
    expect(stored.parts[1]!.meta).not.toHaveProperty('url')
    expect(stored.parts[1]!.meta).not.toHaveProperty('path')
  })

  it('чанк image (П-3): картинка тула — отдельным сообщением ассистента с ImagePart, байты во вложениях, path в meta', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-be-gen-img-'))
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9])
    const generate: GenerateFn = async function* () {
      yield { type: 'tool_call', callId: 'c1', name: 'image_generate', args: { prompt: 'apple' } }
      yield { type: 'tool_result', callId: 'c1', name: 'image_generate', text: 'saved gen/0001.png' }
      yield { type: 'image', name: '0001.png', mime: 'image/png', data: png, path: '/w/gen/0001.png' }
      yield { type: 'text', delta: 'Готово — яблоко.' }
    }
    const backend = createStoreBackend({ store: createNrChatStore({ dir }), generate })
    const s = await backend.sessions.create()
    for await (const _ of backend.run(s.id, { userMessage: 'нарисуй яблоко' })) { /* drain */ }
    const msgs = (await backend.history(s.id)).messages
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'assistant'])
    const img = msgs[3]!.parts[0]!
    expect(img).toMatchObject({ type: 'image', meta: { mime: 'image/png', alt: '0001.png', path: '/w/gen/0001.png' } })
    const got = await backend.attachments!.get!(s.id, img.meta!.ref as string)
    expect(got).toMatchObject({ encoding: 'base64', content: Buffer.from(png).toString('base64') })
    expect(msgs[4]!.parts[0]).toMatchObject({ type: 'text', text: 'Готово — яблоко.' })
  })

  it('attachments.get: драйвер без assets.get — capability и метода нет (v1.10)', async () => {
    const mem = createMemoryStore()
    const backend = createStoreBackend({ store: { ...mem, assets: { put: mem.assets!.put } }, generate: noGen, name: 'mem' })
    expect((await backend.capabilities()).attachments).not.toHaveProperty('get')
    expect(backend.attachments!.get).toBeUndefined()
  })

  it('attachments.put: сайдкар на диске, ref формы драйвера', async () => {
    const { backend, dir } = mkMds(noGen)
    const s = await backend.sessions.create()
    const res = await backend.attachments!.put(s.id, 'арт.png', new Uint8Array([0x89, 0x50, 7]), 'image/png')
    expect(res.ref).toBe(`file:${s.id}.assets/арт.png`)
    expect(existsSync(join(dir, s.id + '.assets', 'арт.png'))).toBe(true)
  })

  it('forkCopy копирует сайдкар .assets и переписывает ref в parts', async () => {
    const { backend, store, dir } = mkMds(noGen)
    const s = await backend.sessions.create()
    const { ref } = await backend.attachments!.put(s.id, 'pic.png', new Uint8Array([1, 2, 3]), 'image/png')
    await store.appendNode(s.id, { role: 'user', parts: [{ type: 'image', meta: { mime: 'image/png', ref } }] })

    const forked = await backend.sessions.fork!(s.id)
    // файл сайдкара скопирован под новый id
    expect(existsSync(join(dir, forked.id + '.assets', 'pic.png'))).toBe(true)
    // ref в parts форка указывает на новый сайдкар, не на исходный
    const img = (await backend.history(forked.id)).messages[0].parts.find((p) => p.type === 'image')!
    expect((img as { meta: { ref?: string } }).meta.ref).toBe(`file:${forked.id}.assets/pic.png`)

    // копия независима: удаление исходной сессии не уводит файл форка
    await backend.sessions.delete(s.id)
    expect(readFileSync(join(dir, forked.id + '.assets', 'pic.png'))).toEqual(Buffer.from([1, 2, 3]))
  })

  it('meta.get декодирует тела суб-нод через инъектированные decoders', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-be-'))
    // toon-подобный декодер: считает строки тела
    const store = createNrChatStore({ dir, decoders: { toon: (b) => ({ lines: b.trim().split('\n').length }) } })
    const backend = createStoreBackend({ store, generate: noGen, name: 'mds' })
    const s = await backend.sessions.create()
    // хедер с %%-суб-нодой state{format:'json5'} и notes{format:'toon'}
    writeFileSync(
      join(dir, s.id + '.mds'),
      `%meta {id: '${s.id}'}\n%%state {format: 'json5'}\n{hp: 10}\n%%board {format: 'toon'}\na\nb\nc\n%user\nx\n`,
      'utf-8',
    )
    const meta = await backend.meta!.get(s.id)
    expect(meta.state).toEqual({ hp: 10 }) // json5-декод
    expect(meta.board).toEqual({ lines: 3 }) // инъектированный toon-декодер
  })
})

// ── rename после слияния (гэп закрыт) ──────────────────────────────
describe('sessions.rename на mds', () => {
  it('rename выставлен и меняет title в %meta-хедере (хирургия)', async () => {
    const { backend, dir } = mkMds(noGen)
    expect(backend.sessions.rename).toBeDefined()
    const s = await backend.sessions.create({ title: 'старое' })
    await backend.sessions.rename!(s.id, 'новое имя')
    expect((await backend.sessions.get(s.id)).title).toBe('новое имя')
    // title живёт в маркере хедера файла
    expect(readFileSync(join(dir, s.id + '.mds'), 'utf-8')).toContain('новое имя')
  })
})

describe('заголовок по первой реплике (ABC-228)', () => {
  it('пустой title → первые 40 символов первой реплики; заданный — не трогается', async () => {
    const { backend } = mkMds(scriptGen({ chunks: [{ type: 'text', text: 'ок' }] }))
    const s = await backend.sessions.create()
    const long = 'Привет,   агент! Сделай мне утилиту для просмотра картинок, пожалуйста'
    for await (const _ of backend.run(s.id, { userMessage: long })) { /* drain */ }
    expect((await backend.sessions.get(s.id)).title).toBe('Привет, агент! Сделай мне утилиту для пр…')
    for await (const _ of backend.run(s.id, { userMessage: 'второе' })) { /* drain */ }
    expect((await backend.sessions.get(s.id)).title).toBe('Привет, агент! Сделай мне утилиту для пр…')

    const named = await backend.sessions.create({ title: 'своё' })
    for await (const _ of backend.run(named.id, { userMessage: 'короткое' })) { /* drain */ }
    expect((await backend.sessions.get(named.id)).title).toBe('своё')
  })
})

// ── models (models-spec §5): опция каталога ──────────────────────────────────

describe('пространство: одно и неподвижное (workspace-spec §4)', () => {
  it('capability заявлена без switch, метода switch нет', async () => {
    const { backend } = mkMds(noGen())
    expect((await backend.capabilities()).workspace).toEqual({})
    expect(backend.workspace?.switch).toBeUndefined()
  })

  it('current = {id:"memory", name бэкенда}; list = [current]', async () => {
    const { backend } = mkMds(noGen(), 'мой-store')
    const current = await backend.workspace!.current()
    expect(current).toEqual({ id: 'memory', name: 'мой-store' })
    expect(await backend.workspace!.list()).toEqual([current])
  })
})

describe('models: опция каталога', () => {
  const CATALOG: ModelInfo[] = [
    { id: 'fx/fast', name: 'Fast', provider: 'fx', tags: ['vision'] },
    { id: 'fx/deep', name: 'Deep', provider: 'fx', tags: ['reasoning'], thinking: ['off', 'high'] },
  ]

  function mkWithModels(extra: Partial<StoreBackendOpts> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'store-be-models-'))
    const store = createNrChatStore({ dir })
    const backend = createStoreBackend({ store, generate: scriptGen({ chunks: [{ type: 'text', delta: 'ок' }] }), ...extra })
    return { backend, store }
  }

  it('без опции — capability нет, метода нет', async () => {
    const { backend } = mkWithModels()
    expect((await backend.capabilities()).models).toBeUndefined()
    expect(backend.models).toBeUndefined()
  })

  it('с опцией — capability {select, thinking} и list отдаёт каталог', async () => {
    const { backend } = mkWithModels({ models: CATALOG })
    expect((await backend.capabilities()).models).toEqual({ select: true, thinking: true })
    expect(await backend.models!.list()).toEqual(CATALOG)
  })

  it('каталог без уровней рассуждения — thinking:false', async () => {
    const { backend } = mkWithModels({ models: [CATALOG[0]!] })
    expect((await backend.capabilities()).models).toEqual({ select: true, thinking: false })
  })

  it('set фиксируется на сессии и виден в get/list', async () => {
    const { backend } = mkWithModels({ models: CATALOG })
    const s = await backend.sessions.create()
    expect(s.model).toBeUndefined()

    const applied = await backend.models!.set!(s.id, { model: 'fx/deep', thinking: 'high' })
    expect(applied).toEqual({ model: 'fx/deep', thinking: 'high' })
    expect((await backend.sessions.get(s.id)).model).toEqual(applied)
    expect((await backend.sessions.list()).find((x) => x.id === s.id)?.model).toEqual(applied)
  })

  it('set возвращает ПРИМЕНЁННОЕ: невозможный уровень снимается', async () => {
    const { backend } = mkWithModels({ models: CATALOG })
    const s = await backend.sessions.create()
    expect(await backend.models!.set!(s.id, { model: 'fx/fast', thinking: 'high' })).toEqual({ model: 'fx/fast' })
  })

  it('неизвестная модель → bad_request, выбор не меняется', async () => {
    const { backend } = mkWithModels({ models: CATALOG, defaultModel: { model: 'fx/fast' } })
    const s = await backend.sessions.create()
    const err = await backend.models!.set!(s.id, { model: 'нет/такой' }).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(StoreUnknownModelError)
    expect((err as StoreUnknownModelError).code).toBe('bad_request')
    expect((await backend.sessions.get(s.id)).model).toEqual({ model: 'fx/fast' })
  })

  it('defaultModel — модель сессий без явного выбора', async () => {
    const { backend } = mkWithModels({ models: CATALOG, defaultModel: { model: 'fx/deep', thinking: 'high' } })
    const s = await backend.sessions.create()
    expect(s.model).toEqual({ model: 'fx/deep', thinking: 'high' })
  })

  it('fallbackModel (П-15): сессия без выбора показывает модель рана — $model профиля, иначе стенда; в выбор не пишется', async () => {
    const { backend } = mkWithModels({
      models: CATALOG,
      fallbackModel: 'fx/fast',
      profiles: [{ id: 'default', name: 'Default' }, { id: 'deep', name: 'Deep', model: 'fx/deep' }],
    })
    const s = await backend.sessions.create()
    expect(s.model).toEqual({ model: 'fx/fast' })
    await backend.profiles!.set!(s.id, 'deep')
    expect((await backend.sessions.get(s.id)).model).toEqual({ model: 'fx/deep' })
    await backend.models!.set!(s.id, { model: 'fx/fast' })
    expect((await backend.sessions.get(s.id)).model).toEqual({ model: 'fx/fast' })
  })

  it('create({model}) фиксирует выбор новой сессии', async () => {
    const { backend } = mkWithModels({ models: CATALOG, defaultModel: { model: 'fx/fast' } })
    const s = await backend.sessions.create({ model: { model: 'fx/deep', thinking: 'high' } })
    expect(s.model).toEqual({ model: 'fx/deep', thinking: 'high' })
    // соседняя сессия осталась на дефолте
    const other = await backend.sessions.create()
    expect(other.model).toEqual({ model: 'fx/fast' })
  })

  it('смена посреди рана → busy, применяется к следующему run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-be-models-'))
    const store = createNrChatStore({ dir })
    const backend = createStoreBackend({
      store,
      generate: scriptGen({ chunks: [{ type: 'text', delta: 'ок' }], waitAbort: true }),
      models: CATALOG,
    })
    const s = await backend.sessions.create()

    const iter = backend.run(s.id, { userMessage: 'привет' })[Symbol.asyncIterator]()
    await iter.next() // ран пошёл
    const err = await backend.models!.set!(s.id, { model: 'fx/deep' }).then(() => null, (e: unknown) => e)
    expect((err as { code?: string }).code).toBe('busy')

    await backend.cancel(s.id, `store-${s.id}-1`)
    for (;;) if ((await iter.next()).done) break
    await expect(backend.models!.set!(s.id, { model: 'fx/deep' })).resolves.toEqual({ model: 'fx/deep' })
  })

  it('meta.model ассистента — модель сессии, если генерация молчит', async () => {
    const { backend } = mkWithModels({ models: CATALOG, defaultModel: { model: 'fx/fast' } })
    const s = await backend.sessions.create()
    for await (const _ of backend.run(s.id, { userMessage: 'привет' })) { /* drain */ }
    const last = (await backend.history(s.id)).messages.at(-1)!
    expect(last.role).toBe('assistant')
    expect(last.meta?.model).toBe('fx/fast')
  })

  it('генерация назвала модель — её и пишем, а не модель сессии', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-be-models-'))
    const store = createNrChatStore({ dir })
    const backend = createStoreBackend({
      store,
      generate: scriptGen({ chunks: [{ type: 'text', delta: 'ок' }, { type: 'model', model: 'fx/fallback' }] }),
      models: CATALOG,
      defaultModel: { model: 'fx/fast' },
    })
    const s = await backend.sessions.create()
    for await (const _ of backend.run(s.id, { userMessage: 'привет' })) { /* drain */ }
    expect((await backend.history(s.id)).messages.at(-1)!.meta?.model).toBe('fx/fallback')
  })

  it('generate видит модель сессии в req.session.model', async () => {
    let seen: unknown
    const dir = mkdtempSync(join(tmpdir(), 'store-be-models-'))
    const store = createNrChatStore({ dir })
    const backend = createStoreBackend({
      store,
      generate: scriptGen({ chunks: [{ type: 'text', delta: 'ок' }], onRequest: (r) => { seen = r.session.model } }),
      models: CATALOG,
    })
    const s = await backend.sessions.create()
    await backend.models!.set!(s.id, { model: 'fx/deep', thinking: 'high' })
    for await (const _ of backend.run(s.id, { userMessage: 'привет' })) { /* drain */ }
    expect(seen).toEqual({ model: 'fx/deep', thinking: 'high' })
  })
})
