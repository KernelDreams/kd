/**
 * Транспорт `acp`: Agent Client Protocol v1 по WebSocket (`backend-acp`,
 * `ws://…/acp`) — JSON-RPC текстовыми кадрами, без SDK (бандл).
 *
 *  - `initialize` → `session/new` (`cwd` — атрибут, пусто — каталог бэкенда)
 *    или `session/load` по `session` (реплей ленты апдейтами); профиль —
 *    `session/set_mode`;
 *  - `session/prompt` → `session/update`: дельты text/thought, `tool_call` →
 *    карточка, `tool_call_update` → её статус и результат;
 *  - `session/request_permission` (запрос агента) → карточка апрува с
 *    вариантами агента → `{outcome: selected, optionId}`;
 *  - стоп — `session/cancel`; открытые вопросы — `cancelled`.
 *
 * Чего в ACP нет — не эмулируется: правки и свайпы, тулы страницы (агенту их
 * не объявить), история сверх того, что видел виджет (или реплей `load`).
 * Снимок страницы (`onContext`) уходит ресурсом в prompt.
 */

import type { ApprovalOption, Block } from './feed.js'
import { errorText, type Transport, type TransportHost } from './transport.js'

interface RpcPending {
  resolve(v: unknown): void
  reject(e: unknown): void
}

interface AcpUpdate {
  sessionUpdate: string
  content?: unknown
  messageId?: string | null
  toolCallId?: string
  title?: string
  status?: string
  rawInput?: unknown
  rawOutput?: unknown
}

/** Минимальный WebSocket (браузерный; в тестах — подмена). */
export interface WsLike {
  readyState: number
  send(data: string): void
  close(): void
  addEventListener(type: 'open' | 'message' | 'close' | 'error', fn: (ev: any) => void): void
}

export type WsFactory = (url: string) => WsLike

export class AcpTransport implements Transport {
  readonly kind = 'acp' as const
  sessionId: string | undefined
  private ws: WsLike | undefined
  private nextId = 0
  private readonly pending = new Map<number, RpcPending>()
  /** askId карточки → id JSON-RPC запроса агента. */
  private readonly permissions = new Map<string, number | string>()
  /** Сообщение ассистента текущего хода (ACP `messageId` может не прийти). */
  private current: string | undefined
  private readonly byMessageId = new Map<string, string>()
  private running = false
  private loading = false
  private toolsWarned = false

  constructor(
    private readonly host: TransportHost,
    private readonly factory: WsFactory = (url) => new WebSocket(url) as unknown as WsLike,
  ) {}

