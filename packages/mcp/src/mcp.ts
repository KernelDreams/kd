/**
 * MCP (JSON-RPC 2.0) над тулами машины: `initialize`, `ping`, `tools/list`, `tools/call`. Ответы —
 * `application/json` (Streamable HTTP это разрешает), без потока сервера. Ошибка тула — `isError`
 * в результате, а не падение процесса (дыра пробника 22.10).
 */

import type { ToolContext, ToolDef, ToolResult } from '@kerneldreams/tools'
import type { RootsGuard } from './roots.js'

export const SERVER_NAME = 'nr-mcp'
export const PROTOCOL_VERSION = '2025-06-18'

export type Rpc = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }

export const rpcError = (id: unknown, code: number, message: string): Record<string, unknown> => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

export interface McpHost {
  name: string
  version: string
  tools: ToolDef[]
  guard: RootsGuard
  log(line: string): void
}

/** Аргументы-пути тулов `nr-tools`: их — к корням до вызова, с понятным модели текстом. */
const PATH_ARGS = ['path', 'workdir'] as const

function outside(host: McpHost, args: Record<string, unknown>): string | undefined {
  for (const k of PATH_ARGS) {
    const v = args[k]
    if (typeof v !== 'string' || !v.trim()) continue
    const p = v.trim().replace(/^@/, '')
    const abs = p === '~' || p.startsWith('~/') ? p.replace(/^~/, process.env.HOME ?? '~') : p.startsWith('/') ? p : `${host.guard.roots[0]}/${p}`
    if (!host.guard.allowed(abs)) return `${k} outside the roots of ${host.name}: ${v} (roots: ${host.guard.roots.join(', ')})`
  }
  return undefined
}

function content(res: ToolResult | string): Record<string, unknown> {
  const r: ToolResult = typeof res === 'string' ? { text: res } : res
  return {
    content: [{ type: 'text', text: r.text ?? '' }, ...(r.images ?? []).map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType }))],
    ...(r.isError ? { isError: true } : {}),
  }
}

/** Один запрос; уведомление — `undefined`. `session` — ключ процессов `exec` (заголовок `Mcp-Session-Id`). */
export async function handleRpc(host: McpHost, msg: Rpc, o: { session: string; signal: AbortSignal }): Promise<Record<string, unknown> | undefined> {
  const id = msg.id
  const isCall = id !== undefined && id !== null
  const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>
  const ok = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result })
  switch (msg.method) {
    case 'initialize':
      return ok({
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: host.version },
        instructions: `Hands on machine «${host.name}»: files under ${host.guard.roots.join(', ')}, shell commands, processes.`,
      })
    case 'ping':
      return isCall ? ok({}) : undefined
    case 'tools/list':
      return ok({ tools: host.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })) })
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : ''
      const tool = host.tools.find((t) => t.name === name)
      if (!tool) return ok(content({ text: `${host.name}: no tool «${name || '(no name)'}»`, isError: true }))
      const args = (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}) as Record<string, unknown>
      const out = outside(host, args)
      if (out) return ok(content({ text: out, isError: true }))
      const ctx: ToolContext = {
        signal: o.signal,
        sessionId: o.session,
        callId: String(id ?? Date.now()),
        cwd: host.guard.roots[0],
        ask: () => Promise.reject(new Error('nr-mcp: no one to ask')),
      }
      try {
        return ok(content(await tool.execute(args, ctx)))
      } catch (err) {
        return ok(content({ text: `${name}: ${err instanceof Error ? err.message : String(err)}`, isError: true }))
      }
    }
    default:
      if (!isCall) return undefined
      return rpcError(id, -32601, `method ${String(msg.method)} not found`)
  }
}
