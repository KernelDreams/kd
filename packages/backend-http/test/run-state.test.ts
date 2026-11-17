/**
 * состояние ранов — в KvStore, не в памяти процесса. Два бэкенда над
 * одним kv (как два запроса Worker'а): busy виден обоим, ответ на ask,
 * пришедший во «второй процесс», доходит до рана в первом.
 */

import { describe, expect, it } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import { createStoreBackend, type GenChunk, type GenerateRequest } from '../src/index.js'
import { createMemoryKv } from '../src/run-state.js'

describe('состояние ранов в kv', () => {
  it('busy общий для бэкендов над одним kv; ask-ответ из другого процесса', async () => {
    const kv = createMemoryKv()
    const store = createMemoryStore()
    let answered: unknown
    const generate = async function* (req: GenerateRequest): AsyncGenerator<GenChunk> {
      yield { type: 'ask', askId: 'q1', kind: 'text', payload: { question: '?' } }
      answered = await req.awaitAnswer!('q1')
      yield { type: 'text', delta: String(answered) }
    }
    const a = createStoreBackend({ store, generate, kv, ask: ['text'] })
    const b = createStoreBackend({ store, generate, kv, ask: ['text'] })
    const s = await a.sessions.create()
    const it = a.run(s.id, { userMessage: 'hi' })[Symbol.asyncIterator]()
    for (;;) {
      const ev = (await it.next()).value as { type: string }
      if (ev.type === 'ask') break
    }
    expect(await kv.list('runs/')).toEqual({ ok: true, value: [`runs/${s.id}`] })
    await expect(b.messages.append!(s.id, [{ type: 'text', text: 'x' }])).rejects.toMatchObject({ code: 'busy' })
    await b.respond!(s.id, 'q1', 'ответ')
    for (;;) if ((await it.next()).done) break
    expect(answered).toBe('ответ')
    expect(await kv.list('runs/')).toEqual({ ok: true, value: [] })
  }, 10_000)
})
