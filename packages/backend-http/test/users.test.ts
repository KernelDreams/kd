/**
 * Пользователи стенда (users-spec §2–5, протокол v1.30): вход по ссылке, Access
 * JWT, локальный owner; проекты по `$members`, приватные сессии, граница ACP —
 * в сервере, по HTTP (как ходит фронт).
 */

import { createSign, createVerify, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNrChatStore } from '@kerneldreams/chat-store/nr-chat'
import type { Capabilities, SessionInfo, UserLink, WorkspaceInfo } from '@kerneldreams/ui-protocol'
import { createStoreBackend, type GenerateRequest } from '../src/store-backend.js'
import { createMemoryProjects, type ProjectEntry } from '../src/projects.js'
import { createMemoryFiles } from '../src/memory-files.js'
import { serveBackend } from '../src/serve.js'
import { createHttpBackend } from '../src/client.js'
import { createHub } from '../src/hub.js'
import { createUsersGate } from '../src/gate.js'
import { createMemoryUsers, type UserRecord } from '../src/users.js'
import type { AccessVerifier } from '../src/access.js'

const TEAM = 'studio-gate.cloudflareaccess.com'
const AUD = 'aud-dev-tag'
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })

/** Проверяльщик Access для теста: RS256 одним ключом, iss / aud / exp (реализация ядра не везёт — её подаёт хост). */
function testAccess(): AccessVerifier {
  let lastError: string | undefined
  const fail = (why: string): null => ((lastError = why), null)
  return {
    get lastError() {
      return lastError
    },
    async verify(token) {
      const [h, b, sig] = token.split('.')
      if (!h || !b || !sig) return fail('не JWT')
      const head = JSON.parse(Buffer.from(h, 'base64url').toString()) as { kid?: string }
      if (head.kid !== 'k1') return fail(`kid ${head.kid}`)
      if (!createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(sig, 'base64url'))) return fail('подпись')
      const c = JSON.parse(Buffer.from(b, 'base64url').toString()) as { iss?: string; aud?: string[]; exp?: number; email?: string; sub?: string }
      if (c.iss !== `https://${TEAM}`) return fail('iss')
      if (!c.aud?.includes(AUD)) return fail('aud')
      if (!c.exp || c.exp < Date.now() / 1000) return fail('истёк')
      if (!c.email) return fail('нет email')
      lastError = undefined
      return { email: c.email, ...(c.sub ? { sub: c.sub } : {}) }
    },
  }
}

function jwt(claims: Record<string, unknown>, key = privateKey, kid = 'k1'): string {
  const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  const head = enc({ alg: 'RS256', kid, typ: 'JWT' })
  const body = enc({ iss: `https://${TEAM}`, aud: [AUD], exp: Math.floor(Date.now() / 1000) + 600, ...claims })
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key).toString('base64url')
  return `${head}.${body}.${sig}`
}

function engine(name: string, dir: string, projects: ReturnType<typeof createMemoryProjects>) {
  return createStoreBackend({
    store: createNrChatStore({ dir }),
    name,
    models: [{ id: `${name}-model` }],
    profiles: [{ id: 'default', name: 'Default' }],
    generate: async function* (req: GenerateRequest) {
      yield { type: 'text' as const, delta: `${name}: ${req.messages.length}` }
    },
    projects,
  })
}

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  while (closers.length) await closers.pop()!()
})

