/**
 * createTauriBackend — сторона webview: Tauri `invoke` + события → ProtocolBackend.
 *
 * Тот же интерфейс, что у бэкенда в sidecar: UI не различает, Tauri это, HTTP
 * или in-process (backends-spec §1). `@tauri-apps/api` не импортируется —
 * `invoke`/`listen` приходят опцией (или из `window.__TAURI__`), поэтому пакет
 * не тянет Tauri в бандл и тестируется без него.
 *
 * Норматив — docs/TRANSPORT.md.
 */

import { NotSupportedError, serviceErrorEvent } from '@kerneldreams/ui-protocol'
import type {
  AnyRunEvent,
  AssetData,
  AttachmentPutResult,
  Capabilities,
  CatalogExtension,
  CatalogSkill,
  CatalogTool,
  FileContent,
  FileEntry,
  FileReadOpts,
  FileSearchHit,
  FileSearchQuery,
  FileWriteOpts,
  HistoryPage,
  Message,
  MessageAppendOpts,
  MessageEditPatch,
  ModelInfo,
  Part,
  Persona,
  PersonasDoc,
  ProfileDoc,
  ProfileInfo,
  ProtocolBackend,
  RunStartInput,
  SessionCreateOpts,
  SessionInfo,
  SessionMetaDoc,
  SessionMetaPatch,
  SessionModel,
  ServiceEvent,
  SwipeTo,
  WorkspaceInfo,
  WorkspaceUpdateEvent,
  WorkspaceUpdateListener,
} from '@kerneldreams/ui-protocol'
import {
  CODE_BAD_REQUEST,
  CODE_CONNECTION_LOST,
  CODE_NOT_FOUND,
  CODE_NOT_SUPPORTED,
  PROTOCOL_CALL_COMMAND,
  PROTOCOL_EVENT,
  STREAM_CLOSE_METHOD,
  base64ToBytes,
  bytesToBase64,
  errorMessage,
  type ProtocolEventPayload,
  type WireEnvelope,
} from './wire.js'

// ────────────────────────────────────────────────────────────────────────────
// Опции
// ────────────────────────────────────────────────────────────────────────────

/** Форма `invoke` из `@tauri-apps/api/core`. */
export type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

/** Форма `listen` из `@tauri-apps/api/event`. */
export type ListenFn = (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>

export interface TauriBackendOpts {
  /** Default — `window.__TAURI__.core.invoke` (`app.withGlobalTauri`). */
  invoke?: InvokeFn
  /** Default — `window.__TAURI__.event.listen`. */
  listen?: ListenFn
  /** Имя команды. Default `protocol_call`. */
  command?: string
  /** Имя события кадров. Default `protocol_event`. */
  event?: string
  /** TTL кэша capabilities, мс. Default — навсегда, до close(). */
  capabilitiesTtl?: number
}

/** Ошибка бэкенда, доехавшая через Envelope. */
export class BackendError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'BackendError'
  }
}

/** Что получает подписчик стрима. */
type StreamItem =
  | { kind: 'event'; event: AnyRunEvent | WorkspaceUpdateEvent | ServiceEvent }
  | { kind: 'end' }
  | { kind: 'lost'; message: string }

// ────────────────────────────────────────────────────────────────────────────
// createTauriBackend
// ────────────────────────────────────────────────────────────────────────────

/**
 * ProtocolBackend поверх `protocol_call`.
 *
 * ```ts
 * import { invoke } from '@tauri-apps/api/core'
 * import { listen } from '@tauri-apps/api/event'
 * const backend = createTauriBackend({ invoke, listen })
 * ```
 *
 * Опциональные методы присутствуют всегда, как у createHttpBackend:
 * capabilities асинхронны, а фабрика синхронна. «Не умею» приезжает
 * NotSupportedError от хоста; UI гасит фичи по capabilities().
 */
