/**
 * store-backend на драйвере nr-chat в сборке стенда nr (
 * nr-driver-switch-spec §1, §4): выбор, персоны, рецепт и `effectivePrompt` —
 * в файле сессии, переживают рестарт; форк и свайп их не теряют; старая
 * pi-сессия читается с `legacyFormat`, запись её переносит.
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readabilityViolations, createNrChatStore } from '@kerneldreams/chat-store/nr-chat'
import { createPiStore } from '@kerneldreams/chat-store/pi'
import { withLegacySessions, type ExtendedSessionStore } from '@kerneldreams/chat-store/migrate'
import type { Persona } from '@kerneldreams/ui-protocol'
import { createStoreBackend, type GenerateRequest } from '../src/store-backend.js'

const MODELS = [{ id: 'm1', name: 'M1' }]
const PROFILES = [{ id: 'default', name: 'Default' }, { id: 'rp', name: 'RP' }]

/** Как стенд (appz/pi serve-nr): расширения драйвера — опциями бэкенда. */
function standBackend(store: ExtendedSessionStore, seen: GenerateRequest[] = []) {
  const generate = async function* (req: GenerateRequest) {
    seen.push(req)
    yield { type: 'recipe' as const, system: 'SYS', mds: '%system\nSYS\n%user\nq\n' }
    yield { type: 'text' as const, delta: 'ответ' }
  }
  return createStoreBackend({
    store,
    generate,
    models: MODELS,
    profiles: PROFILES,
    choices: { get: (sid) => store.choices!.get(sid) as never, set: (sid, c) => store.choices!.set(sid, c as never) },
    prompts: { store: store.recipes as never },
    personas: { store: store.personas as never, raw: true },
    compaction: store.compaction!,
    commands: ['compact'],
  })
}

const CAST: Persona[] = [
  { id: 'roxie', kind: 'char', name: 'Roxie' } as Persona,
  { id: 'max', kind: 'user', name: 'Макс', description: 'промпт Макса', avatar: 'max.png' } as Persona,
]

async function play(backend: ReturnType<typeof standBackend>, sid: string, text: string) {
  const out: string[] = []
  for await (const ev of backend.run(sid, { userMessage: text })) if (ev.type === 'message_end') out.push(ev.messageId)
  return out
}

describe('стенд nr на nr-chat', () => {
  it('выбор, персоны, рецепт и effectivePrompt — в файле, переживают рестарт; одна шапка без nrs*', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stand-nr-'))
    const a = standBackend(createNrChatStore({ dir }))
    const s = await a.sessions.create({ model: { model: 'm1' }, profile: 'rp', title: 'RP' })
    await a.personas!.save!(s.id, CAST, 'max')
    await a.meta!.patch(s.id, { persona: { user: 'Макс' } })
    await play(a, s.id, 'q')
    const answer = (await a.history(s.id)).messages.at(-1)!

    // «Рестарт»: новый бэкенд, новый драйвер над тем же каталогом.
    const seen: GenerateRequest[] = []
    const b = standBackend(createNrChatStore({ dir }), seen)
    expect(await b.sessions.get(s.id)).toMatchObject({ model: { model: 'm1' }, profile: 'rp' })
    expect((await b.personas!.list(s.id)).userId).toBe('max')
    expect((await b.meta!.get(s.id)).effectivePrompt).toBe('%system\nSYS\n%user\nq\n')
    const view = await b.messages!.prompt!(s.id, answer.id)
    expect(view.recipe.systemHash).toMatch(/^[0-9a-f]+$/)
    expect(answer.meta?.recipe).toBeUndefined()

    const text = readFileSync(join(dir, `${s.id}.mds`), 'utf-8')
    // персоны — `%%character` подузлами шапки, маркер — короткое машинное.
    expect(text.split('\n')[0]).toMatch(/^%meta \{.*profile: 'rp'/)
    expect(text.split('\n')[0]).not.toContain('personas')
    expect(text).toMatch(/^%%character \S+ \{kind: 'char'/m)
    expect(readabilityViolations(text)).toEqual([])
    expect(text).not.toMatch(/nrs[A-Z]|customType/)
  })

  it('форк с середины: персона с промптом и аватаром на месте; свайп гритинга — мета на месте', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stand-nr-'))
    const be = standBackend(createNrChatStore({ dir }))
    const s = await be.sessions.create({ profile: 'rp' })
    await be.personas!.save!(s.id, CAST, 'max')
    const g0 = await be.messages!.append!(s.id, [{ type: 'text', text: 'g0' }], { role: 'assistant' })
    await be.messages!.append!(s.id, [{ type: 'text', text: 'g1' }], { role: 'assistant', swipeOf: g0.id })
    await be.meta!.patch(s.id, { persona: { user: 'Макс' } })
    await be.messages!.swipe!(s.id, g0.id, { index: 0 })
    expect((await be.meta!.get(s.id)).persona).toEqual({ user: 'Макс' })
    expect((await be.personas!.list(s.id)).personas).toHaveLength(2)

    await play(be, s.id, 'один')
    await play(be, s.id, 'два')
    const hist = (await be.history(s.id)).messages
    const mid = hist[2]!
    const fork = await be.sessions.fork!(s.id, mid.id)
    const cast = await be.personas!.list(fork.id)
    const max = cast.personas.find((p) => p.id === 'max')!
    expect(max).toMatchObject({ description: 'промпт Макса', avatar: 'max.png' })
    expect((await be.sessions.get(fork.id)).profile).toBe('rp')
    expect((await be.meta!.get(fork.id)).persona).toEqual({ user: 'Макс' })
  })

  it('старая pi-сессия: читается с legacyFormat, ран переносит её в nr-chat; патч {legacyFormat: null} — конвертация', async () => {
    const piDir = mkdtempSync(join(tmpdir(), 'stand-pi-'))
    const nrDir = mkdtempSync(join(tmpdir(), 'stand-nr-'))
    const pi = createPiStore({ dir: piDir, piServiceEntries: 'hide' })
    const old = await pi.create()
    await pi.personas!.set(old.id, { personas: CAST, userId: 'max' })
    await pi.appendNode(old.id, { role: 'assistant', text: 'старое' })
    const old2 = await pi.create()
    await pi.appendNode(old2.id, { role: 'assistant', text: 'ещё' })

    const be = standBackend(withLegacySessions(createNrChatStore({ dir: nrDir }), pi))
    expect((await be.meta!.get(old.id)).legacyFormat).toBe('pi/2')
    expect((await be.history(old.id)).messages.map((m) => m.parts)).toEqual([[{ type: 'text', text: 'старое' }]])

    await play(be, old.id, 'играем дальше')
    expect((await be.meta!.get(old.id)).legacyFormat).toBeUndefined()
    expect(readFileSync(join(nrDir, `${old.id}.mds`), 'utf-8')).toContain('играем дальше')
    expect((await be.personas!.list(old.id)).userId).toBe('max')

    const after = await be.meta!.patch(old2.id, { legacyFormat: null } as never)
    expect(after.legacyFormat).toBeUndefined()
    expect(readFileSync(join(nrDir, `${old2.id}.mds`), 'utf-8')).toContain('ещё')
  })
})
