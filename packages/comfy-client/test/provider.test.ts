// comfyImageProvider (image-gen-2-spec §4): шаблоны-фикстуры qwen21-edit / anima-t2i,
// фейковый HTTP ComfyUI + управляемый WebSocket — события → onProgress, превью байтами.
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ImageProgress } from '@kerneldreams/nrd/contracts'
import { comfyImageProvider, embedWorkflow } from '../src/index.js'
import type { Prompt } from '../src/index.js'

const fixture = (name: string): string => new URL(`./fixtures/${name}`, import.meta.url).pathname
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

class FakeWS extends EventTarget {
  static last: FakeWS | null = null
  binaryType = 'blob'
  constructor(readonly url: string) {
    super()
    FakeWS.last = this
    setTimeout(() => this.dispatchEvent(new Event('open')), 0)
  }
  send(): void {}
  close(): void {
    this.dispatchEvent(new Event('close'))
  }
  emit(type: string, data: Record<string, unknown>): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type, data }) }))
  }
  emitBinary(bytes: Uint8Array): void {
    this.dispatchEvent(new MessageEvent('message', { data: bytes.buffer }))
  }
}

/** Что сервер делает после /prompt: сценарий событий по id. */
let script: (ws: FakeWS, id: string) => void
let server: Server
let addr = ''
let dir = ''
const uploads: string[] = []
let queued: Prompt | null = null
let interrupts = 0
let running: string[] = []

const PREVIEW = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 0xff, 0xd8, 0xff, 0xe0])

const happy = (ws: FakeWS, id: string): void => {
  ws.emit('execution_start', { prompt_id: id })
  ws.emit('executing', { node: 'sampler', prompt_id: id })
  ws.emit('progress', { node: 'sampler', value: 1, max: 2, prompt_id: id })
  ws.emitBinary(PREVIEW)
  ws.emit('progress', { node: 'sampler', value: 2, max: 2, prompt_id: id })
  ws.emit('executed', { node: 'pv', output: { images: [{ filename: 'p.png', subfolder: '', type: 'temp' }] }, prompt_id: id })
  ws.emit('executed', { node: 'save', output: { images: [{ filename: 'out_1.png', subfolder: '', type: 'output' }] }, prompt_id: id })
  ws.emit('execution_success', { prompt_id: id })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'comfy-prov-'))
  copyFileSync(fixture('qwen21-edit.json'), join(dir, 'qwen21-edit.json'))
  copyFileSync(fixture('anima-t2i.json'), join(dir, 'anima-t2i.json'))
  copyFileSync(fixture('sd-inpaint.json'), join(dir, 'sd-inpaint.json'))
  writeFileSync(join(dir, 'notes.json'), '{"hello": 1}')
  // Профиль шаблона с шапкой: имя модели в каталоге — из неё.
  writeFileSync(join(dir, 'qwen21-edit.md'), '// qwen21-edit — Qwen-Image 2.1 Edit: промпт + до 10 рефов (ref1 — главный слот).\n$workflow: qwen21-edit.json\n')
  // Шапка чужого id — не имя.
  writeFileSync(join(dir, 'anima-t2i.md'), '// other — Something\n')
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const url = req.url ?? ''
      res.setHeader('content-type', 'application/json')
      if (url === '/object_info') {
        const a = JSON.parse(readFileSync(fixture('object_info.json'), 'utf8'))
        const b = JSON.parse(readFileSync(fixture('object_info-extra.json'), 'utf8'))
        return res.end(JSON.stringify({ ...a, ...b }))
      }
      if (url === '/upload/image') {
        const name = /filename="([^"]+)"/.exec(body.toString('latin1'))?.[1] ?? 'x.png'
        uploads.push(name)
        return res.end(JSON.stringify({ name, subfolder: '', type: 'input' }))
      }
      if (url === '/prompt') {
        const j = JSON.parse(body.toString('utf8')) as { prompt: Prompt; prompt_id: string }
        queued = j.prompt
        running = [j.prompt_id]
        res.end(JSON.stringify({ prompt_id: j.prompt_id, number: 1, node_errors: {} }))
        setTimeout(() => script(FakeWS.last!, j.prompt_id), 5)
        return
      }
      if (url === '/queue') return res.end(JSON.stringify({ queue_running: running.map((id) => [0, id, {}]), queue_pending: [] }))
      if (url === '/interrupt') {
        interrupts++
        setTimeout(() => FakeWS.last!.emit('execution_interrupted', { prompt_id: running[0] }), 5)
        return res.end('{}')
      }
      if (url.startsWith('/view')) {
        res.setHeader('content-type', 'image/png')
        return res.end(PNG)
      }
      res.statusCode = 404
      res.end('{}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  addr = `127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  return new Promise<void>((r) => server.close(() => r()))
})
beforeEach(() => {
  script = happy
  uploads.length = 0
  queued = null
  interrupts = 0
})

