/**
 * createFetchHandler — ядро провода на Web `Request`/`Response` (board-edge-spec §5.2).
 *
 * Ядро провода = всё, что отдаёт `createStoreBackend`: capabilities, сессии и мета,
 * ран и SSE, подключение к идущему рану, abort, ответы на ask, steer, форк/свайпы,
 * сообщения и вложения, сервисы, модели, агенты (профили) и их каталоги.
 * Внутри — ни одного Node API: тот же код пойдёт в Cloudflare Worker (T3).
 * Node-`serveBackend` зовёт его же для этих маршрутов; файлы, проекты, хаб,
 * пользователи, PTY, скины, плагины, настройки, `files.external` — Node-only (README).
 *
 * Канон: nr-engine/docs/specs/nr-ui-protocol-spec.md §9.
 */

import { hasRunAttach, withRunAttach } from './run-attach.js'
import { stripGuess } from './devices.js'
import {
  NotSupportedError,
  SERVICE_HTTP_METHOD,
  canService,
  isParallelRun,
  isProfileDoc,
  serializeRunEvent,
  serializeServiceEnd,
  serializeServiceEvent,
  serializeServiceMux,
  serviceErrorEvent,
  validatePersonas,
} from '@kerneldreams/ui-protocol'
import type {
  AnyRunEvent,
  ServiceEvent,
  Capabilities,
  MessageAppendOpts,
  MessageEditPatch,
  Part,
  Persona,
  ProfileDoc,
  ProtocolBackend,
  RunEndEvent,
  RunStartInput,
  ServiceHttpRequest,
  ServiceHttpResponse,
  SessionCreateOpts,
  SessionMetaPatch,
  SessionModel,
  SessionShare,
  SwipeTo,
} from '@kerneldreams/ui-protocol'
import {
  CODE_BAD_REQUEST,
  CODE_BUSY,
  CODE_FORBIDDEN,
  CODE_NOT_FOUND,
  CODE_NOT_SUPPORTED,
  CODE_UNAUTHORIZED,
  errorMessage,
  normalizeBasePath,
  type WireEnvelope,
} from './wire.js'

// ────────────────────────────────────────────────────────────────────────────
// Опции
// ────────────────────────────────────────────────────────────────────────────

export interface FetchHandlerOpts {
  /** CORS-заголовки + preflight. Default false. */
  cors?: boolean
  /** Префикс всех роутов: '/api' → '/api/sessions'. Default ''. */
  basePath?: string
  /** Максимальный размер тела запроса, байт. Default 10 МБ. */
  maxBodyBytes?: number
  /** Ключ доступа: `Authorization: Bearer <ключ>` либо `?auth=<ключ>`, иначе 401. */
  authKey?: string
  /** Достроить capabilities поверх `backend.capabilities()` (транспорт заявляет своё). */
  capabilities?: (caps: Capabilities, request: Request) => Capabilities | Promise<Capabilities>
  /**
   * Доправить `client` рана по запросу (v1.62): догадку по браузеру — именем машины
   * по адресу. Нет — флаг `guess` просто снимается.
   */
  client?: (client: NonNullable<RunStartInput['client']>, request: Request) => RunStartInput['client']
}

/** Ядро провода без разбора адреса: Node-сервер зовёт его после своих маршрутов и гейта. */
export interface WireCore {
  /** Маршрут ядра → `Response`; не маршрут ядра — `null`. Ошибки до ответа — throw (`errorResponse`). */
  route(backend: ProtocolBackend, request: Request, segs: string[], query: URLSearchParams): Promise<Response | null>
}

/** Ошибка транспорта с кодом для Envelope (не путать с ошибкой бэкенда). */
export class WireError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'WireError'
  }
}

export const MAX_BODY_BYTES = 10 * 1024 * 1024

/** Keepalive-комментарий долгих SSE-каналов, мс. */
export const SSE_KEEPALIVE_MS = 25_000

const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no', // прокси не должен буферить кадры
}

const enc = new TextEncoder()

// ────────────────────────────────────────────────────────────────────────────
// createFetchHandler
// ────────────────────────────────────────────────────────────────────────────

/**
 * Обработчик провода для любой среды с Web Fetch (Worker, Deno, Bun, Node).
 *
 * ```ts
 * const handle = createFetchHandler(backend, { basePath: '/api' })
 * export default { fetch: handle }
 * ```
 */
export function createFetchHandler(
  givenBackend: ProtocolBackend,
  opts: FetchHandlerOpts = {},
): (request: Request) => Promise<Response> {
  const backend = hasRunAttach(givenBackend) ? givenBackend : withRunAttach(givenBackend)
  const basePath = normalizeBasePath(opts.basePath)
  const cors = opts.cors ?? false
  const authKey = opts.authKey === '' ? undefined : opts.authKey
  const core = createWireCore(opts)

  return async (request) => {
    if (cors && request.method === 'OPTIONS') return preflight(request)
    const url = new URL(request.url)
    if (authKey !== undefined && !keyMatches(request.headers.get('authorization'), url.searchParams, authKey)) {
      return envelope(401, { ok: false, error: 'unauthorized: нужен ключ (Authorization: Bearer …)', code: CODE_UNAUTHORIZED }, cors, { 'www-authenticate': 'Bearer' })
    }
    const segs = routeSegments(url.pathname, basePath)
    if (!segs) return envelope(404, { ok: false, error: `No route for ${url.pathname}`, code: CODE_NOT_FOUND }, cors)
    try {
      const res = await core.route(backend, request, segs, url.searchParams)
      if (res) return res
      throw new WireError(`No route for ${request.method} /${segs.join('/')}`, CODE_NOT_FOUND, 404)
    } catch (err) {
      return errorResponse(err, cors)
    }
  }
}

