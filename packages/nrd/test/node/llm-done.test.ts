/**
 * helpers.llm — причина конца стрима: пустой ответ без причины не
 * разобрать, `onDone` отдаёт сырой `finish_reason` и `block_reason` провайдера.
 * Стрим OpenAI-совместимого провайдера — на локальном SSE-сервере.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { emptyContext } from '../../src/core/index.js'
import { buildHelpers, type LlmDone, type StreamChunk } from '../../src/node/helpers.js'
import { openaiProvider } from '../../src/web/llm/openai.js'

function helpersWith(stream: () => AsyncIterable<StreamChunk>) {
  return buildHelpers({
    ctx: emptyContext,
    meta: {} as never,
    decls: [],
    caps: {} as never,
    provider: { provider: { stream }, model: 'm', name: 'test' } as never,
    env: { render: (t) => t },
    runFn: async () => ({}) as never,
  })
}

describe('helpers.llm onDone', () => {
  it('пустой ответ: finish_reason SAFETY доезжает; поздний usage-done причину не затирает', async () => {
    const h = helpersWith(async function* () {
      yield { type: 'done', stop_reason: 'end_turn', finish_reason: 'SAFETY' }
      yield { type: 'done' }
    })
    let done: LlmDone | undefined
    const text = await h.llm([{ role: 'user', content: 'x' }], { onDone: (d) => (done = d) })
    expect(text).toBe('')
    expect(done).toEqual({ stop_reason: 'end_turn', finish_reason: 'SAFETY' })
  })
})

let server: ReturnType<typeof createServer>
let url = ''
let frames: unknown[] = []

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})
afterAll(() => server.close())

async function chunks(): Promise<unknown[]> {
  const p = openaiProvider({ baseUrl: url, apiKey: 'k' })
  const out: unknown[] = []
  for await (const c of p.stream!({ model: 'm', messages: [{ role: 'user', content: 'x' }] })) out.push(c)
  return out
}

describe('openai stream: сырые причины', () => {
  it('native_finish_reason важнее свёрнутого finish_reason', async () => {
    frames = [{ choices: [{ index: 0, delta: {}, finish_reason: 'stop', native_finish_reason: 'SAFETY' }] }]
    expect(await chunks()).toContainEqual({ type: 'done', stop_reason: 'end_turn', finish_reason: 'SAFETY' })
  })
  it('блокировка промпта без choices — done с block_reason', async () => {
    frames = [{ choices: [], promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }]
    expect(await chunks()).toContainEqual({ type: 'done', stop_reason: 'end_turn', block_reason: 'PROHIBITED_CONTENT' })
  })
})
