/**
 * Сервисы плагинов через Tauri-провод (plugin-services-spec §7 п.2):
 * бэкенд с сервисом в памяти → createProtocolHost → createMemoryBridge → createTauriBackend.
 * Та же проверка, что у in-process и HTTP в backend-http.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { NotSupportedError } from '@kerneldreams/ui-protocol'
import type { Capabilities, ProtocolBackend, ServiceEvent, ServicesHost } from '@kerneldreams/ui-protocol'
import { createMemoryServices } from '../../src/services/index.js'
import { createMemoryBridge, createTauriBackend, type MemoryBridge } from '../../src/tauri/index.js'

interface Probe {
  aborted: string[]
}

function servicesLayer(probe: Probe): ServicesHost {
  return createMemoryServices({
    'hello-service': (_ctx, meta) => {
      meta.on('echo', (params) => params)
      meta.on('boom', () => {
        throw Object.assign(new Error('сломалось'), { code: 'conflict' })
      })
      meta.stream('tick', async (_p, sink) => {
        for (let i = 1; i <= 3; i++) sink('tick', { i })
      })
      meta.stream('forever', async (_p, sink, signal) => {
        sink('started')
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        probe.aborted.push('forever')
      })
      meta.stream('silent', async (_p, _sink, signal) => {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        probe.aborted.push('silent')
      })
      meta.stream('fails', async (_p, sink) => {
        sink('one', 1)
        throw new Error('упал посреди')
      })
    },
  })
}

/** Минимальный бэкенд: ядро не нужно, только capabilities + services. */
function backendWith(services?: ServicesHost): ProtocolBackend {
  const nope = async () => {
    throw new Error('not in fixture')
  }
  return {
    async capabilities(): Promise<Capabilities> {
      return services ? { protocol: 1, services: await services.capability() } : { protocol: 1 }
    },
    sessions: { list: async () => [], create: nope, get: nope, delete: nope },
    history: nope,
    run: () => ({ [Symbol.asyncIterator]: () => ({ next: nope }) }),
    cancel: nope,
    ...(services ? { services } : {}),
  }
}

let bridge: MemoryBridge | undefined
let client: ProtocolBackend | undefined

afterEach(async () => {
  await client?.close?.()
  bridge?.host.close()
  bridge = client = undefined
})

function loopback(backend: ProtocolBackend): ProtocolBackend {
  bridge = createMemoryBridge(backend)
  client = createTauriBackend({ invoke: bridge.invoke, listen: bridge.listen })
  return client
}

async function collect(iter: AsyncIterable<ServiceEvent>): Promise<ServiceEvent[]> {
  const out: ServiceEvent[] = []
  for await (const e of iter) out.push(e)
  return out
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: таймаут')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('services: Tauri', () => {
  it('call/stream, ошибки, close посреди', async () => {
    const probe: Probe = { aborted: [] }
    const c = loopback(backendWith(servicesLayer(probe)))
    expect((await c.capabilities()).services).toEqual({
      'hello-service': { methods: ['echo', 'boom'], streams: ['tick', 'forever', 'silent', 'fails'] },
    })
    const s = c.services!
    expect(await s.call('hello-service', 'echo', { a: [1, 'два', null] })).toEqual({ a: [1, 'два', null] })
    expect(await s.call('hello-service', 'echo')).toBeUndefined()
    await expect(s.call('hello-service', 'boom')).rejects.toMatchObject({ message: 'сломалось', code: 'conflict' })
    await expect(s.call('hello-service', 'nope')).rejects.toBeInstanceOf(NotSupportedError)
    await expect(s.call('no-service', 'echo')).rejects.toBeInstanceOf(NotSupportedError)

    expect(await collect(s.stream('hello-service', 'tick'))).toEqual([
      { name: 'tick', payload: { i: 1 } },
      { name: 'tick', payload: { i: 2 } },
      { name: 'tick', payload: { i: 3 } },
    ])
    await expect(collect(s.stream('hello-service', 'echo'))).rejects.toBeInstanceOf(NotSupportedError)
    expect(await collect(s.stream('hello-service', 'fails'))).toEqual([
      { name: 'one', payload: 1 },
      { name: 'error', payload: { message: 'упал посреди' } },
    ])

    for await (const e of s.stream('hello-service', 'forever')) {
      expect(e).toEqual({ name: 'started' })
      break
    }
    await waitFor(() => probe.aborted.includes('forever'))

    const it = s.stream('hello-service', 'silent')[Symbol.asyncIterator]()
    const pending = it.next()
    await new Promise((r) => setTimeout(r, 30))
    await it.return!()
    expect(await pending).toEqual({ value: undefined, done: true })
    await waitFor(() => probe.aborted.includes('silent'))
    await waitFor(() => bridge!.host.openStreams === 0)
  })

  it('кадры провода: services.stream шлёт event × 3 и end', async () => {
    const c = loopback(backendWith(servicesLayer({ aborted: [] })))
    await collect(c.services!.stream('hello-service', 'tick'))
    const frames = bridge!.frames.filter((f) => f.type !== 'reset')
    expect(frames.map((f) => f.type)).toEqual(['event', 'event', 'event', 'end'])
  })

  it('reset посреди стрима — кадр error connection_lost', async () => {
    const c = loopback(backendWith(servicesLayer({ aborted: [] })))
    const out: ServiceEvent[] = []
    for await (const e of c.services!.stream('hello-service', 'forever')) {
      out.push(e)
      if (out.length === 1) bridge!.kill()
    }
    expect(out[1]).toMatchObject({ name: 'error', payload: { code: 'connection_lost' } })
  })

  it('бэкенд без services — not_supported на call и stream', async () => {
    const c = loopback(backendWith())
    await expect(c.services!.call('hello-service', 'echo')).rejects.toBeInstanceOf(NotSupportedError)
    await expect(collect(c.services!.stream('hello-service', 'tick'))).rejects.toBeInstanceOf(NotSupportedError)
  })
})
