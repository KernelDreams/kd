/**
 * sessionMeta поверх store-backend (session-meta-spec §2, §5).
 *
 * Фикстурный бэкенд для e2e фронта — это `createStoreBackend` над драйвером в
 * памяти. Проверяется, что он ведёт себя как настоящий: правило патча
 * протокола (вложенный `prompt`, `null` удаляет ключ) применяет БЭКЕНД, а не
 * драйвер, поэтому мета в фикстуре и мета в pi означают одно и то же.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import type { ProtocolBackend } from '@kerneldreams/ui-protocol'
import { createStoreBackend } from '../src/store-backend.js'
import { serveBackend, type ServeHandle } from '../src/serve.js'
import { createHttpBackend } from '../src/client.js'
import { noGen, scriptGen } from './store-harness.js'

let srv: ServeHandle | undefined
let client: ProtocolBackend | undefined

afterEach(async () => {
  await client?.close?.()
  await srv?.close()
  srv = undefined
  client = undefined
})

function memoryBackend(generate = noGen): ProtocolBackend {
  return createStoreBackend({ store: createMemoryStore(), generate, name: 'fixture' })
}

describe('фикстурный бэкенд в памяти', () => {
  it('заявляет sessionMeta и несёт meta (правило §2 backends-spec)', async () => {
    const backend = memoryBackend()
    expect((await backend.capabilities()).sessionMeta).toBe(true)
    expect(backend.meta).toBeDefined()
  })

  it('get на новой сессии — {}, без внутреннего состояния драйвера', async () => {
    const backend = memoryBackend()
    const s = await backend.sessions.create()
    expect(await backend.meta!.get(s.id)).toEqual({})
  })

  it('patch мержит по правилу протокола, а не по правилу драйвера', async () => {
    const backend = memoryBackend()
    const s = await backend.sessions.create()

    expect(await backend.meta!.patch(s.id, { prompt: { pre: 'ты кот' } })).toEqual({
      prompt: { pre: 'ты кот' },
    })
    // Вложенный merge: пришедший post не стирает уже лежащий pre.
    expect(await backend.meta!.patch(s.id, { prompt: { post: 'мяукай' }, notes: 'черновик' })).toEqual({
      prompt: { pre: 'ты кот', post: 'мяукай' },
      notes: 'черновик',
    })
    // null удаляет — драйверный Object.assign так не умеет, поэтому merge и
    // запись документа целиком делает бэкенд.
    expect(await backend.meta!.patch(s.id, { notes: null, prompt: { pre: null } })).toEqual({
      prompt: { post: 'мяукай' },
    })
    expect(await backend.meta!.get(s.id)).toEqual({ prompt: { post: 'мяукай' } })
  })

  it('мета переживает ран и уезжает в генерацию', async () => {
    let seen: Record<string, unknown> | undefined
    const backend = createStoreBackend({
      store: createMemoryStore(),
      generate: scriptGen({
        chunks: [{ type: 'text', delta: 'ответ' }],
        onRequest: (req) => {
          seen = req.sessionMeta
        },
      }),
      name: 'fixture',
    })
    const s = await backend.sessions.create()
    await backend.meta!.patch(s.id, { prompt: { pre: 'ты кот' } })

    for await (const _ of backend.run(s.id, { userMessage: 'привет' })) {
      /* drain */
    }

    expect(seen).toEqual({ prompt: { pre: 'ты кот' }, titleSource: 'auto' })
    expect(await backend.meta!.get(s.id)).toEqual({ prompt: { pre: 'ты кот' }, titleSource: 'auto' })
  })

  it('чанк node_meta (ABC-446): мета реплики игрока пишется на месте, текст не трогается', async () => {
    const store = createMemoryStore()
    const backend = createStoreBackend({
      store,
      generate: async function* (req) {
        const last = req.messages.at(-1)!
        yield { type: 'node_meta', id: last.id, patch: { lore: [{ book: 'bot:b', entry: '7' }] } }
        yield { type: 'text', delta: 'ок' }
      },
      name: 'fixture',
    })
    const s = await backend.sessions.create()
    for await (const _ of backend.run(s.id, { userMessage: 'Кто такой Rico?' })) {
      /* drain */
    }
    const model = await store.load(s.id)
    const user = [...model.nodes.values()].find((n) => n.role === 'user')!
    expect(user.meta?.lore).toEqual([{ book: 'bot:b', entry: '7' }])
    expect(user.parts).toEqual([{ type: 'text', text: 'Кто такой Rico?' }])
  })

  it('чанк meta генерации (v1.32): патч меты из рана — context.cleared рядом с pinned фронта; событие session_update', async () => {
    const backend = createStoreBackend({
      store: createMemoryStore(),
      generate: scriptGen({ chunks: [{ type: 'meta', patch: { context: { pinned: ['c1'], cleared: ['c0'] } } }, { type: 'text', delta: 'ок' }] }),
      name: 'fixture',
    })
    const s = await backend.sessions.create()
    await backend.meta!.patch(s.id, { context: { pinned: ['c1'] }, notes: 'n' })
    const events = []
    for await (const ev of backend.run(s.id, { userMessage: 'привет' })) events.push(ev)
    expect(events.find((e) => e.type === 'session_update')).toMatchObject({ fields: ['context'] })
    expect(events.at(-1)).toMatchObject({ type: 'run_end', status: 'done' })
    expect(await backend.meta!.get(s.id)).toEqual({ notes: 'n', context: { pinned: ['c1'], cleared: ['c0'] }, titleSource: 'auto' })
  })

  it('мета переживает провод: те же значения через HTTP', async () => {
    srv = await serveBackend(memoryBackend())
    client = createHttpBackend(srv.url)

    const s = await client.sessions.create()
    expect((await client.capabilities()).sessionMeta).toBe(true)
    expect(await client.meta!.get(s.id)).toEqual({})

    expect(await client.meta!.patch(s.id, { prompt: { pre: 'ты кот' } })).toEqual({
      prompt: { pre: 'ты кот' },
    })
    expect(await client.meta!.patch(s.id, { prompt: { pre: null } })).toEqual({})
    expect(await client.meta!.get(s.id)).toEqual({})
  })

  it('не-объект в PATCH meta — bad_request, а не тихая порча документа', async () => {
    srv = await serveBackend(memoryBackend())
    const s = await createHttpBackend(srv.url).sessions.create()

    const res = await fetch(new URL(`/sessions/${s.id}`, srv.url), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meta: 'строка' }),
    })
    const body = (await res.json()) as { ok: boolean; code?: string }
    expect(res.status).toBe(400)
    expect(body.ok).toBe(false)
    expect(body.code).toBe('bad_request')
  })
})
