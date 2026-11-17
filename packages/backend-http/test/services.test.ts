/**
 * Сервисы плагинов на транспортах in-process и HTTP (plugin-services-spec §7 п.2).
 * Tauri — в backend-tauri (та же проверка).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { NotSupportedError } from '@kerneldreams/ui-protocol'
import type { ProtocolBackend, ServiceHttpRequest } from '@kerneldreams/ui-protocol'
import { createMemoryServices } from '@kerneldreams/backend-local/services'
import { serveBackend, type ServeHandle } from '../src/serve.js'
import { createHttpBackend } from '../src/client.js'
import { createStoreBackend } from '../src/store-backend.js'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import { servicesBackend, servicesConformance, type ServiceProbe } from './services-fixture.js'
import { noGen } from './store-harness.js'

let srv: ServeHandle | undefined
let client: ProtocolBackend | undefined
let backend: ProtocolBackend | undefined

afterEach(async () => {
  await client?.close?.()
  await srv?.close()
  await backend?.close?.()
  srv = client = backend = undefined
})

describe('services: in-process', () => {
  it('call/stream, ошибки, close посреди', async () => {
    const probe: ServiceProbe = { aborted: [] }
    backend = servicesBackend(probe)
    await servicesConformance(backend, probe)
  })

  it('close() бэкенда закрывает сервисы', async () => {
    const probe: ServiceProbe = { aborted: [] }
    backend = servicesBackend(probe)
    const it = backend.services!.stream('hello-service', 'silent')[Symbol.asyncIterator]()
    const pending = it.next()
    await new Promise((r) => setTimeout(r, 20))
    await backend.close!()
    expect(await pending).toEqual({ value: undefined, done: true })
    await expect(backend.services!.call('hello-service', 'echo', 1)).rejects.toBeInstanceOf(NotSupportedError)
  })

  it('без services — ни capability, ни ops', async () => {
    backend = createStoreBackend({ store: createMemoryStore(), generate: noGen })
    expect((await backend.capabilities()).services).toBeUndefined()
    expect(backend.services).toBeUndefined()
  })
})

describe('services: HTTP', () => {
  it('call/stream, ошибки, close посреди — через провод', async () => {
    const probe: ServiceProbe = { aborted: [] }
    backend = servicesBackend(probe)
    srv = await serveBackend(backend)
    client = createHttpBackend(srv.url)
    await servicesConformance(client, probe)
  })

  it('бэкенд без services: call и stream — not_supported', async () => {
    backend = createStoreBackend({ store: createMemoryStore(), generate: noGen })
    srv = await serveBackend(backend)
    client = createHttpBackend(srv.url)
    await expect(client.services!.call('hello-service', 'echo')).rejects.toBeInstanceOf(NotSupportedError)
    const iter = client.services!.stream('hello-service', 'tick')[Symbol.asyncIterator]()
    await expect(iter.next()).rejects.toBeInstanceOf(NotSupportedError)
  })

  it('провод: SSE-кадры service_event … service_end, GET — 405', async () => {
    const probe: ServiceProbe = { aborted: [] }
    backend = servicesBackend(probe)
    srv = await serveBackend(backend)
    const res = await fetch(`${srv.url}/services/hello-service/tick/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    expect(text.match(/event: service_event/g)).toHaveLength(3)
    expect(text.trimEnd().endsWith('event: service_end\ndata: {}')).toBe(true)

    const call = await fetch(`${srv.url}/services/hello-service/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: { x: 1 } }),
    })
    expect(await call.json()).toEqual({ ok: true, result: { x: 1 } })

    const get = await fetch(`${srv.url}/services/hello-service/echo`)
    expect(get.status).toBe(405)
  })

  it('соединение порвалось без service_end — кадр error connection_lost', async () => {
    const probe: ServiceProbe = { aborted: [] }
    backend = servicesBackend(probe)
    srv = await serveBackend(backend)
    client = createHttpBackend(srv.url)
    const out: unknown[] = []
    for await (const e of client.services!.stream('hello-service', 'forever')) {
      out.push(e)
      if (out.length === 1) void srv.close()
    }
    expect(out[0]).toEqual({ name: 'started' })
    expect(out[1]).toMatchObject({ name: 'error', payload: { code: 'connection_lost' } })
    srv = undefined
  })
})

describe('services: HTTP сервиса (v1.14)', () => {
  function staticBackend(): ProtocolBackend {
    const services = createMemoryServices({
      site: (_ctx, meta) => {
        meta.on('http', (params) => {
          const r = params as ServiceHttpRequest
          if (r.path === '/a/k/') return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'x-seen': `${r.method} ${r.query}` }, body: '<p>страница</p>' }
          if (r.path === '/img.png') return { status: 200, headers: { 'content-type': 'image/png', 'content-length': '999' }, body: { __b64: Buffer.from([137, 80, 78, 71]).toString('base64') } }
          if (r.path === '/f/k') return { status: 403, headers: { 'content-type': 'text/plain' }, body: `нет доступа ${r.query}` }
          return { status: 404, body: `not found: ${r.path}` }
        })
      },
    })
    return createStoreBackend({ store: createMemoryStore(), generate: noGen, name: 'svc', services })
  }

  it('GET/HEAD /services/<id>/http/<путь> → метод http сервиса, ответ как есть; url() клиента ведёт туда же', async () => {
    backend = staticBackend()
    srv = await serveBackend(backend, { basePath: '/api', cors: true })
    expect(srv.url.endsWith('/api')).toBe(true)
    client = createHttpBackend(srv.url)
    const url = client.services!.url!('site', '/a/k/')
    expect(url).toBe(`${srv.url}/services/site/http/a/k/`)

    const page = await fetch(`${url}?x=1`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(page.headers.get('x-seen')).toBe('GET ?x=1')
    expect(page.headers.get('access-control-allow-origin')).toBe('*')
    expect(await page.text()).toBe('<p>страница</p>')

    const img = await fetch(client.services!.url!('site', '/img.png'))
    expect(img.headers.get('content-length')).toBe('4')
    expect([...new Uint8Array(await img.arrayBuffer())]).toEqual([137, 80, 78, 71])

    const denied = await fetch(`${client.services!.url!('site', '/f/k')}?p=%2Fetc%2Fpasswd`)
    expect(denied.status).toBe(403)
    expect(await denied.text()).toBe('нет доступа ?p=%2Fetc%2Fpasswd')

    const head = await fetch(url, { method: 'HEAD' })
    expect(head.status).toBe(200)
    // Пробел по краям значения заголовка — не часть значения (RFC 9110 §5.5): Web Headers ядра провода его срезает
    expect(head.headers.get('x-seen')).toBe('HEAD')
  })

  it('сервис без http — not_supported; бэкенд без services — тоже', async () => {
    const probe: ServiceProbe = { aborted: [] }
    backend = servicesBackend(probe)
    srv = await serveBackend(backend)
    const r = await fetch(`${srv.url}/services/hello-service/http/x`)
    expect(r.status).toBe(501)
    expect((await r.json()).code).toBe('not_supported')
  })
})

describe('services: мультиплекс подписок (v1.68)', () => {
  it('подписки — одно соединение _mux, кадры по ключам, конец своей подписки, отписка абортит сервис', async () => {
    const probe: ServiceProbe = { aborted: [] }
    backend = servicesBackend(probe)
    srv = await serveBackend(backend)
    const paths: string[] = []
    client = createHttpBackend(srv.url, {
      fetch: (url: RequestInfo | URL, init?: RequestInit) => {
        paths.push(new URL(String(url)).pathname)
        return fetch(url, init)
      },
    } as never)
    const tick = client.services!.subscribe!('hello-service', 'tick')[Symbol.asyncIterator]()
    const forever = client.services!.subscribe!('hello-service', 'forever')[Symbol.asyncIterator]()
    const ticks: unknown[] = []
    for (;;) {
      const n = await tick.next()
      if (n.done) break
      ticks.push(n.value)
    }
    expect(ticks).toEqual([1, 2, 3].map((i) => ({ name: 'tick', payload: { i } })))
    expect((await forever.next()).value).toEqual({ name: 'started' })
    expect(paths.filter((p) => p.endsWith('/stream'))).toEqual(['/services/_mux/stream'])
    await forever.return!()
    await new Promise((r) => setTimeout(r, 100))
    expect(probe.aborted).toContain('forever')
  })

  it('незаявленный метод — error + конец только этой подписки', async () => {
    const probe: ServiceProbe = { aborted: [] }
    backend = servicesBackend(probe)
    srv = await serveBackend(backend)
    client = createHttpBackend(srv.url)
    const bad = client.services!.subscribe!('hello-service', 'nope')[Symbol.asyncIterator]()
    const good = client.services!.subscribe!('hello-service', 'forever')[Symbol.asyncIterator]()
    const first = await bad.next()
    expect(first.value).toMatchObject({ name: 'error', payload: { code: 'not_supported' } })
    expect((await bad.next()).done).toBe(true)
    expect((await good.next()).value).toEqual({ name: 'started' })
    await good.return!()
  })

  it('старый сервер без _mux (not_supported) — подписка стримом на себя', async () => {
    const probe: ServiceProbe = { aborted: [] }
    backend = servicesBackend(probe)
    srv = await serveBackend(backend)
    const paths: string[] = []
    client = createHttpBackend(srv.url, {
      fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(url)).pathname
        paths.push(path)
        if (path.endsWith('/_mux/stream')) return new Response(JSON.stringify({ ok: false, code: 'not_supported', error: 'нет' }), { status: 501, headers: { 'content-type': 'application/json' } })
        return fetch(url, init)
      },
    } as never)
    const it1 = client.services!.subscribe!('hello-service', 'forever')[Symbol.asyncIterator]()
    expect((await it1.next()).value).toEqual({ name: 'started' })
    await it1.return!()
    const it2 = client.services!.subscribe!('hello-service', 'forever')[Symbol.asyncIterator]()
    expect((await it2.next()).value).toEqual({ name: 'started' })
    await it2.return!()
    expect(paths.filter((p) => p.endsWith('/stream'))).toEqual(['/services/_mux/stream', '/services/hello-service/forever/stream', '/services/hello-service/forever/stream'])
  })
})
