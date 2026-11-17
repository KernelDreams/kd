/**
 * Подсказка хаба (v1.62): адрес tailnet → имя машины; догадка по браузеру
 * заменяется, имя из настройки или оболочки — никогда.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import type { Capabilities } from '@kerneldreams/ui-protocol'
import { createStoreBackend } from '../src/store-backend.js'
import { serveBackend, type ServeHandle } from '../src/serve.js'
import { createDevices, peerAddress, PEER_HEADER } from '../src/devices.js'

const DEVICES = createDevices([
  { name: 'air', os: 'darwin', match: 'air', client: true, addrs: ['198.51.100.14'] },
  { name: 'max', os: 'darwin', match: 'm3max', client: true, addrs: ['198.51.100.82'] },
  { name: 'mini', os: 'darwin', match: 'o-smith' },
])

describe('peerAddress', () => {
  it('прямой адрес сокета; loopback — последний X-Forwarded-For (Caddy); туннель Cloudflare — нет', () => {
    expect(peerAddress('::ffff:198.51.100.14', {})).toBe('198.51.100.14')
    expect(peerAddress('127.0.0.1', { 'x-forwarded-for': '1.2.3.4, 198.51.100.82' })).toBe('198.51.100.82')
    expect(peerAddress('127.0.0.1', { 'x-forwarded-for': '198.51.100.82', 'cf-connecting-ip': '5.6.7.8' })).toBeUndefined()
    expect(peerAddress('127.0.0.1', {})).toBeUndefined() // ssh-проброс
  })
})

describe('createDevices', () => {
  it('догадка → имя по адресу; не догадка не трогается; флаг снимается всегда', () => {
    expect(DEVICES.client({ device: 'mac', guess: true, tz: 'Europe/Warsaw' }, '198.51.100.82')).toEqual({ device: 'max', tz: 'Europe/Warsaw' })
    expect(DEVICES.client({ device: 'mac', guess: true }, '8.8.8.8')).toEqual({ device: 'mac' })
    expect(DEVICES.client({ device: 'air' }, '198.51.100.82')).toEqual({ device: 'air' })
    expect(DEVICES.capability('198.51.100.14')).toMatchObject({ here: 'air' })
    expect(DEVICES.capability().here).toBeUndefined()
    expect(DEVICES.capability().list.map((d) => d.name)).toEqual(['air', 'max', 'mini'])
    expect(DEVICES.capability().list[0]).not.toHaveProperty('addrs')
  })
})

describe('serveBackend devices', () => {
  let srv: ServeHandle | undefined
  afterEach(async () => {
    await srv?.close()
    srv = undefined
  })

  it('capability devices; входящий x-nr-peer стирается; client.guess до бэкенда не доходит', async () => {
    const store = createMemoryStore()
    const backend = createStoreBackend({ store, generate: async function* () { yield { type: 'text', text: 'ok' } } })
    srv = await serveBackend(backend, { devices: DEVICES })
    // С loopback и подделанным заголовком — машины нет.
    const caps = ((await (await fetch(`${srv.url}/capabilities`, { headers: { [PEER_HEADER]: '198.51.100.14' } })).json()) as { result: Capabilities }).result
    expect(caps.devices?.list.map((d) => d.name)).toEqual(['air', 'max', 'mini'])
    expect(caps.devices?.here).toBeUndefined()
    // Через Caddy (loopback + X-Forwarded-For) — машина известна.
    const viaCaddy = ((await (await fetch(`${srv.url}/capabilities`, { headers: { 'x-forwarded-for': '198.51.100.82' } })).json()) as { result: Capabilities }).result
    expect(viaCaddy.devices?.here).toBe('max')

    const s = await backend.sessions.create({})
    const res = await fetch(`${srv.url}/sessions/${s.id}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.82' },
      body: JSON.stringify({ userMessage: 'привет', client: { device: 'mac', guess: true } }),
    })
    await res.text()
    const hist = await backend.history(s.id)
    const user = (Array.isArray(hist) ? hist : hist.messages).find((m) => m.role === 'user')
    expect(user?.meta?.client).toEqual({ device: 'max' })
  })
})
