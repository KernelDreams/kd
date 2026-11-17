// bflImageProvider (image-gen-spec §2) на локальном фейковом BFL:
// POST → polling_url → Ready → sample. Схема — урезанный реальный openapi.json.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { bflImageProvider } from '../../src/web/image/bfl.js'
import { fromBase64, sniffImageMime, toBase64 } from '../../src/web/image/bytes.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OPENAPI = fs.readFileSync(path.join(HERE, 'fixtures', 'bfl-openapi.json'), 'utf-8')

const PNG = fromBase64(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
)
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46])

interface Script {
  /** Ответы POST по очереди: статус (+тело); последний повторяется. */
  post: Array<{ status: number; body?: unknown }>
  /** Статусы опроса по очереди; последний повторяется. */
  polls: string[]
  sample: Uint8Array
  seed?: number
}

let server: http.Server
let base = ''
let script: Script
const log: { posts: Array<{ path: string; key?: string; body: Record<string, unknown> }>; gets: string[] } = {
  posts: [],
  gets: [],
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? ''
    const send = (status: number, body: unknown, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type })
      res.end(typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body))
    }
    if (req.method === 'GET') log.gets.push(url)
    if (url === '/openapi.json') return send(200, OPENAPI)
    // Глобальный get_result не знает задач региона — как у настоящего BFL.
    if (url.startsWith('/v1/get_result')) return send(200, { id: 'x', status: 'Task not found' })
    if (url.startsWith('/eu/poll')) {
      const status = script.polls.length > 1 ? script.polls.shift()! : script.polls[0]
      const result = status === 'Ready' ? { sample: `${base}/delivery/sample.bin`, seed: script.seed } : null
      return send(200, { id: 'task-1', status, result })
    }
    if (url === '/delivery/sample.bin') return send(200, Buffer.from(script.sample), 'application/octet-stream')
    if (req.method === 'POST' && url.startsWith('/v1/')) {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        log.posts.push({ path: url, key: req.headers['x-key'] as string, body: JSON.parse(raw) })
        const step = script.post.length > 1 ? script.post.shift()! : script.post[0]
        send(step.status, step.body ?? { id: 'task-1', polling_url: `${base}/eu/poll?id=task-1`, cost: 4.5 })
      })
      return
    }
    send(404, { detail: 'Not Found' })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((r) => server.close(() => r())))

beforeEach(() => {
  script = { post: [{ status: 200 }], polls: ['Pending', 'Generating', 'Ready'], sample: PNG, seed: 77 }
  log.posts.length = 0
  log.gets.length = 0
})

const provider = () => bflImageProvider({ baseUrl: base, apiKey: 'test-key-1', pollInterval: 5, retryDelay: 1 })

