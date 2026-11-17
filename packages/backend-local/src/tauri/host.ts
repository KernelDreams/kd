/**
 * createProtocolHost — сторона sidecar: `ProtocolBackend` → `protocol_call` +
 * кадры `protocol_event`.
 *
 * Аналог serveBackend без HTTP: оболочка (Rust) пересылает сюда вызов команды
 * и отдаёт обратно ответ, а `emit` превращает в Tauri-событие окна. Вход
 * проверяется до бэкенда теми же правилами, что у serveBackend: webview —
 * граница доверия. Зависимостей на node нет.
 *
 * Норматив — docs/TRANSPORT.md.
 */

import { NotSupportedError, canService, isProfileDoc, serviceErrorEvent } from '@kerneldreams/ui-protocol'
import type {
  AnyRunEvent,
  FileReadOpts,
  FileSearchQuery,
  FileWriteOpts,
  MessageAppendOpts,
  MessageEditPatch,
  Part,
  Persona,
  ProfileDoc,
  ProtocolBackend,
  RunEndEvent,
  RunStartInput,
  SessionCreateOpts,
  SessionMetaPatch,
  SessionModel,
  SwipeTo,
} from '@kerneldreams/ui-protocol'
import {
  CODE_BAD_REQUEST,
  CODE_BUSY,
  CODE_CONNECTION_LOST,
  CODE_NOT_FOUND,
  CODE_NOT_SUPPORTED,
  STREAM_CLOSE_METHOD,
  base64ToBytes,
  bytesToBase64,
  errorMessage,
  type ProtocolCall,
  type ProtocolEventPayload,
  type WireEnvelope,
} from './wire.js'

export interface ProtocolHostOpts {
  /** Отправить кадр в окно (Tauri `emit(PROTOCOL_EVENT, payload)`). Бросил — стрим считается брошенным. */
  emit: (payload: ProtocolEventPayload) => void
}

export interface ProtocolHost {
  /** Обработать один `protocol_call`. Не бросает: любая ошибка — `ok:false`. */
  call(request: ProtocolCall): Promise<WireEnvelope>
  /** Живые стримы (run и watch) — для диагностики и тестов. */
  readonly openStreams: number
  /**
   * Закрыть все стримы: каждому — кадр `end`, watch'и отписаны, раны
   * дочитываются молча. `backend.close()` не трогает — жизнь бэкенда чужая.
   */
  close(): void
}

/** Ошибка провода с кодом (не путать с ошибкой бэкенда). */
class WireError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'WireError'
  }
}

type Args = unknown[]
type Handler = (args: Args) => Promise<unknown>

/** Стрим хоста: `stop` снимает его без кадра `end`. */
interface HostStream {
  stop(): void
  /** Кадр перед `end` при `close()` хоста: стрим сервиса оборван, а не кончился. */
  lastWords?: ProtocolEventPayload
}

