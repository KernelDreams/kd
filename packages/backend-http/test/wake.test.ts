/**
 * Будильник хаба (wake-spec): условия at / cron / job / pid / file / task, срок,
 * занятая сессия, запись с диска стреляет после «рестарта» (новый createWake на том же каталоге),
 * сквозной ход через хаб в движок по HTTP, тулы сервиса.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNrChatStore } from '@kerneldreams/chat-store/nr-chat'
import type { AnyRunEvent, ProtocolBackend, RunStartInput } from '@kerneldreams/ui-protocol'
import { createStoreBackend, type GenerateRequest } from '../src/store-backend.js'
import { serveBackend } from '../src/serve.js'
import { createHttpBackend } from '../src/client.js'
import { createHub } from '../src/hub.js'
import { createWake, nextCron, parseAt, parseCron, parseDuration, withWakeService, zonedTime, type WakeJobView, type WakeJobs } from '../src/wake.js'

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  while (closers.length) await closers.pop()!()
})

const TZ = 'Europe/Warsaw'
const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))

/** Бэкенд-заглушка: копит ходы; `busy` — сколько первых попыток ответить «занято». */
function fakeBackend(o: { busy?: number; missing?: boolean } = {}) {
  const runs: Array<{ sid: string; input: RunStartInput }> = []
  let busy = o.busy ?? 0
  const b = {
    runs,
    run(sid: string, input: RunStartInput): AsyncIterable<AnyRunEvent> {
      return {
        async *[Symbol.asyncIterator]() {
          if (o.missing) throw Object.assign(new Error(`сессия ${sid} not found`), { code: 'not_found' })
          if (busy > 0) {
            busy--
            throw Object.assign(new Error('занята живым раном'), { code: 'busy' })
          }
          runs.push({ sid, input })
          yield { type: 'run_start', runId: 'r1' } as AnyRunEvent
          yield { type: 'run_end', runId: 'r1', status: 'done', version: '1' } as AnyRunEvent
        },
      }
    },
  }
  return b as typeof b & ProtocolBackend
}

function fakeJobs(): WakeJobs & { set(id: string, v: Partial<WakeJobView>): void } {
  const jobs = new Map<string, WakeJobView>()
  return {
    set(id, v) {
      jobs.set(id, { ...(jobs.get(id) ?? { id, status: 'running' }), ...v })
    },
    async start(o) {
      const id = `20261106-1200000${jobs.size}-abcd`
      const j: WakeJobView = { id, title: o.title ?? o.cmd, status: 'running', cmd: o.cmd, cwd: o.cwd, dir: `/jobs/${id}`, log: `/jobs/${id}/log.ndjson` }
      jobs.set(id, j)
      return j
    },
    async get(id) {
      return jobs.get(id) ?? null
    },
    async tail() {
      return ['line 1', 'done']
    },
  }
}

describe('время и cron', () => {
  it('длительности, «19:30», ISO без пояса — в поясе', () => {
    expect(parseDuration('через 2h')).toBe(7_200_000)
    expect(parseDuration('1h30m')).toBe(5_400_000)
    expect(parseDuration('90 мин')).toBe(5_400_000)
    expect(parseDuration('+45s')).toBe(45_000)
    expect(parseDuration('завтра')).toBeUndefined()
    expect(parseDuration('2h мусор')).toBeUndefined()
    const now = Date.parse('2026-11-06T15:00:00Z') // 16:00 в Варшаве (CET)
    expect(new Date(parseAt('19:30', TZ, now)).toISOString()).toBe('2026-11-06T18:30:00.000Z')
    expect(new Date(parseAt('09:00', TZ, now)).toISOString()).toBe('2026-11-07T08:00:00.000Z')
    expect(new Date(parseAt('завтра 10:15', TZ, now)).toISOString()).toBe('2026-11-07T09:15:00.000Z')
    expect(new Date(parseAt('2026-07-01T12:00', TZ, now)).toISOString()).toBe('2026-07-01T10:00:00.000Z') // CEST
    expect(new Date(parseAt('2026-11-06T19:00:00Z', TZ, now)).toISOString()).toBe('2026-11-06T19:00:00.000Z')
    expect(() => parseAt('когда-нибудь', TZ, now)).toThrow(/не понял/)
    expect(zonedTime(TZ, 2026, 3, 29, 12, 0)).toBe(Date.parse('2026-03-29T10:00:00Z'))
  })

  it('cron: будни 9:00 в поясе, шаг, переход на зимнее время', () => {
    const fri = Date.parse('2026-11-06T09:00:00Z') // пт 10:00 Варшава
    expect(new Date(nextCron('0 9 * * 1-5', TZ, fri)).toISOString()).toBe('2026-11-09T08:00:00.000Z') // пн
    expect(new Date(nextCron('*/15 * * * *', TZ, Date.parse('2026-11-06T09:07:00Z'))).toISOString()).toBe('2026-11-06T09:15:00.000Z')
    expect(new Date(nextCron('30 2 * * *', TZ, Date.parse('2026-10-24T12:00:00Z'))).toISOString()).toBe('2026-10-25T00:30:00.000Z') // ещё CEST
    expect(new Date(nextCron('@daily', 'UTC', Date.parse('2026-11-06T09:00:00Z'))).toISOString()).toBe('2026-11-07T00:00:00.000Z')
    expect(() => parseCron('0 25 * * *')).toThrow(/час/)
    expect(() => parseCron('0 9 *')).toThrow(/пять полей/)
  })
})