/** Удалённый клиент (через туннель): заголовок Cloudflare — не локальный. */
const REMOTE = { 'cf-connecting-ip': '203.0.113.7' }

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'users-'))
  const list: ProjectEntry[] = [
    { id: 'nrchat', name: 'nrchat', root, engine: 'acp' } as ProjectEntry,
    { id: 'family', name: 'family', root, members: { test: 'viewer', oscar: 'editor' } } as ProjectEntry,
    { id: 'user-test', name: 'test', root, members: { test: 'owner' } } as ProjectEntry,
    { id: 'user-oscar', name: 'oscar', root, members: { oscar: 'owner' } } as ProjectEntry,
  ]
  const projects = createMemoryProjects({ root, projects: list })
  const nrDir = mkdtempSync(join(tmpdir(), 'users-nr-'))
  const acpDir = mkdtempSync(join(tmpdir(), 'users-acp-'))
  const nr = engine('nr', nrDir, projects)
  const acp = engine('acp', acpDir, projects)
  const acpSrv = await serveBackend(acp, { port: 0 })
  const hub = createHub({ local: nr, localSessionsDir: nrDir, engines: [{ id: 'acp', backend: createHttpBackend(acpSrv.url, { capabilitiesTtl: 0 }), sessionsDir: acpDir }], probeTtlMs: 0, log: () => {} })
  const users: UserRecord[] = [
    { id: 'alice', name: 'владелец', role: 'owner', access: 'owner@example.com' },
    { id: 'oscar', name: 'Оскар', role: 'member' },
  ]
  const registry = createMemoryUsers({ users, stateRoot: mkdtempSync(join(tmpdir(), 'users-state-')) })
  const firstLogin: string[] = []
  const files = new Map<string, ReturnType<typeof createMemoryFiles>>()
  const gate = createUsersGate({
    backend: hub,
    users: registry,
    projects,
    projectFiles: (p) => {
      if (!files.has(p.id)) files.set(p.id, createMemoryFiles({ 'README.md': `# ${p.id}\n` }))
      return Object.assign(files.get(p.id)!, { capability: { write: true, watch: true } })
    },
    access: testAccess(),
    onFirstLogin: (u) => void firstLogin.push(u.id),
    log: () => {},
  })
  const srv = await serveBackend(hub, { port: 0, users: gate })
  closers.push(async () => {
    await srv.close()
    await acpSrv.close()
  })

  /** Запрос к стенду: `as` — кука устройства, `headers` — свои. */
  async function call<T = unknown>(method: string, path: string, o: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
    const res = await fetch(`${srv.url}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.headers ?? {}) },
      ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
    })
    const env = (await res.json().catch(() => null)) as { ok: boolean; result?: T; code?: string; error?: string } | null
    const set = res.headers.get('set-cookie') ?? undefined
    return { status: res.status, env, result: env?.result as T, cookie: set?.split(';')[0] }
  }
  /** Войти по ссылке «в другом браузере» (удалённо). */
  async function redeem(link: UserLink): Promise<{ status: number; cookie?: string }> {
    const r = await call('POST', `/auth/${link.kind}`, { body: { token: link.token }, headers: REMOTE })
    return { status: r.status, ...(r.cookie ? { cookie: r.cookie } : {}) }
  }
  const as = (cookie: string) => ({ cookie, headers: REMOTE })
  return { hub, gate, call, redeem, as, firstLogin, files }
}

describe('пользователи стенда', () => {
  it('без входа — 401; локальный процесс — owner; подделанный email Access без JWT — не owner', async () => {
    const t = await setup()
    expect((await t.call('GET', '/capabilities', { headers: REMOTE })).status).toBe(401)
    const forged = await t.call('GET', '/capabilities', { headers: { ...REMOTE, 'cf-access-authenticated-user-email': 'owner@example.com' } })
    expect(forged.status).toBe(401)
    const local = await t.call<Capabilities>('GET', '/capabilities')
    expect(local.status).toBe(200)
    expect(local.result.users?.me).toMatchObject({ id: 'alice', role: 'owner', via: 'local' })
    expect(local.result.users?.admin).toBe(true)
  })

  it('Access: проверенный JWT — пользователь по email; чужая подпись, чужой aud, истёкший — 401', async () => {
    const t = await setup()
    const ok = await t.call<Capabilities>('GET', '/capabilities', { headers: { ...REMOTE, 'cf-access-jwt-assertion': jwt({ email: 'Owner@Example.com' }) } })
    expect(ok.status).toBe(200)
    expect(ok.result.users?.me).toMatchObject({ id: 'alice', via: 'access' })
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    for (const bad of [jwt({ email: 'owner@example.com' }, other), jwt({ email: 'owner@example.com', aud: ['other-app'] }), jwt({ email: 'owner@example.com', exp: 1000 })]) {
      expect((await t.call('GET', '/capabilities', { headers: { ...REMOTE, 'cf-access-jwt-assertion': bad } })).status).toBe(401)
    }
    expect((await t.call('GET', '/capabilities', { headers: { ...REMOTE, 'cf-access-jwt-assertion': jwt({ email: 'stranger@example.com' }) } })).status).toBe(401)
  })

  it('приглашение: вход по ссылке один раз, личный проект; ссылка входа 24 ч — один раз; отозвать устройство — 401', async () => {
    const t = await setup()
    const made = await t.call<{ user: { id: string; engines: string[] }; link: UserLink }>('POST', '/auth/users', { body: { id: 'test', name: 'Тест', role: 'member', engines: ['nr'] } })
    expect(made.status).toBe(200)
    expect(made.result.link.path).toMatch(/^#\/join\//)
    expect(made.result.user.engines).toEqual(['nr'])

    const first = await t.redeem(made.result.link)
    expect(first.status).toBe(200)
    expect(first.cookie).toMatch(/^nrchat_device=/)
    expect(t.firstLogin).toEqual(['test'])
    expect((await t.redeem(made.result.link)).status).toBe(401)

    const caps = await t.call<Capabilities>('GET', '/capabilities', t.as(first.cookie!))
    expect(caps.result.users?.me).toMatchObject({ id: 'test', role: 'member', via: 'link' })
    expect(caps.result.users?.admin).toBeUndefined()

    const login = await t.call<UserLink>('POST', '/auth/users/test/login-link')
    const second = await t.redeem(login.result)
    expect(second.status).toBe(200)
    expect((await t.redeem(login.result)).status).toBe(401)

    const devices = await t.call<Array<{ id: string }>>('GET', '/auth/users/test/devices')
    expect(devices.result).toHaveLength(2)
    const dev = second.cookie!.split('.')[1]!
    expect((await t.call('DELETE', `/auth/users/test/devices/${dev}`)).status).toBe(200)
    const revoked = await t.call('GET', '/capabilities', t.as(second.cookie!))
    expect(revoked.status).toBe(401)
    expect(revoked.cookie).toBe('nrchat_device=')
    expect((await t.call('GET', '/capabilities', t.as(first.cookie!))).status).toBe(200)
    // member — не админ.
    expect((await t.call('GET', '/auth/users', t.as(first.cookie!))).status).toBe(403)
  })

  it('member: проекты из $members и личный, ACP нет в движках и 403 на ACP-сессию, сессии приватны', async () => {
    const t = await setup()
    const test = (await t.redeem((await t.call<{ link: UserLink }>('POST', '/auth/users', { body: { id: 'test', role: 'member' } })).result.link)).cookie!
    const olenaLink = await t.call<UserLink>('POST', '/auth/users/oscar/invite')
    const oscar = (await t.redeem(olenaLink.result)).cookie!

    const ws = await t.call<WorkspaceInfo[]>('GET', '/workspaces', t.as(test))
    expect(ws.result.map((w) => [w.id, w.role])).toEqual([
      ['family', 'viewer'],
      ['user-test', 'owner'],
    ])
    expect((await t.call('POST', '/workspace', { ...t.as(test), body: { id: 'nrchat' } })).status).toBe(403)
    const caps = await t.call<Capabilities>('GET', '/capabilities', t.as(test))
    expect(caps.result.engines?.list.map((e) => e.id)).toEqual(['nr'])
    expect(caps.result.workspace?.edit).toBeUndefined()

    // Сессия test: в личном проекте, на nr, автор — test.
    const mine = await t.call<SessionInfo>('POST', '/sessions', { ...t.as(test), body: {} })
    expect(mine.status).toBe(200)
    expect(mine.result).toMatchObject({ owner: 'test', engine: 'nr', workspace: 'user-test' })
    expect((await t.call('POST', '/sessions', { ...t.as(test), body: { engine: 'acp' } })).status).toBe(403)

    // ACP-сессия owner стенда: test не видит и не пишет.
    const acpSession = await t.call<SessionInfo>('POST', '/sessions', { body: { workspace: 'nrchat' } })
    expect(acpSession.result.engine).toBe('acp')
    expect((await t.call('POST', `/sessions/${acpSession.result.id}/run`, { ...t.as(test), body: { userMessage: 'привет' } })).status).toBe(403)
    expect((await t.call('GET', `/sessions/${acpSession.result.id}/history`, t.as(test))).status).toBe(403)
    // Расшарена ему — читать можно, ход нельзя (ACP вне его движков).
    await t.call('POST', `/sessions/${acpSession.result.id}/share`, { body: { share: { users: ['test'], write: true } } })
    expect((await t.call('GET', `/sessions/${acpSession.result.id}/history`, t.as(test))).status).toBe(200)
    expect((await t.call('POST', `/sessions/${acpSession.result.id}/run`, { ...t.as(test), body: { userMessage: 'привет' } })).status).toBe(403)

    // Приватность: oscar не видит сессию test; owner — только в режиме «все пользователи».
    const olenaList = await t.call<SessionInfo[]>('GET', '/sessions', t.as(oscar))
    expect(olenaList.result.map((s) => s.id)).not.toContain(mine.result.id)
    expect((await t.call('GET', `/sessions/${mine.result.id}/history`, t.as(oscar))).status).toBe(403)
    const ownerList = await t.call<SessionInfo[]>('GET', '/sessions')
    expect(ownerList.result.map((s) => s.id)).not.toContain(mine.result.id)
    const all = await t.call<SessionInfo[]>('GET', '/sessions?all=1')
    expect(all.result.find((s) => s.id === mine.result.id)?.owner).toBe('test')
    // member просит all — получает своё.
    const testAll = await t.call<SessionInfo[]>('GET', '/sessions?all=1', t.as(test))
    expect(testAll.result.map((s) => s.id).sort()).toEqual([acpSession.result.id, mine.result.id].sort())

    // Автора не подделать метой.
    await t.call('PATCH', `/sessions/${mine.result.id}`, { ...t.as(test), body: { meta: { owner: 'alice' } } })
    expect((await t.call<SessionInfo>('GET', `/sessions/${mine.result.id}`, t.as(test))).result.owner).toBe('test')
  })

  it('member: файлы проекта по роли — viewer только читает', async () => {
    const t = await setup()
    const test = (await t.redeem((await t.call<{ link: UserLink }>('POST', '/auth/users', { body: { id: 'test', role: 'member' } })).result.link)).cookie!
    // Личный проект (owner) — запись можно.
    expect((await t.call('PUT', '/workspace/file', { ...t.as(test), body: { path: 'a.md', content: 'x' } })).status).toBe(200)
    expect((await t.call('POST', '/workspace', { ...t.as(test), body: { id: 'family' } })).status).toBe(200)
    expect((await t.call('GET', '/workspace/file?path=README.md', t.as(test))).status).toBe(200)
    expect((await t.call('PUT', '/workspace/file', { ...t.as(test), body: { path: 'b.md', content: 'x' } })).status).toBe(403)
    const caps = await t.call<Capabilities>('GET', '/capabilities', t.as(test))
    expect(caps.result.workspace?.files?.write).toBe(false)
    // Процесс owner не переключился.
    const ownerWs = await t.call<WorkspaceInfo>('GET', '/workspace')
    expect(ownerWs.result.id).toBe('default')
    // ?workspace= (v1.33): проект вкладки — та же роль; чужой — 403.
    expect((await t.call('POST', '/workspace', { ...t.as(test), body: { id: 'user-test' } })).status).toBe(200)
    expect((await t.call('GET', '/workspace/file?path=README.md&workspace=family', t.as(test))).status).toBe(200)
    expect((await t.call('PUT', '/workspace/file?workspace=family', { ...t.as(test), body: { path: 'c.md', content: 'x' } })).status).toBe(403)
    expect((await t.call('PUT', '/workspace/file?workspace=user-test', { ...t.as(test), body: { path: 'c.md', content: 'x' } })).status).toBe(200)
    expect((await t.call('GET', '/workspace/files?workspace=default', t.as(test))).status).toBe(403)
  })
})
