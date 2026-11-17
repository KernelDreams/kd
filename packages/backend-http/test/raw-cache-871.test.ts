/**
 * кэш сырых файлов `GET /files/external/raw`. Оригинал — `no-cache` + ETag / Last-Modified,
 * повтор с валидатором — 304 без тела (свой хост и хост через агента машины); правка файла меняет ETag;
 * эскиз — `max-age=3600` с ETag.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import { bootstrapCode } from '@kerneldreams/host-agent'
import { createStoreBackend } from '../src/store-backend.js'
import { serveBackend, type ServeHandle } from '../src/serve.js'
import { createExternalHost } from '../src/external.js'
import { createHostsRouter, createRemoteHost, type RemoteHost } from '../src/remote-host.js'

let hub: string
let box: string
let srv: ServeHandle | undefined
const hosts: RemoteHost[] = []

beforeEach(async () => {
  hub = await realpath(await mkdtemp(join(tmpdir(), 'nr-871-hub-')))
  box = await realpath(await mkdtemp(join(tmpdir(), 'nr-871-box-')))
})
afterEach(async () => {
  await srv?.close()
  srv = undefined
  for (const h of hosts.splice(0)) h.close()
  await rm(hub, { recursive: true, force: true })
  await rm(box, { recursive: true, force: true })
})

const backend = () =>
  createStoreBackend({
    store: createMemoryStore(),
    generate: async function* () {
      yield { type: 'text', text: 'ok' }
    },
  })

const agentAt = (home: string) => (): ChildProcess => spawn(process.execPath, ['-e', bootstrapCode()], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ['pipe', 'pipe', 'pipe'] })

async function serve(): Promise<string> {
  const thumbnail = async (_src: string, out: string): Promise<boolean> => {
    await writeFile(out, Buffer.from('thumb-bytes'))
    return true
  }
  const h = createRemoteHost({ name: 'mini', os: 'darwin' }, { spawn: agentAt(box), thumbnail })
  hosts.push(h)
  srv = await serveBackend(backend(), { external: createHostsRouter(createExternalHost({ home: hub, hostOpen: false, hostName: 'server', thumbnail }), [h]) })
  return srv.url
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

describe('raw: ETag и 304', () => {
  for (const where of ['local', 'remote'] as const) {
    it(`${where}: оригинал с валидатором, повтор — 304 без тела, правка файла — снова 200`, async () => {
      const dir = where === 'local' ? hub : box
      const file = join(dir, 'pic.png')
      await writeFile(file, PNG)
      const url = `${await serve()}/files/external/raw?path=${encodeURIComponent(file)}${where === 'remote' ? '&host=mini' : ''}`

      const first = await fetch(url)
      expect(first.status).toBe(200)
      expect(Buffer.from(await first.arrayBuffer())).toEqual(PNG)
      const etag = first.headers.get('etag')
      expect(etag).toMatch(/^W\/".+"$/)
      expect(first.headers.get('last-modified')).toBeTruthy()
      expect(first.headers.get('cache-control')).toBe('private, no-cache')

      const again = await fetch(url, { headers: { 'if-none-match': etag! } })
      expect(again.status).toBe(304)
      expect((await again.arrayBuffer()).byteLength).toBe(0)
      expect(again.headers.get('etag')).toBe(etag)

      const since = await fetch(url, { headers: { 'if-modified-since': first.headers.get('last-modified')! } })
      expect(since.status).toBe(304)
      await since.arrayBuffer()

      // Файл переписан на месте (поворот, правка) — валидатор другой, тело новое.
      await writeFile(file, Buffer.concat([PNG, PNG]))
      const t = new Date(Date.now() + 5000)
      await utimes(file, t, t)
      const changed = await fetch(url, { headers: { 'if-none-match': etag! } })
      expect(changed.status).toBe(200)
      expect(changed.headers.get('etag')).not.toBe(etag)
      expect((await changed.arrayBuffer()).byteLength).toBe(PNG.length * 2)
    })

    it(`${where}: эскиз — час кэша и ETag, повтор с ним — 304`, async () => {
      const dir = where === 'local' ? hub : box
      const file = join(dir, 'pic.png')
      await writeFile(file, PNG)
      const url = `${await serve()}/files/external/raw?path=${encodeURIComponent(file)}&thumb=128${where === 'remote' ? '&host=mini' : ''}`
      const first = await fetch(url)
      expect(first.status).toBe(200)
      await first.arrayBuffer()
      expect(first.headers.get('cache-control')).toBe('private, max-age=3600')
      const etag = first.headers.get('etag')
      expect(etag).toBeTruthy()
      const again = await fetch(url, { headers: { 'if-none-match': etag! } })
      expect(again.status).toBe(304)
      await again.arrayBuffer()
    })
  }

  it('видео своего хоста: Range — 206 без 304, повтор целиком с валидатором — 304', async () => {
    const file = join(hub, 'clip.mp4')
    await writeFile(file, Buffer.alloc(1000, 7))
    const url = `${await serve()}/files/external/raw?path=${encodeURIComponent(file)}`
    const first = await fetch(url)
    const etag = first.headers.get('etag')!
    await first.arrayBuffer()
    const part = await fetch(url, { headers: { range: 'bytes=0-9', 'if-none-match': etag } })
    expect(part.status).toBe(206)
    expect((await part.arrayBuffer()).byteLength).toBe(10)
    const again = await fetch(url, { headers: { 'if-none-match': etag } })
    expect(again.status).toBe(304)
    await again.arrayBuffer()
  })
})
