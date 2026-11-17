// googleMediaProvider / vertexMediaProvider (media-gen-spec §2) на локальном фейковом
// Google: models, generateContent (картинки, Lyria), predictLongRunning → опрос → ролик (Veo).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { googleMediaProvider, vertexMediaProvider, entryOf } from '../../src/web/image/google.js'
import { fromBase64, sniffMediaMime, toBase64, mediaExt } from '../../src/web/image/bytes.js'

const PNG = fromBase64(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
)
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46])
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0])
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0])

type Json = Record<string, unknown>

interface Call {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body?: Json
}

let server: http.Server
let base = ''
const calls: Call[] = []
/** Ответ на generateContent; функция — по телу. */
let content: (body: Json) => { status: number; body: unknown }
let polls: Json[] = []
let batchPolls: Json[] = []
let postStatus: number[] = []

const MODELS = {
  models: [
    { name: 'models/gemini-3.1-flash-image', displayName: 'Nano Banana 2', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/veo-3.1-lite-generate-preview', displayName: 'Veo 3.1 lite', supportedGenerationMethods: ['predictLongRunning'] },
    { name: 'models/lyria-3-clip-preview', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/lyria-realtime-exp', supportedGenerationMethods: ['bidiGenerateMusic'] },
  ],
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? ''
    const send = (status: number, body: unknown, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type })
      res.end(body instanceof Uint8Array ? Buffer.from(body) : JSON.stringify(body))
    }
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Json) : undefined
      calls.push({ method: req.method ?? '', url, headers: req.headers, ...(body ? { body } : {}) })
      // ---- AI Studio ----
      if (url.startsWith('/v1beta/models?')) return send(200, MODELS)
      if (url.endsWith(':generateContent')) {
        const r = content(body ?? {})
        return send(r.status, r.body)
      }
      if (url.endsWith(':predictLongRunning')) {
        const st = postStatus.shift() ?? 200
        if (st !== 200) return send(st, { error: { code: st, message: 'busy' } })
        return send(200, { name: url.includes('/projects/') ? 'projects/p/locations/us-central1/operations/op1' : 'models/veo/operations/op1' })
      }
      if (url.startsWith('/v1beta/models/veo/operations/op1') || url.endsWith(':fetchPredictOperation')) {
        return send(200, polls.length > 1 ? polls.shift() : polls[0])
      }
      if (url.endsWith(':batchGenerateContent')) return send(200, { name: 'batches/b1', metadata: { state: 'BATCH_STATE_PENDING' } })
      if (url === '/v1beta/batches/b1') return send(200, batchPolls.length > 1 ? batchPolls.shift() : batchPolls[0])
      if (url.startsWith('/files/video.mp4')) {
        if (req.headers['x-goog-api-key'] !== 'test-key-1') return send(403, { error: { message: 'no key' } })
        return send(200, MP4, 'video/mp4')
      }
      // ---- Vertex ----
      if (url.startsWith('/v1beta1/publishers/google/models?')) {
        return send(200, { publisherModels: [{ name: 'publishers/google/models/gemini-3.1-flash-image' }, { name: 'publishers/google/models/gemini-3.5-flash' }] })
      }
      if (url === '/v1beta1/publishers/google/models/veo-3.1-lite-generate-001') return send(200, { name: 'x' })
      send(404, { error: { message: 'not found' } })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((r) => server.close(() => r())))

beforeEach(() => {
  calls.length = 0
  postStatus = []
  content = () => ({
    status: 200,
    body: {
      candidates: [
        {
          content: {
            parts: [
              { text: 'thinking', thought: true },
              { inlineData: { mimeType: 'image/png', data: toBase64(JPEG) }, thought: true },
              { text: 'Here you go' },
              { inlineData: { mimeType: 'image/png', data: toBase64(PNG) } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 1120, totalTokenCount: 1128 },
      responseId: 'resp-1',
    },
  })
  polls = [
    { name: 'models/veo/operations/op1', done: false, metadata: { progressPercent: 40 } },
    { name: 'models/veo/operations/op1', done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `${base}/files/video.mp4` } }] } } },
  ]
})

