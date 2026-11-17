// nanogptImageProvider (image-gen-2-spec §3) на локальном фейковом nano-gpt:
// GET images/models (урезанный реальный ответ 07.10) + POST images.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { nanogptImageProvider } from '../../src/web/image/nanogpt.js'
import { fromBase64, toBase64 } from '../../src/web/image/bytes.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODELS = fs.readFileSync(path.join(HERE, 'fixtures', 'nanogpt-models.json'), 'utf-8')

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG = fromBase64(PNG_B64)
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46])

/** Ответы POST по очереди; последний повторяется. */
let replies: Array<{ status: number; body: unknown }>
let server: http.Server
let base = ''
const log: {
  posts: Array<{ auth?: string; body: Record<string, unknown> }>
  modelGets: number
  tts: Array<{ key?: string; body: Record<string, unknown> }>
  status: string[]
} = { posts: [], modelGets: 0, tts: [], status: [] }
let ttsStatus: unknown[] = []
/** Урезанный реальный `audio-models` (10.10): SFX, музыка, TTS, STT, подкаст. */
const AUDIO_MODELS = {
  object: 'list',
  data: [
    { id: 'elevenlabs/sound-effects/v2', name: 'ElevenLabs SFX v2', category: 'audio_generation', pricing: { per_second: 0.002, minimum: 0 }, capabilities: { text_to_audio: true }, supported_parameters: { min_duration: 0.5, max_duration: 22 } },
    { id: 'elevenlabs/music/v2.5', category: 'audio_music', pricing: { per_billing_interval: 0.75, billing_interval_seconds: 60 }, capabilities: { text_to_music: true }, supported_parameters: { min_duration: 3, max_duration: 600 } },
    { id: 'google/lyria-3.5', category: 'audio_music', pricing: { per_generation: 0.11 }, capabilities: { text_to_music: true, image_to_music: true }, supported_parameters: { max_chars: 5000, image_url: { type: 'string', format: 'uri', required: false } } },
    { id: 'tts-1', category: 'audio_tts', capabilities: { text_to_speech: true }, supported_parameters: {} },
    { id: 'whisper', category: 'audio_stt', capabilities: { speech_to_text: true }, supported_parameters: {} },
    { id: 'mureka/api/generate/podcast', category: 'audio_generation', capabilities: { text_to_audio: true, podcast_generation: true }, supported_parameters: {} },
    { id: 'sonilo/video-to-music', category: 'audio_music', capabilities: { video_to_music: true }, supported_parameters: {} },
  ],
}

const okBody = (n = 1) => ({
  created: 1,
  data: Array.from({ length: n }, () => ({ b64_json: PNG_B64 })),
  cost: 0.05,
  paymentSource: 'USD',
  remainingBalance: 9.95,
  requestId: 'req-1',
})

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(typeof body === 'string' ? body : JSON.stringify(body))
    }
    if (req.method === 'GET' && req.url === '/api/v1/images/models') {
      log.modelGets++
      return send(200, MODELS)
    }
    if (req.method === 'GET' && req.url === '/api/v1/audio-models') return send(200, AUDIO_MODELS)
    if (req.method === 'POST' && req.url === '/api/tts') {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        log.tts.push({ key: req.headers['x-api-key'] as string, body: JSON.parse(raw) })
        send(202, { status: 'pending', runId: 'run-1', model: 'fal-ai/x', charged: true, cost: 0.004, paymentSource: 'USD', isApiRequest: true })
      })
      return
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/tts/status?')) {
      log.status.push(req.url)
      const step = ttsStatus.length > 1 ? ttsStatus.shift()! : ttsStatus[0]
      return send(200, step)
    }
    if (req.method === 'GET' && req.url === '/cdn/out.mp3') {
      res.writeHead(200, { 'content-type': 'audio/mpeg' })
      return res.end(Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]))
    }
    if (req.method === 'POST' && req.url === '/api/v1/images') {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        log.posts.push({ auth: req.headers.authorization, body: JSON.parse(raw) })
        const step = replies.length > 1 ? replies.shift()! : replies[0]
        send(step.status, step.body)
      })
      return
    }
    send(404, { error: 'not found' })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
})

afterAll(() => new Promise<void>((r) => server.close(() => r())))

beforeEach(() => {
  replies = [{ status: 200, body: okBody() }]
  log.posts.length = 0
  log.modelGets = 0
  log.tts.length = 0
  log.status.length = 0
  ttsStatus = [{ status: 'pending', queuePosition: 2 }, { status: 'completed', audioUrl: `${base.replace('/api/v1', '')}/cdn/out.mp3`, contentType: 'audio/mpeg' }]
})

