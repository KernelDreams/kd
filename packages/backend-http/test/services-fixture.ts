/**
 * Фикстура сервисов плагинов (plugin-services-spec §7 п.1–2): store-backend на
 * памяти + сервис `hello-service` в памяти. Одна и та же проверка гоняется по
 * транспортам: in-process (сам бэкенд) и HTTP (serveBackend ⇄ createHttpBackend).
 */

import { expect } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import { NotSupportedError } from '@kerneldreams/ui-protocol'
import type { ProtocolBackend, ServiceEvent } from '@kerneldreams/ui-protocol'
import { createMemoryServices } from '@kerneldreams/backend-local/services'
import { createStoreBackend } from '../src/store-backend.js'
import { noGen } from './store-harness.js'

/** Что видел сервис: abort'ы стримов — доказательство `stream.close`. */
export interface ServiceProbe {
  aborted: string[]
}

export function servicesBackend(probe: ServiceProbe): ProtocolBackend {
  const services = createMemoryServices({
    'hello-service': (_ctx, meta) => {
      meta.on('echo', (params) => params)
      meta.on('boom', () => {
        throw Object.assign(new Error('сломалось'), { code: 'conflict' })
      })
      meta.stream('tick', async (_params, sink) => {
        for (let i = 1; i <= 3; i++) sink('tick', { i })
      })
      meta.stream('forever', async (_params, sink, signal) => {
        sink('started')
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        probe.aborted.push('forever')
      })
      meta.stream('silent', async (_params, _sink, signal) => {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        probe.aborted.push('silent')
      })
      meta.stream('fails', async (_params, sink) => {
        sink('one', 1)
        throw new Error('упал посреди')
      })
    },
    // Плагин без сервиса в capability не попадает — у него нет записи вовсе.
  })
  return createStoreBackend({ store: createMemoryStore(), generate: noGen, name: 'svc', services })
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

/** Проверка провода сервисов: одинакова для любого транспорта. */
export async function servicesConformance(backend: ProtocolBackend, probe: ServiceProbe): Promise<void> {
  const caps = await backend.capabilities()
  // Транспорт добавляет встроенный поток активности сессий (v1.69) — он не сервис плагина.
  const { 'nr.sessions': _activity, ...plugins } = caps.services ?? {}
  expect(plugins).toEqual({
    'hello-service': { methods: ['echo', 'boom'], streams: ['tick', 'forever', 'silent', 'fails'] },
  })
  const services = backend.services!

  // call: JSON туда и обратно, undefined-аргумент — undefined
  expect(await services.call('hello-service', 'echo', { a: [1, 'два', null], b: { c: true } })).toEqual({
    a: [1, 'два', null],
    b: { c: true },
  })
  expect(await services.call('hello-service', 'echo')).toBeUndefined()

  // ошибки call
  await expect(services.call('hello-service', 'boom')).rejects.toMatchObject({ message: 'сломалось', code: 'conflict' })
  await expect(services.call('hello-service', 'nope')).rejects.toBeInstanceOf(NotSupportedError)
  await expect(services.call('no-service', 'echo')).rejects.toBeInstanceOf(NotSupportedError)

  // stream: 3 кадра и конец
  expect(await collect(services.stream('hello-service', 'tick'))).toEqual([
    { name: 'tick', payload: { i: 1 } },
    { name: 'tick', payload: { i: 2 } },
    { name: 'tick', payload: { i: 3 } },
  ])

  // незаявленный стрим — throw до кадров
  await expect(collect(services.stream('hello-service', 'echo'))).rejects.toBeInstanceOf(NotSupportedError)
  await expect(collect(services.stream('no-service', 'tick'))).rejects.toBeInstanceOf(NotSupportedError)

  // throw посреди — кадр error и конец
  expect(await collect(services.stream('hello-service', 'fails'))).toEqual([
    { name: 'one', payload: 1 },
    { name: 'error', payload: { message: 'упал посреди' } },
  ])

  // close посреди — сервис видит abort
  for await (const e of services.stream('hello-service', 'forever')) {
    expect(e).toEqual({ name: 'started' })
    break
  }
  await waitFor(() => probe.aborted.includes('forever'))

  // молчащий стрим закрывается return() без ожидания кадра
  const it = services.stream('hello-service', 'silent')[Symbol.asyncIterator]()
  const pending = it.next()
  await new Promise((r) => setTimeout(r, 30))
  await it.return!()
  await waitFor(() => probe.aborted.includes('silent'))
  await Promise.race([pending, new Promise((r) => setTimeout(r, 1000))])
}