const studio = () => googleMediaProvider({ apiKey: 'test-key-1', baseUrl: `${base}/v1beta`, pollInterval: 5, retryDelay: 1, batchPollInterval: 5 })
const vertex = () =>
  vertexMediaProvider({ project: 'proj-1', baseUrl: base, token: async () => 'tok-1', pollInterval: 5, retryDelay: 1 })

describe('байты медиа', () => {
  it('sniffMediaMime: картинки, mp4, webm, mp3, wav, ogg; mediaExt', () => {
    expect(sniffMediaMime(PNG)).toBe('image/png')
    expect(sniffMediaMime(MP4)).toBe('video/mp4')
    expect(sniffMediaMime(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1]))).toBe('video/webm')
    expect(sniffMediaMime(MP3)).toBe('audio/mpeg')
    expect(sniffMediaMime(new Uint8Array([0xff, 0xfb, 0x90, 0]))).toBe('audio/mpeg')
    expect(sniffMediaMime(new TextEncoder().encode('RIFF\0\0\0\0WAVEfmt '))).toBe('audio/wav')
    expect(sniffMediaMime(new TextEncoder().encode('OggS\0'))).toBe('audio/ogg')
    expect(mediaExt('video/mp4')).toBe('mp4')
    expect(mediaExt('audio/mpeg')).toBe('mp3')
    expect(mediaExt('image/jpeg')).toBe('jpg')
  })
})

describe('googleMediaProvider — модели и схемы', () => {
  it('models(): только медиа с нужным методом, вид и роль рефов', async () => {
    const r = await studio().models!()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.map((m) => m.id)).toEqual(['gemini-3.1-flash-image', 'veo-3.1-lite-generate-preview', 'lyria-3-clip-preview'])
    expect(r.value[0]).toMatchObject({ kind: 'image', refRole: 'reference', edit: true, maxRefs: 14, name: 'Nano Banana 2' })
    expect(r.value[1]).toMatchObject({ kind: 'video', refRole: 'frames', maxRefs: 2 })
    expect(r.value[2]).toMatchObject({ kind: 'audio' })
    expect(calls[0].headers['x-goog-api-key']).toBe('test-key-1')
  })

  it('схема по семейству: lite без 4k у Veo, image_size у flash-lite только 1K, у 2.5 его нет', () => {
    expect(entryOf('veo-3.1-lite-generate-preview')!.schema.fields.resolution.enum).toEqual(['720p', '1080p'])
    expect(entryOf('veo-3.1-generate-preview')!.schema.fields.resolution.enum).toContain('4k')
    expect(entryOf('gemini-3.1-flash-lite-image')!.schema.fields.image_size.enum).toEqual(['1K'])
    expect(entryOf('gemini-2.5-flash-image')!.schema.fields.image_size).toBeUndefined()
    expect(entryOf('gemini-3.5-flash')).toBeUndefined()
  })
})