export function createTauriBackend(opts: TauriBackendOpts = {}): ProtocolBackend {
  const invoke = opts.invoke ?? globalTauri()?.core?.invoke
  const listen = opts.listen ?? globalTauri()?.event?.listen
  if (typeof invoke !== 'function' || typeof listen !== 'function') {
    throw new Error('createTauriBackend: invoke/listen недоступны — передай opts или включи app.withGlobalTauri')
  }
  const command = opts.command ?? PROTOCOL_CALL_COMMAND
  const eventName = opts.event ?? PROTOCOL_EVENT

  let closed = false
  let capsCache: { value: Capabilities; at: number } | null = null

  const streamPrefix = Math.random().toString(36).slice(2, 10)
  let streamSeq = 0
  /** Открытые стримы: id → получатель кадров. Подписка — ДО вызова, кадры не теряются. */
  const streams = new Map<string, (item: StreamItem) => void>()

  let listening: Promise<void> | undefined
  let unlisten: (() => void) | undefined

  function ensureOpen(): void {
    if (closed) throw new Error('createTauriBackend: backend закрыт (close())')
  }

  /** Один слушатель события на клиент; кадры раздаются по id стрима. */
  function ready(): Promise<void> {
    listening ??= listen!(eventName, (e) => onFrame(e.payload as ProtocolEventPayload)).then(
      (off) => {
        if (closed) off()
        else unlisten = off
      },
      (err: unknown) => {
        listening = undefined
        throw new BackendError(`listen ${eventName}: ${errorMessage(err)}`, CODE_CONNECTION_LOST)
      },
    )
    return listening
  }

  function onFrame(payload: ProtocolEventPayload): void {
    if (payload === null || typeof payload !== 'object') return
    if (payload.type === 'reset') {
      for (const deliver of [...streams.values()]) deliver({ kind: 'lost', message: 'protocol host reset' })
      return
    }
    const deliver = streams.get(payload.stream)
    if (!deliver) return // стрим уже закрыт клиентом — хвост кадров не нужен
    if (payload.type === 'event') deliver({ kind: 'event', event: payload.event })
    else if (payload.type === 'end') deliver({ kind: 'end' })
  }

  function newStreamId(): string {
    return `${streamPrefix}-${++streamSeq}`
  }

  /** Сказать хосту, что стрим больше не нужен (run доигрывает, watch отписывается). */
  function closeStream(id: string): void {
    streams.delete(id)
    void invoke!(command, { method: STREAM_CLOSE_METHOD, args: [id] }).catch(() => {})
  }

  /** Вызов + разбор Envelope. Reject invoke — провод сломан (connection_lost). */
  async function call<T>(method: string, args: unknown[] = []): Promise<T> {
    ensureOpen()
    let envelope: WireEnvelope<T>
    try {
      envelope = (await invoke!(command, { method, args })) as WireEnvelope<T>
    } catch (err) {
      throw new BackendError(`${method}: ${errorMessage(err)}`, CODE_CONNECTION_LOST)
    }
    if (envelope === null || typeof envelope !== 'object' || typeof envelope.ok !== 'boolean') {
      throw new BackendError(`${method}: ответ не Envelope`)
    }
    if (!envelope.ok) throw toError(envelope)
    return envelope.result as T
  }

  const backend: ProtocolBackend = {
    async capabilities(): Promise<Capabilities> {
      const ttl = opts.capabilitiesTtl
      if (capsCache && (ttl === undefined || Date.now() - capsCache.at < ttl)) return capsCache.value
      const value = await call<Capabilities>('capabilities')
      capsCache = { value, at: Date.now() }
      return value
    },

    sessions: {
      list: () => call<SessionInfo[]>('sessions.list'),
      create: (createOpts?: SessionCreateOpts) => call<SessionInfo>('sessions.create', [createOpts ?? {}]),
      get: (id: string) => call<SessionInfo>('sessions.get', [id]),
      delete: (id: string) => call<void>('sessions.delete', [id]),
      fork: (id: string, atMessageId?: string) => call<SessionInfo>('sessions.fork', [id, atMessageId]),
      rename: (id: string, title: string) => call<void>('sessions.rename', [id, title]),
    },

    async history(id: string): Promise<HistoryPage> {
      const page = await call<HistoryPage>('history', [id])
      return { messages: page.messages, version: page.version ?? '' }
    },

    run(id: string, input: RunStartInput): AsyncIterable<AnyRunEvent> {
      return streamRun(id, input)
    },

    cancel: (id: string, runId: string) => call<void>('cancel', [id, runId]),
    respond: (id: string, askId: string, answer: unknown) => call<void>('respond', [id, askId, answer]),

    messages: {
      append: (sid: string, parts: Part[], appendOpts?: MessageAppendOpts) =>
        call<Message>('messages.append', [sid, parts, appendOpts]),
      edit: (sid: string, mid: string, patch: MessageEditPatch) => call<Message>('messages.edit', [sid, mid, patch]),
      delete: (sid: string, mid: string) => call<void>('messages.delete', [sid, mid]),
      hide: (sid: string, mid: string, hidden: boolean) => call<void>('messages.hide', [sid, mid, hidden]),
      swipe: (sid: string, mid: string, to: SwipeTo) => call<Message>('messages.swipe', [sid, mid, to]),
    },

    models: {
      list: () => call<ModelInfo[]>('models.list'),
      set: (sessionId: string, model: SessionModel) => call<SessionModel>('models.set', [sessionId, model]),
    },

    workspace: {
      current: () => call<WorkspaceInfo>('workspace.current'),
      list: () => call<WorkspaceInfo[]>('workspace.list'),
      switch: (id: string) => call<WorkspaceInfo>('workspace.switch', [id]),
      files: {
        list: (path?: string) => call<FileEntry[]>('workspace.files.list', [path]),
        read: (path: string, readOpts?: FileReadOpts) => call<FileContent>('workspace.files.read', [path, readOpts]),
        // revision: null («создать») обязан доехать — JSON его хранит; undefined — поля нет.
        write: (path: string, content: string, writeOpts?: FileWriteOpts) =>
          call<{ revision: string }>('workspace.files.write', [path, content, writeOpts]),
        delete: (path: string) => call<void>('workspace.files.delete', [path]),
        rename: (from: string, to: string) => call<void>('workspace.files.rename', [from, to]),
        stat: (path: string) => call<FileEntry>('workspace.files.stat', [path]),
        search: (q: FileSearchQuery) => call<FileSearchHit[]>('workspace.files.search', [q]),
        watch: (listener: WorkspaceUpdateListener) => watchWorkspace(listener),
      },
    },

    profiles: {
      list: () => call<ProfileInfo[]>('profiles.list'),
      set: (sessionId: string, profile: string | ProfileDoc) => call<ProfileInfo>('profiles.set', [sessionId, profile]),
      get: (id: string) => call<ProfileDoc>('profiles.get', [id]),
      save: (doc: ProfileDoc) => call<ProfileDoc>('profiles.save', [doc]),
      delete: (id: string) => call<void>('profiles.delete', [id]),
      duplicate: (id: string, newId: string) => call<ProfileDoc>('profiles.duplicate', [id, newId]),
    },

    catalogs: {
      tools: () => call<CatalogTool[]>('catalogs.tools'),
      skills: () => call<CatalogSkill[]>('catalogs.skills'),
      extensions: () => call<CatalogExtension[]>('catalogs.extensions'),
    },

    catalog: {
      bots: () => call<unknown[]>('catalog.bots'),
      bot: (id: string) => call<unknown>('catalog.bot', [id]),
      async asset(botId: string, file: string): Promise<AssetData> {
        const wire = await call<{ data: string; mime?: string }>('catalog.asset', [botId, file])
        const data = typeof wire?.data === 'string' ? base64ToBytes(wire.data) : undefined
        if (!data) throw new BackendError('catalog.asset: data не base64')
        return wire.mime !== undefined ? { data, mime: wire.mime } : { data }
      },
    },

    personas: {
      list: (sid: string) => call<PersonasDoc>('personas.list', [sid]),
      save: (sid: string, personas: Persona[], userId?: string) =>
        call<PersonasDoc>('personas.save', [sid, personas, userId]),
    },

    meta: {
      get: (id: string) => call<SessionMetaDoc>('meta.get', [id]),
      patch: (id: string, patch: SessionMetaPatch) => call<SessionMetaDoc>('meta.patch', [id, patch]),
    },

    attachments: {
      put: (sid: string, name: string, data: Uint8Array, mime?: string) =>
        call<AttachmentPutResult>('attachments.put', [sid, name, bytesToBase64(data), mime]),
    },

    // services (plugin-services-spec §2, v1.11): незаявленное — not_supported от хоста.
    services: {
      call: (plugin: string, method: string, args?: unknown) => call<unknown>('services.call', [plugin, method, args]),
      stream: (plugin: string, method: string, args?: unknown) => streamService(plugin, method, args),
    },

    async close(): Promise<void> {
      if (closed) return
      closed = true
      capsCache = null
      // Хосту — закрыть стримы (watch'и в sidecar не должны пережить окно),
      // своим — обрыв: ран на хосте при этом не отменяется (§5.4).
      for (const [id, deliver] of [...streams]) {
        closeStream(id)
        deliver({ kind: 'lost', message: 'backend закрыт' })
      }
      unlisten?.()
      unlisten = undefined
    },
  }

  // ──────────────────────────────────────────────────────────────────────────
  // run — вызов со стримом → AsyncIterable<AnyRunEvent>
  // ──────────────────────────────────────────────────────────────────────────

  async function* streamRun(id: string, input: RunStartInput): AsyncGenerator<AnyRunEvent> {
    ensureOpen()
    await ready()
    const stream = newStreamId()
    const queue = createQueue<StreamItem>()
    streams.set(stream, queue.push)

    let finished = false
    try {
      try {
        await call<void>('run', [id, input ?? {}, stream])
      } catch (err) {
        finished = true // хост стрим не открыл — закрывать нечего
        throw err
      }

      let lastRunId = ''
      let sawRunEnd = false
      for (;;) {
        const item = await queue.next()
        if (item.kind === 'end') break
        if (item.kind === 'lost') {
          finished = true
          yield connectionLost(lastRunId, item.message)
          return
        }
        const event = item.event as AnyRunEvent
        if (typeof event.runId === 'string') lastRunId = event.runId
        if (event.type === 'run_end') sawRunEnd = true
        yield event // неизвестные типы — вверх opaque, не фильтруем (§1.2)
      }
      finished = true
      // Стрим кончился, а run_end не приехал — то же, что обрыв.
      if (!sawRunEnd) yield connectionLost(lastRunId, 'stream ended without run_end')
    } finally {
      // Клиент ушёл посреди стрима (break): хосту — перестать слать. Ран НЕ
      // отменяется (§5.4) — отмена только явным cancel().
      if (!finished && streams.has(stream) && !closed) closeStream(stream)
      streams.delete(stream)
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // services.stream — вызов со стримом → AsyncIterable<ServiceEvent>
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Отказ хоста (not_supported) — throw первого `next()`; `end` — конец;
   * `reset`/закрытие клиента — кадр `error {code: 'connection_lost'}`.
   * `return()` шлёт `stream.close` сразу, даже посреди ожидания кадра.
   */
  function streamService(plugin: string, method: string, args: unknown): AsyncIterable<ServiceEvent> {
    return {
      [Symbol.asyncIterator]() {
        const queue = createQueue<StreamItem>()
        let stream: string | undefined
        let finished = false
        const inner = (async function* (): AsyncGenerator<ServiceEvent, void> {
          ensureOpen()
          await ready()
          const id = newStreamId()
          streams.set(id, queue.push)
          try {
            await call<void>('services.stream', [plugin, method, args, id])
          } catch (err) {
            streams.delete(id)
            finished = true
            throw err
          }
          stream = id
          if (finished) {
            // return() пришёл, пока открывали: хосту — закрыть сразу
            if (!closed) closeStream(id)
            return
          }
          try {
            for (;;) {
              const item = await queue.next()
              if (item.kind === 'end') break
              if (item.kind === 'lost') {
                yield serviceErrorEvent(item.message, CODE_CONNECTION_LOST)
                break
              }
              yield item.event as ServiceEvent
            }
          } finally {
            finished = true
            streams.delete(id)
          }
        })()
        return {
          next: () => inner.next(),
          async return() {
            if (!finished && stream !== undefined && streams.has(stream) && !closed) closeStream(stream)
            finished = true
            queue.push({ kind: 'end' }) // отпустить висящий next()
            await inner.return(undefined).catch(() => {})
            return { value: undefined, done: true }
          },
        }
      },
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // watch — стрим workspace_update с переподключением
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Синхронная подписка (протокол: `watch → unsubscribe`), канал — фоном.
   * Потеря канала (reset хоста, `end`, упавший вызов) — переподписка с backoff,
   * и после любой подписки, кроме первой, подписчик получает `paths: ['']`.
   * not_supported / bad_request / not_found — канала нет и не будет: без ретраев.
   */
  function watchWorkspace(listener: WorkspaceUpdateListener): () => void {
    ensureOpen()
    let active = true
    let current: string | undefined
    let wake: (() => void) | undefined

    const deliver = (event: WorkspaceUpdateEvent) => {
      if (!active) return
      try {
        listener(event)
      } catch {
        // упавший подписчик — его дело, канал живёт
      }
    }

    void (async () => {
      let attempt = 0
      let backoff = 0
      while (active && !closed) {
        if (backoff > 0) {
          await sleep(backoff, (w) => (wake = w))
          if (!active || closed) break
        }
        backoff = Math.min(WATCH_BACKOFF_MAX_MS, backoff ? backoff * 2 : WATCH_BACKOFF_MS)

        const stream = newStreamId()
        let lost!: () => void
        const channel = new Promise<void>((resolve) => (lost = resolve))
        streams.set(stream, (item) => {
          if (item.kind === 'event') deliver(item.event as WorkspaceUpdateEvent)
          else {
            streams.delete(stream)
            lost()
          }
        })

        try {
          await ready()
          await call<void>('workspace.files.watch', [stream])
        } catch (err) {
          streams.delete(stream)
          if (PERMANENT_CODES.has((err as { code?: unknown })?.code as string)) break
          attempt++
          continue
        }
        if (!active || closed) {
          closeStream(stream)
          break
        }

        current = stream
        if (attempt > 0) deliver({ type: 'workspace_update', paths: [''] })
        attempt++
        backoff = WATCH_BACKOFF_MS
        wake = lost
        await channel
        current = undefined
      }
    })()

    return () => {
      if (!active) return
      active = false
      if (current !== undefined && !closed) closeStream(current)
      wake?.()
    }
  }

  return backend
}

// ────────────────────────────────────────────────────────────────────────────
// Хелперы
// ────────────────────────────────────────────────────────────────────────────

/** Первая пауза переподписки watch, мс; дальше — удвоение. */
const WATCH_BACKOFF_MS = 500
const WATCH_BACKOFF_MAX_MS = 30_000

/** Коды, после которых переподписываться бессмысленно. */
const PERMANENT_CODES = new Set([CODE_NOT_SUPPORTED, CODE_BAD_REQUEST, CODE_NOT_FOUND])

interface GlobalTauri {
  core?: { invoke?: InvokeFn }
  event?: { listen?: ListenFn }
}

function globalTauri(): GlobalTauri | undefined {
  return (globalThis as { __TAURI__?: GlobalTauri }).__TAURI__
}

/** Очередь кадров: push синхронный (из слушателя), next — ждёт. */
function createQueue<T>(): { push: (item: T) => void; next: () => Promise<T> } {
  const items: T[] = []
  let waiter: ((item: T) => void) | undefined
  return {
    push(item) {
      if (waiter) {
        const w = waiter
        waiter = undefined
        w(item)
      } else items.push(item)
    },
    next() {
      if (items.length > 0) return Promise.resolve(items.shift()!)
      return new Promise<T>((resolve) => (waiter = resolve))
    },
  }
}

/** Пауза, которую можно оборвать извне (отписка). */
function sleep(ms: number, onWake: (wake: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    onWake(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/** Envelope-ошибка → исключение: not_supported восстанавливается классом (§3.1). */
function toError(envelope: WireEnvelope<unknown>): Error {
  const message = envelope.error ?? 'protocol_call failed'
  if (envelope.code === CODE_NOT_SUPPORTED) return new NotSupportedError(undefined, message)
  return new BackendError(message, envelope.code)
}

/** Синтетический run_end обрыва (§3.2): version неизвестен → ресинк по history. */
function connectionLost(runId: string, message: string): AnyRunEvent {
  return {
    type: 'run_end',
    runId,
    status: 'error',
    error: { message, code: CODE_CONNECTION_LOST },
    version: '',
  }
}
