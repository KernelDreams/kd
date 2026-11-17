/**
 * Хаб (users-spec §1, протокол v1.29): один список сессий всех движков, ход —
 * движку сессии, смена исполнителя переносом ленты, движок лежит — его сессии
 * в списке с пометкой.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNrChatStore } from '@kerneldreams/chat-store/nr-chat'
import type { ProtocolBackend } from '@kerneldreams/ui-protocol'
import { createStoreBackend, type GenerateRequest } from '../src/store-backend.js'
import { createMemoryProjects } from '../src/projects.js'
import { serveBackend } from '../src/serve.js'
import { createHttpBackend } from '../src/client.js'
import { createHub, createHubPlugins } from '../src/hub.js'
import { createFsPlugins } from '../src/fs-plugins.js'

/** Движок: стор nr-chat в своём каталоге, генерация подписывается именем движка. */
function engine(name: string, dir: string, seen: GenerateRequest[] = [], projects?: ReturnType<typeof createMemoryProjects>) {
  return createStoreBackend({
    store: createNrChatStore({ dir }),
    name,
    models: [{ id: `${name}-model` }],
    profiles: [{ id: 'default', name: 'Default' }],
    generate: async function* (req: GenerateRequest) {
      seen.push(req)
      yield { type: 'text' as const, delta: `${name}: ${req.messages.length}` }
    },
    ...(projects ? { projects } : {}),
  })
}

async function turn(b: ProtocolBackend, sid: string, text: string): Promise<string> {
  let out = ''
  for await (const ev of b.run(sid, { userMessage: text })) if (ev.type === 'part_delta') out += (ev as { delta: string }).delta
  return out
}

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  while (closers.length) await closers.pop()!()
})

async function setup(opts: { projects?: boolean } = {}) {
  const nrDir = mkdtempSync(join(tmpdir(), 'hub-nr-'))
  const acpDir = mkdtempSync(join(tmpdir(), 'hub-acp-'))
  const projects = opts.projects
    ? () => createMemoryProjects({ root: tmpdir(), projects: [{ id: 'nrchat', name: 'nrchat', root: tmpdir(), engine: 'acp' } as never] })
    : () => undefined
  const nrSeen: GenerateRequest[] = []
  const acpSeen: GenerateRequest[] = []
  const nr = engine('nr', nrDir, nrSeen, projects())
  const acp = engine('acp', acpDir, acpSeen, projects())
  let srv = await serveBackend(acp, { port: 0 })
  const url = (): string => srv.url
  const remote = createHttpBackend(url(), { capabilitiesTtl: 0 })
  const hub = createHub({ local: nr, localSessionsDir: nrDir, engines: [{ id: 'acp', name: 'Claude Code', backend: remote, sessionsDir: acpDir }], probeTtlMs: 0, log: () => {} })
  closers.push(async () => {
    await srv.close().catch(() => {})
  })
  return {
    nrDir,
    acpDir,
    nr,
    acp,
    hub,
    nrSeen,
    acpSeen,
    stop: () => srv.close(),
    async restart() {
      srv = await serveBackend(acp, { port: Number(new URL(url()).port) })
    },
  }
}