describe('googleMediaProvider — картинки и музыка (generateContent)', () => {
  it('картинка: рефы inlineData перед текстом, imageConfig/thinkingConfig, мысли пропущены', async () => {
    const r = await studio().generate({
      model: 'gemini-3.1-flash-image',
      prompt: 'fox',
      refs: [PNG, JPEG],
      params: { aspect_ratio: '16:9', image_size: '2K', thinking_level: 'high', seed: '7' },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const c = calls.find((x) => x.url.endsWith(':generateContent'))!
    expect(c.url).toBe('/v1beta/models/gemini-3.1-flash-image:generateContent')
    const parts = (c.body!.contents as Json[])[0].parts as Json[]
    expect(parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: toBase64(PNG) } },
      { inlineData: { mimeType: 'image/jpeg', data: toBase64(JPEG) } },
      { text: 'fox' },
    ])
    expect(c.body!.generationConfig).toEqual({
      imageConfig: { aspectRatio: '16:9', imageSize: '2K' },
      thinkingConfig: { thinkingLevel: 'high' },
      seed: 7,
      responseModalities: ['TEXT', 'IMAGE'],
    })
    expect(r.value.images).toHaveLength(1)
    expect(r.value.mime).toBe('image/png')
    expect(r.value.meta).toMatchObject({ cost: 1128, cost_unit: 'tokens', id: 'resp-1', text: 'Here you go' })
  })

  it('лишний параметр и enum — ошибка до сети', async () => {
    const a = await studio().generate({ model: 'gemini-3.1-flash-image', prompt: 'x', params: { steps: 4 } })
    expect(a.ok).toBe(false)
    if (!a.ok) expect(a.error.message).toMatch(/steps.*нет у модели/)
    const b = await studio().generate({ model: 'gemini-3.1-flash-lite-image', prompt: 'x', params: { image_size: '4K' } })
    expect(b.ok).toBe(false)
    expect(calls.filter((x) => x.url.endsWith(':generateContent'))).toHaveLength(0)
  })

  it('блок промпта — ModerationError; без картинки с finishReason IMAGE_SAFETY — ModerationError', async () => {
    content = () => ({ status: 200, body: { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } } })
    const a = await studio().generate({ model: 'gemini-3.1-flash-image', prompt: 'x' })
    expect(!a.ok && a.error.name).toBe('ModerationError')
    content = () => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: 'no' }] }, finishReason: 'IMAGE_SAFETY' }] } })
    const b = await studio().generate({ model: 'gemini-3.1-flash-image', prompt: 'x' })
    expect(!b.ok && b.error.name).toBe('ModerationError')
    if (!b.ok) expect(b.error.message).toMatch(/IMAGE_SAFETY.*no/)
  })

  it('Lyria: responseModalities AUDIO, mp3 по сигнатуре, текст песни в meta.text', async () => {
    content = () => ({
      status: 200,
      body: {
        candidates: [{ content: { parts: [{ text: '<instrumental>' }, { inlineData: { mimeType: 'audio/mpeg', data: toBase64(MP3) } }] } }],
        usageMetadata: { totalTokenCount: 307 },
      },
    })
    const r = await studio().generate({ model: 'lyria-3-clip-preview', prompt: 'jingle' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const c = calls.find((x) => x.url.endsWith(':generateContent'))!
    expect((c.body!.generationConfig as Json).responseModalities).toEqual(['AUDIO', 'TEXT'])
    expect(r.value.mime).toBe('audio/mpeg')
    expect(r.value.meta).toMatchObject({ text: '<instrumental>', cost: 307, cost_unit: 'tokens' })
  })

  it('401 — AuthError; 429 ретраится', async () => {
    let n = 0
    content = () => (++n < 3 ? { status: 429, body: { error: { message: 'quota' } } } : { status: 401, body: { error: { message: 'bad key' } } })
    const r = await studio().generate({ model: 'gemini-3.1-flash-image', prompt: 'x' })
    expect(n).toBe(3)
    expect(!r.ok && r.error.name).toBe('AuthError')
  })
})

