/**
 * Loopback без HTTP (exz-v2-spec §2): createLocalBackend на диске →
 * createProtocolHost → фейковый invoke (createMemoryBridge) → createTauriBackend.
 * Ровно та цепочка, что будет в exz, без Rust и окна.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryBridge, createTauriBackend, type MemoryBridge } from '../src/tauri/index.js'
import type { AnyRunEvent, Message, ProtocolBackend, WorkspaceUpdateEvent } from '@kerneldreams/ui-protocol'
import { NotSupportedError } from '@kerneldreams/ui-protocol'
import { createServicesHost } from '../src/services/index.js'
import { createLocalBackend } from '../src/index.js'

let root = ''
let local: ProtocolBackend | undefined
let bridge: MemoryBridge | undefined
let client: ProtocolBackend | undefined

function loopback(): ProtocolBackend {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'backend-local-lb-')))
  local = createLocalBackend({ root, files: { debounceMs: 30 } })
  bridge = createMemoryBridge(local)
  client = createTauriBackend({ invoke: bridge.invoke, listen: bridge.listen })
  return client
}

afterEach(async () => {
  await client?.close?.()
  bridge?.host.close()
  await local?.close?.()
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
  local = bridge = client = undefined
})

const textOf = (m: Message | undefined): string =>
  (m?.parts ?? []).map((p) => (p.type === 'text' ? (p as { text: string }).text : '')).join('')

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: таймаут')
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function collect(iter: AsyncIterable<AnyRunEvent>): Promise<AnyRunEvent[]> {
  const out: AnyRunEvent[] = []
  for await (const ev of iter) out.push(ev)
  return out
}

describe('loopback: backend-local ⇄ Tauri-провод', () => {
  it('capabilities доезжают как у бэкенда', async () => {
    const c = loopback()
    expect(await c.capabilities()).toEqual(await local!.capabilities())
  })

  it('сессия: create → append → свайп → edit → history → мета; всё на диске', async () => {
    const c = loopback()
    const s = await c.sessions.create({ title: 'Через invoke' })
    const u = await c.messages!.append!(s.id, [{ type: 'text', text: 'вопрос' }])
    const a1 = await c.messages!.append!(s.id, [{ type: 'text', text: 'ответ 1' }], { role: 'assistant' })
    await c.messages!.append!(s.id, [{ type: 'text', text: 'ответ 2' }], { swipeOf: a1.id })
    await c.messages!.edit!(s.id, u.id, { text: 'вопрос!' })

    const page = await c.history(s.id)
    expect(page.messages.map(textOf)).toEqual(['вопрос!', 'ответ 2'])
    expect(page.messages[1]!.swipes).toEqual({ active: 1, count: 2 })
    expect(page.version).toBeTruthy()

    await c.meta!.patch(s.id, { notes: 'из окна' })
    expect(await c.meta!.get(s.id)).toMatchObject({ notes: 'из окна' })

    const onDisk = readFileSync(join(root, `${s.id}.mds`), 'utf8')
    expect(onDisk).toContain('вопрос!')
    expect(onDisk).toContain('ответ 2')
  })

  it('run → NotSupportedError через провод, файл сессии не тронут', async () => {
    const c = loopback()
    const s = await c.sessions.create()
    await c.messages!.append!(s.id, [{ type: 'text', text: 'было' }])
    const before = readFileSync(join(root, `${s.id}.mds`), 'utf8')

    const err = await collect(c.run(s.id, { userMessage: 'x' })).then(
      () => null,
      (e: unknown) => e,
    )
    expect((err as Error).name).toBe('NotSupportedError')
    expect((err as { code?: string }).code).toBe('not_supported')
    expect(readFileSync(join(root, `${s.id}.mds`), 'utf8')).toBe(before)
    expect(bridge!.host.openStreams).toBe(0)
  })

  it('вложение: байты base64 через провод → файл в .nr/attachments', async () => {
    const c = loopback()
    const s = await c.sessions.create()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7])
    const put = await c.attachments!.put(s.id, 'shot.png', png, 'image/png')
    expect(new Uint8Array(readFileSync(join(root, put.ref.slice('file:'.length))))).toEqual(png)
    await c.messages!.append!(s.id, [put.part])
    expect((await c.history(s.id)).messages[0]!.parts[0]).toMatchObject({ type: 'image', meta: { ref: put.ref } })
  })

  it('файлы: write/read и watch — внешняя правка приезжает событием', async () => {
    const c = loopback()
    const f = c.workspace!.files!
    const { revision } = await f.write!('notes/todo.md', '- [ ] tauri', { revision: null })
    expect(await f.read('notes/todo.md')).toMatchObject({ content: '- [ ] tauri', revision })
    expect((await f.list('notes')).map((e) => e.name)).toEqual(['todo.md'])

    const conflict = await f.write!('notes/todo.md', 'x', { revision: null }).then(
      () => null,
      (e: unknown) => e,
    )
    expect((conflict as { code?: string }).code).toBe('conflict')

    const got: WorkspaceUpdateEvent[] = []
    const off = f.watch!((ev) => got.push(ev))
    await waitFor(() => bridge!.host.openStreams === 1)
    await new Promise((r) => setTimeout(r, 50))
    writeFileSync(join(root, 'notes', 'done.md'), 'сделано')
    await waitFor(() => got.some((e) => e.paths.includes('notes/done.md')))

    off()
    await waitFor(() => bridge!.host.openStreams === 0)
  })
})

describe('loopback: сервисы плагинов через Tauri-провод (plugin-services-spec §7 п.3–4)', () => {
  it('capabilities().services заявляет hello-service; call/stream доезжают; чужой плагин — not_supported', async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'backend-local-svc-')))
    writeFileSync(
      join(root, 'hello-service.mjs'),
      `export default function (ctx, meta) {
         meta.on('echo', (p) => p)
         meta.stream('tick', (p, sink) => { for (let i = 1; i <= 3; i++) sink('tick', { i }) })
       }\n`,
    )
    const services = createServicesHost({ root, plugins: { 'hello-service': 'hello-service.mjs' } })
    local = createLocalBackend({ root, files: { debounceMs: 30 }, services })
    bridge = createMemoryBridge(local)
    client = createTauriBackend({ invoke: bridge.invoke, listen: bridge.listen })

    expect((await client.capabilities()).services).toEqual({ 'hello-service': { methods: ['echo'], streams: ['tick'] } })
    expect(await client.services!.call('hello-service', 'echo', [1, 2])).toEqual([1, 2])
    const events: unknown[] = []
    for await (const e of client.services!.stream('hello-service', 'tick')) events.push(e)
    expect(events).toEqual([1, 2, 3].map((i) => ({ name: 'tick', payload: { i } })))
    await expect(client.services!.call('viewer', 'echo')).rejects.toBeInstanceOf(NotSupportedError)
  })
})
