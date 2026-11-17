/**
 * Хаб и агенты (agents-spec §3): один каталог без дублей, движок
 * агента по умолчанию и перебивка при создании, документ агента движку, у
 * которого его нет (профиль сессии — id агента), модель чужого движка —
 * модель движка и скрытая заметка.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNrChatStore } from '@kerneldreams/chat-store/nr-chat'
import type { ProfileDoc } from '@kerneldreams/ui-protocol'
import { createStoreBackend, type GenerateRequest } from '../src/store-backend.js'
import { createMemoryProjects } from '../src/projects.js'
import { serveBackend } from '../src/serve.js'
import { createHttpBackend } from '../src/client.js'
import { createHub } from '../src/hub.js'

const WRITER: ProfileDoc = { id: 'writer', name: 'Writer', template: '/e/agents/writer.mds', source: 'agents', engine: 'acp', model: 'opus' }
const PLAIN: ProfileDoc = { id: 'plain', name: 'Plain', template: '/e/agents/plain.mds', source: 'agents' }
const SONNY: ProfileDoc = { id: 'sonny', name: 'Sonny', template: '/e/agents/sonny.mds', source: 'agents', model: 'sonnet' }
const SNAP: ProfileDoc = { id: 'snap', name: 'Слепок', template: '/e/profiles-acp/snap.mds', source: 'legacy' }

function engine(name: string, seen: GenerateRequest[], agents: ProfileDoc[], models: string[]) {
  return createStoreBackend({
    store: createNrChatStore({ dir: mkdtempSync(join(tmpdir(), `hub-ag-${name}-`)) }),
    name,
    models: models.map((id) => ({ id })),
    profiles: [{ id: 'default', name: 'Default' }],
    profileStore: { list: () => agents, save: (d) => d, delete: () => {} },
    generate: async function* (req: GenerateRequest) {
      seen.push(req)
      yield { type: 'text' as const, delta: `${name}` }
    },
    projects: createMemoryProjects({ root: tmpdir(), projects: [{ id: 'books', name: 'books', root: tmpdir(), profile: 'plain' } as never] }),
  })
}

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  while (closers.length) await closers.pop()!()
})

async function setup() {
  const nrSeen: GenerateRequest[] = []
  const acpSeen: GenerateRequest[] = []
  const nr = engine('nr', nrSeen, [WRITER, PLAIN, SONNY], ['nr-model', 'opus'])
  // Движок «как ACP»: читает тот же agents/ (writer) и свои старые слепки (snap); plain у него нет.
  const acp = engine('acp', acpSeen, [WRITER, SNAP], ['opus', 'sonnet'])
  const srv = await serveBackend(acp, { port: 0 })
  closers.push(() => srv.close())
  const hub = createHub({ local: nr, engines: [{ id: 'acp', name: 'Claude Code', backend: createHttpBackend(srv.url, { capabilitiesTtl: 0 }) }], probeTtlMs: 0, log: () => {} })
  return { hub, nr, acp, nrSeen, acpSeen }
}

async function drain(it: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of it) { /* drain */ }
}

describe('хаб: агенты (ABC-314)', () => {
  it('один каталог: без дублей, у агента — его движок; старый слепок — движок-владелец', async () => {
    const { hub } = await setup()
    expect((await hub.profiles!.list()).map((p) => [p.id, p.engine, p.source])).toEqual([
      ['default', undefined, undefined],
      ['writer', 'acp', 'agents'],
      ['plain', undefined, 'agents'],
      ['sonny', undefined, 'agents'],
      ['snap', 'acp', 'legacy'],
    ])
  })

  it('движок по умолчанию — engine агента; явный engine перебивает, агент тот же', async () => {
    const { hub, nrSeen } = await setup()
    const a = await hub.sessions.create({ profile: 'writer' })
    expect(a.engine).toBe('acp')
    expect(a.profile).toBe('writer')
    const b = await hub.sessions.create({ profile: 'writer', engine: 'nr' })
    expect(b.engine).toBe('nr')
    expect(b.profile).toBe('writer')
    await drain(hub.run(b.id, { userMessage: 'hi' }))
    expect(nrSeen.at(-1)!.profile).toMatchObject({ id: 'writer', template: '/e/agents/writer.mds' })
  })

  it('агента нет у движка — движку документ, профиль сессии — id агента (не inline)', async () => {
    const { hub, acpSeen } = await setup()
    const s = await hub.sessions.create({ profile: 'plain', engine: 'acp' })
    expect(s.engine).toBe('acp')
    expect(s.profile).toBe('plain')
    await drain(hub.run(s.id, { userMessage: 'hi' }))
    expect(acpSeen.at(-1)!.profile).toMatchObject({ id: 'plain', template: '/e/agents/plain.mds' })
    // Старый слепок ACP — на nr: документ с шаблоном слепка.
    const n = await hub.sessions.create({ profile: 'snap', engine: 'nr' })
    expect(n.profile).toBe('snap')
  })

  it('$agent проекта — агент новой сессии; движок без него — документом', async () => {
    const { hub } = await setup()
    const s = await hub.sessions.create({ workspace: 'books', engine: 'acp' })
    expect(s.profile).toBe('plain')
  })

  it('модели агента нет у движка — агент документом без модели, модель движка, заметка', async () => {
    const { hub, nrSeen } = await setup()
    const s = await hub.sessions.create({ profile: 'writer', engine: 'nr', model: undefined })
    expect(s.profile).toBe('writer')
    // writer: opus — у nr есть; берём агента с моделью, которой у nr нет.
    const t = await hub.sessions.create({ profile: 'sonny', engine: 'nr' })
    expect(t.profile).toBe('sonny')
    expect(t.model?.model).not.toBe('sonnet')
    await drain(hub.run(t.id, { userMessage: 'hi' }))
    expect(nrSeen.at(-1)!.profile).toMatchObject({ id: 'sonny', template: '/e/agents/sonny.mds' })
    const msgs = await hub.history(t.id)
    expect(msgs.messages.some((m) => m.flags?.disabled && m.parts.some((p) => p.type === 'text' && p.text.includes('модель sonnet недоступна')))).toBe(true)
  })

  it('модели нет у движка — модель движка, скрытая заметка в ленте', async () => {
    const { hub } = await setup()
    const s = await hub.sessions.create({ engine: 'acp', model: { model: 'nr-model' } })
    expect(s.model?.model).not.toBe('nr-model')
    const msgs = await hub.history(s.id)
    const note = msgs.messages.find((m) => m.parts.some((p) => p.type === 'text' && p.text.includes('модель nr-model недоступна на Claude Code')))
    expect(note?.flags?.disabled).toBe(true)
  })
})
