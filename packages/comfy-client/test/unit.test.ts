import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  asciiJson,
  baseUrl,
  collectOutputFiles,
  connect,
  editableInputs,
  embedWorkflow,
  imageInputValue,
  parseBinary,
  parseMessage,
  parsePng,
  readText,
  setInputs,
  wsUrl,
} from '../src/index.js'
import type { ComfyEvent, ObjectInfo, Prompt } from '../src/index.js'

const fixture = (name: string): Buffer => readFileSync(new URL(`./fixtures/${name}`, import.meta.url))
const info = JSON.parse(fixture('object_info.json').toString('utf8')) as ObjectInfo
const qwen = JSON.parse(fixture('qwen21-t2i.json').toString('utf8')) as Prompt

describe('адреса', () => {
  it('host:port и полный URL', () => {
    expect(baseUrl('10.0.0.5:8188')).toBe('http://10.0.0.5:8188')
    expect(baseUrl('https://comfy.example/base/')).toBe('https://comfy.example/base')
    expect(wsUrl('http://10.0.0.5:8188', 'c1')).toBe('ws://10.0.0.5:8188/ws?clientId=c1')
    expect(wsUrl('https://h', 'c 1')).toBe('wss://h/ws?clientId=c%201')
    expect(() => baseUrl('')).toThrow(/адрес/)
  })
  it('значение LoadImage для загруженного', () => {
    expect(imageInputValue({ filename: 'a.png', subfolder: '', type: 'input' })).toBe('a.png')
    expect(imageInputValue({ filename: 'a.png', subfolder: 'art', type: 'input' })).toBe('art/a.png')
  })
})

describe('parsePng', () => {
  it('prompt из tEXt SaveImage (срез zimage_takeshi_b1_00001_.png)', () => {
    const meta = parsePng(fixture('zimage-meta.png'))
    expect(meta.prompt?.['8']?.class_type).toBe('KSampler')
    expect(meta.prompt?.['8']?.inputs.seed).toBe(555111)
    expect(String(meta.prompt?.['5']?.inputs.text)).toMatch(/^Photorealistic portrait of Takeshi/)
    expect(meta.workflow).toBeUndefined()
  })

  // Оригинал из appz/comfy (1.2 МБ, в репу не кладём): COMFY_SAMPLE_PNG=<путь> npm test.
  it.skipIf(!process.env.COMFY_SAMPLE_PNG)('prompt из полноразмерного PNG (COMFY_SAMPLE_PNG)', () => {
    const meta = parsePng(readFileSync(process.env.COMFY_SAMPLE_PNG!))
    expect(Object.values(meta.prompt ?? {}).some((n) => n.class_type === 'KSampler')).toBe(true)
  })

  it('не PNG — ошибка', () => {
    expect(() => parsePng(Buffer.from('GIF89a......'))).toThrow(/PNG/)
  })

  it('embedWorkflow: замена метаданных, кириллица через ASCII, round-trip', () => {
    const png = fixture('zimage-meta.png')
    const prompt: Prompt = { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'рыжая кошка', clip: ['2', 0] } } }
    const workflow = { nodes: [{ id: 1, type: 'CLIPTextEncode' }], version: 0.4 }
    const out = embedWorkflow(png, { prompt, workflow })
    const meta = parsePng(out)
    expect(meta.prompt).toEqual(prompt)
    expect(meta.workflow).toEqual(workflow)
    // старый prompt ушёл, остался ровно один
    expect(Object.keys(readText(out)).sort()).toEqual(['prompt', 'workflow'])
    expect(asciiJson({ t: 'ё' })).toBe('{"t":"\\u0451"}')
    // картинка цела: чанки после мета те же
    expect(Buffer.from(out).includes(Buffer.from('IDAT'))).toBe(true)
  })

  it('embedWorkflow без workflow — только prompt', () => {
    const out = embedWorkflow(fixture('zimage-meta.png'), { prompt: { a: { class_type: 'X', inputs: {} } } })
    expect(Object.keys(readText(out))).toEqual(['prompt'])
  })
})

