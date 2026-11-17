import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config.js'
import { startServer, type McpServer } from '../src/server.js'
import { VERSION } from '../src/version.js'

const TOKEN = 'test-token-1'
const CONNECTOR = 'test-connector-secret-0123456789abcdef'
let base: string
let root: string
let srv: McpServer

const auth = { authorization: `Bearer ${TOKEN}` }

async function rpc(method: string, params: unknown = {}, headers: Record<string, string> = auth): Promise<{ status: number; body: any; session: string | null }> {
  const r = await fetch(`${srv.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return { status: r.status, body: r.status === 200 ? await r.json() : null, session: r.headers.get('mcp-session-id') }
}

const call = async (name: string, args: Record<string, unknown>) => (await rpc('tools/call', { name, arguments: args })).body.result as { content: Array<{ type: string; text: string }>; isError?: boolean }

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'nr-mcp-')))
  root = join(base, 'root')
  mkdirSync(join(root, 'sub'), { recursive: true })
  writeFileSync(join(root, 'sub', 'a.txt'), 'hello needle\n')
  writeFileSync(join(base, 'secret.txt'), 'outside\n')
  const cfg = parseConfig(`$name: testbox\n$token: ${TOKEN}\n$roots: [${root}]\n$deny: [shutdown*]\n$connector: ${CONNECTOR}\n`)
  srv = await startServer(cfg, { port: 0, runz: false, log: () => {} })
})

afterAll(async () => {
  await srv?.close()
  rmSync(base, { recursive: true, force: true })
})

describe('nr-mcp', () => {
  it('версия в коде = package.json', () => {
    expect(VERSION).toBe(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
  })

  it('/health без токена: имя, платформа, тулы; runz нет', async () => {
    const h = await (await fetch(`${srv.url}/health`)).json()
    expect(h).toMatchObject({ ok: true, host: 'testbox', platform: process.platform, arch: process.arch, version: VERSION })
    expect(h.tools).toEqual(expect.arrayContaining(['read', 'ls', 'find', 'grep', 'write', 'edit', 'apply_patch', 'exec', 'process']))
    expect(h.tools).not.toContain('runz_list')
  })

  it('/mcp без токена и с токеном в query — 401', async () => {
    expect((await rpc('ping', {}, {})).status).toBe(401)
    const r = await fetch(`${srv.url}/mcp?token=${TOKEN}`, { method: 'POST', body: '{}' })
    expect(r.status).toBe(401)
  })

  it('коннектор: /c/<секрет>/mcp без заголовков, чужой секрет — 404, короткий — ошибка конфига', async () => {
    const post = (path: string) => fetch(`${srv.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    const ok = await post(`/c/${CONNECTOR}/mcp`)
    expect(ok.status).toBe(200)
    expect((await ok.json()).result.tools.map((t: { name: string }) => t.name)).toContain('exec')
    expect((await post(`/c/${CONNECTOR}x/mcp`)).status).toBe(404)
    expect((await post('/c//mcp')).status).toBe(404)
    expect(() => parseConfig(`$token: t\n$connector: short\n`)).toThrow(/32/)
  })

  it('initialize даёт сессию, tools/list — набор', async () => {
    const i = await rpc('initialize', { protocolVersion: '2025-06-18' })
    expect(i.body.result.serverInfo.name).toBe('nr-mcp')
    expect(i.session).toBeTruthy()
    const l = await rpc('tools/list')
    expect(l.body.result.tools.map((t: { name: string }) => t.name)).toContain('exec')
  })

  it('exec uname и grep по корню', async () => {
    const u = await call('exec', { command: 'uname' })
    expect(u.isError).toBeFalsy()
    expect(u.content[0]!.text).toMatch(process.platform === 'darwin' ? /Darwin/ : /Linux/)
    const g = await call('grep', { pattern: 'needle', path: root })
    expect(g.isError).toBeFalsy()
    expect(g.content[0]!.text).toContain('a.txt')
  })

  it('вне корня — isError, сервер жив', async () => {
    const r = await call('read', { path: join(base, 'secret.txt') })
    expect(r.isError).toBe(true)
    expect(r.content[0]!.text).toMatch(/outside the roots/)
    const w = await call('exec', { command: 'pwd', workdir: base })
    expect(w.isError).toBe(true)
    // симлинк из корня наружу — тоже выход
    const { symlinkSync } = await import('node:fs')
    symlinkSync(base, join(root, 'up'))
    const s = await call('read', { path: join(root, 'up', 'secret.txt') })
    expect(s.isError).toBe(true)
    expect((await fetch(`${srv.url}/health`)).status).toBe(200)
  })

  it('$deny — отказ без запуска; неизвестный тул — isError', async () => {
    const d = await call('exec', { command: 'shutdown -h now' })
    expect(d.isError).toBe(true)
    expect(d.content[0]!.text).toMatch(/deny/)
    const n = await call('nope', {})
    expect(n.isError).toBe(true)
  })

  it('write и read внутри корня', async () => {
    const w = await call('write', { path: join(root, 'sub', 'b.txt'), content: 'xyz' })
    expect(w.isError).toBeFalsy()
    expect(readFileSync(join(root, 'sub', 'b.txt'), 'utf8')).toBe('xyz')
  })

  it('/agent: SSE hello с сессией, POST — операции, слежение, корни', async () => {
    const ac = new AbortController()
    const r = await fetch(`${srv.url}/agent`, { headers: auth, signal: ac.signal })
    expect(r.headers.get('content-type')).toMatch(/event-stream/)
    const reader = r.body!.getReader()
    const dec = new TextDecoder()
    let buf = ''
    const msgs: any[] = []
    const next = async (pred: (m: any) => boolean): Promise<any> => {
      for (;;) {
        const hit = msgs.find(pred)
        if (hit) return hit
        const { value, done } = await reader.read()
        if (done) throw new Error('поток закрыт')
        buf += dec.decode(value, { stream: true })
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const ev = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const data = ev.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n')
          if (data) msgs.push(JSON.parse(data))
        }
      }
    }
    const hello = await next((m) => m.event === 'hello')
    expect(hello.session).toBeTruthy()
    expect(hello.roots).toEqual([root])
    const op = async (id: number, o: string, args: unknown) => (await fetch(`${srv.url}/agent/${hello.session}`, { method: 'POST', headers: auth, body: JSON.stringify({ id, op: o, args }) })).json()
    expect((await op(1, 'init', { deny: [] })).ok).toBe(true)
    const ls = await op(2, 'list', { path: join(root, 'sub') })
    expect(ls.result.map((e: { name: string }) => e.name)).toContain('a.txt')
    const out = await op(3, 'read', { path: join(base, 'secret.txt') })
    expect(out).toMatchObject({ ok: false, code: 'forbidden' })
    const w = await op(4, 'watch', { path: join(root, 'sub') })
    expect(w.ok).toBe(true)
    await new Promise((res) => setTimeout(res, 300))
    writeFileSync(join(root, 'sub', 'c.txt'), '1')
    const upd = await next((m) => m.event === 'update')
    expect(upd.watch).toBe(w.result.watch)
    ac.abort()
    expect((await fetch(`${srv.url}/agent/${hello.session}`, { method: 'POST', headers: { ...auth }, body: '{"op":"ping"}' })).status).toBeGreaterThanOrEqual(200)
  })
})