const provider = () => nanogptImageProvider({ baseUrl: base, apiKey: 'test-key-1', retryDelay: 1, pollInterval: 5 })
const T2I = 'black-forest-labs/flux-3/text-to-image'
const EDIT = 'black-forest-labs/flux-3/edit'

describe('nanogptImageProvider — генерация', () => {
  it('POST images: Bearer, тело по схеме; meta из ответа (cost в usd, balance, requestId)', async () => {
    const events: unknown[] = []
    const r = await provider().generate({ model: T2I, prompt: 'a fox', params: { resolution: '1k', aspect_ratio: '1:1' }, onProgress: (e) => events.push(e) })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.images[0]).toEqual(PNG)
    expect(r.value.mime).toBe('image/png')
    expect(r.value.meta).toEqual({ model: T2I, id: 'req-1', cost: 0.05, cost_unit: 'usd', balance: 9.95 })
    expect(log.posts[0].auth).toBe('Bearer test-key-1')
    expect(log.posts[0].body).toEqual({ model: T2I, prompt: 'a fox', resolution: '1k', aspect_ratio: '1:1' })
    expect(events).toEqual([{ stage: 'running' }, { stage: 'done' }])
  })

  it('рефы → imageDataUrls (data-URL, MIME по сигнатуре): input_references flux-3/edit не видит', async () => {
    const r = await provider().generate({ model: EDIT, prompt: 'x', refs: [PNG, JPEG] })
    expect(r.ok).toBe(true)
    expect(log.posts[0].body.input_references).toBeUndefined()
    expect(log.posts[0].body.imageDataUrls).toEqual([`data:image/png;base64,${PNG_B64}`, `data:image/jpeg;base64,${toBase64(JPEG)}`])
  })

  it('n → images по числу data', async () => {
    replies = [{ status: 200, body: okBody(3) }]
    const r = await provider().generate({ model: T2I, prompt: 'x', params: { n: '3' } })
    expect(r.ok && r.value.images.length).toBe(3)
    expect(log.posts[0].body.n).toBe(3)
  })

  it('список моделей грузится один раз на экземпляр', async () => {
    const p = provider()
    await p.generate({ model: T2I, prompt: 'x' })
    await p.generate({ model: T2I, prompt: 'y' })
    await p.models!()
    await p.schema!(T2I)
    expect(log.modelGets).toBe(1)
  })
})