describe('editableInputs', () => {
  const list = editableInputs(qwen, info)
  const find = (node: string, name: string) => list.find((i) => i.nodeId === node && i.name === name)

  it('qwen21-t2i: текст промпта, seed, steps', () => {
    expect(find('encoder', 'prompt')).toMatchObject({ type: 'STRING', multiline: true, nodeTitle: 'Encoder', classType: 'TextEncodeQwenImage21', value: '' })
    expect(find('sampler', 'seed')).toMatchObject({ type: 'INT', seed: true, value: 0, min: 0 })
    expect(find('sampler', 'steps')).toMatchObject({ type: 'INT', value: 25, min: 1, max: 10000 })
    expect(find('sampler', 'cfg')).toMatchObject({ type: 'FLOAT', step: 0.1 })
    expect(find('sampler', 'sampler_name')).toMatchObject({ type: 'COMBO', value: 'euler' })
    expect(find('sampler', 'sampler_name')?.options).toContain('euler')
    expect(find('image', 'width')).toMatchObject({ type: 'INT', value: 1024, step: 8 })
    expect(find('save', 'filename_prefix')).toMatchObject({ type: 'STRING', value: 'qwen21' })
    expect(find('clip', 'device')).toMatchObject({ type: 'COMBO', optional: true })
  })

  it('ссылки на ноды — не входы; порядок — input_order схемы', () => {
    expect(list.some((i) => ['model', 'positive', 'negative', 'latent_image', 'clip', 'vae', 'samples', 'images'].includes(i.name))).toBe(false)
    const sampler = list.filter((i) => i.nodeId === 'sampler').map((i) => i.name)
    expect(sampler).toEqual(['seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'])
  })

  it('LoadImage.image → IMAGE с файлами input/', () => {
    const p: Prompt = { l: { class_type: 'LoadImage', inputs: { image: 'ref.jpg' } } }
    expect(editableInputs(p, info)).toEqual([
      expect.objectContaining({ nodeId: 'l', name: 'image', type: 'IMAGE', value: 'ref.jpg', options: ['example.png', 'ref.jpg'], nodeTitle: 'Load Image' }),
    ])
    // без схемы — тоже IMAGE
    expect(editableInputs(p, null)[0]).toMatchObject({ type: 'IMAGE', inferred: true })
  })

  it('незнакомая нода — тип по значению', () => {
    const p: Prompt = { x: { class_type: 'Custom', inputs: { a: 'txt', n: 3, f: 0.5, b: true, link: ['y', 0], o: { k: 1 } } } }
    expect(editableInputs(p, info).map((i) => [i.name, i.type])).toEqual([
      ['a', 'STRING'],
      ['n', 'INT'],
      ['f', 'FLOAT'],
      ['b', 'BOOLEAN'],
    ])
  })

  it('COMBO формы V3 ["COMBO", {options}]', () => {
    const v3: ObjectInfo = { N: { input: { required: { mode: ['COMBO', { options: ['a', 'b'], default: 'a' }] } } } }
    expect(editableInputs({ n: { class_type: 'N', inputs: { mode: 'b' } } }, v3)[0]).toMatchObject({ type: 'COMBO', options: ['a', 'b'], default: 'a' })
  })

  it('setInputs — копия с новыми значениями', () => {
    const next = setInputs(qwen, [
      { nodeId: 'encoder', name: 'prompt', value: 'a cat' },
      { nodeId: 'sampler', name: 'seed', value: 42 },
    ])
    expect(next.encoder?.inputs.prompt).toBe('a cat')
    expect(next.sampler?.inputs.seed).toBe(42)
    expect(qwen.encoder?.inputs.prompt).toBe('')
    expect(() => setInputs(qwen, [{ nodeId: 'nope', name: 'x', value: 1 }])).toThrow(/нет ноды/)
  })
})

