/**
 * Агентный ран createStoreBackend (backend-nr-spec §7, добавлением): чанки
 * tool_call / tool_result / tool_error пишут несколько сообщений за ран
 * (ответ → результаты тулов → ответ), ask ждёт respond, generate получает
 * профиль документом и тулы сессии.
 */

import { describe, expect, it } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import type { AnyRunEvent } from '@kerneldreams/ui-protocol'
import { createStoreBackend, type GenChunk, type GenerateFn, type GenerateRequest } from '../src/store-backend.js'
import { createAliveRegistry, createMemoryKv, SESSION_TOOLS_TTL_MS } from '../src/run-state.js'

async function drain(it: AsyncIterable<AnyRunEvent>): Promise<AnyRunEvent[]> {
  const out: AnyRunEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

function gen(chunks: GenChunk[], onRequest?: (req: GenerateRequest) => void): GenerateFn {
  return async function* (req) {
    onRequest?.(req)
    for (const c of chunks) yield c
  }
}

const TOOL_RUN: GenChunk[] = [
  { type: 'text', delta: 'Ищу.' },
  { type: 'tool_call', callId: 'c1', name: 'web_search', args: { query: 'x' } },
  { type: 'tool_call', callId: 'c2', name: 'web_fetch', args: { url: 'u' } },
  { type: 'usage', input: 10, output: 2 },
  { type: 'tool_result', callId: 'c1', name: 'web_search', text: 'hits' },
  { type: 'tool_error', callId: 'c2', name: 'web_fetch', message: 'blocked' },
  { type: 'text', delta: 'Готово.' },
  { type: 'usage', input: 20, output: 5 },
]

describe('агентный ран: несколько сообщений', () => {
  it('ответ с вызовами → результаты role tool → итоговый ответ; запись по порядку', async () => {
    const store = createMemoryStore()
    const backend = createStoreBackend({ store, generate: gen(TOOL_RUN) })
    const s = await backend.sessions.create()
    const events = await drain(backend.run(s.id, { userMessage: 'q' }))

    const ends = events.filter((e) => e.type === 'message_end') as Array<{ message: { role: string; parts: Array<{ type: string }> } }>
    expect(ends.map((e) => e.message.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant'])
    expect(ends[1]!.message.parts.map((p) => p.type)).toEqual(['text', 'tool_use', 'tool_use'])
    expect(ends[3]!.message.parts[0]).toMatchObject({ type: 'tool_result', text: 'blocked', meta: { callId: 'c2', error: true } })

    const runEnd = events.at(-1) as { type: string; status: string; usage?: unknown }
    expect(runEnd).toMatchObject({ type: 'run_end', status: 'done', usage: { input: 30, output: 7 } })

    const hist = await backend.history(s.id)
    expect(hist.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant'])
    // Цепочка: каждая нода — ребёнок предыдущей.
    const nodes = (await store.load(s.id)).nodes
    for (let i = 1; i < nodes.length; i++) expect(nodes[i]!.parent).toBe(nodes[i - 1]!.id)
    expect(hist.messages[1]!.meta?.usage).toEqual({ input: 10, output: 2 })
    expect(hist.messages[4]!.meta?.usage).toEqual({ input: 20, output: 5 })
  })

  it('субагент (v1.60, ABC-616): parent у вызова и результата, subagentContext — в мете части', async () => {
    const store = createMemoryStore()
    const backend = createStoreBackend({
      store,
      generate: gen([
        { type: 'tool_call', callId: 'a1', name: 'Agent', args: { description: 'читатель' } },
        { type: 'tool_call', callId: 'r1', name: 'Read', args: { path: 'x' }, parent: 'a1' },
        { type: 'tool_result', callId: 'r1', name: 'Read', text: 'текст', parent: 'a1', subagentContext: 12000 },
        { type: 'tool_result', callId: 'a1', name: 'Agent', text: 'итог', subagentContext: 15000 },
      ]),
    })
    const s = await backend.sessions.create()
    const events = await drain(backend.run(s.id, { userMessage: 'q' }))
    const starts = events.filter((e) => e.type === 'part_start') as Array<{ meta?: { callId?: string; parent?: string } }>
    expect(starts.find((e) => e.meta?.callId === 'r1')?.meta?.parent).toBe('a1')
    const hist = await backend.history(s.id)
    const parts = hist.messages.flatMap((m) => m.parts) as Array<{ type: string; meta?: Record<string, unknown> }>
    expect(parts.find((p) => p.type === 'tool_use' && p.meta?.callId === 'r1')?.meta).toEqual({ callId: 'r1', name: 'Read', parent: 'a1' })
    expect(parts.find((p) => p.type === 'tool_result' && p.meta?.callId === 'r1')?.meta).toEqual({ callId: 'r1', name: 'Read', parent: 'a1', subagentContext: 12000 })
    expect(parts.find((p) => p.type === 'tool_use' && p.meta?.callId === 'a1')?.meta).toEqual({ callId: 'a1', name: 'Agent' })
    expect(parts.find((p) => p.type === 'tool_result' && p.meta?.callId === 'a1')?.meta).toEqual({ callId: 'a1', name: 'Agent', subagentContext: 15000 })
  })

  it('note (ABC-305): рассуждение ответа пишется, заметка — отдельным сообщением вне контекста; ран не ошибка', async () => {
    const store = createMemoryStore()
    let second: GenerateRequest | undefined
    const backend = createStoreBackend({
      store,
      generate: async function* (req) {
        if (second === undefined && req.messages.length > 1) second = req
        if (req.messages.length > 1) return yield { type: 'text', delta: 'ок' }
        yield { type: 'tool_call', callId: 'c1', name: 't', args: {} }
        yield { type: 'tool_result', callId: 'c1', name: 't', text: 'ok' }
        yield { type: 'thinking', delta: 'думаю…' }
        yield { type: 'usage', input: 5, output: 9 }
        yield { type: 'note', text: 'модель вернула пустой ответ (только размышления)' }
      },
    })
    const s = await backend.sessions.create()
    const events = await drain(backend.run(s.id, { userMessage: 'q' }))
    expect(events.at(-1)).toMatchObject({ type: 'run_end', status: 'done' })
    const ends = events.filter((e) => e.type === 'message_end') as Array<{ message: { role: string; parts: Array<{ type: string; text?: string }>; flags?: { disabled?: boolean } } }>
    expect(ends.map((e) => e.message.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'assistant'])
    expect(ends[3]!.message.parts).toEqual([{ type: 'thinking', text: 'думаю…' }])
    expect(ends[4]!.message.parts).toEqual([{ type: 'text', text: 'модель вернула пустой ответ (только размышления)' }])
    expect(ends[4]!.message.flags?.disabled).toBe(true)
    const hist = await backend.history(s.id)
    expect(hist.messages[3]!.meta?.usage).toEqual({ input: 5, output: 9 })
    // Следующий ран: заметки в контексте нет.
    await drain(backend.run(s.id, { userMessage: 'дальше' }))
    expect(second!.messages.some((m) => m.parts.some((p) => 'text' in p && p.text?.startsWith('модель вернула')))).toBe(false)
  })

  it('usage с кэшем и контекстом (ABC-275): в meta ответа как есть; итог — сумма кэша, контекст последний', async () => {
    const backend = createStoreBackend({
      store: createMemoryStore(),
      generate: gen([
        { type: 'text', delta: 'a' },
        { type: 'usage', input: 3, output: 1, cacheRead: 100, cacheWrite: 7, context: { used: 110, size: 200000 } },
        { type: 'tool_call', callId: 'c1', name: 't', args: {} },
        { type: 'tool_result', callId: 'c1', name: 't', text: 'ok' },
        { type: 'text', delta: 'b' },
        { type: 'usage', input: 2, output: 4, cacheRead: 110, context: { used: 116, size: 200000 } },
      ]),
    })
    const s = await backend.sessions.create()
    const events = await drain(backend.run(s.id, { userMessage: 'q' }))
    expect(events.at(-1)).toMatchObject({ usage: { input: 5, output: 5, cacheRead: 210, cacheWrite: 7, context: { used: 116, size: 200000 } } })
    const hist = await backend.history(s.id)
    expect(hist.messages[1]!.meta?.usage).toEqual({ input: 3, output: 1, cacheRead: 100, cacheWrite: 7, context: { used: 110, size: 200000 } })
    expect(hist.messages[3]!.meta?.usage).toEqual({ input: 2, output: 4, cacheRead: 110, context: { used: 116, size: 200000 } })
  })

  it('превью тула (ABC-294): tool_call_start → part_start сразу, дельты аргументов → part_delta той же части, итог — part_end туда же', async () => {
    const backend = createStoreBackend({
      store: createMemoryStore(),
      generate: gen([
        { type: 'text', delta: 'Пишу.' },
        { type: 'tool_call_start', stream: '1:1', name: 'write' },
        { type: 'tool_call_delta', stream: '1:1', delta: '{"path":"a.ts",' },
        { type: 'tool_call_delta', stream: '1:1', delta: '"content":"x\\ny"}' },
        { type: 'tool_call_delta', stream: 'чужой', delta: 'мимо' },
        { type: 'tool_call', callId: 'c1', name: 'write', args: { path: 'a.ts', content: 'x\ny' }, stream: '1:1' },
        { type: 'tool_call', callId: 'c2', name: 'read', args: { path: 'b' } },
        { type: 'tool_result', callId: 'c1', name: 'write', text: 'ok' },
        { type: 'tool_result', callId: 'c2', name: 'read', text: 'b' },
      ]),
    })
    const s = await backend.sessions.create()
    const events = await drain(backend.run(s.id, { userMessage: 'q' }))
    const tool = events.filter((e) => (e.type === 'part_start' || e.type === 'part_delta' || e.type === 'part_end') && (e as { part: number }).part >= 2)
    expect(tool.map((e) => [e.type, (e as { part: number }).part])).toEqual([
      ['part_start', 2],
      ['part_delta', 2],
      ['part_delta', 2],
      ['part_end', 2],
      ['part_start', 3],
      ['part_end', 3],
    ])
    expect(tool[0]).toMatchObject({ partType: 'tool_use', meta: { name: 'write', callId: 'stream:1:1' } })
    expect(tool[3]).toMatchObject({ payload: { type: 'tool_use', data: { path: 'a.ts' }, meta: { callId: 'c1', name: 'write' } } })
    // Запись — как без превью: итоговые вызовы, по порядку.
    const hist = await backend.history(s.id)
    expect(hist.messages[1]!.parts.map((p) => [p.type, (p as { meta?: { callId?: string } }).meta?.callId])).toEqual([
      ['text', undefined],
      ['tool_use', 'c1'],
      ['tool_use', 'c2'],
    ])
  })

  it('превью тула, оборванное отменой/ошибкой без итога, в запись не попадает', async () => {
    const backend = createStoreBackend({
      store: createMemoryStore(),
      generate: gen([
        { type: 'text', delta: 'a' },
        { type: 'tool_call_start', stream: '1:1', name: 'write' },
        { type: 'tool_call_delta', stream: '1:1', delta: '{"path"', replace: true },
      ]),
    })
    const s = await backend.sessions.create()
    const events = await drain(backend.run(s.id, { userMessage: 'q' }))
    expect(events.find((e) => e.type === 'part_delta' && (e as { part: number }).part === 2)).toMatchObject({ mode: 'replace' })
    const hist = await backend.history(s.id)
    expect(hist.messages[1]!.parts.map((p) => p.type)).toEqual(['text'])
  })

  it('id-first: message_start каждого сообщения несёт id, под которым оно записано', async () => {
    const backend = createStoreBackend({ store: createMemoryStore(), generate: gen(TOOL_RUN) })
    const s = await backend.sessions.create()
    const events = await drain(backend.run(s.id, { userMessage: 'q' }))
    const starts = events.filter((e) => e.type === 'message_start').map((e) => (e as { message: { id: string } }).message.id)
    const ends = events.filter((e) => e.type === 'message_end').map((e) => (e as { message: { id: string } }).message.id)
    expect(ends).toEqual(starts)
    expect(new Set(starts).size).toBe(starts.length)
  })

  it('regenerate: цепочка рана — новая ветка от родителя, лист — её конец', async () => {
    const store = createMemoryStore()
    let chunks: GenChunk[] = [{ type: 'text', delta: 'первый' }]
    const backend = createStoreBackend({ store, generate: (req) => gen(chunks)(req) })
    const s = await backend.sessions.create()
    await drain(backend.run(s.id, { userMessage: 'q' }))
    const first = (await backend.history(s.id)).messages.at(-1)!
    chunks = TOOL_RUN
    await drain(backend.run(s.id, { regenerate: { messageId: first.id } }))
    const hist = await backend.history(s.id)
    expect(hist.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant'])
    expect(hist.messages.map((m) => m.id)).not.toContain(first.id)
  })

  it('cancel после результатов тулов: записано то, что успело, статус cancelled', async () => {
    const store = createMemoryStore()
    const backend = createStoreBackend({
      store,
      generate: async function* (req) {
        yield { type: 'tool_call', callId: 'c1', name: 't', args: {} }
        yield { type: 'tool_result', callId: 'c1', name: 't', text: 'ok' }
        yield { type: 'text', delta: 'част' }
        if (!req.signal.aborted) await new Promise<void>((resolve) => req.signal.addEventListener('abort', () => resolve()))
      },
    })
    const s = await backend.sessions.create()
    const events: AnyRunEvent[] = []
    for await (const ev of backend.run(s.id, { userMessage: 'q' })) {
      events.push(ev)
      if (ev.type === 'part_delta') await backend.cancel(s.id, (ev as { runId: string }).runId)
    }
    expect(events.at(-1)).toMatchObject({ type: 'run_end', status: 'cancelled' })
    const hist = await backend.history(s.id)
    expect(hist.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect((await store.load(s.id)).nodes.at(-1)!.meta?.cancelled).toBe(true)
  })

  it('ошибка генерации после тулов: записанное остаётся, открытый ответ — нет', async () => {
    const backend = createStoreBackend({
      store: createMemoryStore(),
      generate: async function* () {
        yield { type: 'tool_call', callId: 'c1', name: 't', args: {} }
        yield { type: 'tool_result', callId: 'c1', name: 't', text: 'ok' }
        yield { type: 'text', delta: 'полу' }
        throw new Error('HTTP 503 all_fallbacks_failed')
      },
    })
    const s = await backend.sessions.create()
    const events = await drain(backend.run(s.id, { userMessage: 'q' }))
    expect(events.at(-1)).toMatchObject({ type: 'run_end', status: 'error', error: { message: 'HTTP 503 all_fallbacks_failed' } })
    expect((await backend.history(s.id)).messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
  })
})

describe('отмена не ждёт генерацию', () => {
  it('generate, игнорирующий сигнал, не держит ран: cancelled с частичным', async () => {
    const store = createMemoryStore()
    const backend = createStoreBackend({
      store,
      generate: async function* () {
        yield { type: 'text', delta: 'част' }
        await new Promise(() => {})
      },
    })
    const s = await backend.sessions.create()
    const events: AnyRunEvent[] = []
    for await (const ev of backend.run(s.id, { userMessage: 'q' })) {
      events.push(ev)
      if (ev.type === 'part_delta') setTimeout(() => void backend.cancel(s.id, (ev as { runId: string }).runId), 5)
    }
    expect(events.at(-1)).toMatchObject({ type: 'run_end', status: 'cancelled' })
    expect((await store.load(s.id)).nodes.at(-1)!.parts[0]).toMatchObject({ type: 'text', text: 'част' })
  })
})

describe('ask / respond', () => {
  function askingGen(): GenerateFn {
    return async function* (req) {
      yield { type: 'ask', askId: 'a1', kind: 'text', payload: { question: 'Как зовут?' } }
      const answer = await req.awaitAnswer!('a1')
      yield { type: 'text', delta: `Привет, ${String(answer)}` }
    }
  }

  it('capability ask и respond — ровно при опции', async () => {
    const plain = createStoreBackend({ store: createMemoryStore(), generate: gen([]) })
    expect((await plain.capabilities()).ask).toBeUndefined()
    expect(plain.respond).toBeUndefined()
    const asking = createStoreBackend({ store: createMemoryStore(), generate: gen([]), ask: ['text', 'select'], sessionTools: true })
    const caps = await asking.capabilities()
    expect(caps.ask).toEqual(['text', 'select'])
    expect(caps.tools).toEqual({ session: true })
    expect(typeof asking.respond).toBe('function')
  })

  it('ask-событие → respond → генерация продолжается с ответом', async () => {
    const backend = createStoreBackend({ store: createMemoryStore(), generate: askingGen(), ask: ['text'] })
    const s = await backend.sessions.create()
    const events: AnyRunEvent[] = []
    for await (const ev of backend.run(s.id, { userMessage: 'q' })) {
      events.push(ev)
      if (ev.type === 'ask') {
        expect(ev).toMatchObject({ askId: 'a1', kind: 'text', payload: { question: 'Как зовут?' } })
        setTimeout(() => void backend.respond!(s.id, 'a1', 'владелец'), 5)
      }
    }
    expect(events.at(-1)).toMatchObject({ type: 'run_end', status: 'done' })
    expect((await backend.history(s.id)).messages.at(-1)!.parts[0]).toMatchObject({ type: 'text', text: 'Привет, владелец' })
  })

  it('cancel во время ожидания ответа: awaitAnswer отвергается, ран cancelled', async () => {
    let rejected: unknown
    const backend = createStoreBackend({
      store: createMemoryStore(),
      ask: ['text'],
      generate: async function* (req) {
        yield { type: 'text', delta: 'Вопрос:' }
        yield { type: 'ask', askId: 'a1', kind: 'text', payload: {} }
        try {
          await req.awaitAnswer!('a1')
        } catch (err) {
          rejected = err
        }
      },
    })
    const s = await backend.sessions.create()
    const events: AnyRunEvent[] = []
    for await (const ev of backend.run(s.id, { userMessage: 'q' })) {
      events.push(ev)
      if (ev.type === 'ask') setTimeout(() => void backend.cancel(s.id, (ev as { runId: string }).runId), 5)
    }
    expect(events.at(-1)).toMatchObject({ type: 'run_end', status: 'cancelled' })
    expect((rejected as Error).name).toBe('AbortError')
  })

  it('respond без живого рана — bad_request', async () => {
    const backend = createStoreBackend({ store: createMemoryStore(), generate: gen([]), ask: ['text'] })
    const s = await backend.sessions.create()
    await expect(backend.respond!(s.id, 'a1', 'x')).rejects.toMatchObject({ code: 'bad_request' })
  })
})

describe('generate получает профиль и тулы сессии', () => {
  it('профиль каталога документом, встроенный — тоже; тулы — из sessionMeta.tools', async () => {
    let req: GenerateRequest | undefined
    const store = createMemoryStore()
    const backend = createStoreBackend({
      store,
      generate: gen([{ type: 'text', delta: 'ok' }], (r) => (req = r)),
      profiles: [
        { id: 'chat', name: 'Chat', systemPrompt: 'Ты — собеседник.' },
        { id: 'web', name: 'Web', tools: ['web_search'] },
      ],
    })
    const s = await backend.sessions.create()
    await drain(backend.run(s.id, { userMessage: 'q' }))
    expect(req!.profile).toMatchObject({ id: 'chat', systemPrompt: 'Ты — собеседник.' })

    await backend.profiles!.set!(s.id, 'web')
    await drain(backend.run(s.id, { userMessage: 'q' }))
    expect(req!.profile).toMatchObject({ id: 'web', tools: ['web_search'] })

    await backend.profiles!.set!(s.id, { name: 'Inline', tools: 'none' })
    await drain(backend.run(s.id, { userMessage: 'q' }))
    expect(req!.profile).toMatchObject({ id: 'inline', name: 'Inline', tools: 'none' })
    expect(req!.tools).toBeUndefined()

    const decl = { name: 'paint', description: 'рисует', schema: { type: 'object' }, executor: 'frontend' as const, artifactId: 'a1' }
    await backend.meta!.patch(s.id, { tools: [decl] })
    await drain(backend.run(s.id, { userMessage: 'q' }))
    expect(req!.tools).toEqual([decl])
  })

  it('без каталога профилей — поля profile нет', async () => {
    let req: GenerateRequest | undefined
    const backend = createStoreBackend({ store: createMemoryStore(), generate: gen([], (r) => (req = r)) })
    const s = await backend.sessions.create()
    await drain(backend.run(s.id, { userMessage: 'q' }))
    expect(req && 'profile' in req).toBe(false)
    expect(req!.awaitAnswer).toBeUndefined()
  })
})

describe('живость исполнителей тулов сессии (ABC-228)', () => {
  it('toolsAlive — в kv, не в документ; протухшая отметка — тул не в ране; без отметки — жив', async () => {
    const seen: Array<string[] | undefined> = []
    const kv = createMemoryKv()
    const backend = createStoreBackend({ store: createMemoryStore(), generate: gen([{ type: 'text', delta: 'ок' }], (req) => void seen.push(req.tools?.map((t) => t.name))), sessionTools: true, kv })
    const s = await backend.sessions.create()
    await backend.meta!.patch(s.id, { tools: [{ name: 'page_tool' }, { name: 'art_tool', artifactId: 'demo/x' }, { name: 'legacy_tool' }] })
    const doc = await backend.meta!.patch(s.id, { toolsAlive: { page_tool: 1, 'demo/x': 1 } })
    expect(doc.toolsAlive).toBeUndefined()
    expect((await backend.meta!.get(s.id)).toolsAlive).toBeUndefined()
    for await (const _ of backend.run(s.id, { userMessage: 'q' })) { /* drain */ }
    expect(seen.at(-1)).toEqual(['page_tool', 'art_tool', 'legacy_tool'])

    // Время ушло за TTL: страница стучит, артефакт — нет (вкладку убили).
    const later = createAliveRegistry(kv, () => Date.now() + SESSION_TOOLS_TTL_MS + 1_000)
    await later.mark(s.id, { page_tool: 1 })
    const live = await later.live(s.id)
    expect([live({ name: 'page_tool' }), live({ name: 'art_tool', artifactId: 'demo/x' }), live({ name: 'legacy_tool' })]).toEqual([true, false, true])
  })

  it('удар посреди рана — не busy; протухший исполнитель выкидывается перед раном', async () => {
    let now = Date.now()
    const kv = createMemoryKv()
    const seen: Array<string[] | undefined> = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const backend = createStoreBackend({
      store: createMemoryStore(),
      sessionTools: true,
      kv,
      generate: async function* (req) {
        seen.push(req.tools?.map((t) => t.name))
        await gate
        yield { type: 'text', delta: 'ок' }
      },
    })
    const s = await backend.sessions.create()
    await backend.meta!.patch(s.id, { tools: [{ name: 'dead_tool' }], toolsAlive: { dead_tool: now } })
    const it = backend.run(s.id, { userMessage: 'q' })[Symbol.asyncIterator]()
    await it.next()
    await expect(backend.meta!.patch(s.id, { toolsAlive: { dead_tool: now } })).resolves.toBeDefined()
    await expect(backend.meta!.patch(s.id, { notes: 'x' })).rejects.toMatchObject({ code: 'busy' })
    release()
    while (!(await it.next()).done) { /* drain */ }
    expect(seen[0]).toEqual(['dead_tool'])
    // Подделать «давно»: отметка старше TTL — следующий ран тула не видит.
    now -= SESSION_TOOLS_TTL_MS + 5_000
    await createAliveRegistry(kv, () => now).mark(s.id, { dead_tool: 1 })
    for await (const _ of backend.run(s.id, { userMessage: 'q2' })) { /* drain */ }
    expect(seen[1]).toEqual([])
  })
})