export function createProtocolHost(backend: ProtocolBackend, opts: ProtocolHostOpts): ProtocolHost {
  const streams = new Map<string, HostStream>()
  /** Сессии с живым раном: второй run — busy до бэкенда, как у serveBackend. */
  const activeRuns = new Set<string>()
  let closed = false

  function emit(payload: ProtocolEventPayload): boolean {
    try {
      opts.emit(payload)
      return true
    } catch {
      return false
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Таблица операций: имя → проверка аргументов → метод бэкенда
  // ──────────────────────────────────────────────────────────────────────────

  const files = () => backend.workspace?.files

  const handlers: Record<string, Handler> = {
    capabilities: async () => backend.capabilities(),

    'sessions.list': async () => backend.sessions.list(),
    'sessions.create': async (a) => {
      const body = optObject<SessionCreateOpts>(a[0], 'sessions.create: opts') ?? {}
      if (
        body.profile !== undefined &&
        !(typeof body.profile === 'string' && body.profile !== '') &&
        !isProfileDoc(body.profile)
      ) {
        throw badRequest('sessions.create: profile must be a non-empty string or a profile document {name}')
      }
      return backend.sessions.create(body)
    },
    'sessions.get': async (a) => backend.sessions.get(str(a[0], 'sessions.get: id')),
    'sessions.delete': async (a) => {
      await backend.sessions.delete(str(a[0], 'sessions.delete: id'))
    },
    'sessions.fork': async (a) => {
      const id = str(a[0], 'sessions.fork: id')
      const at = optStr(a[1], 'sessions.fork: atMessageId')
      if (!backend.sessions.fork) throw new NotSupportedError('sessions.fork')
      return backend.sessions.fork(id, at)
    },
    'sessions.rename': async (a) => {
      const id = str(a[0], 'sessions.rename: id')
      if (typeof a[1] !== 'string') throw badRequest('sessions.rename: title must be a string')
      if (!backend.sessions.rename) throw new NotSupportedError('sessions.rename')
      await backend.sessions.rename(id, a[1])
    },

    history: async (a) => backend.history(str(a[0], 'history: id')),

    cancel: async (a) => {
      await backend.cancel(str(a[0], 'cancel: id'), str(a[1], 'cancel: runId'))
    },
    respond: async (a) => {
      const id = str(a[0], 'respond: id')
      const askId = str(a[1], 'respond: askId')
      if (!backend.respond) throw new NotSupportedError('respond')
      await backend.respond(id, askId, a[2])
    },

    'messages.append': async (a) => {
      const sid = str(a[0], 'messages.append: sid')
      const parts = a[1]
      if (!Array.isArray(parts) || parts.length === 0) throw badRequest('messages.append: parts must be a non-empty array')
      if (!parts.every((p) => typeof p === 'object' && p !== null && typeof (p as { type?: unknown }).type === 'string')) {
        throw badRequest('messages.append: every part requires type:string')
      }
      const appendOpts = optObject<MessageAppendOpts>(a[2], 'messages.append: opts')
      if (appendOpts?.role !== undefined && appendOpts.role !== 'user' && appendOpts.role !== 'assistant') {
        throw badRequest("messages.append: role must be 'user' or 'assistant'")
      }
      if (appendOpts?.swipeOf !== undefined) str(appendOpts.swipeOf, 'messages.append: swipeOf')
      if (!backend.messages?.append) throw new NotSupportedError('messages.append')
      return backend.messages.append(sid, parts as Part[], appendOpts)
    },
    'messages.edit': async (a) => {
      const sid = str(a[0], 'messages.edit: sid')
      const mid = str(a[1], 'messages.edit: mid')
      const patch = object<MessageEditPatch>(a[2], 'messages.edit: patch')
      if (!backend.messages?.edit) throw new NotSupportedError('messages.edit')
      return backend.messages.edit(sid, mid, patch)
    },
    'messages.delete': async (a) => {
      const sid = str(a[0], 'messages.delete: sid')
      const mid = str(a[1], 'messages.delete: mid')
      if (!backend.messages?.delete) throw new NotSupportedError('messages.delete')
      await backend.messages.delete(sid, mid)
    },
    'messages.hide': async (a) => {
      const sid = str(a[0], 'messages.hide: sid')
      const mid = str(a[1], 'messages.hide: mid')
      if (typeof a[2] !== 'boolean') throw badRequest('messages.hide: hidden must be a boolean')
      if (!backend.messages?.hide) throw new NotSupportedError('messages.hide')
      await backend.messages.hide(sid, mid, a[2])
    },
    'messages.swipe': async (a) => {
      const sid = str(a[0], 'messages.swipe: sid')
      const mid = str(a[1], 'messages.swipe: mid')
      const to = object<SwipeTo>(a[2], 'messages.swipe: to')
      if (!backend.messages?.swipe) throw new NotSupportedError('messages.swipe')
      return backend.messages.swipe(sid, mid, to)
    },

    'models.list': async () => {
      if (!backend.models) throw new NotSupportedError('models.list')
      return backend.models.list()
    },
    'models.set': async (a) => {
      const sid = str(a[0], 'models.set: sid')
      const model = object<SessionModel>(a[1], 'models.set: model')
      if (typeof model.model !== 'string' || model.model === '') throw badRequest('models.set requires model:string')
      if (model.thinking !== undefined && typeof model.thinking !== 'string') {
        throw badRequest('models.set: thinking must be a string')
      }
      if (!backend.models?.set) throw new NotSupportedError('models.set')
      return backend.models.set(sid, model)
    },

    'workspace.current': async () => {
      if (!backend.workspace) throw new NotSupportedError('workspace.current')
      return backend.workspace.current()
    },
    'workspace.list': async () => {
      if (!backend.workspace) throw new NotSupportedError('workspace.list')
      return backend.workspace.list()
    },
    'workspace.switch': async (a) => {
      const id = str(a[0], 'workspace.switch: id')
      if (!backend.workspace?.switch) throw new NotSupportedError('workspace.switch')
      return backend.workspace.switch(id)
    },

    'workspace.files.list': async (a) => {
      const path = optStr(a[0], 'workspace.files.list: path', true)
      const f = files()
      if (!f) throw new NotSupportedError('workspace.files.list')
      return f.list(path)
    },
    'workspace.files.read': async (a) => {
      const path = str(a[0], 'workspace.files.read: path')
      const readOpts = optObject<FileReadOpts>(a[1], 'workspace.files.read: opts')
      if (readOpts?.maxBytes !== undefined && !(Number.isInteger(readOpts.maxBytes) && readOpts.maxBytes >= 0)) {
        throw badRequest('workspace.files.read: maxBytes must be a non-negative integer')
      }
      const f = files()
      if (!f) throw new NotSupportedError('workspace.files.read')
      return f.read(path, readOpts)
    },
    'workspace.files.write': async (a) => {
      const path = str(a[0], 'workspace.files.write: path')
      if (typeof a[1] !== 'string') throw badRequest('workspace.files.write: content must be a string')
      const writeOpts = optObject<FileWriteOpts>(a[2], 'workspace.files.write: opts') ?? {}
      if (writeOpts.encoding !== undefined && writeOpts.encoding !== 'utf8' && writeOpts.encoding !== 'base64') {
        throw badRequest("workspace.files.write: encoding must be 'utf8' or 'base64'")
      }
      if (writeOpts.revision !== undefined && writeOpts.revision !== null && typeof writeOpts.revision !== 'string') {
        throw badRequest('workspace.files.write: revision must be a string or null')
      }
      const f = files()
      if (!f?.write) throw new NotSupportedError('workspace.files.write')
      return f.write(path, a[1], writeOpts)
    },
    'workspace.files.delete': async (a) => {
      const path = str(a[0], 'workspace.files.delete: path')
      const f = files()
      if (!f?.delete) throw new NotSupportedError('workspace.files.delete')
      await f.delete(path)
    },
    'workspace.files.rename': async (a) => {
      const from = str(a[0], 'workspace.files.rename: from')
      const to = str(a[1], 'workspace.files.rename: to')
      const f = files()
      if (!f?.rename) throw new NotSupportedError('workspace.files.rename')
      await f.rename(from, to)
    },
    'workspace.files.stat': async (a) => {
      const path = optStr(a[0], 'workspace.files.stat: path', true) ?? ''
      const f = files()
      if (!f?.stat) throw new NotSupportedError('workspace.files.stat')
      return f.stat(path)
    },
    'workspace.files.search': async (a) => {
      const q = optObject<FileSearchQuery>(a[0], 'workspace.files.search: query')
      const f = files()
      if (!f?.search) throw new NotSupportedError('workspace.files.search')
      return f.search(q as FileSearchQuery)
    },
    'workspace.files.watch': async (a) => watchFiles(a),

    'profiles.list': async () => {
      if (!backend.profiles) throw new NotSupportedError('profiles.list')
      return backend.profiles.list()
    },
    'profiles.set': async (a) => {
      const sid = str(a[0], 'profiles.set: sid')
      const byId = typeof a[1] === 'string' && a[1] !== ''
      if (!byId && !isProfileDoc(a[1])) throw badRequest('profiles.set: profile must be an id or a profile document {name}')
      if (!backend.profiles?.set) throw new NotSupportedError('profiles.set')
      return backend.profiles.set(sid, a[1] as string | ProfileDoc)
    },
    'profiles.get': async (a) => {
      const id = str(a[0], 'profiles.get: id')
      if (!backend.profiles) throw new NotSupportedError('profiles.get')
      return backend.profiles.get(id)
    },
    'profiles.save': async (a) => {
      const doc = object<ProfileDoc>(a[0], 'profiles.save: doc')
      if (typeof doc.name !== 'string') throw badRequest('profiles.save requires name:string')
      if (!backend.profiles?.save) throw new NotSupportedError('profiles.save')
      return backend.profiles.save(doc)
    },
    'profiles.delete': async (a) => {
      const id = str(a[0], 'profiles.delete: id')
      if (!backend.profiles?.delete) throw new NotSupportedError('profiles.delete')
      await backend.profiles.delete(id)
    },
    'profiles.duplicate': async (a) => {
      const id = str(a[0], 'profiles.duplicate: id')
      const newId = str(a[1], 'profiles.duplicate: newId')
      if (!backend.profiles?.duplicate) throw new NotSupportedError('profiles.duplicate')
      return backend.profiles.duplicate(id, newId)
    },

    'catalogs.tools': async () => {
      if (!backend.catalogs?.tools) throw new NotSupportedError('catalogs.tools')
      return backend.catalogs.tools()
    },
    'catalogs.skills': async () => {
      if (!backend.catalogs?.skills) throw new NotSupportedError('catalogs.skills')
      return backend.catalogs.skills()
    },
    'catalogs.extensions': async () => {
      if (!backend.catalogs?.extensions) throw new NotSupportedError('catalogs.extensions')
      return backend.catalogs.extensions()
    },

    'catalog.bots': async () => {
      if (!backend.catalog) throw new NotSupportedError('catalog.bots')
      return backend.catalog.bots()
    },
    'catalog.bot': async (a) => {
      const id = str(a[0], 'catalog.bot: id')
      if (!backend.catalog) throw new NotSupportedError('catalog.bot')
      return backend.catalog.bot(id)
    },
    // Байты едут base64: провод invoke — JSON.
    'catalog.asset': async (a) => {
      const botId = str(a[0], 'catalog.asset: botId')
      const file = str(a[1], 'catalog.asset: file')
      if (!backend.catalog?.asset) throw new NotSupportedError('catalog.asset')
      const asset = await backend.catalog.asset(botId, file)
      return { data: bytesToBase64(asset.data), ...(asset.mime !== undefined ? { mime: asset.mime } : {}) }
    },

    'personas.list': async (a) => {
      const sid = str(a[0], 'personas.list: sid')
      if (!backend.personas) throw new NotSupportedError('personas.list')
      return backend.personas.list(sid)
    },
    'personas.save': async (a) => {
      const sid = str(a[0], 'personas.save: sid')
      if (!Array.isArray(a[1])) throw badRequest('personas.save: personas must be an array')
      const userId = optStr(a[2], 'personas.save: userId')
      if (!backend.personas?.save) throw new NotSupportedError('personas.save')
      return backend.personas.save(sid, a[1] as Persona[], userId)
    },

    'meta.get': async (a) => {
      const id = str(a[0], 'meta.get: id')
      if (!backend.meta) throw new NotSupportedError('meta.get')
      return backend.meta.get(id)
    },
    'meta.patch': async (a) => {
      const id = str(a[0], 'meta.patch: id')
      const patch = object<SessionMetaPatch>(a[1], 'meta.patch: patch')
      if (!backend.meta) throw new NotSupportedError('meta.patch')
      return backend.meta.patch(id, patch)
    },

    'attachments.put': async (a) => {
      const sid = str(a[0], 'attachments.put: sid')
      const name = str(a[1], 'attachments.put: name')
      if (typeof a[2] !== 'string') throw badRequest('attachments.put: data must be a base64 string')
      const data = base64ToBytes(a[2])
      if (!data) throw badRequest('attachments.put: data is not valid base64')
      const mime = optStr(a[3], 'attachments.put: mime')
      if (!backend.attachments) throw new NotSupportedError('attachments.put')
      return backend.attachments.put(sid, name, data, mime)
    },

    run: async (a) => startRun(a),

    'services.call': async (a) => {
      const plugin = str(a[0], 'services.call: plugin')
      const method = str(a[1], 'services.call: method')
      if (!backend.services) throw new NotSupportedError('services.call')
      return backend.services.call(plugin, method, a[2] ?? undefined)
    },
    'services.stream': async (a) => streamService(a),

    [STREAM_CLOSE_METHOD]: async (a) => {
      const id = str(a[0], `${STREAM_CLOSE_METHOD}: stream`)
      streams.get(id)?.stop()
      streams.delete(id)
    },
  }

  // ──────────────────────────────────────────────────────────────────────────
  // run → кадры стрима
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Ответ на `run` уходит после ПЕРВОГО события: авария до старта — ошибкой
   * вызова (как Envelope до SSE у serveBackend), после — кадром
   * `run_end{status:'error'}`. Клиент подписан на кадры до вызова, поэтому
   * порядок «ответ ↔ первый кадр» ему не важен.
   */
  async function startRun(a: Args): Promise<void> {
    const sid = str(a[0], 'run: id')
    const input = optObject<RunStartInput>(a[1], 'run: input') ?? {}
    const stream = streamIdOf(a[2], 'run')
    if (activeRuns.has(sid)) throw new WireError(`Session ${sid} already has an active run`, CODE_BUSY)
    activeRuns.add(sid)

    let iter: AsyncIterator<AnyRunEvent>
    let first: IteratorResult<AnyRunEvent>
    try {
      iter = backend.run(sid, input)[Symbol.asyncIterator]()
      first = await iter.next()
    } catch (err) {
      activeRuns.delete(sid)
      throw err
    }

    // §5.4: брошенный стрим ран не отменяет — итератор дочитывается молча.
    let gone = false
    streams.set(stream, { stop: () => (gone = true) })
    const send = (payload: ProtocolEventPayload) => {
      if (!gone && !emit(payload)) gone = true
    }

    void (async () => {
      let lastRunId = ''
      try {
        for (let next = first; !next.done; next = await iter.next()) {
          if (typeof next.value.runId === 'string') lastRunId = next.value.runId
          send({ stream, type: 'event', event: next.value })
        }
      } catch (err) {
        const code = err instanceof NotSupportedError ? CODE_NOT_SUPPORTED : errorCode(err)
        const runEnd: RunEndEvent = {
          type: 'run_end',
          runId: lastRunId,
          status: 'error',
          error: { message: errorMessage(err), ...(code !== undefined ? { code } : {}) },
          version: '', // токен неизвестен: ран умер на полуслове, клиент ресинкается
        }
        send({ stream, type: 'event', event: runEnd })
      } finally {
        activeRuns.delete(sid)
        if (streams.get(stream) !== undefined) {
          send({ stream, type: 'end' })
          streams.delete(stream)
        }
      }
    })()
  }

  // ──────────────────────────────────────────────────────────────────────────
  // workspace.files.watch → кадры стрима
  // ──────────────────────────────────────────────────────────────────────────

  function watchFiles(a: Args): void {
    const stream = streamIdOf(a[0], 'workspace.files.watch')
    const f = files()
    if (!f?.watch) throw new NotSupportedError('workspace.files.watch')
    let active = true
    const off = f.watch.call(f, (event) => {
      if (active && !emit({ stream, type: 'event', event })) stop()
    })
    function stop(): void {
      if (!active) return
      active = false
      streams.delete(stream)
      off()
    }
    streams.set(stream, { stop })
  }

  // ──────────────────────────────────────────────────────────────────────────
  // services.stream → кадры стрима (plugin-services-spec §2)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Незаявленный стрим — ошибка вызова (гейт по capability: стрим вправе
   * молчать, ждать первого кадра нельзя). Ответ — сразу после открытия;
   * throw посреди — кадр `error`, затем `end`. `stream.close` — `return()`
   * итератора: сервису abort.
   */
  async function streamService(a: Args): Promise<void> {
    const plugin = str(a[0], 'services.stream: plugin')
    const method = str(a[1], 'services.stream: method')
    const args = a[2] ?? undefined
    const stream = streamIdOf(a[3], 'services.stream')
    if (!backend.services) throw new NotSupportedError('services.stream')
    if (!canService(await backend.capabilities(), plugin, method, 'stream')) {
      throw new NotSupportedError('services.stream', `Service stream not declared: ${plugin}.${method}`)
    }
    if (streams.has(stream)) throw badRequest(`services.stream: stream ${stream} is already open`)
    const iter = backend.services.stream(plugin, method, args)[Symbol.asyncIterator]()

    let gone = false
    const stop = () => {
      if (gone) return
      gone = true
      streams.delete(stream)
      void Promise.resolve(iter.return?.()).catch(() => {})
    }
    streams.set(stream, {
      stop,
      lastWords: {
        stream,
        type: 'event',
        event: serviceErrorEvent('protocol host closed', CODE_CONNECTION_LOST),
      },
    })
    const send = (payload: ProtocolEventPayload) => {
      if (!gone && !emit(payload)) stop()
    }

    void (async () => {
      try {
        for (;;) {
          const next = await iter.next()
          if (next.done || gone) break
          send({ stream, type: 'event', event: next.value })
        }
      } catch (err) {
        send({ stream, type: 'event', event: serviceErrorEvent(err, err instanceof NotSupportedError ? CODE_NOT_SUPPORTED : undefined) })
      } finally {
        if (!gone) {
          send({ stream, type: 'end' })
          gone = true
          streams.delete(stream)
        }
      }
    })()
  }

  function streamIdOf(value: unknown, op: string): string {
    const id = str(value, `${op}: stream`)
    if (streams.has(id)) throw badRequest(`${op}: stream ${id} is already open`)
    return id
  }

  // ──────────────────────────────────────────────────────────────────────────

  return {
    async call(request: ProtocolCall): Promise<WireEnvelope> {
      try {
        if (closed) throw new WireError('protocol host is closed', CODE_NOT_FOUND)
        if (request === null || typeof request !== 'object' || typeof request.method !== 'string') {
          throw badRequest('protocol_call requires method:string')
        }
        const args = request.args ?? []
        if (!Array.isArray(args)) throw badRequest('protocol_call: args must be an array')
        const handler = Object.hasOwn(handlers, request.method) ? handlers[request.method] : undefined
        if (!handler) throw new WireError(`No operation ${request.method}`, CODE_NOT_FOUND)
        const result = await handler(args)
        return result === undefined ? { ok: true } : { ok: true, result }
      } catch (err) {
        return errorEnvelope(err)
      }
    },

    get openStreams() {
      return streams.size
    },

    close(): void {
      if (closed) return
      closed = true
      for (const [id, s] of [...streams]) {
        s.stop()
        if (s.lastWords) emit(s.lastWords)
        emit({ stream: id, type: 'end' })
      }
      streams.clear()
    },
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Аргументы и ошибки
// ────────────────────────────────────────────────────────────────────────────

function badRequest(message: string): WireError {
  return new WireError(message, CODE_BAD_REQUEST)
}

function str(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') throw badRequest(`${what} must be a non-empty string`)
  return value
}

/** Необязательная строка: JSON превращает `undefined` в позиционном аргументе в `null`. */
function optStr(value: unknown, what: string, allowEmpty = false): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || (!allowEmpty && value === '')) throw badRequest(`${what} must be a string`)
  return value
}

function object<T>(value: unknown, what: string): T {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw badRequest(`${what} must be an object`)
  return value as T
}

function optObject<T>(value: unknown, what: string): T | undefined {
  return value === undefined || value === null ? undefined : object<T>(value, what)
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && code !== '' ? code : undefined
}

/** Ошибка → Envelope (backends-spec §3.1): код не теряется, прочее — без кода. */
function errorEnvelope(err: unknown): WireEnvelope<never> {
  if (err instanceof NotSupportedError) return { ok: false, error: err.message, code: CODE_NOT_SUPPORTED }
  const code = errorCode(err)
  return code !== undefined ? { ok: false, error: errorMessage(err), code } : { ok: false, error: errorMessage(err) }
}
