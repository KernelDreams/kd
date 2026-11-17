/**
 * Сторож тишины вечных стримов: сервер пингует — стрим жив; ни байта
 * дольше `idleTimeoutMs` — стрим сервиса кончается кадром connection_lost
 * (рестарт бэкенда за туннелем оставлял соединение висеть вечно).
 */
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createHttpBackend } from '../src/index.js'

let server: Server | undefined
afterEach(() => new Promise<void>((r) => (server ? (server.close(() => r()), server.closeAllConnections()) : r())))

async function serve(pingMs: number | null): Promise<string> {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`event: service_event\ndata: ${JSON.stringify({ name: 'ready' })}\n\n`)
    if (pingMs !== null) {
      const t = setInterval(() => res.write(': ping\n\n'), pingMs)
      req.on('close', () => clearInterval(t))
    }
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  const addr = server.address() as { port: number }
  return `http://127.0.0.1:${addr.port}`
}

describe('services.stream: сторож тишины', () => {
  it('тишина дольше idleTimeoutMs — кадр error connection_lost и конец', async () => {
    const b = createHttpBackend(await serve(null), { idleTimeoutMs: 150 })
    const frames: { name: string; payload?: any }[] = []
    for await (const f of b.services!.stream('p', 'events')) frames.push(f)
    expect(frames[0]).toEqual({ name: 'ready' })
    expect(frames[1]?.name).toBe('error')
    expect(JSON.stringify(frames[1]?.payload)).toMatch(/connection_lost/)
    expect(JSON.stringify(frames[1]?.payload)).toMatch(/heartbeat/)
    b.close?.()
  })

  it('пинги чаще порога — стрим жив', async () => {
    const b = createHttpBackend(await serve(40), { idleTimeoutMs: 150 })
    const it = b.services!.stream('p', 'events')[Symbol.asyncIterator]()
    expect((await it.next()).value).toEqual({ name: 'ready' })
    const raced = await Promise.race([it.next().then(() => 'frame'), new Promise((r) => setTimeout(() => r('alive'), 500))])
    expect(raced).toBe('alive')
    await it.return?.()
    b.close?.()
  })
})

/** Стрим рана: `run_start`, ask и тишина (с пингами или без) — как ран, ждущий апрув. */
async function serveRun(opts: { keepalive: boolean; pingMs: number | null }): Promise<string> {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (opts.keepalive) res.write(': keepalive\n\n')
    res.write(`event: run_start\ndata: ${JSON.stringify({ type: 'run_start', runId: 'r1' })}\n\n`)
    res.write(`event: ask\ndata: ${JSON.stringify({ type: 'ask', runId: 'r1', askId: 'a1', kind: 'tool_approval', payload: {} })}\n\n`)
    if (opts.pingMs !== null) {
      const t = setInterval(() => res.write(': keepalive\n\n'), opts.pingMs)
      req.on('close', () => clearInterval(t))
    }
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  const addr = server.address() as { port: number }
  return `http://127.0.0.1:${addr.port}`
}

describe('стрим рана: сторож тишины (ABC-356)', () => {
  it('сервер пинговал и замолчал — run_end connection_lost, а не вечное ожидание', async () => {
    const b = createHttpBackend(await serveRun({ keepalive: true, pingMs: null }), { idleTimeoutMs: 150 })
    const events: any[] = []
    for await (const e of b.run('s1', { userMessage: 'x' })) events.push(e)
    expect(events.map((e) => e.type)).toEqual(['run_start', 'ask', 'run_end'])
    expect(events[2]).toMatchObject({ runId: 'r1', status: 'error', error: { code: 'connection_lost' } })
    b.close?.()
  })

  it('пинги чаще порога — ран ждёт сколько угодно', async () => {
    const b = createHttpBackend(await serveRun({ keepalive: true, pingMs: 40 }), { idleTimeoutMs: 150 })
    const it = b.run('s1', { userMessage: 'x' })[Symbol.asyncIterator]()
    expect((await it.next()).value.type).toBe('run_start')
    expect((await it.next()).value.type).toBe('ask')
    const raced = await Promise.race([it.next().then(() => 'frame'), new Promise((r) => setTimeout(() => r('alive'), 500))])
    expect(raced).toBe('alive')
    b.close?.()
  })

  it('сервер без keepalive (старый бэкенд) — сторожа нет: долгий тул не обрыв', async () => {
    const b = createHttpBackend(await serveRun({ keepalive: false, pingMs: null }), { idleTimeoutMs: 150 })
    const it = b.run('s1', { userMessage: 'x' })[Symbol.asyncIterator]()
    await it.next()
    await it.next()
    const raced = await Promise.race([it.next().then(() => 'frame'), new Promise((r) => setTimeout(() => r('alive'), 500))])
    expect(raced).toBe('alive')
    b.close?.()
  })
})