  async connect(): Promise<void> {
    const o = this.host.options
    const url = o.auth ? `${o.backend}${o.backend.includes('?') ? '&' : '?'}auth=${encodeURIComponent(o.auth)}` : o.backend
    const ws = this.factory(url)
    this.ws = ws
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', () => reject(new Error(this.host.t.connectFailed)))
      ws.addEventListener('close', () => reject(new Error(this.host.t.connectFailed)))
    })
    ws.addEventListener('message', (ev: { data: unknown }) => this.onFrame(String(ev.data)))
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error(this.host.t.disconnected))
      this.pending.clear()
    })
    await this.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'nr-chat-widget', version: '0.1.0' } })
    const want = o.session && o.session !== 'auto' ? o.session : undefined
    if (want) {
      this.loading = true
      try {
        await this.request('session/load', { sessionId: want, cwd: o.cwd ?? '', mcpServers: [] })
      } finally {
        this.loading = false
        this.current = undefined
      }
      this.sessionId = want
    } else {
      const res = (await this.request('session/new', { cwd: o.cwd ?? '', mcpServers: [] })) as { sessionId: string }
      this.sessionId = res.sessionId
    }
    if (o.profile) await this.request('session/set_mode', { sessionId: this.sessionId, modeId: o.profile }).catch((err) => this.host.emit('error', { message: errorText(err) }))
    this.host.emit('session', { id: this.sessionId, transport: 'acp' })
    if (this.host.pageTools.size) await this.syncTools()
  }

  async syncTools(): Promise<void> {
    if (this.toolsWarned) return
    this.toolsWarned = true
    this.host.emit('error', { message: this.host.t.acpNoPageTools })
  }

  async send(text: string): Promise<void> {
    const sid = this.sessionId
    if (!sid) throw new Error('nr-chat: нет сессии')
    const feed = this.host.feed
    feed.add('user', [{ kind: 'text', text }])
    const prompt: unknown[] = [{ type: 'text', text }]
    if (this.host.context) {
      const state = await this.host.context()
      if (state !== undefined && state !== null) {
        prompt.unshift({ type: 'resource', resource: { uri: 'nr-chat://page-context', mimeType: 'application/json', text: typeof state === 'string' ? state : JSON.stringify(state, null, 2) } })
      }
    }
    this.current = undefined
    this.running = true
    this.host.emit('run-start', { sessionId: sid })
    try {
      const res = (await this.request('session/prompt', { sessionId: sid, prompt })) as { stopReason?: string }
      this.finish()
      const status = res.stopReason === 'cancelled' ? 'cancelled' : 'done'
      this.host.emit('run-end', { status })
    } catch (err) {
      this.finish()
      feed.add('error', [{ kind: 'text', text: errorText(err) }])
      this.host.emit('run-end', { status: 'error', error: { message: errorText(err) } })
    } finally {
      this.running = false
    }
  }

  stop(): void {
    if (!this.running || !this.sessionId) return
    this.notify('session/cancel', { sessionId: this.sessionId })
    // Протокол: на отмену открытые запросы разрешений отвечаются cancelled.
    for (const [askId, rpcId] of this.permissions) {
      this.reply(rpcId, { outcome: { outcome: 'cancelled' } })
      this.markAnswered(askId, '—')
    }
    this.permissions.clear()
  }

  answer(askId: string, value: string): void {
    const rpcId = this.permissions.get(askId)
    if (rpcId === undefined) return
    this.permissions.delete(askId)
    this.reply(rpcId, { outcome: { outcome: 'selected', optionId: value } })
  }

  close(): void {
    try {
      this.ws?.close()
    } catch {
      // уже закрыт
    }
  }

  // ── JSON-RPC ─────────────────────────────────────────────────────────────

  private send_(msg: object): void {
    this.ws?.send(JSON.stringify({ jsonrpc: '2.0', ...msg }))
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send_({ id, method, params })
    })
  }

  private notify(method: string, params: unknown): void {
    this.send_({ method, params })
  }

  private reply(id: number | string, result: unknown): void {
    this.send_({ id, result })
  }

  private onFrame(text: string): void {
    let msg: { id?: number | string; method?: string; params?: any; result?: unknown; error?: { message?: string; code?: number } }
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    if (msg.method) {
      if (msg.method === 'session/update') this.onUpdate(msg.params?.update as AcpUpdate)
      else if (msg.method === 'session/request_permission' && msg.id !== undefined) this.onPermission(msg.id, msg.params)
      else if (msg.id !== undefined) this.send_({ id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } })
      return
    }
    if (typeof msg.id !== 'number') return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    if (msg.error) p.reject(new Error(msg.error.message ?? `ACP error ${msg.error.code ?? ''}`))
    else p.resolve(msg.result)
  }

  // ── апдейты → лента ──────────────────────────────────────────────────────

  private assistant(messageId?: string | null): string {
    const feed = this.host.feed
    if (messageId) {
      const known = this.byMessageId.get(messageId)
      if (known && feed.get(known)) {
        this.current = known
        return known
      }
    }
    if (!this.current || !feed.get(this.current) || feed.messages.at(-1)?.id !== this.current) {
      const m = feed.add('assistant', [])
      m.live = !this.loading
      this.current = m.id
    }
    if (messageId) this.byMessageId.set(messageId, this.current)
    return this.current
  }

  private onUpdate(u: AcpUpdate | undefined): void {
    if (!u) return
    const feed = this.host.feed
    const text = (u.content as { type?: string; text?: string } | undefined)?.type === 'text' ? ((u.content as { text: string }).text ?? '') : ''
    switch (u.sessionUpdate) {
      case 'user_message_chunk': {
        if (!text) return
        const last = feed.messages.at(-1)
        if (last && last.role === 'user' && this.loading) feed.update(last.id, (m) => appendText(m.blocks, 'text', text))
        else feed.add('user', [{ kind: 'text', text }])
        this.current = undefined
        return
      }
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        if (!text) return
        const id = this.assistant(u.messageId)
        feed.update(id, (m) => appendText(m.blocks, u.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thinking', text))
        return
      }
      case 'tool_call': {
        const id = this.assistant()
        const callId = u.toolCallId ?? ''
        const existing = feed.findTool(callId)
        if (existing) {
          feed.update(existing.message.id, () => updateTool(existing.block, u))
          return
        }
        const block: Extract<Block, { kind: 'tool' }> = { kind: 'tool', callId, name: u.title ?? 'tool', title: u.title ?? 'tool', status: 'running' }
        updateTool(block, u)
        feed.update(id, (m) => m.blocks.push(block))
        this.host.emit('tool-call', { name: block.name, args: block.args, callId, page: false })
        return
      }
      case 'tool_call_update': {
        const t = feed.findTool(u.toolCallId ?? '')
        if (t) feed.update(t.message.id, () => updateTool(t.block, u))
        return
      }
      default:
        return
    }
  }

  private onPermission(rpcId: number | string, params: any): void {
    const t = this.host.t
    const tc = (params?.toolCall ?? {}) as { toolCallId?: string; title?: string; content?: unknown[]; rawInput?: unknown }
    const options: ApprovalOption[] = (Array.isArray(params?.options) ? params.options : []).map((o: { optionId: string; name?: string; kind?: string }) => ({
      value: o.optionId,
      label: o.name ?? o.optionId,
      tone: o.kind === 'allow_always' ? 'session' : o.kind?.startsWith('reject') ? 'deny' : 'allow',
    }))
    const askId = `acp-perm-${rpcId}`
    this.permissions.set(askId, rpcId)
    const preview = contentPreview(tc.content)
    const block: Extract<Block, { kind: 'ask' }> = { kind: 'ask', askId, ask: 'acp_permission', question: tc.title ?? t.approval, options, ...(preview ? { preview } : {}) }
    const id = this.assistant()
    this.host.feed.update(id, (m) => m.blocks.push(block))
  }

  private markAnswered(askId: string, value: string): void {
    const a = this.host.feed.findAsk(askId)
    if (a && a.block.answered === undefined) this.host.feed.update(a.message.id, () => (a.block.answered = value))
  }

  private finish(): void {
    const feed = this.host.feed
    for (const m of feed.messages) {
      if (m.live) feed.update(m.id, () => (m.live = false))
      for (const b of m.blocks) if (b.kind === 'ask' && b.answered === undefined) this.markAnswered(b.askId, '—')
    }
    const last = feed.messages.at(-1)
    if (last?.role === 'assistant') this.host.emit('message', { id: last.id, role: 'assistant', text: last.blocks.flatMap((b) => (b.kind === 'text' ? [b.text] : [])).join('\n') })
    this.current = undefined
    feed.flushNow()
  }
}

