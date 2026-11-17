/**
 * HTTP центра пула (compute-pool-spec §2): только tailnet (`https://pool.nr`
 * через Caddy), у каждой машины свой ключ (`$pool_keys`). Ключ в логи не
 * пишется. Тот же {@link PoolClient}, что у воркера в одном процессе с центром.
 *
 * ```
 * POST /v1/heartbeat        WorkerState → HeartbeatReply
 * POST /v1/claim?wait=ms    WorkerState → Assignment | 204
 * POST /v1/log              {id, lease, lines}
 * POST /v1/finish           tar.gz папки прогона, отчёт — заголовок x-pool-report (base64url JSON)
 * POST /v1/return           {id, lease, reason}
 * GET  /v1/pkg/<sha>        tar.gz пакета
 * GET  /v1/workers          машины пула
 * POST /v1/pause            {name, on}
 * ```
 */

import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Center, FinishReport, LogLine } from './center.js'
import type { WorkerState } from './types.js'
import type { PoolClient } from './worker.js'

export interface ServeOpts {
  /** Машина → ключ. Пусто — без проверки (только тесты и localhost). */
  keys: Record<string, string>
  port?: number
  host?: string
  log?: (msg: string) => void
}

const MAX_JSON = 32 * 1024 ** 2
const MAX_OUT = 4 * 1024 ** 3

function body(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = []
    let n = 0
    req.on('data', (c: Buffer) => {
      n += c.length
      if (n > limit) {
        rej(new Error('слишком большое тело'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => res(Buffer.concat(chunks)))
    req.on('error', rej)
  })
}

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Имя машины по ключу; ключей нет — имя из `x-pool-worker`. */
function who(req: IncomingMessage, keys: Record<string, string>): string | null {
  const names = Object.keys(keys)
  if (names.length === 0) return String(req.headers['x-pool-worker'] ?? '') || 'anon'
  const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))
  if (!m) return null
  for (const name of names) if (same(m[1]!, keys[name]!)) return name
  return null
}

function send(res: ServerResponse, code: number, data?: unknown): void {
  if (data === undefined) {
    res.writeHead(code).end()
    return
  }
  if (Buffer.isBuffer(data)) {
    res.writeHead(code, { 'content-type': 'application/gzip', 'content-length': data.length }).end(data)
    return
  }
  const s = JSON.stringify(data)
  res.writeHead(code, { 'content-type': 'application/json' }).end(s)
}

export function servePool(center: Center, opts: ServeOpts): Promise<{ server: Server; url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      opts.log?.(`pool http: ${(e as Error).message}`)
      if (!res.headersSent) send(res, 500, { error: (e as Error).message })
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://pool')
    if (url.pathname === '/health') return send(res, 200, { ok: true })
    const name = who(req, opts.keys)
    if (!name) return send(res, 401, { error: 'нет ключа машины' })
    const json = async <T>(): Promise<T> => JSON.parse((await body(req, MAX_JSON)).toString('utf8') || '{}') as T
    const own = (st: WorkerState): WorkerState => ({ ...st, name })
    const p = url.pathname
    if (req.method === 'POST' && p === '/v1/heartbeat') return send(res, 200, await center.heartbeat(own(await json<WorkerState>())))
    if (req.method === 'POST' && p === '/v1/claim') {
      const st = own(await json<WorkerState>())
      const wait = Math.min(Number(url.searchParams.get('wait') ?? 0) || 0, 60_000)
      res.on('close', () => {
        if (!res.writableEnded) center.dropClaim(name)
      })
      const a = await center.claim(st, wait)
      if (res.destroyed) return
      return a ? send(res, 200, a) : send(res, 204)
    }
    if (req.method === 'POST' && p === '/v1/log') {
      const b = await json<{ id: string; lease: string; lines: LogLine[] }>()
      return send(res, 200, { ok: await center.log(name, b.id, b.lease, b.lines ?? []) })
    }
    if (req.method === 'POST' && p === '/v1/finish') {
      const raw = String(req.headers['x-pool-report'] ?? '')
      const report = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as FinishReport
      const out = await body(req, MAX_OUT)
      return send(res, 200, { ok: await center.finish(name, report, out.length > 0 ? out : undefined) })
    }
    if (req.method === 'POST' && p === '/v1/return') {
      const b = await json<{ id: string; lease: string; reason?: 'guard' | 'pause' | 'error' }>()
      return send(res, 200, { ok: await center.giveBack(name, b.id, b.lease, b.reason ?? 'guard') })
    }
    const pkg = /^\/v1\/pkg\/([0-9a-f]{64})$/.exec(p)
    if (req.method === 'GET' && pkg) {
      const bytes = center.pkg(pkg[1]!)
      return bytes ? send(res, 200, bytes) : send(res, 404, { error: 'нет пакета' })
    }
    if (req.method === 'GET' && p === '/v1/workers') return send(res, 200, center.workerList())
    if (req.method === 'POST' && p === '/v1/pause') {
      const b = await json<{ name?: string; on?: boolean }>()
      center.pause(b.name ?? name, b.on !== false)
      return send(res, 200, { ok: true })
    }
    return send(res, 404, { error: 'нет такого' })
  }

  return new Promise((resolveP, rej) => {
    server.once('error', rej)
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
      const a = server.address() as AddressInfo
      resolveP({
        server,
        url: `http://${a.address.includes(':') ? `[${a.address}]` : a.address}:${a.port}`,
        close: () => new Promise<void>((r) => {
          server.closeAllConnections()
          server.close(() => r())
        }),
      })
    })
  })
}

