/**
 * Окна ленты и списка (протокол v1.57): `history(id, {limit, before})`, кэш ленты по версии,
 * `sessions.list({query, limit, offset})` — у стор-бэкенда, по HTTP и через хаб.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNrChatStore } from '@kerneldreams/chat-store/nr-chat'
import type { ProtocolBackend } from '@kerneldreams/ui-protocol'
import { createStoreBackend, type GenerateRequest } from '../src/store-backend.js'
import { serveBackend } from '../src/serve.js'
import { createHttpBackend } from '../src/client.js'
import { createHub } from '../src/hub.js'

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  while (closers.length) await closers.pop()!()
})

function engine(dir: string) {
  return createStoreBackend({
    store: createNrChatStore({ dir }),
    name: 'nr',
    generate: async function* (_req: GenerateRequest) {
      yield { type: 'text' as const, delta: 'ок' }
    },
  })
}

async function turn(b: ProtocolBackend, sid: string, text: string): Promise<void> {
  for await (const _ev of b.run(sid, { userMessage: text })) void _ev
}

describe('окна v1.57 (ABC-542)', () => {
  it('history: хвост, догрузка вверх, без опций — всё; capability', async () => {
    const b = engine(mkdtempSync(join(tmpdir(), 'page-nr-')))
    const s = await b.sessions.create({ title: 'длинный' })
    for (let i = 0; i < 6; i++) await turn(b, s.id, `вопрос ${i}`)
    const caps = await b.capabilities()
    expect(caps.history?.page).toBe(true)
    expect(caps.sessions?.page).toBe(true)
    const full = await b.history(s.id)
    expect(full.messages).toHaveLength(12)
    expect(full.more).toBeUndefined()
    const tail = await b.history(s.id, { limit: 4 })
    expect(tail.messages.map((m) => m.id)).toEqual(full.messages.slice(-4).map((m) => m.id))
    expect(tail).toMatchObject({ more: true, total: 12, version: full.version })
    const up = await b.history(s.id, { limit: 5, before: tail.messages[0]!.id })
    expect(up.messages.map((m) => m.id)).toEqual(full.messages.slice(3, 8).map((m) => m.id))
    const top = await b.history(s.id, { limit: 5, before: up.messages[0]!.id })
    expect(top.messages).toHaveLength(3)
    expect(top.more).toBe(false)
    // Кэш по версии не отдаёт старую ленту после хода.
    await turn(b, s.id, 'ещё')
    const after = await b.history(s.id, { limit: 2 })
    expect(after.total).toBe(14)
    expect(after.version).not.toBe(full.version)
  })

  it('по HTTP и через хаб: окно ленты и поиск/окно списка', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'page-hub-'))
    const nr = engine(dir)
    const hub = createHub({ local: nr, localSessionsDir: dir, engines: [], probeTtlMs: 0, log: () => {} })
    const srv = await serveBackend(hub, { port: 0 })
    closers.push(() => srv.close())
    const c = createHttpBackend(srv.url, { capabilitiesTtl: 0 })
    const ids: string[] = []
    for (const t of ['Тормоза ленты', 'Голос', 'Тормоза списка', 'Слоты']) {
      const s = await c.sessions.create({ title: t })
      await turn(c, s.id, t)
      ids.push(s.id)
    }
    expect((await c.capabilities()).history?.page).toBe(true)
    const tail = await c.history(ids[0]!, { limit: 1 })
    expect(tail).toMatchObject({ more: true, total: 2 })
    expect(tail.messages).toHaveLength(1)
    expect((await c.sessions.list({ query: 'тормоза' })).map((s) => s.title).sort()).toEqual(['Тормоза ленты', 'Тормоза списка'])
    const all = await c.sessions.list()
    expect(all).toHaveLength(4)
    const page = await c.sessions.list({ limit: 2, offset: 1 })
    expect(page.map((s) => s.id)).toEqual(all.slice(1, 3).map((s) => s.id))
  })
})