describe('хаб', () => {
  it('один список: сессии обоих движков с engine; ход — движку сессии', async () => {
    const t = await setup()
    const a = await t.hub.sessions.create({ title: 'nr-сессия' })
    const b = await t.hub.sessions.create({ title: 'acp-сессия', engine: 'acp' })
    expect(a.engine).toBe('nr')
    expect(b.engine).toBe('acp')
    expect(existsSync(join(t.acpDir, `${b.id}.mds`))).toBe(true)

    const list = await t.hub.sessions.list()
    expect(list.map((s) => [s.title, s.engine]).sort()).toEqual([
      ['acp-сессия', 'acp'],
      ['nr-сессия', 'nr'],
    ])

    expect(await turn(t.hub, a.id, 'привет')).toBe('nr: 1')
    expect(await turn(t.hub, b.id, 'привет')).toBe('acp: 1')
    expect(t.acpSeen).toHaveLength(1)
    expect((await t.hub.history(b.id)).messages.map((m) => m.role)).toEqual(['user', 'assistant'])

    const caps = await t.hub.capabilities()
    expect(caps.engines).toEqual({
      list: [
        { id: 'nr', local: true, available: true },
        { id: 'acp', name: 'Claude Code', available: true },
      ],
      default: 'nr',
      switch: true,
    })
    // Общий каталог моделей: чужие — с пометкой движка.
    expect(await t.hub.models!.list()).toEqual([{ id: 'nr-model' }, { id: 'acp-model', engine: 'acp' }])
  })

  it('чужая сессия (создана на движке мимо хаба) — в списке; модель и профиль встроенного движку не уходят', async () => {
    const t = await setup()
    const direct = await t.acp.sessions.create({ title: 'напрямую' })
    expect((await t.hub.sessions.list()).find((s) => s.id === direct.id)?.engine).toBe('acp')
    const s = await t.hub.sessions.create({ engine: 'acp', model: { model: 'nr-model' }, profile: 'nope' })
    expect(s.model).toBeUndefined()
  })

  it('движок лежит: его сессии — с пометкой, операции — engine_unavailable; nr работает', async () => {
    const t = await setup()
    const a = await t.hub.sessions.create({})
    const b = await t.hub.sessions.create({ engine: 'acp', title: 'acp' })
    await t.stop()
    const list = await t.hub.sessions.list()
    expect(list.find((s) => s.id === b.id)).toMatchObject({ engine: 'acp', engineUnavailable: true })
    expect(list.find((s) => s.id === a.id)?.engineUnavailable).toBeUndefined()
    await expect(t.hub.history(b.id)).rejects.toMatchObject({ code: 'engine_unavailable' })
    await expect(t.hub.sessions.create({ engine: 'acp' })).rejects.toMatchObject({ code: 'engine_unavailable' })
    expect(await turn(t.hub, a.id, 'q')).toBe('nr: 1')
    expect((await t.hub.capabilities()).engines!.list[1]).toMatchObject({ id: 'acp', available: false })
    await t.restart()
    expect(await turn(t.hub, b.id, 'снова')).toBe('acp: 1')
  })

  it('смена исполнителя acp → nr → acp: лента та же, ход на новом, заметка скрыта от контекста', async () => {
    const t = await setup()
    const s = await t.hub.sessions.create({ engine: 'acp' })
    await turn(t.hub, s.id, 'первый')
    const moved = await t.hub.sessions.setEngine!(s.id, 'nr')
    expect(moved).toMatchObject({ id: s.id, engine: 'nr' })
    expect(existsSync(join(t.acpDir, `${s.id}.mds`))).toBe(false)
    expect(existsSync(join(t.nrDir, `${s.id}.mds`))).toBe(true)
    const h = (await t.hub.history(s.id)).messages
    expect(h.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(h[2]).toMatchObject({ flags: { disabled: true } })
    expect(JSON.stringify(h[2]!.parts)).toContain('acp → nr')

    // Ход — на nr, в контексте — вся лента без заметки.
    expect(await turn(t.hub, s.id, 'второй')).toBe('nr: 3')
    expect(t.nrSeen.at(-1)!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])

    // Обратно — CC (acp) видит всю историю.
    await t.hub.sessions.setEngine!(s.id, 'acp')
    expect(await turn(t.hub, s.id, 'третий')).toBe('acp: 5')
    expect(readFileSync(join(t.acpDir, `${s.id}.mds`), 'utf-8')).toContain('второй')
    expect((await t.hub.sessions.list()).find((x) => x.id === s.id)?.engine).toBe('acp')
  })

  it('$engine проекта — движок новой сессии', async () => {
    const t = await setup({ projects: true })
    const s = await t.hub.sessions.create({ workspace: 'nrchat' })
    expect(s.engine).toBe('acp')
    expect((await t.hub.sessions.list({ workspace: 'nrchat' })).map((x) => x.id)).toEqual([s.id])
    expect(await t.hub.sessions.list({ workspace: 'default' })).toEqual([])
  })

  it('по проводу: setEngine и engine в create — через serveBackend/клиент', async () => {
    const t = await setup()
    const hubSrv = await serveBackend(t.hub, { port: 0 })
    closers.push(() => hubSrv.close())
    const c = createHttpBackend(hubSrv.url)
    const s = await c.sessions.create({ engine: 'acp' })
    expect(s.engine).toBe('acp')
    expect(await c.sessions.setEngine!(s.id, 'nr')).toMatchObject({ engine: 'nr' })
    await expect(c.sessions.setEngine!(s.id, 'zzz')).rejects.toMatchObject({ code: 'bad_request' })
  })
})