/** Клиент воркера к центру по HTTP. */
export function httpPoolClient(base: string, key: string, name?: string): PoolClient {
  const root = base.replace(/\/+$/, '')
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    ...(key ? { authorization: `Bearer ${key}` } : {}),
    ...(name ? { 'x-pool-worker': name } : {}),
    ...extra,
  })
  const post = async <T>(path: string, data: unknown, signal?: AbortSignal): Promise<{ status: number; json: T | null }> => {
    const r = await fetch(`${root}${path}`, { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify(data), ...(signal ? { signal } : {}) })
    if (r.status === 204) return { status: 204, json: null }
    if (!r.ok) throw new Error(`pool ${path}: HTTP ${r.status}`)
    return { status: r.status, json: (await r.json()) as T }
  }
  return {
    heartbeat: async (st) => (await post<Awaited<ReturnType<PoolClient['heartbeat']>>>('/v1/heartbeat', st)).json!,
    claim: async (st, waitMs) => (await post<Awaited<ReturnType<PoolClient['claim']>>>(`/v1/claim?wait=${waitMs}`, st, AbortSignal.timeout(waitMs + 15_000))).json,
    log: async (_n, id, lease, lines) => (await post<{ ok: boolean }>('/v1/log', { id, lease, lines })).json?.ok === true,
    giveBack: async (_n, id, lease, reason) => (await post<{ ok: boolean }>('/v1/return', { id, lease, reason })).json?.ok === true,
    finish: async (_n, report, out) => {
      const r = await fetch(`${root}/v1/finish`, {
        method: 'POST',
        headers: headers({ 'content-type': 'application/gzip', 'x-pool-report': Buffer.from(JSON.stringify(report)).toString('base64url') }),
        body: out ? new Uint8Array(out) : new Uint8Array(0),
      })
      if (!r.ok) throw new Error(`pool /v1/finish: HTTP ${r.status}`)
      return ((await r.json()) as { ok: boolean }).ok === true
    },
    pkg: async (sha) => {
      const r = await fetch(`${root}/v1/pkg/${sha}`, { headers: headers() })
      if (!r.ok) throw new Error(`pool пакет ${sha.slice(0, 12)}: HTTP ${r.status}`)
      return Buffer.from(await r.arrayBuffer())
    },
  }
}

/** Клиент в одном процессе с центром (тесты, центр-и-воркер на одной машине). */
export function localPoolClient(center: Center): PoolClient {
  return {
    heartbeat: (st) => center.heartbeat(st),
    claim: (st, waitMs) => center.claim(st, waitMs),
    log: (n, id, lease, lines) => center.log(n, id, lease, lines),
    finish: (n, r, out) => center.finish(n, r, out),
    giveBack: (n, id, lease, reason) => center.giveBack(n, id, lease, reason),
    pkg: async (sha) => {
      const b = center.pkg(sha)
      if (!b) throw new Error(`нет пакета ${sha}`)
      return b
    },
  }
}

/** Машины пула для CLI и плагина (`runz pool ls`). */
export async function poolWorkers(base: string, key: string): Promise<unknown> {
  const r = await fetch(`${base.replace(/\/+$/, '')}/v1/workers`, { headers: key ? { authorization: `Bearer ${key}` } : {} })
  if (!r.ok) throw new Error(`pool /v1/workers: HTTP ${r.status}`)
  return r.json()
}

export async function poolPause(base: string, key: string, name: string, on: boolean): Promise<void> {
  const r = await fetch(`${base.replace(/\/+$/, '')}/v1/pause`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ name, on }),
  })
  if (!r.ok) throw new Error(`pool /v1/pause: HTTP ${r.status}`)
}
