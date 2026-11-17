/**
 * Архив, теги, перенос и автоархив сессий (протокол v1.55) — через хаб: встроенный nr +
 * движок acp по HTTP (как стенд), сессии обоих движков одним списком.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNrChatStore } from '@kerneldreams/chat-store/nr-chat'
import type { ProtocolBackend } from '@kerneldreams/ui-protocol'
import { archivePatch } from '@kerneldreams/ui-protocol'
import { createStoreBackend, type GenerateRequest } from '../src/store-backend.js'
import { createMemoryProjects } from '../src/projects.js'
import { serveBackend } from '../src/serve.js'
import { createHttpBackend } from '../src/client.js'
import { createHub } from '../src/hub.js'
import { createAutoArchive } from '../src/autoarchive.js'

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  while (closers.length) await closers.pop()!()
})

function projects() {
  const root = mkdtempSync(join(tmpdir(), 'arch-proj-'))
  return createMemoryProjects({
    root,
    projects: [
      { id: 'dev', name: 'DEV', root },
      { id: 'slot', name: 'SLOT', root, aliases: ['twin'] },
    ] as never,
  })
}

function engine(name: string, dir: string) {
  return createStoreBackend({
    store: createNrChatStore({ dir }),
    name,
    generate: async function* (_req: GenerateRequest) {
      yield { type: 'text' as const, delta: `${name}: ок` }
    },
    projects: projects(),
  })
}

async function turn(b: ProtocolBackend, sid: string, text: string): Promise<void> {
  for await (const _ev of b.run(sid, { userMessage: text })) void _ev
}

async function setup() {
  const nrDir = mkdtempSync(join(tmpdir(), 'arch-nr-'))
  const acpDir = mkdtempSync(join(tmpdir(), 'arch-acp-'))
  const nr = engine('nr', nrDir)
  const acp = engine('acp', acpDir)
  const srv = await serveBackend(acp, { port: 0 })
  closers.push(() => srv.close())
  const hub = createHub({ local: nr, localSessionsDir: nrDir, engines: [{ id: 'acp', backend: createHttpBackend(srv.url, { capabilitiesTtl: 0 }), sessionsDir: acpDir }], probeTtlMs: 0, log: () => {} })
  return { hub, nr, acp }
}

describe('архив и теги через хаб', () => {
  it('capability; архивные — только по опции; ход возвращает молча; теги в строке', async () => {
    const { hub } = await setup()
    const caps = await hub.capabilities()
    expect(caps.sessions?.archive).toBe(true)
    expect(caps.sessions?.move).toBe(true)
    const a = await hub.sessions.create({ title: 'a', workspace: 'dev' })
    const b = await hub.sessions.create({ title: 'b', workspace: 'dev', engine: 'acp' })
    await hub.meta!.patch(a.id, archivePatch(true))
    await hub.meta!.patch(b.id, { ...archivePatch(true), tags: ['Infra', 'voice'] })
    expect((await hub.sessions.list({ workspace: 'dev' })).map((s) => s.id)).toEqual([])
    const only = await hub.sessions.list({ workspace: 'dev', archived: 'only' })
    expect(only.map((s) => s.id).sort()).toEqual([a.id, b.id].sort())
    expect(only.find((s) => s.id === b.id)!.tags).toEqual(['infra', 'voice'])
    expect((await hub.sessions.list({ archived: true })).length).toBe(2)
    // Открыть архивную можно; ход — вернуть из архива молча (`archived: false`).
    expect((await hub.sessions.get(b.id)).archived).toBeTruthy()
    await turn(hub, b.id, 'привет')
    const back = (await hub.sessions.list({ workspace: 'dev' })).find((s) => s.id === b.id)!
    expect(back.archived).toBe(false)
    expect(back.tags).toEqual(['infra', 'voice'])
  })

  it('перенос: алиас → настоящее id, проект сброшен; ACP-сессия — тоже', async () => {
    const { hub } = await setup()
    const a = await hub.sessions.create({ title: 'a', workspace: 'dev' })
    const b = await hub.sessions.create({ title: 'b', workspace: 'dev', engine: 'acp' })
    const moved = await hub.sessions.move!(a.id, { workspace: 'twin' })
    expect(moved.workspace).toBe('slot')
    const movedB = await hub.sessions.move!(b.id, { workspace: 'slot', project: 'nope' })
    expect(movedB.workspace).toBe('slot')
    expect(movedB.project).toBeUndefined()
    expect(movedB.engine).toBe('acp')
    expect((await hub.sessions.list({ workspace: 'dev' })).length).toBe(0)
    expect((await hub.sessions.list({ workspace: 'slot' })).map((s) => s.id).sort()).toEqual([a.id, b.id].sort())
    await expect(hub.sessions.move!(a.id, { workspace: 'нет-такого' })).rejects.toThrow()
  })

  it('автоархив: run/review закрытой задачи — в архив (auto); вернул руками — не трогает; in_review — видны', async () => {
    const { hub } = await setup()
    const mk = async (title: string, issue: string, role: 'executor' | 'acceptor', engine?: string) => {
      const s = await hub.sessions.create({ title, workspace: 'dev', ...(engine ? { engine } : {}) })
      await hub.meta!.patch(s.id, { task: { issue, role } })
      return s.id
    }
    const ex = await mk('исп', 'ABC-1', 'executor', 'acp')
    const ac = await mk('приём', 'ABC-1', 'acceptor')
    const other = await mk('исп 2', 'ABC-2', 'executor')
    const talk = await hub.sessions.create({ title: 'разговор', workspace: 'dev' })
    const statuses: Record<string, { status: string }> = { 'ABC-1': { status: 'done' }, 'ABC-2': { status: 'in_review' } }
    const auto = createAutoArchive({ backend: hub, status: async (refs) => Object.fromEntries(refs.map((r) => [r, statuses[r]])) })
    const r1 = await auto.once()
    expect(r1.archived.sort()).toEqual([ex, ac].sort())
    const all = await hub.sessions.list({ archived: true })
    expect(all.find((s) => s.id === ex)!.archivedBy).toBe('auto')
    expect(all.find((s) => s.id === other)!.archived).toBeUndefined()
    expect(all.find((s) => s.id === talk.id)!.archived).toBeUndefined()
    // Вернул руками — следующий проход её не трогает.
    await hub.meta!.patch(ac, archivePatch(false))
    const r2 = await auto.once()
    expect(r2.archived).toEqual([])
    expect((await hub.sessions.list({ workspace: 'dev' })).map((s) => s.id)).toContain(ac)
  })
})