describe('тулы сервисов хаба ($hub, ABC-511)', () => {
  it('список и вызов идут в сервис хаба; конфиг $hub / $hub_services', async () => {
    const { loadHubTools } = await import('../src/hub.js')
    const { parseConfig } = await import('../src/config.js')
    const calls: Array<{ url: string; body: unknown }> = []
    const fake = (async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body)
      calls.push({ url, body })
      const result = url.endsWith('/tools') ? [{ name: 'archive_search', description: 'поиск', schema: { type: 'object' } }] : { text: `нашёл: ${body.args.args.query}` }
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 })
    }) as unknown as typeof fetch
    const tools = await loadHubTools({ url: 'http://hub/api/', services: ['archive'], fetch: fake })
    expect(tools.map((t) => t.name)).toEqual(['archive_search'])
    const r = await tools[0]!.execute({ query: 'мит' }, { sessionId: 's1', callId: 'c', signal: new AbortController().signal } as never)
    expect(r).toEqual({ text: 'нашёл: мит' })
    expect(calls[1]).toEqual({ url: 'http://hub/api/services/archive/tool', body: { args: { name: 'archive_search', args: { query: 'мит' }, session: { id: 'mcp:s1' } } } })
    const cfg = parseConfig('$token: t\n$hub: http://127.0.0.1:7800/api\n', '/h')
    expect(cfg.hub).toEqual({ url: 'http://127.0.0.1:7800/api', services: ['archive'] })
  })
})