/** Ядро провода: одно на сервер (один активный ран на сессию — его состояние). */
export function createWireCore(opts: Pick<FetchHandlerOpts, 'cors' | 'maxBodyBytes' | 'capabilities' | 'client'> = {}): WireCore {
  const cors = opts.cors ?? false
  const maxBody = opts.maxBodyBytes ?? MAX_BODY_BYTES

  /** Сессии с живым раном (§10.1: один активный run на сессию). */
  const activeRuns = new Set<string>()

  const ok = <T>(result?: T, version?: string): Response => envelope(200, { ok: true, result, version }, cors)
  const json = <T>(req: Request): Promise<T> => readJson<T>(req, maxBody)

  async function route(backend: ProtocolBackend, req: Request, segs: string[], query: URLSearchParams): Promise<Response | null> {
    const method = req.method

    // GET /capabilities
    if (segs.length === 1 && segs[0] === 'capabilities' && method === 'GET') {
      let caps = await backend.capabilities()
      if (opts.capabilities) caps = await opts.capabilities(caps, req)
      return ok(caps)
    }

    if (segs[0] === 'sessions') return sessions(backend, req, method, segs, query)

    // GET /models (models-spec §4)
    if (segs.length === 1 && segs[0] === 'models' && method === 'GET') {
      if (!backend.models) throw new NotSupportedError('models.list')
      return ok(await backend.models.list())
    }

    // GET /profiles (profiles-spec §4)
    if (segs.length === 1 && segs[0] === 'profiles' && method === 'GET') {
      if (!backend.profiles) throw new NotSupportedError('profiles.list')
      // ?workspace= — каталог глазами проекта клиента (v1.27); без параметра — как раньше.
      return ok(await backend.profiles.list(profilesQuery(query)))
    }

    // GET/PUT/DELETE /profiles/:id (profile-editor-spec §3)
    if (segs.length === 2 && segs[0] === 'profiles') {
      const id = segs[1]!
      if (method === 'GET') {
        if (!backend.profiles) throw new NotSupportedError('profiles.get')
        return ok(await backend.profiles.get(id, profilesQuery(query)))
      }
      if (method === 'PUT') {
        // id документа — адрес: тело без id берёт его отсюда, чужой id — отказ,
        // иначе PUT /profiles/a молча писал бы профиль b.
        const body = await json<Partial<ProfileDoc>>(req)
        if (body.id !== undefined && body.id !== id) {
          throw badRequest(`save: id в теле (${String(body.id)}) не совпадает с адресом (${id})`)
        }
        if (typeof body.name !== 'string') throw badRequest('save requires name:string')
        if (!backend.profiles?.save) throw new NotSupportedError('profiles.save')
        return ok(await backend.profiles.save({ ...body, id } as ProfileDoc))
      }
      if (method === 'DELETE') {
        if (!backend.profiles?.delete) throw new NotSupportedError('profiles.delete')
        await backend.profiles.delete(id)
        return ok()
      }
      throw methodNotAllowed(method, '/profiles/:id')
    }

    // POST /profiles/:id/duplicate {id} (profile-editor-spec §3)
    if (segs.length === 3 && segs[0] === 'profiles' && segs[2] === 'duplicate' && method === 'POST') {
      const body = await json<{ id?: unknown }>(req)
      if (typeof body.id !== 'string' || body.id === '') throw badRequest('duplicate requires id:string')
      if (!backend.profiles?.duplicate) throw new NotSupportedError('profiles.duplicate')
      return ok(await backend.profiles.duplicate(segs[1]!, body.id))
    }

    // GET /catalogs/{tools,skills,extensions} (profile-editor-spec §3)
    if (segs.length === 2 && segs[0] === 'catalogs' && method === 'GET') {
      const catalogs = backend.catalogs
      if (segs[1] === 'tools') {
        if (!catalogs?.tools) throw new NotSupportedError('catalogs.tools')
        return ok(await catalogs.tools())
      }
      if (segs[1] === 'skills') {
        if (!catalogs?.skills) throw new NotSupportedError('catalogs.skills')
        return ok(await catalogs.skills())
      }
      if (segs[1] === 'extensions') {
        if (!catalogs?.extensions) throw new NotSupportedError('catalogs.extensions')
        return ok(await catalogs.extensions())
      }
    }

    // GET|HEAD /services/:plugin/http/<путь> (v1.14) — метод сервиса `http`
    if (segs[0] === 'services' && segs.length >= 3 && segs[2] === SERVICE_HTTP_METHOD && (method === 'GET' || method === 'HEAD')) {
      if (!backend.services) throw new NotSupportedError('services.call')
      return serviceHttp(backend, req, method, segs[1]!, segs.slice(3), query)
    }

    // POST /services/_mux/stream (v1.68) — все подписки вкладки одним SSE
    if (segs[0] === 'services' && segs[1] === '_mux' && segs[2] === 'stream' && segs.length === 3) {
      if (method !== 'POST') throw methodNotAllowed(method, '/services/_mux/stream')
      if (!backend.services) throw new NotSupportedError('services.stream')
      const body = await json<{ streams?: Array<{ key?: unknown; plugin?: unknown; method?: unknown; args?: unknown }> }>(req)
      const streams = (Array.isArray(body.streams) ? body.streams : []).filter(
        (x): x is { key: string; plugin: string; method: string; args?: unknown } =>
          typeof x?.key === 'string' && typeof x.plugin === 'string' && typeof x.method === 'string',
      )
      return muxServices(backend, streams)
    }

    // POST /services/:plugin/:method[/stream] (plugin-services-spec §2, v1.11)
    if (segs[0] === 'services' && (segs.length === 3 || (segs.length === 4 && segs[3] === 'stream'))) {
      const streaming = segs.length === 4
      if (method !== 'POST') throw methodNotAllowed(method, `/services/:plugin/:method${streaming ? '/stream' : ''}`)
      const plugin = segs[1]!
      const name = segs[2]!
      const body = await json<{ args?: unknown }>(req)
      if (!backend.services) throw new NotSupportedError(streaming ? 'services.stream' : 'services.call')
      if (!streaming) return ok(await backend.services.call(plugin, name, body.args))
      return streamService(backend, plugin, name, body.args)
    }

    return null
  }

  async function sessions(backend: ProtocolBackend, req: Request, method: string, segs: string[], query: URLSearchParams): Promise<Response | null> {
    // GET|POST /sessions
    if (segs.length === 1) {
      if (method === 'GET') {
        // ?workspace= — сессии проекта (v1.26); без параметра — все. ?refresh=1 — хаб перечитывает движки (v1.29).
        const ws = query.get('workspace')
        const refresh = query.get('refresh') === '1' || query.get('refresh') === 'true'
        const all = query.get('all') === '1' || query.get('all') === 'true'
        // ?archived=1|only — архивные (v1.55); без параметра — без них.
        const arch = query.get('archived')
        const archived: boolean | 'only' | undefined = arch === 'only' ? 'only' : arch === '1' || arch === 'true' ? true : undefined
        // ?q=&limit=&offset= — поиск и окно (v1.57).
        const q = query.get('q')?.trim()
        const limit = intParam(query.get('limit'))
        const offset = intParam(query.get('offset'))
        const listOpts = { ...(ws ? { workspace: ws } : {}), ...(refresh ? { refresh: true } : {}), ...(all ? { all: true } : {}), ...(archived !== undefined ? { archived } : {}), ...(q ? { query: q } : {}), ...(limit !== undefined ? { limit } : {}), ...(offset ? { offset } : {}) }
        return ok(await backend.sessions.list(Object.keys(listOpts).length ? listOpts : undefined))
      }
      if (method === 'POST') {
        const body = await json<SessionCreateOpts>(req)
        // Профиль — id каталога либо встраиваемый документ (bot-as-session-spec §1).
        if (
          body.profile !== undefined &&
          !(typeof body.profile === 'string' && body.profile !== '') &&
          !isProfileDoc(body.profile)
        ) {
          throw badRequest('create: profile must be a non-empty string or a profile document {name}')
        }
        if (body.cwd !== undefined && (typeof body.cwd !== 'string' || body.cwd === '')) throw badRequest('create: cwd must be a non-empty string')
        if (body.workspace !== undefined && (typeof body.workspace !== 'string' || body.workspace === '')) throw badRequest('create: workspace must be a non-empty string')
        if (body.engine !== undefined && (typeof body.engine !== 'string' || body.engine === '')) throw badRequest('create: engine must be a non-empty string')
        return ok(await backend.sessions.create(body))
      }
      throw methodNotAllowed(method, '/sessions')
    }

    const sid = segs[1]!

    // GET /sessions/live — запущенные сессии (v1.38): идущие раны и живые процессы агентов
    if (segs.length === 2 && sid === 'live' && method === 'GET') {
      if (!backend.sessions.live) throw new NotSupportedError('sessions.live')
      return ok(await backend.sessions.live())
    }

    // GET|DELETE|PATCH /sessions/:id
    if (segs.length === 2) {
      if (method === 'GET') return ok(await backend.sessions.get(sid))
      if (method === 'DELETE') {
        await backend.sessions.delete(sid)
        return ok()
      }
      if (method === 'PATCH') return ok(await patchSession(backend, req, sid))
      throw methodNotAllowed(method, '/sessions/:id')
    }

    if (segs.length === 3) {
      // POST /sessions/:id/engine {engine} — сменить исполнителя (v1.29, хаб)
      if (segs[2] === 'engine' && method === 'POST') {
        const body = await json<{ engine?: unknown }>(req)
        if (typeof body.engine !== 'string' || body.engine === '') throw badRequest('engine requires engine:string')
        if (!backend.sessions.setEngine) throw new NotSupportedError('sessions.setEngine')
        return ok(await backend.sessions.setEngine(sid, body.engine))
      }

      // POST /sessions/:id/move {workspace, project?} — перенос в другое пространство (v1.55)
      if (segs[2] === 'move' && method === 'POST') {
        const body = await json<{ workspace?: unknown; project?: unknown }>(req)
        if (typeof body.workspace !== 'string' || body.workspace === '') throw badRequest('move requires workspace:string')
        if (body.project !== undefined && body.project !== null && typeof body.project !== 'string') throw badRequest('move: project must be a string or null')
        if (!backend.sessions.move) throw new NotSupportedError('sessions.move')
        return ok(await backend.sessions.move(sid, { workspace: body.workspace, ...(body.project !== undefined ? { project: body.project as string | null } : {}) }))
      }

      // POST /sessions/:id/release — погасить процесс агента (v1.38); посреди хода — busy
      if (segs[2] === 'release' && method === 'POST') {
        if (!backend.sessions.release) throw new NotSupportedError('sessions.release')
        await backend.sessions.release(sid)
        return ok()
      }

      // POST /sessions/:id/share {share} — «поделиться» (v1.30, users-spec §4)
      if (segs[2] === 'share' && method === 'POST') {
        const body = await json<{ share?: unknown }>(req)
        if (body.share !== null && (typeof body.share !== 'object' || Array.isArray(body.share))) throw badRequest('share requires share:{project?, users?, write?} | null')
        if (!backend.sessions.share) throw new NotSupportedError('sessions.share')
        return ok(await backend.sessions.share(sid, body.share as SessionShare | null))
      }

      // POST /sessions/:id/fork
      if (segs[2] === 'fork' && method === 'POST') {
        const body = await json<{ atMessageId?: string }>(req)
        if (!backend.sessions.fork) throw new NotSupportedError('sessions.fork')
        return ok(await backend.sessions.fork(sid, body.atMessageId))
      }

      // GET /sessions/:id/history
      if (segs[2] === 'history' && method === 'GET') {
        // ?limit=&before= — окно ленты (v1.57); без них — вся лента.
        const limit = intParam(query.get('limit'))
        const before = query.get('before') || undefined
        const page = await backend.history(sid, limit !== undefined || before ? { ...(limit !== undefined ? { limit } : {}), ...(before ? { before } : {}) } : undefined)
        return ok(page, page.version)
      }

      // GET /sessions/:id/meta  (sessionMeta; §9 даёт только PATCH — см. README)
      if (segs[2] === 'meta' && method === 'GET') {
        if (!backend.meta) throw new NotSupportedError('meta.get')
        return ok(await backend.meta.get(sid))
      }

      // GET/PUT /sessions/:id/personas (personas-spec §3): документ целиком
      if (segs[2] === 'personas' && method === 'GET') {
        if (!backend.personas) throw new NotSupportedError('personas.list')
        return ok(await backend.personas.list(sid))
      }
      if (segs[2] === 'personas' && method === 'PUT') {
        const body = await json<{ personas?: unknown; userId?: unknown }>(req)
        const invalid = validatePersonas(body.personas, body.userId)
        if (invalid) throw badRequest(`personas: ${invalid}`)
        if (!backend.personas?.save) throw new NotSupportedError('personas.save')
        return ok(await backend.personas.save(sid, body.personas as Persona[], body.userId as string | undefined))
      }

      // GET /sessions/:id/attach → SSE идущего рана (v1.31): снимок + живой поток
      if (segs[2] === 'attach' && method === 'GET') {
        if (!backend.sessions.attach) throw new NotSupportedError('sessions.attach')
        return streamAttach(backend.sessions.attach(sid))
      }

      // POST /sessions/:id/run → SSE
      if (segs[2] === 'run' && method === 'POST') {
        let input = await json<RunStartInput>(req)
        if (input.client) input = { ...input, client: opts.client ? opts.client(input.client, req) : stripGuess(input.client) }
        return streamRun(backend, sid, input)
      }

      // POST /sessions/:id/model (models-spec §4)
      if (segs[2] === 'model' && method === 'POST') {
        const body = await json<SessionModel>(req)
        if (typeof body.model !== 'string' || body.model === '') {
          throw badRequest('model requires model:string')
        }
        if (body.thinking !== undefined && typeof body.thinking !== 'string') {
          throw badRequest('model: thinking must be a string')
        }
        if (!backend.models?.set) throw new NotSupportedError('models.set')
        return ok(await backend.models.set(sid, body))
      }

      // POST /sessions/:id/profile {id} | {doc} (profiles-spec §4, bot-as-session-spec §1)
      if (segs[2] === 'profile' && method === 'POST') {
        const body = await json<{ id?: unknown; doc?: unknown }>(req)
        const byId = typeof body.id === 'string' && body.id !== ''
        const byDoc = isProfileDoc(body.doc)
        if (byId === byDoc) throw badRequest('profile requires exactly one of id:string or doc:{name}')
        if (!backend.profiles?.set) throw new NotSupportedError('profiles.set')
        return ok(await backend.profiles.set(sid, byId ? (body.id as string) : (body.doc as ProfileDoc)))
      }

      // POST /sessions/:id/cancel
      if (segs[2] === 'cancel' && method === 'POST') {
        const body = await json<{ runId?: string }>(req)
        if (typeof body.runId !== 'string') throw badRequest('cancel requires runId')
        await backend.cancel(sid, body.runId)
        return ok()
      }

      // POST /sessions/:id/steer {runId, userMessage} (v1.37): сообщение в идущий ран
      if (segs[2] === 'steer' && method === 'POST') {
        const body = await json<{ runId?: unknown; userMessage?: unknown }>(req)
        if (typeof body.runId !== 'string') throw badRequest('steer requires runId')
        if (typeof body.userMessage !== 'string' && !Array.isArray(body.userMessage)) throw badRequest('steer requires userMessage: string | Part[]')
        if (!backend.steer) throw new NotSupportedError('steer')
        return ok(await backend.steer(sid, body.runId, body.userMessage as string | Part[]))
      }

      // POST /sessions/:id/respond (§5.3 — SSE однонаправлен, ответ отдельным POST)
      if (segs[2] === 'respond' && method === 'POST') {
        const body = await json<{ askId?: string; answer?: unknown }>(req)
        if (typeof body.askId !== 'string') throw badRequest('respond requires askId')
        if (!backend.respond) throw new NotSupportedError('respond')
        await backend.respond(sid, body.askId, body.answer)
        return ok()
      }

      // POST|PUT /sessions/:id/attachments — raw body, `x-name` + content-type
      // заголовками (§7 backend-mds-spec: zero-dep, без multipart-парсера).
      // Ответ — {ref, part} (attachments-spec §2). PUT — форма из спеки
      // вложений, POST — исторический роут клиента; принимаются оба.
      if (segs[2] === 'attachments' && (method === 'POST' || method === 'PUT')) {
        if (!backend.attachments) throw new NotSupportedError('attachments.put')
        const name = req.headers.get('x-name')
        if (name === null || name === '') throw badRequest('attachments requires x-name header')
        const ctype = req.headers.get('content-type')
        const mime = ctype !== null && ctype !== '' ? ctype : undefined
        const data = await readBytes(req, maxBody)
        return ok(await backend.attachments.put(sid, decodeURIComponent(name), data, mime))
      }

      // POST /sessions/:id/messages {parts, role?, swipeOf?} → messages.append
      // (attachments-spec §2; assistant и swipeOf — bot-as-session-spec §1)
      if (segs[2] === 'messages' && method === 'POST') {
        const body = await json<{ parts?: unknown; role?: unknown; swipeOf?: unknown; context?: unknown; direction?: unknown }>(req)
        if (!Array.isArray(body.parts) || body.parts.length === 0) {
          throw badRequest('append requires parts: non-empty array')
        }
        if (!body.parts.every((p) => typeof p === 'object' && p !== null && typeof (p as { type?: unknown }).type === 'string')) {
          throw badRequest('append: every part requires type:string')
        }
        if (body.role !== undefined && body.role !== 'user' && body.role !== 'assistant' && body.role !== 'system') {
          throw badRequest("append: role must be 'user', 'assistant' or 'system'")
        }
        if (body.context !== undefined && (typeof body.context !== 'boolean' || body.role !== 'system')) {
          throw badRequest('append: context — boolean, only with role system')
        }
        if (body.swipeOf !== undefined && (typeof body.swipeOf !== 'string' || body.swipeOf === '')) {
          throw badRequest('append: swipeOf must be a non-empty string')
        }
        if (!backend.messages?.append) throw new NotSupportedError('messages.append')
        const appendOpts: MessageAppendOpts = {}
        if (body.role !== undefined) appendOpts.role = body.role
        if (body.swipeOf !== undefined) appendOpts.swipeOf = body.swipeOf
        if (body.context === true) appendOpts.context = true
        // Направление реплики (v1.47): проверяет бэкенд.
        if (body.direction !== undefined) appendOpts.direction = body.direction as MessageAppendOpts['direction']
        return ok(
          await backend.messages.append(sid, body.parts as Part[], Object.keys(appendOpts).length ? appendOpts : undefined),
        )
      }
    }

    // GET /sessions/:id/attachments/:ref → байты вложения (протокол v1.10):
    // Envelope с AttachmentContent, как `workspace.files.read` — не сырой поток.
    if (segs.length === 4 && segs[2] === 'attachments') {
      if (method !== 'GET') throw methodNotAllowed(method, '/sessions/:id/attachments/:ref')
      if (!backend.attachments?.get) throw new NotSupportedError('attachments.get')
      return ok(await backend.attachments.get(sid, segs[3]!))
    }

    // PATCH|DELETE /sessions/:id/messages/:mid
    if (segs.length === 4 && segs[2] === 'messages') {
      const mid = segs[3]!
      if (method === 'PATCH') {
        const patch = await json<MessageEditPatch>(req)
        if (!backend.messages?.edit) throw new NotSupportedError('messages.edit')
        return ok(await backend.messages.edit(sid, mid, patch))
      }
      if (method === 'DELETE') {
        if (!backend.messages?.delete) throw new NotSupportedError('messages.delete')
        await backend.messages.delete(sid, mid)
        return ok()
      }
      throw methodNotAllowed(method, '/sessions/:id/messages/:mid')
    }

    if (segs.length === 5 && segs[2] === 'messages') {
      const mid = segs[3]!

      // GET /sessions/:id/messages/:mid/prompt (prompt-recipe-spec §2)
      if (segs[4] === 'prompt' && method === 'GET') {
        if (!backend.messages?.prompt) throw new NotSupportedError('messages.prompt')
        return ok(await backend.messages.prompt(sid, mid))
      }

      // POST /sessions/:id/messages/:mid/swipe
      if (segs[4] === 'swipe' && method === 'POST') {
        const to = await json<SwipeTo>(req)
        if (!backend.messages?.swipe) throw new NotSupportedError('messages.swipe')
        return ok(await backend.messages.swipe(sid, mid, to))
      }

      // POST /sessions/:id/messages/:mid/hide (§4.2 messages.hide; §9 роута не даёт)
      if (segs[4] === 'hide' && method === 'POST') {
        const body = await json<{ hidden?: boolean }>(req)
        if (typeof body.hidden !== 'boolean') throw badRequest('hide requires hidden:boolean')
        if (!backend.messages?.hide) throw new NotSupportedError('messages.hide')
        await backend.messages.hide(sid, mid, body.hidden)
        return ok()
      }
    }

    return null
  }

  /** PATCH /sessions/:id — по §9 двойного назначения: rename и/или meta. */
  async function patchSession(backend: ProtocolBackend, req: Request, sid: string): Promise<unknown> {
    const body = await json<{ title?: string; meta?: SessionMetaPatch }>(req)
    let touched = false
    let result: unknown

    if ('title' in body) {
      if (typeof body.title !== 'string') throw badRequest('rename requires title:string')
      if (!backend.sessions.rename) throw new NotSupportedError('sessions.rename')
      await backend.sessions.rename(sid, body.title)
      touched = true
    }
    if ('meta' in body) {
      if (!backend.meta) throw new NotSupportedError('meta.patch')
      if (typeof body.meta !== 'object' || body.meta === null || Array.isArray(body.meta)) {
        throw badRequest('meta patch requires an object')
      }
      result = await backend.meta.patch(sid, body.meta)
      touched = true
    }
    if (!touched) throw badRequest('PATCH /sessions/:id requires title or meta')
    return result
  }

  // ──────────────────────────────────────────────────────────────────────────
  // GET /sessions/:id/attach → SSE (v1.31, run-resume-spec §1)
  // ──────────────────────────────────────────────────────────────────────────

  /** Подписка на идущий ран: клиент ушёл — `return()` (отписка), ран не трогаем. */
  function streamAttach(events: AsyncIterable<AnyRunEvent>): Response {
    const iter = events[Symbol.asyncIterator]()
    let gone = false
    let ka: ReturnType<typeof setInterval> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(ctl) {
        const write = (s: string): void => {
          if (!gone) ctl.enqueue(enc.encode(s))
        }
        // Ждущий ask может висеть часами — keepalive, чтобы прокси не закрыл канал
        // (первый — сразу: клиент по нему включает сторож тишины).
        write(': keepalive\n\n')
        ka = setInterval(() => write(': keepalive\n\n'), SSE_KEEPALIVE_MS)
        void (async () => {
          try {
            for (;;) {
              const next = await iter.next()
              if (next.done || gone) break
              write(serializeRunEvent(next.value))
            }
          } catch (err) {
            write(serializeRunEvent({ type: 'run_end', runId: '', status: 'error', error: { message: errorMessage(err) }, version: '' }))
          } finally {
            clearInterval(ka)
            if (!gone) ctl.close()
          }
        })()
      },
      cancel() {
        if (gone) return
        gone = true
        clearInterval(ka)
        void iter.return?.()
      },
    })
    return new Response(body, { status: 200, headers: sseHeaders(cors) })
  }

  // ──────────────────────────────────────────────────────────────────────────
  // POST /sessions/:id/run → SSE-стрим (§5, §9)
  // ──────────────────────────────────────────────────────────────────────────

  async function streamRun(backend: ProtocolBackend, sid: string, input: RunStartInput): Promise<Response> {
    // §10.1: один активный run на сессию. Регистрируем ДО первого await —
    // иначе два одновременных POST проскочат оба. Служебная команда (v1.47,
    // `choices`/`editor`) идёт рядом с ходом — замок её не касается.
    const parallel = isParallelRun(input)
    if (!parallel && activeRuns.has(sid)) {
      throw new WireError(`Session ${sid} already has an active run`, CODE_BUSY, 409)
    }
    if (!parallel) activeRuns.add(sid)

    let iter: AsyncIterator<AnyRunEvent>
    let first: IteratorResult<AnyRunEvent>
    try {
      iter = backend.run(sid, input)[Symbol.asyncIterator]()
      // Заголовки — по первому событию: авария до него уедет обычным Envelope.
      first = await iter.next()
    } catch (err) {
      if (!parallel) activeRuns.delete(sid)
      throw err // ещё ничего не отдали
    }

    // §5.4: обрыв SSE-коннекта НЕ отменяет ран. Итератор дочитываем до конца
    // (ран живёт на сервере, клиент ресинкается через history), просто молча.
    let clientGone = false
    let ka: ReturnType<typeof setInterval> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(ctl) {
        let closed = false
        const write = (s: string): void => {
          if (!clientGone && !closed) ctl.enqueue(enc.encode(s))
        }
        const close = (): void => {
          if (clientGone || closed) return
          closed = true
          ctl.close()
        }
        write(': keepalive\n\n')
        // Ран молчит часами, пока ждёт ask или долгий тул: keepalive не даёт
        // прокси закрыть канал, а клиенту — отличить тишину рана от мёртвого провода.
        ka = setInterval(() => write(': keepalive\n\n'), SSE_KEEPALIVE_MS)
        ;(ka as { unref?: () => void }).unref?.()
        void (async () => {
          let lastRunId = ''
          try {
            let next = first
            while (!next.done) {
              const event = next.value
              if (typeof event.runId === 'string') lastRunId = event.runId
              write(serializeRunEvent(event))
              next = await iter.next()
            }
            close() // ран без событий — всё равно валидный пустой стрим
          } catch (err) {
            // Авария посреди стрима: клиент уже читает SSE — единственный способ
            // сказать «сломалось» — кадр run_end{status:'error'} (backends-spec §3.1).
            const runEnd: RunEndEvent = {
              type: 'run_end',
              runId: lastRunId,
              status: 'error',
              error: {
                message: errorMessage(err),
                ...(err instanceof NotSupportedError
                  ? { code: CODE_NOT_SUPPORTED }
                  : errorCode(err) !== undefined
                    ? { code: errorCode(err) }
                    : {}),
              },
              version: '', // токен неизвестен: ран умер на полуслове, клиент ресинкается
            }
            write(serializeRunEvent(runEnd))
            close()
          } finally {
            clearInterval(ka)
            if (!parallel) activeRuns.delete(sid)
          }
        })()
      },
      cancel() {
        clientGone = true
      },
    })
    return new Response(body, { status: 200, headers: sseHeaders(cors) })
  }

  // ──────────────────────────────────────────────────────────────────────────
  // POST /services/:plugin/:method/stream → SSE service_event … service_end
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Стрим сервиса (plugin-services-spec §2). Незаявленный — Envelope
   * `not_supported` до заголовков: гейт по capability, а не по первому кадру —
   * стрим вправе молчать долго. Дальше throw — кадр `error`, конец —
   * `service_end`; клиент закрыл соединение — `return()` итератора (сервису abort).
   */
  async function streamService(backend: ProtocolBackend, plugin: string, method: string, args: unknown): Promise<Response> {
    if (!canService(await backend.capabilities(), plugin, method, 'stream')) {
      throw new NotSupportedError('services.stream', `Service stream not declared: ${plugin}.${method}`)
    }
    const iter = backend.services!.stream(plugin, method, args)[Symbol.asyncIterator]()
    let done = false
    let keepalive: ReturnType<typeof setInterval> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(ctl) {
        const write = (s: string): void => {
          if (!done) ctl.enqueue(enc.encode(s))
        }
        keepalive = setInterval(() => write(': ping\n\n'), SSE_KEEPALIVE_MS)
        ;(keepalive as { unref?: () => void }).unref?.()
        const finish = (tail: string): void => {
          if (done) return
          write(tail)
          done = true
          clearInterval(keepalive)
          ctl.close()
        }
        void (async () => {
          try {
            for (;;) {
              const next = await iter.next()
              if (next.done || done) break
              write(serializeServiceEvent(next.value))
            }
            finish(serializeServiceEnd())
          } catch (err) {
            const code = err instanceof NotSupportedError ? CODE_NOT_SUPPORTED : undefined
            finish(serializeServiceEvent(serviceErrorEvent(err, code)) + serializeServiceEnd())
          }
        })()
      },
      cancel() {
        if (done) return
        done = true
        clearInterval(keepalive)
        void Promise.resolve(iter.return?.()).catch(() => {})
      },
    })
    return new Response(body, { status: 200, headers: sseHeaders(cors) })
  }

  /**
   * Мультиплекс подписок (v1.68): каждая подписка — свой итератор сервиса,
   * кадры — `service_mux` с ключом, конец подписки — `{key, end}`. Незаявленный
   * метод — кадр `error` + конец этой подписки, остальные живут. Соединение
   * держится, пока клиент его не закроет (подписки кончились — пинги).
   */
  async function muxServices(backend: ProtocolBackend, streams: Array<{ key: string; plugin: string; method: string; args?: unknown }>): Promise<Response> {
    const caps = await backend.capabilities()
    const iters: Array<AsyncIterator<ServiceEvent>> = []
    let done = false
    let keepalive: ReturnType<typeof setInterval> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(ctl) {
        const write = (s: string): void => {
          if (!done) ctl.enqueue(enc.encode(s))
        }
        write(': mux\n\n') // заголовки и первый байт сразу: клиент меняет соединение без зазора
        keepalive = setInterval(() => write(': ping\n\n'), SSE_KEEPALIVE_MS)
        ;(keepalive as { unref?: () => void }).unref?.()
        for (const s of streams) {
          if (!canService(caps, s.plugin, s.method, 'stream')) {
            write(serializeServiceMux(s.key, serviceErrorEvent(`Service stream not declared: ${s.plugin}.${s.method}`, CODE_NOT_SUPPORTED)) + serializeServiceMux(s.key, null))
            continue
          }
          const iter = backend.services!.stream(s.plugin, s.method, s.args)[Symbol.asyncIterator]()
          iters.push(iter)
          void (async () => {
            try {
              for (;;) {
                const next = await iter.next()
                if (next.done || done) break
                write(serializeServiceMux(s.key, next.value))
              }
              write(serializeServiceMux(s.key, null))
            } catch (err) {
              const code = err instanceof NotSupportedError ? CODE_NOT_SUPPORTED : undefined
              write(serializeServiceMux(s.key, serviceErrorEvent(err, code)) + serializeServiceMux(s.key, null))
            }
          })()
        }
      },
      cancel() {
        if (done) return
        done = true
        clearInterval(keepalive)
        for (const it of iters) void Promise.resolve(it.return?.()).catch(() => {})
      },
    })
    return new Response(body, { status: 200, headers: sseHeaders(cors) })
  }

  /**
   * HTTP сервиса (v1.14): запрос → `call(plugin, 'http', ServiceHttpRequest)`,
   * ответ сервиса — как есть. Не Envelope: это страница/ассет для iframe.
   * Незаявленный метод — not_supported (JSON 501), как у call.
   */
  async function serviceHttp(
    backend: ProtocolBackend,
    req: Request,
    method: 'GET' | 'HEAD',
    plugin: string,
    rest: string[],
    query: URLSearchParams,
  ): Promise<Response> {
    const headers: Record<string, string> = {}
    for (const h of ['accept', 'accept-language', 'range', 'if-none-match', 'user-agent']) {
      const v = req.headers.get(h)
      if (v !== null) headers[h] = v
    }
    const pathname = new URL(req.url).pathname
    const path = `/${rest.join('/')}${rest.length && pathname.endsWith('/') ? '/' : ''}`
    const q = query.toString()
    const r = (await backend.services!.call(plugin, SERVICE_HTTP_METHOD, {
      method,
      path,
      query: q ? `?${q}` : '',
      headers,
    } satisfies ServiceHttpRequest)) as ServiceHttpResponse | null
    const body =
      r?.body === undefined || r.body === null
        ? new Uint8Array(0)
        : typeof r.body === 'string'
          ? enc.encode(r.body)
          : fromBase64(r.body.__b64)
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(r?.headers ?? {})) {
      // Длину считаем сами: тело прошло через JSON; hop-by-hop — не наши.
      if (!/^(content-length|transfer-encoding|connection|keep-alive)$/i.test(k)) out[k.toLowerCase()] = String(v)
    }
    out['content-length'] = String(body.byteLength)
    if (cors) Object.assign(out, corsHeaders())
    const status = typeof r?.status === 'number' ? r.status : 200
    const nullBody = method === 'HEAD' || status === 204 || status === 304
    return new Response(nullBody ? null : (body as BodyInit), { status, headers: out })
  }

  return { route }
}

