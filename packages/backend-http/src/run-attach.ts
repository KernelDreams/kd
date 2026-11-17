/**
 * Подхват идущего рана (run-resume-spec §1, протокол v1.31): `withRunAttach`
 * оборачивает любой `ProtocolBackend` так, что ран живёт в процессе, а не в
 * потоке запроса, который его начал.
 *
 *  - ран качается сам: потребитель `run()` ушёл (вкладка закрыта, туннель
 *    порвался) — ран идёт дальше, события копятся в снимке;
 *  - снимок — сообщения рана: закрытые — `message_start` + `message_end`,
 *    незакрытое — частями с накопленным текстом; ждущие `ask`; последняя
 *    `activity`. Дельты не хранятся поштучно — только сумма;
 *  - `sessions.attach(id)` — снимок, потом живой поток с того же места до
 *    `run_end`; подписчиков сколько угодно, уход подписчика ран не трогает;
 *  - `respond` — от любого подписчика: принятый ответ гасит ask у всех
 *    (`ask_end`);
 *  - `sessions.get/list` несут `SessionInfo.run` {id, startedAt, waiting?}.
 *
 * Состояние — в памяти процесса: ран исполняется здесь же, его снимок — тоже.
 * `serveBackend` оборачивает бэкенд сам, если у того нет своего `attach`.
 */

import { isParallelRun } from '@kerneldreams/ui-protocol'
import { isImpersonateRun } from './impersonate-run.js'
import { withSessionActivity } from './session-activity.js'
import type {
  ActivityEvent,
  AnyRunEvent,
  AskEvent,
  Capabilities,
  MessageEndEvent,
  MessageStartEvent,
  PartEndEvent,
  PartStartEvent,
  ProtocolBackend,
  RunStartInput,
  SessionInfo,
  SessionRun,
} from '@kerneldreams/ui-protocol'

interface PartSnap {
  start?: PartStartEvent
  /** Сумма дельт (replace — с нуля). */
  text: string
  delta: boolean
  end?: PartEndEvent
}

interface MessageSnap {
  start: MessageStartEvent
  parts: Map<number, PartSnap>
  end?: MessageEndEvent
}

/** Подписчик рана: очередь событий для одного `for await`. */
interface Sub {
  push(ev: AnyRunEvent): void
  end(): void
  fail(err: unknown): void
}

interface LiveRun {
  runId: string
  startedAt: string
  messages: Map<string, MessageSnap>
  /** Незакрытое сообщение (куда идут части). */
  openId: string | null
  asks: Map<string, AskEvent>
  activity?: ActivityEvent
  /** Последнее событие (v1.38): с какого момента ран в этом состоянии. */
  last?: SessionRun['last']
  /** Накопленный usage ходов рана (`message_end` → `meta.usage`; v1.53, монитор T4). */
  usage?: UsageSum
  subs: Set<Sub>
}

