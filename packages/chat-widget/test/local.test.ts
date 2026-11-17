/**
 * Транспорт `local`: `<nr-chat backend="local">` над бэкендом в
 * процессе страницы — без HTTP. Бэкенд отдан из JS (`localBackend`), ран и
 * апрув — как у `nr`; без provider-url и бэкенда — понятная ошибка.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createStoreBackend, type GenerateRequest } from '@kerneldreams/backend-http'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import { defineNrChat, mount, type NrChatElement } from '../src/element.js'

beforeAll(() => defineNrChat())
afterEach(() => document.body.replaceChildren())

const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('<nr-chat backend="local">', () => {
  it('ран и апрув через бэкенд страницы; сессия — в его сторе', async () => {
    let answer: unknown
    const store = createMemoryStore()
    const backend = createStoreBackend({
      store,
      ask: ['tool_approval'],
      async *generate(req: GenerateRequest) {
        yield { type: 'ask', askId: 'a1', kind: 'tool_approval', payload: { callId: 'c1', name: 'write', args: { path: 'a.txt' }, title: 'write a.txt' } }
        answer = await req.awaitAnswer!('a1')
        yield { type: 'text', delta: 'Готово' }
      },
    })
    const w: NrChatElement = mount(document.body, { backend: 'local', localBackend: backend })
    const session = new Promise<CustomEvent>((r) => w.addEventListener('session', (e) => r(e as CustomEvent), { once: true }))
    const sent = w.send('пиши')
    expect((await session).detail.transport).toBe('local')
    await until(() => !!w.shadowRoot!.querySelector('button[data-value="allow"]'))
    w.shadowRoot!.querySelector<HTMLButtonElement>('button[data-value="allow"]')!.click()
    await sent
    expect(answer).toBe('allow')
    w.feed.flushNow()
    expect(w.feed.messages.at(-1)!.role).toBe('assistant')
    expect((await store.list()).sessions.map((s) => s.id)).toEqual([w.sessionId])
    expect(w.localBackend).toBe(backend)
  })

  it('без provider-url и бэкенда — ошибка подключения', async () => {
    const w = mount(document.body, { backend: 'local' })
    const err = new Promise<CustomEvent>((r) => w.addEventListener('error', (e) => r(e as CustomEvent), { once: true }))
    expect((await err).detail.message).toMatch(/provider-url/)
  })
})
