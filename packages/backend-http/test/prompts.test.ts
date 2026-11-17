/**
 * Промпт сообщения поверх store-backend и провода (prompt-recipe-spec §2, §5).
 *
 * Фикстура для e2e nrchat: рецепт каждого рана в памяти. Проверяется контракт,
 * а не хранение: system с pre меты, post — инъекцией, сообщения — ровно то, что
 * ушло в generate, правки и удаления после рана помечены.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import type { Message, ProtocolBackend } from '@kerneldreams/ui-protocol'
import { BackendError, createHttpBackend } from '../src/client.js'
import { serveBackend, type ServeHandle } from '../src/serve.js'
import { createStoreBackend } from '../src/store-backend.js'
import { collect, scriptGen } from './store-harness.js'

let srv: ServeHandle | undefined
let client: ProtocolBackend | undefined

afterEach(async () => {
  await client?.close?.()
  await srv?.close()
  srv = undefined
  client = undefined
})

function fixture(seen: Message[][] = [], prompts: boolean | { system?: string } = { system: 'ты помощник' }): ProtocolBackend {
  return createStoreBackend({
    store: createMemoryStore(),
    generate: scriptGen({
      chunks: [{ type: 'text', delta: 'ответ' }, { type: 'model', model: 'fx-1' }, { type: 'usage', input: 7, output: 1 }],
      onRequest: (req) => seen.push(req.messages),
    }),
    name: 'fixture',
    prompts,
  })
}

async function lastAssistant(backend: ProtocolBackend, sid: string): Promise<Message> {
  const { messages } = await backend.history(sid)
  return messages.filter((m) => m.role === 'assistant').at(-1)!
}

describe('store-backend: messages.prompt', () => {
  it('без опции — ни capability, ни метода', async () => {
    const backend = createStoreBackend({ store: createMemoryStore(), generate: scriptGen({ chunks: [] }) })
    expect((await backend.capabilities()).prompts).toBeUndefined()
    expect(backend.messages?.prompt).toBeUndefined()
  })

  it('рецепт рана: system с pre, post — инъекция, сообщения — вход генерации', async () => {
    const seen: Message[][] = []
    const backend = fixture(seen)
    expect((await backend.capabilities()).prompts).toBe(true)

    const s = await backend.sessions.create()
    await collect(backend.run(s.id, { userMessage: 'раз' }))
    await backend.meta!.patch(s.id, { prompt: { pre: 'ты кот', post: 'мяукай' } })
    await collect(backend.run(s.id, { userMessage: 'два' }))

    const answer = await lastAssistant(backend, s.id)
    const view = await backend.messages!.prompt!(s.id, answer.id)

    expect(view.system).toBe('ты кот\n\nты помощник')
    expect(view.injections).toEqual([{ role: 'user', text: 'мяукай', source: 'meta.post' }])
    expect(view.recipe.messageIds).toEqual(seen[1].map((m) => m.id))
    expect(view.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'раз'],
      ['assistant', 'ответ'],
      ['user', 'два'],
    ])
    expect(view.recipe.model).toBe('fx-1')
    expect(view.recipe.tokens).toEqual({ input: 7, output: 1 })
    expect(view.recipe.systemHash).toMatch(/^[0-9a-f]{16}$/)
    expect(view.recipe.injections[0].hash).toMatch(/^[0-9a-f]{16}$/)
    expect(view.messages.some((m) => m.edited || m.missing)).toBe(false)
  })

  it('replace: system — только pre', async () => {
    const backend = fixture()
    const s = await backend.sessions.create()
    await backend.meta!.patch(s.id, { prompt: { pre: 'ты кот', mode: 'replace' } })
    await collect(backend.run(s.id, { userMessage: 'мяу' }))
    const view = await backend.messages!.prompt!(s.id, (await lastAssistant(backend, s.id)).id)
    expect(view.system).toBe('ты кот')
    expect(view.injections).toEqual([])
  })

  it('правка и удаление после рана — edited и missing', async () => {
    const backend = fixture()
    const s = await backend.sessions.create()
    await collect(backend.run(s.id, { userMessage: 'раз' }))
    await collect(backend.run(s.id, { userMessage: 'два' }))
    const [first, firstAnswer] = (await backend.history(s.id)).messages
    const answer = await lastAssistant(backend, s.id)

    await backend.messages!.edit!(s.id, first.id, { text: 'раз, исправлено' })
    await backend.messages!.delete!(s.id, firstAnswer.id)

    const view = await backend.messages!.prompt!(s.id, answer.id)
    expect(view.messages[0]).toEqual({ id: first.id, role: 'user', text: 'раз, исправлено', edited: true })
    expect(view.messages[1]).toEqual({ id: firstAnswer.id, role: '', text: '', missing: true })
    expect(view.messages[2].edited).toBeUndefined()
  })

  it('через провод: GET /sessions/:id/messages/:mid/prompt; нет рецепта — not_found', async () => {
    srv = await serveBackend(fixture())
    client = createHttpBackend(srv.url)
    expect((await client.capabilities()).prompts).toBe(true)

    const s = await client.sessions.create()
    await collect(client.run(s.id, { userMessage: 'привет' }))
    const [user, answer] = (await client.history(s.id)).messages

    const view = await client.messages!.prompt!(s.id, answer.id)
    expect(view.system).toBe('ты помощник')
    expect(view.messages).toEqual([{ id: user.id, role: 'user', text: 'привет' }])

    const err = await client.messages!.prompt!(s.id, user.id).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BackendError)
    expect((err as BackendError).code).toBe('not_found')
  })

  it('бэкенд без prompts — not_supported через провод', async () => {
    srv = await serveBackend(createStoreBackend({ store: createMemoryStore(), generate: scriptGen({ chunks: [] }) }))
    client = createHttpBackend(srv.url)
    const s = await client.sessions.create()
    const err = await client.messages!.prompt!(s.id, 'x').catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('not_supported')
  })
})
