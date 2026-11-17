/**
 * Удалённые хосты (v1.45, hosts-spec §2): агент nr-host-agent тем же загрузчиком,
 * что уходит в ssh, но локальным процессом с подменённым HOME; провал ssh — фейковым процессом.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile, realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import type { ExternalUpdateEvent } from '@kerneldreams/ui-protocol'
import { bootstrapCode } from '@kerneldreams/host-agent'
import { createStoreBackend } from '../src/store-backend.js'
import { serveBackend, type ServeHandle } from '../src/serve.js'
import { createHttpBackend } from '../src/client.js'
import { createExternalHost } from '../src/external.js'
import { createHostsRouter, createRemoteHost, transferAcross, type RemoteHost } from '../src/remote-host.js'

let hub: string
let erin: string
let srv: ServeHandle | undefined
const hosts: RemoteHost[] = []
let spawns = 0

beforeEach(async () => {
  hub = await realpath(await mkdtemp(join(tmpdir(), 'nr-rh-hub-')))
  erin = await realpath(await mkdtemp(join(tmpdir(), 'nr-rh-erin-')))
  await mkdir(join(erin, 'w', 'sub'), { recursive: true })
  await writeFile(join(erin, 'w', 'a.txt'), 'alpha\nbeta\n')
  await writeFile(join(erin, 'w', 'sub', 'b.md'), '# beta\n')
  await writeFile(join(erin, 'w', 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
  await mkdir(join(erin, '.ssh'))
  await writeFile(join(erin, '.ssh', 'id_ed25519'), 'secret')
  spawns = 0
})
afterEach(async () => {
  await srv?.close()
  srv = undefined
  for (const h of hosts.splice(0)) h.close()
  await rm(hub, { recursive: true, force: true })
  await rm(erin, { recursive: true, force: true })
})

/** Агент «на хосте»: свой node, HOME — каталог хоста. */
const agentAt = (home: string) => (): ChildProcess => {
  spawns++
  return spawn(process.execPath, ['-e', bootstrapCode()], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ['pipe', 'pipe', 'pipe'] })
}

