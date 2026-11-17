/**
 * (pics-spec §10–§11): медиа с удалённого хоста с Range и MIME (WebKit без них не играет), диски
 * Windows-машины спросом у неё (`/` — «Этот компьютер»), путь `C:/…` руками, причины ssh словами, адрес ssh
 * источника реестра, когда своего алиаса нет.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import { bootstrapCode } from '@kerneldreams/host-agent'
import { createStoreBackend } from '../src/store-backend.js'
import { serveBackend, type ServeHandle } from '../src/serve.js'
import { createExternalHost, rawMime } from '../src/external.js'
import { createHostsRouter, createRemoteHost, hasLocalSshAlias, sshReason, sshTargetArgs, wirePath, type RemoteHost } from '../src/remote-host.js'

let hub: string
let box: string
let srv: ServeHandle | undefined
const hosts: RemoteHost[] = []

beforeEach(async () => {
  hub = await realpath(await mkdtemp(join(tmpdir(), 'nr-794-hub-')))
  box = await realpath(await mkdtemp(join(tmpdir(), 'nr-794-box-')))
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

async function serve(remotes: RemoteHost[]): Promise<string> {
  srv = await serveBackend(backend(), { external: createHostsRouter(createExternalHost({ home: hub, hostOpen: false, hostName: 'server' }), remotes) })
  return srv.url
}

const agentAt = (home: string) => (): ChildProcess => spawn(process.execPath, ['-e', bootstrapCode()], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ['pipe', 'pipe', 'pipe'] })

/** Агент «на Windows»: hello `win32`, `exec fsutil` — строка как на laptop (локаль русская), `list` — пишет, что просили. */
const FAKE_WIN = `
const rl = require('readline').createInterface({ input: process.stdin })
let first = true
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
rl.on('line', (l) => {
  if (first) { first = false; out({ event: 'hello', version: 't', os: 'win32', arch: 'x64', node: 'v22', home: '/D:/!Studio', realHome: '/D:/!Studio', caps: { thumb: null, video: false, rg: false, tar: false, git: false, watch: false } }); return }
  const q = JSON.parse(l)
  if (q.op === 'init') return out({ id: q.id, ok: true, result: {} })
  if (q.op === 'exec') return out({ id: q.id, ok: true, result: { code: 0, stdout: '\\r\\nДиски: C:\\\\ D:\\\\ E:\\\\ P:\\\\ S:\\\\ T:\\\\ V:\\\\ \\r\\n', stderr: '' } })
  if (q.op === 'list') return out({ id: q.id, ok: true, result: [{ name: 'asked', path: q.args.path, kind: 'file', size: 1, mtime: '2026-11-11T00:00:00Z' }] })
  out({ id: q.id, ok: false, error: 'нет', code: 'bad_request' })
})`

describe('медиа с удалённого хоста: Range и MIME', () => {
  it('mov / m4a / имя со скобками и пробелами: accept-ranges, 206 по Range, верный MIME, байты куска', async () => {
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 17)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
    await writeFile(join(box, 'clip.mov'), bytes)
    await writeFile(join(box, '(Backing Vocals).m4a'), bytes.subarray(0, 1000))
    const h = createRemoteHost({ name: 'mini', os: 'darwin' }, { spawn: agentAt(box) })
    hosts.push(h)
    const url = await serve([h])
    const raw = (p: string, init?: RequestInit) => fetch(`${url}/files/external/raw?path=${encodeURIComponent(join(box, p))}&host=mini`, init)

    const full = await raw('clip.mov')
    expect(full.status).toBe(200)
    expect(full.headers.get('content-type')).toBe('video/quicktime')
    expect(full.headers.get('accept-ranges')).toBe('bytes')
    expect(Number(full.headers.get('content-length'))).toBe(bytes.length)
    expect(Buffer.from(await full.arrayBuffer()).equals(bytes)).toBe(true)

    // WebKit сначала просит bytes=0-1, потом хвост (moov в конце mov)
    const head = await raw('clip.mov', { headers: { range: 'bytes=0-1' } })
    expect(head.status).toBe(206)
    expect(head.headers.get('content-range')).toBe(`bytes 0-1/${bytes.length}`)
    expect([...Buffer.from(await head.arrayBuffer())]).toEqual([0, 1])
    const from = 1024 * 1024 - 5
    const mid = await raw('clip.mov', { headers: { range: `bytes=${from}-${from + 2 * 1024 * 1024}` } })
    expect(mid.status).toBe(206)
    expect(Buffer.from(await mid.arrayBuffer()).equals(bytes.subarray(from, from + 2 * 1024 * 1024 + 1))).toBe(true)
    const tail = await raw('clip.mov', { headers: { range: 'bytes=-10' } })
    expect(Buffer.from(await tail.arrayBuffer()).equals(bytes.subarray(bytes.length - 10))).toBe(true)
    expect((await raw('clip.mov', { headers: { range: `bytes=${bytes.length}-` } })).status).toBe(416)

    const m4a = await raw('(Backing Vocals).m4a', { headers: { range: 'bytes=0-' } })
    expect(m4a.status).toBe(206)
    expect(m4a.headers.get('content-type')).toBe('audio/mp4')
    expect((await m4a.arrayBuffer()).byteLength).toBe(1000)
  })

  it('rawMime: медиа своей таблицей, остальное — протоколом; свой хост тоже отдаёт MIME медиа', async () => {
    expect(rawMime('/a/b.MOV')).toBe('video/quicktime')
    expect(rawMime('/a/b.webm')).toBe('video/webm')
    expect(rawMime('/a/b.mp3')).toBe('audio/mpeg')
    expect(rawMime('/a/b.wav')).toBe('audio/wav')
    expect(rawMime('/a/b.png')).toBe('image/png')
    await writeFile(join(hub, 's.mp4'), Buffer.alloc(100))
    const url = await serve([])
    const r = await fetch(`${url}/files/external/raw?path=${encodeURIComponent(join(hub, 's.mp4'))}`, { headers: { range: 'bytes=0-9' } })
    expect(r.status).toBe(206)
    expect(r.headers.get('content-type')).toBe('video/mp4')
  })
})