// ────────────────────────────────────────────────────────────────────────────
// Общие помощники провода (Node-сервер берёт их же)
// ────────────────────────────────────────────────────────────────────────────

/** Путь → сегменты после `basePath`; чужой префикс — `null`. Декод ПОСЛЕ нарезки: %2F внутри id — часть id. */
export function routeSegments(pathname: string, basePath: string): string[] | null {
  let path = pathname
  if (basePath) {
    if (path !== basePath && !path.startsWith(`${basePath}/`)) return null
    path = path.slice(basePath.length) || '/'
  }
  return path.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s))
}

/** Ключ из `Authorization: Bearer` или query `auth`; сравнение постоянного времени без Node API. */
export function keyMatches(header: string | null | undefined, query: URLSearchParams, key: string): boolean {
  const given = typeof header === 'string' && /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, '').trim() : (query.get('auth') ?? '')
  const a = enc.encode(given)
  const b = enc.encode(key)
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

export function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-name',
    'access-control-max-age': '86400',
  }
}

function preflight(request: Request): Response {
  // Private Network Access: страница с публичного origin (или `null` —
  // песочница iframe) к 127.0.0.1 — Chrome спрашивает разрешение preflight'ом.
  const pna = request.headers.get('access-control-request-private-network') === 'true'
  return new Response(null, { status: 204, headers: { ...corsHeaders(), ...(pna ? { 'access-control-allow-private-network': 'true' } : {}) } })
}

