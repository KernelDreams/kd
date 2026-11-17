/**
 * Заметка хоста (v1.36, task-session-spec §8): `POST /sessions/:id/messages`
 * с `role: 'system'` и `context` — запись без рана, `meta.context` доживает до
 * истории; `context` без system — 400.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNrChatStore } from '@kerneldreams/chat-store/nr-chat'
import { serveBackend, type ServeHandle } from '../src/serve.js'
import { createStoreBackend } from '../src/store-backend.js'
import { noGen } from './store-harness.js'

let srv: ServeHandle | undefined
afterEach(async () => {
  await srv?.close()
  srv = undefined
})

describe('заметка хоста', () => {
  it('system+context по проводу → в ленте system с meta.context, рана нет', async () => {
    const backend = createStoreBackend({ store: createNrChatStore({ dir: mkdtempSync(join(tmpdir(), 'bh-note-')) }), generate: noGen })
    srv = await serveBackend(backend)
    const s = await backend.sessions.create()
    const post = (body: unknown) => fetch(`${srv!.url}/sessions/${s.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const r = await post({ parts: [{ type: 'text', text: '■ ABC-7: принято' }], role: 'system', context: true })
    expect(r.status).toBe(200)
    expect((await post({ parts: [{ type: 'text', text: 'x' }], context: true })).status).toBe(400)
    const h = await backend.history(s.id)
    expect(h.messages).toHaveLength(1)
    expect(h.messages[0]).toMatchObject({ role: 'system', meta: { context: true } })
    await backend.messages!.append!(s.id, [{ type: 'text', text: 'лента' }], { role: 'system' })
    expect((await backend.history(s.id)).messages[1]!.meta?.context).toBeUndefined()
  })
})
