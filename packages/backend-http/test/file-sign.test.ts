/**
 * Подписанные адреса сырых файлов (v1.72): `files.sign`, `GET /files/external/sign`,
 * `raw?…&exp=&sig=` без куки и ключа стенда, протухание, подмена пути / хоста / эскиза, строгий режим
 * (путь `raw` открыт мимо Cloudflare Access), клиент `external.url()` подписывает сам.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import { signRaw } from '@kerneldreams/chat-client'
import { createStoreBackend } from '../src/store-backend.js'
import { serveBackend, type ServeHandle } from '../src/serve.js'
import { createHttpBackend } from '../src/client.js'
import { createExternalHost } from '../src/external.js'
import { createFileSigner } from '../src/file-sign.js'
import type { UsersGate } from '../src/gate.js'

let srv: ServeHandle | undefined
let home: string
let img: string
afterEach(async () => {
  await srv?.close()
  srv = undefined
})
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'nr-sign-'))
  await mkdir(join(home, 'docs'))
  img = join(home, 'docs', 'img.png')
  await writeFile(img, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))
  await writeFile(join(home, 'docs', 'other.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]))
  await mkdir(join(home, '.ssh'))
  await writeFile(join(home, '.ssh', 'id_ed25519'), 'PRIVATE')
})
afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

const backend = () =>
  createStoreBackend({
    store: createMemoryStore(),
    generate: async function* () {
      yield { type: 'text', text: 'ok' }
    },
  })
const external = () => createExternalHost({ home })
const rawUrl = (base: string, q: Record<string, string | number>) =>
  `${base}/files/external/raw?${new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)])).toString()}`

describe('createFileSigner', () => {
  it('подпись сходится с клиентской, подмена path / host / thumb / exp — bad, срок — expired', () => {
    let t = Date.parse('2026-11-13T07:00:00Z')
    const s = createFileSigner({ secret: 'test-secret-1', ttlSec: 3600, now: () => t })
    const k = s.issue()
    expect(k.exp).toBeGreaterThan(t / 1000)
    const sig = signRaw(k.key, { path: '/a/b.png', host: 'mini', thumb: 256 })
    const base = { path: '/a/b.png', host: 'mini', thumb: '256', exp: String(k.exp), sig }
    expect(s.check(base)).toBe('ok')
    expect(s.check({ ...base, path: '/a/c.png' })).toBe('bad')
    expect(s.check({ ...base, host: null })).toBe('bad')
    expect(s.check({ ...base, thumb: null })).toBe('bad')
    expect(s.check({ ...base, exp: String(k.exp + 3600) })).toBe('bad')
    expect(s.check({ ...base, sig: null })).toBe('bad')
    expect(s.check({ ...base, sig: 'AAAA' })).toBe('bad')
    // другой секрет — другой стенд
    expect(createFileSigner({ secret: 'test-secret-2', now: () => t }).check(base)).toBe('bad')
    t = k.exp * 1000 + 1
    expect(s.check(base)).toBe('expired')
  })
  it('пустой секрет — громкая ошибка', () => {
    expect(() => createFileSigner({ secret: '' })).toThrow(/секрет/)
  })
})

describe('raw по подписи (v1.72)', () => {
  it('capability files.sign; ключ; клиент подписывает url(); подписанный адрес без ключа стенда — 200', async () => {
    srv = await serveBackend(backend(), { external: external(), fileSign: createFileSigner({ secret: 'test-secret-1' }), authKey: 'test-key-1', basePath: '/api' })
    const client = createHttpBackend(srv.url, { auth: 'test-key-1' })
    const caps = await client.capabilities()
    expect(caps.files?.sign).toBe(true)
    await client.external!.ready!()
    const url = new URL(client.external!.url!(img, { thumb: 0 }))
    expect(url.searchParams.get('sig')).toBeTruthy()
    expect(url.searchParams.get('exp')).toMatch(/^\d+$/)
    // без ключа стенда (как кадр srcdoc без куки)
    url.searchParams.delete('auth')
    const r = await fetch(url)
    expect(r.status).toBe(200)
    expect(Buffer.from(await r.arrayBuffer())[0]).toBe(0x89)
    // тот же адрес, другой файл — 403
    url.searchParams.set('path', join(home, 'docs', 'other.png'))
    const bad = await fetch(url)
    expect(bad.status).toBe(403)
    expect(((await bad.json()) as { code: string }).code).toBe('forbidden')
    // без подписи и без ключа — как раньше 401
    expect((await fetch(rawUrl(srv.url, { path: img }))).status).toBe(401)
    // ключ подписи — только с авторизацией
    expect((await fetch(`${srv.url}/files/external/sign`)).status).toBe(401)
  })

  it('подпись не открывает закрытое: deny хоста действует и по подписанному адресу', async () => {
    const signer = createFileSigner({ secret: 'test-secret-1' })
    srv = await serveBackend(backend(), { external: external(), fileSign: signer, basePath: '/api' })
    const k = signer.issue()
    const p = join(home, '.ssh', 'id_ed25519')
    const r = await fetch(rawUrl(srv.url, { path: p, exp: k.exp, sig: signRaw(k.key, { path: p }) }))
    expect(r.status).toBe(403)
    expect(await r.text()).not.toContain('PRIVATE')
  })

  it('протухший адрес — 401 «истекла»', async () => {
    let t = Date.now()
    const signer = createFileSigner({ secret: 'test-secret-1', ttlSec: 60, now: () => t })
    srv = await serveBackend(backend(), { external: external(), fileSign: signer, basePath: '/api' })
    const k = signer.issue()
    const u = rawUrl(srv.url, { path: img, exp: k.exp, sig: signRaw(k.key, { path: img }) })
    expect((await fetch(u)).status).toBe(200)
    t = k.exp * 1000 + 1000
    const r = await fetch(u)
    expect(r.status).toBe(401)
    expect(((await r.json()) as { error: string }).error).toMatch(/истекла/)
  })

  it('с гейтом пользователей: подписанный адрес без куки — 200, ключ — только owner', async () => {
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
    srv = await serveBackend(b, { external: external(), fileSign: createFileSigner({ secret: 'test-secret-1' }), users, basePath: '/api' })
    expect((await fetch(`${srv.url}/files/external/sign`, { headers: { 'x-user': 'guest' } })).status).toBe(403)
    const kr = await fetch(`${srv.url}/files/external/sign`, { headers: { 'x-user': 'alice' } })
    expect(kr.status).toBe(200)
    const k = ((await kr.json()) as { result: { key: string; exp: number } }).result
    expect((await fetch(rawUrl(srv.url, { path: img, exp: k.exp, sig: signRaw(k.key, { path: img }) }))).status).toBe(200)
    // без подписи и без входа — гейт: 401
    expect((await fetch(rawUrl(srv.url, { path: img }))).status).toBe(401)
  })

  it('строгий режим без гейта: неподписанный raw снаружи (заголовки туннеля) — 401, с подтверждённым Access JWT — 200', async () => {
    const access = { verify: async (jwt: string) => (jwt === 'good-jwt' ? { email: 'owner@example.com' } : null) }
    srv = await serveBackend(backend(), { external: external(), fileSign: createFileSigner({ secret: 'test-secret-1', strict: true, access }), basePath: '/api' })
    const u = rawUrl(srv.url, { path: img })
    // локальный процесс — как раньше
    expect((await fetch(u)).status).toBe(200)
    // через туннель без Access — отказ
    expect((await fetch(u, { headers: { 'cf-connecting-ip': '1.2.3.4' } })).status).toBe(401)
    // поддельный JWT — отказ, настоящий — пропуск
    expect((await fetch(u, { headers: { 'cf-connecting-ip': '1.2.3.4', 'cf-access-jwt-assertion': 'forged' } })).status).toBe(401)
    expect((await fetch(u, { headers: { 'cf-connecting-ip': '1.2.3.4', 'cf-access-jwt-assertion': 'good-jwt' } })).status).toBe(200)
    expect((await fetch(u, { headers: { 'x-forwarded-for': '1.2.3.4', cookie: 'a=1; CF_Authorization=good-jwt' } })).status).toBe(200)
  })

  it('без fileSign — поведение прежнее: capability без sign, sig в адресе игнорируется', async () => {
    srv = await serveBackend(backend(), { external: external(), basePath: '/api' })
    const client = createHttpBackend(srv.url)
    expect((await client.capabilities()).files?.sign).toBeUndefined()
    await client.external!.ready!()
    expect(client.external!.url!(img)).not.toContain('sig=')
    expect((await fetch(rawUrl(srv.url, { path: img, exp: 1, sig: 'x' }))).status).toBe(200)
  })
})
