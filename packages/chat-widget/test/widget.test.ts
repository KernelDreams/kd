/**
 * `<nr-chat>` в jsdom против настоящего бэкенда (createStoreBackend в памяти
 * за serveBackend): лента и стрим, карточки tool_call/результата, апрув
 * (allow / allow-session / deny), ask_user (выбор и текст), тул страницы,
 * снимок страницы в мете, ошибка рана, история существующей сессии, auth.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createAliveRegistry, createMemoryKv, createStoreBackend, serveBackend, SESSION_TOOLS_TTL_MS, type GenerateFn, type GenerateRequest, type ServeHandle } from '@kerneldreams/backend-http'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import type { ProtocolBackend } from '@kerneldreams/ui-protocol'
import { NrChatElement, defineNrChat, mount } from '../src/element.js'

beforeAll(() => defineNrChat())

let srv: ServeHandle | undefined
let backend: ProtocolBackend | undefined
/** kv бэкенда: отметки живости тулов страницы. */
let kv = createMemoryKv()
afterEach(async () => {
  document.body.replaceChildren()
  await srv?.close()
  srv = undefined
  backend = undefined
})

async function serve(gen: GenerateFn, extra: { authKey?: string } = {}): Promise<string> {
  kv = createMemoryKv()
  backend = createStoreBackend({ store: createMemoryStore(), generate: gen, kv, ask: ['text', 'select', 'permission', 'tool_approval', 'tool'], sessionTools: true, profiles: [{ id: 'agent', name: 'Agent' } as never] })
  srv = await serveBackend(backend, { cors: true, ...(extra.authKey ? { authKey: extra.authKey } : {}) })
  return srv.url
}

const shadow = (w: NrChatElement): ShadowRoot => w.shadowRoot!
const msgs = (w: NrChatElement) => [...shadow(w).querySelectorAll<HTMLElement>('.msg')]
const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}
const click = async (w: NrChatElement, selector: string): Promise<void> => {
  await until(() => !!shadow(w).querySelector(selector))
  ;(shadow(w).querySelector(selector) as HTMLButtonElement).click()
}

