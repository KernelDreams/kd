/**
 * Транспорт `nr`: nr-ui-protocol через `nr-chat-client` (HTTP + SSE).
 *
 *  - сессия: `auto` — `sessions.create({profile, cwd})`, иначе существующая
 *    (`get` + `history` в ленту);
 *  - ран: события → лента (дельты text/thinking, tool_use → карточка,
 *    tool_result — в неё же), `ask` → карточка (апрув, выбор, текст,
 *    разрешение) → `respond`; `ask` вида `tool` — тул страницы: исполняет
 *    обработчик `registerTool`, ответ — `respond`;
 *  - тулы страницы — `sessionMeta.tools` (исполнитель — фронт, v1.16);
 *    снимок страницы (`onContext`) — `sessionMeta.pageContext` перед раном.
 */

import { createClient, type ChatClient } from '@kerneldreams/chat-client'
import type { AnyRunEvent, Capabilities, Message, Part, SessionToolDecl } from '@kerneldreams/ui-protocol'
import { Feed, type ApprovalOption, type Block, type FeedMessage } from './feed.js'
import { errorText, runPageTool, type Transport, type TransportHost } from './transport.js'

interface PendingAsk {
  kind: string
}

export class NrTransport implements Transport {
  readonly kind: 'nr' | 'local' = 'nr'
  sessionId: string | undefined
  private client: ChatClient
  private caps: Capabilities | undefined
  private abort: AbortController | undefined
  private readonly asks = new Map<string, PendingAsk>()
  /** Имена тулов, которые эта страница положила в мету (снимаются при уходе). */
  private declared = new Set<string>()
  /** Чужие тулы сессии на момент последней синхронизации (для keepalive-снятия своих). */
  private others: SessionToolDecl[] = []
  private beatTimer: ReturnType<typeof setInterval> | undefined
  private onHide = (): void => this.withdrawTools(true)

  constructor(
    private readonly host: TransportHost,
    client?: ChatClient,
  ) {
    this.client = client ?? createClient(host.options.backend, host.options.auth ? { auth: host.options.auth } : {})
    if (client) this.kind = 'local'
  }

