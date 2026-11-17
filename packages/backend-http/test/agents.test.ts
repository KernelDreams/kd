/**
 * Агенты (agents-spec §2–3) у store-бэкенда: каталог глазами проекта
 * (агенты проекта поверх общих), `$agent` проекта, документ агента из общего
 * каталога — профиль сессии его id (не `inline`), переживает гидратацию.
 */

import { describe, expect, it } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import type { AnyRunEvent, ProfileDoc } from '@kerneldreams/ui-protocol'
import { createStoreBackend, type GenerateFn, type GenerateRequest } from '../src/store-backend.js'
import { createMemoryProjects, type ProjectEntry } from '../src/projects.js'

function recorder(): { gen: GenerateFn; seen: GenerateRequest[] } {
  const seen: GenerateRequest[] = []
  return {
    seen,
    gen: async function* (req) {
      seen.push(req)
      yield { type: 'text', text: 'ok' }
    },
  }
}

async function drain(it: AsyncIterable<AnyRunEvent>): Promise<void> {
  for await (const _ of it) { /* drain */ }
}

const RP: ProjectEntry = { id: 'rp-lab', name: 'rp-lab', root: '/work/rp', profile: 'narrator' }
const STAND: ProfileDoc[] = [{ id: 'chat', name: 'Chat', template: '/e/agents/chat.mds', source: 'agents' }]
const PROJECT: ProfileDoc[] = [{ id: 'narrator', name: 'Narrator', template: '/e/projects/rp-lab/agents/narrator.mds', source: 'agents', engine: 'nr' }]

function mk() {
  const r = recorder()
  const choices = new Map<string, Record<string, unknown>>()
  const backend = createStoreBackend({
    store: createMemoryStore(),
    generate: r.gen,
    profiles: [{ id: 'default', name: 'Default' }],
    profileStore: {
      list: (ws) => (ws === 'rp-lab' ? [...STAND, ...PROJECT] : STAND),
      save: (d) => d,
      delete: () => {},
    },
    choices: {
      get: async (sid) => (choices.get(sid) ?? {}) as never,
      set: async (sid, c) => void choices.set(sid, { ...(choices.get(sid) ?? {}), ...c }),
    },
    projects: createMemoryProjects({ root: '/stand', projects: [RP] }),
  })
  return { backend, r, choices }
}

describe('агенты: store-бэкенд (ABC-314)', () => {
  it('list глазами проекта: агенты проекта поверх общих; без проекта — общие', async () => {
    const { backend } = mk()
    expect((await backend.profiles!.list()).map((p) => p.id)).toEqual(['default', 'chat'])
    const inProject = await backend.profiles!.list({ workspace: 'rp-lab' })
    expect(inProject.map((p) => p.id)).toEqual(['default', 'chat', 'narrator'])
    expect(inProject[2]).toMatchObject({ engine: 'nr', source: 'agents' })
    expect((await backend.profiles!.get('narrator', { workspace: 'rp-lab' })).template).toContain('narrator.mds')
    await expect(backend.profiles!.get('narrator')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('$agent проекта — агент проекта: профиль сессии его id, генерация видит документ', async () => {
    const { backend, r } = mk()
    const s = await backend.sessions.create({ workspace: 'rp-lab' })
    expect(s.profile).toBe('narrator')
    expect(s.profileDoc).toBeUndefined()
    await drain(backend.run(s.id, { userMessage: 'hi' }))
    expect(r.seen[0]!.profile).toMatchObject({ id: 'narrator', template: '/e/projects/rp-lab/agents/narrator.mds' })
  })

  it('явный id агента проекта — тоже; документ сохранён в сессии', async () => {
    const { backend, choices } = mk()
    const s = await backend.sessions.create({ workspace: 'rp-lab', profile: 'narrator' })
    expect(s.profile).toBe('narrator')
    expect(choices.get(s.id)).toMatchObject({ profile: 'narrator', profileDoc: { id: 'narrator' } })
  })

  it('документ агента с source (от хаба) — профиль его id, не inline; новый процесс поднимает документ из сессии', async () => {
    const store = createMemoryStore()
    const choices = new Map<string, Record<string, unknown>>()
    const make = (r: ReturnType<typeof recorder>) =>
      createStoreBackend({
        store,
        generate: r.gen,
        profiles: [{ id: 'default', name: 'Default' }],
        profileStore: { list: () => STAND, save: (d) => d, delete: () => {} },
        choices: {
          get: async (sid) => (choices.get(sid) ?? {}) as never,
          set: async (sid, c) => void choices.set(sid, { ...(choices.get(sid) ?? {}), ...c }),
        },
      })
    const doc: ProfileDoc = { id: 'cc-only', name: 'CC', template: '/e/profiles-acp/cc-only.mds', source: 'legacy' }
    const s = await make(recorder()).sessions.create({ profile: doc })
    expect(s.profile).toBe('cc-only')
    expect(s.profileDoc).toBeUndefined()
    expect(choices.get(s.id)).toMatchObject({ profile: 'cc-only', profileDoc: { template: '/e/profiles-acp/cc-only.mds' } })

    const r2 = recorder()
    const fresh = make(r2)
    await drain(fresh.run(s.id, { userMessage: 'hi' }))
    expect(r2.seen[0]!.profile).toMatchObject({ id: 'cc-only', template: '/e/profiles-acp/cc-only.mds' })
    expect((await fresh.sessions.get(s.id)).profile).toBe('cc-only')
  })
})