describe('googleMediaProvider — Veo (predictLongRunning)', () => {
  it('первый и последний кадр, параметры в parameters, allow_adult при кадре, опрос, скачивание по ключу', async () => {
    const events: string[] = []
    const r = await studio().generate({
      model: 'veo-3.1-lite-generate-preview',
      prompt: 'wave',
      refs: [PNG, JPEG],
      params: { duration: '4', resolution: '720p', aspect_ratio: '9:16' },
      onProgress: (e) => events.push(e.status ? `${e.stage} ${e.status}` : e.stage),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const c = calls.find((x) => x.url.endsWith(':predictLongRunning'))!
    expect(c.body).toEqual({
      instances: [
        {
          prompt: 'wave',
          image: { bytesBase64Encoded: toBase64(PNG), mimeType: 'image/png' },
          lastFrame: { bytesBase64Encoded: toBase64(JPEG), mimeType: 'image/jpeg' },
        },
      ],
      parameters: { durationSeconds: 4, resolution: '720p', aspectRatio: '9:16', personGeneration: 'allow_adult' },
    })
    expect(r.value.mime).toBe('video/mp4')
    expect(r.value.meta).toMatchObject({ cost: 4, cost_unit: 'seconds', id: 'models/veo/operations/op1' })
    expect(events).toEqual(['queued', 'running 40%', 'running running', 'downloading', 'done'])
  })

  it('без кадра — text-to-video без personGeneration; 3 кадра — ошибка до сети', async () => {
    const r = await studio().generate({ model: 'veo-3.1-lite-generate-preview', prompt: 'boat' })
    expect(r.ok).toBe(true)
    const c = calls.find((x) => x.url.endsWith(':predictLongRunning'))!
    expect(c.body).toEqual({ instances: [{ prompt: 'boat' }], parameters: {} })
    const bad = await studio().generate({ model: 'veo-3.1-lite-generate-preview', prompt: 'x', refs: [PNG, PNG, PNG] })
    expect(bad.ok).toBe(false)
  })

  it('отфильтровано RAI — ModerationError с причиной; ошибка операции — текстом', async () => {
    polls = [{ done: true, response: { generateVideoResponse: { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ['celebrity'] } } }]
    const a = await studio().generate({ model: 'veo-3.1-lite-generate-preview', prompt: 'x' })
    expect(!a.ok && a.error.name).toBe('ModerationError')
    if (!a.ok) expect(a.error.message).toMatch(/celebrity/)
    polls = [{ done: true, error: { code: 3, message: 'bad frame' } }]
    const b = await studio().generate({ model: 'veo-3.1-lite-generate-preview', prompt: 'x' })
    expect(!b.ok && b.error.message).toMatch(/bad frame/)
  })

  it('отмена — AbortError', async () => {
    polls = [{ done: false }]
    const ctl = new AbortController()
    setTimeout(() => ctl.abort(), 30)
    const r = await studio().generate({ model: 'veo-3.1-lite-generate-preview', prompt: 'x', signal: ctl.signal })
    expect(!r.ok && r.error.name).toBe('AbortError')
  })
})

describe('vertexMediaProvider', () => {
  it('models(): Gemini из publishers + живые кандидаты Veo/Lyria', async () => {
    const r = await vertex().models!()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.map((m) => m.id)).toEqual(['gemini-3.1-flash-image', 'veo-3.1-lite-generate-001'])
    const list = calls.find((x) => x.url.startsWith('/v1beta1/publishers/google/models?'))!
    expect(list.headers.authorization).toBe('Bearer tok-1')
    expect(list.headers['x-goog-user-project']).toBe('proj-1')
  })

  it('картинка — generateContent проекта в global; Veo — регион us-central1, fetchPredictOperation, байты', async () => {
    const a = await vertex().generate({ model: 'gemini-3.1-flash-image', prompt: 'x' })
    expect(a.ok).toBe(true)
    expect(calls.some((x) => x.url === '/v1/projects/proj-1/locations/global/publishers/google/models/gemini-3.1-flash-image:generateContent')).toBe(true)

    polls = [{ done: true, response: { videos: [{ bytesBase64Encoded: toBase64(MP4), mimeType: 'video/mp4' }] } }]
    const b = await vertex().generate({ model: 'veo-3.1-lite-generate-001', prompt: 'x', refs: [PNG] })
    expect(b.ok).toBe(true)
    if (!b.ok) return
    const veo = '/v1/projects/proj-1/locations/us-central1/publishers/google/models/veo-3.1-lite-generate-001'
    expect(calls.some((x) => x.url === `${veo}:predictLongRunning`)).toBe(true)
    const poll = calls.find((x) => x.url === `${veo}:fetchPredictOperation`)!
    expect(poll.body).toEqual({ operationName: 'projects/p/locations/us-central1/operations/op1' })
    expect(b.value.mime).toBe('video/mp4')
  })

  it('токен берётся один раз (кэш)', async () => {
    let n = 0
    const p = vertexMediaProvider({ project: 'proj-1', baseUrl: base, token: async () => `tok-${++n}`, retryDelay: 1 })
    await p.generate({ model: 'gemini-3.1-flash-image', prompt: 'x' })
    await p.generate({ model: 'gemini-3.1-flash-image', prompt: 'y' })
    expect(n).toBe(1)
  })
})

// ──: персонаж Veo, Lyria на Vertex, пакет Gemini ─────────────────────

describe('Veo — рефы персонажа (referenceImages)', () => {
  it('subjects → referenceImages asset, ролик 8 с, allow_adult; lite — maxSubjects нет', async () => {
    expect(entryOf('veo-3.1-generate-preview')!.schema.maxSubjects).toBe(3)
    expect(entryOf('veo-3.1-lite-generate-preview')!.schema.maxSubjects).toBeUndefined()
    const r = await studio().generate({ model: 'veo-3.1-generate-preview', prompt: 'hero walks', subjects: [PNG, JPEG] })
    expect(r.ok).toBe(true)
    const c = calls.find((x) => x.url.endsWith(':predictLongRunning'))!
    expect(c.body).toEqual({
      instances: [
        {
          prompt: 'hero walks',
          referenceImages: [
            { image: { bytesBase64Encoded: toBase64(PNG), mimeType: 'image/png' }, referenceType: 'asset' },
            { image: { bytesBase64Encoded: toBase64(JPEG), mimeType: 'image/jpeg' }, referenceType: 'asset' },
          ],
        },
      ],
      parameters: { durationSeconds: 8, personGeneration: 'allow_adult' },
    })
    const short = await studio().generate({ model: 'veo-3.1-generate-preview', prompt: 'x', subjects: [PNG], params: { duration: 4 } })
    expect(!short.ok && short.error.message).toMatch(/только 8 с/)
    const lite = await studio().generate({ model: 'veo-3.1-lite-generate-preview', prompt: 'x', subjects: [PNG] })
    expect(!lite.ok && lite.error.message).toMatch(/персонажа не принимает/)
  })

  it('отказ «violates usage guidelines» — ModerationError', async () => {
    polls = [{ done: true, error: { code: 3, message: 'The input image violates usage guidelines.' } }]
    const r = await studio().generate({ model: 'veo-3.1-lite-generate-preview', prompt: 'x', refs: [PNG] })
    expect(!r.ok && r.error.name).toBe('ModerationError')
  })

  it('Vertex text-to-video — allow_adult по умолчанию', async () => {
    // Ответ опроса здесь в форме AI Studio — Vertex ролика не найдёт; проверяем тело запроса.
    await vertex().generate({ model: 'veo-3.1-lite-generate-001', prompt: 'x' })
    const c = calls.find((x) => x.url.endsWith(':predictLongRunning'))!
    expect((c.body!.parameters as Json).personGeneration).toBe('allow_adult')
  })
})

describe('Lyria на Vertex', () => {
  it('без seed/temperature (Vertex отвечает 400) — схема и проверка до сети', async () => {
    expect(entryOf('lyria-3-pro-preview', true)!.schema.fields.seed).toBeUndefined()
    expect(entryOf('lyria-3-pro-preview')!.schema.fields.seed).toBeDefined()
    const s = await vertex().schema!('lyria-3-pro-preview')
    expect(s.ok && Object.keys(s.value!.fields)).toEqual(['prompt'])
    const bad = await vertex().generate({ model: 'lyria-3-pro-preview', prompt: 'x', params: { seed: 1 } })
    expect(!bad.ok && bad.error.message).toMatch(/seed/)
    expect(calls.some((x) => x.url.includes('lyria'))).toBe(false)
  })
})

describe('пакет Gemini (generateBatch)', () => {
  it('batchGenerateContent инлайн → опрос → ответы по key, meta.batch; models() — batch только у AI Studio', async () => {
    const img = (b: Uint8Array) => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: toBase64(b) } }] }, finishReason: 'STOP' }] })
    batchPolls = [
      { name: 'batches/b1', metadata: { state: 'BATCH_STATE_RUNNING', batchStats: { requestCount: '3', successfulRequestCount: '1' } } },
      {
        name: 'batches/b1',
        done: true,
        metadata: { state: 'BATCH_STATE_SUCCEEDED' },
        response: {
          inlinedResponses: {
            inlinedResponses: [
              { metadata: { key: '2' }, response: img(JPEG) },
              { metadata: { key: '0' }, response: img(PNG) },
              { metadata: { key: '1' }, error: { code: 3, message: 'bad prompt' } },
            ],
          },
        },
      },
    ]
    const events: string[] = []
    const p = studio()
    const r = await p.generateBatch!(
      ['a', 'b', 'c'].map((prompt) => ({ model: 'gemini-3.1-flash-image', prompt, params: { aspect_ratio: '3:4' } })),
      { onProgress: (e) => events.push(e.stage + (e.status ? ` ${e.status}` : '')) },
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const c = calls.find((x) => x.url.endsWith(':batchGenerateContent'))!
    const reqs = ((c.body!.batch as Json).inputConfig as { requests: { requests: Json[] } }).requests.requests
    expect(reqs.map((x) => (x.metadata as Json).key)).toEqual(['0', '1', '2'])
    expect((reqs[0].request as Json).generationConfig).toEqual({ imageConfig: { aspectRatio: '3:4' }, responseModalities: ['TEXT', 'IMAGE'] })
    expect(r.value[0].ok && r.value[0].value.mime).toBe('image/png')
    expect(r.value[0].ok && r.value[0].value.meta.batch).toBe('batches/b1')
    expect(!r.value[1].ok && r.value[1].error.message).toMatch(/bad prompt/)
    expect(r.value[2].ok && r.value[2].value.mime).toBe('image/jpeg')
    expect(events.slice(0, 2)).toEqual(['queued batches/b1', 'running running 1/3'])
    expect(events.slice(-2)).toEqual(['downloading', 'done'])
    const m = await p.models!()
    expect(m.ok && m.value.find((x) => x.id === 'gemini-3.1-flash-image')!.batch).toBe(true)
    expect(m.ok && m.value.find((x) => x.id === 'veo-3.1-lite-generate-preview')!.batch).toBeUndefined()
    expect(vertex().generateBatch).toBeUndefined()
  })

  it('Veo пакетом — ошибка; разные модели — ошибка; пакет FAILED — ошибка с состоянием', async () => {
    const v = await studio().generateBatch!([{ model: 'veo-3.1-lite-generate-preview', prompt: 'x' }])
    expect(!v.ok && v.error.message).toMatch(/только Gemini image и Lyria/)
    const mixed = await studio().generateBatch!([{ model: 'gemini-3.1-flash-image', prompt: 'x' }, { model: 'lyria-3-clip-preview', prompt: 'y' }])
    expect(!mixed.ok && mixed.error.message).toMatch(/одна модель/)
    batchPolls = [{ name: 'batches/b1', done: true, metadata: { state: 'BATCH_STATE_FAILED' } }]
    const f = await studio().generateBatch!([{ model: 'gemini-3.1-flash-image', prompt: 'x' }])
    expect(!f.ok && f.error.message).toMatch(/FAILED/)
  })
})