  async connect(): Promise<void> {
    this.caps = await this.client.capabilities()
    const want = this.host.options.session
    if (want && want !== 'auto') {
      await this.client.sessions.get(want)
      this.sessionId = want
      const page = await this.client.sessions.history(want)
      loadHistory(this.host.feed, page.messages)
      // Открытая сессия могла быть в ходе у другого клиента (прогон в окне, агент в терминале):
      // подписка на идущий ран (sessions.attach) и на следующие.
      if (this.caps.sessions?.attach && this.client.backend.sessions.attach) void this.follow(want)
    } else {
      const s = await this.client.sessions.create({
        ...(this.host.options.profile ? { profile: this.host.options.profile } : {}),
        ...(this.host.options.cwd ? { cwd: this.host.options.cwd } : {}),
      })
      this.sessionId = s.id
    }
    this.host.emit('session', { id: this.sessionId, transport: this.kind })
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.onHide)
    if (this.host.pageTools.size) await this.syncTools()
  }

  async syncTools(): Promise<void> {
    if (!this.sessionId) return
    if (!this.caps?.tools?.session || !this.caps.sessionMeta) {
      this.host.emit('error', { message: this.host.t.noPageTools })
      return
    }
    const meta = await this.client.sessions.meta.get(this.sessionId)
    const mine = new Set(this.host.pageTools.keys())
    const others = (Array.isArray(meta.tools) ? meta.tools : []).filter((d) => !mine.has(d.name) && !this.declared.has(d.name))
    const decls: SessionToolDecl[] = [...this.host.pageTools.values()].map(({ def }) => ({
      name: def.name,
      ...(def.description ? { description: def.description } : {}),
      schema: def.schema ?? { type: 'object', properties: {} },
      executor: 'frontend',
    }))
    await this.client.sessions.meta.patch(this.sessionId, { tools: [...others, ...decls] })
    this.declared = mine
    this.others = others
    this.beat()
  }

  /**
   * Удар живости: пока страница объявляет тулы — сразу и раз в 10 с
   * `meta.patch({toolsAlive: {имя: ts}})`; бэкенд (store-backend) держит отметки
   * в kv и выкидывает из рана тулы страницы, молчащей дольше 30 с (вкладку
   * убили, pagehide не дошёл).
   */
  private beat(): void {
    const sid = this.sessionId
    if (!sid || !this.declared.size) {
      if (this.beatTimer) clearInterval(this.beatTimer)
      this.beatTimer = undefined
      return
    }
    const send = (): void => {
      if (!this.declared.size) return
      const marks = Object.fromEntries([...this.declared].map((n) => [n, Date.now()]))
      void this.client.sessions.meta.patch(sid, { toolsAlive: marks }).catch(() => {})
    }
    send()
    if (!this.beatTimer) this.beatTimer = setInterval(send, 10_000)
  }

  async send(text: string): Promise<void> {
    const sid = this.sessionId
    if (!sid) throw new Error('nr-chat: нет сессии')
    const feed = this.host.feed
    const optimistic = feed.add('user', [{ kind: 'text', text }])
    if (this.host.context) {
      const state = await this.host.context()
      await this.client.sessions.meta.patch(sid, { pageContext: state === undefined ? null : (state as never) })
    }
    const ac = new AbortController()
    this.abort = ac
    const state = new RunState(feed, optimistic.id)
    this.host.emit('run-start', { sessionId: sid })
    let end: Extract<AnyRunEvent, { type: 'run_end' }> | undefined
    try {
      end = await this.client.run(sid, text, {
        signal: ac.signal,
        onEvent: (ev) => this.onEvent(state, ev),
      })
    } catch (err) {
      feed.add('error', [{ kind: 'text', text: errorText(err) }])
      this.host.emit('run-end', { status: 'error', error: { message: errorText(err) } })
      return
    } finally {
      this.abort = undefined
      state.finish()
      this.asks.clear()
    }
    if (end.status === 'error') feed.add('error', [{ kind: 'text', text: end.error?.message ?? this.host.t.runError }])
    this.host.emit('run-end', { status: end.status, ...(end.error ? { error: end.error } : {}) })
  }

  /** Чужой ран сессии: живой поток в ленту, по концу — лента заново из истории; ждёт следующий. */
  private following = false
  private closed = false
  private async follow(sid: string): Promise<void> {
    if (this.following) return
    this.following = true
    const feed = this.host.feed
    try {
      while (!this.closed && this.sessionId === sid) {
        const info = await this.client.sessions.get(sid).catch(() => undefined)
        // Свой ран ведёт send(); чужого нет — ждать.
        if (!info?.run || this.abort) {
          await new Promise((r) => setTimeout(r, 1500))
          continue
        }
        const state = new RunState(feed, undefined)
        let any = false
        try {
          for await (const ev of this.client.backend.sessions.attach!(sid)) {
            if (this.closed || this.abort) break
            any = true
            if (ev.type === 'ask') {
              const e = ev as Extract<AnyRunEvent, { type: 'ask' }>
              if (e.kind !== 'tool') {
                this.asks.set(e.askId, { kind: e.kind })
                state.ask(e.askId, e.kind, e.payload, this.host)
              }
              continue
            }
            state.apply(ev)
          }
        } catch {
          // обрыв подписки — ран не трогаем, перечитаем ленту
        }
        state.finish()
        if (any && !this.abort && !this.closed) {
          const page = await this.client.sessions.history(sid).catch(() => undefined)
          if (page) {
            feed.clear()
            loadHistory(feed, page.messages)
          }
        }
        if (!any) await new Promise((r) => setTimeout(r, 1500))
      }
    } finally {
      this.following = false
    }
  }

  stop(): void {
    this.abort?.abort()
  }

  answer(askId: string, value: string): void {
    const sid = this.sessionId
    const ask = this.asks.get(askId)
    if (!sid || !ask) return
    this.asks.delete(askId)
    const answer = ask.kind === 'permission' ? value === 'allow' : value
    void this.client.respond(sid, askId, answer).catch((err) => this.host.emit('error', { message: errorText(err) }))
  }

  close(): void {
    this.closed = true
    this.abort?.abort()
    if (this.beatTimer) clearInterval(this.beatTimer)
    this.beatTimer = undefined
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.onHide)
    this.withdrawTools(false)
    // Локальный бэкенд живёт дольше транспорта (кэш страницы) — не закрывать.
    if (this.kind === 'nr') void this.client.close()
  }

  // ── события рана → лента ────────────────────────────────────────────────

  private onEvent(state: RunState, ev: AnyRunEvent): void {
    if (ev.type === 'ask') {
      const e = ev as Extract<AnyRunEvent, { type: 'ask' }>
      if (e.kind === 'tool') return void this.pageTool(state, e.askId, e.payload)
      this.asks.set(e.askId, { kind: e.kind })
      state.ask(e.askId, e.kind, e.payload, this.host)
      return
    }
    const done = state.apply(ev)
    if (done) this.host.emit('message', { id: done.id, role: done.role, text: Feed.textOf(done) })
    if (ev.type === 'part_end') {
      const p = (ev as { payload?: Part }).payload
      if (p?.type === 'tool_use' && !this.host.pageTools.has(p.meta.name)) this.host.emit('tool-call', { name: p.meta.name, args: p.data, callId: p.meta.callId, page: false })
    }
  }

  private async pageTool(state: RunState, askId: string, payload: unknown): Promise<void> {
    const call = (payload ?? {}) as { callId?: string; name?: string; args?: unknown }
    const name = call.name ?? ''
    state.markPage(call.callId ?? '')
    const res = await runPageTool(this.host, name, call.args, call.callId ?? '')
    const sid = this.sessionId
    if (sid) await this.client.respond(sid, askId, res).catch((err) => this.host.emit('error', { message: errorText(err) }))
  }

  /** Убрать свои тулы из меты: страница уходит — исполнителя больше нет. */
  private withdrawTools(keepalive: boolean): void {
    const sid = this.sessionId
    if (!sid || !this.declared.size) return
    const names = this.declared
    this.declared = new Set()
    if (!keepalive) {
      void this.client.sessions.meta
        .get(sid)
        .then((meta) => this.client.sessions.meta.patch(sid, { tools: (meta.tools ?? []).filter((d) => !names.has(d.name)) }))
        .catch(() => {})
      return
    }
    // pagehide: ждать ответа нельзя — keepalive-запрос с последним известным составом.
    const base = this.client.baseUrl
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(this.host.options.auth ? { authorization: `Bearer ${this.host.options.auth}` } : {}) }
    try {
      void fetch(`${base}/sessions/${encodeURIComponent(sid)}`, { method: 'PATCH', headers, body: JSON.stringify({ meta: { tools: this.others.length ? this.others : null } }), keepalive: true }).catch(() => {})
    } catch {
      // страница уже закрывается
    }
  }
}

