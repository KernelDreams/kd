/**
 * Бот = сессия (bot-as-session-spec §1): append от assistant и swipeOf,
 * встроенный профиль в create/set.
 *
 * Провод — что тело доезжает до бэкенда и битое отсекается до него. Store-backend —
 * механика: гритинг без рана, свайпы первого сообщения, документ профиля при сессии.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNrChatStore } from '@kerneldreams/chat-store/nr-chat'
import type { ProfileDoc, ProfileInfo, ProtocolBackend } from '@kerneldreams/ui-protocol'
import { serveBackend, type ServeHandle } from '../src/serve.js'
import { createHttpBackend } from '../src/client.js'
import { StoreBadRequestError, createStoreBackend, type GenerateFn } from '../src/store-backend.js'
import { createFakeBackend, type FakeBackend } from './fake-backend.js'
import { noGen, scriptGen } from './store-harness.js'

const IRIS: ProfileDoc = { id: 'whatever', name: 'Ирис', tools: 'none', prompt: { mode: 'replace' } }

let srv: ServeHandle | undefined
let client: ProtocolBackend | undefined

afterEach(async () => {
  await client?.close?.()
  await srv?.close()
  srv = undefined
  client = undefined
})

async function loopback(fake: FakeBackend) {
  srv = await serveBackend(fake)
  client = createHttpBackend(srv.url)
  return { srv, client }
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${srv!.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ────────────────────────────────────────────────────────────────────────────
// Провод
// ────────────────────────────────────────────────────────────────────────────

describe('бот = сессия: провод', () => {
  it('create с документом профиля доезжает телом, SessionInfo несёт inline + profileDoc', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)

    const info = await client.sessions.create({ title: 'Ирис', profile: IRIS })
    expect(fake.createOpts.at(-1)?.profile).toEqual(IRIS)
    expect(info.profile).toBe('inline')
    expect(info.profileDoc).toEqual({ ...IRIS, id: 'inline' })
  })

  it('profiles.set с документом едет {doc}, с id — {id}', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)

    expect(await client.profiles!.set!('s1', IRIS)).toEqual({ id: 'inline', name: 'Ирис' })
    await client.profiles!.set!('s1', 'chat')
    expect(fake.profileSets).toEqual([
      { sid: 's1', id: 'inline', doc: { ...IRIS, id: 'inline' } },
      { sid: 's1', id: 'chat' },
    ])
  })

  it('битый профиль — bad_request до бэкенда: и id, и doc; doc без name; create с пустым объектом', async () => {
    const fake = createFakeBackend()
    await loopback(fake)

    for (const body of [{ id: 'chat', doc: IRIS }, { doc: {} }, { doc: 'chat' }]) {
      const res = await post('/sessions/s1/profile', body)
      expect(res.status).toBe(400)
    }
    expect((await post('/sessions', { profile: {} })).status).toBe(400)
    expect(fake.calls).not.toContain('profiles.set')
    expect(fake.calls).not.toContain('sessions.create')
  })

  it('append: role assistant и swipeOf доезжают', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)
    const parts = [{ type: 'text' as const, text: '— Реестр закрыт.' }]

    const msg = await client.messages!.append!('s1', parts, { role: 'assistant', swipeOf: 'm1' })
    expect(msg.role).toBe('assistant')
    expect(fake.edits).toEqual([{ op: 'append', sid: 's1', mid: '', arg: { parts, opts: { role: 'assistant', swipeOf: 'm1' } } }])
  })

  it('append: swipeOf не строкой — bad_request до бэкенда', async () => {
    const fake = createFakeBackend()
    await loopback(fake)

    for (const swipeOf of [42, '']) {
      const res = await post('/sessions/s1/messages', { parts: [{ type: 'text', text: 'x' }], swipeOf })
      expect(res.status).toBe(400)
    }
    expect(fake.edits).toEqual([])
  })
})

// ────────────────────────────────────────────────────────────────────────────
// store-backend
// ────────────────────────────────────────────────────────────────────────────

const CATALOG: ProfileInfo[] = [
  { id: 'default', name: 'default' },
  { id: 'chat', name: 'Chat', tools: 'none' },
]

function mk(generate: GenerateFn = noGen(), profiles: ProfileInfo[] | undefined = CATALOG) {
  const store = createNrChatStore({ dir: mkdtempSync(join(tmpdir(), 'store-be-bot-')) })
  return createStoreBackend({ store, generate, profiles })
}

const text = (t: string) => [{ type: 'text' as const, text: t }]

describe('бот = сессия: store-backend append', () => {
  it('assistant без рана — гритинг первым сообщением', async () => {
    const backend = mk()
    const s = await backend.sessions.create()

    const greeting = await backend.messages.append!(s.id, text('— Реестр закрыт.'), { role: 'assistant' })
    expect(greeting.role).toBe('assistant')
    const { messages } = await backend.history(s.id)
    expect(messages.map((m) => [m.role, m.parts])).toEqual([['assistant', text('— Реестр закрыт.')]])
  })

  it('swipeOf — альтернатива, она активна; swipe возвращает первую', async () => {
    const backend = mk()
    const s = await backend.sessions.create()
    const first = await backend.messages.append!(s.id, text('первый'), { role: 'assistant' })

    const alt = await backend.messages.append!(s.id, text('второй'), { swipeOf: first.id })
    expect(alt.role).toBe('assistant')
    expect(alt.swipes).toEqual({ active: 1, count: 2 })
    expect((await backend.history(s.id)).messages.map((m) => m.parts)).toEqual([text('второй')])

    await backend.messages.swipe!(s.id, alt.id, { index: 0 })
    const { messages } = await backend.history(s.id)
    expect(messages.map((m) => m.parts)).toEqual([text('первый')])
    expect(messages[0]!.swipes).toEqual({ active: 0, count: 2 })
  })

  it('swipeOf у сообщения с родителем — сиблинг под тем же родителем', async () => {
    const backend = mk(scriptGen({ chunks: [{ type: 'text', delta: 'ответ' }] }))
    const s = await backend.sessions.create()
    for await (const _ of backend.run(s.id, { userMessage: 'привет' })) { /* drain */ }
    const [user, answer] = (await backend.history(s.id)).messages

    await backend.messages.append!(s.id, text('иначе'), { role: 'assistant', swipeOf: answer!.id })
    const { messages } = await backend.history(s.id)
    expect(messages.map((m) => m.id)[0]).toBe(user!.id)
    expect(messages.map((m) => m.parts)).toEqual([text('привет'), text('иначе')])
  })

  it('swipeOf с чужой ролью — bad_request; неизвестный id — ошибка, запись не легла', async () => {
    const backend = mk()
    const s = await backend.sessions.create()
    const first = await backend.messages.append!(s.id, text('первый'), { role: 'assistant' })

    await expect(backend.messages.append!(s.id, text('x'), { role: 'user', swipeOf: first.id })).rejects.toBeInstanceOf(
      StoreBadRequestError,
    )
    await expect(backend.messages.append!(s.id, text('x'), { swipeOf: 'нет' })).rejects.toThrow()
    expect((await backend.history(s.id)).messages).toHaveLength(1)
  })

  it('роль вне user/assistant/system — bad_request', async () => {
    const backend = mk()
    const s = await backend.sessions.create()
    await expect(
      backend.messages.append!(s.id, text('x'), { role: 'tool' as unknown as 'user' }),
    ).rejects.toBeInstanceOf(StoreBadRequestError)
  })
})

