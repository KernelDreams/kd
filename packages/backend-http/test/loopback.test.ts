/**
 * Loopback: fake-backend → serveBackend → createHttpBackend (backends-spec §3.3).
 *
 * Приёмка: события на клиенте равны событиям fake-бэкенда, NotSupported
 * доезжает кодом, неизвестное событие доезжает opaque.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NotSupportedError } from '@kerneldreams/ui-protocol'
import type { AnyRunEvent, Persona, ProtocolBackend, RunEndEvent } from '@kerneldreams/ui-protocol'
import { serveBackend, type ServeHandle } from '../src/serve.js'
import { createHttpBackend, BackendError } from '../src/client.js'
import { createFakeBackend, fullRunScript, FAKE_MODELS, FAKE_WORKSPACES, FULL_CAPABILITIES, type FakeBackend } from './fake-backend.js'

// ────────────────────────────────────────────────────────────────────────────
// Обвязка
// ────────────────────────────────────────────────────────────────────────────

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

/** Ждать условия поллингом — раны стоят на нём, пока клиент шлёт respond/cancel. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: таймаут')
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function collect(iterable: AsyncIterable<AnyRunEvent>): Promise<AnyRunEvent[]> {
  const out: AnyRunEvent[] = []
  for await (const ev of iterable) out.push(ev)
  return out
}

let srv: ServeHandle | undefined
let client: ProtocolBackend | undefined
const gates: Deferred[] = []

/** Поднять шов над fake-бэкендом: сервер + клиент по его же url. */
async function loopback(fake: FakeBackend, opts?: Parameters<typeof serveBackend>[1]) {
  srv = await serveBackend(fake, opts)
  client = createHttpBackend(srv.url)
  return { srv, client }
}

beforeEach(() => {
  gates.length = 0
})

afterEach(async () => {
  for (const gate of gates) gate.resolve() // распустить зависшие раны
  await client?.close?.()
  await srv?.close()
  srv = undefined
  client = undefined
})

function gate(): Deferred {
  const d = deferred()
  gates.push(d)
  return d
}

// ────────────────────────────────────────────────────────────────────────────
// Ядро операций (§4.1)
// ────────────────────────────────────────────────────────────────────────────

