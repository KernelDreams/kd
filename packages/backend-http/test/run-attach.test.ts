/**
 * Подхват идущего рана (run-resume-spec §1, протокол v1.31): поток, начавший
 * ран, оборвался посреди ask — ран ждёт; `get` показывает `run.waiting`;
 * `attach` с другого клиента — снимок (незакрытое сообщение, тулы, ask) и
 * живой поток; ответ любого подписчика гасит ask у всех и ведёт ход дальше.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import { createNrChatStore } from '@kerneldreams/chat-store/nr-chat'
import type { AnyRunEvent, ProtocolBackend } from '@kerneldreams/ui-protocol'
import { createStoreBackend, type GenerateFn } from '../src/store-backend.js'
import { serveBackend, type ServeHandle } from '../src/serve.js'
import { createHttpBackend } from '../src/client.js'
import { createHub } from '../src/hub.js'
import { withRunAttach } from '../src/run-attach.js'

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  while (closers.length) await closers.pop()!()
})

/** Ход: текст, вызов тула, апрув (ask), после ответа — результат и итог. */
function approvalGen(): GenerateFn {
  return async function* (req) {
    yield { type: 'text', delta: 'Удаляю ' }
    yield { type: 'text', delta: 'файл.' }
    yield { type: 'tool_call', callId: 'c1', name: 'bash', args: { command: 'rm x' } }
    yield { type: 'ask', askId: 'a1', kind: 'tool_approval', payload: { callId: 'c1', name: 'bash', args: { command: 'rm x' } } }
    const answer = (await req.awaitAnswer!('a1')) as { decision?: string }
    yield { type: 'tool_result', callId: 'c1', name: 'bash', text: answer?.decision === 'allow' ? 'removed' : 'denied' }
    yield { type: 'text', delta: 'Готово.' }
  }
}

async function served(backend: ProtocolBackend): Promise<{ srv: ServeHandle; client: () => ProtocolBackend }> {
  const srv = await serveBackend(backend, { port: 0 })
  closers.push(() => srv.close())
  return { srv, client: () => createHttpBackend(srv.url, { capabilitiesTtl: 0 }) }
}

async function until<T>(it: AsyncIterator<T>, pred: (v: T) => boolean): Promise<T[]> {
  const out: T[] = []
  for (;;) {
    const r = await it.next()
    if (r.done) return out
    out.push(r.value)
    if (pred(r.value)) return out
  }
}