const provider = () => comfyImageProvider({ server: addr, templatesDir: dir, WebSocket: FakeWS as never })

describe('comfyImageProvider — модели и схема', () => {
  it('models(): шаблоны каталога, edit/maxRefs по ref-слотам; не-шаблон пропущен', async () => {
    const r = await provider().models!()
    expect(r.ok && r.value).toEqual([
      { id: 'anima-t2i', edit: false },
      { id: 'qwen21-edit', name: 'Qwen-Image 2.1 Edit', edit: true, maxRefs: 10 },
      { id: 'sd-inpaint', edit: true, maxRefs: 1, mask: true },
    ])
  })

  it('schema = роли: prompt/negative/width/height/seed/steps, без denoise у t2i', async () => {
    const r = await provider().schema!('qwen21-edit')
    expect(r.ok).toBe(true)
    if (!r.ok || !r.value) return
    expect(Object.keys(r.value.fields).sort()).toEqual(['height', 'negative', 'prompt', 'seed', 'steps', 'width'])
    expect(r.value.maxRefs).toBe(10)
  })

  it('PNG со вшитым графом — тоже шаблон', async () => {
    const graph = JSON.parse(readFileSync(fixture('anima-t2i.json'), 'utf8'))
    writeFileSync(join(dir, 'from-png.png'), embedWorkflow(PNG, { prompt: graph }))
    try {
      const r = await provider().schema!('from-png')
      expect(r.ok && r.value?.fields.prompt).toEqual({ type: 'string' })
    } finally {
      rmSync(join(dir, 'from-png.png'))
    }
  })
})

