/**
 * Конструктор профилей (profile-editor-spec §3–4): провод и фикстурная механика
 * store-backend.
 *
 * Провод: `GET/PUT/DELETE /profiles/:id`, `POST /profiles/:id/duplicate {id}`,
 * `GET /catalogs/{tools,skills,extensions}`; незаявленное — not_supported кодом,
 * ошибки бэкенда (not_found, conflict, bad_request) — своими кодами.
 * Store-backend: каталог профилей правится в памяти, каталоги — статика опцией.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNrChatStore } from '@kerneldreams/chat-store/nr-chat'
import { NotSupportedError } from '@kerneldreams/ui-protocol'
import type { ProfileDoc, ProfileInfo, ProtocolBackend } from '@kerneldreams/ui-protocol'
import { serveBackend, type ServeHandle } from '../src/serve.js'
import { BackendError, createHttpBackend } from '../src/client.js'
import {
  createStoreBackend,
  StoreBadRequestError,
  StoreProfileConflictError,
  StoreProfileNotFoundError,
  type StoreBackendOpts,
} from '../src/store-backend.js'
import { createFakeBackend, FAKE_CATALOGS } from './fake-backend.js'
import { noGen } from './store-harness.js'

let srv: ServeHandle | undefined
let client: ProtocolBackend | undefined

afterEach(async () => {
  await client?.close?.()
  await srv?.close()
  srv = undefined
  client = undefined
})

async function loopback(backend: ProtocolBackend): Promise<ProtocolBackend> {
  srv = await serveBackend(backend)
  client = createHttpBackend(srv.url)
  return client
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${srv!.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const errOf = (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e)

const DOC: ProfileDoc = {
  id: 'prompt-gen',
  name: 'Prompt Gen',
  description: 'генератор промптов под модель',
  model: 'nr/opus',
  thinking: 'high',
  tools: ['read'],
  skills: ['dev-skill'],
  extensions: ['pi-ext-web'],
  systemPrompt: 'Ты пишешь промпты.\nПод конкретную модель.',
  prompt: { mode: 'replace', post: 'формат выдачи' },
  extra: { 'no-context-files': 'true' },
}

// ────────────────────────────────────────────────────────────────────────────
// Провод
// ────────────────────────────────────────────────────────────────────────────

describe('конструктор профилей: провод', () => {
  it('capabilities: profiles.edit и catalogs доезжают', async () => {
    const client = await loopback(createFakeBackend())
    const caps = await client.capabilities()
    expect(caps.profiles).toEqual({ switch: true, edit: true })
    expect(caps.catalogs).toEqual({ tools: true, skills: true, extensions: true })
  })

  it('GET /profiles/:id → документ; неизвестный — not_found (404)', async () => {
    const fake = createFakeBackend()
    const client = await loopback(fake)

    expect(await client.profiles!.get('chat')).toEqual({ id: 'chat', name: 'Chat', tools: 'none' })
    const err = await errOf(client.profiles!.get('нет'))
    expect(err).toBeInstanceOf(BackendError)
    expect((err as BackendError).code).toBe('not_found')
    expect((err as BackendError).status).toBe(404)
  })

  it('PUT /profiles/:id → save: документ целиком, многострочный промпт и extra не теряются', async () => {
    const fake = createFakeBackend()
    const client = await loopback(fake)

    expect(await client.profiles!.save!(DOC)).toEqual(DOC)
    expect(fake.profileEdits).toEqual([{ op: 'save', arg: DOC }])
  })

  it('PUT: тело без id берёт id из адреса', async () => {
    const fake = createFakeBackend()
    await loopback(fake)

    const res = await send('PUT', '/profiles/chat-2', { name: 'Chat 2' })
    expect(res.status).toBe(200)
    expect(fake.profileEdits).toEqual([{ op: 'save', arg: { id: 'chat-2', name: 'Chat 2' } }])
  })

  it('PUT: чужой id в теле, нет name — bad_request, бэкенд не тронут', async () => {
    const fake = createFakeBackend()
    await loopback(fake)

    const alien = await send('PUT', '/profiles/a', { id: 'b', name: 'B' })
    expect(alien.status).toBe(400)
    expect(await alien.json()).toMatchObject({ ok: false, code: 'bad_request' })
    expect((await send('PUT', '/profiles/a', { tools: 'none' })).status).toBe(400)
    expect(fake.calls).not.toContain('profiles.save')
  })

  it('DELETE /profiles/:id; default — bad_request кодом', async () => {
    const fake = createFakeBackend()
    const client = await loopback(fake)

    await client.profiles!.delete!('chat')
    expect(fake.profileEdits).toEqual([{ op: 'delete', arg: 'chat' }])
    const err = await errOf(client.profiles!.delete!('default'))
    expect((err as BackendError).code).toBe('bad_request')
  })

  it('POST /profiles/:id/duplicate {id}; занятый — conflict (409); без id — bad_request', async () => {
    const fake = createFakeBackend()
    const client = await loopback(fake)

    expect(await client.profiles!.duplicate!('chat', 'chat-copy')).toEqual({ id: 'chat-copy', name: 'chat' })
    expect(fake.profileEdits).toEqual([{ op: 'duplicate', arg: ['chat', 'chat-copy'] }])

    const taken = await errOf(client.profiles!.duplicate!('chat', 'default'))
    expect((taken as BackendError).code).toBe('conflict')
    expect((taken as BackendError).status).toBe(409)

    expect((await send('POST', '/profiles/chat/duplicate', {})).status).toBe(400)
  })

  it('GET /catalogs/{tools,skills,extensions}; неизвестный вид — 404', async () => {
    const client = await loopback(createFakeBackend())

    expect(await client.catalogs!.tools!()).toEqual(FAKE_CATALOGS.tools)
    expect(await client.catalogs!.skills!()).toEqual(FAKE_CATALOGS.skills)
    expect(await client.catalogs!.extensions!()).toEqual(FAKE_CATALOGS.extensions)
    expect((await send('GET', '/catalogs/models')).status).toBe(404)
  })

  it('без profiles.edit и catalogs — not_supported кодом; get и list живы', async () => {
    const fake = createFakeBackend({
      capabilities: { protocol: 1, profiles: { switch: true } },
      omit: ['profiles.edit', 'catalogs'],
    })
    const client = await loopback(fake)

    await expect(client.profiles!.get('chat')).resolves.toMatchObject({ id: 'chat' })
    const calls = [
      () => client.profiles!.save!(DOC),
      () => client.profiles!.delete!('chat'),
      () => client.profiles!.duplicate!('chat', 'x'),
      () => client.catalogs!.tools!(),
      () => client.catalogs!.skills!(),
      () => client.catalogs!.extensions!(),
    ]
    for (const call of calls) expect(await errOf(call())).toBeInstanceOf(NotSupportedError)
  })

  it('каталог одного вида не заявлен — только он not_supported', async () => {
    const client = await loopback(createFakeBackend({ omit: ['catalogs.extensions'] }))
    await expect(client.catalogs!.tools!()).resolves.toHaveLength(2)
    expect(await errOf(client.catalogs!.extensions!())).toBeInstanceOf(NotSupportedError)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// store-backend: правка каталога в памяти (фикстура)
// ────────────────────────────────────────────────────────────────────────────

describe('store-backend: конструктор профилей', () => {
  const CATALOG: ProfileInfo[] = [
    { id: 'default', name: 'default' },
    { id: 'chat', name: 'Chat', tools: 'none', promptMode: 'replace' },
  ]

  function mk(extra: Partial<StoreBackendOpts> = {}): ProtocolBackend {
    const store = createNrChatStore({ dir: mkdtempSync(join(tmpdir(), 'store-be-editor-')) })
    return createStoreBackend({ store, generate: noGen(), profiles: CATALOG, ...extra })
  }

  it('get: витрина опции становится документом (promptMode → prompt.mode)', async () => {
    const backend = mk()
    expect(await backend.profiles!.get('chat')).toEqual({ id: 'chat', name: 'Chat', tools: 'none', prompt: { mode: 'replace' } })
    expect(await errOf(backend.profiles!.get('нет'))).toBeInstanceOf(StoreProfileNotFoundError)
  })

  it('save: create, затем update; list и create({profile}) видят новый профиль', async () => {
    const backend = mk()

    expect(await backend.profiles!.save!(DOC)).toEqual(DOC)
    expect((await backend.profiles!.list()).map((p) => p.id)).toEqual(['default', 'chat', 'prompt-gen'])
    expect((await backend.sessions.create({ profile: 'prompt-gen' })).profile).toBe('prompt-gen')

    await backend.profiles!.save!({ ...DOC, name: 'Prompt Gen 2', tools: 'all' })
    expect((await backend.profiles!.list()).find((p) => p.id === 'prompt-gen')).toEqual({
      id: 'prompt-gen',
      name: 'Prompt Gen 2',
      description: DOC.description,
      tools: 'all',
      skills: ['dev-skill'],
      model: 'nr/opus',
      promptMode: 'replace',
    })
  })

  it('save без extra не стирает прежний extra; наружу — копии', async () => {
    const backend = mk()
    await backend.profiles!.save!(DOC)
    const { extra: _extra, ...withoutExtra } = DOC
    expect((await backend.profiles!.save!(withoutExtra)).extra).toEqual(DOC.extra)

    const got = await backend.profiles!.get('prompt-gen')
    got.tools = 'none'
    expect((await backend.profiles!.get('prompt-gen')).tools).toEqual(['read'])
  })

  it('save с битым id — bad_request, каталог не тронут', async () => {
    const backend = mk()
    for (const id of ['', 'Chat', '../x', '-x']) {
      const err = await errOf(backend.profiles!.save!({ id, name: 'x' }))
      expect(err).toBeInstanceOf(StoreBadRequestError)
      expect((err as StoreBadRequestError).code).toBe('bad_request')
    }
    expect(await backend.profiles!.list()).toHaveLength(2)
  })

  it('delete: профиль по умолчанию — bad_request; неизвестный — not_found; сессия удалённого — на default', async () => {
    const backend = mk()
    expect(await errOf(backend.profiles!.delete!('default'))).toBeInstanceOf(StoreBadRequestError)
    expect(await errOf(backend.profiles!.delete!('нет'))).toBeInstanceOf(StoreProfileNotFoundError)

    const s = await backend.sessions.create({ profile: 'chat' })
    await backend.profiles!.delete!('chat')
    expect((await backend.profiles!.list()).map((p) => p.id)).toEqual(['default'])
    expect((await backend.sessions.get(s.id)).profile).toBe('default')
  })

  it('duplicate: копия под новым id; занятый — conflict; битый — bad_request; нет источника — not_found', async () => {
    const backend = mk()

    expect(await backend.profiles!.duplicate!('chat', 'chat-2')).toEqual({ id: 'chat-2', name: 'Chat', tools: 'none', prompt: { mode: 'replace' } })
    expect((await backend.profiles!.list()).map((p) => p.id)).toEqual(['default', 'chat', 'chat-2'])

    const taken = await errOf(backend.profiles!.duplicate!('chat', 'default'))
    expect(taken).toBeInstanceOf(StoreProfileConflictError)
    expect((taken as StoreProfileConflictError).code).toBe('conflict')
    expect(await errOf(backend.profiles!.duplicate!('chat', 'Bad Id'))).toBeInstanceOf(StoreBadRequestError)
    expect(await errOf(backend.profiles!.duplicate!('нет', 'x'))).toBeInstanceOf(StoreProfileNotFoundError)
  })

  it('catalogs: заданный вид ⇔ флаг и метод; без опции — ничего', async () => {
    const without = mk()
    expect((await without.capabilities()).catalogs).toBeUndefined()
    expect(without.catalogs).toBeUndefined()

    const backend = mk({ catalogs: { tools: FAKE_CATALOGS.tools, skills: FAKE_CATALOGS.skills } })
    expect((await backend.capabilities()).catalogs).toEqual({ tools: true, skills: true })
    expect(await backend.catalogs!.tools!()).toEqual(FAKE_CATALOGS.tools)
    expect(await backend.catalogs!.skills!()).toEqual(FAKE_CATALOGS.skills)
    expect(backend.catalogs!.extensions).toBeUndefined()
  })

  it('через провод: save → list → сессия с профилем → duplicate → delete', async () => {
    const client = await loopback(mk({ catalogs: FAKE_CATALOGS }))

    await client.profiles!.save!(DOC)
    expect((await client.profiles!.list()).map((p) => p.id)).toContain('prompt-gen')
    expect((await client.sessions.create({ profile: 'prompt-gen' })).profile).toBe('prompt-gen')
    expect((await client.profiles!.duplicate!('prompt-gen', 'prompt-gen-2')).systemPrompt).toBe(DOC.systemPrompt)
    await client.profiles!.delete!('prompt-gen')
    expect((await errOf(client.profiles!.get('prompt-gen')) as BackendError).code).toBe('not_found')
    expect((await client.catalogs!.extensions!())[0]!.id).toBe('pi-ext-web')
  })
})