async function waitFor(pred: () => Promise<boolean> | boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('waitFor: таймаут')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('подхват идущего рана по HTTP', () => {
  it('поток оборвался на ask → get: run.waiting → attach другим клиентом: снимок + ask → ответ → ход дальше', async () => {
    const backend = createStoreBackend({ store: createMemoryStore(), generate: approvalGen(), ask: ['tool_approval'] })
    const { client } = await served(backend)
    const a = client()
    expect((await a.capabilities()).sessions).toEqual({ archive: true, move: true, page: true, attach: true, live: true })
    const s = await a.sessions.create()

    // Вкладка A: ран до ask и — обрыв (return итератора рвёт fetch).
    const itA = a.run(s.id, { userMessage: 'удали x' })[Symbol.asyncIterator]()
    const seenA = await until(itA, (e) => e.type === 'ask')
    const runId = (seenA[0] as { runId: string }).runId
    await itA.return!()

    // Ран жив и ждёт человека.
    await waitFor(async () => (await a.sessions.get(s.id)).run?.waiting === 'ask')
    const info = await a.sessions.get(s.id)
    expect(info.run).toMatchObject({ id: runId, waiting: 'ask' })
    expect(typeof info.run!.startedAt).toBe('string')
    expect((await a.sessions.list()).find((x) => x.id === s.id)?.run?.id).toBe(runId)

    // Вкладка B (другое устройство): снимок.
    const b = client()
    const itB = b.sessions.attach!(s.id)[Symbol.asyncIterator]()
    const snap = await until(itB, (e) => e.type === 'ask')
    expect(snap[0]).toEqual({ type: 'run_start', runId })
    // Реплика пользователя — закрыта; ответ ассистента — открыт: текст суммой, тул с аргументами.
    expect(snap.filter((e) => e.type === 'message_end').map((e) => (e as { message: { role: string } }).message.role)).toEqual(['user'])
    const delta = snap.find((e) => e.type === 'part_delta') as { delta: string }
    expect(delta.delta).toBe('Удаляю файл.')
    const tool = snap.find((e) => e.type === 'part_end' && (e as { payload?: { type: string } }).payload?.type === 'tool_use') as { payload: { data: unknown } }
    expect(tool.payload.data).toEqual({ command: 'rm x' })
    expect(snap.at(-1)).toMatchObject({ type: 'ask', askId: 'a1', kind: 'tool_approval' })

    // Ответ с B — ask гаснет, ход идёт дальше до конца.
    await b.respond!(s.id, 'a1', { decision: 'allow' })
    const rest: AnyRunEvent[] = []
    for (;;) {
      const r = await itB.next()
      if (r.done) break
      rest.push(r.value)
    }
    expect(rest[0]).toEqual({ type: 'ask_end', runId, askId: 'a1' })
    expect(rest.at(-1)).toMatchObject({ type: 'run_end', status: 'done' })
    expect((await b.sessions.get(s.id)).run).toBeUndefined()
    const hist = await b.history(s.id)
    expect(hist.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(hist.messages[2]!.parts[0]).toMatchObject({ type: 'tool_result', text: 'removed' })
  })

  it('рана нет — attach пустой; несколько подписчиков видят одно и то же', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const backend = createStoreBackend({
      store: createMemoryStore(),
      generate: async function* () {
        yield { type: 'text', delta: 'раз ' }
        await gate
        yield { type: 'text', delta: 'два' }
      },
    })
    const { client } = await served(backend)
    const c = client()
    const s = await c.sessions.create()
    const empty: AnyRunEvent[] = []
    for await (const e of c.sessions.attach!(s.id)) empty.push(e)
    expect(empty).toEqual([])

    const it0 = c.run(s.id, { userMessage: 'q' })[Symbol.asyncIterator]()
    await until(it0, (e) => e.type === 'part_delta')
    const subs = [client().sessions.attach!(s.id)[Symbol.asyncIterator](), client().sessions.attach!(s.id)[Symbol.asyncIterator]()]
    const snaps = await Promise.all(subs.map((it) => until(it, (e) => e.type === 'part_delta')))
    for (const snap of snaps) expect((snap.at(-1) as { delta: string }).delta).toBe('раз ')
    release()
    const tails = await Promise.all(
      subs.map(async (it) => {
        const out: AnyRunEvent[] = []
        for (;;) {
          const r = await it.next()
          if (r.done) return out
          out.push(r.value)
        }
      }),
    )
    for (const t of tails) {
      expect(t.filter((e) => e.type === 'part_delta').map((e) => (e as { delta: string }).delta)).toEqual(['два'])
      expect(t.at(-1)).toMatchObject({ type: 'run_end', status: 'done' })
    }
    await it0.return!()
  })

  it('потребитель в процессе ушёл (return) — ран идёт до конца без него', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const store = createMemoryStore()
    const b = withRunAttach(
      createStoreBackend({
        store,
        generate: async function* () {
          yield { type: 'text', delta: 'начало ' }
          await gate
          yield { type: 'text', delta: 'конец' }
        },
      }),
    )
    const s = await b.sessions.create()
    const it = b.run(s.id, { userMessage: 'q' })[Symbol.asyncIterator]()
    await until(it, (e) => e.type === 'part_delta')
    await it.return!()
    expect((await b.sessions.get(s.id)).run).toBeDefined()
    release()
    await waitFor(async () => (await b.sessions.get(s.id)).run === undefined)
    expect((await b.history(s.id)).messages.at(-1)!.parts[0]).toMatchObject({ type: 'text', text: 'начало конец' })
  })
})

describe('attach до run_start (ABC-443)', () => {
  it('ран начат, run_start ещё впереди — attach ждёт регистрации и видит ход до конца', async () => {
    let go!: () => void
    const before = new Promise<void>((r) => (go = r))
    const inner = createStoreBackend({ store: createMemoryStore(), generate: async function* () { yield { type: 'text', delta: 'ответ' } } })
    // Сборка промпта, подключение MCP — секунды до run_start: здесь их держит `before`.
    const slow = new Proxy(inner, {
      get: (t, k) =>
        k === 'run'
          ? (sid: string, input: Parameters<ProtocolBackend['run']>[1]) => ({
              async *[Symbol.asyncIterator]() {
                await before
                yield* inner.run(sid, input)
              },
            })
          : Reflect.get(t, k),
    })
    const b = withRunAttach(slow)
    const s = await b.sessions.create()
    const it = b.run(s.id, { userMessage: 'q' })[Symbol.asyncIterator]()
    const first = it.next() // ран пошёл, run_start ещё нет
    await it.return!() // начавший ушёл
    void first.catch(() => undefined)
    const seen: AnyRunEvent[] = []
    const tail = (async () => {
      for await (const ev of b.sessions.attach!(s.id)) seen.push(ev)
    })()
    go()
    await tail
    expect(seen[0]?.type).toBe('run_start')
    expect(seen.at(-1)).toMatchObject({ type: 'run_end', status: 'done' })
    expect(JSON.stringify(seen)).toContain('ответ')
  })

  it('рана нет и не начат — attach пустой сразу', async () => {
    const b = withRunAttach(createStoreBackend({ store: createMemoryStore(), generate: async function* () {} }))
    const s = await b.sessions.create()
    const got: AnyRunEvent[] = []
    for await (const ev of b.sessions.attach!(s.id)) got.push(ev)
    expect(got).toEqual([])
  })
})

