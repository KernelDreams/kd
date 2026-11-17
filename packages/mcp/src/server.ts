/**
 * HTTP-сервер машины (board-edge-spec §3):
 *
 *   GET  /health          {ok, host, platform, arch, version, tools[]} — без токена
 *   POST /mcp             MCP Streamable HTTP (ответ JSON); GET /mcp — 405, DELETE /mcp — конец сессии
 *   GET  /agent           установленный nr-host-agent для хаба: SSE, первое событие — `hello` с `session`,
 *                         дальше `update` слежения; закрыл поток — сессия снята
 *   POST /agent/<session> запрос агента `{id, op, args}` → ответ `{id, ok, result | error, code}`
 *
 *   POST /c/<секрет>/mcp  тот же MCP для коннектора claude.ai (он не умеет заголовки): секрет пути — `$connector`
 *                         конфига, нет — маршрута нет; снаружи путь `/c/` идёт мимо Access (bypass-приложение)
 *
 * Токен — только `Authorization: Bearer`; в query не читается. Секрет пути в лог не пишется. Ошибки не роняют процесс.
 */

import { createAgent, type AgentSession } from '@kerneldreams/host-agent/embed'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { arch, platform } from 'node:os'
import type { McpConfig } from './config.js'
import { handleRpc, rpcError, type Rpc } from './mcp.js'
import { attachChildren } from './children.js'
import { attachHubTools } from './hub.js'
import { createMachineTools, type MachineToolsOptions } from './tools.js'
import { VERSION } from './version.js'
import { createWatchThread } from './watch.js'

export interface StartOptions extends MachineToolsOptions {
  log?: (line: string) => void
  /** Порт вместо `$port` (тесты: 0 — свободный). */
  port?: number
  /** Пинг SSE агента, мс; default 15 000. */
  keepaliveMs?: number
}

export interface McpServer {
  port: number
  url: string
  tools: string[]
  close(): Promise<void>
}

function sameToken(got: string | undefined, want: string): boolean {
  const a = Buffer.from(got ?? '')
  const b = Buffer.from(`Bearer ${want}`)
  return a.length === b.length && timingSafeEqual(a, b)
}