describe('хаб: служебный движок (ABC-630, v1.61)', () => {
  it('хаб задач: сессии в списке, в live и открываются; в выборе нет, новые и перевод — не на него', async () => {
    const nrDir = mkdtempSync(join(tmpdir(), 'hub-nr-'))
    const chatDir = mkdtempSync(join(tmpdir(), 'hub-chat-'))
    const tasksDir = mkdtempSync(join(tmpdir(), 'hub-tasks-'))
    const projects = () => createMemoryProjects({ root: tmpdir(), projects: [{ id: 'svc', name: 'svc', root: tmpdir(), engine: 'tasks' } as never] })
    const chat = engine('acp', chatDir, [], projects())
    const tasks = engine('tasks', tasksDir, [], projects())
    const s1 = await serveBackend(chat, { port: 0 })
    const s2 = await serveBackend(tasks, { port: 0 })
    closers.push(() => s1.close().catch(() => {}), () => s2.close().catch(() => {}))
    const hub = createHub({
      local: engine('nr', nrDir, [], projects()),
      localSessionsDir: nrDir,
      engines: [
        { id: 'acp', name: 'Claude Code', backend: createHttpBackend(s1.url, { capabilitiesTtl: 0 }), sessionsDir: chatDir },
        { id: 'tasks', name: 'Claude Code · задачи', backend: createHttpBackend(s2.url, { capabilitiesTtl: 0 }), sessionsDir: tasksDir, create: false },
      ],
      probeTtlMs: 0,
      log: () => {},
    })
    const exec = await tasks.sessions.create({ title: 'ABC-1 · исполнитель' })
    const caps = await hub.capabilities()
    const info = caps.engines!.list.find((e) => e.id === 'tasks')!
    expect(info).toMatchObject({ create: false, switch: false, available: true })
    expect(caps.engines!.list.find((e) => e.id === 'acp')!.create).toBeUndefined()
    const list = await hub.sessions.list()
    expect(list.find((s) => s.id === exec.id)).toMatchObject({ engine: 'tasks', title: 'ABC-1 · исполнитель' })
    // Продолжить из nrchat — ход уходит хабу задач.
    expect(await turn(hub, exec.id, 'дальше')).toBe('tasks: 1')
    // `$engine` проекта на служебный — новая сессия всё равно на дефолте.
    const fresh = await hub.sessions.create({ workspace: 'svc' })
    expect(fresh.engine).toBe('nr')
    await expect(hub.sessions.setEngine!(fresh.id, 'tasks')).rejects.toThrow(/служебный/)
  })
})

