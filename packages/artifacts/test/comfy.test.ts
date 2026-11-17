import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePng } from '@kerneldreams/comfy-client'
import type { ComfyConnection, ComfyEvent, ComfyJob } from '@kerneldreams/comfy-client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ComfyBridge } from '../src/comfy.js'
import type { ComfyWireEvent } from '../src/comfy.js'
import { createArtifactHost } from '../src/host.js'
import type { ArtifactHost } from '../src/host.js'
import { checkAccess, checkArtifact, parseManifest } from '../src/index.js'

const PNG = readFileSync(new URL('./fixtures/comfy-meta.png', import.meta.url))
const manifest = (text: string) => {
  const r = parseManifest(text)
  if (!r.ok) throw new Error(r.error)
  return r.value
}
const env = { artifactDir: '/ws/.nr/artifacts/a', dataDir: '/data/a', workspace: '/ws', selected: new Set<string>() }

describe('права comfy', () => {
  it('без $uses: comfy — отказ; с ним — можно', () => {
    expect(checkAccess(manifest('$title: A\n$uses: $[file]\n'), 'comfy.queue', [{}], env)).toEqual({ ok: false, error: 'capability not declared: comfy' })
    expect(checkAccess(manifest('$title: A\n$uses: $[comfy]\n'), 'comfy.queue', [{}], env)).toEqual({ ok: true })
    expect(checkAccess(manifest('$title: A\n$uses: $[comfy]\n'), 'comfy.events', [], env)).toEqual({ ok: true })
  })

  it('comfy.save: относительный путь — от рабочей области; {workspace} разрешён сверх $fs-write', () => {
    const m = manifest('$title: A\n$uses: $[comfy]\n')
    expect(checkAccess(m, 'comfy.save', [{}, null, 'out/x.png'], env)).toEqual({ ok: true, path: '/ws/out/x.png' })
    expect(checkAccess(m, 'comfy.save', [{}, null, '/etc/x.png'], env)).toMatchObject({ ok: false, error: expect.stringMatching(/fs-write/) })
    expect(checkAccess(m, 'comfy.save', [{}, null, ''], env)).toMatchObject({ ok: false })
    // $fs-write расширяет, {workspace} остаётся
    const wide = manifest('$title: A\n$uses: $[comfy]\n$fs-write: {artifact}, /tmp/comfy-out\n')
    expect(checkAccess(wide, 'comfy.save', [{}, null, '/tmp/comfy-out/1.png'], env)).toMatchObject({ ok: true })
    expect(checkAccess(wide, 'comfy.save', [{}, null, 'a.png'], env)).toMatchObject({ ok: true, path: '/ws/a.png' })
  })

  it('статическая проверка: __host.viewer.open требует $uses: viewer (ABC-155)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'artifacts-viewer-check-'))
    try {
      writeFileSync(join(tmp, 'index.html'), '<!doctype html><script src="app.js"></script>')
      writeFileSync(join(tmp, 'app.js'), '__host.viewer.open([url], 0)\n__host.viewer.show(url)\n')
      const without = checkArtifact(tmp, manifest('$title: A\n$uses: $[comfy]\n'))
      expect(without.errors.join('\n')).toMatch(/__host\.viewer\.open требует право "viewer"/)
      expect(without.errors.join('\n')).toMatch(/__host\.viewer\.show не существует/)
      expect(checkArtifact(tmp, manifest('$title: A\n$uses: $[viewer]\n')).used).toContain('viewer')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('статическая проверка: __host.comfy.* требует $uses: comfy, выдумки — ошибка', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'artifacts-comfy-check-'))
    try {
      writeFileSync(join(tmp, 'index.html'), '<script src="./app.js"></script>')
      writeFileSync(join(tmp, 'app.js'), 'await __host.comfy.queue(p, { onEvent })\n__host.comfy.view(img)\n__host.comfy.generate(p)\n')
      const without = checkArtifact(tmp, manifest('$title: A\n$uses: $[file]\n'))
      expect(without.errors.join('\n')).toMatch(/__host\.comfy\.queue требует право "comfy"/)
      expect(without.errors.join('\n')).toMatch(/__host\.comfy\.generate не существует/)
      const withIt = checkArtifact(tmp, manifest('$title: A\n$uses: $[comfy]\n'))
      expect(withIt.errors.filter((e) => /требует/.test(e))).toEqual([])
      expect(withIt.used).toContain('comfy')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

// ── хост против фейкового ComfyUI (HTTP) ────────────────────────────────────

describe('хост: comfy через фейковый сервер', () => {
  let comfySrv: Server
  let comfyAddr = ''
  const uploads: string[] = []
  let tmp: string
  let host: ArtifactHost

  beforeAll(async () => {
    comfySrv = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      if (url.pathname === '/view') {
        res.setHeader('content-type', 'image/png')
        return res.end(PNG)
      }
      if (url.pathname === '/object_info') {
        res.setHeader('content-type', 'application/json')
        return res.end(JSON.stringify({ KSampler: { input: { required: { seed: ['INT', { control_after_generate: true, min: 0 }], steps: ['INT', { min: 1, max: 100 }] } } } }))
      }
      if (url.pathname === '/upload/image') {
        let body = ''
        req.on('data', (c: Buffer) => (body += c.toString('latin1')))
        req.on('end', () => {
          uploads.push(body)
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ name: 'ref (1).png', subfolder: '', type: 'input' }))
        })
        return
      }
      res.statusCode = 404
      res.end()
    })
    await new Promise<void>((r) => comfySrv.listen(0, '127.0.0.1', r))
    comfyAddr = `127.0.0.1:${(comfySrv.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((r) => comfySrv.close(() => r())))

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'artifacts-comfy-'))
    mkdirSync(join(tmp, 'ws'), { recursive: true })
    host = createArtifactHost({ root: join(tmp, 'ws'), dataRoot: join(tmp, 'data'), configFile: join(tmp, 'none.md'), comfy: comfyAddr, warn: () => {} })
  })
  afterEach(async () => {
    await host.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  function artifact(name: string, uses: string): string {
    const dir = join(tmp, 'ws', '.nr', 'artifacts', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'meta.mdz'), `$title: ${name}\n$uses: ${uses}\n`)
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head></head><body></body></html>')
    return dir
  }

  it('parse / inputs / upload / view / save', async () => {
    artifact('gen', '$[comfy, file]')
    const o = await host.open('ws/gen')
    const parsed = (await host.bridge(o.key, 'comfy.parse', [{ __b64: PNG.toString('base64') }])) as { ok: true; value: { prompt: Record<string, { class_type: string }> } }
    expect(parsed.ok).toBe(true)
    expect(parsed.value.prompt['8']?.class_type).toBe('KSampler')

    const inputs = (await host.bridge(o.key, 'comfy.inputs', [parsed.value.prompt])) as { ok: true; value: Array<{ nodeId: string; name: string; type: string; seed?: boolean }> }
    expect(inputs.value.find((i) => i.nodeId === '8' && i.name === 'seed')).toMatchObject({ type: 'INT', seed: true })
    // текст промпта: CLIPTextEncode нет в фейковой схеме — тип по значению
    expect(inputs.value.find((i) => i.nodeId === '5' && i.name === 'text')).toMatchObject({ type: 'STRING' })

    const up = (await host.bridge(o.key, 'comfy.upload', [new Uint8Array([1, 2, 3]), '../../evil/ref.png'])) as { ok: true; value: { value: string } }
    expect(up.value.value).toBe('ref (1).png')
    expect(uploads.at(-1)).toMatch(/filename="ref\.png"/)

    const img = { filename: 'q_00001_.png', subfolder: '', type: 'output' }
    const view = (await host.bridge(o.key, 'comfy.view', [img])) as { ok: true; value: string }
    expect(view.value).toBe(`/c/${o.key}/view?filename=q_00001_.png&subfolder=&type=output`)
    const got = await fetch(`${await host.origin}${view.value}`)
    expect(got.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await got.arrayBuffer()).equals(PNG)).toBe(true)
    // и через маршрут бэкенда (удалённый клиент)
    const [path, query] = view.value.split('?')
    const viaBackend = await host.http({ path: path!, query: `?${query}` })
    expect(viaBackend.status).toBe(200)

    const workflow = { nodes: [{ id: 1 }] }
    const saved = (await host.bridge(o.key, 'comfy.save', [img, { workflow }, 'gen/out.png'])) as { ok: true; value: { path: string } }
    expect(saved.value.path).toBe(join(tmp, 'ws', 'gen', 'out.png'))
    const meta = parsePng(readFileSync(saved.value.path))
    expect(meta.workflow).toEqual(workflow)
    expect(meta.prompt?.['8']?.class_type).toBe('KSampler') // prompt сервера не затёрт
    // сохранённое гостю читается (право file)
    expect((await host.bridge(o.key, 'readFileBinary', [saved.value.path])).ok).toBe(true)

    const escape = await host.bridge(o.key, 'comfy.save', [img, null, '/etc/passwd.png'])
    expect(escape).toMatchObject({ ok: false })
  })

  it('без права comfy — отказ и в мосте, и в HTTP', async () => {
    artifact('plain', '$[file]')
    const o = await host.open('ws/plain')
    expect(await host.bridge(o.key, 'comfy.inputs', [{}])).toEqual({ ok: false, error: 'capability not declared: comfy' })
    expect((await fetch(`${await host.origin}/c/${o.key}/view?filename=a.png`)).status).toBe(403)
    const ctrl = new AbortController()
    expect(host.comfyEvents(o.key, ctrl.signal, () => {})).toMatchObject({ ok: false })
  })

  it('адрес не задан — понятная ошибка', async () => {
    const bare = createArtifactHost({ root: join(tmp, 'ws'), dataRoot: join(tmp, 'data2'), configFile: join(tmp, 'none.md'), comfy: null, warn: () => {} })
    const prev = process.env.NR_COMFY
    try {
      artifact('gen2', '$[comfy]')
      const o = await bare.open('ws/gen2')
      const r = await bare.bridge(o.key, 'comfy.objectInfo', [])
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/\$comfy/) })
      const ctx = (await bare.bridge(o.key, 'getContext', [])) as { ok: true; value: { comfy: boolean } }
      expect(ctx.value.comfy).toBe(process.env.NR_COMFY ? true : false)
    } finally {
      process.env.NR_COMFY = prev
      await bare.close()
    }
  })
})

// ── очередь: фейковое соединение ──────────────────────────────────────────────

function fakeConnection(): { conn: ComfyConnection; push: (e: ComfyEvent) => void; end: () => void; cancelled: string[] } {
  let push: (e: ComfyEvent) => void = () => {}
  let end: () => void = () => {}
  const cancelled: string[] = []
  const conn: ComfyConnection = {
    server: 'fake',
    clientId: 'c',
    closed: false,
    on: () => () => {},
    close: () => {},
    async queue() {
      const buffer: ComfyEvent[] = []
      let wake: (() => void) | null = null
      let finished = false
      let resolveDone!: (r: Awaited<ComfyJob['done']>) => void
      const done = new Promise<Awaited<ComfyJob['done']>>((r) => (resolveDone = r))
      push = (e) => {
        buffer.push(e)
        wake?.()
      }
      end = () => {
        finished = true
        resolveDone({ status: 'success', images: [] })
        wake?.()
      }
      return {
        promptId: 'job-1',
        number: 3,
        done,
        cancel: async () => {
          cancelled.push('job-1')
          return 'interrupted' as const
        },
        async *[Symbol.asyncIterator]() {
          for (;;) {
            while (buffer.length) yield buffer.shift()!
            if (finished) return
            await new Promise<void>((r) => (wake = r))
          }
        },
      }
    },
  }
  return { conn, push: (e) => push(e), end: () => end(), cancelled }
}

describe('ComfyBridge: queue → канал артефакта', () => {
  it('события до подписки — из backlog; превью — путь, байты — в памяти; итог с картинками', async () => {
    const f = fakeConnection()
    const bridge = new ComfyBridge('fake', () => {}, async () => f.conn)
    const q = await bridge.queue('K', { a: { class_type: 'X', inputs: {} } }, null)
    expect(q).toEqual({ id: 'job-1', number: 3 })
    f.push({ kind: 'execution_start', promptId: 'job-1' })
    f.push({ kind: 'progress', promptId: 'job-1', node: '8', value: 1, max: 4 })
    f.push({ kind: 'preview', promptId: 'job-1', mime: 'image/jpeg', bytes: new Uint8Array([1]) })
    f.push({ kind: 'preview', promptId: 'job-1', mime: 'image/jpeg', bytes: new Uint8Array([2]), node: '8' })
    await new Promise((r) => setTimeout(r, 10))
    const got: ComfyWireEvent[] = []
    const off = bridge.subscribe('K', (e) => got.push(e))
    // backlog: одно (последнее) превью
    expect(got.map((e) => e.kind)).toEqual(['execution_start', 'progress', 'preview'])
    expect(got[2]).toMatchObject({ kind: 'preview', seq: 2, path: '/c/K/p/job-1?seq=2', node: '8' })
    expect(bridge.preview('K', 'job-1')?.bytes).toEqual(new Uint8Array([2]))
    expect(bridge.preview('other', 'job-1')).toBeNull()

    const img = { filename: 'o.png', subfolder: '', type: 'output' }
    f.push({ kind: 'executed', promptId: 'job-1', node: '10', output: { images: [img] }, images: [img] })
    f.push({ kind: 'execution_success', promptId: 'job-1' })
    f.end()
    await new Promise((r) => setTimeout(r, 10))
    expect(got.at(-2)).toMatchObject({ kind: 'executed', images: [{ ...img, path: '/c/K/view?filename=o.png&subfolder=&type=output' }] })
    expect(got.at(-1)).toMatchObject({ kind: 'execution_success', images: [{ filename: 'o.png' }] })

    expect(await bridge.interrupt('K', 'job-1')).toBe('none') // уже закончен
    await expect(bridge.interrupt('other', 'job-1')).rejects.toThrow(/чужой/)
    off()
    bridge.close()
  })

  it('interrupt идущего job — через его cancel', async () => {
    const f = fakeConnection()
    const bridge = new ComfyBridge('fake', () => {}, async () => f.conn)
    await bridge.queue('K', { a: { class_type: 'X', inputs: {} } }, null)
    expect(await bridge.interrupt('K', 'job-1')).toBe('interrupted')
    expect(f.cancelled).toEqual(['job-1'])
    f.end()
    bridge.close()
  })

  it('обрыв итератора — execution_error в канал', async () => {
    const conn: ComfyConnection = {
      server: 'fake',
      clientId: 'c',
      closed: false,
      on: () => () => {},
      close: () => {},
      async queue() {
        return {
          promptId: 'j2',
          number: 1,
          done: Promise.resolve({ status: 'error' as const, images: [] }),
          cancel: async () => 'none' as const,
          async *[Symbol.asyncIterator]() {
            yield { kind: 'execution_start', promptId: 'j2' } as ComfyEvent
            throw new Error('comfy: websocket закрыт до конца prompt')
          },
        }
      },
    }
    const bridge = new ComfyBridge('fake', () => {}, async () => conn)
    const got: ComfyWireEvent[] = []
    bridge.subscribe('K', (e) => got.push(e))
    await bridge.queue('K', {}, null)
    await new Promise((r) => setTimeout(r, 10))
    expect(got.map((e) => e.kind)).toEqual(['execution_start', 'execution_error'])
    expect(got[1]).toMatchObject({ message: expect.stringMatching(/websocket/) })
    bridge.close()
  })
})