describe('ядро операций', () => {
  it('capabilities доезжают целиком и кэшируются', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)

    // serveBackend добавляет подхват рана (v1.31) — бэкенд сам его не заявлял.
    const served = { ...FULL_CAPABILITIES, sessions: { attach: true, live: true }, services: { 'nr.sessions': { methods: [], streams: ['activity'] } } }
    expect(await client.capabilities()).toEqual(served)
    expect(await client.capabilities()).toEqual(served)
    expect(await client.capabilities()).toEqual(served)

    // кэш default — навсегда до close(): бэкенд опрошен один раз
    expect(fake.calls.filter((c) => c === 'capabilities')).toHaveLength(1)
  })

  it('capabilitiesTtl протухает', async () => {
    const fake = createFakeBackend()
    srv = await serveBackend(fake)
    client = createHttpBackend(srv.url, { capabilitiesTtl: 10 })

    await client.capabilities()
    await client.capabilities()
    expect(fake.calls.filter((c) => c === 'capabilities')).toHaveLength(1)

    await new Promise((r) => setTimeout(r, 15))
    await client.capabilities()
    expect(fake.calls.filter((c) => c === 'capabilities')).toHaveLength(2)
  })

  it('sessions: list / create / get / delete', async () => {
    const fake = createFakeBackend({ sessions: [{ id: 's1', title: 'Первая' }] })
    const { client } = await loopback(fake)

    expect(await client.sessions.list()).toEqual([{ id: 's1', title: 'Первая' }])

    const created = await client.sessions.create({ title: 'Вторая', botId: 'bot1' })
    expect(created).toMatchObject({ title: 'Вторая', botId: 'bot1' })

    expect(await client.sessions.get(created.id)).toEqual(created)
    expect(await client.sessions.list()).toHaveLength(2)

    await client.sessions.delete(created.id)
    expect(await client.sessions.list()).toHaveLength(1)
  })

  it('sessions.create без опций = пустое тело', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)
    expect(await client.sessions.create()).toMatchObject({ title: 'Новая' })
  })

  it('history отдаёт messages + version', async () => {
    const fake = createFakeBackend({
      history: {
        s1: {
          messages: [
            { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'привет' }] },
            { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'здравствуй' }], swipes: { active: 0, count: 2 } },
          ],
          version: 'v7',
        },
      },
    })
    const { client } = await loopback(fake)

    const page = await client.history('s1')
    expect(page.version).toBe('v7')
    expect(page.messages).toHaveLength(2)
    expect(page.messages[1].swipes).toEqual({ active: 0, count: 2 })
  })

  it('id сессии с косой чертой не ломает роут', async () => {
    const fake = createFakeBackend({ sessions: [{ id: 'grp/a b', title: 'Слэш' }] })
    const { client } = await loopback(fake)
    expect(await client.sessions.get('grp/a b')).toEqual({ id: 'grp/a b', title: 'Слэш' })
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Capability-gated операции (§4.2)
// ────────────────────────────────────────────────────────────────────────────

describe('capability-gated операции', () => {
  it('fork / rename', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)

    expect(await client.sessions.fork!('s1', 'm3')).toEqual({
      id: 's1-fork',
      parentSessionId: 's1',
      forkMessageId: 'm3',
    })

    await client.sessions.rename!('s1', 'Переименована')
    expect((await client.sessions.get('s1')).title).toBe('Переименована')
  })

  it('messages: edit / delete / hide / swipe', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)

    const edited = await client.messages!.edit!('s1', 'm1', { text: 'правка', ifHash: 'h1' })
    expect(edited.parts).toEqual([{ type: 'text', text: 'правка' }])
    expect(fake.edits[0]).toEqual({ op: 'edit', sid: 's1', mid: 'm1', arg: { text: 'правка', ifHash: 'h1' } })

    const editedParts = await client.messages!.edit!('s1', 'm1', {
      parts: [{ type: 'text', text: 'через parts' }],
    })
    expect(editedParts.parts).toEqual([{ type: 'text', text: 'через parts' }])

    await client.messages!.delete!('s1', 'm2')
    expect(fake.edits.at(-1)).toMatchObject({ op: 'delete', mid: 'm2' })

    await client.messages!.hide!('s1', 'm3', true)
    expect(fake.edits.at(-1)).toMatchObject({ op: 'hide', mid: 'm3', arg: true })

    const swiped = await client.messages!.swipe!('s1', 'mini', { index: 2 })
    expect(swiped.swipes).toEqual({ active: 2, count: 3 })
    expect(fake.edits.at(-1)).toMatchObject({ op: 'swipe', mid: 'mini', arg: { index: 2 } })
  })

  it('catalog / personas / meta', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)

    expect(await client.catalog!.bots()).toEqual([{ id: 'bot1', name: 'Бот' }])
    expect(await client.catalog!.bot('bot1')).toEqual({ id: 'bot1', name: 'Бот' })

    const asset = await client.catalog!.asset!('bot1', 'avatar.png')
    expect(asset.mime).toBe('image/png')
    expect([...asset.data]).toEqual([0x89, 0x50, 0x4e, 0x47, 4, 10])

    expect(await client.personas!.list('s1')).toEqual({ personas: [{ id: 'p1', kind: 'user', name: 'владелец s1' }], userId: 'p1' })
    const cast: Persona[] = [{ id: 'a', kind: 'char', name: 'Alice' }]
    expect(await client.personas!.save!('s1', cast)).toEqual({ personas: cast })
    // Битый документ отбивает транспорт, до бэкенда (validatePersonas).
    const bad = await client.personas!.save!('s1', cast, 'a').then(
      () => undefined,
      (e: { code?: string }) => e,
    )
    expect(bad?.code).toBe('bad_request')

    expect(await client.meta!.get('s1')).toEqual({ notes: 'заметки s1' })
    expect(await client.meta!.patch('s1', { notes: 'новое' })).toEqual({
      notes: 'обновлено',
      patch: { notes: 'новое' },
    })
    expect(fake.metaPatches).toEqual([{ sid: 's1', patch: { notes: 'новое' } }])
  })

  it('attachments.put — сырые байты + x-name/mime доезжают, ref возвращается', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)

    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const res = await client.attachments!.put('s1', 'скрин 01.png', data, 'image/png')
    // attachments-spec §2: ответ — ref И готовая часть, провод несёт оба
    expect(res).toEqual({
      ref: './s1.assets/скрин 01.png',
      part: { type: 'image', meta: { ref: './s1.assets/скрин 01.png', mime: 'image/png' } },
    })

    expect(fake.attaches).toHaveLength(1)
    const got = fake.attaches[0]
    expect(got.sid).toBe('s1')
    expect(got.name).toBe('скрин 01.png') // юникод-имя пережило x-name (percent-encode)
    expect(got.mime).toBe('image/png')
    expect([...got.data]).toEqual([...data]) // байты не побились транспортом
  })

  it('attachments без mime → application/octet-stream', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)
    await client.attachments!.put('s1', 'data.bin', new Uint8Array([1, 2]))
    expect(fake.attaches[0].mime).toBe('application/octet-stream')
  })

  it('attachments принимает и PUT (форма attachments-spec §2), не только POST', async () => {
    const fake = createFakeBackend()
    const { srv } = await loopback(fake)
    const res = await fetch(`${srv.url}/sessions/s1/attachments`, {
      method: 'PUT',
      headers: { 'content-type': 'text/markdown', 'x-name': encodeURIComponent('план.md') },
      body: new TextEncoder().encode('# план'),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).result.ref).toBe('./s1.assets/план.md')
    expect(fake.attaches[0]).toMatchObject({ name: 'план.md', mime: 'text/markdown' })
  })

  it('CORS: preflight пускает x-name и PUT — браузерная загрузка не упрётся в заголовок', async () => {
    const fake = createFakeBackend()
    const { srv } = await loopback(fake, { cors: true })
    const res = await fetch(`${srv.url}/sessions/s1/attachments`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173', 'access-control-request-headers': 'x-name, content-type' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-headers')).toContain('x-name')
    expect(res.headers.get('access-control-allow-methods')).toContain('PUT')
  })

  it('messages.append: parts и role доезжают, сообщение возвращается', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)
    const part = { type: 'file' as const, text: '# план', meta: { name: 'план.md', ref: 'r1', tokens: 2 } }

    const msg = await client.messages!.append!('s1', [part], { role: 'user' })
    expect(msg).toEqual({ id: 'm-appended', role: 'user', parts: [part], hash: 'h-app' })
    expect(fake.edits).toEqual([{ op: 'append', sid: 's1', mid: '', arg: { parts: [part], opts: { role: 'user' } } }])

    // без role — опций на провод не уезжает
    await client.messages!.append!('s1', [{ type: 'text', text: 'x' }])
    expect(fake.edits[1].arg).toEqual({ parts: [{ type: 'text', text: 'x' }], opts: undefined })
  })

  it('messages.append: пустые parts и чужая роль — bad_request до бэкенда', async () => {
    const fake = createFakeBackend()
    const { client, srv } = await loopback(fake)

    await expect(client.messages!.append!('s1', [])).rejects.toMatchObject({ code: 'bad_request', status: 400 })
    const res = await fetch(`${srv.url}/sessions/s1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'x' }], role: 'tool' }),
    })
    expect(res.status).toBe(400)
    expect(fake.edits).toEqual([])
  })
})

// ────────────────────────────────────────────────────────────────────────────
// models (models-spec §4)
// ────────────────────────────────────────────────────────────────────────────

describe('модели', () => {
  it('GET /models отдаёт каталог целиком, включая tags/thinking/contextWindow', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)

    expect(await client.models!.list()).toEqual(FAKE_MODELS)
    expect(fake.calls).toContain('models.list')
  })

  it('capability models доезжает вместе с остальными', async () => {
    const { client } = await loopback(createFakeBackend())
    expect((await client.capabilities()).models).toEqual({ select: true, thinking: true })
  })

  it('POST /sessions/:id/model доезжает до бэкенда и возвращает ПРИМЕНЁННОЕ', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)

    const applied = await client.models!.set!('s1', { model: 'nr/opus', thinking: 'high' })
    expect(applied).toEqual({ model: 'nr/opus', thinking: 'high' })
    expect(fake.modelSets).toEqual([{ sid: 's1', model: { model: 'nr/opus', thinking: 'high' } }])
    // и сессия несёт выбор дальше (§2: SessionInfo.model)
    expect((await client.sessions.get('s1')).model).toEqual({ model: 'nr/opus', thinking: 'high' })
  })

  it('id сессии со слэшем не рвёт роут /model', async () => {
    const fake = createFakeBackend({ sessions: [{ id: 'grp/s1' }] })
    const { client } = await loopback(fake)

    await client.models!.set!('grp/s1', { model: 'nr/glm-5.3-flash' })
    expect(fake.modelSets[0]!.sid).toBe('grp/s1')
  })

  it('модель без выбора — SessionInfo.model отсутствует', async () => {
    const { client } = await loopback(createFakeBackend())
    expect((await client.sessions.get('s1')).model).toBeUndefined()
  })

  it('sessions.create с моделью доезжает телом', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)

    const info = await client.sessions.create({ title: 'С моделью', model: { model: 'nr/opus', thinking: 'low' } })
    expect(fake.createOpts.at(-1)?.model).toEqual({ model: 'nr/opus', thinking: 'low' })
    expect(info.title).toBe('С моделью')
  })

  it('битое тело /model → bad_request, бэкенд не тронут', async () => {
    const fake = createFakeBackend()
    const { srv } = await loopback(fake)

    const res = await fetch(`${srv.url}/sessions/s1/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ thinking: 'high' }), // без model
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ ok: false, code: 'bad_request' })
    expect(fake.calls).not.toContain('models.set')
  })

  it('list есть, set нет (models без select) → set отказывает, list работает', async () => {
    const fake = createFakeBackend({
      capabilities: { protocol: 1, name: 'ro', models: {} },
      omit: ['models.set'],
    })
    const { client } = await loopback(fake)

    expect((await client.capabilities()).models).toEqual({})
    await expect(client.models!.list()).resolves.toEqual(FAKE_MODELS)
    await expect(client.models!.set!('s1', { model: 'nr/opus' })).rejects.toBeInstanceOf(NotSupportedError)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Пространство (workspace-spec §3)
// ────────────────────────────────────────────────────────────────────────────

describe('пространство', () => {
  it('GET /workspace отдаёт текущее', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)

    expect(await client.workspace!.current()).toEqual(FAKE_WORKSPACES[0])
    expect(fake.calls).toContain('workspace.current')
  })

  it('GET /workspaces отдаёт список целиком, с path и kind', async () => {
    const { client } = await loopback(createFakeBackend())
    expect(await client.workspace!.list()).toEqual(FAKE_WORKSPACES)
  })

  it('POST /workspace {id} переключает: current после него — новое', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)

    expect(await client.workspace!.switch!('/work/beta')).toEqual(FAKE_WORKSPACES[1])
    expect(await client.workspace!.current()).toEqual(FAKE_WORKSPACES[1])
    expect(fake.calls).toContain('workspace.switch')
  })

  it('capability workspace доезжает вместе с остальными', async () => {
    const { client } = await loopback(createFakeBackend())
    expect((await client.capabilities()).workspace).toEqual({ switch: true })
  })

  it('POST /workspace без id → bad_request, бэкенд не тронут', async () => {
    const fake = createFakeBackend()
    const { srv } = await loopback(fake)

    const res = await fetch(`${srv.url}/workspace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ ok: false, code: 'bad_request' })
    expect(fake.calls).not.toContain('workspace.switch')
  })

  it('current/list есть, switch нет → switch отказывает, чтение работает', async () => {
    const fake = createFakeBackend({
      capabilities: { protocol: 1, name: 'fixed', workspace: {} },
      omit: ['workspace.switch'],
    })
    const { client } = await loopback(fake)

    expect((await client.capabilities()).workspace).toEqual({})
    await expect(client.workspace!.list()).resolves.toEqual(FAKE_WORKSPACES)
    await expect(client.workspace!.switch!('/work/beta')).rejects.toBeInstanceOf(NotSupportedError)
  })

  it('бэкенд без пространства → current/list тоже not_supported', async () => {
    const fake = createFakeBackend({ capabilities: { protocol: 1, name: 'bare' }, omit: ['workspace'] })
    const { client } = await loopback(fake)

    expect((await client.capabilities()).workspace).toBeUndefined()
    await expect(client.workspace!.current()).rejects.toBeInstanceOf(NotSupportedError)
    await expect(client.workspace!.list()).rejects.toBeInstanceOf(NotSupportedError)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// NotSupported (§2, §3.1)
// ────────────────────────────────────────────────────────────────────────────

describe('NotSupported доезжает кодом', () => {
  it('незаявленные операции → NotSupportedError на клиенте', async () => {
    const fake = createFakeBackend({
      capabilities: { protocol: 1, name: 'bare' },
      omit: ['sessions.fork', 'sessions.rename', 'respond', 'messages', 'catalog', 'personas', 'meta', 'attachments', 'models'],
    })
    const { client } = await loopback(fake)

    const cases: Array<[string, () => Promise<unknown>]> = [
      ['sessions.fork', () => client.sessions.fork!('s1')],
      ['sessions.rename', () => client.sessions.rename!('s1', 'x')],
      ['respond', () => client.respond!('s1', 'ask1', {})],
      ['messages.append', () => client.messages!.append!('s1', [{ type: 'text', text: 'x' }])],
      ['messages.edit', () => client.messages!.edit!('s1', 'm1', { text: 'x' })],
      ['messages.delete', () => client.messages!.delete!('s1', 'm1')],
      ['messages.hide', () => client.messages!.hide!('s1', 'm1', true)],
      ['messages.swipe', () => client.messages!.swipe!('s1', 'm1', { dir: 'next' })],
      ['catalog.bots', () => client.catalog!.bots()],
      ['catalog.bot', () => client.catalog!.bot('b1')],
      ['catalog.asset', () => client.catalog!.asset!('b1', 'a.png')],
      ['personas.list', () => client.personas!.list('s1')],
      ['personas.save', () => client.personas!.save!('s1', [])],
      ['meta.get', () => client.meta!.get('s1')],
      ['meta.patch', () => client.meta!.patch('s1', {})],
      ['attachments.put', () => client.attachments!.put('s1', 'a.png', new Uint8Array([1]))],
      ['models.list', () => client.models!.list()],
      ['models.set', () => client.models!.set!('s1', { model: 'nr/opus' })],
    ]

    for (const [name, call] of cases) {
      const err = await call().then(
        () => null,
        (e: unknown) => e,
      )
      expect(err, `${name} обязана отказать`).toBeInstanceOf(NotSupportedError)
      expect((err as NotSupportedError).code, name).toBe('not_supported')
    }
  })

  it('частичный omit: swipe нет, edit есть', async () => {
    const fake = createFakeBackend({ omit: ['messages.swipe'] })
    const { client } = await loopback(fake)

    await expect(client.messages!.swipe!('s1', 'm1', { dir: 'next' })).rejects.toBeInstanceOf(NotSupportedError)
    await expect(client.messages!.edit!('s1', 'm1', { text: 'ok' })).resolves.toMatchObject({ id: 'm1' })
  })

  it('прочая ошибка бэкенда → 500 без кода not_supported', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)

    const err = await client.sessions.get('нет-такой').then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(BackendError)
    expect(err).not.toBeInstanceOf(NotSupportedError)
    expect((err as BackendError).status).toBe(500)
    expect((err as BackendError).message).toContain('нет-такой')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Полный ран (§3.3)
// ────────────────────────────────────────────────────────────────────────────

describe('полный ран', () => {
  it('события на клиенте равны событиям fake-бэкенда, ask/respond работает', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)
    fake.script('s1', fullRunScript('s1', { onAsk: () => waitFor(() => fake.answers.length > 0) }))

    const received: AnyRunEvent[] = []
    for await (const ev of client.run('s1', { userMessage: 'посчитай 2+2' })) {
      received.push(ev)
      if (ev.type === 'ask') {
        // §5.3: ран стоит, ответ едет отдельным POST
        await client.respond!('s1', (ev as { askId: string }).askId, { allow: true })
      }
    }

    // Принятый ответ гасит ask у всех подписчиков (v1.31): ask_end — сразу после ask.
    const at = fake.emitted.findIndex((e) => e.type === 'ask')
    expect(received).toEqual([...fake.emitted.slice(0, at + 1), { type: 'ask_end', runId: 'run-s1', askId: 'ask1' }, ...fake.emitted.slice(at + 1)])
    expect(fake.answers).toEqual([{ sid: 's1', askId: 'ask1', answer: { allow: true } }])

    // ран приехал целиком: multi-message, tool-парты, финал
    expect(received[0]).toEqual({ type: 'run_start', runId: 'run-s1' })
    expect(received.filter((e) => e.type === 'message_end')).toHaveLength(4)
    expect(received.at(-1)).toEqual({
      type: 'run_end',
      runId: 'run-s1',
      status: 'done',
      usage: { input: 10, output: 24 },
      version: 'v2',
    })
  })

  it('неизвестное событие доезжает opaque, не фильтруется', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)
    fake.script('s1', fullRunScript('s1', { onAsk: () => waitFor(() => fake.answers.length > 0) }))

    const received: AnyRunEvent[] = []
    for await (const ev of client.run('s1', {})) {
      received.push(ev)
      if (ev.type === 'ask') await client.respond!('s1', (ev as { askId: string }).askId, { allow: true })
    }

    const opaque = received.find((e) => e.type === 'fake.telemetry')
    expect(opaque).toEqual({ type: 'fake.telemetry', runId: 'run-s1', payload: { tokensPerSec: 42 } })
  })

  it('cancel отменяет ран через эндпоинт', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)
    fake.script('s1', [
      { emit: { type: 'run_start', runId: 'r1' } },
      { await: () => waitFor(() => fake.cancels.length > 0) },
      { emit: { type: 'run_end', runId: 'r1', status: 'cancelled', version: 'v3' } },
    ])

    const received: AnyRunEvent[] = []
    for await (const ev of client.run('s1', {})) {
      received.push(ev)
      if (ev.type === 'run_start') await client.cancel('s1', 'r1')
    }

    expect(fake.cancels).toEqual([{ sid: 's1', runId: 'r1' }])
    expect(received.at(-1)).toEqual({ type: 'run_end', runId: 'r1', status: 'cancelled', version: 'v3' })
  })

  it('ошибка рана — это run_end{status:error} от бэкенда, не исключение', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)
    fake.script('s1', [
      { emit: { type: 'run_start', runId: 'r1' } },
      {
        emit: {
          type: 'run_end',
          runId: 'r1',
          status: 'error',
          error: { message: 'провайдер отказал', code: 'provider_error' },
          version: 'v4',
        },
      },
    ])

    const received = await collect(client.run('s1', {}))
    expect(received).toEqual(fake.emitted)
    expect(received.at(-1)).toMatchObject({ status: 'error', error: { code: 'provider_error' } })
  })

  it('авария итератора после старта → кадр run_end{status:error} и закрытие', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)
    fake.script('s1', [
      { emit: { type: 'run_start', runId: 'r1' } },
      { emit: { type: 'message_start', runId: 'r1', message: { id: 'a1', role: 'assistant' } } },
      { throw: new Error('движок умер') },
    ])

    const received = await collect(client.run('s1', {}))

    expect(received.map((e) => e.type)).toEqual(['run_start', 'message_start', 'run_end'])
    const end = received.at(-1) as RunEndEvent
    expect(end.status).toBe('error')
    expect(end.runId).toBe('r1')
    expect(end.error?.message).toContain('движок умер')
    expect(end.version).toBe('') // токен неизвестен — клиент ресинкается history
  })

  it('авария до первого кадра → Envelope-ошибка, не стрим', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)
    fake.script('s1', [{ throw: new Error('не стартовал') }])

    const err = await collect(client.run('s1', {})).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(BackendError)
    expect((err as BackendError).status).toBe(500)
    expect((err as BackendError).message).toContain('не стартовал')
  })

  it('run незаявленной сессии с NotSupportedError → код в run_end после старта', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)
    fake.script('s1', [
      { emit: { type: 'run_start', runId: 'r1' } },
      { throw: new NotSupportedError('run.regenerate') },
    ])

    const received = await collect(client.run('s1', {}))
    expect(received.at(-1)).toMatchObject({
      type: 'run_end',
      status: 'error',
      error: { code: 'not_supported' },
    })
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Один активный run на сессию (§10.1)
// ────────────────────────────────────────────────────────────────────────────

describe('один активный run на сессию', () => {
  it('второй run при живом → reject', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)
    const g = gate()
    fake.script('s1', [
      { emit: { type: 'run_start', runId: 'r1' } },
      { await: () => g.promise },
      { emit: { type: 'run_end', runId: 'r1', status: 'done', version: 'v2' } },
    ])

    const first = client.run('s1', {})[Symbol.asyncIterator]()
    expect((await first.next()).value).toEqual({ type: 'run_start', runId: 'r1' })

    const err = await collect(client.run('s1', {})).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(BackendError)
    expect((err as BackendError).code).toBe('busy')
    expect((err as BackendError).status).toBe(409)

    // первый ран не пострадал
    g.resolve()
    expect((await first.next()).value).toMatchObject({ type: 'run_end', status: 'done' })
    await first.return?.(undefined)
  })

  it('после завершения рана сессия снова свободна', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)
    fake.script('s1', [{ emit: { type: 'run_end', runId: 'r1', status: 'done', version: 'v1' } }])

    await collect(client.run('s1', {}))
    await collect(client.run('s1', {}))
    expect(fake.calls.filter((c) => c === 'run')).toHaveLength(2)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Обрыв SSE (§5.4, §3.2)
// ────────────────────────────────────────────────────────────────────────────

describe('обрыв SSE', () => {
  it('обрыв коннекта НЕ отменяет ран — он доигрывает на сервере', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)
    const g = gate()
    fake.script('s1', [
      { emit: { type: 'run_start', runId: 'r1' } },
      { await: () => g.promise },
      { emit: { type: 'run_end', runId: 'r1', status: 'done', version: 'v9' } },
    ])

    // клиент читает первое событие и уходит — стрим рвётся
    for await (const ev of client.run('s1', {})) {
      expect(ev.type).toBe('run_start')
      break
    }

    g.resolve()
    await fake.runFinished('s1')

    // ран доиграл до run_end, cancel никто не звал (§5.4)
    expect(fake.cancels).toEqual([])
    expect(fake.emitted.at(-1)).toMatchObject({ type: 'run_end', status: 'done', version: 'v9' })

    // ресинк через history — как и предписано протоколом
    expect((await client.history('s1')).version).toBe('v1')
  })

  it('порванный транспорт → синтетический run_end{code:connection_lost}', async () => {
    const fake = createFakeBackend()
    const { srv, client } = await loopback(fake)
    const g = gate()
    fake.script('s1', [
      { emit: { type: 'run_start', runId: 'r1' } },
      { emit: { type: 'part_delta', runId: 'r1', messageId: 'a1', part: 0, delta: 'при' } },
      { await: () => g.promise },
      { emit: { type: 'run_end', runId: 'r1', status: 'done', version: 'v2' } },
    ])

    const received: AnyRunEvent[] = []
    for await (const ev of client.run('s1', {})) {
      received.push(ev)
      // получили второй кадр — рвём провод под клиентом
      if (received.length === 2) srv.server.closeAllConnections()
    }

    expect(received.slice(0, 2).map((e) => e.type)).toEqual(['run_start', 'part_delta'])
    const end = received.at(-1) as RunEndEvent
    expect(end.type).toBe('run_end')
    expect(end.status).toBe('error')
    expect(end.error?.code).toBe('connection_lost')
    expect(end.runId).toBe('r1') // runId последнего события — UI знает, чей ран умер
    expect(end.version).toBe('')
  })

  it('стрим кончился без run_end → тоже connection_lost', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)
    fake.script('s1', [{ emit: { type: 'run_start', runId: 'r1' } }]) // бэкенд молча иссяк

    const received = await collect(client.run('s1', {}))
    expect(received.map((e) => e.type)).toEqual(['run_start', 'run_end'])
    expect(received.at(-1)).toMatchObject({ status: 'error', error: { code: 'connection_lost' } })
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Транспортные опции
// ────────────────────────────────────────────────────────────────────────────

describe('опции сервера', () => {
  it('basePath префиксует все роуты', async () => {
    const fake = createFakeBackend()
    const { srv, client } = await loopback(fake, { basePath: '/api/v1' })

    expect(srv.url).toMatch(/\/api\/v1$/)
    expect(await client.capabilities()).toEqual({ ...FULL_CAPABILITIES, sessions: { attach: true, live: true }, services: { 'nr.sessions': { methods: [], streams: ['activity'] } } })

    // вне basePath роутов нет
    const bare = await fetch(`http://127.0.0.1:${srv.port}/capabilities`)
    expect(bare.status).toBe(404)
    expect(await bare.json()).toMatchObject({ ok: false, code: 'not_found' })
  })

  it('cors отдаёт заголовки и preflight', async () => {
    const fake = createFakeBackend()
    const { srv } = await loopback(fake, { cors: true })

    const preflight = await fetch(`${srv.url}/sessions`, { method: 'OPTIONS' })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')

    const res = await fetch(`${srv.url}/capabilities`)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('без cors заголовков нет', async () => {
    const fake = createFakeBackend()
    const { srv } = await loopback(fake)
    const res = await fetch(`${srv.url}/capabilities`)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('host по умолчанию — 127.0.0.1', async () => {
    const fake = createFakeBackend()
    const { srv } = await loopback(fake)
    expect(srv.url).toContain('127.0.0.1')
  })

  it('неизвестный роут → 404 в Envelope', async () => {
    const fake = createFakeBackend()
    const { srv } = await loopback(fake)
    const res = await fetch(`${srv.url}/нет-такого`)
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ ok: false, code: 'not_found' })
  })

  it('битый JSON → bad_request, а не 500', async () => {
    const fake = createFakeBackend()
    const { srv } = await loopback(fake)
    const res = await fetch(`${srv.url}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{нет',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ ok: false, code: 'bad_request' })
  })

  it('SSE-кадры на проводе — формат §9', async () => {
    const fake = createFakeBackend()
    const { srv } = await loopback(fake)
    fake.script('s1', [
      { emit: { type: 'run_start', runId: 'r1' } },
      { emit: { type: 'run_end', runId: 'r1', status: 'done', version: 'v1' } },
    ])

    const res = await fetch(`${srv.url}/sessions/s1/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const raw = await res.text()
    expect(raw).toBe(
      // Комментарий-keepalive первым: клиент по нему включает сторож тишины.
      ': keepalive\n\n' +
        'event: run_start\ndata: {"type":"run_start","runId":"r1"}\n\n' +
        'event: run_end\ndata: {"type":"run_end","runId":"r1","status":"done","version":"v1"}\n\n',
    )
  })

  it('cancel без runId → bad_request', async () => {
    const fake = createFakeBackend()
    const { srv } = await loopback(fake)
    const res = await fetch(`${srv.url}/sessions/s1/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(400)
    expect(fake.cancels).toEqual([])
  })
})

describe('опции клиента', () => {
  it('headers едут в запросах (auth — вне протокола)', async () => {
    const fake = createFakeBackend()
    srv = await serveBackend(fake)
    const seen: string[] = []
    client = createHttpBackend(srv.url, {
      headers: { authorization: 'Bearer t0ken' },
      fetch: async (input, init) => {
        seen.push(String((init?.headers as Record<string, string>)?.authorization))
        return fetch(input as string, init)
      },
    })

    await client.capabilities()
    expect(seen).toEqual(['Bearer t0ken'])
  })

  it('close() рвёт запросы и запрещает новые', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)

    await client.capabilities()
    await client.close!()

    await expect(client.sessions.list()).rejects.toThrow(/закрыт/)
  })

  it('сервер недоступен → BackendError с connection_lost', async () => {
    const dead = createHttpBackend('http://127.0.0.1:1')
    const err = await dead.capabilities().then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(BackendError)
    expect((err as BackendError).code).toBe('connection_lost')
  })
})

describe('код ошибки бэкенда доезжает до клиента (backends-spec §3.1 + §4.3)', () => {
  let srv: ServeHandle | undefined

  afterEach(async () => {
    await srv?.close()
    srv = undefined
  })

  it('ошибка с code=busy → 409 и code в BackendError', async () => {
    const fake = createFakeBackend()
    fake.sessions.get = async () => {
      throw Object.assign(new Error('session is busy'), { code: 'busy' })
    }
    srv = await serveBackend(fake)
    const client = createHttpBackend(srv.url)
    const err = await client.sessions.get('s1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BackendError)
    expect((err as BackendError).code).toBe('busy')
    expect((err as BackendError).status).toBe(409)
  })

  it('неизвестный code едет в теле при статусе 500', async () => {
    const fake = createFakeBackend()
    fake.sessions.get = async () => {
      throw Object.assign(new Error('weird'), { code: 'pi_exploded' })
    }
    srv = await serveBackend(fake)
    const client = createHttpBackend(srv.url)
    const err = await client.sessions.get('s1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BackendError)
    expect((err as BackendError).code).toBe('pi_exploded')
  })
})