describe('хаб: хвосты ABC-303 (ABC-308)', () => {
  it('движок без каталога .mds — не цель смены исполнителя (switch: false)', async () => {
    const t = await setup()
    const pi = engine('pi', mkdtempSync(join(tmpdir(), 'hub-pi-')))
    const hub = createHub({ local: t.nr, localSessionsDir: t.nrDir, engines: [{ id: 'acp', backend: t.acp, sessionsDir: t.acpDir }, { id: 'pi', backend: pi }], probeTtlMs: 0, log: () => {} })
    const caps = await hub.capabilities()
    expect(caps.engines!.switch).toBe(true)
    expect(caps.engines!.list.map((e) => [e.id, e.switch])).toEqual([
      ['nr', undefined],
      ['acp', undefined],
      ['pi', false],
    ])
  })

  it('П-21: сессия pi, которую встроенный тоже видит (легаси-каталог pi), — у pi: список, get, ход, форк, удаление', async () => {
    const shared = mkdtempSync(join(tmpdir(), 'hub-pi-shared-'))
    const piSeen: GenerateRequest[] = []
    const nrSeen: GenerateRequest[] = []
    const pi = engine('pi', shared, piSeen)
    // Встроенный читает тот же каталог — как nr читает старый каталог pi.
    const nr = engine('nr', shared, nrSeen)
    const hub = createHub({ local: nr, engines: [{ id: 'pi', backend: pi }], probeTtlMs: 0, log: () => {} })
    const s = await hub.sessions.create({ engine: 'pi' })
    expect(s.engine).toBe('pi')
    // Новый хаб (индекс пуст) — список решает сам.
    const fresh = createHub({ local: nr, engines: [{ id: 'pi', backend: pi }], probeTtlMs: 0, log: () => {} })
    expect((await fresh.sessions.list()).find((x) => x.id === s.id)?.engine).toBe('pi')
    expect((await fresh.sessions.get(s.id)).engine).toBe('pi')
    expect(await turn(fresh, s.id, 'привет')).toBe('pi: 1')
    expect(nrSeen).toHaveLength(0)
    const f = await fresh.sessions.fork!(s.id)
    expect(f.engine).toBe('pi')
    await fresh.sessions.delete(s.id)
    await expect(pi.sessions.get(s.id)).rejects.toThrow()
  })

  it('индекс каталога: не перечитывается без событий, видит новый файл по mtime каталога и после create через хаб', async () => {
    const t = await setup()
    const a = await t.hub.sessions.create({ title: 'через хаб', engine: 'acp' })
    expect((await t.hub.sessions.list()).some((s) => s.id === a.id)).toBe(true)
    // Мимо хаба — новый файл в каталоге: mtime каталога сменился.
    const direct = await t.acp.sessions.create({ title: 'мимо' })
    expect((await t.hub.sessions.list()).some((s) => s.id === direct.id)).toBe(true)
    // ?refresh=1 — перечитать в любом случае.
    expect((await t.hub.sessions.list({ refresh: true })).filter((s) => s.engine === 'acp')).toHaveLength(2)
  })
})

