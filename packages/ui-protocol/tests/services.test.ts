import { describe, it, expect } from 'vitest'
import {
  SERVICE_ERROR_EVENT,
  canService,
  isServiceEvent,
  parseServiceFrame,
  serializeServiceEnd,
  serializeServiceEvent,
  serviceErrorEvent,
} from '../src/index.js'
import type { Capabilities, ProtocolBackend, ServiceEvent, ServicesHost } from '../src/index.js'
import type { ServiceFn, ServiceMeta } from '../src/service.js'

const caps: Capabilities = {
  protocol: 1,
  services: { 'hello-service': { methods: ['echo'], streams: ['tick'] } },
}

describe('canService (plugin-services-spec §5)', () => {
  it('метод и стрим — по виду; без вида — любой', () => {
    expect(canService(caps, 'hello-service', 'echo')).toBe(true)
    expect(canService(caps, 'hello-service', 'tick')).toBe(true)
    expect(canService(caps, 'hello-service', 'echo', 'call')).toBe(true)
    expect(canService(caps, 'hello-service', 'echo', 'stream')).toBe(false)
    expect(canService(caps, 'hello-service', 'tick', 'stream')).toBe(true)
    expect(canService(caps, 'hello-service', 'tick', 'call')).toBe(false)
  })

  it('нет capability, нет плагина, нет метода — false', () => {
    expect(canService({ protocol: 1 }, 'hello-service', 'echo')).toBe(false)
    expect(canService({ protocol: 1, services: {} }, 'hello-service', 'echo')).toBe(false)
    expect(canService(caps, 'other', 'echo')).toBe(false)
    expect(canService(caps, 'hello-service', 'nope')).toBe(false)
    expect(canService(null, 'hello-service', 'echo')).toBe(false)
    expect(canService(undefined, 'hello-service', 'echo')).toBe(false)
  })

  it('ключи прототипа — не плагины', () => {
    expect(canService({ protocol: 1, services: {} }, 'constructor', 'call')).toBe(false)
    expect(canService({ protocol: 1, services: {} }, '__proto__', 'x')).toBe(false)
  })
})

describe('кадры стрима сервиса', () => {
  it('isServiceEvent: name — непустая строка', () => {
    expect(isServiceEvent({ name: 'chunk', payload: 1 })).toBe(true)
    expect(isServiceEvent({ name: 'end' })).toBe(true)
    expect(isServiceEvent({ name: '' })).toBe(false)
    expect(isServiceEvent({ payload: 1 })).toBe(false)
    expect(isServiceEvent(null)).toBe(false)
    expect(isServiceEvent('x')).toBe(false)
  })

  it('serviceErrorEvent: message и строковый code', () => {
    expect(serviceErrorEvent(new Error('boom'))).toEqual({ name: SERVICE_ERROR_EVENT, payload: { message: 'boom' } })
    const coded = Object.assign(new Error('nope'), { code: 'bad_request' })
    expect(serviceErrorEvent(coded)).toEqual({ name: 'error', payload: { message: 'nope', code: 'bad_request' } })
    expect(serviceErrorEvent('str', 'connection_lost')).toEqual({
      name: 'error',
      payload: { message: 'str', code: 'connection_lost' },
    })
  })

  it('SSE: событие и конец туда-обратно', () => {
    const events: ServiceEvent[] = [
      { name: 'chunk', payload: { text: 'при\nвет' } },
      { name: 'bare' },
      { name: 'n', payload: null },
      { name: 'arr', payload: [1, 'два', { три: 3 }] },
    ]
    for (const event of events) {
      const frame = serializeServiceEvent(event)
      expect(frame.endsWith('\n\n')).toBe(true)
      expect(parseServiceFrame(frame.trimEnd())).toEqual({ type: 'event', event })
    }
    expect(parseServiceFrame(serializeServiceEnd().trimEnd())).toEqual({ type: 'end' })
  })

  it('SSE: комментарий, чужой и битый кадр — null', () => {
    expect(parseServiceFrame(': ping')).toBeNull()
    expect(parseServiceFrame('event: run_end\ndata: {"type":"run_end"}')).toBeNull()
    expect(parseServiceFrame('event: service_event\ndata: {not json')).toBeNull()
    expect(parseServiceFrame('event: service_event\ndata: {"payload":1}')).toBeNull()
  })

  it('SSE: CRLF и data в несколько строк', () => {
    const frame = 'event: service_event\r\ndata: {"name":"a",\r\ndata: "payload":2}'
    expect(parseServiceFrame(frame)).toEqual({ type: 'event', event: { name: 'a', payload: 2 } })
  })
})

describe('формы типов', () => {
  it('ProtocolBackend.services и ServicesHost совместимы с ServicesOps', async () => {
    const host: ServicesHost = {
      async call(plugin, method, args) {
        return { plugin, method, args }
      },
      async *stream() {
        yield { name: 'x' }
      },
      async capability() {
        return {}
      },
      async close() {},
    }
    const backend: Pick<ProtocolBackend, 'services'> = { services: host }
    expect(await backend.services!.call('p', 'm', 1)).toEqual({ plugin: 'p', method: 'm', args: 1 })
    const out: ServiceEvent[] = []
    for await (const e of backend.services!.stream('p', 'm')) out.push(e)
    expect(out).toEqual([{ name: 'x' }])
  })

  it('ServiceFn: регистрация через meta', async () => {
    const calls: string[] = []
    const fn: ServiceFn = (_ctx, meta: ServiceMeta) => {
      meta.on('echo', (p) => p)
      meta.stream('tick', (_p, sink) => sink('tick', 1))
      calls.push(meta.pluginId)
    }
    const meta: ServiceMeta = {
      pluginId: 'hello',
      root: '/r',
      dataDir: '/d',
      pluginDir: '/p',
      on: () => calls.push('on'),
      stream: () => calls.push('stream'),
    }
    await fn({}, meta)
    expect(calls).toEqual(['on', 'stream', 'hello'])
  })
})