function samePath(got: string, want: string | undefined): boolean {
  if (!want) return false
  const a = Buffer.from(got)
  const b = Buffer.from(want)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** URL для лога: секрет пути коннектора — звёздочками. */
const safeUrl = (url: string | undefined): string => (url ?? '/').replace(/^\/c\/[^/?]+/, '/c/***')

function readBody(req: IncomingMessage, max = 64 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > max) {
        reject(new Error('request body too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

export async function startServer(cfg: McpConfig, opts: StartOptions = {}): Promise<McpServer> {
  const log = opts.log ?? ((line: string) => console.error(`[nr-mcp] ${line}`))
  const machine = createMachineTools(cfg, opts)
  const host = { name: cfg.name, version: VERSION, tools: machine.tools, guard: machine.guard, log }
  const watcher = createWatchThread({ log })
  const agents = new Map<string, { agent: AgentSession; res: ServerResponse }>()
  const keepaliveMs = opts.keepaliveMs ?? 15_000
  const health = () => ({ ok: true, host: cfg.name, platform: platform(), arch: arch(), version: VERSION, tools: machine.tools.map((t) => t.name) })
  // Тулы сервисов хаба nrchat: подгружаются в тот же список, хаб лёг — повтор.
  const stopHub = cfg.hub ? attachHubTools(machine.tools, cfg.hub, log) : () => {}
  // Дочерние MCP-серверы: права macOS — от nr-mcp, тулы — в тот же список.
  const stopChildren = cfg.children.length ? attachChildren(machine.tools, cfg.children, log) : () => {}

  const send = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void => {
    if (res.writableEnded || res.destroyed) return
    if (body === undefined) res.writeHead(status, headers).end()
    else res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body))
  }

  async function mcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') return send(res, 405, undefined, { allow: 'POST, DELETE' })
    const sid = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined
    if (req.method === 'DELETE') {
      if (sid) machine.processes.killSession(sid)
      return send(res, 200)
    }
    if (req.method !== 'POST') return send(res, 405, undefined, { allow: 'POST, DELETE' })
    const ac = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) ac.abort(new Error('HTTP request closed'))
    })
    let body: unknown
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return send(res, 400, rpcError(null, -32700, 'parse error'))
    }
    const msgs = Array.isArray(body) ? body : [body]
    const initializing = msgs.some((m) => m && typeof m === 'object' && (m as Rpc).method === 'initialize')
    const session = sid ?? (initializing ? randomUUID() : 'mcp')
    const headers: Record<string, string> = initializing && !sid ? { 'mcp-session-id': session } : {}
    const one = (m: unknown): Promise<Record<string, unknown> | undefined> =>
      m && typeof m === 'object' && !Array.isArray(m) ? handleRpc(host, m as Rpc, { session, signal: ac.signal }) : Promise.resolve(rpcError(null, -32600, 'invalid request'))
    const out = (await Promise.all(msgs.map(one))).filter((x): x is Record<string, unknown> => !!x)
    if (!out.length) return send(res, 202, undefined, headers)
    return send(res, 200, Array.isArray(body) ? out : out[0], headers)
  }

  function agentStream(res: ServerResponse): void {
    const session = randomUUID()
    const write = (msg: unknown): void => {
      if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(msg)}\n\n`)
    }
    const agent = createAgent({ roots: cfg.roots, emit: write, watchDir: watcher.watchDir })
    agents.set(session, { agent, res })
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' })
    write({ ...agent.hello, session, host: cfg.name })
    const ping = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), keepaliveMs)
    ping.unref?.()
    res.on('close', () => {
      clearInterval(ping)
      agents.delete(session)
      agent.close()
    })
  }

  async function agentCall(req: IncomingMessage, res: ServerResponse, session: string): Promise<void> {
    const a = agents.get(session)
    if (!a) return send(res, 404, { ok: false, error: 'no agent session', code: 'not_found' })
    let msg: { id?: number; op?: string; args?: Record<string, unknown> }
    try {
      msg = JSON.parse(await readBody(req))
    } catch {
      return send(res, 400, { ok: false, error: 'bad json', code: 'bad_request' })
    }
    send(res, 200, await a.agent.call({ ...msg, op: String(msg.op ?? '') }))
  }

  const srv: Server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0]!
      if (path === '/health' && req.method === 'GET') return send(res, 200, health())
      const authed = sameToken(req.headers.authorization, cfg.token)
      if (path === '/mcp') return authed ? mcp(req, res) : send(res, 401, { error: 'unauthorized' })
      const c = /^\/c\/([^/]+)\/mcp$/.exec(path)
      if (c) return samePath(c[1]!, cfg.connector) ? mcp(req, res) : send(res, 404, { error: 'not_found' })
      if (path === '/agent' && req.method === 'GET') return authed ? agentStream(res) : send(res, 401, { error: 'unauthorized' })
      const m = /^\/agent\/([\w-]+)$/.exec(path)
      if (m && req.method === 'POST') return authed ? agentCall(req, res, m[1]!) : send(res, 401, { error: 'unauthorized' })
      return send(res, 404, { error: 'not_found' })
    })().catch((err) => {
      log(`${req.method} ${safeUrl(req.url)}: ${err instanceof Error ? err.message : String(err)}`)
      send(res, 500, { error: 'internal' })
    })
  })
  srv.requestTimeout = 0
  srv.headersTimeout = 60_000
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject)
    srv.listen(opts.port ?? cfg.port, cfg.listen, () => {
      srv.off('error', reject)
      resolve()
    })
  })
  const port = (srv.address() as AddressInfo).port
  log(`${cfg.name}: http://${cfg.listen}:${port} · корни ${machine.guard.roots.join(', ')} · тулы ${machine.tools.map((t) => t.name).join(', ')}${cfg.connector ? ' · коннектор /c/***/mcp' : ''}`)
  return {
    port,
    url: `http://${cfg.listen === '0.0.0.0' ? '127.0.0.1' : cfg.listen}:${port}`,
    tools: machine.tools.map((t) => t.name),
    async close() {
      stopHub()
      stopChildren()
      for (const [, a] of agents) a.res.end()
      machine.processes.killAll()
      await watcher.close()
      await new Promise<void>((resolve) => {
        srv.closeAllConnections?.()
        srv.close(() => resolve())
      })
    },
  }
}
