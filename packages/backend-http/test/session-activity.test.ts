/**
 * Активность сессий (v1.69): открытая вкладка узнаёт о ране, которого не начинала
 * (безголовый ход будильника, другое устройство), и о дописанном в ленту — потоком сервиса
 * `nr.sessions`/`activity`; стенд и хаб (ран подключённого движка) — одинаково.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import { createNrChatStore } from '@kerneldreams/chat-store/nr-chat'
import { SESSION_ACTIVITY_SERVICE, SESSION_ACTIVITY_STREAM, canSessionActivity } from '@kerneldreams/ui-protocol'
import type { ProtocolBackend, ServiceEvent, SessionActivity } from '@kerneldreams/ui-protocol'
import { createStoreBackend, type GenerateFn } from '../src/store-backend.js'
import { serveBackend } from '../src/serve.js'
import { createHttpBackend } from '../src/client.js'
import { createHub } from '../src/hub.js'
import { withRunAttach } from '../src/run-attach.js'
import { activityFeedOf } from '../src/session-activity.js'

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  while (closers.length) await closers.pop()!()
})

const gen: GenerateFn = async function* () {
  yield { type: 'text', delta: 'ок' }
}

async function served(backend: ProtocolBackend): Promise<() => ProtocolBackend> {
  const srv = await serveBackend(backend, { port: 0 })
  closers.push(() => srv.close())
  return () => createHttpBackend(srv.url, { capabilitiesTtl: 0 })
}

/** Подписка: копит кадры активности, `wait` — дождаться условия. */
function watch(b: ProtocolBackend): { got: SessionActivity[]; wait(pred: (a: SessionActivity[]) => boolean): Promise<void>; stop(): Promise<void> } {
  const got: SessionActivity[] = []
  const it = b.services!.stream(SESSION_ACTIVITY_SERVICE, SESSION_ACTIVITY_STREAM)[Symbol.asyncIterator]()
  let stopped = false
  void (async () => {
    for (;;) {
      const r = await it.next().catch(() => ({ done: true, value: undefined }) as IteratorResult<ServiceEvent>)
      if (r.done || stopped) return
      got.push(r.value.payload as SessionActivity)
    }
  })()
  return {
    got,
    async wait(pred) {
      const end = Date.now() + 3000
      while (!pred(got)) {
        if (Date.now() > end) throw new Error(`watch: таймаут, пришло ${JSON.stringify(got)}`)
        await new Promise((r) => setTimeout(r, 10))
      }
    },
    async stop() {
      stopped = true
      await it.return?.()
    },
  }
}

const drain = async (it: AsyncIterable<unknown>): Promise<void> => {
  for await (const _ of it) {
    /* до конца */
  }
}

describe('активность сессий: стенд', () => {
  it('заявлена в capabilities; чужой ран и append доходят подписчику по HTTP', async () => {
    const client = await served(createStoreBackend({ store: createMemoryStore(), generate: gen }))
    const tab = client()
    expect(canSessionActivity(await tab.capabilities())).toBe(true)
    const s = await tab.sessions.create()
    const w = watch(tab)
    await new Promise((r) => setTimeout(r, 100))

    // Другое устройство (или будильник) — безголовый ход.
    await drain(client().run(s.id, { userMessage: '⏰ пора', headless: true }))
    await w.wait((g) => g.some((a) => a.kind === 'run_end'))
    const run = w.got.filter((a) => a.id === s.id)
    expect(run.map((a) => a.kind)).toEqual(['run_start', 'run_end'])
    expect(run[0]).toMatchObject({ headless: true })
    expect(typeof run[0]!.runId).toBe('string')
    expect(run[1]!.runId).toBe(run[0]!.runId)

    // Заметка хоста задач — без рана.
    await client().messages!.append(s.id, [{ type: 'text', text: 'вердикт' }], { role: 'assistant' })
    await w.wait((g) => g.some((a) => a.kind === 'messages'))
    expect(w.got.at(-1)).toMatchObject({ id: s.id, kind: 'messages' })
    await w.stop()
  })

  it('обёртка над обёрткой — одна лента, сигнал не дублируется', async () => {
    const inner = withRunAttach(createStoreBackend({ store: createMemoryStore(), generate: gen }))
    const outer = withRunAttach(inner)
    expect(activityFeedOf(outer)).toBe(activityFeedOf(inner))
    const s = await outer.sessions.create()
    const w = watch(outer)
    await drain(outer.run(s.id, { userMessage: 'раз' }))
    await w.wait((g) => g.some((a) => a.kind === 'run_end'))
    await new Promise((r) => setTimeout(r, 50))
    expect(w.got.map((a) => a.kind)).toEqual(['run_start', 'run_end'])
    await w.stop()
    expect(activityFeedOf(outer)!.size()).toBe(0)
  })
})

describe('активность сессий: хаб', () => {
  it('ран подключённого движка, начатый мимо вкладки, — в ленте хаба; вкладка подцепляется attach', async () => {
    const nrDir = mkdtempSync(join(tmpdir(), 'act-nr-'))
    const acpDir = mkdtempSync(join(tmpdir(), 'act-acp-'))
    let release!: () => void
    const hold = new Promise<void>((r) => (release = r))
    const slow: GenerateFn = async function* () {
      yield { type: 'text', delta: 'думаю ' }
      await hold
      yield { type: 'text', delta: 'готово' }
    }
    const acp = await served(createStoreBackend({ store: createNrChatStore({ dir: acpDir }), generate: slow }))
    const hub = createHub({ local: createStoreBackend({ store: createNrChatStore({ dir: nrDir }), generate: gen }), localSessionsDir: nrDir, engines: [{ id: 'acp', backend: acp(), sessionsDir: acpDir }], probeTtlMs: 0, log: () => {} })
    const front = await served(hub)
    const tab = front()
    expect(canSessionActivity(await tab.capabilities())).toBe(true)
    const s = await tab.sessions.create({ engine: 'acp' })
    const w = watch(tab)
    await new Promise((r) => setTimeout(r, 100))

    // Будильник хаба ходит в объект хаба напрямую, не через HTTP.
    const wake = drain(hub.run(s.id, { userMessage: '⏰ пора', headless: true }))
    await w.wait((g) => g.some((a) => a.id === s.id && a.kind === 'run_start'))
    const att = tab.sessions.attach!(s.id)[Symbol.asyncIterator]()
    const first = await att.next()
    expect(first.value).toMatchObject({ type: 'run_start' })
    release()
    await wake
    await w.wait((g) => g.some((a) => a.id === s.id && a.kind === 'run_end'))
    await att.return?.()
    await w.stop()
  })

  it('impersonate (target: user) — не ран сессии: сигнала нет, attach его не видит (ABC-723)', async () => {
    const be = withRunAttach(createStoreBackend({ store: createMemoryStore(), generate: gen, impersonate: true }))
    const s = await be.sessions.create()
    await be.messages!.append!(s.id, [{ type: 'text', text: 'Привет.' }], { role: 'assistant' })
    const w = watch(be)
    await new Promise((r) => setTimeout(r, 30))
    await drain(be.run(s.id, { target: { kind: 'user' } } as never))
    await drain(be.run(s.id, { userMessage: 'раз' }))
    await w.wait((g) => g.some((a) => a.kind === 'run_end'))
    await new Promise((r) => setTimeout(r, 50))
    expect(w.got.filter((a) => a.kind !== 'messages').map((a) => a.kind)).toEqual(['run_start', 'run_end'])
    await w.stop()
  })
})