function sseHeaders(cors: boolean): Record<string, string> {
  return { ...SSE_HEADERS, ...(cors ? corsHeaders() : {}) }
}

/** Envelope-ответ (§4). */
export function envelope<T>(status: number, body: WireEnvelope<T>, cors: boolean, extra?: Record<string, string>): Response {
  const bytes = enc.encode(JSON.stringify(body))
  return new Response(bytes, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(bytes.byteLength),
      ...(cors ? corsHeaders() : {}),
      ...extra,
    },
  })
}

/** Ошибка → Envelope-ответ. */
export function errorResponse(err: unknown, cors: boolean): Response {
  const { status, body } = errorEnvelope(err)
  return envelope(status, body, cors)
}

/** Сырое тело запроса байтами (вложения: файл едет как есть, не JSON); больше `maxBytes` — 413. */
export async function readBytes(req: Request, maxBytes: number): Promise<Uint8Array> {
  if (!req.body) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = req.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      void reader.cancel().catch(() => {})
      throw new WireError('Request body too large', CODE_BAD_REQUEST, 413)
    }
    chunks.push(value)
  }
  if (chunks.length === 1) return chunks[0]!
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

/** JSON-объект тела; пустое тело = пустой вход (§5.1: «продолжай»). */
export async function readJson<T>(req: Request, maxBytes: number): Promise<T> {
  const raw = new TextDecoder().decode(await readBytes(req, maxBytes)).trim()
  if (raw === '') return {} as T
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') throw new Error('body must be a JSON object')
    return parsed as T
  } catch (err) {
    throw new WireError(`Invalid JSON body: ${errorMessage(err)}`, CODE_BAD_REQUEST, 400)
  }
}

