/**
 * Loopback без HTTP: fake-backend → createProtocolHost → createMemoryBridge
 * (фейковый invoke/listen, JSON и асинхронная доставка) → createTauriBackend.
 *
 * Приёмка та же, что у HTTP-шва (backends-spec §3.3): события на клиенте равны
 * событиям fake-бэкенда, NotSupported доезжает классом, неизвестное событие —
 * opaque, коды ошибок не теряются.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NotSupportedError } from '@kerneldreams/ui-protocol'
import type {
  AnyRunEvent,
  FileWriteOpts,
  ProtocolBackend,
  RunEndEvent,
  WorkspaceFilesOps,
  WorkspaceUpdateEvent,
  WorkspaceUpdateListener,
} from '@kerneldreams/ui-protocol'
import { BackendError, createTauriBackend, type ListenFn } from '../../src/tauri/client.js'
import { createMemoryBridge, type MemoryBridge, type MemoryBridgeOpts } from '../../src/tauri/bridge.js'
import type { ProtocolEventPayload, WireEnvelope } from '../../src/tauri/wire.js'
import {
  createFakeBackend,
  fullRunScript,
  FAKE_CATALOGS,
  FAKE_MODELS,
  FAKE_PROFILES,
  FAKE_WORKSPACES,
  FULL_CAPABILITIES,
  type FakeBackend,
} from './fake-backend.js'

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

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: таймаут')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function collect(iterable: AsyncIterable<AnyRunEvent>): Promise<AnyRunEvent[]> {
  const out: AnyRunEvent[] = []
  for await (const ev of iterable) out.push(ev)
  return out
}

const errOf = (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e)

let bridge: MemoryBridge | undefined
let client: ProtocolBackend | undefined
const gates: Deferred[] = []

function loopback(fake: ProtocolBackend, opts?: MemoryBridgeOpts) {
  bridge = createMemoryBridge(fake, opts)
  client = createTauriBackend({ invoke: bridge.invoke, listen: bridge.listen })
  return { bridge, client }
}

/** Сырой вызов команды — мимо клиента, как это сделал бы кривой фронт. */
async function raw(b: MemoryBridge, method: string, args?: unknown[]): Promise<WireEnvelope> {
  return (await b.invoke('protocol_call', { method, args })) as WireEnvelope
}

function gate(): Deferred {
  const d = deferred()
  gates.push(d)
  return d
}

beforeEach(() => {
  gates.length = 0
})

afterEach(async () => {
  for (const g of gates) g.resolve()
  await client?.close?.()
  bridge?.host.close()
  bridge = undefined
  client = undefined
})

