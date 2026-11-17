/**
 * createFetchHandler (board-edge-spec §5.2): ядро провода на Web
 * `Request`/`Response` без Node-сервера — capabilities, создание сессии, ран с
 * SSE, подхват идущего рана (attach), abort; и клиент поверх обработчика.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import { parseSSEStream, type AnyRunEvent } from '@kerneldreams/ui-protocol'
import { createStoreBackend, type GenerateFn } from '../src/store-backend.js'
import { createFetchHandler } from '../src/fetch-handler.js'
import { createHttpBackend } from '../src/client.js'

const BASE = 'http://edge.test/api'

/** Ход: текст, вызов тула, апрув (ask), после ответа — результат и итог. */
function approvalGen(): GenerateFn {
  return async function* (req) {
    yield { type: 'text', delta: 'Удаляю ' }
    yield { type: 'tool_call', callId: 'c1', name: 'bash', args: { command: 'rm x' } }
    yield { type: 'ask', askId: 'a1', kind: 'tool_approval', payload: { callId: 'c1', name: 'bash', args: { command: 'rm x' } } }
    const answer = (await req.awaitAnswer!('a1')) as { decision?: string }
    yield { type: 'tool_result', callId: 'c1', name: 'bash', text: answer?.decision === 'allow' ? 'removed' : 'denied' }
    yield { type: 'text', delta: 'Готово.' }
  }
}

function setup(generate: GenerateFn = approvalGen()) {
  const backend = createStoreBackend({ store: createMemoryStore(), generate, ask: ['tool_approval'] })
  const handle = createFetchHandler(backend, { basePath: '/api' })
  const call = (path: string, init?: RequestInit) => handle(new Request(`${BASE}${path}`, init))
  const post = (path: string, body: unknown) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { handle, call, post }
}

/** Читает SSE-тело до события, удовлетворяющего `pred`; поток после этого отменяется. */
async function readUntil(res: Response, pred: (text: string) => boolean): Promise<string> {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text
    text += dec.decode(value, { stream: true })
    if (pred(text)) {
      await reader.cancel()
      return text
    }
  }
}