describe('события', () => {
  it('текстовые сообщения', () => {
    expect(parseMessage({ type: 'status', data: { status: { exec_info: { queue_remaining: 2 } }, sid: 's' } })).toEqual({ kind: 'status', queueRemaining: 2, sid: 's' })
    expect(parseMessage({ type: 'executing', data: { node: 'sampler', prompt_id: 'p' } })).toEqual({ kind: 'executing', promptId: 'p', node: 'sampler' })
    expect(parseMessage({ type: 'progress', data: { node: 'sampler', value: 3, max: 25, prompt_id: 'p' } })).toEqual({ kind: 'progress', promptId: 'p', node: 'sampler', value: 3, max: 25 })
    const img = { filename: 'a.png', subfolder: '', type: 'output' }
    expect(parseMessage({ type: 'executed', data: { node: 'save', output: { images: [img] }, prompt_id: 'p' } })).toMatchObject({ kind: 'executed', node: 'save', images: [img] })
    expect(parseMessage({ type: 'execution_error', data: { prompt_id: 'p', node_id: '8', node_type: 'KSampler', exception_message: 'OOM\n', exception_type: 'RuntimeError', traceback: ['x'] } })).toMatchObject({
      kind: 'execution_error',
      node: '8',
      nodeType: 'KSampler',
      message: 'OOM',
    })
    expect(parseMessage({ type: 'crystools.monitor', data: { cpu: 1 } })).toEqual({ kind: 'other', type: 'crystools.monitor', data: { cpu: 1 } })
  })

  it('бинарное превью: тип 1 (JPEG/PNG) и тип 4 (с метаданными)', () => {
    const frame = (event: number, fmt: number, body: number[]) => {
      const b = new Uint8Array(8 + body.length)
      const v = new DataView(b.buffer)
      v.setUint32(0, event)
      v.setUint32(4, fmt)
      b.set(body, 8)
      return b.buffer
    }
    expect(parseBinary(frame(1, 1, [0xff, 0xd8]))).toEqual({ kind: 'preview', mime: 'image/jpeg', bytes: Uint8Array.from([0xff, 0xd8]) })
    expect(parseBinary(frame(1, 2, [0x89]))?.mime).toBe('image/png')
    expect(parseBinary(frame(2, 1, [1]))).toBeNull()
    const meta = new TextEncoder().encode(JSON.stringify({ prompt_id: 'p', node_id: '8', image_type: 'image/png' }))
    const b4 = new Uint8Array(8 + meta.length + 2)
    new DataView(b4.buffer).setUint32(0, 4)
    new DataView(b4.buffer).setUint32(4, meta.length)
    b4.set(meta, 8)
    b4.set([7, 7], 8 + meta.length)
    expect(parseBinary(b4)).toEqual({ kind: 'preview', mime: 'image/png', bytes: Uint8Array.from([7, 7]), promptId: 'p', node: '8' })
  })

  it('collectOutputFiles', () => {
    const img = { filename: 'a.png', subfolder: '', type: 'output' }
    expect(collectOutputFiles({ outputs: { save: { images: [img] }, other: {} } })).toEqual([img])
  })
})

// ── queue: фейковый сервер (HTTP) + управляемый WebSocket ────────────────────

