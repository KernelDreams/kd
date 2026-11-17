/**
 * Персоны поверх store-backend и провода (personas-spec §3, §5).
 *
 * Фикстура для e2e nrchat: документ персон в памяти, имена в фикстурном
 * generate. Проверяется контракт: в store текст чистый, имя — `meta.personaId`;
 * префиксы и блок участников — только когда имена в ходу.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import type { Message, Persona, ProtocolBackend } from '@kerneldreams/ui-protocol'
import { derivedText } from '@kerneldreams/ui-protocol'
import { BackendError, createHttpBackend } from '../src/client.js'
import { serveBackend, type ServeHandle } from '../src/serve.js'
import { createStoreBackend, type GenerateRequest, type GenChunk } from '../src/store-backend.js'
import { collect, scriptGen } from './store-harness.js'

let srv: ServeHandle | undefined
let client: ProtocolBackend | undefined

afterEach(async () => {
  await client?.close?.()
  await srv?.close()
  srv = undefined
  client = undefined
})

const alice: Persona = { id: 'alice', kind: 'char', name: 'Alice' }
const bob: Persona = { id: 'bob', kind: 'char', name: 'Bob', prompt: 'Ворчи на {{user}}.' }
const me: Persona = { id: 'me', kind: 'user', name: 'owner' }

function fixture(seen: GenerateRequest[] = [], chunks: GenChunk[] = [{ type: 'text', delta: 'ответ' }]): ProtocolBackend {
  return createStoreBackend({
    store: createMemoryStore(),
    generate: scriptGen({ chunks, onRequest: (req) => seen.push(req) }),
    personas: true,
    prompts: { system: 'база' },
  })
}

const text = (m: Message) => derivedText(m)

describe('store-backend: personas', () => {
  it('без опции — ни capability, ни метода', async () => {
    const backend = createStoreBackend({ store: createMemoryStore(), generate: scriptGen({ chunks: [] }) })
    expect((await backend.capabilities()).personas).toBeUndefined()
    expect(backend.personas).toBeUndefined()
  })

  it('list/save: документ целиком, битый — bad_request', async () => {
    const backend = fixture()
    expect((await backend.capabilities()).personas).toEqual({ edit: true, multi: true })
    const s = await backend.sessions.create()
    expect(await backend.personas!.list(s.id)).toEqual({ personas: [] })
    expect(await backend.personas!.save!(s.id, [alice, me], 'me')).toEqual({ personas: [alice, me], userId: 'me' })
    expect(await backend.personas!.list(s.id)).toEqual({ personas: [alice, me], userId: 'me' })
    await expect(backend.personas!.save!(s.id, [alice, { ...alice }])).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('один собеседник: имена не приписываются, {{char}}/{{user}} раскрыты, personaId проставлен', async () => {
    const seen: GenerateRequest[] = []
    const backend = fixture(seen)
    const s = await backend.sessions.create()
    await backend.personas!.save!(s.id, [alice, me], 'me')
    await backend.meta!.patch(s.id, { prompt: { pre: 'Ты {{char}}, собеседник — {{user}}.' } })
    await collect(backend.run(s.id, { userMessage: 'привет' }))

    const req = seen[0]!
    expect(req.persona?.id).toBe('alice')
    expect(req.system).toBeUndefined()
    expect(text(req.messages[0]!)).toBe('привет')
    expect((req.sessionMeta as { prompt: { pre: string } }).prompt.pre).toBe('Ты Alice, собеседник — owner.')

    const { messages } = await backend.history(s.id)
    expect(messages.map((m) => m.meta?.personaId)).toEqual(['me', 'alice'])
  })

  it('двое собеседников: префиксы и блок в generate, в store текст без префикса, ход выбранной', async () => {
    const seen: GenerateRequest[] = []
    // Модель отвечает с префиксом — фикстура его срезает.
    const backend = fixture(seen, [{ type: 'text', delta: 'Bob: ' }, { type: 'text', delta: 'ну и что?' }])
    const s = await backend.sessions.create()
    await backend.personas!.save!(s.id, [alice, bob, me], 'me')

    await collect(backend.run(s.id, { userMessage: 'привет', personaId: 'bob' }))
    await collect(backend.run(s.id, { userMessage: 'а ты?', personaId: 'alice' }))

    const { messages } = await backend.history(s.id)
    expect(messages.map(text)).toEqual(['привет', 'ну и что?', 'а ты?', 'ну и что?'])
    // Ответ второго рана назвался Bob — префикс известной персоны побеждает ход.
    expect(messages.map((m) => m.meta?.personaId)).toEqual(['me', 'bob', 'me', 'bob'])

    const first = seen[0]!
    expect(first.persona?.id).toBe('bob')
    expect(first.system).toContain('Сейчас ход: Bob.')
    expect(first.system).toContain('Ворчи на owner.')
    expect(first.messages.map(text)).toEqual(['owner: привет'])
    expect(seen[1]!.messages.map(text)).toEqual(['owner: привет', 'Bob: ну и что?', 'owner: а ты?'])
    expect(seen[1]!.system).not.toContain('Ворчи')
  })

  it('рецепт: блок участников инъекцией persona, personaId ответа', async () => {
    const backend = fixture([], [{ type: 'text', delta: 'Alice: да' }])
    const s = await backend.sessions.create()
    await backend.personas!.save!(s.id, [alice, bob, me], 'me')
    await collect(backend.run(s.id, { userMessage: 'кто тут?' }))
    const answer = (await backend.history(s.id)).messages.at(-1)!
    const view = await backend.messages!.prompt!(s.id, answer.id)
    expect(view.recipe.personaId).toBe('alice')
    expect(view.injections[0]).toMatchObject({ role: 'system', source: 'persona' })
    expect(view.system.startsWith('база\n\nВ этом диалоге участвуют:')).toBe(true)
  })

  it('чужой personaId — bad_request до записи; regenerate держит персону ответа', async () => {
    const seen: GenerateRequest[] = []
    const backend = fixture(seen)
    const s = await backend.sessions.create()
    await backend.personas!.save!(s.id, [alice, bob, me], 'me')
    await expect(collect(backend.run(s.id, { userMessage: 'x', personaId: 'ghost' }))).rejects.toMatchObject({
      code: 'bad_request',
    })
    expect((await backend.history(s.id)).messages).toEqual([])

    await collect(backend.run(s.id, { userMessage: 'x', personaId: 'bob' }))
    const answer = (await backend.history(s.id)).messages.at(-1)!
    await collect(backend.run(s.id, { regenerate: { messageId: answer.id } }))
    expect(seen.at(-1)!.persona?.id).toBe('bob')
    expect((await backend.history(s.id)).messages.at(-1)!.meta?.personaId).toBe('bob')
  })

  it('провод: GET/PUT /sessions/:id/personas, битый — 400', async () => {
    const backend = fixture()
    srv = await serveBackend(backend, { port: 0 })
    client = createHttpBackend(srv.url)
    const s = await client.sessions.create()
    expect(await client.personas!.save!(s.id, [alice, me], 'me')).toEqual({ personas: [alice, me], userId: 'me' })
    expect(await client.personas!.list(s.id)).toEqual({ personas: [alice, me], userId: 'me' })
    const err = await client.personas!.save!(s.id, [alice], 'me').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BackendError)
    expect((err as BackendError).code).toBe('bad_request')
  })

  it('провод: MessageMeta.to/seen (шёпот, свидетели) — round-trip до history()', async () => {
    const store = createMemoryStore()
    const backend = createStoreBackend({ store, generate: scriptGen({ chunks: [] }), personas: true })
    srv = await serveBackend(backend, { port: 0 })
    client = createHttpBackend(srv.url)
    const s = await client.sessions.create()
    await store.appendNode(s.id, { role: 'user', parts: [{ type: 'text', text: 'шепчу' }], meta: { personaId: 'me', to: 'bob', seen: ['bob'] } })
    await store.appendNode(s.id, { role: 'assistant', parts: [{ type: 'text', text: 'всем' }], meta: { personaId: 'alice', seen: ['alice', 'bob'] } })
    const { messages } = await client.history(s.id)
    expect(messages.map(({ meta: { createdAt: _, ...rest } = {} }) => rest)).toEqual([
      { personaId: 'me', to: 'bob', seen: ['bob'] },
      { personaId: 'alice', seen: ['alice', 'bob'] },
    ])
  })
})