/** Файлы пространства на фейке: watch отдаёт управление тесту. */
function withFiles(fake: FakeBackend, withWatch = true) {
  const listeners = new Set<WorkspaceUpdateListener>()
  const writes: Array<{ path: string; content: string; opts?: FileWriteOpts }> = []
  const files: WorkspaceFilesOps = {
    list: async (path) => [{ name: 'a.md', path: path ? `${path}/a.md` : 'a.md', kind: 'file' }],
    read: async (path) => ({ path, content: 'hi', encoding: 'utf8', size: 2, revision: '2:1' }),
    write: async (path, content, opts) => {
      writes.push({ path, content, opts })
      return { revision: '3:2' }
    },
    ...(withWatch
      ? {
          watch(listener: WorkspaceUpdateListener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
        }
      : {}),
  }
  fake.workspace!.files = files
  return {
    writes,
    listeners,
    emit: (paths: string[]) => {
      for (const l of [...listeners]) l({ type: 'workspace_update', paths })
    },
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Операции
// ────────────────────────────────────────────────────────────────────────────

describe('операции', () => {
  it('capabilities доезжают целиком и кэшируются', async () => {
    const fake = createFakeBackend()
    const { client } = loopback(fake)
    expect(await client.capabilities()).toEqual(FULL_CAPABILITIES)
    expect(await client.capabilities()).toEqual(FULL_CAPABILITIES)
    expect(fake.calls.filter((c) => c === 'capabilities')).toHaveLength(1)
  })

  it('sessions: list / create / get / delete / fork / rename', async () => {
    const fake = createFakeBackend()
    const { client } = loopback(fake)

    expect(await client.sessions.list()).toEqual([{ id: 's1', title: 'Первая' }])
    const created = await client.sessions.create({ title: 'Вторая', model: { model: 'nr/opus' } })
    expect(created).toMatchObject({ title: 'Вторая', model: { model: 'nr/opus' } })
    await client.sessions.create()
    expect(fake.createOpts.at(-1)).toEqual({})
    expect(await client.sessions.get(created.id)).toMatchObject({ id: created.id })

    // atMessageId не задан: JSON несёт null, бэкенд получает undefined
    const forked = await client.sessions.fork!('s1')
    expect(forked).toEqual({ id: 's1-fork', parentSessionId: 's1' })
    await client.sessions.rename!('s1', 'Переименована')
    expect((await client.sessions.get('s1')).title).toBe('Переименована')

    await client.sessions.delete(created.id)
    expect((await client.sessions.list()).map((s) => s.id)).not.toContain(created.id)
  })

  it('history отдаёт messages + version', async () => {
    const fake = createFakeBackend({
      history: { s1: { messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }], version: 'v7' } },
    })
    const { client } = loopback(fake)
    expect(await client.history('s1')).toEqual({
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      version: 'v7',
    })
  })

  it('messages: append / edit / delete / hide / swipe', async () => {
    const fake = createFakeBackend()
    const { client } = loopback(fake)
    const m = client.messages!

    expect(await m.append!('s1', [{ type: 'text', text: 'hello' }], { role: 'assistant', swipeOf: 'm0' })).toMatchObject({
      role: 'assistant',
    })
    await m.append!('s1', [{ type: 'text', text: 'без опций' }])
    expect(await m.edit!('s1', 'm1', { text: 'новый', ifHash: 'h1' })).toMatchObject({ id: 'm1', hash: 'h2' })
    await m.delete!('s1', 'm2')
    await m.hide!('s1', 'm3', true)
    expect(await m.swipe!('s1', 'mini', { index: 2 })).toMatchObject({ swipes: { active: 2, count: 3 } })

    expect(fake.edits).toEqual([
      { op: 'append', sid: 's1', mid: '', arg: { parts: [{ type: 'text', text: 'hello' }], opts: { role: 'assistant', swipeOf: 'm0' } } },
      { op: 'append', sid: 's1', mid: '', arg: { parts: [{ type: 'text', text: 'без опций' }], opts: undefined } },
      { op: 'edit', sid: 's1', mid: 'm1', arg: { text: 'новый', ifHash: 'h1' } },
      { op: 'delete', sid: 's1', mid: 'm2', arg: null },
      { op: 'hide', sid: 's1', mid: 'm3', arg: true },
      { op: 'swipe', sid: 's1', mid: 'mini', arg: { index: 2 } },
    ])
  })

  it('models / workspace / profiles / catalogs / personas / meta', async () => {
    const fake = createFakeBackend()
    const { client } = loopback(fake)

    expect(await client.models!.list()).toEqual(FAKE_MODELS)
    expect(await client.models!.set!('s1', { model: 'nr/opus', thinking: 'high' })).toEqual({ model: 'nr/opus', thinking: 'high' })

    expect(await client.workspace!.current()).toEqual(FAKE_WORKSPACES[0])
    expect(await client.workspace!.list()).toEqual(FAKE_WORKSPACES)
    expect(await client.workspace!.switch!('/work/beta')).toEqual(FAKE_WORKSPACES[1])

    expect(await client.profiles!.list()).toEqual(FAKE_PROFILES)
    expect(await client.profiles!.set!('s1', { name: 'Бот', tools: 'none' } as never)).toEqual({ id: 'inline', name: 'Бот' })
    expect(await client.profiles!.get('chat')).toMatchObject({ id: 'chat' })
    await client.profiles!.save!({ id: 'x', name: 'X' })
    await client.profiles!.delete!('x')
    expect(await client.profiles!.duplicate!('chat', 'chat-2')).toEqual({ id: 'chat-2', name: 'chat' })
    expect(fake.profileEdits.map((e) => e.op)).toEqual(['save', 'delete', 'duplicate'])

    expect(await client.catalogs!.tools!()).toEqual(FAKE_CATALOGS.tools)
    expect(await client.catalogs!.skills!()).toEqual(FAKE_CATALOGS.skills)
    expect(await client.catalogs!.extensions!()).toEqual(FAKE_CATALOGS.extensions)

    expect(await client.catalog!.bots()).toEqual([{ id: 'bot1', name: 'Бот' }])
    expect(await client.catalog!.bot('bot1')).toEqual({ id: 'bot1', name: 'Бот' })
    expect(await client.personas!.list('s1')).toEqual({ personas: [{ id: 'p1', kind: 'user', name: 'владелец s1' }], userId: 'p1' })
    expect(await client.personas!.save!('s1', [{ id: 'c1', kind: 'char', name: 'Ира' }], 'p1')).toEqual({
      personas: [{ id: 'c1', kind: 'char', name: 'Ира s1' }],
      userId: 'p1',
    })

    expect(await client.meta!.get('s1')).toEqual({ notes: 'заметки s1' })
    await client.meta!.patch('s1', { notes: 'новые', prompt: null } as never)
    expect(fake.metaPatches).toEqual([{ sid: 's1', patch: { notes: 'новые', prompt: null } }])
  })

  it('байты: attachments.put и catalog.asset едут base64 и доезжают байт-в-байт', async () => {
    const fake = createFakeBackend()
    const { client, bridge } = loopback(fake)
    const data = new Uint8Array(70_000).map((_, i) => (i * 31) % 256)

    const put = await client.attachments!.put('s1', 'кадр.png', data, 'image/png')
    expect(put.ref).toBe('./s1.assets/кадр.png')
    expect(fake.attaches[0]!.data).toEqual(data)
    expect(fake.attaches[0]!.mime).toBe('image/png')

    const asset = await client.catalog!.asset!('bot1', 'a.png')
    expect(asset).toEqual({ data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 4, 5]), mime: 'image/png' })

    // битый base64 — bad_request до бэкенда
    const bad = await raw(bridge, 'attachments.put', ['s1', 'x.png', '%%%'])
    expect(bad).toMatchObject({ ok: false, code: 'bad_request' })
    expect(fake.attaches).toHaveLength(1)
  })

  it('файлы: list / read / write, revision:null доезжает', async () => {
    const fake = createFakeBackend()
    const files = withFiles(fake)
    const { client } = loopback(fake)
    const f = client.workspace!.files!

    expect(await f.list()).toEqual([{ name: 'a.md', path: 'a.md', kind: 'file' }])
    expect(await f.list('docs')).toEqual([{ name: 'a.md', path: 'docs/a.md', kind: 'file' }])
    expect(await f.read('a.md', { maxBytes: 10 })).toMatchObject({ content: 'hi', revision: '2:1' })
    expect(await f.write!('new.md', 'x', { revision: null })).toEqual({ revision: '3:2' })
    await f.write!('free.md', 'y')
    expect(files.writes).toEqual([
      { path: 'new.md', content: 'x', opts: { revision: null } },
      { path: 'free.md', content: 'y', opts: {} },
    ])
    // незаявленные у бэкенда операции
    expect(await errOf(f.delete!('a.md'))).toBeInstanceOf(NotSupportedError)
    expect(await errOf(f.stat!('a.md'))).toBeInstanceOf(NotSupportedError)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Ошибки
// ────────────────────────────────────────────────────────────────────────────

describe('ошибки доезжают кодом', () => {
  it('незаявленные операции → NotSupportedError на клиенте', async () => {
    const fake = createFakeBackend({
      capabilities: { protocol: 1, name: 'bare' },
      omit: ['sessions.fork', 'sessions.rename', 'respond', 'messages', 'catalog', 'personas', 'meta', 'attachments', 'models', 'workspace', 'profiles', 'catalogs'],
    })
    const { client } = loopback(fake)

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
      ['catalog.asset', () => client.catalog!.asset!('b1', 'a.png')],
      ['personas.list', () => client.personas!.list('s1')],
      ['meta.get', () => client.meta!.get('s1')],
      ['meta.patch', () => client.meta!.patch('s1', {})],
      ['attachments.put', () => client.attachments!.put('s1', 'a.png', new Uint8Array([1]))],
      ['models.list', () => client.models!.list()],
      ['models.set', () => client.models!.set!('s1', { model: 'nr/opus' })],
      ['workspace.current', () => client.workspace!.current()],
      ['workspace.switch', () => client.workspace!.switch!('x')],
      ['workspace.files.list', () => client.workspace!.files!.list()],
      ['workspace.files.write', () => client.workspace!.files!.write!('a', 'b')],
      ['profiles.list', () => client.profiles!.list()],
      ['profiles.save', () => client.profiles!.save!({ id: 'x', name: 'x' })],
      ['catalogs.tools', () => client.catalogs!.tools!()],
    ]

    for (const [name, call] of cases) {
      const err = await errOf(call())
      expect(err, `${name} обязана отказать`).toBeInstanceOf(NotSupportedError)
      expect((err as NotSupportedError).code, name).toBe('not_supported')
    }
  })

  it('code бэкенда (busy, conflict, свой) доезжает в BackendError', async () => {
    const fake = createFakeBackend()
    const { client } = loopback(fake)
    for (const code of ['busy', 'conflict', 'pi_exploded']) {
      fake.sessions.get = async () => {
        throw Object.assign(new Error(`boom ${code}`), { code })
      }
      const err = await errOf(client.sessions.get('s1'))
      expect(err).toBeInstanceOf(BackendError)
      expect((err as BackendError).code).toBe(code)
      expect((err as BackendError).message).toBe(`boom ${code}`)
    }
  })

  it('прочая ошибка бэкенда → BackendError без кода', async () => {
    const fake = createFakeBackend()
    const { client } = loopback(fake)
    const err = await errOf(client.sessions.get('нет-такой'))
    expect(err).toBeInstanceOf(BackendError)
    expect(err).not.toBeInstanceOf(NotSupportedError)
    expect((err as BackendError).code).toBeUndefined()
    expect((err as BackendError).message).toContain('нет-такой')
  })

  it('кривой вызов: неизвестная операция → not_found, битые аргументы → bad_request до бэкенда', async () => {
    const fake = createFakeBackend()
    const { bridge } = loopback(fake)

    expect(await raw(bridge, 'sessions.explode')).toMatchObject({ ok: false, code: 'not_found' })
    expect(await raw(bridge, 'constructor')).toMatchObject({ ok: false, code: 'not_found' })
    expect(await bridge.invoke('protocol_call', { method: 42 })).toMatchObject({ ok: false, code: 'bad_request' })
    expect(await bridge.invoke('protocol_call', { method: 'history', args: 's1' })).toMatchObject({ ok: false, code: 'bad_request' })

    expect(await raw(bridge, 'cancel', ['s1'])).toMatchObject({ ok: false, code: 'bad_request' })
    expect(await raw(bridge, 'messages.append', ['s1', []])).toMatchObject({ ok: false, code: 'bad_request' })
    expect(await raw(bridge, 'messages.append', ['s1', [{ text: 'без type' }]])).toMatchObject({ ok: false, code: 'bad_request' })
    expect(await raw(bridge, 'messages.append', ['s1', [{ type: 'text', text: 'x' }], { role: 'system' }])).toMatchObject({
      ok: false,
      code: 'bad_request',
    })
    expect(await raw(bridge, 'messages.hide', ['s1', 'm1', 'yes'])).toMatchObject({ ok: false, code: 'bad_request' })
    expect(await raw(bridge, 'models.set', ['s1', { thinking: 'high' }])).toMatchObject({ ok: false, code: 'bad_request' })
    expect(await raw(bridge, 'sessions.create', [{ profile: 42 }])).toMatchObject({ ok: false, code: 'bad_request' })
    expect(await raw(bridge, 'run', ['s1', {}])).toMatchObject({ ok: false, code: 'bad_request' }) // без id стрима

    expect(fake.cancels).toEqual([])
    expect(fake.edits).toEqual([])
    expect(fake.modelSets).toEqual([])
    expect(fake.calls).not.toContain('run')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Ран
// ────────────────────────────────────────────────────────────────────────────

describe('ран', () => {
  it('события на клиенте равны событиям fake-бэкенда, ask/respond работает', async () => {
    const fake = createFakeBackend()
    const { client, bridge } = loopback(fake)
    fake.script('s1', fullRunScript('s1', { onAsk: () => waitFor(() => fake.answers.length > 0) }))

    const received: AnyRunEvent[] = []
    for await (const ev of client.run('s1', { userMessage: 'посчитай 2+2' })) {
      received.push(ev)
      if (ev.type === 'ask') await client.respond!('s1', (ev as { askId: string }).askId, { allow: true })
    }

    expect(received).toEqual(fake.emitted)
    expect(fake.answers).toEqual([{ sid: 's1', askId: 'ask1', answer: { allow: true } }])
    expect(received.find((e) => e.type === 'fake.telemetry')).toEqual({
      type: 'fake.telemetry',
      runId: 'run-s1',
      payload: { tokensPerSec: 42 },
    })

    // кадры провода: event… и один end; стрим на хосте снят
    const frames = bridge.frames.filter((f): f is Extract<ProtocolEventPayload, { stream: string }> => 'stream' in f)
    expect(frames.filter((f) => f.type === 'end')).toHaveLength(1)
    expect(frames.at(-1)!.type).toBe('end')
    expect(bridge.host.openStreams).toBe(0)
  })

  it('кадры раньше ответа на вызов — не теряются', async () => {
    const fake = createFakeBackend()
    const { client } = loopback(fake, { replyDelayMs: 40 })
    fake.script('s1', [
      { emit: { type: 'run_start', runId: 'r1' } },
      { emit: { type: 'part_delta', runId: 'r1', messageId: 'a1', part: 0, delta: 'x' } },
      { emit: { type: 'run_end', runId: 'r1', status: 'done', version: 'v2' } },
    ])
    expect(await collect(client.run('s1', {}))).toEqual(fake.emitted)
  })

  it('cancel отменяет ран', async () => {
    const fake = createFakeBackend()
    const { client } = loopback(fake)
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

  it('авария итератора после старта → run_end{status:error} и конец', async () => {
    const fake = createFakeBackend()
    const { client } = loopback(fake)
    fake.script('s1', [
      { emit: { type: 'run_start', runId: 'r1' } },
      { emit: { type: 'message_start', runId: 'r1', message: { id: 'a1', role: 'assistant' } } },
      { throw: new Error('движок умер') },
    ])

    const received = await collect(client.run('s1', {}))
    expect(received.map((e) => e.type)).toEqual(['run_start', 'message_start', 'run_end'])
    const end = received.at(-1) as RunEndEvent
    expect(end).toMatchObject({ status: 'error', runId: 'r1', version: '' })
    expect(end.error?.message).toContain('движок умер')
  })

  it('NotSupportedError после старта → код в run_end', async () => {
    const fake = createFakeBackend()
    const { client } = loopback(fake)
    fake.script('s1', [{ emit: { type: 'run_start', runId: 'r1' } }, { throw: new NotSupportedError('run.regenerate') }])
    expect((await collect(client.run('s1', {}))).at(-1)).toMatchObject({
      type: 'run_end',
      status: 'error',
      error: { code: 'not_supported' },
    })
  })

  it('авария до первого события → ошибка вызова, не стрим; NotSupported — классом', async () => {
    const fake = createFakeBackend()
    const { client, bridge } = loopback(fake)

    fake.script('s1', [{ throw: new Error('не стартовал') }])
    const err = await errOf(collect(client.run('s1', {})))
    expect(err).toBeInstanceOf(BackendError)
    expect((err as BackendError).message).toContain('не стартовал')

    fake.script('s1', [{ throw: new NotSupportedError('run') }])
    expect(await errOf(collect(client.run('s1', {})))).toBeInstanceOf(NotSupportedError)
    expect(bridge.host.openStreams).toBe(0)
  })

  it('второй run при живом → busy; после конца сессия свободна', async () => {
    const fake = createFakeBackend()
    const { client } = loopback(fake)
    const g = gate()
    fake.script('s1', [
      { emit: { type: 'run_start', runId: 'r1' } },
      { await: () => g.promise },
      { emit: { type: 'run_end', runId: 'r1', status: 'done', version: 'v2' } },
    ])

    const first = client.run('s1', {})[Symbol.asyncIterator]()
    expect((await first.next()).value).toEqual({ type: 'run_start', runId: 'r1' })

    const err = await errOf(collect(client.run('s1', {})))
    expect(err).toBeInstanceOf(BackendError)
    expect((err as BackendError).code).toBe('busy')

    g.resolve()
    expect((await first.next()).value).toMatchObject({ type: 'run_end', status: 'done' })
    await first.return?.(undefined)

    fake.script('s1', [{ emit: { type: 'run_end', runId: 'r2', status: 'done', version: 'v3' } }])
    expect(await collect(client.run('s1', {}))).toHaveLength(1)
  })

  it('клиент ушёл посреди стрима — ран НЕ отменён, доигрывает на хосте молча', async () => {
    const fake = createFakeBackend()
    const { client, bridge } = loopback(fake)
    const g = gate()
    fake.script('s1', [
      { emit: { type: 'run_start', runId: 'r1' } },
      { await: () => g.promise },
      { emit: { type: 'run_end', runId: 'r1', status: 'done', version: 'v9' } },
    ])

    for await (const ev of client.run('s1', {})) {
      expect(ev.type).toBe('run_start')
      break
    }
    await waitFor(() => bridge.host.openStreams === 0) // stream.close доехал

    const before = bridge.frames.length
    g.resolve()
    await fake.runFinished('s1')
    await delay(10)

    expect(fake.cancels).toEqual([])
    expect(fake.emitted.at(-1)).toMatchObject({ type: 'run_end', status: 'done', version: 'v9' })
    expect(bridge.frames.length).toBe(before) // брошенному стриму кадров не шлют
    expect((await client.history('s1')).version).toBe('v1')
  })

  it('стрим кончился без run_end → connection_lost', async () => {
    const fake = createFakeBackend()
    const { client } = loopback(fake)
    fake.script('s1', [{ emit: { type: 'run_start', runId: 'r1' } }])
    const received = await collect(client.run('s1', {}))
    expect(received.map((e) => e.type)).toEqual(['run_start', 'run_end'])
    expect(received.at(-1)).toMatchObject({ runId: 'r1', status: 'error', error: { code: 'connection_lost' }, version: '' })
  })

  it('sidecar умер (reset) → синтетический run_end{connection_lost}, вызовы → connection_lost', async () => {
    const fake = createFakeBackend()
    const { client, bridge } = loopback(fake)
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
      if (received.length === 2) bridge.kill()
    }
    expect(received.slice(0, 2).map((e) => e.type)).toEqual(['run_start', 'part_delta'])
    expect(received.at(-1)).toMatchObject({ type: 'run_end', runId: 'r1', status: 'error', error: { code: 'connection_lost' }, version: '' })

    const err = await errOf(client.sessions.list())
    expect(err).toBeInstanceOf(BackendError)
    expect((err as BackendError).code).toBe('connection_lost')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// watch
// ────────────────────────────────────────────────────────────────────────────

describe('workspace.files.watch', () => {
  it('события доезжают; отписка снимает подписку на хосте', async () => {
    const fake = createFakeBackend()
    const files = withFiles(fake)
    const { client, bridge } = loopback(fake)

    const got: WorkspaceUpdateEvent[] = []
    const off = client.workspace!.files!.watch!((ev) => got.push(ev))
    await waitFor(() => files.listeners.size === 1)

    files.emit(['a.md'])
    files.emit(['docs', 'b.md'])
    await waitFor(() => got.length === 2)
    expect(got).toEqual([
      { type: 'workspace_update', paths: ['a.md'] },
      { type: 'workspace_update', paths: ['docs', 'b.md'] },
    ])

    off()
    await waitFor(() => files.listeners.size === 0)
    expect(bridge.host.openStreams).toBe(0)
    files.emit(['late.md'])
    await delay(10)
    expect(got).toHaveLength(2)
  })

  it('отписка до того, как хост ответил, — подписка не повисает', async () => {
    const fake = createFakeBackend()
    const files = withFiles(fake)
    const { client, bridge } = loopback(fake, { replyDelayMs: 20 })

    const off = client.workspace!.files!.watch!(() => {})
    off()
    await delay(60)
    expect(files.listeners.size).toBe(0)
    expect(bridge.host.openStreams).toBe(0)
  })

  it('watch не заявлен → канала нет и ретраев нет', async () => {
    const fake = createFakeBackend()
    withFiles(fake, false)
    const bridge = createMemoryBridge(fake)
    let watchCalls = 0
    client = createTauriBackend({
      invoke: async (cmd, args) => {
        if ((args as { method?: string }).method === 'workspace.files.watch') watchCalls++
        return bridge.invoke(cmd, args)
      },
      listen: bridge.listen,
    })
    client.workspace!.files!.watch!(() => {})
    await delay(700)
    expect(watchCalls).toBe(1)
  })

  it('потеря канала (reset) → переподписка и paths:[""]', async () => {
    const fake = createFakeBackend()
    const files = withFiles(fake)
    const bridge = createMemoryBridge(fake)
    const handlers: Array<(e: { payload: unknown }) => void> = []
    const listen: ListenFn = async (event, handler) => {
      handlers.push(handler)
      return bridge.listen(event, handler)
    }
    client = createTauriBackend({ invoke: bridge.invoke, listen })

    const got: WorkspaceUpdateEvent[] = []
    client.workspace!.files!.watch!((ev) => got.push(ev))
    await waitFor(() => files.listeners.size === 1)

    // оболочка: sidecar перезапущен (хост в тесте тот же — старая подписка остаётся ему)
    for (const h of handlers) h({ payload: { type: 'reset' } })
    await waitFor(() => files.listeners.size === 2, 3000)
    await waitFor(() => got.length === 1)
    expect(got).toEqual([{ type: 'workspace_update', paths: [''] }])

    files.emit(['after.md'])
    await waitFor(() => got.some((e) => e.paths[0] === 'after.md'))
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Жизненный цикл клиента
// ────────────────────────────────────────────────────────────────────────────

describe('клиент', () => {
  it('close() закрывает стримы на хосте и запрещает новые вызовы', async () => {
    const fake = createFakeBackend()
    const files = withFiles(fake)
    const { client, bridge } = loopback(fake)

    client.workspace!.files!.watch!(() => {})
    await waitFor(() => files.listeners.size === 1)
    await client.close!()
    await waitFor(() => files.listeners.size === 0)
    expect(bridge.host.openStreams).toBe(0)
    await expect(client.sessions.list()).rejects.toThrow(/закрыт/)
  })

  it('без invoke/listen и без window.__TAURI__ — внятная ошибка; с __TAURI__ — работает', async () => {
    expect(() => createTauriBackend()).toThrow(/invoke\/listen/)

    const fake = createFakeBackend()
    const b = createMemoryBridge(fake)
    const g = globalThis as { __TAURI__?: unknown }
    g.__TAURI__ = { core: { invoke: b.invoke }, event: { listen: b.listen } }
    try {
      const c = createTauriBackend()
      expect(await c.sessions.list()).toEqual([{ id: 's1', title: 'Первая' }])
    } finally {
      delete g.__TAURI__
    }
  })

  it('invoke отказал (провод) → BackendError connection_lost', async () => {
    client = createTauriBackend({
      invoke: async () => {
        throw new Error('ipc down')
      },
      listen: async () => () => {},
    })
    const err = await errOf(client.capabilities())
    expect(err).toBeInstanceOf(BackendError)
    expect((err as BackendError).code).toBe('connection_lost')
  })
})
