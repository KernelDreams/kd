/**
 * Рабочий каталог сессии (протокол v1.20): `SessionCreateOpts.cwd` →
 * мета `workspace.cwd` → `GenerateRequest.cwd`; смена — патчем меты.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import { NotSupportedError, type AnyRunEvent, type ProtocolBackend } from '@kerneldreams/ui-protocol'
import { createStoreBackend, type GenerateFn, type GenerateRequest } from '../src/store-backend.js'
import { serveBackend, type ServeHandle } from '../src/serve.js'
import { createHttpBackend } from '../src/client.js'

let srv: ServeHandle | undefined
let client: ProtocolBackend | undefined
afterEach(async () => {
  await client?.close?.()
  await srv?.close()
  srv = undefined
  client = undefined
})

function recorder(): { gen: GenerateFn; seen: GenerateRequest[] } {
  const seen: GenerateRequest[] = []
  return {
    seen,
    gen: async function* (req) {
      seen.push(req)
      yield { type: 'text', text: 'ok' }
    },
  }
}

async function drain(it: AsyncIterable<AnyRunEvent>): Promise<AnyRunEvent[]> {
  const out: AnyRunEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

describe('cwd сессии', () => {
  it('без опции: capability нет, create с cwd — not_supported до создания', async () => {
    const store = createMemoryStore()
    const backend = createStoreBackend({ store, generate: recorder().gen })
    expect((await backend.capabilities()).workspace?.perSession).toBeUndefined()
    await expect(backend.sessions.create({ cwd: '/tmp/a' })).rejects.toBeInstanceOf(NotSupportedError)
    expect(await backend.sessions.list()).toEqual([])
  })

  it('create({cwd}) → мета → GenerateRequest.cwd; патч меты меняет каталог следующего рана', async () => {
    const r = recorder()
    const backend = createStoreBackend({ store: createMemoryStore(), generate: r.gen, sessionCwd: true })
    expect((await backend.capabilities()).workspace?.perSession).toBe(true)
    const s = await backend.sessions.create({ cwd: '/tmp/a' })
    expect(await backend.meta!.get(s.id)).toEqual({ workspace: { cwd: '/tmp/a' } })
    await drain(backend.run(s.id, { userMessage: 'раз' }))
    expect(r.seen[0]!.cwd).toBe('/tmp/a')
    await backend.meta!.patch(s.id, { workspace: { cwd: '/tmp/b' } })
    await drain(backend.run(s.id, { userMessage: 'два' }))
    expect(r.seen[1]!.cwd).toBe('/tmp/b')
    await backend.meta!.patch(s.id, { workspace: null })
    await drain(backend.run(s.id, { userMessage: 'три' }))
    expect(r.seen[2]!.cwd).toBeUndefined()
  })

  it('относительный путь и отказ проверки хоста — bad_request, сессии нет', async () => {
    const backend = createStoreBackend({
      store: createMemoryStore(),
      generate: recorder().gen,
      sessionCwd: (cwd) => {
        if (cwd.includes('nope')) throw new Error('каталога нет')
      },
    })
    await expect(backend.sessions.create({ cwd: 'rel/dir' })).rejects.toThrow(/абсолютный/)
    await expect(backend.sessions.create({ cwd: '/nope' })).rejects.toThrow(/каталога нет/)
    expect(await backend.sessions.list()).toEqual([])
    const s = await backend.sessions.create()
    await expect(backend.meta!.patch(s.id, { workspace: { cwd: 'x' } })).rejects.toThrow(/абсолютный/)
  })

  it('через провод: cwd доезжает, ошибка пути — 400', async () => {
    const r = recorder()
    srv = await serveBackend(createStoreBackend({ store: createMemoryStore(), generate: r.gen, sessionCwd: true }))
    client = createHttpBackend(srv.url)
    const s = await client.sessions.create({ cwd: '/tmp/w' })
    await drain(client.run(s.id, { userMessage: 'hi' }))
    expect(r.seen[0]!.cwd).toBe('/tmp/w')
    await expect(client.sessions.create({ cwd: 'w' })).rejects.toMatchObject({ status: 400 })
  })
})