describe('bflImageProvider — генерация', () => {
  it('POST → опрос строго по polling_url → Ready → sample; meta и MIME', async () => {
    const r = await provider().generate({ model: 'flux-3-image', prompt: 'a red fox', params: { resolution: '1k' } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.mime).toBe('image/png')
    expect(r.value.images[0]).toEqual(PNG)
    expect(r.value.meta).toMatchObject({ model: 'flux-3-image', id: 'task-1', cost: 4.5, seed: 77 })
    expect(log.posts[0]).toMatchObject({ path: '/v1/flux-3-image', key: 'test-key-1' })
    expect(log.posts[0].body).toEqual({ prompt: 'a red fox', resolution: '1k' })
    expect(log.gets.filter((g) => g.startsWith('/eu/poll'))).toHaveLength(3)
    expect(log.gets.some((g) => g.startsWith('/v1/get_result'))).toBe(false)
  })

  it('MIME — по сигнатуре байтов, не по заголовку', async () => {
    script.sample = JPEG
    const r = await provider().generate({ model: 'flux-2-pro', prompt: 'x' })
    expect(r.ok && r.value.mime).toBe('image/jpeg')
  })

  it('схема openapi.json грузится один раз на экземпляр', async () => {
    const p = provider()
    await p.generate({ model: 'flux-2-pro', prompt: 'a' })
    await p.generate({ model: 'flux-2-pro', prompt: 'b' })
    expect(log.gets.filter((g) => g === '/openapi.json')).toHaveLength(1)
  })
})

describe('bflImageProvider — раскладка рефов', () => {
  const a = new Uint8Array([1, 2, 3])
  const b = new Uint8Array([4, 5, 6])

  it('images (flux-3-image) — массив base64', async () => {
    const r = await provider().generate({ model: 'flux-3-image', prompt: 'x', refs: [a, b] })
    expect(r.ok).toBe(true)
    expect(log.posts[0].body.images).toEqual([toBase64(a), toBase64(b)])
  })

  it('input_image* (flux-2-pro) — input_image, input_image_2…', async () => {
    const r = await provider().generate({ model: 'flux-2-pro', prompt: 'x', refs: [a, b] })
    expect(r.ok).toBe(true)
    expect(log.posts[0].body).toMatchObject({ input_image: toBase64(a), input_image_2: toBase64(b) })
    expect(log.posts[0].body).not.toHaveProperty('input_image_3')
  })

  it('image_prompt (flux-pro-1.1) — первый реф; два — err, не обрезка', async () => {
    const one = await provider().generate({ model: 'flux-pro-1.1', prompt: 'x', refs: [a] })
    expect(one.ok).toBe(true)
    expect(log.posts[0].body.image_prompt).toBe(toBase64(a))
    const two = await provider().generate({ model: 'flux-pro-1.1', prompt: 'x', refs: [a, b] })
    expect(two.ok).toBe(false)
    if (!two.ok) expect(two.error.message).toMatch(/до 1 реф\., передано 2/)
    expect(log.posts).toHaveLength(1)
  })

  it('image/mask (erase) — рефы по порядку полей схемы', async () => {
    const r = await provider().generate({ model: 'flux-tools/erase-v1', refs: [a, b] })
    expect(r.ok).toBe(true)
    expect(log.posts[0].body).toEqual({ image: toBase64(a), mask: toBase64(b) })
  })

  it('реф и явное поле-картинка на одно поле — err', async () => {
    const r = await provider().generate({
      model: 'flux-2-pro',
      prompt: 'x',
      refs: [a],
      params: { input_image: 'https://example.com/a.png' },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toMatch(/input_image/)
    expect(log.posts).toHaveLength(0)
  })

  it('maxRefs из схемы: images — 10 из описания, input_image* — по числу полей', async () => {
    const p = provider()
    const s3 = await p.schema!('flux-3-image')
    const s2 = await p.schema!('flux-2-pro')
    expect(s3.ok && s3.value?.maxRefs).toBe(10)
    expect(s2.ok && s2.value?.maxRefs).toBe(8)
    expect(s3.ok && s3.value?.fields.images.image).toBe(true)
    expect(s3.ok && s3.value?.fields.resolution.enum).toContain('1k')
  })
})

describe('bflImageProvider — параметры по схеме', () => {
  it('строки приводятся к integer/boolean', async () => {
    const r = await provider().generate({
      model: 'flux-2-pro',
      prompt: 'x',
      params: { width: '1024', height: '768', seed: '42', disable_pup: 'true' },
    })
    expect(r.ok).toBe(true)
    expect(log.posts[0].body).toEqual({ prompt: 'x', width: 1024, height: 768, seed: 42, disable_pup: true })
  })

  it('лишний ключ — err с именем ключа и списком полей, без сети', async () => {
    const r = await provider().generate({ model: 'flux-3-image', prompt: 'x', params: { widht: 512 } })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.name).toBe('ImageError')
      expect(r.error.message).toMatch(/"widht"/)
      expect(r.error.message).toMatch(/resolution \(768sq\|1k/)
    }
    expect(log.posts).toHaveLength(0)
  })

  it('enum — err', async () => {
    const r = await provider().generate({ model: 'flux-3-image', prompt: 'x', params: { resolution: '3k' } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toMatch(/"3k" не из списка 768sq, 1k/)
  })

  it('тип не приводится — err', async () => {
    const r = await provider().generate({ model: 'flux-2-pro', prompt: 'x', params: { seed: 'abc' } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toMatch(/"seed": ожидается integer/)
  })

  it('модели нет — err со списком ближайших', async () => {
    const r = await provider().generate({ model: 'flux-3-imag', prompt: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toMatch(/модель flux-3-imag нет в API BFL; ближайшие: flux-3-image/)
  })
})

describe('bflImageProvider — ошибки', () => {
  it('429 — ретраи, потом успех', async () => {
    script.post = [{ status: 429 }, { status: 429 }, { status: 200 }]
    const r = await provider().generate({ model: 'flux-2-pro', prompt: 'x' })
    expect(r.ok).toBe(true)
    expect(log.posts).toHaveLength(3)
  })

  it('503 (over capacity) — ретраи как у 429', async () => {
    script.post = [{ status: 503, body: { detail: 'over capacity' } }, { status: 200 }]
    const r = await provider().generate({ model: 'flux-2-pro', prompt: 'x' })
    expect(r.ok).toBe(true)
    expect(log.posts).toHaveLength(2)
  })

  it('429 сверх 6 ретраев — RateLimitError', async () => {
    script.post = [{ status: 429, body: { detail: 'slow down' } }]
    const r = await provider().generate({ model: 'flux-2-pro', prompt: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.name).toBe('RateLimitError')
    expect(log.posts).toHaveLength(7)
  })

  it('модерация результата — ModerationError', async () => {
    script.polls = ['Pending', 'Content Moderated']
    const r = await provider().generate({ model: 'flux-2-pro', prompt: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.name).toBe('ModerationError')
  })

  it('статус Error — ImageError с телом', async () => {
    script.polls = ['Error']
    const r = await provider().generate({ model: 'flux-2-pro', prompt: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.name).toBe('ImageError')
      expect((r.error as Error & { body?: string }).body).toMatch(/"status":"Error"/)
    }
  })

  it('401 — AuthError', async () => {
    script.post = [{ status: 401, body: { detail: 'bad key' } }]
    const r = await provider().generate({ model: 'flux-2-pro', prompt: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.name).toBe('AuthError')
  })

  it('общий таймаут — ImageError', async () => {
    script.polls = ['Pending']
    const p = bflImageProvider({ baseUrl: base, apiKey: 'test-key-1', pollInterval: 5, timeout: 80 })
    const r = await p.generate({ model: 'flux-2-pro', prompt: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toMatch(/таймаут 80 мс \(задача task-1, последний статус Pending\)/)
  })
})

describe('bflImageProvider — прогресс и модели (image-gen-2-spec §2)', () => {
  it('onProgress: queued → running по смене статуса → downloading → done', async () => {
    script.polls = ['Pending', 'Reasoning', 'Reasoning', 'Generating', 'Ready']
    const events: unknown[] = []
    const r = await provider().generate({ model: 'flux-3-image', prompt: 'x', onProgress: (e) => events.push(e) })
    expect(r.ok).toBe(true)
    expect(events).toEqual([
      { stage: 'queued' },
      { stage: 'running', status: 'Pending' },
      { stage: 'running', status: 'Reasoning' },
      { stage: 'running', status: 'Generating' },
      { stage: 'downloading' },
      { stage: 'done' },
    ])
  })

  it('падение колбэка не роняет генерацию', async () => {
    const r = await provider().generate({
      model: 'flux-3-image',
      prompt: 'x',
      onProgress: () => {
        throw new Error('boom')
      },
    })
    expect(r.ok).toBe(true)
  })

  it('models(): POST /v1/* без файнтюнов и delete_*; edit/maxRefs/имя из схемы; flux-3-video — вид video', async () => {
    const r = await provider().models!()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const ids = r.value.map((m) => m.id)
    expect(ids).toContain('flux-3-image')
    expect(ids).not.toContain('delete_finetune')
    expect(r.value.find((m) => m.id === 'flux-3-video')).toMatchObject({ kind: 'video', refRole: 'frames', maxRefs: 10, edit: false })
    expect(r.value.find((m) => m.id === 'flux-3-image')).toMatchObject({ edit: true, maxRefs: 10, name: 'Generate an image with FLUX 3.' })
    expect(r.value.find((m) => m.id === 'flux-pro-1.1')).toMatchObject({ edit: true, maxRefs: 1 })
  })
})

describe('bytes', () => {
  it('base64 туда-обратно, сигнатуры', () => {
    const big = new Uint8Array(100_000).map((_, i) => i % 251)
    expect(fromBase64(toBase64(big))).toEqual(big)
    expect(sniffImageMime(PNG)).toBe('image/png')
    expect(sniffImageMime(JPEG)).toBe('image/jpeg')
    expect(sniffImageMime(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
  })
})

// ==================== flux-3-video (media-gen-spec §2) ====================

/** Начало MP4: размер бокса + `ftyp` + бренд. */
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0])

describe('bflImageProvider — flux-3-video', () => {
  it('schema: поля t2v без mode, вид video, кадры до 10 («one to ten total»)', async () => {
    const r = await provider().schema!('flux-3-video')
    expect(r.ok).toBe(true)
    if (!r.ok || !r.value) return
    expect(r.value).toMatchObject({ kind: 'video', refRole: 'frames', maxRefs: 10 })
    expect(Object.keys(r.value.fields)).toEqual(expect.arrayContaining(['prompt', 'duration', 'resolution', 'generate_audio']))
    expect(r.value.fields.mode).toBeUndefined()
    expect(r.value.fields.keyframes).toBeUndefined()
  })

  it('без рефов — mode t2v; duration "5" строкой → 5 числом; результат video/mp4', async () => {
    script.sample = MP4
    const r = await provider().generate({ model: 'flux-3-video', prompt: 'boat', params: { duration: '5', resolution: 'hd' } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(log.posts[0].path).toBe('/v1/flux-3-video')
    expect(log.posts[0].body).toEqual({ prompt: 'boat', duration: 5, resolution: 'hd', mode: 't2v' })
    expect(r.value.mime).toBe('video/mp4')
  })

  it('рефы — mode i2v, кадры base64 в keyframes по порядку', async () => {
    script.sample = MP4
    const r = await provider().generate({ model: 'flux-3-video', prompt: 'wave', refs: [PNG, JPEG] })
    expect(r.ok).toBe(true)
    expect(log.posts[0].body).toEqual({ prompt: 'wave', mode: 'i2v', keyframes: [toBase64(PNG), toBase64(JPEG)] })
  })

  it('duration "auto" остаётся строкой; mode в params — ошибка до сети', async () => {
    script.sample = MP4
    const ok1 = await provider().generate({ model: 'flux-3-video', prompt: 'x', params: { duration: 'auto' } })
    expect(ok1.ok).toBe(true)
    expect(log.posts[0].body.duration).toBe('auto')
    const bad = await provider().generate({ model: 'flux-3-video', prompt: 'x', params: { mode: 'i2v' } })
    expect(bad.ok).toBe(false)
    expect(log.posts).toHaveLength(1)
  })
})
