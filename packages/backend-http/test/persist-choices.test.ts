/**
 * Выбор модели/профиля и каталог профилей не в памяти (DEBT):
 * `choices` — выбор переживает новый экземпляр бэкенда (рестарт), лениво
 * поднимается на get/run; `profileStore` — правки конструктора уходят в
 * хранилище, внешняя правка видна без рестарта, встроенные профили — первыми.
 */

import { describe, expect, it } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import type { ProfileDoc } from '@kerneldreams/ui-protocol'
import { createStoreBackend, type GenerateRequest, type SessionChoices } from '../src/store-backend.js'

const MODELS = [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }]

function memoryChoices() {
  const byId = new Map<string, SessionChoices>()
  return {
    byId,
    get: async (sid: string) => ({ ...(byId.get(sid) ?? {}) }),
    set: async (sid: string, c: SessionChoices) => void byId.set(sid, { ...(byId.get(sid) ?? {}), ...c }),
  }
}

function fileProfiles(initial: ProfileDoc[]) {
  const files = new Map(initial.map((p) => [p.id, p]))
  return {
    files,
    list: () => [...files.values()],
    save: (doc: ProfileDoc) => (files.set(doc.id, { ...doc, description: 'saved' }), files.get(doc.id)!),
    delete: (id: string) => void files.delete(id),
  }
}

describe('choices: выбор переживает рестарт', () => {
  it('модель и профиль из create/set — в хранилище; новый экземпляр поднимает их на get и run', async () => {
    const store = createMemoryStore()
    const choices = memoryChoices()
    const seen: GenerateRequest[] = []
    const generate = async function* (req: GenerateRequest) {
      seen.push(req)
      yield { type: 'text' as const, delta: 'ok' }
    }
    const profiles = [{ id: 'default', name: 'Default' }, { id: 'agent', name: 'Agent' }]
    const a = createStoreBackend({ store, generate, models: MODELS, profiles, choices })
    const s = await a.sessions.create({ model: { model: 'm2' } })
    expect(choices.byId.get(s.id)).toEqual({ model: { model: 'm2' } })
    await a.profiles!.set!(s.id, 'agent')
    expect(choices.byId.get(s.id)).toEqual({ model: { model: 'm2' }, profile: 'agent' })

    // «Рестарт»: новый бэкенд над тем же стором и хранилищем выбора.
    const b = createStoreBackend({ store, generate, models: MODELS, profiles, choices })
    expect((await b.sessions.get(s.id))).toMatchObject({ model: { model: 'm2' }, profile: 'agent' })
    const c = createStoreBackend({ store, generate, models: MODELS, profiles, choices })
    for await (const _ of c.run(s.id, { userMessage: 'x' })) void _
    expect(seen.at(-1)!.session.model).toEqual({ model: 'm2' })
    expect(seen.at(-1)!.profile?.id).toBe('agent')
  })

  it('встроенный профиль переживает рестарт документом (ABC-224); неизвестная модель не восстанавливается', async () => {
    const store = createMemoryStore()
    const choices = memoryChoices()
    const seen: GenerateRequest[] = []
    const gen = async function* (req: GenerateRequest) {
      seen.push(req)
      yield { type: 'text' as const, delta: 'ok' }
    }
    const a = createStoreBackend({ store, generate: gen, models: MODELS, profiles: [{ id: 'default', name: 'D' }], choices })
    const s = await a.sessions.create({ profile: { name: 'Inline', systemPrompt: 'SP' } })
    expect(choices.byId.get(s.id)).toMatchObject({ profile: 'inline', profileDoc: { name: 'Inline', systemPrompt: 'SP' } })
    const b = createStoreBackend({ store, generate: gen, models: MODELS, profiles: [{ id: 'default', name: 'D' }], choices })
    expect(await b.sessions.get(s.id)).toMatchObject({ profile: 'inline', profileDoc: { name: 'Inline', systemPrompt: 'SP' } })
    for await (const _ of b.run(s.id, { userMessage: 'x' })) void _
    expect(seen.at(-1)!.profile).toMatchObject({ id: 'inline', systemPrompt: 'SP' })

    choices.byId.set(s.id, { model: { model: 'ghost' } })
    const c = createStoreBackend({ store, generate: gen, models: MODELS, profiles: [{ id: 'default', name: 'D' }], choices })
    expect((await c.sessions.get(s.id)).model).toBeUndefined()
  })
})

describe('profileStore: каталог профилей в файлах', () => {
  it('встроенные первыми, save/delete/duplicate — в хранилище, внешняя правка видна', async () => {
    const fp = fileProfiles([{ id: 'agent', name: 'Agent' }])
    const b = createStoreBackend({ store: createMemoryStore(), generate: async function* () {}, profiles: [{ id: 'default', name: 'Default' }], profileStore: fp })
    expect((await b.profiles!.list()).map((p) => p.id)).toEqual(['default', 'agent'])
    const saved = await b.profiles!.save!({ id: 'rp', name: 'RP', tools: 'none' })
    expect(saved.description).toBe('saved')
    expect(fp.files.has('rp')).toBe(true)
    await b.profiles!.duplicate!('rp', 'rp-2')
    expect(fp.files.get('rp-2')?.name).toBe('RP')
    await b.profiles!.delete!('rp')
    expect(fp.files.has('rp')).toBe(false)
    fp.files.set('ext', { id: 'ext', name: 'Внешний' }) // правка файла руками
    expect((await b.profiles!.list()).map((p) => p.id)).toEqual(['default', 'agent', 'rp-2', 'ext'])
    expect((await b.profiles!.get!('ext')).name).toBe('Внешний')
    await expect(b.profiles!.delete!('default')).rejects.toThrow(/не удаляется/)
  })
})