describe('хаб: плагины, сервисы, профили и capabilities движков (ABC-310)', () => {
  /** Слой сервисов с одним сервисом `id`: call → `${id}:${method}`. */
  const svcHost = (id: string, calls: string[]) => ({
    capability: async () => ({ [id]: { methods: ['ping'], streams: ['tick'] } }),
    call: async (plugin: string, method: string) => (calls.push(`${plugin}.${method}`), `${id}:${method}`),
    stream: (plugin: string, method: string) =>
      (async function* () {
        calls.push(`${plugin}.${method}~`)
        yield { type: 'service_event', data: 1 } as never
      })(),
    close: async () => {},
  })

  it('П-7/П-8: сервисы — объединение, вызов движку-владельцу; EngineInfo.caps — отличия; профили движка по engine', async () => {
    const nrCalls: string[] = []
    const acpCalls: string[] = []
    const nr = createStoreBackend({ store: createNrChatStore({ dir: mkdtempSync(join(tmpdir(), 'hub-svc-nr-')) }), generate: async function* () {}, profiles: [{ id: 'default', name: 'Default' }], services: svcHost('notes', nrCalls) as never })
    const acp = createStoreBackend({
      store: createNrChatStore({ dir: mkdtempSync(join(tmpdir(), 'hub-svc-acp-')) }),
      generate: async function* () {},
      attachmentMaxBytes: 2 * 1024 * 1024,
      profiles: [{ id: 'default', name: 'Default' }, { id: 'snap', name: 'Слепок' }],
      services: svcHost('cc', acpCalls) as never,
    })
    const srv = await serveBackend(acp, { port: 0 })
    closers.push(() => srv.close())
    const hub = createHub({ local: nr, engines: [{ id: 'acp', backend: createHttpBackend(srv.url, { capabilitiesTtl: 0 }) }], probeTtlMs: 0, log: () => {} })
    const caps = await hub.capabilities()
    expect(Object.keys(caps.services ?? {}).sort()).toEqual(['cc', 'notes', 'nr.sessions'])
    const acpInfo = caps.engines!.list.find((e) => e.id === 'acp')!
    expect(acpInfo.caps).toMatchObject({ attachments: { maxBytes: 2 * 1024 * 1024 } })
    expect(caps.engines!.list.find((e) => e.id === 'nr')!.caps).toBeUndefined()
    expect(await hub.services!.call('cc', 'ping')).toBe('cc:ping')
    expect(await hub.services!.call('notes', 'ping')).toBe('notes:ping')
    for await (const _ of hub.services!.stream('cc', 'tick')) { /* drain */ }
    expect(acpCalls).toEqual(['cc.ping', 'cc.tick~'])
    expect(nrCalls).toEqual(['notes.ping'])
    // Один каталог агентов: без дублей по движкам, агент только движка — с его пометкой.
    expect((await hub.profiles!.list()).map((p) => [p.id, (p as { engine?: string }).engine])).toEqual([
      ['default', undefined],
      ['snap', 'acp'],
    ])
    // Документ агента только движка — у хаба без engine тоже.
    expect((await hub.profiles!.get('snap')).name).toBe('Слепок')
    expect((await hub.profiles!.list({ engine: 'acp' })).map((p) => [p.id, (p as { engine?: string }).engine])).toEqual([
      ['default', 'acp'],
      ['snap', 'acp'],
    ])
    expect((await hub.profiles!.get('snap', { engine: 'acp' })).name).toBe('Слепок')
    // По проводу: ?engine= у /profiles.
    const hubSrv = await serveBackend(hub, { port: 0 })
    closers.push(() => hubSrv.close())
    const client = createHttpBackend(hubSrv.url)
    expect((await client.profiles!.list({ engine: 'acp' })).map((p) => p.id)).toEqual(['default', 'snap'])
    expect((await client.profiles!.get('snap', { engine: 'acp' })).name).toBe('Слепок')
    expect(await client.services!.call('cc', 'ping')).toBe('cc:ping')
  })

  it('П-7: createHubPlugins — плагины стенда + движка; файлы чужого — прокси с движка', async () => {
    const mk = (id: string, js: string): string => {
      const dir = join(mkdtempSync(join(tmpdir(), 'hub-plug-')), id)
      mkdirSync(join(dir, 'dist'), { recursive: true })
      writeFileSync(join(dir, 'dist', 'index.js'), js)
      return dir
    }
    const own = createFsPlugins([mk('notes', 'export default "notes"')])
    const acpPlugins = createFsPlugins([mk('cc', 'export default "cc"'), mk('notes', 'export default "acp-notes"')])
    const acp = engine('acp', mkdtempSync(join(tmpdir(), 'hub-plug-acp-')))
    const srv = await serveBackend(acp, { port: 0, plugins: acpPlugins })
    closers.push(() => srv.close())
    const src = createHubPlugins(own, [{ id: 'acp', backend: createHttpBackend(srv.url, { capabilitiesTtl: 0 }), url: srv.url }])
    expect((await src.list()).map((p) => p.id)).toEqual(['notes', 'cc'])
    // Адрес плагина движка — через хаб, не абсолютный адрес движка (браузер не на хосте).
    const cc = (await src.list()).find((p) => p.id === 'cc')!
    expect(cc.url).toMatch(/^plugins\/cc\/index\.js(\?|$)/)
    expect(cc.url).not.toContain('127.0.0.1')
    expect(new TextDecoder().decode((await src.file('cc', 'index.js'))!.data)).toBe('export default "cc"')
    expect(new TextDecoder().decode((await src.file('notes', 'index.js'))!.data)).toBe('export default "notes"')
    expect(await src.file('cc', '../x')).toBeNull()
    // Через serveBackend хаба — тот же путь, что у фронта.
    const hubSrv = await serveBackend(createHub({ local: engine('nr', mkdtempSync(join(tmpdir(), 'hub-plug-nr-'))), engines: [], log: () => {} }), { port: 0, plugins: src })
    closers.push(() => hubSrv.close())
    expect(await (await fetch(`${hubSrv.url}/plugins/cc/index.js`)).text()).toBe('export default "cc"')
  })
})