interface UsageSum {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  context?: { used: number; size: number }
  at: number
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function addUsage(prev: UsageSum | undefined, u: unknown, at: number): UsageSum | undefined {
  if (!u || typeof u !== 'object') return prev
  const x = u as { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; context?: { used?: unknown; size?: unknown } }
  const ctx = x.context && typeof x.context === 'object' && num(x.context.size) > 0 ? { used: num(x.context.used), size: num(x.context.size) } : prev?.context
  return {
    input: (prev?.input ?? 0) + num(x.input),
    output: (prev?.output ?? 0) + num(x.output),
    cacheRead: (prev?.cacheRead ?? 0) + num(x.cacheRead),
    cacheWrite: (prev?.cacheWrite ?? 0) + num(x.cacheWrite),
    ...(ctx ? { context: ctx } : {}),
    at,
  }
}

/** Счётчики сессии для монитора (`SessionInfo.metrics`, v1.53): токены и контекст. */
export function usageMetrics(u: UsageSum | undefined): NonNullable<SessionInfo['metrics']> {
  if (!u) return []
  return [
    { name: 'tokens_in', value: u.input, unit: 'tok', at: u.at },
    { name: 'tokens_out', value: u.output, unit: 'tok', at: u.at },
    ...(u.cacheRead ? [{ name: 'cache_read', value: u.cacheRead, unit: 'tok', at: u.at }] : []),
    ...(u.context ? [{ name: 'context', value: u.context.used, unit: 'tok', max: u.context.size, at: u.at }] : []),
  ]
}

/** Очередь «push → AsyncIterator»; `onClose` — подписчик ушёл (`return()`). */
function createQueue(onClose: (sub: Sub) => void): { sub: Sub; iterator: AsyncIterator<AnyRunEvent> } {
  const items: AnyRunEvent[] = []
  let ended = false
  let error: { err: unknown } | undefined
  let wake: (() => void) | undefined
  const sub: Sub = {
    push(ev) {
      if (ended) return
      items.push(ev)
      wake?.()
    },
    end() {
      ended = true
      wake?.()
    },
    fail(err) {
      error = { err }
      ended = true
      wake?.()
    },
  }
  const iterator: AsyncIterator<AnyRunEvent> = {
    async next() {
      for (;;) {
        if (items.length) return { done: false, value: items.shift()! }
        if (error) {
          const e = error.err
          error = undefined
          throw e
        }
        if (ended) return { done: true, value: undefined }
        await new Promise<void>((r) => (wake = r))
        wake = undefined
      }
    },
    async return() {
      ended = true
      items.length = 0
      onClose(sub)
      return { done: true, value: undefined }
    },
  }
  return { sub, iterator }
}

/** Снимок рана событиями протокола — то, что подписчик видит первым. */
function snapshot(live: LiveRun): AnyRunEvent[] {
  const { runId } = live
  const out: AnyRunEvent[] = [{ type: 'run_start', runId }]
  for (const m of live.messages.values()) {
    out.push(m.start)
    if (m.end) {
      out.push(m.end)
      continue
    }
    for (const index of [...m.parts.keys()].sort((a, b) => a - b)) {
      const p = m.parts.get(index)!
      if (p.start) out.push(p.start)
      // Финальная часть с payload — накопленное не нужно.
      if (p.delta && !p.end?.payload) out.push({ type: 'part_delta', runId, messageId: m.start.message.id, part: index, delta: p.text })
      if (p.end) out.push(p.end)
    }
  }
  for (const a of live.asks.values()) out.push(a)
  if (live.activity) out.push(live.activity)
  return out
}

/** Состояние рана по событию (`SessionRun.last`); дельты и служебное — без смены. */
function lastOf(ev: AnyRunEvent, prev: SessionRun['last']): Omit<NonNullable<SessionRun['last']>, 'at'> | undefined {
  switch (ev.type) {
    case 'part_start': {
      const e = ev as PartStartEvent
      const name = typeof e.meta?.name === 'string' ? e.meta.name : undefined
      if (e.partType === 'tool_use') return { kind: 'tool', ...(name ? { name } : {}) }
      if (e.partType === 'tool_result') return { kind: 'result', ...(name ?? prev?.name ? { name: name ?? prev!.name! } : {}) }
      if (e.partType === 'thinking') return { kind: 'thinking' }
      if (e.partType === 'text') return { kind: 'text' }
      return undefined
    }
    case 'ask': {
      return { kind: 'ask', name: (ev as AskEvent).kind }
    }
    case 'activity':
      return { kind: 'activity', name: (ev as ActivityEvent).kind }
    default:
      return undefined
  }
}

function record(live: LiveRun, ev: AnyRunEvent, now: () => number = Date.now): void {
  const next = lastOf(ev, live.last)
  if (next && (next.kind !== live.last?.kind || next.name !== live.last?.name)) live.last = { ...next, at: new Date(now()).toISOString() }
  switch (ev.type) {
    case 'message_start': {
      const e = ev as MessageStartEvent
      live.messages.set(e.message.id, { start: e, parts: new Map() })
      live.openId = e.message.id
      return
    }
    case 'part_start': {
      const e = ev as PartStartEvent
      live.messages.get(e.messageId)?.parts.set(e.part, { start: e, text: '', delta: false })
      return
    }
    case 'part_delta': {
      const e = ev as { messageId: string; part: number; delta: string; mode?: 'append' | 'replace' }
      const m = live.messages.get(e.messageId)
      if (!m) return
      let p = m.parts.get(e.part)
      if (!p) m.parts.set(e.part, (p = { text: '', delta: false }))
      p.text = e.mode === 'replace' ? e.delta : p.text + e.delta
      p.delta = true
      return
    }
    case 'part_end': {
      const e = ev as PartEndEvent
      const m = live.messages.get(e.messageId)
      if (!m) return
      const p = m.parts.get(e.part) ?? { text: '', delta: false }
      p.end = e
      // Финал с payload — сумма дельт больше не нужна.
      if (e.payload) p.text = ''
      m.parts.set(e.part, p)
      return
    }
    case 'message_end': {
      const e = ev as MessageEndEvent
      live.usage = addUsage(live.usage, (e.message.meta as { usage?: unknown } | undefined)?.usage, now())
      // Id мог стабилизироваться на message_end (backend-pi) — тогда закрываем незакрытое.
      const m = live.messages.get(e.message.id) ?? (live.openId ? live.messages.get(live.openId) : undefined)
      if (m) {
        m.end = e
        m.parts.clear()
      }
      if (live.openId === m?.start.message.id || live.openId === e.message.id) live.openId = null
      return
    }
    case 'ask': {
      const e = ev as AskEvent
      live.asks.set(e.askId, e)
      return
    }
    case 'ask_end': {
      live.asks.delete((ev as { askId: string }).askId)
      return
    }
    case 'activity':
      live.activity = ev as ActivityEvent
      return
  }
}

/** `SessionInfo.run` из живого рана. */
function runInfo(live: LiveRun): SessionRun {
  return { id: live.runId, startedAt: live.startedAt, ...(live.asks.size ? { waiting: 'ask' as const } : {}), ...(live.last ? { last: live.last } : {}) }
}

export interface RunAttachOpts {
  /** Часы для `startedAt` (тесты). */
  now?: () => number
}

/** Обёртка уже умеет attach — `serveBackend` не оборачивает её второй раз. */
export function hasRunAttach(backend: ProtocolBackend): boolean {
  return typeof backend.sessions.attach === 'function'
}

export function withRunAttach(backend: ProtocolBackend, opts: RunAttachOpts = {}): ProtocolBackend {
  const now = opts.now ?? Date.now
  const lives = new Map<string, LiveRun>()
  /**
   * Ран начат, а `run_start` ещё не пришёл (сборка промпта, подключение MCP — секунды):
   * `attach` в это окно ждёт регистрации рана, а не отдаёт пустой поток — иначе второе
   * устройство, открытое в первую секунду хода, видит «ран идёт» и молчащий attach.
   */
  const starting = new Map<string, Promise<void>>()

  /** Usage последнего законченного рана сессии — счётчики простаивающего процесса. */
  const lastUsage = new Map<string, UsageSum>()
  const withMetrics = (s: SessionInfo, u: UsageSum | undefined): SessionInfo => {
    const m = usageMetrics(u)
    return m.length ? { ...s, metrics: m } : s
  }
  const withRun = (s: SessionInfo): SessionInfo => {
    const live = lives.get(s.id)
    if (live) return withMetrics({ ...s, run: runInfo(live) }, live.usage ?? lastUsage.get(s.id))
    if (s.run === undefined) return withMetrics(s, lastUsage.get(s.id))
    // Поле осталось от нижнего слоя, а рана здесь нет — не врём.
    const { run: _drop, ...rest } = s
    return withMetrics(rest, lastUsage.get(s.id))
  }

  const broadcast = (live: LiveRun, ev: AnyRunEvent): void => {
    for (const s of live.subs) s.push(ev)
  }

  function run(sid: string, input: RunStartInput): AsyncIterable<AnyRunEvent> {
    // Служебная команда (v1.47) — не «ран сессии»: живым не регистрируется, attach её не видит.
    // Impersonate (`target: user`, v1.19) — тоже: ничего не пишет, ответ — в поле вызвавшей вкладки (// вкладка, подключившись к нему по сигналу активности, рисовала реплику игрока в ленте).
    if (isParallelRun(input) || isImpersonateRun(input)) return backend.run(sid, input)
    return {
      [Symbol.asyncIterator]() {
        let live: LiveRun | undefined
        let primaryGone = false
        const { sub: primary, iterator } = createQueue(() => {
          primaryGone = true
          live?.subs.delete(primary)
        })
        let started = false
        let registered: () => void = () => {}
        const pump = async (): Promise<void> => {
          const ready = new Promise<void>((r) => (registered = r))
          starting.set(sid, ready)
          const it = backend.run(sid, input)[Symbol.asyncIterator]()
          try {
            for (;;) {
              const r = await it.next()
              if (r.done) break
              const ev = r.value
              if (ev.type === 'run_start' && !live && typeof ev.runId === 'string') {
                live = { runId: ev.runId, startedAt: new Date(now()).toISOString(), messages: new Map(), openId: null, asks: new Map(), subs: new Set() }
                if (!primaryGone) live.subs.add(primary)
                lives.set(sid, live)
                if (starting.get(sid) === ready) starting.delete(sid)
                registered()
              }
              if (live) {
                record(live, ev, now)
                broadcast(live, ev)
              } else if (!primaryGone) primary.push(ev)
              if (ev.type === 'run_end') {
                // Итог рана (сумма ходов, контекст последнего) — счётчики до следующего хода.
                const end = ev as { usage?: unknown }
                const sum = addUsage(undefined, end.usage, now()) ?? live?.usage
                if (sum) lastUsage.set(sid, sum)
                break
              }
            }
            // Хвост после run_end (если есть) дочитываем молча: ран закрыт.
            for (;;) {
              const r = await it.next()
              if (r.done) break
            }
          } catch (err) {
            // Авария итератора: начавшему — как было (throw), остальным — run_end{error}.
            if (live) {
              const end: AnyRunEvent = { type: 'run_end', runId: live.runId, status: 'error', error: { message: (err as Error)?.message ?? String(err) }, version: '' }
              for (const s of live.subs) if (s !== primary) s.push(end)
            }
            primary.fail(err)
          } finally {
            if (starting.get(sid) === ready) starting.delete(sid)
            registered()
            if (live) {
              if (lives.get(sid) === live) lives.delete(sid)
              for (const s of live.subs) s.end()
              live.subs.clear()
            }
            primary.end()
          }
        }
        return {
          next() {
            if (!started) {
              started = true
              void pump()
            }
            return iterator.next()
          },
          return: () => iterator.return!(),
        }
      },
    }
  }

  function attach(sid: string): AsyncIterable<AnyRunEvent> {
    const subscribe = (live: LiveRun): AsyncIterator<AnyRunEvent> => {
      const { sub, iterator } = createQueue((s) => live.subs.delete(s))
      for (const ev of snapshot(live)) sub.push(ev)
      live.subs.add(sub)
      return iterator
    }
    const empty: AsyncIterator<AnyRunEvent> = { next: async () => ({ done: true, value: undefined }) }
    return {
      [Symbol.asyncIterator]() {
        const live = lives.get(sid)
        if (live) return subscribe(live)
        const pending = starting.get(sid)
        if (!pending) return empty
        // Ран начат, `run_start` впереди: ждём регистрации (или конца рана без неё).
        let inner: AsyncIterator<AnyRunEvent> | undefined
        let closed = false
        const open = async (): Promise<AsyncIterator<AnyRunEvent>> => {
          if (!inner) {
            await pending
            const l = lives.get(sid)
            inner = l && !closed ? subscribe(l) : empty
          }
          return inner
        }
        return {
          next: async () => (await open()).next(),
          return: async (v?: unknown) => {
            closed = true
            const it = inner
            return it?.return ? it.return(v) : { done: true as const, value: v as AnyRunEvent }
          },
        }
      },
    }
  }

  // Обёртка живая: бэкенд может отдавать группы заново на каждом обращении
  // (переключение пространства, Proxy) — снимок `{...backend}` их заморозил бы.
  const sessionsOver: Record<string, unknown> = {
    list: async (...args: Parameters<ProtocolBackend['sessions']['list']>) => (await backend.sessions.list(...args)).map(withRun),
    get: async (id: string) => withRun(await backend.sessions.get(id)),
    create: async (...args: Parameters<ProtocolBackend['sessions']['create']>) => withRun(await backend.sessions.create(...args)),
    attach,
    // v1.38: запущенные — живые процессы движка (если он их знает) + идущие здесь раны.
    live: async (): Promise<SessionInfo[]> => {
      const own = backend.sessions.live ? await backend.sessions.live() : []
      const seen = new Set(own.map((s) => s.id))
      const extra = await Promise.all(
        [...lives.keys()]
          .filter((id) => !seen.has(id))
          .map((id) => backend.sessions.get(id).catch(() => ({ id }) as SessionInfo)),
      )
      return [...own, ...extra].map(withRun)
    },
  }
  const sessions: ProtocolBackend['sessions'] = new Proxy({} as ProtocolBackend['sessions'], {
    get(_t, prop) {
      if (typeof prop === 'string' && prop in sessionsOver) return sessionsOver[prop]
      const group = backend.sessions
      const v = Reflect.get(group, prop)
      return typeof v === 'function' ? v.bind(group) : v
    },
    has: (_t, prop) => (typeof prop === 'string' && prop in sessionsOver) || prop in backend.sessions,
    ownKeys: () => [...new Set([...Reflect.ownKeys(backend.sessions), ...Object.keys(sessionsOver)])],
    getOwnPropertyDescriptor: (_t, prop): PropertyDescriptor => ({ configurable: true, enumerable: true, writable: false, value: (sessions as unknown as Record<PropertyKey, unknown>)[prop] }),
  })

  const over: Record<string, unknown> = {
    async capabilities(): Promise<Capabilities> {
      const caps = await backend.capabilities()
      return { ...caps, sessions: { ...caps.sessions, attach: true, live: true } }
    },
    sessions,
    run,
    async respond(id: string, askId: string, answer: unknown): Promise<void> {
      await backend.respond!(id, askId, answer)
      const live = lives.get(id)
      if (live?.asks.delete(askId)) broadcast(live, { type: 'ask_end', runId: live.runId, askId })
    },
  }
  const wrapped: ProtocolBackend = new Proxy({} as ProtocolBackend, {
    get(_t, prop) {
      if (prop === 'respond' && !backend.respond) return undefined
      if (typeof prop === 'string' && prop in over) return over[prop]
      const v = Reflect.get(backend, prop)
      return typeof v === 'function' ? v.bind(backend) : v
    },
    has: (_t, prop) => (prop === 'respond' ? !!backend.respond : (typeof prop === 'string' && prop in over) || prop in backend),
    ownKeys: () => [...new Set([...Reflect.ownKeys(backend), ...Object.keys(over).filter((k) => k !== 'respond' || backend.respond)])],
    getOwnPropertyDescriptor: (_t, prop): PropertyDescriptor => ({ configurable: true, enumerable: true, writable: false, value: (wrapped as unknown as Record<PropertyKey, unknown>)[prop] }),
  })
  // Активность сессий (v1.69): раны процесса идут здесь — и сигнал «начался ран» отсюда.
  return withSessionActivity(wrapped, { now })
}
