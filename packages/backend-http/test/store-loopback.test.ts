/**
 * Loopback-сквозняк: serveBackend(createStoreBackend(mds)) + createHttpBackend.
 * Конформанс-профиль протокола через реальный провод (backend-mds-spec §9 loopback):
 * capabilities → create → run → history → edit → swipe → attachments → sessionMeta.
 */

import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNrChatStore } from '@kerneldreams/chat-store/nr-chat'
import { ATTACHMENT_MIMES, DEFAULT_ATTACHMENT_MAX_BYTES } from '@kerneldreams/ui-protocol'
import type { AnyRunEvent, ProtocolBackend, RunEndEvent } from '@kerneldreams/ui-protocol'
import { serveBackend, type ServeHandle } from '../src/serve.js'
import { createHttpBackend } from '../src/client.js'
import { createStoreBackend, type GenerateFn } from '../src/store-backend.js'
import { scriptGen, textOf } from './store-harness.js'

let srv: ServeHandle | undefined
let client: ProtocolBackend | undefined
let dir = ''

async function loopback(gen: GenerateFn = scriptGen({ chunks: [{ type: 'text', delta: 'ответ' }] })) {
  dir = mkdtempSync(join(tmpdir(), 'store-lb-'))
  const backend = createStoreBackend({ store: createNrChatStore({ dir }), generate: gen, name: 'mds' })
  srv = await serveBackend(backend)
  client = createHttpBackend(srv.url)
  return client
}

afterEach(async () => {
  await client?.close?.()
  await srv?.close()
  srv = undefined
  client = undefined
  dir = ''
})

async function collect(iter: AsyncIterable<AnyRunEvent>): Promise<AnyRunEvent[]> {
  const out: AnyRunEvent[] = []
  for await (const ev of iter) out.push(ev)
  return out
}

describe('loopback (store-backend/mds)', () => {
  it('capabilities доезжают', async () => {
    const c = await loopback()
    expect(await c.capabilities()).toEqual({
      protocol: 1,
      name: 'mds',
      client: true,
      edits: { edit: true, delete: true, hide: true, append: true },
      swipes: true,
      fork: 'tree',
      cancel: true,
      attachments: { maxBytes: DEFAULT_ATTACHMENT_MAX_BYTES, mimes: [...ATTACHMENT_MIMES], get: true },
      run: { continue: true, vars: true },
      sessionMeta: true,
      workspace: {},
      sessions: { archive: true, move: true, page: true, attach: true, live: true },
      history: { page: true },
      services: { 'nr.sessions': { methods: [], streams: ['activity'] } },
    })
  })

  it('полный цикл: create → run → history → edit → swipe', async () => {
    const c = await loopback(
      scriptGen({ chunks: [{ type: 'thinking', delta: 'хм' }, { type: 'text', delta: 'привет!' }] }),
    )

    const s = await c.sessions.create({ title: 'Диалог' })
    expect(s.title).toBe('Диалог')

    const events = await collect(c.run(s.id, { userMessage: 'здравствуй' }))
    expect((events.at(-1) as RunEndEvent).status).toBe('done')

    const hist = await c.history(s.id)
    expect(hist.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(textOf(hist.messages[1])).toBe('привет!')
    expect(hist.version).toBeTruthy()

    const userMsg = hist.messages[0]
    const edited = await c.messages!.edit!(s.id, userMsg.id, { text: 'привет', ifHash: userMsg.hash })
    expect(textOf(edited)).toBe('привет')

    // regenerate → свайп
    await collect(c.run(s.id, { regenerate: { messageId: hist.messages[1].id } }))
    const hist2 = await c.history(s.id)
    expect(hist2.messages.at(-1)!.swipes).toEqual({ active: 1, count: 2 })
    const swiped = await c.messages!.swipe!(s.id, hist2.messages.at(-1)!.id, { dir: 'prev' })
    expect(swiped.swipes?.active).toBe(0)
  })

  it('attachments.put сквозь провод: байты в .assets, ref возвращается', async () => {
    const c = await loopback()
    const s = await c.sessions.create()

    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7, 7])
    const res = await c.attachments!.put(s.id, 'арт.png', data, 'image/png')
    expect(res.ref).toBe(`file:${s.id}.assets/арт.png`)
    expect(res.part).toEqual({ type: 'image', meta: { ref: res.ref, alt: 'арт.png', mime: 'image/png' } })
    expect(existsSync(join(dir, s.id + '.assets', 'арт.png'))).toBe(true)
  })

  it('attachments.get сквозь провод (v1.10): put → get байт в байт, mime по имени; чужой ref — not_found 404', async () => {
    const c = await loopback()
    const s = await c.sessions.create()
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 7])
    const { ref } = await c.attachments!.put(s.id, 'арт.png', data, 'image/png')
    const got = await c.attachments!.get!(s.id, ref)
    expect(got).toEqual({ ref, content: Buffer.from(data).toString('base64'), encoding: 'base64', size: 6, mime: 'image/png' })
    const err = await c.attachments!.get!(s.id, `file:${s.id}.assets/../x.mds`).then(() => null, (e) => e)
    expect(err).toMatchObject({ code: 'not_found', status: 404 })
  })

  it('continue сквозь провод: ран без userMessage — только ответ, user-сообщения нет', async () => {
    const c = await loopback()
    const s = await c.sessions.create()
    await collect(c.run(s.id, { userMessage: 'привет' }))
    const events = await collect(c.run(s.id, {}))
    expect(events.filter((e) => e.type === 'message_start').map((e) => (e as { message: { role: string } }).message.role)).toEqual(['assistant'])
    expect((await c.history(s.id)).messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant'])
  })

  it('put → append → run сквозь провод: текст вложения доезжает до generate', async () => {
    let seen = ''
    const c = await loopback(
      scriptGen({ chunks: [{ type: 'text', delta: 'вижу' }], onRequest: (req) => { seen = JSON.stringify(req.messages) } }),
    )
    const s = await c.sessions.create()

    const { part } = await c.attachments!.put(s.id, 'план.md', new TextEncoder().encode('ШАГ-1: купить хлеб'), 'text/markdown')
    const attached = await c.messages!.append!(s.id, [part])
    expect(attached.parts).toEqual([part])

    await collect(c.run(s.id, { userMessage: 'что в плане?' }))
    expect(seen).toContain('ШАГ-1: купить хлеб')
    expect((await c.history(s.id)).messages.map((m) => m.role)).toEqual(['user', 'user', 'assistant'])

    // bad_request доезжает кодом и текстом лимита
    const err = await c.attachments!.put(s.id, 'x.pdf', new Uint8Array([1]), 'application/pdf').then(() => null, (e) => e)
    expect(err).toMatchObject({ code: 'bad_request', status: 400 })
  })

  it('sessionMeta patch/get сквозь провод', async () => {
    const c = await loopback()
    const s = await c.sessions.create()
    await c.meta!.patch(s.id, { notes: 'заметка', summary: 'итог' })
    expect(await c.meta!.get(s.id)).toMatchObject({ notes: 'заметка', summary: 'итог' })
  })
})
