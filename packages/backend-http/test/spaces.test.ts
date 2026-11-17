/**
 * Пространства и проекты (протокол v1.35, spaces-spec §1–4): проекты по
 * маскам `$projects`, контекст-пакет, `$aliases`, сессия с проектом и скиллами
 * старта — cwd, пометка, префикс генерации.
 */

import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import type { AnyRunEvent } from '@kerneldreams/ui-protocol'
import { createStoreBackend, type GenerateFn, type GenerateRequest } from '../src/store-backend.js'
import { createMemoryProjects, type ProjectEntry } from '../src/projects.js'
import { createRepos, listRepos, repoPrefix } from '../src/repos.js'
import { serveBackend } from '../src/serve.js'
import { createHttpBackend } from '../src/client.js'

const T = mkdtempSync(join(tmpdir(), 'spaces-'))
afterAll(() => rmSync(T, { recursive: true, force: true }))

const w = (p: string, text = ''): void => {
  mkdirSync(join(T, p, '..'), { recursive: true })
  writeFileSync(join(T, p), text)
}
// acme/projects/{alpha,beta} + alpha.dev (пакет рядом), beta/beta.dev внутри; twin-jester — SKILL.md в корне.
w('acme/projects/alpha/README.md')
w('acme/projects/alpha.dev/SKILL.md', 'ALPHA SKILL')
w('acme/projects/alpha.dev/HANDOFF.md', 'ALPHA HANDOFF')
w('acme/projects/beta/beta.dev/SKILL.md', 'BETA SKILL')
w('acme/projects/.hidden/x')
w('acme/projects/stuff.skills/x')
w('Projects/twin-jester/SKILL.md', 'TJ SKILL')
w('Projects/meadow/.nrchat/project.mdz', '$files: $[notes.md]\n$agent: slots-math\n$skills: $[use-gamekit]\n')
w('Projects/meadow/notes.md', 'MEADOW NOTES')
w('other/alpha/x')
w('skills/use-gamekit/SKILL.md', 'GAMEKIT')

const SLOT: ProjectEntry = {
  id: 'slot',
  name: 'SLOT',
  root: join(T, 'acme'),
  projektor: 'SLOT',
  projects: [join(T, 'acme/projects/*'), join(T, 'Projects/twin-jester'), join(T, 'Projects/meadow')],
  aliases: ['twin-jester', 'acme'],
}
const OLD_TJ: ProjectEntry = { id: 'twin-jester', name: 'twin-jester', root: join(T, 'Projects/twin-jester') }

describe('проекты по маскам', () => {
  it('маска * — каталоги без *.dev, *.skills, скрытых; контекст-пакет рядом, внутри, SKILL.md в корне', () => {
    const list = listRepos(SLOT)
    expect(list.map((r) => r.id)).toEqual(['alpha', 'beta', 'twin-jester', 'meadow'])
    const [alpha, beta, tj, meadow] = list
    expect(alpha).toMatchObject({ root: join(T, 'acme/projects/alpha'), context: join(T, 'acme/projects/alpha.dev') })
    expect(alpha!.files).toEqual([join(T, 'acme/projects/alpha.dev/SKILL.md'), join(T, 'acme/projects/alpha.dev/HANDOFF.md')])
    expect(beta!.files).toEqual([join(T, 'acme/projects/beta/beta.dev/SKILL.md')])
    expect(tj).toMatchObject({ context: join(T, 'Projects/twin-jester'), files: [join(T, 'Projects/twin-jester/SKILL.md')] })
    expect(meadow).toMatchObject({ files: [join(T, 'Projects/meadow/notes.md')], agent: 'slots-math', skills: ['use-gamekit'] })
  })

  it('конфликт имён — <родитель>/<имя>', () => {
    const ids = listRepos({ projects: [join(T, 'acme/projects/*'), join(T, 'other/*')] }).map((r) => r.id)
    expect(ids).toContain('projects/alpha')
    expect(ids).toContain('other/alpha')
  })

  it('кэш: новый каталог под маской виден без рестарта', () => {
    const repos = createRepos()
    const space = { ...SLOT, id: 'cache', projects: [join(T, 'cache/*')] }
    mkdirSync(join(T, 'cache/one'), { recursive: true })
    expect(repos.list(space).map((r) => r.id)).toEqual(['one'])
    mkdirSync(join(T, 'cache/two'))
    expect(repos.list(space).map((r) => r.id)).toEqual(['one', 'two'])
  })

  it('префикс: проект, затем скиллы; пропавший скилл — в missing', async () => {
    const alpha = listRepos(SLOT)[0]!
    const got = await repoPrefix(alpha, ['use-gamekit', 'nope'], createRepos().readText, async () => [{ name: 'use-gamekit', dir: join(T, 'skills/use-gamekit') }])
    expect(got.blocks.map((b) => b.source)).toEqual(['project', 'skill:use-gamekit'])
    expect(got.blocks[0]!.text).toContain(`Проект alpha (${join(T, 'acme/projects/alpha')})`)
    expect(got.blocks[0]!.text).toContain('ALPHA SKILL')
    expect(got.blocks[0]!.text.indexOf('ALPHA SKILL')).toBeLessThan(got.blocks[0]!.text.indexOf('ALPHA HANDOFF'))
    expect(got.missing).toEqual(['nope'])
  })
})