describe('бот = сессия: store-backend inline-профиль', () => {
  it('create с документом — inline + profileDoc, каталог не тронут, генерация видит документ', async () => {
    let seen: { profile?: string; profileDoc?: ProfileDoc } | undefined
    const inner = scriptGen({ chunks: [{ type: 'text', delta: 'ок' }] })
    const backend = mk((req) => {
      seen = { profile: req.session.profile, profileDoc: req.session.profileDoc }
      return inner(req)
    })

    const s = await backend.sessions.create({ profile: IRIS })
    expect(s.profile).toBe('inline')
    expect(s.profileDoc).toEqual({ ...IRIS, id: 'inline' })
    expect((await backend.sessions.get(s.id)).profileDoc?.name).toBe('Ирис')
    expect(await backend.profiles!.list()).toEqual(CATALOG)

    for await (const _ of backend.run(s.id, { userMessage: 'привет' })) { /* drain */ }
    expect(seen).toEqual({ profile: 'inline', profileDoc: { ...IRIS, id: 'inline' } })
  })

  it('set: документ → inline, id → каталожный, документ снимается', async () => {
    const backend = mk()
    const s = await backend.sessions.create()

    expect(await backend.profiles!.set!(s.id, IRIS)).toEqual({ id: 'inline', name: 'Ирис', tools: 'none', promptMode: 'replace' })
    expect((await backend.sessions.get(s.id)).profile).toBe('inline')

    await backend.profiles!.set!(s.id, 'chat')
    const info = await backend.sessions.get(s.id)
    expect(info.profile).toBe('chat')
    expect(info.profileDoc).toBeUndefined()
  })

  it('каталожный профиль с id inline не сохраняется', async () => {
    const backend = mk()
    await expect(backend.profiles!.save!({ id: 'inline', name: 'x' })).rejects.toBeInstanceOf(StoreBadRequestError)
  })

  it('документ без name — bad_request', async () => {
    const backend = mk()
    await expect(backend.sessions.create({ profile: {} as ProfileDoc })).rejects.toBeInstanceOf(StoreBadRequestError)
    expect(await backend.sessions.list()).toEqual([])
  })
})