describe('<nr-chat> транспорт nr', () => {
  it('атрибуты → сессия с профилем; стрим текста и thinking-свёртка; событие message; markdown', async () => {
    const seen: GenerateRequest[] = []
    const url = await serve(async function* (req) {
      seen.push(req)
      yield { type: 'thinking', delta: 'думаю' }
      yield { type: 'text', delta: 'При' }
      yield { type: 'text', delta: 'вет, **мир**' }
    })
    const w = document.createElement('nr-chat') as NrChatElement
    w.setAttribute('backend', url)
    w.setAttribute('profile', 'agent')
    w.setAttribute('lang', 'en')
    document.body.append(w)
    await w.ready
    expect(w.sessionId).toBeTruthy()
    const events: string[] = []
    for (const n of ['run-start', 'run-end', 'message']) w.addEventListener(n, () => events.push(n))
    const done = new Promise<CustomEvent>((r) => w.addEventListener('message', (e) => r(e as CustomEvent), { once: true }))
    await w.send('hi')
    const msg = await done
    expect(msg.detail).toMatchObject({ role: 'assistant', text: 'Привет, **мир**' })
    expect(events).toEqual(['run-start', 'message', 'run-end'])
    expect(seen[0]!.session.profile).toBe('agent')
    w.feed.flushNow()
    const [user, answer] = msgs(w)
    expect(user!.dataset.role).toBe('user')
    expect(user!.textContent).toBe('hi')
    expect(answer!.querySelector('details.thinking summary')!.textContent).toBe('Thinking')
    expect(answer!.querySelector('.text')!.innerHTML).toBe('<p>Привет, <strong>мир</strong></p>')
    expect(shadow(w).querySelector('textarea')!.placeholder).toBe('Message…')
  })

  it('tool_call → карточка; апрув: allow, allow-session и deny доезжают решением', async () => {
    const answers: unknown[] = []
    const url = await serve(async function* (req) {
      for (const [i, title] of ['exec: ls', 'write a.txt', 'exec: rm'].entries()) {
        const callId = `c${i}`
        yield { type: 'tool_call', callId, name: 'exec', args: { command: title } }
        yield { type: 'ask', askId: `a${i}`, kind: 'tool_approval', payload: { callId, name: 'exec', args: {}, title, preview: { kind: 'command', command: 'ls', cwd: '/w' } } }
        const a = await req.awaitAnswer!(`a${i}`)
        answers.push(a)
        if (a === 'deny') yield { type: 'tool_error', callId, name: 'exec', message: 'denied' }
        else yield { type: 'tool_result', callId, name: 'exec', text: `ok ${i}` }
      }
      yield { type: 'text', delta: 'готово' }
    })
    const w = mount(document.body, { backend: url })
    const run = w.send('go')
    await click(w, '[data-ask-id="a0"] button.allow')
    await click(w, '[data-ask-id="a1"] button.session')
    await click(w, '[data-ask-id="a2"] button.deny')
    await run
    expect(answers).toEqual(['allow', 'allow_session', 'deny'])
    w.feed.flushNow()
    const cards = [...shadow(w).querySelectorAll<HTMLElement>('details.tool')]
    expect(cards.map((c) => c.dataset.status)).toEqual(['done', 'done', 'error'])
    expect(cards[0]!.querySelector('.result')!.textContent).toBe('ok 0')
    expect(shadow(w).querySelector('[data-ask-id="a0"] pre.preview')!.textContent).toBe('$ ls\n# /w')
    expect(shadow(w).querySelector('[data-ask-id="a1"] .answered')!.textContent).toContain('До конца сессии')
  })

  it('ask_user: выбор кнопкой и текст полем', async () => {
    const got: unknown[] = []
    const url = await serve(async function* (req) {
      yield { type: 'ask', askId: 's', kind: 'select', payload: { question: 'Цвет?', options: ['красный', 'синий'] } }
      got.push(await req.awaitAnswer!('s'))
      yield { type: 'ask', askId: 't', kind: 'text', payload: { question: 'Имя?' } }
      got.push(await req.awaitAnswer!('t'))
      yield { type: 'text', delta: 'ok' }
    })
    const w = mount(document.body, { backend: url })
    const run = w.send('?')
    await click(w, '[data-ask-id="s"] button[data-value="синий"]')
    await until(() => !!shadow(w).querySelector('[data-ask-id="t"] textarea'))
    const ta = shadow(w).querySelector('[data-ask-id="t"] textarea') as HTMLTextAreaElement
    ta.value = 'владелец'
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await run
    expect(got).toEqual(['синий', 'владелец'])
  })

  it('тул страницы: registerTool → sessionMeta.tools; вызов → обработчик → ответ модели; onContext → pageContext', async () => {
    let result: unknown
    let tools: unknown
    let page: unknown
    const url = await serve(async function* (req) {
      tools = req.tools
      page = req.sessionMeta?.pageContext
      yield { type: 'tool_call', callId: 'g1', name: 'get_state', args: { what: 'count' } }
      yield { type: 'ask', askId: 'k1', kind: 'tool', payload: { callId: 'g1', name: 'get_state', args: { what: 'count' } } }
      result = await req.awaitAnswer!('k1')
      yield { type: 'tool_result', callId: 'g1', name: 'get_state', text: (result as { text: string }).text }
      yield { type: 'text', delta: 'count=3' }
    })
    const w = mount(document.body, { backend: url })
    const calls: unknown[] = []
    w.addEventListener('tool-call', (e) => calls.push((e as CustomEvent).detail))
    w.registerTool({ name: 'get_state', description: 'Состояние страницы', schema: { type: 'object', properties: { what: { type: 'string' } } } }, (args) => ({ text: JSON.stringify({ count: 3, what: args.what }), data: { count: 3 } }))
    w.onContext(() => ({ scene: 'main', count: 3 }))
    await w.send('сколько?')
    expect(tools).toEqual([{ name: 'get_state', description: 'Состояние страницы', schema: { type: 'object', properties: { what: { type: 'string' } } }, executor: 'frontend' }])
    expect(page).toEqual({ scene: 'main', count: 3 })
    // Удар живости: страница отметилась — сейчас жива, через TTL без ударов — нет.
    const sid = (await backend!.sessions.list())[0]!.id
    expect((await createAliveRegistry(kv).live(sid))({ name: 'get_state' })).toBe(true)
    expect((await createAliveRegistry(kv, () => Date.now() + SESSION_TOOLS_TTL_MS + 1_000).live(sid))({ name: 'get_state' })).toBe(false)
    expect(result).toEqual({ text: '{"count":3,"what":"count"}', data: { count: 3 } })
    expect(calls).toContainEqual({ name: 'get_state', args: { what: 'count' }, callId: 'g1', page: true })
    w.feed.flushNow()
    expect(shadow(w).querySelector('details.tool .badge')!.textContent).toBe('тул страницы')
  })

  it('ошибка рана — сообщение ошибки в ленте, run-end error', async () => {
    const url = await serve(async function* () {
      yield { type: 'text', delta: 'начал' }
      throw new Error('провайдер упал')
    })
    const w = mount(document.body, { backend: url })
    const end = new Promise<CustomEvent>((r) => w.addEventListener('run-end', (e) => r(e as CustomEvent), { once: true }))
    await w.send('x')
    expect((await end).detail.status).toBe('error')
    w.feed.flushNow()
    expect(shadow(w).querySelector('.msg.error')!.textContent).toContain('провайдер упал')
  })

  it('существующая сессия: история в ленту (тул с результатом)', async () => {
    const url = await serve(async function* () {
      yield { type: 'tool_call', callId: 'h1', name: 'read', args: { path: 'a.md' } }
      yield { type: 'tool_result', callId: 'h1', name: 'read', text: 'содержимое' }
      yield { type: 'text', delta: 'прочитал' }
    })
    const s = await backend!.sessions.create()
    for await (const _ of backend!.run(s.id, { userMessage: 'прочти' })) void _
    const w = mount(document.body, { backend: url, session: s.id })
    await w.ready
    w.feed.flushNow()
    expect(msgs(w).map((m) => m.dataset.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(shadow(w).querySelector('details.tool')!.getAttribute('data-status')).toBe('done')
    expect(shadow(w).querySelector('details.tool .result')!.textContent).toBe('содержимое')
  })

  it('auth: с ключом работает, без ключа — ошибка подключения', async () => {
    const url = await serve(async function* () {
      yield { type: 'text', delta: 'ok' }
    }, { authKey: 'test-key-1' })
    const ok = mount(document.body, { backend: url, auth: 'test-key-1' })
    await ok.send('x')
    expect(ok.feed.messages.at(-1)!.blocks).toEqual([{ kind: 'text', text: 'ok' }])
    const bad = mount(document.body, { backend: url })
    const err = new Promise<CustomEvent>((r) => bad.addEventListener('error', (e) => r(e as unknown as CustomEvent), { once: true }))
    await bad.ready
    expect((await err).detail.message).toMatch(/unauthorized/)
  })

  it('стоп: отмена посреди стрима — run-end cancelled', async () => {
    const url = await serve(async function* (req) {
      yield { type: 'text', delta: 'долго' }
      await new Promise<void>((r) => req.signal.addEventListener('abort', () => r()))
    })
    const w = mount(document.body, { backend: url })
    const end = new Promise<CustomEvent>((r) => w.addEventListener('run-end', (e) => r(e as CustomEvent), { once: true }))
    const run = w.send('x')
    await until(() => w.feed.messages.some((m) => m.role === 'assistant' && m.blocks.length > 0))
    expect(shadow(w).querySelector('button.send')!.textContent).toBe('Стоп')
    ;(shadow(w).querySelector('button.send') as HTMLButtonElement).click()
    await run
    expect((await end).detail.status).toBe('cancelled')
  })
})
