/**
 * Обработчик гритинга на хосте (v1.70, §6): служебная команда `greeting`
 * кладёт вариант сиблингом гритинга (активным) или свайпает на совпавший по мете.
 */
import { describe, expect, it } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import type { AnyRunEvent } from '@kerneldreams/ui-protocol'
import { createStoreBackend } from '../src/store-backend.js'

async function drain(it: AsyncIterable<AnyRunEvent>): Promise<AnyRunEvent[]> {
  const out: AnyRunEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

describe('служебная команда greeting', () => {
  it('новый сиблинг с метой и активный; повтор — свайп на тот же, без дубля', async () => {
    let calls = 0
    const backend = createStoreBackend({
      store: createMemoryStore(),
      name: 'fixture',
      commands: ['greeting'],
      generate: async function* (req) {
        const id = req.command!.options!.messageId as string
        calls++
        yield { type: 'sibling', of: id, match: { 'generated.key': 'k1' }, text: 'Привет по-русски.', meta: { generated: { of: 0, vars: { language: 'ru' }, key: 'k1' } } }
      },
    })
    const s = await backend.sessions.create()
    const g = await backend.messages!.append!(s.id, [{ type: 'text', text: 'Hello.' }], { role: 'assistant' })
    const ev = await drain(backend.run(s.id, { command: { name: 'greeting', options: { messageId: g.id } } }))
    const act = ev.find((e) => e.type === 'activity') as { payload: { id: string } } | undefined
    expect(act).toBeTruthy()
    let path = (await backend.history(s.id)).messages
    expect(path).toHaveLength(1)
    expect(path[0]!.id).toBe(act!.payload.id)
    expect(path[0]!.meta?.generated).toMatchObject({ of: 0, vars: { language: 'ru' } })
    // Оригинал не подменён: свайпом назад — он.
    const back = await backend.messages!.swipe!(s.id, path[0]!.id, { index: 0 })
    expect(back.parts).toEqual([{ type: 'text', text: 'Hello.' }])
    await drain(backend.run(s.id, { command: { name: 'greeting', options: { messageId: g.id } } }))
    path = (await backend.history(s.id)).messages
    expect(path[0]!.id).toBe(act!.payload.id)
    expect(calls).toBe(2)
    const info = (await backend.history(s.id)).messages[0]!
    expect(info.swipes ?? { count: 2 }).toMatchObject({ count: 2 })
  })
})
