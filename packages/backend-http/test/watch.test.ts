/**
 * слежение вне главного потока — стресс create/close, таймаут, лимит, выключатель.
 * 22.10 lab nr завис в `uv_fs_event_start → uv_sem_wait` после дня create/close наблюдателей.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import type { ExternalUpdateEvent } from '@kerneldreams/ui-protocol'
import { createStoreBackend } from '../src/store-backend.js'
import { serveBackend, type ServeHandle } from '../src/serve.js'
import { createHttpBackend } from '../src/client.js'
import { createExternalHost } from '../src/external.js'
import { createWatchPool, type WatchPool } from '../src/watch.js'

let srv: ServeHandle | undefined
let pool: WatchPool | undefined
let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'nr-watch-'))
  for (let i = 0; i < 20; i++) await mkdir(join(home, 'd', `s${i}`, 'deep'), { recursive: true })
})
afterEach(async () => {
  await srv?.close()
  await pool?.close()
  srv = undefined
  pool = undefined
  await rm(home, { recursive: true, force: true })
})

const backend = () =>
  createStoreBackend({
    store: createMemoryStore(),
    generate: async function* () {
      yield { type: 'text', text: 'ok' }
    },
  })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Поток, который на `open` не отвечает никогда — как повисший FSEvents. */
const HUNG = `require('node:worker_threads').parentPort.on('message', () => {})`

describe('FRR-7: слежение вне главного потока', () => {
  it('стресс: 200 create/close через HTTP подряд — HTTP отвечает всё время, слежение живо после', async () => {
    const lines: string[] = []
    pool = createWatchPool({ log: (l) => lines.push(l) })
    srv = await serveBackend(backend(), { external: createExternalHost({ home, hostOpen: false, watchPool: pool }) })
    const ext = createHttpBackend(srv.url).external!

    let worst = 0
    let pings = 0
    let stop = false
    const pinger = (async () => {
      while (!stop) {
        const t0 = Date.now()
        await ext.stat(join(home, 'd'))
        worst = Math.max(worst, Date.now() - t0)
        pings++
        await sleep(5)
      }
    })()

    for (let i = 0; i < 200; i++) {
      const dir = join(home, 'd', `s${i % 20}`)
      const off = ext.watch!(dir, () => {}, i % 3 === 0 ? { recursive: true } : undefined)
      if (i % 4 === 0) await sleep(1)
      off()
    }
    // и пачкой: 40 открыты одновременно, закрыты разом
    const offs = Array.from({ length: 40 }, (_, i) => ext.watch!(join(home, 'd', `s${i % 20}`), () => {}, { recursive: i % 2 === 0 }))
    await sleep(200)
    offs.forEach((off) => off())
    await sleep(300)
    stop = true
    await pinger

    expect(pings).toBeGreaterThan(10)
    expect(worst).toBeLessThan(1000)
    expect(lines).toEqual([])
    expect(pool.size()).toBe(0)

    const got: ExternalUpdateEvent[] = []
    const off = ext.watch!(join(home, 'd'), (e) => got.push(e))
    await sleep(300)
    await writeFile(join(home, 'd', 'new.txt'), 'x')
    for (let i = 0; i < 20 && !got.some((e) => e.paths.some((p) => p.endsWith('/new.txt'))); i++) await sleep(100)
    expect(got.some((e) => e.paths.some((p) => p.endsWith('/new.txt')))).toBe(true)
    off()
  }, 30_000)

  it('таймаут: поток не ответил — отказ за timeoutMs, одна строка в лог; после maxRespawns — сразу отказ', async () => {
    const lines: string[] = []
    pool = createWatchPool({ timeoutMs: 150, maxRespawns: 1, log: (l) => lines.push(l), workerSource: HUNG })
    const sink = { onEvent: () => {}, onError: () => {} }
    const t0 = Date.now()
    await expect(pool.open(home, false, sink).ready).rejects.toMatchObject({ code: 'watch_failed' })
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('не открылся за 150 мс')
    await expect(pool.open(home, false, sink).ready).rejects.toMatchObject({ code: 'watch_failed' })
    await expect(pool.open(home, false, sink).ready).rejects.toThrow(/выключено/)
    expect(pool.size()).toBe(0)
  })

  it('повисший поток: живые наблюдатели получают onError, панель — paths [""]; запись уходит из карты', async () => {
    // Живой поток, но open на «/hang» не отвечает.
    const src = `
const { parentPort } = require('node:worker_threads')
parentPort.on('message', (m) => { if (m.op === 'open' && !m.path.endsWith('hang')) parentPort.postMessage({ op: 'opened', id: m.id }) })`
    await mkdir(join(home, 'hang'))
    pool = createWatchPool({ timeoutMs: 150, log: () => {}, workerSource: src })
    const ext = createExternalHost({ home, hostOpen: false, watchPool: pool })
    const got: ExternalUpdateEvent[] = []
    const off = ext.watch!(join(home, 'd'), (e) => got.push(e))
    await sleep(50)
    expect(pool.size()).toBe(1)
    const offHang = ext.watch!(join(home, 'hang'), () => {})
    await sleep(300)
    expect(got.map((e) => e.paths)).toEqual([['']])
    expect(pool.size()).toBe(0)
    // следующая подписка — новый поток
    const off2 = ext.watch!(join(home, 'd'), () => {})
    await sleep(50)
    expect(pool.size()).toBe(1)
    off()
    offHang()
    off2()
    expect(pool.size()).toBe(0)
  })

  it('лимит: сверх max — отказ и строка в лог; закрыли — снова можно; один путь — один наблюдатель', async () => {
    const lines: string[] = []
    pool = createWatchPool({ max: 2, log: (l) => lines.push(l) })
    const ext = createExternalHost({ home, hostOpen: false, watchPool: pool })
    const a1 = ext.watch!(join(home, 'd', 's0'), () => {})
    const a2 = ext.watch!(join(home, 'd', 's0'), () => {})
    const b = ext.watch!(join(home, 'd', 's1'), () => {})
    expect(pool.size()).toBe(2)
    const c = ext.watch!(join(home, 'd', 's2'), () => {})
    await sleep(50)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('лимит 2')
    a1()
    expect(pool.size()).toBe(2)
    a2()
    expect(pool.size()).toBe(1)
    const d = ext.watch!(join(home, 'd', 's3'), () => {})
    expect(pool.size()).toBe(2)
    b()
    c()
    d()
    expect(pool.size()).toBe(0)
  })

  it('выключатель: watch: false — нет capability, нет роута, пул не трогается', async () => {
    pool = createWatchPool()
    srv = await serveBackend(backend(), { external: createExternalHost({ home, hostOpen: false, watch: false, watchPool: pool }) })
    expect((await createHttpBackend(srv.url).capabilities()).files?.watch).toBeUndefined()
    const r = await fetch(`${srv.url}/files/external/events?path=${encodeURIComponent(home)}`)
    expect(r.status).toBe(501)
    expect(pool.size()).toBe(0)
  })
})
