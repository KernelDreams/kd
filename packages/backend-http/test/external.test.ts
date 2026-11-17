/**
 * Файл вне пространств и действия хоста (v1.41, file-links-spec §3):
 * `serveBackend({external})` — роуты /files/external/*, /host/*, capability,
 * закрытые пути, словарь приложений, только owner.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import { createStoreBackend } from '../src/store-backend.js'
import { serveBackend, type ServeHandle } from '../src/serve.js'
import { createHttpBackend } from '../src/client.js'
import { createExternalHost } from '../src/external.js'
import type { UsersGate } from '../src/gate.js'

let srv: ServeHandle | undefined
let home: string
afterEach(async () => {
  await srv?.close()
  srv = undefined
})
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'nr-ext-'))
  await mkdir(join(home, 'docs'))
  await writeFile(join(home, 'docs', 'a.md'), '# A\n')
  await writeFile(join(home, 'docs', '.env.local'), 'SECRET=1')
  await writeFile(join(home, 'docs', 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))
  await mkdir(join(home, '.ssh'))
  await writeFile(join(home, '.ssh', 'id_ed25519'), 'PRIVATE')
  await symlink(join(home, '.ssh', 'id_ed25519'), join(home, 'docs', 'innocent.txt'))
  await writeFile(join(home, 'docs', 'my api key.json'), '{}')
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

function setup(extra: Parameters<typeof createExternalHost>[0] = {}) {
  const calls: Array<{ cmd: string; args: string[] }> = []
  const external = createExternalHost({ home, hostOpen: true, exec: async (cmd, args) => void calls.push({ cmd, args }), ...extra })
  return { external, calls }
}

describe('files.external / host (v1.41)', () => {
  it('capability; stat/read/list/raw по абсолютному пути и ~', async () => {
    const { external } = setup()
    srv = await serveBackend(backend(), { external, basePath: '/api' })
    const client = createHttpBackend(srv.url)
    const caps = await client.capabilities()
    expect(caps.files).toEqual({ external: true, write: true, search: true, watch: true, disk: true })
    expect(caps.host).toEqual({ open: true, apps: ['zed'] })

    expect(await client.external!.stat('~/docs/a.md')).toMatchObject({ path: join(home, 'docs', 'a.md'), exists: true, kind: 'file', size: 4 })
    expect(await client.external!.stat('~/docs/none.md')).toEqual({ path: join(home, 'docs', 'none.md'), exists: false })
    expect(await client.external!.stat(join(home, 'docs'))).toMatchObject({ exists: true, kind: 'dir' })
    const read = await client.external!.read(join(home, 'docs', 'a.md'))
    expect(read).toMatchObject({ path: join(home, 'docs', 'a.md'), content: '# A\n', encoding: 'utf8' })
    const names = (await client.external!.list('~/docs')).map((e) => e.name)
    expect(names).toEqual(['a.md', 'img.png'])
    const raw = await fetch(client.external!.url!('~/docs/img.png'))
    expect(raw.status).toBe(200)
    expect(raw.headers.get('content-type')).toBe('image/png')
    expect((await raw.arrayBuffer()).byteLength).toBe(7)
  })

  it('закрытые пути — forbidden, и через симлинк; относительный — bad_request; нет файла — not_found', async () => {
    const { external } = setup({ deny: ['~/docs/private'] })
    srv = await serveBackend(backend(), { external })
    const get = (op: string, path: string) => fetch(`${srv!.url}/files/external/${op}?path=${encodeURIComponent(path)}`)
    for (const p of ['~/.ssh/id_ed25519', '~/.ssh', '~/docs/.env.local', '~/docs/innocent.txt', '~/docs/my api key.json', '~/docs/private/x.md']) {
      const r = await get('read', p)
      expect(r.status, p).toBe(403)
      expect((await r.json()).code).toBe('forbidden')
    }
    expect((await get('read', 'docs/a.md')).status).toBe(400)
    expect((await get('read', '~/docs/none.md')).status).toBe(404)
    expect((await get('raw', '~/.ssh/id_ed25519')).status).toBe(403)
  })

  it('host.reveal/open: open -R, open -a Zed, по умолчанию; чужое приложение — bad_request; dryRun не запускает', async () => {
    const { external, calls } = setup()
    srv = await serveBackend(backend(), { external })
    const client = createHttpBackend(srv.url)
    const abs = join(home, 'docs', 'a.md')
    await client.host!.reveal('~/docs/a.md')
    await client.host!.open(abs, { app: 'zed' })
    await client.host!.open(abs)
    expect(calls).toEqual([
      { cmd: 'open', args: ['-R', abs] },
      { cmd: 'open', args: ['-a', 'Zed', abs] },
      { cmd: 'open', args: [abs] },
    ])
    await expect(client.host!.open(abs, { app: 'Terminal' })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(client.host!.reveal('~/.ssh/id_ed25519')).rejects.toMatchObject({ code: 'forbidden' })
    const dry = await fetch(`${srv.url}/host/reveal`, { method: 'POST', body: JSON.stringify({ path: abs, dryRun: true }) })
    expect((await dry.json()).result).toEqual({ cmd: 'open', args: ['-R', abs] })
    expect(calls).toHaveLength(3)
  })

  it('не macOS — host не заявлен, /host — not_supported; без опции — роутов нет', async () => {
    const external = createExternalHost({ home, hostOpen: false })
    srv = await serveBackend(backend(), { external })
    const caps = await createHttpBackend(srv.url).capabilities()
    expect(caps.host).toBeUndefined()
    expect((await fetch(`${srv.url}/host/reveal`, { method: 'POST', body: '{"path":"/tmp"}' })).status).toBe(501)
    await srv.close()
    srv = await serveBackend(backend(), {})
    expect((await createHttpBackend(srv.url).capabilities()).files).toBeUndefined()
    expect((await fetch(`${srv.url}/files/external/stat?path=/tmp`)).status).toBe(404)
  })

  it('с гейтом пользователей — только owner', async () => {
    const { external } = setup()
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
    srv = await serveBackend(b, { external, users })
    const url = `${srv.url}/files/external/stat?path=${encodeURIComponent('~/docs/a.md')}`
    expect((await fetch(url, { headers: { 'x-user': 'anna' } })).status).toBe(403)
    expect((await fetch(url, { headers: { 'x-user': 'alice' } })).status).toBe(200)
  })
})