/** Процесс, который умирает как ssh без связи (255) или без node (127). */
const dying = (code: number, stderr: string) => (): ChildProcess => {
  spawns++
  return spawn(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(stderr)}); process.exit(${code})`], { stdio: ['pipe', 'pipe', 'pipe'] })
}

function remote(name: string, home: string, extra: Parameters<typeof createRemoteHost>[1] = {}): RemoteHost {
  const h = createRemoteHost({ name, os: 'linux' }, { spawn: agentAt(home), thumbsDir: join(hub, '.cache', 'nr-thumbs', 'hosts'), ...extra })
  hosts.push(h)
  return h
}

const backend = () =>
  createStoreBackend({
    store: createMemoryStore(),
    generate: async function* () {
      yield { type: 'text', text: 'ok' }
    },
  })

async function start(remotes: RemoteHost[]) {
  const router = createHostsRouter(createExternalHost({ home: hub, hostOpen: false, hostName: 'mini' }), remotes)
  srv = await serveBackend(backend(), { external: router })
  return { router, client: createHttpBackend(srv.url) }
}

describe('remote-host: файлы хоста через агента', () => {
  it('stat/list/read/write/mkdir/rename/copy/delete на хосте; ~ — дом хоста; закрытое — forbidden', async () => {
    const { client } = await start([remote('erin', erin)])
    const ext = client.external!
    const at = { host: 'erin' }
    expect((await ext.stat('~', at)).path).toBe(erin)
    const list = await ext.list(join(erin, 'w'), at)
    expect(list.map((e) => [e.name, e.kind, e.host])).toEqual([
      ['sub', 'dir', 'erin'],
      ['a.txt', 'file', 'erin'],
      ['pic.png', 'file', 'erin'],
    ])
    expect(list.find((e) => e.name === 'pic.png')?.mime).toBe('image/png')
    const r = await ext.read(join(erin, 'w', 'a.txt'), at)
    expect(r.content).toBe('alpha\nbeta\n')
    const w = await ext.write!(join(erin, 'w', 'a.txt'), 'gamma', { ...at, revision: r.revision })
    expect(w.revision).toMatch(/:5$/)
    await expect(ext.write!(join(erin, 'w', 'a.txt'), 'x', { ...at, revision: r.revision })).rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(join(erin, 'w', 'a.txt'), 'utf8')).toBe('gamma')
    await ext.mkdir!(join(erin, 'w', 'new'), at)
    await ext.rename!(join(erin, 'w', 'new'), join(erin, 'w', 'new2'), at)
    await ext.copy!(join(erin, 'w', 'sub'), join(erin, 'w', 'sub2'), at)
    expect(await readFile(join(erin, 'w', 'sub2', 'b.md'), 'utf8')).toBe('# beta\n')
    const d = await ext.delete!(join(erin, 'w', 'sub2'), at)
    expect(d.trashed).toBe(join(erin, '.nr-trash', erin.slice(1), 'w', 'sub2'))
    await expect(ext.read(join(erin, '.ssh', 'id_ed25519'), at)).rejects.toMatchObject({ code: 'forbidden' })
    // свой хост — как раньше, чужой незаявленный — not_found
    expect((await ext.stat('~')).path).toBe(hub)
    await expect(ext.stat('~', { host: 'nope' })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('capability: hostsInfo со связью, disk; поиск по имени и тексту; disk хоста', async () => {
    const d = remote('erin', erin)
    const { router, client } = await start([d])
    let caps = await client.capabilities()
    expect(caps.files?.hosts).toEqual(['mini', 'erin'])
    expect(caps.files?.hostsInfo?.[1]).toEqual({ name: 'erin', os: 'linux', state: 'unknown' })
    await router.probe()
    caps = await createHttpBackend(srv!.url).capabilities()
    expect(caps.files?.hostsInfo).toEqual([
      { name: 'mini', hub: true, state: 'ok', os: process.platform, home: [homedir()] },
      { name: 'erin', os: process.platform, state: 'ok' },
    ])
    expect(caps.files?.disk).toBe(true)
    const ext = client.external!
    const byName = await ext.search!(join(erin, 'w'), { glob: '*.md' }, { host: 'erin' })
    expect(byName.map((h) => h.path)).toEqual([join(erin, 'w', 'sub', 'b.md')])
    const byText = await ext.search!(join(erin, 'w'), { query: 'BETA' }, { host: 'erin' })
    expect(byText.map((h) => [h.path.slice(erin.length), h.line, h.column])).toEqual([
      ['/w/a.txt', 2, 1],
      ['/w/sub/b.md', 1, 3],
    ])
    const disk = await (await fetch(`${srv!.url}/files/external/disk?path=${encodeURIComponent(erin)}&host=erin`)).json()
    expect(disk.ok).toBe(true)
    expect(disk.result.total).toBeGreaterThan(0)
  })

  it('raw потоком с хоста; эскиз хабом (хост не умеет) и второй раз — из кэша', async () => {
    let made = 0
    const thumbnail = async (src: string, out: string) => {
      made++
      await writeFile(out, Buffer.concat([Buffer.from('thumb:'), await readFile(src)]))
      return true
    }
    await start([remote('erin', erin, { thumbnail })])
    const raw = await fetch(`${srv!.url}/files/external/raw?path=${encodeURIComponent(join(erin, 'w', 'pic.png'))}&host=erin`)
    expect(raw.status).toBe(200)
    expect(raw.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await raw.arrayBuffer())).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    const url = `${srv!.url}/files/external/raw?path=${encodeURIComponent(join(erin, 'w', 'pic.png'))}&host=erin&thumb=128`
    const t1 = Buffer.from(await (await fetch(url)).arrayBuffer())
    const t2 = Buffer.from(await (await fetch(url)).arrayBuffer())
    expect(t1.subarray(0, 6).toString()).toBe('thumb:')
    expect(t2).toEqual(t1)
    expect(made).toBe(1)
  })

  it('нет связи: 503 host_unavailable с причиной, состояние off; в окне повтора — без нового ssh', async () => {
    const off = createRemoteHost({ name: 'linux' }, { spawn: dying(255, 'ssh: Could not resolve hostname linux: nodename nor servname provided\n'), retryMs: 60_000 })
    hosts.push(off)
    const { client } = await start([off])
    const res = await fetch(`${srv!.url}/files/external/list?path=%2F&host=linux`)
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.code).toBe('host_unavailable')
    expect(body.error).toMatch(/нет связи с linux: нет ssh-алиаса linux на этой машине/)
    await expect(client.external!.stat('/', { host: 'linux' })).rejects.toMatchObject({ code: 'host_unavailable' })
    expect(spawns).toBe(1)
    expect(off.info()).toMatchObject({ name: 'linux', state: 'off' })
    const noNode = createRemoteHost({ name: 'carol' }, { spawn: dying(127, "sh: node: command not found\n") })
    hosts.push(noNode)
    await expect(noNode.connect()).rejects.toMatchObject({ code: 'host_unavailable' })
    expect(noNode.info()).toMatchObject({ state: 'no-node', reason: 'sh: node: command not found' })
  })

  it('close посреди подключения: агент без hello убит, connect отклонён (ABC-785 — ssh переживали стенд)', async () => {
    let proc: ChildProcess | undefined
    // процесс, который молчит: hello так и не придёт (ssh ещё подключается)
    const h = createRemoteHost({ name: 'slow' }, { spawn: () => (proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['pipe', 'pipe', 'pipe'] })), connectTimeoutMs: 30_000 })
    const pending = h.connect()
    await new Promise((r) => setTimeout(r, 50))
    const exited = new Promise<void>((r) => proc!.once('exit', () => r()))
    h.close()
    await expect(pending).rejects.toMatchObject({ code: 'host_unavailable' })
    await exited
    expect(proc!.exitCode !== null || proc!.signalCode !== null).toBe(true)
  })

  it('после обрыва — следующий вызов поднимает агента заново; слежение: событие, обрыв — [\'\'] и снова события', async () => {
    const d = remote('erin', erin, { retryMs: 50 })
    await d.connect()
    const events: ExternalUpdateEvent[] = []
    const stop = d.files.watch(join(erin, 'w'), (e) => events.push(e))
    await new Promise((r) => setTimeout(r, 300))
    await writeFile(join(erin, 'w', 'x1.txt'), '1')
    await waitFor(() => events.some((e) => e.paths.some((p) => p.endsWith('x1.txt'))))
    expect(events[0]!.host).toBe('erin')
    // обрыв процесса
    const before = spawns
    await killAgent(d)
    await waitFor(() => events.some((e) => e.paths.length === 1 && e.paths[0] === ''))
    expect((await d.files.stat(join(erin, 'w'))).exists).toBe(true)
    expect(spawns).toBeGreaterThan(before)
    await new Promise((r) => setTimeout(r, 400))
    await writeFile(join(erin, 'w', 'x2.txt'), '2')
    await waitFor(() => events.some((e) => e.paths.some((p) => p.endsWith('x2.txt'))))
    stop()
  })

  it('transferAcross: каталог хаб → хост и обратно переносом, прогресс по байтам, конфликт', async () => {
    const mini = remote('mini', hub)
    const d = remote('erin', erin)
    await mkdir(join(hub, 'src', 'deep'), { recursive: true })
    await writeFile(join(hub, 'src', 'big.bin'), Buffer.alloc(3 * 1024 * 1024 + 17, 9))
    await writeFile(join(hub, 'src', 'deep', 'n.txt'), 'n')
    const seen: number[] = []
    const r = await transferAcross(mini, d, [{ from: join(hub, 'src'), to: join(erin, 'got') }], { onProgress: (p) => seen.push(p.done) })
    expect(r).toEqual({ done: 1, failed: [] })
    expect((await readFile(join(erin, 'got', 'big.bin'))).length).toBe(3 * 1024 * 1024 + 17)
    expect(await readFile(join(erin, 'got', 'deep', 'n.txt'), 'utf8')).toBe('n')
    expect(seen.at(-1)).toBe(3 * 1024 * 1024 + 18)
    expect(new Set(seen).size).toBeGreaterThan(3)
    const again = await transferAcross(mini, d, [{ from: join(hub, 'src'), to: join(erin, 'got') }])
    expect(again.failed[0]!.error).toMatch(/уже есть/)
    const back = await transferAcross(d, mini, [{ from: join(erin, 'got'), to: join(hub, 'back') }], { move: true })
    expect(back.done).toBe(1)
    expect(existsSync(join(erin, 'got'))).toBe(false)
    expect(existsSync(join(hub, 'back', 'deep', 'n.txt'))).toBe(true)
  })
})

async function waitFor(ok: () => boolean, ms = 4000): Promise<void> {
  const until = Date.now() + ms
  while (!ok()) {
    if (Date.now() > until) throw new Error('не дождались')
    await new Promise((r) => setTimeout(r, 30))
  }
}

/** Убить процесс агента изнутри (как обрыв ssh): exec на хосте шлёт себе SIGKILL. */
async function killAgent(h: RemoteHost): Promise<void> {
  await h.exec(process.execPath, ['-e', 'process.kill(process.ppid, "SIGKILL")']).catch(() => {})
}

describe('свой запуск агента (command)', () => {
  it('command + env вместо ssh: тот же агент', async () => {
    const h = createRemoteHost({ name: 'box', command: [process.execPath], env: { HOME: erin, USERPROFILE: erin } })
    hosts.push(h)
    expect((await h.connect()).home).toBe(erin)
    expect((await h.files.list(join(erin, 'w'))).map((e) => e.name)).toEqual(['sub', 'a.txt', 'pic.png'])
  })
})

describe('клиент: disk по проводу', () => {
  it('external.disk своего и чужого хоста', async () => {
    const { client } = await start([remote('erin', erin)])
    expect((await client.external!.disk!(hub)).total).toBeGreaterThan(0)
    expect((await client.external!.disk!(erin, { host: 'erin' })).free).toBeGreaterThanOrEqual(0)
  })
})

describe('установленный агент по HTTP (nr-mcp, ABC-433)', () => {
  it('url + bearer: те же операции и слежение; без токена — off с причиной; обрыв SSE — host_unavailable', async () => {
    const { createServer } = await import('node:http')
    const { createAgent } = await import('@kerneldreams/host-agent/embed')
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'nr-http-agent-')))
    await writeFile(join(dir, 'a.txt'), 'hello')
    const streams = new Set<import('node:http').ServerResponse>()
    const sessions = new Map<string, ReturnType<typeof createAgent>>()
    let n = 0
    // провод nr-mcp: GET /agent — SSE с hello+session, POST /agent/<session> — запрос
    const srv = createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer test-token-1') return void res.writeHead(401).end()
      if (req.method === 'GET' && req.url === '/agent') {
        const session = `s${++n}`
        const agent = createAgent({ emit: (m) => res.write(`data: ${JSON.stringify(m)}\n\n`) })
        sessions.set(session, agent)
        streams.add(res)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ ...agent.hello, session })}\n\n`)
        res.on('close', () => {
          streams.delete(res)
          sessions.delete(session)
          agent.close()
        })
        return
      }
      const m = /^\/agent\/(\w+)$/.exec(req.url ?? '')
      const agent = m ? sessions.get(m[1]!) : undefined
      if (!agent) return void res.writeHead(404).end()
      let body = ''
      req.on('data', (d) => (body += d))
      req.on('end', () => void agent.call(JSON.parse(body)).then((r) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(r))))
    })
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok))
    const url = `http://127.0.0.1:${(srv.address() as import('node:net').AddressInfo).port}`
    const host = createRemoteHost({ name: 'box', url, token: 'test-token-1' }, { retryMs: 50 })
    const bad = createRemoteHost({ name: 'nobox', url, token: 'wrong' }, { retryMs: 50 })
    try {
      const hello = await host.connect()
      expect(hello.version).toBe('0.2.0')
      expect(host.info().state).toBe('ok')
      const list = await host.files.list(dir)
      expect(list.map((e) => e.name)).toContain('a.txt')
      await host.files.write(join(dir, 'b.txt'), 'xyz')
      expect(await readFile(join(dir, 'b.txt'), 'utf8')).toBe('xyz')
      const events: string[][] = []
      const unsub = host.files.watch!(dir, (e: ExternalUpdateEvent) => events.push(e.paths), { recursive: false })
      await new Promise((r) => setTimeout(r, 300))
      await writeFile(join(dir, 'c.txt'), '1')
      await expect.poll(() => events.flat().some((p) => p.endsWith('c.txt')), { timeout: 3000 }).toBe(true)
      // обрыв потока со стороны машины: подписчику — [''], вызов поднимает связь заново
      for (const r of streams) r.end()
      await expect.poll(() => events.some((p) => p.length === 1 && p[0] === ''), { timeout: 3000 }).toBe(true)
      await new Promise((r) => setTimeout(r, 100))
      expect((await host.files.list(dir)).length).toBeGreaterThan(0)
      unsub()
      await expect(bad.connect()).rejects.toMatchObject({ code: 'host_unavailable' })
      expect(bad.info()).toMatchObject({ state: 'off', reason: expect.stringContaining('401') })
    } finally {
      host.close()
      bad.close()
      srv.closeAllConnections()
      srv.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