describe('условия', () => {
  it('at: стреляет по часам, ход с prompt, запись fired; занятая сессия — pending, потом доставка', async () => {
    let t = Date.parse('2026-11-06T15:00:00Z')
    const b = fakeBackend({ busy: 1 })
    const notes: string[] = []
    const wake = createWake({ dir: tmp('wake-at-'), fire: true, backend: () => b, now: () => t, notify: (x) => void notes.push(x) })
    const r = await wake.create({ session: 's1', prompt: 'проверь прогон', when: { at: 'через 2h' } })
    expect(r.next).toBe('2026-11-06T17:00:00.000Z')
    expect((await wake.once()).triggered).toEqual([])
    t += 2 * 3600_000
    const p1 = await wake.once()
    expect(p1.triggered).toEqual([r.id])
    expect(p1.delivered).toEqual([])
    expect(wake.get(r.id)!.status).toBe('pending')
    expect(wake.get(r.id)!.error).toMatch(/занята/)
    const p2 = await wake.once()
    expect(p2.delivered).toEqual([r.id])
    expect(b.runs).toHaveLength(1)
    expect(b.runs[0]!.sid).toBe('s1')
    expect(b.runs[0]!.input.headless).toBe(true)
    expect(String(b.runs[0]!.input.userMessage)).toMatch(/^⏰ проверь прогон\n\nСработало: время 18:00/)
    expect(wake.get(r.id)!.status).toBe('fired')
    expect(notes[0]).toMatch(/⏰ проверь прогон/)
  })

  it('cron: после доставки снова waiting со следующим временем', async () => {
    let t = Date.parse('2026-11-06T07:59:00Z')
    const b = fakeBackend()
    const wake = createWake({ dir: tmp('wake-cron-'), fire: true, backend: () => b, now: () => t })
    const r = await wake.create({ session: 's', prompt: 'утро', when: { cron: '0 9 * * *' } })
    expect(r.next).toBe('2026-11-06T08:00:00.000Z')
    t = Date.parse('2026-11-06T08:00:30Z')
    await wake.once()
    const after = wake.get(r.id)!
    expect(after.status).toBe('waiting')
    expect(after.fires).toBe(1)
    expect(after.next).toBe('2026-11-07T08:00:00.000Z')
    expect(b.runs).toHaveLength(1)
  })

  it('job: конец задачи — статус, exit, папка, лог и хвост лога в ходе', async () => {
    const b = fakeBackend()
    const jobs = fakeJobs()
    const wake = createWake({ dir: tmp('wake-job-'), fire: true, backend: () => b, jobs })
    const j = await jobs.start({ cmd: 'sleep 90 && echo done', cwd: '/tmp', title: 'сон' })
    const r = await wake.create({ session: 's', prompt: 'итог', when: { job: j.id } })
    expect(r.title).toBe('сон')
    await wake.once()
    expect(b.runs).toHaveLength(0)
    jobs.set(j.id, { status: 'done', exit: 0, started: '2026-11-06T12:00:00Z', ended: '2026-11-06T12:01:30Z' })
    await wake.once()
    const msg = String(b.runs[0]!.input.userMessage)
    expect(msg).toContain(`Сработало: задача ${j.id} «сон»: done`)
    expect(msg).toContain('статус: done, exit 0, 1 мин 30 с')
    expect(msg).toContain(`лог: /jobs/${j.id}/log.ndjson`)
    expect(msg).toContain('line 1\ndone')
    await expect(wake.create({ session: 's', prompt: 'x', when: { job: 'nope' } })).rejects.toThrow(/нет задачи/)
  })

  it('pid: процесс вышел', async () => {
    const b = fakeBackend()
    const wake = createWake({ dir: tmp('wake-pid-'), fire: true, backend: () => b })
    const child = spawn('sleep', ['30'], { stdio: 'ignore' })
    const r = await wake.create({ session: 's', prompt: 'вышел?', when: { pid: child.pid! } })
    await wake.once()
    expect(wake.get(r.id)!.status).toBe('waiting')
    child.kill('SIGKILL')
    await new Promise((res) => child.once('exit', res))
    await wake.once()
    expect(wake.get(r.id)!.status).toBe('fired')
    expect(String(b.runs[0]!.input.userMessage)).toContain(`процесс ${child.pid} вышел`)
  })

  it('file: появился; match — строка в файле; timeout — ход «не дождался»', async () => {
    let t = Date.parse('2026-11-06T15:00:00Z')
    const b = fakeBackend()
    const d = tmp('wake-file-')
    const wake = createWake({ dir: tmp('wake-filed-'), fire: true, backend: () => b, now: () => t })
    const f = join(d, 'out.log')
    const appear = await wake.create({ session: 'a', prompt: 'появился', when: { file: f } })
    const line = await wake.create({ session: 'b', prompt: 'строка', when: { file: f, match: '^DONE \\d+' } })
    const late = await wake.create({ session: 'c', prompt: 'ждать', when: { file: join(d, 'never') }, timeout: '1h' })
    await wake.once()
    expect(b.runs).toHaveLength(0)
    writeFileSync(f, 'start\n')
    await wake.once()
    expect(wake.get(appear.id)!.status).toBe('fired')
    expect(wake.get(line.id)!.status).toBe('waiting')
    appendFileSync(f, 'DONE 42 ok\n')
    await wake.once()
    expect(wake.get(line.id)!.status).toBe('fired')
    expect(String(b.runs.find((x) => x.sid === 'b')!.input.userMessage)).toContain('строка: DONE 42 ok')
    t += 3600_000
    await wake.once()
    expect(wake.get(late.id)!.status).toBe('timeout')
    expect(String(b.runs.find((x) => x.sid === 'c')!.input.userMessage)).toMatch(/Не дождался: файл .*never — срок/)
  })

  it('task: смена статуса относительно постановки', async () => {
    const b = fakeBackend()
    let status = 'in_progress'
    const wake = createWake({ dir: tmp('wake-task-'), fire: true, backend: () => b, taskStatus: async (refs) => Object.fromEntries(refs.map((r) => [r, { status }])) })
    const r = await wake.create({ session: 's', prompt: 'задача', when: { task: 'abc-1' } })
    expect(r.baseline).toBe('in_progress')
    await wake.once()
    expect(b.runs).toHaveLength(0)
    status = 'in_review'
    await wake.once()
    expect(String(b.runs[0]!.input.userMessage)).toContain('задача ABC-1: in_progress → in_review')
  })

  it('task on=verdict (ABC-738): проход статусы не смотрит, будит taskEvent; постановщику — ход сразу pending, один на событие; доставит стреляющий стенд с диска', async () => {
    const b = fakeBackend({ busy: 1 })
    const dir = tmp('wake-verdict-')
    let asked = 0
    const taskStatus = async (refs: string[]) => (asked++, Object.fromEntries(refs.map((r) => [r, { status: 'in_review' }])))
    const notes: string[] = []
    const fire = createWake({ dir, fire: true, backend: () => b, taskStatus, notify: (x) => void notes.push(x) })
    // Хост задач — другой процесс без fire, тот же каталог.
    const host = createWake({ dir })
    const w = await fire.create({ session: 'watcher', prompt: 'чужая задача', when: { task: 'abc-5', on: 'verdict' } })
    expect(w.baseline).toBeUndefined()
    await expect(fire.create({ session: 's', prompt: 'x', when: { task: 'abc-5', on: 'nope' as never } })).rejects.toThrow(/status или verdict/)
    await fire.once()
    expect(asked).toBe(0)
    expect(b.runs).toHaveLength(0)
    const both = await fire.create({ session: 'trunk', prompt: 'своя', when: { task: 'ABC-5', on: 'verdict' } })
    const ids = host.taskEvent({ task: 'abc-5', reason: 'ABC-5: отказ — нет тестов', details: 'исполнитель e1, приёмщик a1', session: 'trunk', message: '⏰ ABC-5: отказ — нет тестов; исполнитель e1, приёмщик a1' })
    // trunk уже ждёт сам — второго хода нет; watcher разбужен.
    expect(ids.sort()).toEqual([w.id, both.id].sort())
    // Без ждущих — запись постановщику.
    const solo = host.taskEvent({ task: 'ABC-6', reason: 'ABC-6: принято — ок', session: 'trunk2', message: '⏰ ABC-6: принято — ок; исполнитель e2, приёмщик a2' })
    expect(solo).toHaveLength(1)
    expect(host.get(solo[0]!)?.status).toBe('pending')
    expect(host.taskEvent({ task: 'ABC-7', reason: 'ABC-7: оборван' })).toEqual([])
    await fire.once() // первая доставка — «занято»: остаётся pending
    await fire.once()
    const msgs = b.runs.map((r) => `${r.sid}: ${String(r.input.userMessage)}`)
    expect(msgs.some((m) => m.startsWith('watcher: ⏰ чужая задача') && m.includes('Сработало: ABC-5: отказ — нет тестов') && m.includes('приёмщик a1'))).toBe(true)
    expect(msgs).toContain('trunk2: ⏰ ABC-6: принято — ок; исполнитель e2, приёмщик a2')
    expect(b.runs).toHaveLength(3)
    expect(fire.get(solo[0]!)?.status).toBe('fired')
    // Ход хоста задач — без второго Telegram (хост уже отправил).
    expect(notes.filter((n) => n.includes('ABC-6'))).toHaveLength(0)
    await fire.once()
    expect(b.runs).toHaveLength(3)
  })

  it('wake_on task on=verdict тулом; описание тула зовёт verdict', async () => {
    const wake = createWake({ dir: tmp('wake-verdict-tool-') })
    const r = (await wake.call('tool', { name: 'wake_on', args: { task: 'ABC-9', on: 'verdict', prompt: 'проверь ABC-9' }, session: { id: 's1' } })) as { text: string; data: { when: unknown; label: string } }
    expect(r.data.when).toEqual({ task: 'ABC-9', on: 'verdict' })
    expect(r.data.label).toBe('вердикт ABC-9')
    const plain = (await wake.call('tool', { name: 'wake_on', args: { task: 'ABC-9', prompt: 'статус' }, session: { id: 's1' } })) as { data: { when: unknown } }
    expect(plain.data.when).toEqual({ task: 'ABC-9' })
  })

  it('нет сессии — failed; отмена — не стреляет; без fire не стреляет', async () => {
    let t = Date.parse('2026-11-06T15:00:00Z')
    const dir = tmp('wake-misc-')
    const gone = fakeBackend({ missing: true })
    const wake = createWake({ dir, fire: true, backend: () => gone, now: () => t })
    const a = await wake.create({ session: 'gone', prompt: 'x', when: { at: '1m' } })
    const c = await wake.create({ session: 's', prompt: 'снят', when: { at: '1m' } })
    expect(wake.cancel(c.id).status).toBe('cancelled')
    const quiet = createWake({ dir, now: () => t + 120_000 })
    expect((await quiet.once()).triggered).toEqual([])
    t += 120_000
    await wake.once()
    expect(wake.get(a.id)!.status).toBe('failed')
    expect(wake.get(c.id)!.status).toBe('cancelled')
    expect(wake.list().map((r) => r.id)).toEqual([])
    expect(wake.list({ all: true })).toHaveLength(2)
  })
})

