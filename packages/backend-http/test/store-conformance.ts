/**
 * Конформанс-сюита StoreBackend — поведение createStoreBackend поверх любого
 * SessionStore. Перенос 28 сценариев backend-mds (backend-mds-spec §9),
 * параметризованных драйвером: v1 гоняется на mds-store, но каждый сценарий
 * строит сессии через контракт SessionStore (create/appendNode/setActiveLeaf),
 * а не файловой хирургией — конструкция обязана допускать прогон с другим store.
 *
 * Format-специфика (байт-diff, битый файл, decoders, ref-форма) — не здесь, а в
 * store-специфичных тестах драйвера.
 */

import { describe, expect, it } from 'vitest'
import { ATTACHMENT_MIMES, DEFAULT_ATTACHMENT_MAX_BYTES, estimateTokens } from '@kerneldreams/ui-protocol'
import type { AnyRunEvent, Message, ProtocolBackend, RunEndEvent } from '@kerneldreams/ui-protocol'
import type { NodeInput, SessionStore, StoreNode } from '@kerneldreams/chat-store'
import type { GenerateFn } from '../src/store-backend.js'
import { collect, noGen, scriptGen, textOf } from './store-harness.js'

export interface StoreHandle {
  backend: ProtocolBackend
  store: SessionStore
}

/** Фабрика: свежий store + бэкенд над ним с заданной генерацией. */
export type MakeHandle = (generate: GenerateFn, name?: string) => StoreHandle | Promise<StoreHandle>

// ── seed-хелперы через контракт store (драйверо-нейтрально) ──────────────────

async function fresh(store: SessionStore): Promise<string> {
  return (await store.create()).id
}

function add(
  store: SessionStore,
  sid: string,
  role: string,
  content: string | NodeInput['parts'],
  parent?: string,
): Promise<StoreNode> {
  const node: NodeInput =
    typeof content === 'string' ? { role, text: content, parent } : { role, parts: content, parent }
  return store.appendNode(sid, node)
}

/** Линейный диалог: user 'вопрос' → assistant 'старый ответ'. */
async function seedLinear(store: SessionStore): Promise<{ sid: string; u1: string; a1: string }> {
  const sid = await fresh(store)
  const u1 = await add(store, sid, 'user', 'вопрос')
  const a1 = await add(store, sid, 'assistant', 'старый ответ')
  return { sid, u1: u1.id, a1: a1.id }
}