class FakeWS extends EventTarget {
  static last: FakeWS | null = null
  binaryType = 'blob'
  sent: string[] = []
  constructor(readonly url: string) {
    super()
    FakeWS.last = this
    setTimeout(() => this.dispatchEvent(new Event('open')), 0)
  }
  send(s: string): void {
    this.sent.push(s)
  }
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

describe('connect / queue', () => {
  let server: Server
  let addr = ''
  const posted: Array<{ path: string; body: Record<string, unknown> }> = []
  let pending: string[] = []
  let running: string[] = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c))
      req.on('end', () => {
        const json = body ? (JSON.parse(body) as Record<string, unknown>) : {}
        posted.push({ path: req.url ?? '', body: json })
        res.setHeader('content-type', 'application/json')
        if (req.url === '/prompt') {
          if ((json.prompt as Record<string, unknown>).bad) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' }, node_errors: { '8': { errors: [{ message: 'Value not in list', extra_info: { input_name: 'sampler_name' } }] } } }))
          }
          return res.end(JSON.stringify({ prompt_id: json.prompt_id, number: 7, node_errors: {} }))
        }
        if (req.url === '/queue' && req.method === 'GET') {
          return res.end(JSON.stringify({ queue_running: running.map((id) => [0, id, {}]), queue_pending: pending.map((id) => [1, id, {}]) }))
        }
        res.end('{}')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    addr = `127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  it('события только своего prompt, превью без id — исполняемому, конец на success', async () => {
    const conn = await connect(addr, { WebSocket: FakeWS as never, clientId: 'cid' })
    const ws = FakeWS.last!
    expect(ws.url).toBe(`ws://${addr}/ws?clientId=cid`)
    expect(JSON.parse(ws.sent[0]!)).toMatchObject({ type: 'feature_flags', data: { supports_preview_metadata: true } })
    const job = await conn.queue(qwen, { workflow: { nodes: [] } })
    const body = posted.find((p) => p.path === '/prompt')!.body
    expect(body).toMatchObject({ client_id: 'cid', prompt_id: job.promptId, extra_data: { extra_pnginfo: { workflow: { nodes: [] } }, preview_method: 'auto' } })
    expect(job.number).toBe(7)
    const id = job.promptId
    const png = { filename: 'q_00001_.png', subfolder: '', type: 'output' }
    ws.emit('status', { status: { exec_info: { queue_remaining: 1 } } })
    ws.emit('execution_start', { prompt_id: id })
    ws.emit('executing', { node: 'other', prompt_id: 'someone-else' })
    ws.emit('executing', { node: 'sampler', prompt_id: id })
    ws.emit('progress', { node: 'sampler', value: 1, max: 2, prompt_id: id })
    const frame = new Uint8Array(10)
    new DataView(frame.buffer).setUint32(0, 1)
    new DataView(frame.buffer).setUint32(4, 1)
    ws.emitBinary(frame)
    ws.emit('executed', { node: 'save', output: { images: [png] }, prompt_id: id })
    ws.emit('execution_success', { prompt_id: id })
    ws.emit('executing', { node: null, prompt_id: id })
    const got: ComfyEvent[] = []
    for await (const e of job) got.push(e)
    expect(got.map((e) => e.kind)).toEqual(['execution_start', 'executing', 'progress', 'preview', 'executed', 'execution_success'])
    expect(got[3]).toMatchObject({ kind: 'preview', mime: 'image/jpeg', promptId: id, node: 'sampler' })
    expect(await job.done).toEqual({ status: 'success', images: [png] })
    conn.close()
  })

  it('события после начала итерации, конец на execution_error', async () => {
    const conn = await connect(addr, { WebSocket: FakeWS as never })
    const ws = FakeWS.last!
    const job = await conn.queue(qwen)
    const it = job[Symbol.asyncIterator]()
    const first = it.next()
    ws.emit('execution_start', { prompt_id: job.promptId })
    expect((await first).value).toMatchObject({ kind: 'execution_start' })
    ws.emit('execution_error', { prompt_id: job.promptId, node_id: '8', node_type: 'KSampler', exception_message: 'boom' })
    expect((await it.next()).value).toMatchObject({ kind: 'execution_error', message: 'boom' })
    expect((await it.next()).done).toBe(true)
    expect(await job.done).toMatchObject({ status: 'error', error: 'KSampler [8]: boom' })
    conn.close()
  })

  it('cancel ждущего в очереди — снят и событие interrupted; бегущего — /interrupt {prompt_id}', async () => {
    const conn = await connect(addr, { WebSocket: FakeWS as never })
    const a = await conn.queue(qwen)
    pending = [a.promptId]
    expect(await a.cancel()).toBe('deleted')
    expect(posted.at(-1)).toMatchObject({ path: '/queue', body: { delete: [a.promptId] } })
    const evs: string[] = []
    for await (const e of a) evs.push(e.kind)
    expect(evs).toEqual(['execution_interrupted'])
    expect((await a.done).status).toBe('interrupted')

    const b = await conn.queue(qwen)
    pending = []
    running = [b.promptId]
    expect(await b.cancel()).toBe('interrupted')
    expect(posted.at(-1)).toMatchObject({ path: '/interrupt', body: { prompt_id: b.promptId } })
    FakeWS.last!.emit('execution_interrupted', { prompt_id: b.promptId, node_id: '8' })
    expect((await b.done).status).toBe('interrupted')
    running = []
    conn.close()
  })

  it('обрыв сокета — итератор бросает, done — error', async () => {
    const conn = await connect(addr, { WebSocket: FakeWS as never })
    const job = await conn.queue(qwen)
    const it = job[Symbol.asyncIterator]()
    const next = it.next()
    FakeWS.last!.close()
    await expect(next).rejects.toThrow(/закрыт/)
    expect((await job.done).status).toBe('error')
  })

  it('ошибка валидации /prompt — throw с разбором node_errors', async () => {
    const conn = await connect(addr, { WebSocket: FakeWS as never })
    await expect(conn.queue({ bad: { class_type: 'X', inputs: {} } })).rejects.toThrow(/node \[8\]\.sampler_name: Value not in list/)
    conn.close()
  })
})
