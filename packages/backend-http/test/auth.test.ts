/**
 * Ключ доступа и кросс-доменный вход serveBackend: Bearer или
 * `?auth=`, 401 без ключа (и у SSE), preflight без ключа, `Origin: null`,
 * Private Network Access.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import type { AnyRunEvent } from '@kerneldreams/ui-protocol'
import { createStoreBackend } from '../src/store-backend.js'
import { serveBackend, type ServeHandle } from '../src/serve.js'
import { createHttpBackend } from '../src/client.js'

let srv: ServeHandle | undefined
afterEach(async () => {
  await srv?.close()
  srv = undefined
})

const KEY = 'test-key-1'

async function serve(authKey?: string): Promise<ServeHandle> {
  const backend = createStoreBackend({
    store: createMemoryStore(),
    generate: async function* () {
      yield { type: 'text', text: 'ok' }
    },
  })
  return serveBackend(backend, { cors: true, ...(authKey ? { authKey } : {}) })
}

describe('authKey', () => {
  it('без ключа — 401 Envelope unauthorized; с Bearer и ?auth= — 200', async () => {
    srv = await serve(KEY)
    const bare = await fetch(`${srv.url}/capabilities`)
    expect(bare.status).toBe(401)
    expect(bare.headers.get('www-authenticate')).toBe('Bearer')
    expect(bare.headers.get('access-control-allow-origin')).toBe('*')
    expect(await bare.json()).toMatchObject({ ok: false, code: 'unauthorized' })
    expect((await fetch(`${srv.url}/capabilities`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
    expect((await fetch(`${srv.url}/capabilities`, { headers: { authorization: `Bearer ${KEY}` } })).status).toBe(200)
    expect((await fetch(`${srv.url}/capabilities?auth=${KEY}`)).status).toBe(200)
  })

  it('клиент с ключом — ран по SSE; без ключа — отказ до стрима', async () => {
    srv = await serve(KEY)
    const ok = createHttpBackend(srv.url, { headers: { authorization: `Bearer ${KEY}` } })
    const s = await ok.sessions.create()
    const evs: AnyRunEvent[] = []
    for await (const ev of ok.run(s.id, { userMessage: 'hi' })) evs.push(ev)
    expect(evs.at(-1)).toMatchObject({ type: 'run_end', status: 'done' })
    const bad = createHttpBackend(srv.url)
    await expect(bad.sessions.list()).rejects.toMatchObject({ status: 401, code: 'unauthorized' })
    const it = bad.run(s.id, { userMessage: 'hi' })[Symbol.asyncIterator]()
    await expect(it.next()).rejects.toMatchObject({ status: 401 })
    await ok.close?.()
    await bad.close?.()
  })

  it('preflight — без ключа; Origin: null и PNA', async () => {
    srv = await serve(KEY)
    const pre = await fetch(`${srv.url}/sessions`, {
      method: 'OPTIONS',
      headers: { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type', 'access-control-request-private-network': 'true' },
    })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe('*')
    expect(pre.headers.get('access-control-allow-headers')).toContain('authorization')
    expect(pre.headers.get('access-control-allow-private-network')).toBe('true')
    const get = await fetch(`${srv.url}/sessions`, { headers: { origin: 'null', authorization: `Bearer ${KEY}` } })
    expect(get.status).toBe(200)
    expect(get.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('без authKey — как раньше', async () => {
    srv = await serve()
    expect((await fetch(`${srv.url}/capabilities`)).status).toBe(200)
  })
})