function appendText(blocks: Block[], kind: 'text' | 'thinking', text: string): void {
  const last = blocks.at(-1)
  if (last && last.kind === kind) last.text += text
  else blocks.push({ kind, text })
}

function updateTool(block: Extract<Block, { kind: 'tool' }>, u: AcpUpdate): void {
  if (u.title) block.title = u.title
  if (u.rawInput !== undefined && u.rawInput !== null && !(typeof u.rawInput === 'object' && !Object.keys(u.rawInput as object).length)) block.args = u.rawInput
  if (u.status === 'completed') block.status = 'done'
  else if (u.status === 'failed') block.status = 'error'
  const text = contentPreview(u.content as unknown[] | undefined)
  if (text) block.result = text
  else if (u.rawOutput !== undefined && u.rawOutput !== null && block.status !== 'running') block.result = typeof u.rawOutput === 'string' ? u.rawOutput : JSON.stringify(u.rawOutput)
}

/** Содержимое тула ACP → текст карточки: текстовые блоки и дифы. */
function contentPreview(content: unknown[] | undefined): string {
  if (!Array.isArray(content)) return ''
  const out: string[] = []
  for (const c of content as Array<Record<string, any>>) {
    if (c.type === 'content' && c.content?.type === 'text') out.push(String(c.content.text ?? ''))
    else if (c.type === 'diff') {
      out.push(`--- ${c.path}`)
      for (const l of String(c.oldText ?? '').split('\n')) if (l !== '') out.push(`-${l}`)
      for (const l of String(c.newText ?? '').split('\n')) if (l !== '') out.push(`+${l}`)
    }
  }
  return out.join('\n')
}