export function badRequest(message: string): WireError {
  return new WireError(message, CODE_BAD_REQUEST, 400)
}

export function methodNotAllowed(method: string, route: string): WireError {
  return new WireError(`Method ${method} not allowed on ${route}`, CODE_NOT_FOUND, 405)
}

/**
 * Ошибка → Envelope (backends-spec §3.1): NotSupportedError отдаёт код,
 * ошибки транспорта — свой код и статус; любая ошибка бэкенда со строковым
 * полем code прокидывает его в Envelope (busy/conflict → 409-класс, §4.3
 * backends-spec); прочее — голый 500 без кода.
 */
export function errorEnvelope(err: unknown): { status: number; body: WireEnvelope<never> } {
  if (err instanceof NotSupportedError) {
    return { status: 501, body: { ok: false, error: err.message, code: CODE_NOT_SUPPORTED } }
  }
  if (err instanceof WireError) {
    return { status: err.status, body: { ok: false, error: err.message, code: err.code } }
  }
  const code = errorCode(err)
  if (code !== undefined) {
    return { status: statusForCode(code), body: { ok: false, error: errorMessage(err), code } }
  }
  return { status: 500, body: { ok: false, error: errorMessage(err) } }
}

/** Строковый code ошибки бэкенда, если есть. */
function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && code !== '' ? code : undefined
}