function backendWith() {
  const seen: GenerateRequest[] = []
  const gen: GenerateFn = async function* (req) {
    seen.push(req)
    yield { type: 'text', text: 'ok' }
  }
  const store = createMemoryStore()
  const backend = createStoreBackend({
    store,
    generate: gen,
    sessionCwd: true,
    projects: createMemoryProjects({ root: T, projects: [SLOT, OLD_TJ] }),
    repos: createRepos(),
    skillDir: async (names) => names.filter((n) => n === 'use-gamekit').map((name) => ({ name, dir: join(T, 'skills', name) })),
  })
  return { backend, seen, store }
}

async function drain(it: AsyncIterable<AnyRunEvent>): Promise<void> {
  for await (const _ of it) void _
}

describe('пространство: store-бэкенд', () => {
  it('capability repos; запись-алиас — hidden; repos по пространству', async () => {
    const { backend } = backendWith()
    expect((await backend.capabilities()).workspace?.repos).toBe(true)
    const list = await backend.workspace!.list()
    expect(list.find((x) => x.id === 'twin-jester')?.hidden).toBe(true)
    expect(list.find((x) => x.id === 'slot')?.hidden).toBeUndefined()
    expect(list.find((x) => x.id === 'slot')?.project?.projektor).toBe('SLOT')
    expect((await backend.workspace!.repos!({ workspace: 'slot' })).map((r) => r.id)).toEqual(['alpha', 'beta', 'twin-jester', 'meadow'])
  })

  it('сессия с проектом и скиллом: cwd — корень, пометка, skills в мете, префикс в генерации', async () => {
    const { backend, seen } = backendWith()
    const s = await backend.sessions.create({ workspace: 'slot', project: 'alpha', skills: ['use-gamekit'] })
    expect(s).toMatchObject({ workspace: 'slot', project: 'alpha' })
    const meta = await backend.meta!.get(s.id)
    expect(meta.workspace?.cwd).toBe(join(T, 'acme/projects/alpha'))
    expect(meta.skills).toEqual(['use-gamekit'])
    await drain(backend.run(s.id, { message: { parts: [{ type: 'text', text: 'hi' }] } }))
    expect(seen[0]!.prefix?.map((b) => b.source)).toEqual(['project', 'skill:use-gamekit'])
    expect(seen[0]!.repo?.id).toBe('alpha')
    expect(seen[0]!.cwd).toBe(join(T, 'acme/projects/alpha'))
  })

  it('скиллы сессии v1.59: loaded — в префикс, linked — в generate, capability skills.session', async () => {
    const { backend, seen } = backendWith()
    expect((await backend.capabilities()).skills?.session).toBe(true)
    const s = await backend.sessions.create({ workspace: 'slot' })
    await backend.meta!.patch(s.id, { skills: [{ name: 'use-gamekit', mode: 'loaded' }, { name: 'runz', mode: 'linked', source: 'skillbox' }] })
    await drain(backend.run(s.id, { message: { parts: [{ type: 'text', text: 'hi' }] } }))
    expect(seen[0]!.prefix?.map((b) => b.source)).toEqual(['skill:use-gamekit'])
    expect(seen[0]!.skills).toEqual(['runz'])
  })

  it('скиллы сессии: патч одного ключа skills посреди рана — не busy, прочее — busy', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const store = createMemoryStore()
    const backend = createStoreBackend({
      store,
      generate: async function* () {
        await gate
        yield { type: 'text', text: 'ok' }
      },
      skillDir: async () => [],
    })
    const s = await backend.sessions.create({})
    const run = drain(backend.run(s.id, { message: { parts: [{ type: 'text', text: 'hi' }] } }))
    await new Promise((r) => setTimeout(r, 20))
    await expect(backend.meta!.patch(s.id, { skills: [{ name: 'x', mode: 'linked' }] })).resolves.toMatchObject({ skills: [{ name: 'x', mode: 'linked' }] })
    await expect(backend.meta!.patch(s.id, { notes: 'n' } as never)).rejects.toMatchObject({ code: 'busy' })
    release()
    await run
  })

  it('неизвестный проект — not_found до создания', async () => {
    const { backend } = backendWith()
    await expect(backend.sessions.create({ workspace: 'slot', project: 'nope' })).rejects.toMatchObject({ code: 'not_found' })
    expect(await backend.sessions.list()).toEqual([])
  })

  it('$aliases: старая сессия twin-jester видна в SLOT с проектом twin-jester', async () => {
    const { backend } = backendWith()
    const old = await backend.sessions.create({ workspace: 'twin-jester' })
    const own = await backend.sessions.create({ workspace: 'slot', project: 'beta' })
    const inSlot = await backend.sessions.list({ workspace: 'slot' })
    expect(inSlot.map((x) => x.id).sort()).toEqual([old.id, own.id].sort())
    expect(inSlot.find((x) => x.id === old.id)?.project).toBe('twin-jester')
    expect(inSlot.find((x) => x.id === own.id)?.project).toBe('beta')
    // Без workspace («Недавние») — у сессии алиаса проект дописан тоже.
    expect((await backend.sessions.list()).find((x) => x.id === old.id)?.project).toBe('twin-jester')
  })

  it('провод: GET /workspace/repos, create с project/skills', async () => {
    const { backend } = backendWith()
    const srv = await serveBackend(backend, { port: 0 })
    const client = createHttpBackend(srv.url)
    try {
      expect((await client.workspace!.repos!({ workspace: 'slot' })).map((r) => r.id)).toContain('meadow')
      const s = await client.sessions.create({ workspace: 'slot', project: 'meadow', skills: ['use-gamekit'] })
      expect(s.project).toBe('meadow')
    } finally {
      await client.close?.()
      await srv.close()
    }
  })
})