describe('createFetchHandler', () => {
  it('capabilities и создание сессии — Envelope на Web Response', async () => {
    const { call, post } = setup()
    const caps = await call('/capabilities')
    expect(caps.status).toBe(200)
    expect(caps.headers.get('content-type')).toMatch(/application\/json/)
    const cbody = (await caps.json()) as { ok: boolean; result: { sessions?: unknown } }
    expect(cbody.ok).toBe(true)
    expect(cbody.result.sessions).toEqual({ archive: true, move: true, page: true, attach: true, live: true })

    const created = (await (await post('/sessions', { title: 'край' })).json()) as { ok: boolean; result: { id: string; title?: string } }
    expect(created.ok).toBe(true)
    const list = (await (await call('/sessions')).json()) as { result: Array<{ id: string }> }
    expect(list.result.map((s) => s.id)).toContain(created.result.id)
  })

  it('ошибки провода: чужой префикс, нет маршрута, плохой JSON, Node-only маршрут', async () => {
    const { handle, call } = setup()
    expect((await handle(new Request('http://edge.test/other'))).status).toBe(404)
    expect((await call('/nope')).status).toBe(404)
    const bad = await call('/sessions', { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { code?: string }).code).toBe('bad_request')
    // файлы пространства — Node-only, в ядро не входят
    expect((await call('/workspace/files')).status).toBe(404)
  })

  it('ран с SSE → ask; attach с другого «клиента» видит снимок; respond доводит ход', async () => {
    const { call, post } = setup()
    const sid = ((await (await post('/sessions', {})).json()) as { result: { id: string } }).result.id

    const run = await post(`/sessions/${sid}/run`, { userMessage: 'удали x' })
    expect(run.status).toBe(200)
    expect(run.headers.get('content-type')).toMatch(/text\/event-stream/)
    const runText = await readUntil(run, (t) => t.includes('event: ask'))
    expect(runText.startsWith(': keepalive')).toBe(true)
    const runEvents = parseSSEStream(runText)
    expect(runEvents.map((e) => e.type)).toContain('ask')
    // поток отменён посреди ask — ран жив (§5.4), второй ран — busy
    expect((await post(`/sessions/${sid}/run`, { userMessage: 'ещё' })).status).toBe(409)

    const attach = await call(`/sessions/${sid}/attach`)
    expect(attach.status).toBe(200)
    const reader = attach.body!.getReader()
    const dec = new TextDecoder()
    let text = ''
    while (!text.includes('event: ask')) {
      const { value, done } = await reader.read()
      if (done) break
      text += dec.decode(value, { stream: true })
    }
    expect(text).toContain('event: ask')

    expect((await post(`/sessions/${sid}/respond`, { askId: 'a1', answer: { decision: 'allow' } })).status).toBe(200)
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      text += dec.decode(value, { stream: true })
    }
    const events = parseSSEStream(text)
    expect(events.at(-1)?.type).toBe('run_end')
    expect((events.at(-1) as { status?: string }).status).toBe('done')

    const hist = (await (await call(`/sessions/${sid}/history`)).json()) as { result: { messages: Array<{ role: string }> } }
    expect(hist.result.messages.some((m) => m.role === 'assistant')).toBe(true)
  })

  it('abort: cancel по runId гасит ран, стрим кончается run_end', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { post } = setup(async function* (req) {
      yield { type: 'text', delta: 'начало ' }
      await Promise.race([gate, new Promise((r) => req.signal.addEventListener('abort', r))])
      if (req.signal.aborted) return
      yield { type: 'text', delta: 'конец' }
    })
    const sid = ((await (await post('/sessions', {})).json()) as { result: { id: string } }).result.id
    const run = await post(`/sessions/${sid}/run`, { userMessage: 'пиши' })
    const reader = run.body!.getReader()
    const dec = new TextDecoder()
    let text = ''
    let runId = ''
    while (!runId) {
      const { value, done } = await reader.read()
      if (done) break
      text += dec.decode(value, { stream: true })
      runId = parseSSEStream(text).find((e) => typeof e.runId === 'string' && e.runId !== '')?.runId ?? ''
    }
    expect(runId).not.toBe('')
    expect((await post(`/sessions/${sid}/cancel`, { runId })).status).toBe(200)
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      text += dec.decode(value, { stream: true })
    }
    release()
    const end = parseSSEStream(text).at(-1) as AnyRunEvent & { status?: string }
    expect(end.type).toBe('run_end')
    expect(end.status).toBe('cancelled')
    expect(text).not.toContain('конец')
  })

  it('клиент createHttpBackend поверх обработчика — без Node-сервера', async () => {
    const { handle } = setup(async function* () {
      yield { type: 'text', delta: 'привет с края' }
    })
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => handle(new Request(input, init))) as typeof fetch
    const client = createHttpBackend(BASE, { fetch: fetchImpl, capabilitiesTtl: 0 })
    const s = await client.sessions.create()
    const events: AnyRunEvent[] = []
    for await (const e of client.run(s.id, { userMessage: 'hi' })) events.push(e)
    expect(events.at(-1)?.type).toBe('run_end')
    const page = await client.history(s.id)
    expect(JSON.stringify(page.messages)).toContain('привет с края')
  })

  it('ключ доступа: без Bearer — 401, с ним — 200', async () => {
    const backend = createStoreBackend({ store: createMemoryStore(), generate: approvalGen() })
    const handle = createFetchHandler(backend, { authKey: 'key-1' })
    expect((await handle(new Request('http://e.test/capabilities'))).status).toBe(401)
    expect((await handle(new Request('http://e.test/capabilities', { headers: { authorization: 'Bearer key-1' } }))).status).toBe(200)
  })
})

describe('граница ядра провода', () => {
  it('fetch-handler и его импорты — без Node API (уезжает в Worker); serve.ts маршруты ядра не дублирует', () => {
    for (const f of ['fetch-handler.ts', 'run-attach.ts', 'wire.ts']) {
      const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')
      expect(src, f).not.toMatch(/from 'node:|\bBuffer\.|\bprocess\./)
    }
    const serve = readFileSync(new URL('../src/serve.ts', import.meta.url), 'utf8')
    expect(serve).not.toMatch(/segs\[0\] === 'sessions'|backend\.run\(|segs\[0\] === 'models'|segs\[0\] === 'profiles'/)
    expect(serve).toContain('core.route(')
  })
})