/** HTTP-статус по известным кодам; неизвестный код — честный 500 с кодом в теле. */
function statusForCode(code: string): number {
  switch (code) {
    case 'busy':
    case 'conflict':
      return 409
    case 'not_found':
      return 404
    case 'bad_request':
      return 400
    case 'unreadable':
      // pics-spec §3: эскиз картинки или видео не сделан — файл битый или формат не читается.
      return 422
    case CODE_FORBIDDEN:
      return 403
    case 'engine_unavailable':
      // Хаб (v1.29): движок сессии лежит — сессия на месте, операция нет.
      return 503
    case 'service_unavailable':
      // хозяин сервисов контура лежит — хаб жив, сервис нет.
      return 503
    case 'host_unavailable':
      // v1.45: нет связи с удалённым хостом — адрес вкладки на месте, операция нет.
      return 503
    case CODE_NOT_SUPPORTED:
      return 501
    default:
      return 500
  }
}

/** `?workspace=` (v1.27) и `?engine=` (v1.33, хаб) каталога профилей; нет — `undefined`. */
function profilesQuery(query: URLSearchParams): { workspace?: string; engine?: string } | undefined {
  const ws = query.get('workspace')
  const engine = query.get('engine')
  return ws || engine ? { ...(ws ? { workspace: ws } : {}), ...(engine ? { engine } : {}) } : undefined
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Неотрицательное целое из query (`limit`, `offset`, v1.57); мусор — нет. */
function intParam(v: string | null): number | undefined {
  if (v === null || v === '') return undefined
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? n : undefined
}
