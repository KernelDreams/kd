/**
 * хаб без своих сервисов проксирует их хозяину контура (`createRemoteServices`).
 * Хозяин лёг — плагины в capability остаются, вызов — `service_unavailable` (503).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryServices } from '@kerneldreams/backend-local/services'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import type { ProtocolBackend, ServiceEvent } from '@kerneldreams/ui-protocol'
import { serveBackend, type ServeHandle } from '../src/serve.js'
import { createHttpBackend } from '../src/client.js'
import { createStoreBackend } from '../src/store-backend.js'
import { createRemoteServices, SERVICE_UNAVAILABLE_CODE, type RemoteServices } from '../src/remote-services.js'
import { noGen } from './store-harness.js'

const open: Array<{ close(): Promise<void> | void }> = []
afterEach(async () => {
  for (const c of open.splice(0).reverse()) await Promise.resolve().then(() => c.close()).catch(() => undefined)
})

async function owner(port = 0): Promise<{ srv: ServeHandle; loads: () => number }> {
  let loads = 0
  const services = createMemoryServices({
    archive: (_ctx, meta) => {
      loads++
      meta.on('status', () => ({ configured: true }))
      meta.on('http', () => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'страница' }))
      meta.stream('tick', async (_p, sink) => {
        for (let i = 1; i <= 2; i++) sink('tick', { i })
      })
    },
  })
  const backend = createStoreBackend({ store: createMemoryStore(), generate: noGen, name: 'nr', services })
  const srv = await serveBackend(backend, { port, servicesOwner: services })
  open.push(srv, { close: () => backend.close?.() })
  return { srv, loads: () => loads }
}

async function hub(url: string): Promise<{ client: ProtocolBackend; remote: RemoteServices; srv: ServeHandle }> {
  const remote = createRemoteServices({ url, ttlMs: 0 })
  const backend = createStoreBackend({ store: createMemoryStore(), generate: noGen, name: 'acp', services: remote })
  const srv = await serveBackend(backend)
  const client = createHttpBackend(srv.url, { capabilitiesTtl: 0 })
  open.push(srv, { close: () => backend.close?.() }, { close: () => client.close?.() })
  return { client, remote, srv }
}

describe('createRemoteServices', () => {
  it('capability, call, stream и http сервиса — у хозяина, хаб своих не грузит', async () => {
    const o = await owner()
    const h = await hub(o.srv.url)
    expect((await h.client.capabilities()).services?.archive).toEqual({ methods: ['status', 'http'], streams: ['tick'] })
    expect(await h.client.services!.call('archive', 'status')).toEqual({ configured: true })
    const frames: ServiceEvent[] = []
    for await (const e of h.client.services!.stream('archive', 'tick')) frames.push(e)
    expect(frames.map((f) => f.payload)).toEqual([{ i: 1 }, { i: 2 }])
    const page = await fetch(`${h.srv.url}/services/archive/http/index.html`)
    expect(await page.text()).toBe('страница')
    expect(o.loads()).toBe(1)
    expect(h.remote.available()).toBe(true)
  })

  it('хозяин лёг — плагин в capability остаётся, вызов 503 service_unavailable; встал — снова работает', async () => {
    const o = await owner()
    const port = o.srv.port
    const h = await hub(o.srv.url)
    expect((await h.client.capabilities()).services?.archive).toBeDefined()
    await o.srv.close()
    const res = await fetch(`${h.srv.url}/services/archive/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { code?: string; error?: string }
    expect(body.code).toBe(SERVICE_UNAVAILABLE_CODE)
    expect(body.error).toMatch(/сервис недоступен/)
    expect((await h.client.capabilities()).services?.archive).toBeDefined()
    expect(h.remote.available()).toBe(false)
    await owner(port)
    expect(await h.client.services!.call('archive', 'status')).toEqual({ configured: true })
  })

  it('хозяина не было никогда — пустая capability, не падение', async () => {
    const remote = createRemoteServices({ url: 'http://127.0.0.1:9/api', timeoutMs: 500 })
    open.push(remote)
    expect(await remote.capability()).toEqual({})
    expect(remote.available()).toBe(false)
    await expect(remote.call('archive', 'status')).rejects.toMatchObject({ code: SERVICE_UNAVAILABLE_CODE })
  })

  it('GET /services без servicesOwner — не маршрут', async () => {
    const backend = createStoreBackend({ store: createMemoryStore(), generate: noGen })
    const srv = await serveBackend(backend)
    open.push(srv)
    expect((await fetch(`${srv.url}/services`)).status).toBe(404)
  })
})