describe('comfyImageProvider — generate', () => {
  it('роли проставлены, реф загружен в ref1, пустые слоты вырезаны; onProgress: queued → нода/шаги/превью → downloading → done', async () => {
    const events: ImageProgress[] = []
    const r = await provider().generate({
      model: 'qwen21-edit',
      prompt: 'a red fox',
      refs: [new Uint8Array(PNG)],
      params: { seed: 42, steps: '6', width: 832, height: 1216 },
      onProgress: (e) => events.push(e),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.images).toHaveLength(1)
    expect(r.value.mime).toBe('image/png')
    expect(r.value.meta).toMatchObject({ model: 'qwen21-edit', seed: 42 })
    expect(typeof r.value.meta.id).toBe('string')

    expect(uploads).toHaveLength(1)
    const p = queued!
    expect(p.ref1!.inputs.image).toBe(uploads[0])
    expect(p.ref2).toBeUndefined()
    expect(p.encoder!.inputs.prompt).toBe('a red fox')
    expect(p.sampler!.inputs).toMatchObject({ seed: 42, steps: 6 })
    expect(p.image!.inputs).toMatchObject({ width: 832, height: 1216 })

    expect(events[0]).toEqual({ stage: 'queued' })
    const running = events.filter((e) => e.stage === 'running')
    expect(running.some((e) => e.step === 2 && e.total === 2 && e.status)).toBe(true)
    const preview = running.find((e) => e.preview)
    expect(preview?.preview).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))
    expect(events.slice(-2)).toEqual([{ stage: 'downloading' }, { stage: 'done' }])
  })

  it('seed -1 или нет — случайный ≥ 0, реальный в meta', async () => {
    const r = await provider().generate({ model: 'anima-t2i', prompt: 'x', params: { seed: -1 } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.meta.seed).toBeGreaterThanOrEqual(0)
    expect(Object.values(queued!).some((n) => n.inputs.seed === r.value.meta.seed || n.inputs.noise_seed === r.value.meta.seed)).toBe(true)
  })

  it('лишний ключ — err со списком полей; рефы у t2i — err; шаблона нет — err', async () => {
    const a = await provider().generate({ model: 'qwen21-edit', prompt: 'x', params: { cfg: 4 } })
    expect(!a.ok && a.error.message).toMatch(/"cfg" — нет у шаблона; поля: prompt, negative, width, height, seed, steps/)
    const b = await provider().generate({ model: 'anima-t2i', prompt: 'x', refs: [new Uint8Array(PNG)] })
    expect(!b.ok && b.error.message).toMatch(/не принимает референсы/)
    const c = await provider().generate({ model: 'nope', prompt: 'x' })
    expect(!c.ok && c.error.message).toMatch(/шаблона nope нет/)
    expect(queued).toBeNull()
  })

  it('инпейнт (ABC-313): маска — в LoadImage «mask», картинка — в ref1, denoise и ckpt; без маски — err', async () => {
    const sch = await provider().schema!('sd-inpaint')
    expect(sch.ok && sch.value?.mask).toBe(true)
    expect(sch.ok && Object.keys(sch.value!.fields).sort()).toEqual(['ckpt', 'denoise', 'negative', 'prompt', 'seed', 'steps'])
    const r = await provider().generate({
      model: 'sd-inpaint',
      prompt: 'closed eyes',
      refs: [new Uint8Array(PNG)],
      mask: new Uint8Array(PNG),
      params: { denoise: 0.4, seed: 7, ckpt: 'other.safetensors' },
    })
    expect(r.ok).toBe(true)
    expect(uploads).toHaveLength(2)
    expect(uploads[1]).toMatch(/^nrmask-/)
    const p = queued!
    expect(p['1']!.inputs.image).toBe(uploads[0])
    expect(p['2']!.inputs.image).toBe(uploads[1])
    expect(p['13']!.inputs).toMatchObject({ denoise: 0.4, seed: 7 })
    expect(p['8']!.inputs.ckpt_name).toBe('other.safetensors')
    const noMask = await provider().generate({ model: 'sd-inpaint', prompt: 'x', refs: [new Uint8Array(PNG)] })
    expect(!noMask.ok && noMask.error.message).toMatch(/нужна маска/)
    const wrong = await provider().generate({ model: 'anima-t2i', prompt: 'x', mask: new Uint8Array(PNG) })
    expect(!wrong.ok && wrong.error.message).toMatch(/не принимает маску/)
  })

  it('ошибка исполнения — ImageError с нодой', async () => {
    script = (ws, id) => ws.emit('execution_error', { prompt_id: id, node_id: 'sampler', node_type: 'KSampler', exception_message: 'OOM' })
    const r = await provider().generate({ model: 'anima-t2i', prompt: 'x' })
    expect(!r.ok && r.error.message).toMatch(/KSampler \[sampler\]: OOM/)
  })

  it('signal → interrupt, AbortError', async () => {
    script = (ws, id) => ws.emit('execution_start', { prompt_id: id })
    const ac = new AbortController()
    const p = provider().generate({ model: 'anima-t2i', prompt: 'x', signal: ac.signal, onProgress: (e) => e.stage === 'queued' && setTimeout(() => ac.abort(), 10) })
    const r = await p
    expect(!r.ok && r.error.name).toBe('AbortError')
    expect(interrupts).toBe(1)
  })
})