describe('диски Windows и путь руками', () => {
  it('list("/") у win32 — диски машины из fsutil; C:/… и C:\\… уходят агенту как /C:/…', async () => {
    const h = createRemoteHost({ name: 'laptop', os: 'win32' }, { spawn: () => spawn(process.execPath, ['-e', FAKE_WIN], { stdio: ['pipe', 'pipe', 'pipe'] }) })
    hosts.push(h)
    const drives = await h.files.list('/')
    expect(drives.map((d) => d.name)).toEqual(['C:', 'D:', 'E:', 'P:', 'S:', 'T:', 'V:'])
    expect(drives[0]).toMatchObject({ host: 'laptop', path: '/C:/', kind: 'dir' })
    expect((await h.files.list('F:/Studio'))[0]!.path).toBe('/F:/Studio')
    expect((await h.files.list('c:\\Users\\owner'))[0]!.path).toBe('/C:/Users/owner')
  })

  it('wirePath', () => {
    expect(wirePath('C:/x/y')).toBe('/C:/x/y')
    expect(wirePath('d:')).toBe('/D:/')
    expect(wirePath('E:\\a\\b')).toBe('/E:/a/b')
    expect(wirePath('/home/user')).toBe('/home/user')
    expect(wirePath('~/x')).toBe('~/x')
  })
})

describe('ssh: причина словами и адрес источника', () => {
  it('sshReason', () => {
    expect(sshReason('ssh: Could not resolve hostname pc: nodename nor servname provided, or not known', 'pc')).toBe('нет ssh-алиаса pc на этой машине')
    expect(sshReason('alice@1.2.3.4: Permission denied (publickey,password).', 'max')).toBe('ключ не принят (max)')
    expect(sshReason('ssh: connect to host 192.0.2.108 port 22: Operation timed out', 'pc')).toBe('не отвечает')
    expect(sshReason('что-то своё', 'pc')).toBeNull()
  })

  it('нет связи по ssh: reason в hostsInfo — словами', async () => {
    const h = createRemoteHost({ name: 'pc', os: 'win32' }, { spawn: () => spawn(process.execPath, ['-e', `process.stderr.write('ssh: Could not resolve hostname pc: Name or service not known\\n'); process.exit(255)`], { stdio: ['pipe', 'pipe', 'pipe'] }) })
    hosts.push(h)
    await expect(h.files.stat('~')).rejects.toThrow(/нет ssh-алиаса pc на этой машине/)
    expect(h.info()).toMatchObject({ state: 'off', reason: 'нет ssh-алиаса pc на этой машине' })
  })

  it('sshTargetArgs: своего алиаса нет — HostName/User/Port источника; есть — ничего', () => {
    expect(sshTargetArgs('pc', { host: '192.0.2.108', user: 'owner', port: 2222 }, () => false)).toEqual(['-o', 'HostName=192.0.2.108', '-o', 'User=owner', '-o', 'Port=2222'])
    expect(sshTargetArgs('pc', { host: '192.0.2.108' }, () => true)).toEqual([])
    expect(sshTargetArgs('pc', undefined, () => false)).toEqual([])
  })

  it('hasLocalSshAlias: ssh -G без алиаса отдаёт hostname = имя', () => {
    expect(hasLocalSshAlias('t794-none', () => 'user alice\nhostname t794-none\nport 22\n')).toBe(false)
    expect(hasLocalSshAlias('t794-pc', () => 'user alice\nhostname 192.0.2.108\n')).toBe(true)
    expect(hasLocalSshAlias('t794-err', () => null)).toBe(false)
  })
})
