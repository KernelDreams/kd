/**
 * Панель файлов (v1.42, file-panel-spec §1–1a): `files.external` с записью,
 * корзиной, копированием, поиском, слежением и эскизами; хост в адресе.
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import type { ExternalUpdateEvent } from '@kerneldreams/ui-protocol'
import { createStoreBackend } from '../src/store-backend.js'
import { serveBackend, type ServeHandle } from '../src/serve.js'
import { createHttpBackend } from '../src/client.js'
import { createExternalHost } from '../src/external.js'

let srv: ServeHandle | undefined
let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'nr-extw-'))
  await mkdir(join(home, 'w', 'sub'), { recursive: true })
  await writeFile(join(home, 'w', 'a.txt'), 'alpha\nbeta\n')
  await writeFile(join(home, 'w', 'sub', 'b.md'), '# beta\n')
  await writeFile(join(home, 'w', 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
})
afterEach(async () => {
  await srv?.close()
  srv = undefined
  await rm(home, { recursive: true, force: true })
})

const backend = () =>
  createStoreBackend({
    store: createMemoryStore(),
    generate: async function* () {
      yield { type: 'text', text: 'ok' }
    },
  })

async function start(extra: Parameters<typeof createExternalHost>[0] = {}) {
  const external = createExternalHost({ home, hostOpen: false, hostName: 'mini', ...extra })
  srv = await serveBackend(backend(), { external })
  return createHttpBackend(srv.url).external!
}

describe('files.external v1.42 — запись', () => {
  it('capability: host и под-флаги; write: false — без записи', async () => {
    await start()
    const caps = await createHttpBackend(srv!.url).capabilities()
    expect(caps.files).toEqual({ external: true, write: true, search: true, watch: true, disk: true, host: 'mini', hosts: ['mini'] })
    await srv!.close()
    srv = await serveBackend(backend(), { external: createExternalHost({ home, hostOpen: false, write: false, watch: false }) })
    expect((await createHttpBackend(srv.url).capabilities()).files).toEqual({ external: true, search: true, disk: true })
    const r = await fetch(`${srv.url}/files/external/mkdir`, { method: 'POST', body: JSON.stringify({ path: join(home, 'x') }) })
    expect(r.status).toBe(501)
  })

  it('хост в адресе: свой и пустой — да, чужой — not_found; FileEntry/stat несут host', async () => {
    const ext = await start()
    expect(await ext.stat('~/w/a.txt', { host: 'mini' })).toMatchObject({ host: 'mini', exists: true })
    const list = await ext.list('~/w')
    expect(list.every((e) => e.host === 'mini')).toBe(true)
    await expect(ext.list('~/w', { host: 'linux' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(ext.write!('~/w/z.txt', 'z', { host: 'linux' })).rejects.toMatchObject({ code: 'not_found' })
    const raw = await fetch(ext.url!('~/w/pic.png', { host: 'linux' }))
    expect(raw.status).toBe(404)
  })

  it('write/mkdir/rename/copy; revision; конфликты', async () => {
    const ext = await start()
    const { revision } = await ext.write!(join(home, 'w', 'new', 'n.txt'), 'hi')
    expect(await readFile(join(home, 'w', 'new', 'n.txt'), 'utf8')).toBe('hi')
    await expect(ext.write!('~/w/new/n.txt', 'x', { revision: null })).rejects.toMatchObject({ code: 'conflict' })
    await ext.write!('~/w/new/n.txt', 'hi2', { revision })
    await expect(ext.write!('~/w/new/n.txt', 'x', { revision })).rejects.toMatchObject({ code: 'conflict' })

    await ext.mkdir!('~/w/d1/d2')
    expect(existsSync(join(home, 'w', 'd1', 'd2'))).toBe(true)

    await ext.rename!('~/w/a.txt', '~/w/a2.txt')
    expect(existsSync(join(home, 'w', 'a2.txt'))).toBe(true)
    await expect(ext.rename!('~/w/a2.txt', '~/w/pic.png')).rejects.toMatchObject({ code: 'conflict' })
    await expect(ext.rename!('~/w/sub', '~/w/sub/in')).rejects.toMatchObject({ code: 'bad_request' })

    await ext.copy!('~/w/sub', '~/w/sub-copy')
    expect(await readFile(join(home, 'w', 'sub-copy', 'b.md'), 'utf8')).toBe('# beta\n')
    await expect(ext.copy!('~/w/sub', '~/w/sub-copy')).rejects.toMatchObject({ code: 'conflict' })
    await ext.copy!('~/w/a2.txt', '~/w/pic.png', { overwrite: true })
    expect(await readFile(join(home, 'w', 'pic.png'), 'utf8')).toBe('alpha\nbeta\n')
    await expect(ext.copy!('~/w/sub', '~/w/sub/deeper')).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('закрытое — forbidden и на запись; дом и корень не трогаем', async () => {
    const ext = await start()
    await expect(ext.write!('~/.ssh/config', 'x')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(ext.write!('~/w/.env', 'x')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(ext.copy!('~/w/a.txt', '~/.ssh/a')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(ext.delete!('~')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(ext.delete!('/')).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('delete: в ~/.nr-trash/<абсолютный путь>, повтор — с суффиксом; permanent — насовсем', async () => {
    const ext = await start()
    const abs = join(home, 'w', 'a.txt')
    const { trashed } = await ext.delete!(abs)
    expect(trashed).toBe(join(home, '.nr-trash', abs.replace(/^\/+/, '')))
    expect(existsSync(abs)).toBe(false)
    expect(await readFile(trashed!, 'utf8')).toBe('alpha\nbeta\n')
    await writeFile(abs, 'again')
    const second = await ext.delete!(abs)
    expect(second.trashed).not.toBe(trashed)
    expect(existsSync(second.trashed!)).toBe(true)
    expect(await ext.delete!('~/w/sub', { permanent: true })).toEqual({})
    expect(existsSync(join(home, 'w', 'sub'))).toBe(false)
    expect(existsSync(join(home, '.nr-trash', join(home, 'w', 'sub').replace(/^\/+/, '')))).toBe(false)
    await expect(ext.delete!('~/w/none')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('delete на macOS — системная Корзина: место в Корзине от Finder; Корзина не приняла — ~/.nr-trash', async () => {
    const calls: string[][] = []
    let fail = false
    const trashRun = async (cmd: string, args: string[]): Promise<string> => {
      calls.push([cmd, ...args])
      if (fail) throw new Error('нет доступа к Finder')
      const src = args[args.length - 1]!
      const dest = join(home, '.Trash', 'a.txt')
      await mkdir(join(home, '.Trash'), { recursive: true })
      await writeFile(dest, await readFile(src))
      await rm(src)
      return `${dest}\n`
    }
    const ext = createExternalHost({ home, os: 'darwin', hostOpen: false, watch: false, trashRun })
    const abs = join(home, 'w', 'a.txt')
    expect(await ext.delete!(abs)).toEqual({ trashed: join(home, '.Trash', 'a.txt') })
    expect(calls[0]![0]).toBe('osascript')
    expect(existsSync(abs)).toBe(false)
    // permanent — мимо Корзины.
    expect(await ext.delete!('~/w/sub', { permanent: true })).toEqual({})
    expect(calls.length).toBe(1)
    // Корзина не приняла — прежняя ~/.nr-trash, без потерь.
    fail = true
    const { trashed } = await ext.delete!(join(home, 'w', 'pic.png'))
    expect(trashed).toBe(join(home, '.nr-trash', join(home, 'w', 'pic.png').replace(/^\/+/, '')))
    // systemTrash: false — всегда ~/.nr-trash.
    await writeFile(abs, 'x')
    const off = createExternalHost({ home, os: 'darwin', hostOpen: false, watch: false, systemTrash: false, trashRun })
    const before = calls.length
    expect((await off.delete!(abs)).trashed).toContain('.nr-trash')
    expect(calls.length).toBe(before)
  })

  it('search: маска имени, текст, оба; без обоих — bad_request', async () => {
    const ext = await start()
    const byName = await ext.search!('~/w', { glob: '*.md' })
    expect(byName).toEqual([{ path: join(home, 'w', 'sub', 'b.md'), line: 0, text: '' }])
    const byText = await ext.search!('~/w', { query: 'BETA' })
    expect(byText.map((h) => [h.path.slice(home.length), h.line])).toEqual([
      ['/w/a.txt', 2],
      ['/w/sub/b.md', 1],
    ])
    const both = await ext.search!('~/w', { glob: '*.txt', query: 'beta' })
    expect(both).toHaveLength(1)
    await expect(ext.search!('~/w', {})).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('watch: SSE external_update с абсолютными путями; без recursive — только прямые дети', async () => {
    const ext = await start()
    const wait = async (got: ExternalUpdateEvent[], tail: string): Promise<ExternalUpdateEvent | undefined> => {
      for (let i = 0; i < 30 && !got.some((e) => e.paths.some((p) => p.endsWith(tail))); i++) await new Promise((r) => setTimeout(r, 100))
      return got.find((e) => e.paths.some((p) => p.endsWith(tail)))
    }
    const flat: ExternalUpdateEvent[] = []
    const deep: ExternalUpdateEvent[] = []
    const off1 = ext.watch!(join(home, 'w'), (e) => flat.push(e))
    const off2 = ext.watch!(join(home, 'w'), (e) => deep.push(e), { recursive: true })
    await new Promise((r) => setTimeout(r, 300))
    await writeFile(join(home, 'w', 'top.txt'), 't')
    await writeFile(join(home, 'w', 'sub', 'c.txt'), 'c')
    expect(await wait(flat, '/w/top.txt')).toMatchObject({ type: 'external_update', host: 'mini' })
    expect(await wait(deep, '/sub/c.txt')).toMatchObject({ type: 'external_update', host: 'mini' })
    off1()
    off2()
  })

  it('эскиз: raw?thumb= — генератор хоста и кэш; не картинка — оригинал', async () => {
    let made = 0
    const ext = await start({
      thumbsDir: join(home, 'thumbs'),
      thumbnail: async (_src, out, px, kind) => {
        made++
        expect(kind).toBe('image')
        expect(px).toBe(128)
        await writeFile(out, 'PNGTHUMB')
        return true
      },
    })
    const a = await fetch(ext.url!('~/w/pic.png', { thumb: 128 }))
    expect(a.headers.get('content-type')).toBe('image/png')
    expect(await a.text()).toBe('PNGTHUMB')
    await fetch(ext.url!('~/w/pic.png', { thumb: 128 }))
    expect(made).toBe(1)
    const txt = await fetch(ext.url!('~/w/a.txt', { thumb: 128 }))
    expect(await txt.text()).toBe('alpha\nbeta\n')
  })

  it('видео — потоком с Range: 206 и кусок, без Range — весь файл, за краем — 416 (ABC-763)', async () => {
    const ext = await start({})
    await writeFile(join(home, 'w', 'clip.mp4'), Buffer.from('0123456789'))
    const url = ext.url!('~/w/clip.mp4')!
    const part = await fetch(url, { headers: { range: 'bytes=2-5' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await part.text()).toBe('2345')
    const tail = await fetch(url, { headers: { range: 'bytes=-3' } })
    expect(await tail.text()).toBe('789')
    const all = await fetch(url)
    expect(all.status).toBe(200)
    expect(all.headers.get('accept-ranges')).toBe('bytes')
    expect(await all.text()).toBe('0123456789')
    expect((await fetch(url, { headers: { range: 'bytes=20-' } })).status).toBe(416)
  })

  it('эскиз не вышел — 422 «не читается», а не оригинал (pics-spec §3)', async () => {
    const ext = await start({ thumbsDir: join(home, 'thumbs'), thumbnail: async () => false })
    const r = await fetch(ext.url!('~/w/pic.png', { thumb: 128 }))
    expect(r.status).toBe(422)
    expect(((await r.json()) as { code?: string }).code).toBe('unreadable')
  })

  it('эскизы: не больше thumbConcurrency одновременно, один и тот же — один раз', async () => {
    for (let i = 0; i < 8; i++) await writeFile(join(home, 'w', `p${i}.png`), Buffer.from([0x89, 0x50, 0x4e, 0x47, i]))
    let active = 0
    let peak = 0
    let made = 0
    const host = createExternalHost({
      home,
      thumbsDir: join(home, 'thumbs'),
      thumbConcurrency: 2,
      thumbnail: async (_src, out) => {
        made++
        peak = Math.max(peak, ++active)
        await new Promise((r) => setTimeout(r, 20))
        await writeFile(out, 'T')
        active--
        return true
      },
    })
    const paths = [...Array(8).keys()].map((i) => `~/w/p${i}.png`)
    const got = await Promise.all([...paths, '~/w/p0.png', '~/w/p0.png'].map((p) => host.thumb(p, 128)))
    expect(got.every((g) => g !== null)).toBe(true)
    expect(peak).toBe(2)
    expect(made).toBe(8)
  })
})
