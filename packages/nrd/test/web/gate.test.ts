// gateMediaProvider (gate-media-spec §7) на фейковом гейте: POST /v1/media → опрос → файлы.
// Живой гейт на фейк-провайдере гоняют тесты llm-gate (test/media-client.test.ts).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { gateMediaProvider, gateRoot } from '../../src/web/image/gate.js'
import { fromBase64 } from '../../src/web/image/bytes.js'

const PNG = fromBase64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')

interface Script {
  /** Статусы опроса по очереди; последний повторяется. */
  polls: Array<Record<string, unknown>>
  postStatus?: number
}

let server: http.Server
let base = ''
let script: Script
let posts: Array<{ auth?: string; body: Record<string, any> }> = []
let polls = 0

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const url = req.url ?? ''
    if (req.method === 'POST' && url === '/v1/media') {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        posts.push({ auth: req.headers.authorization, body: JSON.parse(raw) })
        if (script.postStatus) return send(script.postStatus, { error: { message: 'no provider for model: x' } })
        send(202, { id: 'job1', status: 'queued', kind: 'image' })
      })
      return
    }
    if (url === '/v1/media/job1') {
      const reply = script.polls[Math.min(polls++, script.polls.length - 1)]
      return send(200, { id: 'job1', ...reply })
    }
    if (url === '/v1/media/job1/files/1') {
      res.writeHead(200, { 'Content-Type': 'image/png' })
      return res.end(Buffer.from(PNG))
    }
    if (url === '/v1/media/models') return send(200, { data: [{ id: 'flux', output: 'image', name: 'FLUX', maxRefs: 4 }, { id: 'veo', output: 'video', refRole: 'frames' }] })
    if (url.startsWith('/v1/media/schema?model=flux')) return send(200, { fields: { seed: { type: 'integer' } }, maxRefs: 4 })
    if (url.startsWith('/v1/media/schema')) return send(404, { error: { message: 'no provider for model: nope' } })
    send(404, { error: { message: 'not found' } })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

afterAll(() => new Promise<void>((r) => server.close(() => r())))

beforeEach(() => {
  posts = []
  polls = 0
  script = { polls: [] }
})

describe('gateMediaProvider', () => {
  it('корень без /v1', () => {
    expect(gateRoot('https://g/v1/')).toBe('https://g')
    expect(gateRoot('https://g')).toBe('https://g')
  })

  it('generate: задача → прогресс → файлы, meta.gate.id', async () => {
    script.polls = [
      { status: 'queued' },
      { status: 'running', progress: { stage: 'running', status: 'Pending' } },
      { status: 'done', files: [{ n: 1, mime: 'image/png', url: '/v1/media/job1/files/1' }], meta: { model: 'flux-2-pro', cost: 3 } },
    ]
    const events: unknown[] = []
    const p = gateMediaProvider({ baseUrl: base, apiKey: 'k', poll: 5 })
    const r = await p.generate({ model: 'flux', prompt: 'кот', refs: [PNG], params: { seed: 1 }, onProgress: (e) => events.push(e) })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.mime).toBe('image/png')
    expect([...r.value.images[0]]).toEqual([...PNG])
    expect(r.value.meta).toMatchObject({ cost: 3, gate: { id: 'job1' } })
    expect(posts[0].auth).toBe('Bearer k')
    expect(posts[0].body).toMatchObject({ model: 'flux', prompt: 'кот', params: { seed: 1 } })
    expect(posts[0].body.refs).toHaveLength(1)
    expect(events).toContainEqual({ stage: 'running', status: 'Pending' })
    expect(events.at(-1)).toEqual({ stage: 'done' })
  })

  it('failed: текст и статус провайдера, 429 → RateLimitError', async () => {
    script.polls = [{ status: 'failed', error: { message: 'bfl: 429 too many', status: 429 } }]
    const r = await gateMediaProvider({ baseUrl: base, poll: 5 }).generate({ model: 'flux', prompt: 'x' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.name).toBe('RateLimitError')
    expect(r.error.message).toContain('bfl: 429 too many')
    expect((r.error as Error & { status?: number }).status).toBe(429)
  })

  it('отказ гейта на POST — ошибка с его текстом', async () => {
    script.postStatus = 404
    const r = await gateMediaProvider({ baseUrl: base }).generate({ model: 'x', prompt: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toContain('no provider for model: x')
  })

  it('signal прекращает ожидание', async () => {
    script.polls = [{ status: 'running' }]
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 40)
    const r = await gateMediaProvider({ baseUrl: base, poll: 10 }).generate({ model: 'flux', prompt: 'x', signal: ac.signal })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toContain('прервано')
  })

  it('models: output → kind; schema: есть / нет модели', async () => {
    const p = gateMediaProvider({ baseUrl: base })
    const m = await p.models!()
    expect(m.ok && m.value).toEqual([{ id: 'flux', name: 'FLUX', kind: 'image', maxRefs: 4 }, { id: 'veo', kind: 'video', refRole: 'frames' }])
    const s = await p.schema!('flux')
    expect(s.ok && s.value?.maxRefs).toBe(4)
    const none = await p.schema!('nope')
    expect(none.ok).toBe(false)
  })
})