describe('keepalive стрима рана (ABC-356)', () => {
  /** Сырой SSE до предиката: клиент комментарии глотает, тут смотрим провод. */
  async function rawUntil(url: string, init: RequestInit, pred: (text: string) => boolean): Promise<string> {
    const ctl = new AbortController()
    const res = await fetch(url, { ...init, signal: ctl.signal })
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let text = ''
    try {
      while (!pred(text)) {
        const r = await reader.read()
        if (r.done) break
        text += dec.decode(r.value, { stream: true })
      }
    } finally {
      ctl.abort()
    }
    return text
  }

  it('POST /run и GET /attach начинаются с `: keepalive` — клиент включает сторож тишины', async () => {
    const backend = createStoreBackend({ store: createMemoryStore(), generate: approvalGen(), ask: ['tool_approval'] })
    const { srv, client } = await served(backend)
    const a = client()
    const s = await a.sessions.create()
    const run = await rawUntil(`${srv.url}/sessions/${s.id}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userMessage: 'удали x' }) }, (t) => t.includes('event: ask'))
    expect(run.startsWith(': keepalive\n\n')).toBe(true)
    await waitFor(async () => (await a.sessions.get(s.id)).run?.waiting === 'ask')
    const attach = await rawUntil(`${srv.url}/sessions/${s.id}/attach`, { method: 'GET' }, (t) => t.includes('event: ask'))
    expect(attach.startsWith(': keepalive\n\n')).toBe(true)
    await a.cancel(s.id, (await a.sessions.get(s.id)).run!.id)
  })
})

describe('хаб: attach — движку сессии', () => {
  it('встроенный и подключённый движки: ран посреди ask виден в списке и подхватывается через хаб', async () => {
    const nrDir = mkdtempSync(join(tmpdir(), 'attach-nr-'))
    const acpDir = mkdtempSync(join(tmpdir(), 'attach-acp-'))
    const mk = (dir: string) => createStoreBackend({ store: createNrChatStore({ dir }), generate: approvalGen(), ask: ['tool_approval'] })
    const acp = await served(mk(acpDir))
    const hub = createHub({ local: mk(nrDir), localSessionsDir: nrDir, engines: [{ id: 'acp', backend: acp.client(), sessionsDir: acpDir }], probeTtlMs: 0, log: () => {} })
    const front = await served(hub)
    const c = front.client()
    expect((await c.capabilities()).sessions).toEqual({ archive: true, move: true, page: true, attach: true, live: true })

    for (const engine of ['nr', 'acp']) {
      const s = await c.sessions.create({ engine })
      const it = c.run(s.id, { userMessage: 'удали' })[Symbol.asyncIterator]()
      await until(it, (e) => e.type === 'ask')
      await it.return!()
      await waitFor(async () => (await c.sessions.list()).find((x) => x.id === s.id)?.run?.waiting === 'ask')
      const att = front.client().sessions.attach!(s.id)[Symbol.asyncIterator]()
      const snap = await until(att, (e) => e.type === 'ask')
      expect(snap.at(-1)).toMatchObject({ type: 'ask', askId: 'a1' })
      await c.respond!(s.id, 'a1', { decision: 'deny' })
      const rest: AnyRunEvent[] = []
      for (;;) {
        const r = await att.next()
        if (r.done) break
        rest.push(r.value)
      }
      expect(rest.map((e) => e.type)).toContain('ask_end')
      expect(rest.at(-1)).toMatchObject({ type: 'run_end', status: 'done' })
      await waitFor(async () => (await c.sessions.get(s.id)).run === undefined)
    }
  })
})

describe('запущенные сессии (v1.38, ABC-352)', () => {
  it('две параллельные сессии на разных движках — в sessions.live хаба с последним событием; ход кончился — пропали', async () => {
    const nrDir = mkdtempSync(join(tmpdir(), 'live-nr-'))
    const acpDir = mkdtempSync(join(tmpdir(), 'live-acp-'))
    const mk = (dir: string) => createStoreBackend({ store: createNrChatStore({ dir }), generate: approvalGen(), ask: ['tool_approval'] })
    const acp = await served(mk(acpDir))
    const hub = createHub({ local: mk(nrDir), localSessionsDir: nrDir, engines: [{ id: 'acp', backend: acp.client(), sessionsDir: acpDir }], probeTtlMs: 0, log: () => {} })
    const front = await served(hub)
    const c = front.client()
    const ids: Record<string, string> = {}
    for (const engine of ['nr', 'acp']) {
      const s = await c.sessions.create({ engine, title: `в ${engine}` })
      ids[engine] = s.id
      const it = c.run(s.id, { userMessage: 'удали' })[Symbol.asyncIterator]()
      await until(it, (e) => e.type === 'ask')
      await it.return!()
    }
    await waitFor(async () => (await c.sessions.live!()).length === 2)
    const live = await c.sessions.live!()
    for (const engine of ['nr', 'acp']) {
      const row = live.find((x) => x.id === ids[engine])!
      expect(row).toMatchObject({ engine, title: `в ${engine}`, run: { waiting: 'ask', last: { kind: 'ask', name: 'tool_approval' } } })
      expect(Date.parse(row.run!.last!.at)).toBeGreaterThan(0)
    }
    for (const engine of ['nr', 'acp']) await c.respond!(ids[engine]!, 'a1', { decision: 'deny' })
    await waitFor(async () => (await c.sessions.live!()).length === 0)
  })

  it('run.last: тул по имени, потом его результат', async () => {
    let go!: () => void
    const gate = new Promise<void>((r) => (go = r))
    const gen: GenerateFn = async function* () {
      yield { type: 'tool_call', callId: 'c1', name: 'bash', args: {} }
      await gate
      yield { type: 'tool_result', callId: 'c1', name: 'bash', text: 'ok' }
      await new Promise((r) => setTimeout(r, 200))
    }
    const w = withRunAttach(createStoreBackend({ store: createMemoryStore(), generate: gen }))
    const s = await w.sessions.create()
    const it = w.run(s.id, { userMessage: 'x' })[Symbol.asyncIterator]()
    void (async () => {
      for (;;) if ((await it.next()).done) break
    })()
    await waitFor(async () => (await w.sessions.live!())[0]?.run?.last?.kind === 'tool')
    expect((await w.sessions.live!())[0]!.run!.last).toMatchObject({ kind: 'tool', name: 'bash' })
    go()
    await waitFor(async () => (await w.sessions.live!())[0]?.run?.last?.kind === 'result')
    expect((await w.sessions.live!())[0]!.run!.last).toMatchObject({ kind: 'result', name: 'bash' })
  })
})

describe('обёртка живая', () => {
  it('группы бэкенда читаются на каждом обращении (переключение пространства, Proxy), а не снимком', async () => {
    const a = createStoreBackend({ store: createMemoryStore(), generate: approvalGen() })
    const b = createStoreBackend({ store: createMemoryStore(), generate: approvalGen() })
    let cur = a
    const dynamic = new Proxy({} as ProtocolBackend, { get: (_t, p) => Reflect.get(cur, p) })
    const w = withRunAttach(dynamic)
    await w.sessions.create({ title: 'в a' })
    expect((await w.sessions.list()).map((s) => s.title)).toEqual(['в a'])
    cur = b
    expect(await w.sessions.list()).toEqual([])
    expect(typeof w.sessions.attach).toBe('function')
    expect((await w.capabilities()).sessions?.attach).toBe(true)
  })
})

describe('счётчики сессии в sessions.live (v1.53, монитор T4)', () => {
  it('токены и контекст растут по ходам рана (message_end → meta.usage)', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const gen: GenerateFn = async function* () {
      yield { type: 'usage', input: 100, output: 10, cacheRead: 80, context: { used: 110, size: 1000 } }
      yield { type: 'text', delta: 'смотрю' }
      yield { type: 'tool_call', callId: 'c1', name: 'read', args: {} }
      yield { type: 'tool_result', callId: 'c1', name: 'read', text: 'ok' }
      await gate
      yield { type: 'usage', input: 50, output: 5, context: { used: 165, size: 1000 } }
      yield { type: 'text', delta: 'готово' }
    }
    const b = withRunAttach(createStoreBackend({ store: createMemoryStore(), generate: gen }))
    const s = await b.sessions.create()
    const it = b.run(s.id, { userMessage: 'go' })[Symbol.asyncIterator]()
    const metric = async (name: string) => (await b.sessions.live!()).find((x) => x.id === s.id)?.metrics?.find((m) => m.name === name)
    let ends = 0
    let first: unknown
    for (;;) {
      const r = await it.next()
      if (r.done) break
      if (r.value.type === 'message_end' && (r.value as { message: { role: string } }).message.role === 'assistant') {
        ends++
        if (ends === 1) {
          first = await metric('tokens_in')
          release()
        }
      }
      if (r.value.type === 'run_end') break
    }
    expect(first).toMatchObject({ value: 100, unit: 'tok' })
    release()
  })
})