describe('хаб: медленный движок без каталога (ABC-344)', () => {
  it('список не ждёт движок дольше таймаута; опоздавший ложится в следующий запрос; ошибка не роняет', async () => {
    const nrDir = mkdtempSync(join(tmpdir(), 'hub-slow-nr-'))
    const nr = engine('nr', nrDir)
    await nr.sessions.create({ title: 'свой' })
    let delay = 600
    let fail = false
    const info = { id: 'pi-1', title: 'из pi', createdAt: '2026-01-01T00:00:00.000Z' }
    const slow = {
      capabilities: async () => ({ protocol: 1 }),
      sessions: {
        list: async () => {
          await new Promise((r) => setTimeout(r, delay))
          if (fail) throw new Error('boom')
          return [info]
        },
      },
    } as unknown as ProtocolBackend
    const hub = createHub({ local: nr, localSessionsDir: nrDir, engines: [{ id: 'pi', backend: slow }], probeTtlMs: 0, listTimeoutMs: 100, log: () => {} })
    let t = Date.now()
    expect((await hub.sessions.list()).map((s) => s.title)).toEqual(['свой'])
    expect(Date.now() - t).toBeLessThan(450)
    await new Promise((r) => setTimeout(r, 700))
    t = Date.now()
    expect((await hub.sessions.list()).map((s) => s.title).sort()).toEqual(['из pi', 'свой'])
    expect(Date.now() - t).toBeLessThan(450)
    delay = 0
    fail = true
    expect((await hub.sessions.list()).map((s) => s.title).sort()).toEqual(['из pi', 'свой'])
  })
})

describe('хаб: погасить процесс (v1.38, ABC-352)', () => {
  it('release — движку сессии по HTTP, если он заявил capability; встроенный без неё — not_supported', async () => {
    const nrDir = mkdtempSync(join(tmpdir(), 'hub-rel-nr-'))
    const acpDir = mkdtempSync(join(tmpdir(), 'hub-rel-acp-'))
    const inner = engine('acp', acpDir)
    const released: string[] = []
    const acp: ProtocolBackend = {
      ...inner,
      capabilities: async () => ({ ...(await inner.capabilities()), sessions: { release: true } }),
      sessions: { ...inner.sessions, release: async (id: string) => void released.push(id), live: async () => [] },
    }
    const srv = await serveBackend(acp, { port: 0 })
    closers.push(() => srv.close())
    const hub = createHub({ local: engine('nr', nrDir), localSessionsDir: nrDir, engines: [{ id: 'acp', backend: createHttpBackend(srv.url, { capabilitiesTtl: 0 }), sessionsDir: acpDir }], probeTtlMs: 0, log: () => {} })
    expect((await hub.capabilities()).sessions).toMatchObject({ live: true, release: true })
    const a = await hub.sessions.create({ engine: 'acp' })
    await hub.sessions.release!(a.id)
    expect(released).toEqual([a.id])
    const n = await hub.sessions.create({ engine: 'nr' })
    await expect(hub.sessions.release!(n.id)).rejects.toMatchObject({ code: 'not_supported' })
  })
})