export function storeBackendConformance(label: string, make: MakeHandle): void {
  describe(`StoreBackend конформанс — ${label}`, () => {
    // ── Хранение ─────────────────────────────────────────────────────────────

    describe('хранение', () => {
      it('create / get / list / delete', async () => {
        const { backend } = await make(noGen)
        const created = await backend.sessions.create({ title: 'Первая' })
        expect(created.title).toBe('Первая')
        expect(created.id).toBeTruthy()

        expect(await backend.sessions.get(created.id)).toMatchObject({ id: created.id, title: 'Первая' })
        expect(await backend.sessions.list()).toHaveLength(1)

        await backend.sessions.delete(created.id)
        expect(await backend.sessions.list()).toHaveLength(0)
      })

      it('version меняется на каждой мутации', async () => {
        const { backend, store } = await make(noGen)
        const { sid, u1, a1 } = await seedLinear(store)

        const v0 = (await backend.history(sid)).version
        await backend.messages!.hide!(sid, a1, true)
        const v1 = (await backend.history(sid)).version
        await backend.messages!.edit!(sid, u1, { text: 'здравствуй' })
        const v2 = (await backend.history(sid)).version

        expect(v0).not.toBe(v1)
        expect(v1).not.toBe(v2)
      })

      it('botId персистится на create и отдаётся в get', async () => {
        const { backend } = await make(noGen)
        const created = await backend.sessions.create({ title: 'С ботом', botId: 'claude' })
        expect(created.botId).toBe('claude')
        expect((await backend.sessions.get(created.id)).botId).toBe('claude')
      })

      it('rename меняет title сессии (примитив, не sessionMeta)', async () => {
        const { backend } = await make(noGen)
        const created = await backend.sessions.create({ title: 'старое' })
        await backend.sessions.rename!(created.id, 'новое')
        expect((await backend.sessions.get(created.id)).title).toBe('новое')
        // meta.get не задет — rename пишет хедер, не sessionMeta
        if (backend.meta) expect(await backend.meta.get(created.id)).not.toHaveProperty('title')
      })

      it('id-first: appendNode чтит явный NodeInput.id как id записи', async () => {
        const { store } = await make(noGen)
        const sid = await fresh(store)
        const written = await store.appendNode(sid, { role: 'user', text: 'привет', id: 'want-me' })
        expect(written.id).toBe('want-me')
        // id стабилен: та же нода в load несёт тот же id
        const model = await store.load(sid)
        expect(model.nodes.some((n) => n.id === 'want-me')).toBe(true)
      })
    })

    // ── Дерево ───────────────────────────────────────────────────────────────

    describe('дерево', () => {
      it('swipe → history отдаёт другой хвост', async () => {
        const { backend, store } = await make(noGen)
        const sid = await fresh(store)
        const u1 = await add(store, sid, 'user', 'вопрос')
        await add(store, sid, 'assistant', 'ответ раз')
        const a2 = await add(store, sid, 'assistant', 'ответ два', u1.id)
        await store.setActiveLeaf!(sid, a2.id)

        // активный хвост — ветка a2
        expect(textOf((await backend.history(sid)).messages[1])).toBe('ответ два')

        const swiped = await backend.messages!.swipe!(sid, a2.id, { dir: 'prev' })
        expect(textOf(swiped)).toBe('ответ раз')
        expect(swiped.swipes).toEqual({ active: 0, count: 2 })

        // хвост сменился
        expect(textOf((await backend.history(sid)).messages[1])).toBe('ответ раз')
      })

      it('delete середины → дети перецеплены, история не склеилась', async () => {
        const { backend, store } = await make(noGen)
        const sid = await fresh(store)
        const u1 = await add(store, sid, 'user', 'корень')
        await add(store, sid, 'assistant', 'ветка А')
        const a2 = await add(store, sid, 'assistant', 'ветка Б', u1.id)
        await store.setActiveLeaf!(sid, a2.id)
        await add(store, sid, 'user', 'продолжение Б') // ребёнок a2 (активный лист)

        await backend.messages!.delete!(sid, a2.id)

        const msgs = (await backend.history(sid)).messages
        // без явного перецепа "продолжение Б" склеилось бы с "ветка А"
        expect(msgs.map(textOf)).toEqual(['корень', 'продолжение Б'])
      })
    })

    // ── Edits ────────────────────────────────────────────────────────────────

    describe('edits', () => {
      async function seedThinking(store: SessionStore): Promise<{ sid: string; u1: string; a1: string }> {
        const sid = await fresh(store)
        const u1 = await add(store, sid, 'user', 'вопрос')
        const a1 = await add(store, sid, 'assistant', [
          { type: 'text', text: 'ответ' },
          { type: 'thinking', text: 'размышление' },
        ])
        return { sid, u1: u1.id, a1: a1.id }
      }

      it('правка assistant text-шорткатом: суб-часть thinking выживает', async () => {
        const { backend, store } = await make(noGen)
        const { sid, a1 } = await seedThinking(store)
        const edited = await backend.messages!.edit!(sid, a1, { text: 'новый ответ' })
        expect(textOf(edited)).toBe('новый ответ')
        expect(edited.parts.some((p) => p.type === 'thinking')).toBe(true)
      })

      it('правка через parts: пересборка группы', async () => {
        const { backend, store } = await make(noGen)
        const { sid, a1 } = await seedThinking(store)
        const edited = await backend.messages!.edit!(sid, a1, {
          parts: [
            { type: 'text', text: 'ответ 2' },
            { type: 'thinking', text: 'мысль 2' },
          ],
        })
        expect(textOf(edited)).toBe('ответ 2')
        const think = edited.parts.find((p) => p.type === 'thinking')
        expect(think && 'text' in think ? think.text : '').toBe('мысль 2')
      })

      it('ifHash: mismatch → conflict', async () => {
        const { backend, store } = await make(noGen)
        const { sid, u1 } = await seedThinking(store)
        const err = await backend.messages!.edit!(sid, u1, { text: 'x', ifHash: 'deadbeef' }).then(
          () => null,
          (e) => e,
        )
        expect((err as { code?: string })?.code).toBe('conflict')
      })

      it('ifHash: совпадение → правка проходит', async () => {
        const { backend, store } = await make(noGen)
        const { sid, u1 } = await seedThinking(store)
        const cur = (await backend.history(sid)).messages.find((m) => m.id === u1)!
        const edited = await backend.messages!.edit!(sid, u1, { text: 'исправлено', ifHash: cur.hash })
        expect(textOf(edited)).toBe('исправлено')
      })

      it('hide остаётся в history с флагом', async () => {
        const { backend, store } = await make(noGen)
        const { sid, u1 } = await seedThinking(store)
        await backend.messages!.hide!(sid, u1, true)
        const hist = await backend.history(sid)
        expect(hist.messages.find((m) => m.id === u1)!.flags?.disabled).toBe(true)
      })
    })

    // ── Fork (семантика 'copy') ────────────────────────────────────────────────

    describe('fork', () => {
      it('новая сессия: parentSessionId/forkMessageId, линейная копия пути', async () => {
        const { backend, store } = await make(noGen)
        const sid = await fresh(store)
        const u1 = await add(store, sid, 'user', 'раз')
        await add(store, sid, 'assistant', 'старая ветка')
        const a2 = await add(store, sid, 'assistant', 'два', u1.id)
        await store.setActiveLeaf!(sid, a2.id)

        const forked = await backend.sessions.fork!(sid, a2.id)
        expect(forked.parentSessionId).toBe(sid)
        expect(forked.forkMessageId).toBe(a2.id)
        expect(forked.id).not.toBe(sid)

        const msgs = (await backend.history(forked.id)).messages
        expect(msgs.map(textOf)).toEqual(['раз', 'два']) // активный путь, без соседней ветки
        expect(msgs.every((m) => !m.swipes)).toBe(true) // копия линейная
        // Дерево сессий (П-13): родитель виден и в списке — панель веток строится по нему.
        expect((await backend.sessions.list()).find((s) => s.id === forked.id)?.parentSessionId).toBe(sid)
        expect((await backend.capabilities()).fork).toBe('tree')
      })
    })

    // ── sessionMeta ────────────────────────────────────────────────────────────

    describe('sessionMeta', () => {
      it('patch заменяет ключ и добавляет новый; get возвращает', async () => {
        const { backend, store } = await make(noGen)
        const sid = await fresh(store)
        await backend.meta!.patch(sid, { notes: 'старые' })
        const after = (await backend.meta!.patch(sid, { notes: 'новые', summary: 'итог' })) as Record<string, unknown>
        expect(after.notes).toBe('новые')
        expect(after.summary).toBe('итог')
        expect(await backend.meta!.get(sid)).toMatchObject({ notes: 'новые', summary: 'итог' })
      })
    })

    // ── Run-лайфцикл (§6) ──────────────────────────────────────────────────────

    describe('вложения (attachments-spec §2–3)', () => {
      const utf8 = (s: string) => new TextEncoder().encode(s)

      it('capabilities: attachments-объект с лимитом, edits.append', async () => {
        const { backend } = await make(noGen)
        const caps = await backend.capabilities()
        expect(caps.attachments).toEqual({ maxBytes: DEFAULT_ATTACHMENT_MAX_BYTES, mimes: [...ATTACHMENT_MIMES], get: true })
        expect(caps.edits?.append).toBe(true)
        expect(caps.run).toEqual({ continue: true, vars: true })
      })

      it('attachments.get (v1.10): put → get байт в байт', async () => {
        const { backend } = await make(noGen)
        const s = await backend.sessions.create()
        const { ref } = await backend.attachments!.put(s.id, 'a.png', new Uint8Array([0x89, 0, 1]), 'image/png')
        const got = await backend.attachments!.get!(s.id, ref)
        expect(got).toMatchObject({ ref, encoding: 'base64', size: 3, mime: 'image/png' })
        expect(Buffer.from(got.content, 'base64')).toEqual(Buffer.from([0x89, 0, 1]))
      })

      it('put текстового файла → готовая file-part; append кладёт её сообщением без рана', async () => {
        const { backend } = await make(noGen)
        const s = await backend.sessions.create()
        const text = '# план\nшаг 1'

        const { ref, part } = await backend.attachments!.put(s.id, 'note.md', utf8(text), 'text/markdown')
        expect(part).toEqual({
          type: 'file',
          text,
          meta: { name: 'note.md', mime: 'text/markdown', ref, tokens: estimateTokens(text) },
        })

        const msg = await backend.messages!.append!(s.id, [part])
        expect(msg).toMatchObject({ role: 'user', parts: [part] })
        expect(msg.hash).toBeTruthy()

        const hist = await backend.history(s.id)
        expect(hist.messages.map((m) => m.id)).toEqual([msg.id])
        expect(hist.messages[0].parts).toEqual([part])
      })

      it('вложение уходит в generate; скрытое (hide) — нет', async () => {
        let seen: Message[] = []
        const { backend } = await make(
          scriptGen({ chunks: [{ type: 'text', delta: 'ок' }], onRequest: (req) => { seen = req.messages } }),
        )
        const s = await backend.sessions.create()
        const { part } = await backend.attachments!.put(s.id, 'secret.txt', utf8('ПАРОЛЬ-42'), 'text/plain')
        const attached = await backend.messages!.append!(s.id, [part])

        await collect(backend.run(s.id, { userMessage: 'что в файле?' }))
        expect(seen.map((m) => m.id)).toContain(attached.id)
        expect(seen.find((m) => m.id === attached.id)!.parts).toEqual([part])

        await backend.messages!.hide!(s.id, attached.id, true)
        await collect(backend.run(s.id, { userMessage: 'а теперь?' }))
        expect(seen.map((m) => m.id)).not.toContain(attached.id)
        expect(JSON.stringify(seen)).not.toContain('ПАРОЛЬ-42')
        // в истории скрытое вложение осталось — выключено, а не удалено
        expect((await backend.history(s.id)).messages.map((m) => m.id)).toContain(attached.id)
      })

      it('картинка → image-part без текста; append смешанных частей', async () => {
        const { backend } = await make(noGen)
        const s = await backend.sessions.create()
        const { ref, part } = await backend.attachments!.put(s.id, 'shot.png', new Uint8Array([0x89, 0x50, 1]), 'image/png')
        expect(part).toEqual({ type: 'image', meta: { ref, alt: 'shot.png', mime: 'image/png' } })
        const msg = await backend.messages!.append!(s.id, [part])
        expect((await backend.history(s.id)).messages.find((m) => m.id === msg.id)!.parts[0]).toMatchObject({
          type: 'image',
          meta: { ref, mime: 'image/png' },
        })
      })

      it('отказ: чужой тип и лимит → bad_request, сессия не тронута', async () => {
        const { backend, store } = await make(noGen)
        const s = await backend.sessions.create()
        await expect(backend.attachments!.put(s.id, 'a.pdf', utf8('%PDF'), 'application/pdf')).rejects.toMatchObject({
          code: 'bad_request',
        })
        const big = new Uint8Array(DEFAULT_ATTACHMENT_MAX_BYTES + 1).fill(0x61)
        await expect(backend.attachments!.put(s.id, 'big.txt', big, 'text/plain')).rejects.toMatchObject({
          code: 'bad_request',
          message: expect.stringMatching(/лимит/),
        })
        expect((await store.load(s.id)).nodes).toHaveLength(0)
      })

      it('append: пустые parts — bad_request; посреди рана — busy', async () => {
        const { backend } = await make(scriptGen({ chunks: [{ type: 'text', delta: '…' }], waitAbort: true }))
        const s = await backend.sessions.create()
        await expect(backend.messages!.append!(s.id, [])).rejects.toMatchObject({ code: 'bad_request' })

        const iter = backend.run(s.id, { userMessage: 'зависни' })[Symbol.asyncIterator]()
        const first = await iter.next()
        await expect(backend.messages!.append!(s.id, [{ type: 'text', text: 'x' }])).rejects.toMatchObject({
          code: 'busy',
        })
        await backend.cancel(s.id, (first.value as { runId: string }).runId)
        while (!(await iter.next()).done) { /* drain */ }
      })
    })

    describe('run', () => {
      it('порядок событий, id-first, запись только на done', async () => {
        const gen = scriptGen({
          chunks: [
            { type: 'thinking', delta: 'думаю' },
            { type: 'text', delta: 'При' },
            { type: 'text', delta: 'вет' },
            { type: 'model', model: 'test-1' },
            { type: 'usage', input: 5, output: 3 },
          ],
        })
        const { backend } = await make(gen)
        const s = await backend.sessions.create({ title: 'Диалог' })

        const events: AnyRunEvent[] = []
        let midRunHadAssistant = false
        for await (const ev of backend.run(s.id, { userMessage: 'привет' })) {
          events.push(ev)
          if (ev.type === 'part_delta') {
            const mid = await backend.history(s.id)
            if (mid.messages.some((m) => m.role === 'assistant')) midRunHadAssistant = true
          }
        }

        expect(events.map((e) => e.type)).toEqual([
          'run_start',
          'message_start', // user
          'message_end', // user
          'message_start', // assistant
          'part_start', // thinking
          'part_delta',
          'part_start', // text
          'part_delta',
          'part_delta',
          'part_end', // thinking
          'part_end', // text
          'message_end',
          'run_end',
        ])

        // id-first: id ассистента в message_start == id в message_end
        const aStart = events.find((e, i) => e.type === 'message_start' && i > 2) as { message: { id: string } }
        const aEnd = events.filter((e) => e.type === 'message_end').at(-1) as { message: Message }
        expect(aStart.message.id).toBe(aEnd.message.id)

        // запись только на done: ассистента не было в истории во время стрима
        expect(midRunHadAssistant).toBe(false)

        expect(textOf(aEnd.message)).toBe('Привет')
        expect(aEnd.message.parts.some((p) => p.type === 'thinking')).toBe(true)
        expect(aEnd.message.meta?.model).toBe('test-1')
        expect(aEnd.message.meta?.usage).toEqual({ input: 5, output: 3 })

        const end = events.at(-1) as RunEndEvent
        expect(end.status).toBe('done')
        expect(end.usage).toEqual({ input: 5, output: 3 })
        expect(end.version).toBeTruthy()
      })

      it('пустой input = continue: generate получает активный путь как есть', async () => {
        let seen: Message[] = []
        const gen = scriptGen({ chunks: [{ type: 'text', delta: 'ещё' }], onRequest: (r) => (seen = r.messages) })
        const { backend, store } = await make(gen)
        const { sid } = await seedLinear(store)

        await collect(backend.run(sid, {}))
        expect(seen.map(textOf)).toEqual(['вопрос', 'старый ответ'])
      })

      it('hidden не попадает в generate, но остаётся в history', async () => {
        let seen: Message[] = []
        const gen = scriptGen({ chunks: [{ type: 'text', delta: 'ok' }], onRequest: (r) => (seen = r.messages) })
        const { backend, store } = await make(gen)
        const { sid, u1 } = await seedLinear(store)

        await backend.messages!.hide!(sid, u1, true)
        await collect(backend.run(sid, {}))

        expect(seen.map(textOf)).not.toContain('вопрос') // скрыто от LLM
        expect((await backend.history(sid)).messages.some((m) => m.flags?.disabled)).toBe(true)
      })

      it('cancel пишет частичное, status cancelled', async () => {
        const gen = scriptGen({ chunks: [{ type: 'text', delta: 'начал' }], waitAbort: true })
        const { backend } = await make(gen)
        const s = await backend.sessions.create()

        const events: AnyRunEvent[] = []
        const iter = backend.run(s.id, { userMessage: 'давай' })[Symbol.asyncIterator]()
        for (;;) {
          const { value, done } = await iter.next()
          if (done) break
          events.push(value)
          if (value.type === 'part_delta') await backend.cancel(s.id, (value as { runId: string }).runId)
        }

        expect((events.at(-1) as RunEndEvent).status).toBe('cancelled')
        const finalMsg = (events.filter((e) => e.type === 'message_end').at(-1) as { message: Message }).message
        expect(textOf(finalMsg)).toBe('начал') // частичный текст записан
        expect(textOf((await backend.history(s.id)).messages.at(-1)!)).toBe('начал')
      })

      it('busy: второй run при живом ране → ошибка', async () => {
        const gen = scriptGen({ chunks: [{ type: 'text', delta: 'жду' }], waitAbort: true })
        const { backend } = await make(gen)
        const s = await backend.sessions.create()

        const iter = backend.run(s.id, { userMessage: 'первый' })[Symbol.asyncIterator]()
        const first = (await iter.next()).value as { type: string; runId: string } // run_start (activeRuns уже содержит sid)

        const err = await collect(backend.run(s.id, { userMessage: 'второй' })).then(
          () => null,
          (e) => e,
        )
        expect((err as { code?: string })?.code).toBe('busy')

        await backend.cancel(s.id, first.runId)
        for (;;) {
          const { done } = await iter.next()
          if (done) break
        }
      })

      it('мутация при живом ране → busy', async () => {
        const gen = scriptGen({ chunks: [{ type: 'text', delta: 'жду' }], waitAbort: true })
        const { backend, store } = await make(gen)
        const { sid, u1 } = await seedLinear(store)

        const iter = backend.run(sid, {})[Symbol.asyncIterator]()
        const first = (await iter.next()).value as { type: string; runId: string }

        const err = await backend.messages!.edit!(sid, u1, { text: 'нельзя' }).then(
          () => null,
          (e) => e,
        )
        expect((err as { code?: string })?.code).toBe('busy')

        await backend.cancel(sid, first.runId)
        for (;;) {
          const { done } = await iter.next()
          if (done) break
        }
      })

      it('ошибка generate не трогает store', async () => {
        const gen = scriptGen({ chunks: [], throwErr: new Error('движок отказал') })
        const { backend, store } = await make(gen)
        const { sid } = await seedLinear(store)

        const before = await backend.history(sid)
        const events = await collect(backend.run(sid, {}))
        const end = events.at(-1) as RunEndEvent
        expect(end.status).toBe('error')
        expect(end.error?.message).toContain('движок отказал')

        const after = await backend.history(sid)
        expect(after.version).toBe(before.version) // store не тронут
        expect(after.messages.map(textOf)).toEqual(before.messages.map(textOf))
      })

      it('regenerate → sibling + swipes в history', async () => {
        const gen = scriptGen({ chunks: [{ type: 'text', delta: 'новый ответ' }] })
        const { backend, store } = await make(gen)
        const { sid, a1 } = await seedLinear(store)

        const events = await collect(backend.run(sid, { regenerate: { messageId: a1 } }))
        expect((events.at(-1) as RunEndEvent).status).toBe('done')

        const msgs = (await backend.history(sid)).messages
        expect(textOf(msgs.at(-1)!)).toBe('новый ответ') // активный хвост — новая ветка
        expect(msgs.at(-1)!.swipes).toEqual({ active: 1, count: 2 }) // это свайп: две ветки
      })
    })
  })
}
