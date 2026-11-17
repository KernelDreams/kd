/**
 * Скины (v1.21, skin-spec §5): `serveBackend({skins})` — роуты /skins*,
 * capability skins поверх бэкенда; клиент — тот же createHttpBackend.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import type { SkinSelection, SkinsOps } from '@kerneldreams/ui-protocol'
import { createStoreBackend } from '../src/store-backend.js'
import { serveBackend, type ServeHandle } from '../src/serve.js'
import { createHttpBackend } from '../src/client.js'
import type { UsersGate } from '../src/gate.js'

let srv: ServeHandle | undefined
afterEach(async () => {
  await srv?.close()
  srv = undefined
})

function fakeSkins(): SkinsOps & { selected: SkinSelection[]; saved: Array<{ name: string; css: string; opts: unknown }> } {
  const selected: SkinSelection[] = []
  const saved: Array<{ name: string; css: string; opts: unknown }> = []
  return {
    selected,
    saved,
    async list(o) {
      return [
        { name: 'parchment', mode: 'both', source: 'shared', hash: 'a1' },
        ...(o?.sessionId === 's1' ? [{ name: 'my', mode: 'dark' as const, source: 'workspace' as const, hash: 'b2', base: 'parchment' }] : []),
      ]
    },
    async css(name) {
      if (name === 'broken') throw Object.assign(new Error('скин broken не прошёл проверку'), { code: 'bad_request' })
      if (name !== 'parchment') throw Object.assign(new Error(`скина ${name} нет`), { code: 'not_found' })
      return '[data-skin="parchment"]{--nr-bg:#fff}'
    },
    async save(name, css, opts) {
      saved.push({ name, css, opts })
      return css.includes('.sidebar') ? { ok: false, errors: ['селектор «.sidebar» вне контракта'] } : { ok: true, path: `/x/${name}.skin.css` }
    },
    async select(sel) {
      selected.push(sel)
    },
  }
}

const backend = () =>
  createStoreBackend({
    store: createMemoryStore(),
    generate: async function* () {
      yield { type: 'text', text: 'ok' }
    },
  })

describe('serveBackend skins', () => {
  it('capability, список, CSS, save, select — через createHttpBackend', async () => {
    const skins = fakeSkins()
    srv = await serveBackend(backend(), { skins, basePath: '/api' })
    const client = createHttpBackend(srv.url)
    expect((await client.capabilities()).skins).toEqual({ save: true, select: true })
    expect((await client.skins!.list()).map((s) => s.name)).toEqual(['parchment'])
    expect((await client.skins!.list({ sessionId: 's1' })).map((s) => s.name)).toEqual(['parchment', 'my'])

    const raw = await fetch(`${srv.url}/skins/parchment.css`)
    expect(raw.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(await client.skins!.css('parchment')).toBe('[data-skin="parchment"]{--nr-bg:#fff}')
    await expect(client.skins!.css('broken')).rejects.toMatchObject({ code: 'bad_request' })
    await expect(client.skins!.css('nope')).rejects.toMatchObject({ code: 'not_found' })

    const bad = await client.skins!.save!('my', '[data-skin="my"] .sidebar{color:red}', { sessionId: 's1', base: 'parchment' })
    expect(bad).toEqual({ ok: false, errors: ['селектор «.sidebar» вне контракта'] })
    expect(skins.saved[0]).toMatchObject({ name: 'my', opts: { sessionId: 's1', base: 'parchment' } })

    await client.skins!.select!({ name: 'my', mode: 'dark' })
    expect(skins.selected).toEqual([{ name: 'my', mode: 'dark' }])
    const badSel = await fetch(`${srv.url}/skins/current`, { method: 'PUT', body: JSON.stringify({ name: 'x', mode: 'sepia' }) })
    expect(badSel.status).toBe(400)
  })

  it('без источника — capability нет, /skins — not_supported', async () => {
    srv = await serveBackend(backend())
    const client = createHttpBackend(srv.url)
    expect((await client.capabilities()).skins).toBeUndefined()
    await expect(client.skins!.list()).rejects.toMatchObject({ code: 'not_supported' })
  })
})

/** user.css в памяти: по пользователю (нет id — `owner`). */
function userCssSkins(): SkinsOps & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    ...fakeSkins(),
    files,
    async userCss(o) {
      return files.get(o?.userId ?? 'owner') ?? ''
    },
    async saveUserCss(css, o) {
      files.set(o?.userId ?? 'owner', css)
    },
  }
}

/** Гейт пользователей для теста: кто пришёл — заголовок `x-user`. */
function headerGate(b: ReturnType<typeof backend>): UsersGate {
  const user = (id: string) => ({ id, name: id, role: id === 'alice' ? 'owner' : 'member' }) as never
  return {
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
}

describe('user.css (v1.32): GET|PUT /skins/user', () => {
  it('capability skins.user; без гейта — владелец; пусто — 200 с пустым телом; клиент userCss/saveUserCss', async () => {
    const skins = userCssSkins()
    srv = await serveBackend(backend(), { skins, basePath: '/api' })
    const client = createHttpBackend(srv.url)
    expect((await client.capabilities()).skins).toEqual({ save: true, select: true, user: true })
    const empty = await fetch(`${srv.url}/skins/user`)
    expect(empty.status).toBe(200)
    expect(empty.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(await empty.text()).toBe('')
    await client.skins!.saveUserCss!('@media (max-width: 500px) { .sidebar { display: none } }')
    expect(skins.files.get('owner')).toContain('.sidebar')
    expect(await client.skins!.userCss!()).toContain('.sidebar')
    expect((await fetch(`${srv.url}/skins/user`, { method: 'PUT', body: JSON.stringify({ css: 1 }) })).status).toBe(400)
    expect((await fetch(`${srv.url}/skins/user`, { method: 'DELETE' })).status).toBe(405)
  })

  it('с гейтом — пользователь запроса; member пишет свой user.css (общие скины — только owner)', async () => {
    const skins = userCssSkins()
    const b = backend()
    srv = await serveBackend(b, { skins, users: headerGate(b) })
    const put = (user: string, path: string, body: unknown) => fetch(`${srv!.url}${path}`, { method: 'PUT', headers: { 'x-user': user }, body: JSON.stringify(body) })
    expect((await put('anna', '/skins/user', { css: 'a{color:red}' })).status).toBe(200)
    expect((await put('alice', '/skins/user', { css: 'b{}' })).status).toBe(200)
    expect([...skins.files.entries()]).toEqual([['anna', 'a{color:red}'], ['alice', 'b{}']])
    expect(await (await fetch(`${srv.url}/skins/user`, { headers: { 'x-user': 'anna' } })).text()).toBe('a{color:red}')
    expect((await put('anna', '/skins/current', { name: 'x', mode: 'dark' })).status).toBe(403)
  })

  it('источник без user.css — capability нет, роут not_supported', async () => {
    srv = await serveBackend(backend(), { skins: fakeSkins() })
    expect((await createHttpBackend(srv.url).capabilities()).skins).toEqual({ save: true, select: true })
    expect((await fetch(`${srv.url}/skins/user`)).status).toBe(501)
  })
})