// ── ран → лента ──────────────────────────────────────────────────────────

/** Состояние одного рана: части сообщений по индексу, id сообщений-результатов. */
export class RunState {
  private readonly parts = new Map<string, Block>()
  private readonly toolMessages = new Set<string>()
  private readonly live = new Set<string>()
  private readonly pageCalls = new Set<string>()

  constructor(
    private readonly feed: Feed,
    private optimisticUser: string | undefined,
  ) {}

  markPage(callId: string): void {
    this.pageCalls.add(callId)
    const t = this.feed.findTool(callId)
    if (t) this.feed.update(t.message.id, () => (t.block.page = true))
  }

  /** Событие → лента; возвращает сообщение ассистента, если оно закончилось. */
  apply(ev: AnyRunEvent): FeedMessage | undefined {
    const feed = this.feed
    switch (ev.type) {
      case 'message_start': {
        const m = (ev as Extract<AnyRunEvent, { type: 'message_start' }>).message
        if (m.role === 'tool') {
          this.toolMessages.add(m.id)
        } else if (m.role === 'user') {
          if (this.optimisticUser) {
            feed.rename(this.optimisticUser, m.id)
            this.optimisticUser = undefined
          } else feed.ensure(m.id, 'user')
        } else if (m.role === 'assistant') {
          const msg = feed.ensure(m.id, 'assistant')
          msg.live = true
          this.live.add(m.id)
        }
        return undefined
      }
      case 'part_start': {
        const e = ev as Extract<AnyRunEvent, { type: 'part_start' }>
        if (this.toolMessages.has(e.messageId)) return undefined
        const msg = feed.get(e.messageId)
        if (!msg || msg.role !== 'assistant') return undefined
        const meta = (e.meta ?? {}) as { callId?: string; name?: string }
        const block: Block | undefined =
          e.partType === 'text'
            ? { kind: 'text', text: '' }
            : e.partType === 'thinking'
              ? { kind: 'thinking', text: '' }
              : e.partType === 'tool_use'
                ? { kind: 'tool', callId: meta.callId ?? '', name: meta.name ?? 'tool', status: 'running', ...(this.pageCalls.has(meta.callId ?? '') ? { page: true } : {}) }
                : undefined
        if (!block) return undefined
        this.parts.set(`${e.messageId}:${e.part}`, block)
        feed.update(e.messageId, (m) => m.blocks.push(block))
        return undefined
      }
      case 'part_delta': {
        const e = ev as Extract<AnyRunEvent, { type: 'part_delta' }>
        const block = this.parts.get(`${e.messageId}:${e.part}`)
        if (!block || (block.kind !== 'text' && block.kind !== 'thinking') || !e.delta) return undefined
        feed.update(e.messageId, () => (block.text += e.delta))
        return undefined
      }
      case 'part_end': {
        const e = ev as Extract<AnyRunEvent, { type: 'part_end' }>
        const p = e.payload
        if (!p) return undefined
        if (p.type === 'tool_result') {
          applyResult(feed, p)
          return undefined
        }
        const block = this.parts.get(`${e.messageId}:${e.part}`)
        if (!block) return undefined
        feed.update(e.messageId, () => {
          if ((p.type === 'text' || p.type === 'thinking') && (block.kind === 'text' || block.kind === 'thinking') && typeof p.text === 'string') block.text = p.text
          if (p.type === 'tool_use' && block.kind === 'tool') block.args = p.data
        })
        return undefined
      }
      case 'message_end': {
        const m = (ev as Extract<AnyRunEvent, { type: 'message_end' }>).message
        if (m.role === 'tool') {
          for (const p of m.parts) if (p.type === 'tool_result') applyResult(feed, p)
          return undefined
        }
        if (m.role !== 'assistant') return undefined
        const msg = feed.get(m.id)
        if (!msg) return undefined
        this.live.delete(m.id)
        feed.update(m.id, (x) => {
          x.live = false
          x.blocks = mergeBlocks(x.blocks, blocksOf(m.parts))
        })
        return msg
      }
      default:
        return undefined
    }
  }

