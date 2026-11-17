/**
 * Дочерние MCP-серверы по stdio: `$stdio_<имя>: <команда> [аргументы…]` в конфиге — nr-mcp запускает
 * процесс сам и отдаёт его тулы в своём `/mcp`. Зачем: права macOS (Accessibility, Screen Recording) выдаются
 * процессу-родителю — дочерний сервер (Macbeth и т.п.) получает их от nr-mcp, разрешения ставятся один раз, а
 * тулы видны всем клиентам машины (Claude Code на других машинах, коннектор claude.ai, агенты nrchat).
 * Упал дочерний — следующий вызов поднимает его заново; не поднялся на старте — повтор раз в минуту.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ToolDef, ToolResult } from '@kerneldreams/tools'

export interface ChildSpec {
  name: string
  command: string
  args: string[]
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }
type Def = { name: string; description?: string; inputSchema?: Record<string, unknown> }
type Content = { type?: string; text?: string; data?: string; mimeType?: string }

/** `$stdio_<имя>` конфига → спеки; значение — строка через пробелы. */
export function childSpecs(raw: Record<string, string | string[]>): ChildSpec[] {
  const out: ChildSpec[] = []
  for (const [k, v] of Object.entries(raw)) {
    const m = /^stdio_([\w-]+)$/.exec(k)
    if (!m) continue
    const parts = (Array.isArray(v) ? v : v.split(/\s+/)).filter(Boolean)
    if (parts.length) out.push({ name: m[1]!, command: parts[0]!, args: parts.slice(1) })
  }
  return out
}

class Child {
  private proc?: ChildProcessWithoutNullStreams
  private ready?: Promise<void>
  private seq = 0
  private pending = new Map<number, Pending>()
  private buf = ''

  constructor(readonly spec: ChildSpec, private log: (m: string) => void) {}

  private start(): Promise<void> {
    const p = spawn(this.spec.command, this.spec.args, { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = p
    this.buf = ''
    p.stdout.setEncoding('utf-8')
    p.stdout.on('data', (chunk: string) => {
      this.buf += chunk
      let i: number
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim()
        this.buf = this.buf.slice(i + 1)
        if (!line) continue
        let msg: { id?: number; result?: unknown; error?: { message?: string } }
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        const w = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined
        if (!w) continue
        this.pending.delete(msg.id!)
        if (msg.error) w.reject(new Error(msg.error.message ?? 'error'))
        else w.resolve(msg.result)
      }
    })
    p.stderr.on('data', () => {})
    const gone = (why: string): void => {
      if (this.proc !== p) return
      this.proc = undefined
      this.ready = undefined
      for (const w of this.pending.values()) w.reject(new Error(`${this.spec.name}: ${why}`))
      this.pending.clear()
    }
    p.on('exit', (code) => gone(`процесс вышел (${code ?? 'signal'})`))
    p.on('error', (e) => gone(e.message))
    return this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'nr-mcp', version: '1' } }).then(() => {
      p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    })
  }

  private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const p = this.proc
    if (!p) return Promise.reject(new Error(`${this.spec.name}: не запущен`))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      signal?.addEventListener('abort', () => {
        if (!this.pending.delete(id)) return
        p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } })}\n`)
        reject(new Error('aborted'))
      })
      p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  async call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.ready) {
      this.ready = this.start()
      this.ready.catch((e: unknown) => {
        this.log(`${this.spec.name}: ${(e as Error).message}`)
        this.proc?.kill()
      })
    }
    await this.ready
    return this.request(method, params, signal)
  }

  stop(): void {
    this.proc?.kill()
  }
}

function result(r: unknown): ToolResult {
  const o = (r ?? {}) as { content?: Content[]; isError?: boolean }
  const content = Array.isArray(o.content) ? o.content : []
  const text = content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n')
  const images = content.filter((c) => c.type === 'image' && c.data).map((c) => ({ data: c.data!, mimeType: c.mimeType ?? 'image/png' }))
  return { text, ...(images.length ? { images } : {}), ...(o.isError ? { isError: true } : {}) }
}

/** Поднять детей и подгрузить их тулы в живой список машины; имя занято — тул пропускается. */
export function attachChildren(tools: ToolDef[], specs: ChildSpec[], log: (m: string) => void, retryMs = 60_000): () => void {
  const children = specs.map((s) => new Child(s, log))
  const timers: ReturnType<typeof setTimeout>[] = []
  let stopped = false
  const load = (c: Child): void => {
    c.call('tools/list', {})
      .then((r) => {
        if (stopped) return
        const defs = ((r as { tools?: Def[] })?.tools ?? []).filter((d) => d?.name)
        const added: string[] = []
        for (const d of defs) {
          if (tools.some((t) => t.name === d.name)) continue
          added.push(d.name)
          tools.push({
            name: d.name,
            description: d.description ?? d.name,
            schema: d.inputSchema ?? { type: 'object' },
            executor: 'backend',
            source: 'mcp',
            async execute(args, ctx): Promise<ToolResult> {
              return result(await c.call('tools/call', { name: d.name, arguments: args }, ctx.signal))
            },
          } as ToolDef)
        }
        log(`${c.spec.name}: тулы ${added.join(', ') || '—'}`)
      })
      .catch((e: unknown) => {
        if (stopped) return
        log(`${c.spec.name}: ${(e as Error).message} — повтор через ${Math.round(retryMs / 1000)} с`)
        const t = setTimeout(() => load(c), retryMs)
        t.unref?.()
        timers.push(t)
      })
  }
  children.forEach(load)
  return () => {
    stopped = true
    timers.forEach(clearTimeout)
    children.forEach((c) => c.stop())
  }
}