describe('nanogptImageProvider — схема', () => {
  it('поля из supported_parameters: resolution/aspect_ratio enum, seed/output_format/thinking_level…; prompt и n всегда', async () => {
    const r = await provider().schema!('nano-banana-2.1')
    expect(r.ok).toBe(true)
    if (!r.ok || !r.value) return
    const f = r.value.fields
    expect(Object.keys(f).sort()).toEqual(
      ['aspect_ratio', 'enable_web_search', 'n', 'output_format', 'prompt', 'resolution', 'seed', 'system_prompt', 'thinking_level'].sort(),
    )
    expect(f.seed.type).toBe('integer')
    expect(f.enable_web_search.type).toBe('boolean')
    expect(f.output_format.enum).toEqual(['png', 'jpeg', 'webp'])
  })

  it('лишний ключ — err с именем и списком полей, без сети', async () => {
    const r = await provider().generate({ model: T2I, prompt: 'x', params: { steps: 20 } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toMatch(/"steps".*поля: .*resolution \(1k\|2k\|4k\)/)
    expect(log.posts).toHaveLength(0)
  })

  it('enum — err', async () => {
    const r = await provider().generate({ model: T2I, prompt: 'x', params: { resolution: '8k' } })
    expect(!r.ok && r.error.message).toMatch(/"8k" не из списка/)
  })

  it('рефов больше maxRefs — err; модели без image_to_image рефы не положены', async () => {
    const many = Array.from({ length: 11 }, () => PNG)
    const r = await provider().generate({ model: EDIT, prompt: 'x', refs: many })
    expect(!r.ok && r.error.message).toMatch(/до 10 реф\., передано 11/)
    const s = await provider().schema!('minimax-h3/text-to-image')
    expect(s.ok && s.value?.fields.loras?.type).toBe('array')
  })

  it('модели нет — err', async () => {
    const r = await provider().generate({ model: 'nope/x', prompt: 'x' })
    expect(!r.ok && r.error.message).toMatch(/модели nope\/x нет/)
  })
})

describe('nanogptImageProvider — models()', () => {
  it('только image_generation; edit = image_to_image; price из pricing.per_image', async () => {
    const r = await provider().models!()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.map((m) => m.id)).not.toContain('test/upscale-only')
    expect(r.value.find((m) => m.id === EDIT)).toEqual({ id: EDIT, name: 'FLUX.3 Image Edit', edit: true, maxRefs: 10, price: '$0.05/1k, $0.12/2k, $0.65/4k' })
  })
})

describe('nanogptImageProvider — ошибки', () => {
  it('401 — AuthError', async () => {
    replies = [{ status: 401, body: { error: 'Invalid API key' } }]
    const r = await provider().generate({ model: T2I, prompt: 'x' })
    expect(!r.ok && r.error.name).toBe('AuthError')
  })

  it('429 — ретраи, потом успех; сверх 6 — RateLimitError', async () => {
    replies = [{ status: 429, body: {} }, { status: 429, body: {} }, { status: 200, body: okBody() }]
    expect((await provider().generate({ model: T2I, prompt: 'x' })).ok).toBe(true)
    expect(log.posts).toHaveLength(3)
    replies = [{ status: 429, body: {} }]
    const r = await provider().generate({ model: T2I, prompt: 'x' })
    expect(!r.ok && r.error.name).toBe('RateLimitError')
  })

  it('400 модерации — ModerationError', async () => {
    replies = [{ status: 400, body: { error: 'Prompt rejected', type: 'CONTENT_POLICY_VIOLATION' } }]
    const r = await provider().generate({ model: T2I, prompt: 'x' })
    expect(!r.ok && r.error.name).toBe('ModerationError')
  })

  it('прочее 400 — ImageError с type и error; IMAGE_PROCESSING_FAILED — «не списано»', async () => {
    replies = [{ status: 400, body: { error: 'Provider failed', type: 'IMAGE_PROCESSING_FAILED' } }]
    const r = await provider().generate({ model: T2I, prompt: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.name).toBe('ImageError')
      expect(r.error.message).toMatch(/400 IMAGE_PROCESSING_FAILED — Provider failed \(не списано\)/)
    }
  })
})

describe('nanogptImageProvider — звук (ABC-261)', () => {
  it('models(): SFX и музыка с kind audio и ценой; TTS/STT/подкаст/видео→музыка — нет', async () => {
    const r = await provider().models!()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const audio = r.value.filter((m) => m.kind === 'audio')
    expect(audio.map((m) => [m.id, m.price])).toEqual([
      ['elevenlabs/sound-effects/v2', '$0.002/с'],
      ['elevenlabs/music/v2.5', '$0.75/мин'],
      ['google/lyria-3.5', '$0.11'],
    ])
  })

  it('схема: duration из min/max, поля по модели (loop, prompt_influence)', async () => {
    const s = await provider().schema!('elevenlabs/sound-effects/v2')
    expect(s.ok && s.value).toMatchObject({ kind: 'audio', fields: { prompt: { type: 'string' }, duration: { type: 'number', min: 0.5, max: 22 }, loop: { type: 'boolean' } } })
  })

  it('generate: /api/tts x-api-key {model, text, duration} → 202 → опрос статуса → audioUrl; cost usd', async () => {
    const events: string[] = []
    const r = await provider().generate({ model: 'elevenlabs/sound-effects/v2', prompt: 'door knock', params: { duration: '2' }, onProgress: (e) => events.push(e.stage) })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(log.tts).toEqual([{ key: 'test-key-1', body: { model: 'elevenlabs/sound-effects/v2', text: 'door knock', duration: 2 } }])
    expect(log.status[0]).toMatch(/runId=run-1&model=fal-ai%2Fx&cost=0.004&paymentSource=USD&isApiRequest=true/)
    expect(r.value.mime).toBe('audio/mpeg')
    expect(r.value.meta).toMatchObject({ cost: 0.004, cost_unit: 'usd', id: 'run-1' })
    expect(events).toContain('downloading')
  })

  it('ошибка статуса CONTENT_POLICY — ModerationError; duration вне границ — до сети', async () => {
    ttsStatus = [{ status: 'error', code: 'CONTENT_POLICY_VIOLATION', error: 'blocked' }]
    const r = await provider().generate({ model: 'elevenlabs/sound-effects/v2', prompt: 'x' })
    expect(!r.ok && r.error.name).toBe('ModerationError')
    const bad = await provider().generate({ model: 'elevenlabs/sound-effects/v2', prompt: 'x', params: { duration: 60 } })
    expect(!bad.ok && bad.error.message).toMatch(/больше максимума/)
    expect(log.tts.length).toBe(1)
  })
})
