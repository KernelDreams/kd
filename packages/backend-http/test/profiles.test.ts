/**
 * Профили сессии (profiles-spec §4–5): провод и фикстурная опция store-backend.
 *
 * Провод: `GET /profiles`, `POST /sessions/:id/profile {id}`, `profile` в теле
 * `sessions.create`; незаявленное — not_supported кодом. Store-backend: каталог
 * опцией, выбор без семантики — только запоминается и виден в `SessionInfo`.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNrChatStore } from '@kerneldreams/chat-store/nr-chat'
import { NotSupportedError } from '@kerneldreams/ui-protocol'
import type { AnyRunEvent, ProfileInfo, ProtocolBackend } from '@kerneldreams/ui-protocol'
import { serveBackend, type ServeHandle } from '../src/serve.js'
import { BackendError, createHttpBackend } from '../src/client.js'
import { createStoreBackend, StoreBusyError, StoreUnknownProfileError, type GenerateFn } from '../src/store-backend.js'
import { createFakeBackend, FAKE_PROFILES, type FakeBackend } from './fake-backend.js'
import { noGen, scriptGen } from './store-harness.js'

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

describe('профили: провод', () => {
  it('GET /profiles отдаёт каталог целиком, capability доезжает', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)

    expect(await client.profiles!.list()).toEqual(FAKE_PROFILES)
    expect(fake.calls).toContain('profiles.list')
    expect((await client.capabilities()).profiles).toEqual({ switch: true, edit: true })
  })

  it('v1.27: ?workspace= доезжает до profiles.list/get (каталог глазами проекта клиента)', async () => {
    const fake = createFakeBackend()
    const seen: unknown[] = []
    const list = fake.profiles!.list.bind(fake.profiles)
    const get = fake.profiles!.get.bind(fake.profiles)
    fake.profiles!.list = async (opts) => (seen.push(['list', opts]), list(opts))
    fake.profiles!.get = async (id, opts) => (seen.push(['get', id, opts]), get(id, opts))
    const { client } = await loopback(fake)

    await client.profiles!.list({ workspace: 'nrchat' })
    await client.profiles!.list()
    await client.profiles!.get(FAKE_PROFILES[0]!.id, { workspace: 'runz' }).catch(() => {})
    expect(seen).toEqual([
      ['list', { workspace: 'nrchat' }],
      ['list', undefined],
      ['get', FAKE_PROFILES[0]!.id, { workspace: 'runz' }],
    ])
  })

  it('POST /sessions/:id/profile доезжает до бэкенда и возвращает профиль', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)

    expect(await client.profiles!.set!('s1', 'chat')).toEqual(FAKE_PROFILES[1])
    expect(fake.profileSets).toEqual([{ sid: 's1', id: 'chat' }])
    expect((await client.sessions.get('s1')).profile).toBe('chat')
  })

  it('id сессии со слэшем не рвёт роут /profile', async () => {
    const fake = createFakeBackend({ sessions: [{ id: 'grp/s1' }] })
    const { client } = await loopback(fake)

    await client.profiles!.set!('grp/s1', 'chat')
    expect(fake.profileSets[0]!.sid).toBe('grp/s1')
  })

  it('sessions.create с профилем доезжает телом, SessionInfo его несёт', async () => {
    const fake = createFakeBackend()
    const { client } = await loopback(fake)

    const info = await client.sessions.create({ title: 'Чат', profile: 'chat' })
    expect(fake.createOpts.at(-1)?.profile).toBe('chat')
    expect(info.profile).toBe('chat')
  })

  it('битое тело → bad_request, бэкенд не тронут', async () => {
    const fake = createFakeBackend()
    await loopback(fake)

    const noId = await post('/sessions/s1/profile', {})
    expect(noId.status).toBe(400)
    expect(await noId.json()).toMatchObject({ ok: false, code: 'bad_request' })

    const badCreate = await post('/sessions', { profile: 42 })
    expect(badCreate.status).toBe(400)

    expect(fake.calls).not.toContain('profiles.set')
    expect(fake.calls).not.toContain('sessions.create')
  })

  it('неизвестный профиль — bad_request от бэкенда доезжает кодом', async () => {
    const { client } = await loopback(createFakeBackend())
    const err = await client.profiles!.set!('s1', 'нет-такого').then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(BackendError)
    expect((err as BackendError).code).toBe('bad_request')
    expect((err as BackendError).status).toBe(400)
  })

  it('list есть, set нет (без switch) → set отказывает, list работает', async () => {
    const fake = createFakeBackend({ capabilities: { protocol: 1, profiles: {} }, omit: ['profiles.set'] })
    const { client } = await loopback(fake)

    await expect(client.profiles!.list()).resolves.toEqual(FAKE_PROFILES)
    await expect(client.profiles!.set!('s1', 'chat')).rejects.toBeInstanceOf(NotSupportedError)
  })

  it('профилей нет вовсе → not_supported на обе операции', async () => {
    const fake = createFakeBackend({ capabilities: { protocol: 1 }, omit: ['profiles'] })
    const { client } = await loopback(fake)

    for (const call of [() => client.profiles!.list(), () => client.profiles!.set!('s1', 'chat')]) {
      const err = await call().then(() => null, (e: unknown) => e)
      expect(err).toBeInstanceOf(NotSupportedError)
      expect((err as NotSupportedError).code).toBe('not_supported')
    }
  })
})

// ────────────────────────────────────────────────────────────────────────────
// store-backend: опция каталога (фикстура)
// ────────────────────────────────────────────────────────────────────────────

describe('store-backend: опция profiles', () => {
  const CATALOG: ProfileInfo[] = [
    { id: 'default', name: 'default' },
    { id: 'chat', name: 'Chat', tools: 'none', promptMode: 'replace' },
  ]

  function mk(profiles: ProfileInfo[] | undefined, generate: GenerateFn = noGen()) {
    const store = createNrChatStore({ dir: mkdtempSync(join(tmpdir(), 'store-be-profiles-')) })
    return createStoreBackend({ store, generate, profiles })
  }

  it('без опции — ни capability, ни метода, ни поля сессии', async () => {
    const backend = mk(undefined)
    expect((await backend.capabilities()).profiles).toBeUndefined()
    expect(backend.profiles).toBeUndefined()
    expect((await backend.sessions.create({ profile: 'chat' })).profile).toBeUndefined()
  })

  it('с опцией — capability {switch, edit} и каталог', async () => {
    const backend = mk(CATALOG)
    expect((await backend.capabilities()).profiles).toEqual({ switch: true, edit: true })
    expect(await backend.profiles!.list()).toEqual(CATALOG)
  })

  it('сессия без выбора — первый профиль каталога; create({profile}) фиксирует выбор', async () => {
    const backend = mk(CATALOG)
    expect((await backend.sessions.create()).profile).toBe('default')

    const chat = await backend.sessions.create({ profile: 'chat' })
    expect(chat.profile).toBe('chat')
    expect((await backend.sessions.get(chat.id)).profile).toBe('chat')
    expect((await backend.sessions.list()).find((s) => s.id === chat.id)?.profile).toBe('chat')
  })

  it('create с неизвестным профилем — bad_request, сессия не создана', async () => {
    const backend = mk(CATALOG)
    const err = await backend.sessions.create({ profile: 'нет' }).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(StoreUnknownProfileError)
    expect((err as StoreUnknownProfileError).code).toBe('bad_request')
    expect(await backend.sessions.list()).toEqual([])
  })

  it('set меняет профиль, генерация видит его в session', async () => {
    let seen: string | undefined
    const inner = scriptGen({ chunks: [{ type: 'text', delta: 'ок' }] })
    const generate: GenerateFn = (req) => {
      seen = req.session.profile
      return inner(req)
    }
    const backend = mk(CATALOG, generate)
    const s = await backend.sessions.create()

    expect(await backend.profiles!.set!(s.id, 'chat')).toEqual(CATALOG[1])
    for await (const _ of backend.run(s.id, { userMessage: 'привет' })) { /* drain */ }
    expect(seen).toBe('chat')
  })

  it('смена посреди рана — busy, выбор не меняется', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const generate: GenerateFn = async function* () {
      await gate
      yield { type: 'text', delta: 'ок' }
    }
    const backend = mk(CATALOG, generate)
    const s = await backend.sessions.create()

    const it = backend.run(s.id, { userMessage: 'привет' })[Symbol.asyncIterator]()
    const first = await it.next()
    expect((first.value as AnyRunEvent).type).toBe('run_start')

    const err = await backend.profiles!.set!(s.id, 'chat').then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(StoreBusyError)

    release()
    while (!(await it.next()).done) { /* drain */ }
    expect((await backend.sessions.get(s.id)).profile).toBe('default')
  })
})
