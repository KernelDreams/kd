/**
 * Проекты стенда (протокол v1.26, projects-spec §2–3): реестр —
 * пространства `kind: 'project'`, сессии помечены проектом и фильтруются,
 * новая сессия берёт `$root`/`$profile`/`$model` проекта, реестр правится формой.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import type { AnyRunEvent, ProtocolBackend } from '@kerneldreams/ui-protocol'
import { createStoreBackend, type GenerateFn, type GenerateRequest } from '../src/store-backend.js'
import { createMemoryProjects, projectInfo, type ProjectEntry } from '../src/projects.js'
import { serveBackend, type ServeHandle } from '../src/serve.js'
import { createHttpBackend } from '../src/client.js'

let srv: ServeHandle | undefined
let client: ProtocolBackend | undefined
afterEach(async () => {
  await client?.close?.()
  await srv?.close()
  srv = undefined
  client = undefined
})

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

async function drain(it: AsyncIterable<AnyRunEvent>): Promise<AnyRunEvent[]> {
  const out: AnyRunEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

const NRCHAT: ProjectEntry = {
  id: 'nrchat',
  name: 'nrchat',
  description: 'фронт nrchat',
  root: '/work/nrchat',
  dirs: ['/work/nrlib'],
  profile: 'dev',
  model: 'opus',
  skills: ['nrchat', 'dev-skill'],
}

function backendWith(edit = true) {
  const r = recorder()
  const backend = createStoreBackend({
    store: createMemoryStore(),
    generate: r.gen,
    sessionCwd: true,
    models: [{ id: 'sonnet' }, { id: 'opus' }],
    profiles: [{ id: 'default', name: 'default' }, { id: 'dev', name: 'dev' }],
    projects: createMemoryProjects({ root: '/stand', projects: [NRCHAT], edit }),
  })
  return { backend, r }
}

describe('проекты: store-бэкенд', () => {
  it('без опции — прежнее единственное пространство, без projects/edit', async () => {
    const backend = createStoreBackend({ store: createMemoryStore(), generate: recorder().gen })
    const caps = await backend.capabilities()
    expect(caps.workspace?.projects).toBeUndefined()
    expect(caps.workspace?.switch).toBeUndefined()
    expect((await backend.workspace!.list()).map((w) => w.id)).toEqual(['memory'])
    expect(backend.workspace!.create).toBeUndefined()
  })

  it('capability, list — реестр kind project с описанием и записью; current — default', async () => {
    const { backend } = backendWith()
    expect((await backend.capabilities()).workspace).toMatchObject({ switch: true, projects: true, edit: true, perSession: true })
    const list = await backend.workspace!.list()
    expect(list.map((w) => w.id)).toEqual(['default', 'nrchat'])
    expect(list[1]).toMatchObject({ id: 'nrchat', name: 'nrchat', path: '/work/nrchat', kind: 'project', description: 'фронт nrchat' })
    expect(list[1]!.project).toMatchObject({ root: '/work/nrchat', dirs: ['/work/nrlib'], skills: ['nrchat', 'dev-skill'] })
    expect((await backend.workspace!.current()).id).toBe('default')
    expect(await backend.workspace!.switch!('nrchat')).toMatchObject({ id: 'nrchat' })
    expect((await backend.workspace!.current()).id).toBe('nrchat')
    await expect(backend.workspace!.switch!('nope')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('create в проекте: cwd = $root, профиль и модель проекта, пометка; генерация получает проект', async () => {
    const { backend, r } = backendWith()
    const s = await backend.sessions.create({ workspace: 'nrchat' })
    expect(s.workspace).toBe('nrchat')
    expect(s.profile).toBe('dev')
    expect(s.model).toEqual({ model: 'opus' })
    expect(await backend.meta!.get(s.id)).toEqual({ workspace: { cwd: '/work/nrchat' } })
    await drain(backend.run(s.id, { userMessage: 'hi' }))
    expect(r.seen[0]!.cwd).toBe('/work/nrchat')
    expect(r.seen[0]!.project).toMatchObject({ id: 'nrchat', dirs: ['/work/nrlib'], skills: ['nrchat', 'dev-skill'] })
  })

  it('явные cwd/профиль/модель — поверх проекта; без workspace — текущий проект процесса', async () => {
    const { backend } = backendWith()
    const a = await backend.sessions.create({ workspace: 'nrchat', cwd: '/tmp/x', profile: 'default', model: { model: 'sonnet' } })
    expect(a).toMatchObject({ workspace: 'nrchat', profile: 'default', model: { model: 'sonnet' } })
    expect(await backend.meta!.get(a.id)).toEqual({ workspace: { cwd: '/tmp/x' } })
    await backend.workspace!.switch!('nrchat')
    const b = await backend.sessions.create()
    expect(b.workspace).toBe('nrchat')
    await expect(backend.sessions.create({ workspace: 'nope' })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('default: без пометки и без cwd; list({workspace}) — сессии проекта, без параметра — все', async () => {
    const { backend, r } = backendWith()
    const d = await backend.sessions.create()
    expect(d.workspace).toBeUndefined()
    expect(await backend.meta!.get(d.id)).toEqual({})
    const n = await backend.sessions.create({ workspace: 'nrchat' })
    expect((await backend.sessions.list({ workspace: 'default' })).map((s) => s.id)).toEqual([d.id])
    expect((await backend.sessions.list({ workspace: 'nrchat' })).map((s) => s.id)).toEqual([n.id])
    expect((await backend.sessions.list({ workspace: 'slots' })).map((s) => s.id)).toEqual([])
    expect((await backend.sessions.list()).length).toBe(2)
    await drain(backend.run(d.id, { userMessage: 'hi' }))
    expect(r.seen[0]!.project).toMatchObject({ id: 'default', root: '/stand' })
    expect(r.seen[0]!.cwd).toBeUndefined()
  })

  it('workspace.create/update: id из имени, проверка полей, конфликт, патч null — снять', async () => {
    const { backend } = backendWith()
    const created = await backend.workspace!.create!({ name: 'Meadow Fortune', root: '/work/slots', dirs: [], skills: ['slots'] })
    expect(created).toMatchObject({ id: 'meadow-fortune', kind: 'project', path: '/work/slots' })
    expect(created.project).toEqual({ name: 'Meadow Fortune', root: '/work/slots', skills: ['slots'] })
    expect(projectInfo({ id: 'x', name: 'x', root: '/x', dir: '/reg/x' }).project).toEqual({ name: 'x', root: '/x' })
    await expect(backend.workspace!.create!({ id: 'nrchat', name: 'x', root: '/x' })).rejects.toMatchObject({ code: 'conflict' })
    await expect(backend.workspace!.create!({ name: 'x', root: 'relative' })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(backend.workspace!.create!({ name: '', root: '/x' } as never)).rejects.toMatchObject({ code: 'bad_request' })
    await expect(backend.workspace!.create!({ name: 'a\nb', root: '/x' })).rejects.toMatchObject({ code: 'bad_request' })
    const again = await backend.workspace!.create!({ name: 'Meadow Fortune', root: '/work/slots2' })
    expect(again.id).toBe('meadow-fortune-2')
    const upd = await backend.workspace!.update!('nrchat', { description: null, model: 'sonnet' })
    expect(upd.description).toBeUndefined()
    expect(upd.project).toMatchObject({ model: 'sonnet' })
    expect(upd.project!.description).toBeUndefined()
    await expect(backend.workspace!.update!('nope', { model: 'x' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(backend.workspace!.update!('nrchat', { root: null } as never)).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('пути с ~ — раскрывает реестр (expand) до проверки', async () => {
    const reg = createMemoryProjects({ root: '/stand' })
    reg.expand = (p) => (p.startsWith('~/') ? `/home/u/${p.slice(2)}` : p)
    const backend = createStoreBackend({ store: createMemoryStore(), generate: recorder().gen, projects: reg })
    const p = await backend.workspace!.create!({ name: 'x', root: '~/w', dirs: ['~/a', '/b'] })
    expect(p.project).toMatchObject({ root: '/home/u/w', dirs: ['/home/u/a', '/b'] })
    expect((await backend.workspace!.update!('x', { context: '~/ctx' })).project?.context).toBe('/home/u/ctx')
  })

  it('реестр без create/update — capability edit нет, методов нет', async () => {
    const { backend } = backendWith(false)
    expect((await backend.capabilities()).workspace?.edit).toBeUndefined()
    expect(backend.workspace!.create).toBeUndefined()
  })

  it('провод: ?workspace=, POST /workspaces, PATCH /workspaces/:id', async () => {
    const { backend } = backendWith()
    srv = await serveBackend(backend, { port: 0 })
    client = createHttpBackend(srv.url)
    const n = await client.sessions.create({ workspace: 'nrchat' })
    await client.sessions.create()
    expect((await client.sessions.list({ workspace: 'nrchat' })).map((s) => s.id)).toEqual([n.id])
    expect((await client.sessions.list()).length).toBe(2)
    const p = await client.workspace!.create!({ name: 'slots', root: '/work/slots' })
    expect(p).toMatchObject({ id: 'slots', kind: 'project' })
    expect((await client.workspace!.list()).map((w) => w.id)).toEqual(['default', 'nrchat', 'slots'])
    expect(await client.workspace!.update!('slots', { description: 'слоты' })).toMatchObject({ description: 'слоты' })
    await expect(client.workspace!.create!({ name: 'x', root: 'rel' })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(client.sessions.create({ workspace: 'nope' })).rejects.toMatchObject({ code: 'not_found' })
  })
})