  ask(askId: string, kind: string, payload: unknown, host: TransportHost): void {
    const block = askBlock(askId, kind, payload, host)
    const target = this.feed.lastAssistant()
    this.feed.update(target.id, (m) => m.blocks.push(block))
  }

  /** Конец рана: живые ответы закрыть, неотвеченные вопросы погасить. */
  finish(): void {
    for (const id of this.live) this.feed.update(id, (m) => (m.live = false))
    this.live.clear()
    for (const m of this.feed.messages) {
      for (const b of m.blocks) {
        if (b.kind === 'ask' && b.answered === undefined) {
          b.answered = '—'
          this.feed.update(m.id, () => {})
        }
        if (b.kind === 'tool' && b.status === 'running' && b.result === undefined) {
          // ран кончился, результата нет (отмена, ошибка)
          b.status = 'error'
          this.feed.update(m.id, () => {})
        }
      }
    }
    this.feed.flushNow()
  }
}

function applyResult(feed: Feed, p: Extract<Part, { type: 'tool_result' }>): void {
  const t = feed.findTool(p.meta.callId)
  if (!t) return
  feed.update(t.message.id, () => {
    t.block.result = p.text ?? (p.data === undefined ? '' : JSON.stringify(p.data))
    t.block.status = p.meta.error ? 'error' : 'done'
  })
}

