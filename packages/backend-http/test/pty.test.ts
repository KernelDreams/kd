/**
 * `serveBackend({pty})`: роуты /pty, capability, Origin, owner, WebSocket-upgrade
 * через ту же базу пути и ключ. Хост — фейк: живой tmux гоняют тесты `nr-pty`.
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import { createStoreBackend } from '../src/store-backend.js'
import { serveBackend, type ServeHandle } from '../src/serve.js'
import type { UsersGate } from '../src/gate.js'
import { ptyOriginAllowed, type PtyOps } from '../src/pty.js'

let srv: ServeHandle | undefined
afterEach(async () => {
  await srv?.close()
  srv = undefined
})

const backend = () =>
  createStoreBackend({
    store: createMemoryStore(),
    generate: async function* () {
      yield { type: 'text', text: 'ok' }
    },
  })

function fakePty() {
  const calls: unknown[] = []
  const upgrades: string[] = []
  const pty: PtyOps = {
    list: async () => [{ id: 't1', state: 'prompt' }],
    ensure: async (id, o) => (calls.push({ ensure: id, ...o }), { id, state: 'prompt' }),
    info: async (id) => (id === 't1' ? { id, state: 'prompt' } : null),
    run: async (input) => (calls.push({ run: input }), { status: 'done', code: 0, output: 'hi', terminal: 't1' }),
    read: async (input) => (calls.push({ read: input }), { terminal: 't1', state: 'prompt', text: '$ ' }),
    kill: async (id) => id === 't1',
    upgrade(_req: IncomingMessage, socket: Duplex, _head: Buffer, id: string) {
      upgrades.push(id)
      socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    },
  }
  return { pty, calls, upgrades }
}

/** Голый upgrade-запрос: статус ответа. */
async function upgrade(url: string, headers: Record<string, string> = {}): Promise<number> {
  const { request } = await import('node:http')
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } })
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve(res.statusCode ?? 0)
    })
    req.on('response', (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

describe('pty (FRR-3)', () => {
  it('capability и роуты: list, ensure, run, read, info, kill', async () => {
    const { pty, calls } = fakePty()
    srv = await serveBackend(backend(), { pty, basePath: '/api' })
    const caps = await (await fetch(`${srv.url}/capabilities`)).json()
    expect(caps.result.pty).toEqual({ run: true })
    expect((await (await fetch(`${srv.url}/pty`)).json()).result).toEqual([{ id: 't1', state: 'prompt' }])
    const made = await (await fetch(`${srv.url}/pty`, { method: 'POST', body: JSON.stringify({ id: 'x1', cwd: '/tmp' }) })).json()
    expect(made.result).toEqual({ id: 'x1', state: 'prompt' })
    const run = await (await fetch(`${srv.url}/pty/run`, { method: 'POST', body: JSON.stringify({ command: 'ls', mode: 'execute', terminal: 't1' }) })).json()
    expect(run.result).toMatchObject({ status: 'done', code: 0 })
    const read = await (await fetch(`${srv.url}/pty/read?terminal=t1&lines=5`)).json()
    expect(read.result.text).toBe('$ ')
    expect(calls).toEqual([{ ensure: 'x1', cwd: '/tmp' }, { run: { command: 'ls', mode: 'execute', terminal: 't1' } }, { read: { terminal: 't1', lines: 5 } }])
    expect((await fetch(`${srv.url}/pty/t1`)).status).toBe(200)
    expect((await fetch(`${srv.url}/pty/nope`)).status).toBe(404)
    expect((await (await fetch(`${srv.url}/pty/t1`, { method: 'DELETE' })).json()).result).toEqual({ killed: true })
    const bad = await fetch(`${srv.url}/pty/run`, { method: 'POST', body: JSON.stringify({ command: 'ls', mode: 'sudo' }) })
    expect(bad.status).toBe(400)
  })

  it('чужой Origin — 403 и на POST, и на WebSocket; свой и маска — можно', async () => {
    const { pty, upgrades } = fakePty()
    srv = await serveBackend(backend(), { pty, basePath: '/api', ptyOrigins: ['https://*.nr'] })
    const post = (origin: string) => fetch(`${srv!.url}/pty/run`, { method: 'POST', headers: { origin, 'content-type': 'text/plain' }, body: JSON.stringify({ command: 'id' }) })
    expect((await post('https://evil.example')).status).toBe(403)
    expect((await post('https://far.nr')).status).toBe(200)
    expect((await post('http://localhost:5376')).status).toBe(200)
    const ws = `${srv.url}/pty/t1/attach`
    expect(await upgrade(ws, { origin: 'https://evil.example' })).toBe(403)
    expect(await upgrade(ws, { origin: 'https://far.nr' })).toBe(101)
    expect(await upgrade(`${srv.url.replace('/api', '')}/pty/t1/attach`)).toBe(404)
    expect(upgrades).toEqual(['t1'])
  })

  it('ключ стенда и гейт: без ключа 401, не owner — 403', async () => {
    const { pty, upgrades } = fakePty()
    const b = backend()
    const user = (id: string) => ({ id, name: id, role: id === 'alice' ? 'owner' : 'member' }) as never
    const users: UsersGate = {
      async authenticate(req) {
        const id = String(req.headers['x-user'] ?? '')
        return id ? { ok: true, identity: { user: user(id), via: 'link' } } : { ok: false, reason: 'кто ты' }
      },
      async redeem() {
        return null
      },
      async logout() {},
      backendFor: () => b,
      clearCookie: () => 'x=',
      isOwner: (i) => i.user.id === 'alice',
    }
    srv = await serveBackend(b, { pty, users })
    expect((await fetch(`${srv.url}/pty`, { headers: { 'x-user': 'anna' } })).status).toBe(403)
    expect((await fetch(`${srv.url}/pty`, { headers: { 'x-user': 'alice' } })).status).toBe(200)
    expect(await upgrade(`${srv.url}/pty/t1/attach`, { 'x-user': 'anna' })).toBe(403)
    expect(await upgrade(`${srv.url}/pty/t1/attach`)).toBe(401)
    expect(await upgrade(`${srv.url}/pty/t1/attach`, { 'x-user': 'alice' })).toBe(101)
    await srv.close()
    srv = await serveBackend(b, { pty, authKey: 'test-key-1' })
    expect(await upgrade(`${srv.url}/pty/t1/attach`)).toBe(401)
    expect(await upgrade(`${srv.url}/pty/t1/attach?auth=test-key-1`)).toBe(101)
    expect(upgrades).toEqual(['t1', 't1'])
  })

  it('ptyOriginAllowed: нет Origin — процесс стенда; null — нельзя; X-Forwarded-Host', () => {
    const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage
    expect(ptyOriginAllowed(req({}))).toBe(true)
    expect(ptyOriginAllowed(req({ origin: 'null' }))).toBe(false)
    expect(ptyOriginAllowed(req({ origin: 'https://far.nr', host: '127.0.0.1:7600', 'x-forwarded-host': 'far.nr' }))).toBe(true)
    expect(ptyOriginAllowed(req({ origin: 'https://far.nr.evil.com', host: '127.0.0.1:7600' }), ['https://*.nr'])).toBe(false)
    expect(ptyOriginAllowed(req({ origin: 'http://far.nr', host: 'x' }), ['https://far.nr'])).toBe(false)
  })
})