describe('рестарт', () => {
  it('запись с диска стреляет после перезапуска хаба (новый будильник на том же каталоге)', async () => {
    let t = Date.parse('2026-11-06T15:00:00Z')
    const dir = tmp('wake-restart-')
    const first = createWake({ dir, fire: true, backend: () => fakeBackend(), now: () => t })
    const r = await first.create({ session: 's', prompt: 'после рестарта', when: { at: 'через 2 мин' } })
    first.stop()
    expect(readdirSync(dir)).toEqual([`${r.id}.json`])
    t += 3 * 60_000
    const b = fakeBackend()
    const second = createWake({ dir, fire: true, backend: () => b, now: () => t })
    expect((await second.once()).delivered).toEqual([r.id])
    expect(String(b.runs[0]!.input.userMessage)).toMatch(/^⏰ после рестарта/)
  })
})

describe('сквозной ход и тулы', () => {
  it('через хаб в движок по HTTP: ход ⏰ в ленте сессии и ответ агента; тулы wake_* и job_*', async () => {
    const acpDir = tmp('wake-acp-')
    const acp = createStoreBackend({
      store: createNrChatStore({ dir: acpDir }),
      name: 'acp',
      generate: async function* (req: GenerateRequest) {
        const last = req.messages?.at(-1) as { parts?: Array<{ text?: string }> } | undefined
        yield { type: 'text' as const, delta: `видел: ${(last?.parts?.[0]?.text ?? '').split('\n')[0]}` }
      },
    })
    const srv = await serveBackend(acp, { port: 0 })
    closers.push(() => srv.close())
    const nr = createStoreBackend({ store: createNrChatStore({ dir: tmp('wake-nr-') }), name: 'nr', generate: async function* () {} })
    const hub = createHub({ local: nr, engines: [{ id: 'acp', backend: createHttpBackend(srv.url, { capabilitiesTtl: 0 }), sessionsDir: acpDir }], probeTtlMs: 0, log: () => {} })
    const s = await hub.sessions.create({ title: 'чат', engine: 'acp' })
    const jobs = fakeJobs()
    const wake = createWake({ dir: tmp('wake-e2e-'), fire: true, backend: () => hub, jobs, cwd: '/tmp' })
    const svc = withWakeService(undefined, wake)
    const cap = await svc.capability()
    expect(cap.wake?.methods).toContain('tool')
    const tools = (await svc.call('wake', 'tools', {})) as Array<{ name: string }>
    expect(tools.map((x) => x.name)).toEqual(['wake_at', 'wake_on', 'wake_list', 'wake_cancel', 'job_start', 'job_status'])
    const started = (await svc.call('wake', 'tool', { name: 'job_start', args: { cmd: 'sleep 90 && echo done' }, session: { id: s.id, cwd: '/tmp' } })) as { text: string; data: { job: WakeJobView; wake: { id: string } } }
    expect(started.text).toMatch(/запущена/)
    expect(started.text).toMatch(/будильник w-/)
    const other = (await svc.call('wake', 'tool', { name: 'wake_at', args: { when: 'через 2h', prompt: 'другой' }, session: { id: s.id } })) as { data: { id: string } }
    const cancelled = (await svc.call('wake', 'tool', { name: 'wake_cancel', args: { id: other.data.id } })) as { text: string }
    expect(cancelled.text).toMatch(/cancelled/)
    const listed = (await svc.call('wake', 'tool', { name: 'wake_list', args: {}, session: { id: s.id } })) as { text: string; data: unknown[] }
    expect(listed.data).toHaveLength(1)
    const bad = (await svc.call('wake', 'tool', { name: 'wake_on', args: { prompt: 'x' }, session: { id: s.id } })) as { isError?: boolean; text: string }
    expect(bad.isError).toBe(true)
    jobs.set(started.data.job.id, { status: 'done', exit: 0 })
    const st = (await svc.call('wake', 'tool', { name: 'job_status', args: { id: started.data.job.id } })) as { text: string }
    expect(st.text).toContain('статус: done, exit 0')
    await wake.once()
    for (let i = 0; i < 50; i++) {
      const h = await hub.history(s.id)
      if (h.messages.some((m) => m.role === 'assistant')) break
      await new Promise((r) => setTimeout(r, 50))
    }
    const h = await hub.history(s.id)
    const texts = h.messages.map((m) => `${m.role}: ${m.parts.map((p) => (p as { text?: string }).text ?? '').join('')}`)
    expect(texts[0]).toMatch(/^user: ⏰ задача .* кончилась — проверь итог и доложи/)
    expect(texts[0]).toContain('line 1\ndone')
    expect(texts[1]).toBe(`assistant: видел: ⏰ задача ${started.data.job.id} «sleep 90 && echo done» кончилась — проверь итог и доложи`)
  })
})