/** Части сообщения → блоки (без результатов — они в отдельных сообщениях). */
export function blocksOf(parts: Part[]): Block[] {
  const out: Block[] = []
  for (const p of parts) {
    if (p.type === 'text' && p.text) out.push({ kind: 'text', text: p.text })
    else if (p.type === 'thinking' && p.text) out.push({ kind: 'thinking', text: p.text })
    else if (p.type === 'tool_use') out.push({ kind: 'tool', callId: p.meta.callId, name: p.meta.name, args: p.data, status: 'running' })
    else if (p.type === 'image') out.push({ kind: 'text', text: '🖼' })
    else if (p.type === 'file') out.push({ kind: 'text', text: `📎 ${(p.meta as { name?: string }).name ?? ''}` })
  }
  return out
}

/** Финальные блоки сообщения + то, что знает только лента (результаты тулов, вопросы). */
function mergeBlocks(prev: Block[], next: Block[]): Block[] {
  const tools = new Map(prev.flatMap((b) => (b.kind === 'tool' ? [[b.callId, b] as const] : [])))
  const merged = next.map((b) => {
    if (b.kind !== 'tool') return b
    const old = tools.get(b.callId)
    return old ? { ...b, status: old.status, ...(old.result !== undefined ? { result: old.result } : {}), ...(old.page ? { page: true } : {}) } : b
  })
  return [...merged, ...prev.filter((b) => b.kind === 'ask')]
}

/** История сессии → лента: тулы с результатами, скрытые и системные — мимо. */
export function loadHistory(feed: Feed, messages: Message[]): void {
  for (const m of messages) {
    if (m.flags?.hidden || m.flags?.disabled) continue
    if (m.role === 'tool') {
      for (const p of m.parts) if (p.type === 'tool_result') applyResult(feed, p)
      continue
    }
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const blocks = blocksOf(m.parts)
    if (!blocks.length) continue
    feed.add(m.role, blocks, m.id)
  }
  // Тул без результата в истории — оборванный ран.
  for (const m of feed.messages) for (const b of m.blocks) if (b.kind === 'tool' && b.status === 'running') b.status = 'error'
}

/** `ask` протокола → карточка. */
export function askBlock(askId: string, kind: string, payload: unknown, host: Pick<TransportHost, 't'>): Extract<Block, { kind: 'ask' }> {
  const t = host.t
  const p = (payload ?? {}) as Record<string, unknown>
  if (kind === 'tool_approval') {
    const preview = p.preview as { kind?: string; diff?: string; command?: string; cwd?: string; text?: string } | undefined
    const text = preview?.kind === 'diff' ? preview.diff : preview?.kind === 'command' ? `$ ${preview.command}${preview.cwd ? `\n# ${preview.cwd}` : ''}` : preview?.text
    const options: ApprovalOption[] = [
      { value: 'allow', label: t.allow, tone: 'allow' },
      { value: 'allow_session', label: t.allowSession, tone: 'session' },
      { value: 'deny', label: t.deny, tone: 'deny' },
    ]
    return { kind: 'ask', askId, ask: 'tool_approval', question: String(p.title ?? p.name ?? t.approval), options, ...(text ? { preview: text } : {}) }
  }
  if (kind === 'select') {
    const options = Array.isArray(p.options) ? p.options.map(String) : []
    return { kind: 'ask', askId, ask: 'select', question: String(p.question ?? ''), options }
  }
  if (kind === 'permission') {
    const options: ApprovalOption[] = [
      { value: 'allow', label: t.allow, tone: 'allow' },
      { value: 'deny', label: t.deny, tone: 'deny' },
    ]
    return { kind: 'ask', askId, ask: 'permission', question: String(p.question ?? p.title ?? t.approval), options }
  }
  return { kind: 'ask', askId, ask: 'text', question: String(p.question ?? p.title ?? '') }
}
