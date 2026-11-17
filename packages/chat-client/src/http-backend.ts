/**
 * createHttpBackend — клиентская сторона шва: HTTP + SSE → ProtocolBackend.
 * Переехал из backend-http: backend-http реэкспортирует отсюда.
 *
 * Тот же интерфейс, что у бэкенда за проводом: UI не различает локальный он
 * или удалённый (backends-spec §1). Поверх fetch — работает и в браузере, и в
 * node; EventSource не используется (ран стартует POST'ом с телом).
 *
 * Канон: nr-engine/docs/specs/nr-ui-protocol-spec.md §9,
 *        nr-ui-protocol.dev/specs/backends-spec.md §3.2
 */

import type {
  SessionListOpts,
  SessionMoveInput,
  ProfilesListOpts,
  WorkspaceProject,
  WorkspaceProjectPatch,
  AnyRunEvent,
  AssetData,
  FileContent,
  FileEntry,
  FileReadOpts,
  FileSearchHit,
  FileSearchQuery,
  FileWriteOpts,
  WorkspaceUpdateEvent,
  WorkspaceUpdateListener,
  WorkspaceFilesOps,
  AttachmentContent,
  AttachmentPutResult,
  Capabilities,
  CatalogExtension,
  CatalogSkill,
  CatalogTool,
  HistoryPage,
  HistoryOpts,
  Message,
  MessageAppendOpts,
  MessageEditPatch,
  Part,
  ModelInfo,
  Persona,
  PersonasDoc,
  ProfileDoc,
  ProfileInfo,
  PromptView,
  ProtocolBackend,
  RunStartInput,
  SteerResult,
  SessionCreateOpts,
  SessionInfo,
  SessionMetaDoc,
  SessionMetaPatch,
  SessionModel,
  ServiceEvent,
  SkinInfo,
  SkinSaveOpts,
  SkinSaveResult,
  SkinSelection,
  SkinsListOpts,
  SessionShare,
  SettingsGetOpts,
  ExternalFileStat,
  ExternalOpts,
  ExternalSignKey,
  HostActionOpts,
  HostActionResult,
  ExternalSearchQuery,
  ExternalUpdateEvent,
  ExternalUpdateListener,
  SettingsResetOpts,
  SettingsSetOpts,
  SettingsSnapshot,
  SettingsWriteResult,
  UserCreateInput,
  UserDevice,
  UserInfo,
  UserLink,
  SwipeTo,
  ProjectInfo,
  WorkspaceInfo,
} from '@kerneldreams/ui-protocol'
import { signRaw } from './sign.js'
import {
  BackendError,
  CODE_CONNECTION_LOST,
  CODE_NOT_SUPPORTED,
  NotSupportedError,
  errorMessage,
  parseSSEStream,
  parseServiceFrame,
  parseServiceMuxFrame,
  parsePluginEvent,
  parseExternalEvent,
  parseWorkspaceEvent,
  serviceErrorEvent,
  type ServiceFrame,
  type WireEnvelope,
} from './wire.js'

/** `host`/`on`/`dryRun` действия хоста (v1.54) — только заданные. */
function hostWhere(o?: HostActionOpts): Record<string, unknown> {
  return { ...(o?.host ? { host: o.host } : {}), ...(o?.on ? { on: o.on } : {}), ...(o?.dryRun ? { dryRun: true } : {}) }
}

// ────────────────────────────────────────────────────────────────────────────
// Опции
// ────────────────────────────────────────────────────────────────────────────

export interface HttpBackendOpts {
  /** Своя реализация fetch (тесты, node-прокси, авторизующая обёртка). */
  fetch?: typeof globalThis.fetch
  /** Заголовки транспорта (auth — вне протокола, §10.6). Могут быть ленивыми. */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>)
  /** TTL кэша capabilities, мс. Default — навсегда, до close(). */
  capabilitiesTtl?: number
  /**
   * Ключ доступа бэкенда (`$auth_key` стенда): `Authorization: Bearer
   * <auth>` на каждом запросе, включая SSE. Явный `authorization` в `headers` —
   * главнее.
   */
  auth?: string
  /**
   * Сторож тишины вечных стримов (`services.stream`, `/workspace/events`;
   *) и стрима/подписки рана, если сервер их пингует: сервер шлёт `: ping` раз в 25 с — нет ни байта дольше, чем
   * столько мс, — соединение считается мёртвым (рестарт бэкенда за туннелем,
   * сон машины): стрим сервиса кончается кадром `connection_lost`, канал файлов
   * переподключается. Default 60 000; `0` — без сторожа.
   */
  idleTimeoutMs?: number
}


// ────────────────────────────────────────────────────────────────────────────
// createHttpBackend
// ────────────────────────────────────────────────────────────────────────────

/**
 * ProtocolBackend поверх HTTP-биндинга §9.
 *
 * ```ts
 * const backend = createHttpBackend('http://127.0.0.1:7331')
 * for await (const ev of backend.run(sid, { userMessage: 'привет' })) ...
 * ```
 *
 * Опциональные методы (fork, messages.*, catalog, ...) присутствуют всегда:
 * capabilities асинхронны, а фабрика синхронна — узнать их к моменту сборки
 * объекта нельзя. Правило «метод есть ⇔ capability заявлена» держит бэкенд за
 * проводом: незаявленная операция приезжает NotSupportedError. UI и так гасит
 * фичи по capabilities() (§1.2), а не по наличию метода.
 */
export function createHttpBackend(url: string, opts: HttpBackendOpts = {}): ProtocolBackend {
  const base = url.replace(/\/+$/, '')
  // Без привязки к globalThis браузер бросает «Illegal invocation».
  const maybeFetch = opts.fetch ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined)
  if (typeof maybeFetch !== 'function') {
    throw new Error('createHttpBackend: fetch недоступен — передай opts.fetch')
  }
  const doFetch: typeof globalThis.fetch = maybeFetch
  const idleMs = opts.idleTimeoutMs ?? STREAM_IDLE_MS

  /** Общий abort: close() рвёт все живые запросы и стримы. */
  const lifetime = new AbortController()
  let closed = false

  let capsCache: { value: Capabilities; at: number } | null = null

  async function buildHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
    const base = typeof opts.headers === 'function' ? await opts.headers() : (opts.headers ?? {})
    const auth: Record<string, string> = opts.auth ? { authorization: `Bearer ${opts.auth}` } : {}
    return { ...auth, ...base, ...extra }
  }

  /**
   * Адреса внешних плагинов (v1.24) — абсолютными: на проводе они от базы
   * бэкенда, а `import()` и `<link>` во фронте резолвятся от страницы. Ключ —
   * в `?auth=`: модулю заголовок не поставить.
   */
  function absolute(rel: string): string {
    const url = /^[a-z][a-z0-9+.-]*:/i.test(rel) ? new URL(rel) : new URL(rel.replace(/^\/+/, ''), `${base}/`)
    if (opts.auth && !url.searchParams.has('auth')) url.searchParams.set('auth', opts.auth)
    return url.href
  }

  // v1.72: ключ подписи адресов `raw` — `GET /files/external/sign`, обновляется на последней четверти срока.
  let signKey: (ExternalSignKey & { at: number }) | null = null
  let signLoad: Promise<void> | null = null
  /** Ключа не дали (не owner, нет `files.sign`) — не переспрашивать до следующих capabilities. */
  let signRefused = false

  function loadSignKey(): Promise<void> {
    if (signLoad) return signLoad
    signLoad = call<ExternalSignKey>('GET', '/files/external/sign')
      .then(({ result }) => {
        if (typeof result?.key === 'string' && typeof result.exp === 'number') signKey = { ...result, at: Date.now() / 1000 }
      })
      .catch(() => {
        signRefused = true
      })
      .finally(() => {
        signLoad = null
      })
    return signLoad
  }

  /** Действующий ключ; на последней четверти срока — обновление в фоне, протухший — `null`. */
  function currentSignKey(): ExternalSignKey | null {
    if (!signKey) return null
    const now = Date.now() / 1000
    if (now >= signKey.exp - 60) {
      signKey = null
      if (!signRefused && !closed) void loadSignKey()
      return null
    }
    if (now > signKey.exp - (signKey.exp - signKey.at) / 4 && !closed) void loadSignKey()
    return signKey
  }

  function withPluginUrls(caps: Capabilities): Capabilities {
    if (!Array.isArray(caps.plugins)) return caps
    return { ...caps, plugins: caps.plugins.map((p) => ({ ...p, url: absolute(p.url), ...(p.css ? { css: absolute(p.css) } : {}) })) }
  }

  function ensureOpen(): void {
    if (closed) throw new Error('createHttpBackend: backend закрыт (close())')
  }

  /** Запрос + разбор Envelope §4. Ошибка провода → throw (§2: фатальное). */
  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ result: T; version?: string }> {
    ensureOpen()
    const headers = await buildHeaders(
      body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
    )

    let res: Response
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: lifetime.signal,
      })
    } catch (err) {
      throw new BackendError(`${method} ${path}: ${errorMessage(err)}`, CODE_CONNECTION_LOST)
    }

    const text = await res.text()
    let envelope: WireEnvelope<T> | null = null
    try {
      envelope = text === '' ? null : (JSON.parse(text) as WireEnvelope<T>)
    } catch {
      envelope = null
    }

    if (!envelope || typeof envelope.ok !== 'boolean') {
      throw new BackendError(
        `${method} ${path}: ответ не Envelope (HTTP ${res.status})`,
        undefined,
        res.status,
      )
    }
    if (!envelope.ok) throw toError(envelope, res.status)

    return { result: envelope.result as T, version: envelope.version }
  }

  /** GET текста CSS (`/skins/<имя>.css`, `/skins/user`): ответ — text/css, ошибка — Envelope. */
  async function getCss(path: string): Promise<string> {
    ensureOpen()
    let res: Response
    try {
      res = await doFetch(`${base}${path}`, { headers: await buildHeaders({ accept: 'text/css' }), signal: lifetime.signal })
    } catch (err) {
      throw new BackendError(`GET ${path}: ${errorMessage(err)}`, CODE_CONNECTION_LOST)
    }
    const text = await res.text()
    if (res.ok) return text
    let envelope: WireEnvelope<never> | null = null
    try {
      envelope = JSON.parse(text) as WireEnvelope<never>
    } catch {
      /* не Envelope */
    }
    if (envelope && envelope.ok === false) throw toError(envelope, res.status)
    throw new BackendError(`GET ${path}: HTTP ${res.status}`, undefined, res.status)
  }

  const backend: ProtocolBackend = {
    async capabilities(): Promise<Capabilities> {
      const ttl = opts.capabilitiesTtl
      if (capsCache && (ttl === undefined || Date.now() - capsCache.at < ttl)) {
        return capsCache.value
      }
      const { result } = await call<Capabilities>('GET', '/capabilities')
      const value = withPluginUrls(result)
      capsCache = { value, at: Date.now() }
      signRefused = false
      if (value.files?.sign && !currentSignKey()) void loadSignKey()
      return value
    },

    sessions: {
      async list(listOpts?: SessionListOpts): Promise<SessionInfo[]> {
        // v1.26: сессии проекта — ?workspace=; без него — все. v1.29: ?refresh=1 — хаб перечитывает движки.
        // v1.30: ?all=1 — сессии всех пользователей (owner стенда). v1.55: ?archived=1|only — архивные.
        return (await call<SessionInfo[]>('GET', `/sessions${query({ workspace: listOpts?.workspace, refresh: listOpts?.refresh ? 1 : undefined, all: listOpts?.all ? 1 : undefined, archived: listOpts?.archived === 'only' ? 'only' : listOpts?.archived ? 1 : undefined, q: listOpts?.query || undefined, limit: listOpts?.limit, offset: listOpts?.offset || undefined })}`)).result
      },
      async create(createOpts?: SessionCreateOpts): Promise<SessionInfo> {
        return (await call<SessionInfo>('POST', '/sessions', createOpts ?? {})).result
      },
      async get(id: string): Promise<SessionInfo> {
        return (await call<SessionInfo>('GET', `/sessions/${enc(id)}`)).result
      },
      async delete(id: string): Promise<void> {
        await call<void>('DELETE', `/sessions/${enc(id)}`)
      },
      async fork(id: string, atMessageId?: string): Promise<SessionInfo> {
        return (await call<SessionInfo>('POST', `/sessions/${enc(id)}/fork`, { atMessageId })).result
      },
      async rename(id: string, title: string): Promise<void> {
        await call<void>('PATCH', `/sessions/${enc(id)}`, { title })
      },
      // v1.29 (users-spec §1): сменить исполнителя сессии у хаба.
      async setEngine(id: string, engine: string): Promise<SessionInfo> {
        return (await call<SessionInfo>('POST', `/sessions/${enc(id)}/engine`, { engine })).result
      },
      // v1.31 (run-resume-spec §1): подписка на идущий ран.
      attach(id: string): AsyncIterable<AnyRunEvent> {
        return streamAttach(id)
      },
      // v1.30 (users-spec §4): «поделиться»; null — снова приватна.
      async share(id: string, share: SessionShare | null): Promise<SessionInfo> {
        return (await call<SessionInfo>('POST', `/sessions/${enc(id)}/share`, { share })).result
      },
      // v1.38: запущенные сессии и «погасить процесс» — по capability `sessions.live/release`.
      async live(): Promise<SessionInfo[]> {
        return (await call<SessionInfo[]>('GET', '/sessions/live')).result
      },
      async release(id: string): Promise<void> {
        await call<void>('POST', `/sessions/${enc(id)}/release`)
      },
      // v1.55: перенос в другое пространство — по capability `sessions.move`.
      async move(id: string, to: SessionMoveInput): Promise<SessionInfo> {
        return (await call<SessionInfo>('POST', `/sessions/${enc(id)}/move`, to)).result
      },
    },

    async history(id: string, opts?: HistoryOpts): Promise<HistoryPage> {
      // v1.57: окно ленты — ?limit=&before=; старый бэкенд их не смотрит и отдаёт всё.
      const { result, version } = await call<HistoryPage>('GET', `/sessions/${enc(id)}/history${query({ limit: opts?.limit, before: opts?.before })}`)
      return { ...result, messages: result.messages, version: result.version ?? version ?? '' }
    },

    run(id: string, input: RunStartInput): AsyncIterable<AnyRunEvent> {
      return streamRun(id, input)
    },

    async cancel(id: string, runId: string): Promise<void> {
      await call<void>('POST', `/sessions/${enc(id)}/cancel`, { runId })
    },

    async steer(id: string, runId: string, userMessage: string | Part[]): Promise<SteerResult> {
      return (await call<SteerResult>('POST', `/sessions/${enc(id)}/steer`, { runId, userMessage })).result
    },
    async respond(id: string, askId: string, answer: unknown): Promise<void> {
      await call<void>('POST', `/sessions/${enc(id)}/respond`, { askId, answer })
    },

    messages: {
      async append(sid: string, parts: Part[], appendOpts?: MessageAppendOpts): Promise<Message> {
        const body: { parts: Part[]; role?: string; swipeOf?: string; direction?: unknown } = { parts }
        if (appendOpts?.role) body.role = appendOpts.role
        if (appendOpts?.swipeOf) body.swipeOf = appendOpts.swipeOf
        if (appendOpts?.direction) body.direction = appendOpts.direction
        return (await call<Message>('POST', `/sessions/${enc(sid)}/messages`, body)).result
      },
      async edit(sid: string, mid: string, patch: MessageEditPatch): Promise<Message> {
        return (await call<Message>('PATCH', `/sessions/${enc(sid)}/messages/${enc(mid)}`, patch)).result
      },
      async delete(sid: string, mid: string): Promise<void> {
        await call<void>('DELETE', `/sessions/${enc(sid)}/messages/${enc(mid)}`)
      },
      async hide(sid: string, mid: string, hidden: boolean): Promise<void> {
        await call<void>('POST', `/sessions/${enc(sid)}/messages/${enc(mid)}/hide`, { hidden })
      },
      async swipe(sid: string, mid: string, to: SwipeTo): Promise<Message> {
        return (await call<Message>('POST', `/sessions/${enc(sid)}/messages/${enc(mid)}/swipe`, to)).result
      },
      async prompt(sid: string, mid: string): Promise<PromptView> {
        return (await call<PromptView>('GET', `/sessions/${enc(sid)}/messages/${enc(mid)}/prompt`)).result
      },
    },

    // models (models-spec §4): как остальные опциональные ops — метод есть
    // всегда, «не умею» приезжает от бэкенда за проводом (not_supported).
    models: {
      async list(): Promise<ModelInfo[]> {
        return (await call<ModelInfo[]>('GET', '/models')).result
      },
      async set(sessionId: string, model: SessionModel): Promise<SessionModel> {
        return (await call<SessionModel>('POST', `/sessions/${enc(sessionId)}/model`, model)).result
      },
    },

    // workspace (workspace-spec §3): current/list всегда, switch — гейт
    // capability `workspace.switch`; незаявленный приезжает not_supported.
    // services (plugin-services-spec §2, v1.11): незаявленное — not_supported с сервера.
    services: {
      async call(plugin: string, method: string, args?: unknown): Promise<unknown> {
        const path = `/services/${enc(plugin)}/${enc(method)}`
        return (await call<unknown>('POST', path, args === undefined ? {} : { args })).result
      },
      stream(plugin: string, method: string, args?: unknown): AsyncIterable<ServiceEvent> {
        return streamService(plugin, method, args)
      },
      // v1.68: долгие подписки — одним соединением (мультиплекс), старый сервер — стрим на подписку.
      subscribe(plugin: string, method: string, args?: unknown): AsyncIterable<ServiceEvent> {
        return mux.subscribe(plugin, method, args)
      },
      // v1.14: HTTP сервиса — тем же адресом, что бэкенд (туннель, чужое устройство).
      url(plugin: string, path: string): string {
        const rest = path.split('/').filter((s) => s !== '').map(enc).join('/')
        return `${base}/services/${enc(plugin)}/http/${rest}${path.endsWith('/') && rest ? '/' : ''}`
      },
    },

    workspace: {
      async current(): Promise<WorkspaceInfo> {
        return (await call<WorkspaceInfo>('GET', '/workspace')).result
      },
      async list(): Promise<WorkspaceInfo[]> {
        return (await call<WorkspaceInfo[]>('GET', '/workspaces')).result
      },
      async switch(id: string): Promise<WorkspaceInfo> {
        return (await call<WorkspaceInfo>('POST', '/workspace', { id })).result
      },
      // Проекты (v1.26, capability workspace.edit): реестр стенда формой.
      async create(project: WorkspaceProject & { id?: string }): Promise<WorkspaceInfo> {
        return (await call<WorkspaceInfo>('POST', '/workspaces', project)).result
      },
      async update(id: string, patch: WorkspaceProjectPatch): Promise<WorkspaceInfo> {
        return (await call<WorkspaceInfo>('PATCH', `/workspaces/${enc(id)}`, patch)).result
      },
      // Проекты пространства (v1.35, capability workspace.repos).
      async repos(o?: { workspace?: string }): Promise<ProjectInfo[]> {
        return (await call<ProjectInfo[]>('GET', `/workspace/repos${query({ workspace: o?.workspace })}`)).result
      },

      // files (workspace-files-spec §1): все методы всегда; незаявленное
      // приезжает not_supported. watch — SSE с переподключением.
      files: filesOps(undefined),
    },

    // profiles (profiles-spec §4): list всегда, set — гейт `profiles.switch`;
    // незаявленный приезжает not_supported.
    profiles: {
      // v1.27: каталог глазами проекта клиента — ?workspace=; без него — проект бэкенда.
      async list(listOpts?: ProfilesListOpts): Promise<ProfileInfo[]> {
        return (await call<ProfileInfo[]>('GET', `/profiles${query({ workspace: listOpts?.workspace, engine: listOpts?.engine })}`)).result
      },
      // Встроенный профиль (bot-as-session-spec §1) едет документом: {doc}, не {id}.
      async set(sessionId: string, profile: string | ProfileDoc): Promise<ProfileInfo> {
        const body = typeof profile === 'string' ? { id: profile } : { doc: profile }
        return (await call<ProfileInfo>('POST', `/sessions/${enc(sessionId)}/profile`, body)).result
      },
      // Конструктор (profile-editor-spec §3): save/delete/duplicate — гейт `profiles.edit`.
      async get(id: string, getOpts?: ProfilesListOpts): Promise<ProfileDoc> {
        return (await call<ProfileDoc>('GET', `/profiles/${enc(id)}${query({ workspace: getOpts?.workspace, engine: getOpts?.engine })}`)).result
      },
      async save(doc: ProfileDoc): Promise<ProfileDoc> {
        return (await call<ProfileDoc>('PUT', `/profiles/${enc(doc.id)}`, doc)).result
      },
      async delete(id: string): Promise<void> {
        await call<void>('DELETE', `/profiles/${enc(id)}`)
      },
      async duplicate(id: string, newId: string): Promise<ProfileDoc> {
        return (await call<ProfileDoc>('POST', `/profiles/${enc(id)}/duplicate`, { id: newId })).result
      },
    },

    // catalogs (profile-editor-spec §3): все три всегда; незаявленный вид
    // приезжает not_supported.
    catalogs: {
      async tools(): Promise<CatalogTool[]> {
        return (await call<CatalogTool[]>('GET', '/catalogs/tools')).result
      },
      async skills(): Promise<CatalogSkill[]> {
        return (await call<CatalogSkill[]>('GET', '/catalogs/skills')).result
      },
      async extensions(): Promise<CatalogExtension[]> {
        return (await call<CatalogExtension[]>('GET', '/catalogs/extensions')).result
      },
    },

    // v1.30 (users-spec §2): пользователи стенда — capability users.admin.
    users: {
      async list(): Promise<UserInfo[]> {
        return (await call<UserInfo[]>('GET', '/auth/users')).result
      },
      async create(input: UserCreateInput): Promise<{ user: UserInfo; link: UserLink }> {
        return (await call<{ user: UserInfo; link: UserLink }>('POST', '/auth/users', input)).result
      },
      async invite(id: string): Promise<UserLink> {
        return (await call<UserLink>('POST', `/auth/users/${enc(id)}/invite`, {})).result
      },
      async loginLink(id: string): Promise<UserLink> {
        return (await call<UserLink>('POST', `/auth/users/${enc(id)}/login-link`, {})).result
      },
      async devices(id: string): Promise<UserDevice[]> {
        return (await call<UserDevice[]>('GET', `/auth/users/${enc(id)}/devices`)).result
      },
      async revoke(id: string, deviceId: string): Promise<void> {
        await call<void>('DELETE', `/auth/users/${enc(id)}/devices/${enc(deviceId)}`)
      },
    },

    catalog: {
      async bots(): Promise<unknown[]> {
        return (await call<unknown[]>('GET', '/bots')).result
      },
      async bot(id: string): Promise<unknown> {
        return (await call<unknown>('GET', `/bots/${enc(id)}`)).result
      },
      async asset(botId: string, file: string): Promise<AssetData> {
        return fetchAsset(botId, file)
      },
    },

    // skin-spec §5 (v1.21): список и собранный CSS; незаявленное приезжает not_supported.
    plugins: {
      watch: (listener) => watchChannel('/plugins/events', parsePluginEvent, listener),
    },

    skins: {
      async list(o?: SkinsListOpts): Promise<SkinInfo[]> {
        return (await call<SkinInfo[]>('GET', `/skins${query({ session: o?.sessionId })}`)).result
      },
      async css(name: string, o?: SkinsListOpts): Promise<string> {
        return getCss(`/skins/${enc(name)}.css${query({ session: o?.sessionId })}`)
      },
      async save(name: string, css: string, o?: SkinSaveOpts): Promise<SkinSaveResult> {
        return (await call<SkinSaveResult>('PUT', `/skins/${enc(name)}.css`, { css, ...(o ?? {}) })).result
      },
      async select(sel: SkinSelection): Promise<void> {
        await call<void>('PUT', '/skins/current', sel)
      },
      // v1.32 (front-context-spec §6): user.css пользователя запроса — его решает сервер, не клиент.
      async userCss(): Promise<string> {
        return getCss('/skins/user')
      },
      async saveUserCss(css: string): Promise<void> {
        await call<void>('PUT', '/skins/user', { css })
      },
    },

    // file-links-spec §3 (v1.41): файл по абсолютному пути вне пространств, действия хоста.
    // v1.42 (file-panel-spec §1): `host` у всех, запись, поиск, слежение, эскиз.
    external: {
      async stat(path: string, o?: ExternalOpts): Promise<ExternalFileStat> {
        return (await call<ExternalFileStat>('GET', `/files/external/stat${query({ path, host: o?.host })}`)).result
      },
      async read(path: string, o?: { maxBytes?: number } & ExternalOpts): Promise<FileContent> {
        return (await call<FileContent>('GET', `/files/external/read${query({ path, maxBytes: o?.maxBytes, host: o?.host })}`)).result
      },
      async list(path: string, o?: ExternalOpts): Promise<FileEntry[]> {
        return (await call<FileEntry[]>('GET', `/files/external/list${query({ path, host: o?.host })}`)).result
      },
      url(path: string, o?: ExternalOpts & { thumb?: number }): string {
        const host = o?.host || undefined
        // v1.72: подписанный адрес работает без куки (srcdoc, песочницы, мимо Cloudflare Access).
        const k = currentSignKey()
        const signed = k ? { exp: k.exp, sig: signRaw(k.key, { path, host, thumb: o?.thumb }) } : {}
        return absolute(`files/external/raw${query({ path, host, thumb: o?.thumb, ...signed })}`)
      },
      async ready(): Promise<void> {
        if (currentSignKey()) return
        const caps = await backend.capabilities().catch(() => null)
        if (!caps?.files?.sign || signRefused) return
        await loadSignKey()
      },
      async write(path: string, content: string, o?: FileWriteOpts & ExternalOpts): Promise<{ revision: string }> {
        const { host, ...rest } = o ?? {}
        return (await call<{ revision: string }>('POST', '/files/external/write', { path, content, ...rest, ...(host ? { host } : {}) })).result
      },
      async mkdir(path: string, o?: ExternalOpts): Promise<void> {
        await call<unknown>('POST', '/files/external/mkdir', { path, ...(o?.host ? { host: o.host } : {}) })
      },
      async rename(from: string, to: string, o?: ExternalOpts): Promise<void> {
        await call<unknown>('POST', '/files/external/rename', { from, to, ...(o?.host ? { host: o.host } : {}) })
      },
      async delete(path: string, o?: ExternalOpts & { permanent?: boolean }): Promise<{ trashed?: string }> {
        return (await call<{ trashed?: string }>('POST', '/files/external/delete', { path, ...(o?.host ? { host: o.host } : {}), ...(o?.permanent ? { permanent: true } : {}) })).result
      },
      async copy(from: string, to: string, o?: ExternalOpts & { overwrite?: boolean }): Promise<void> {
        await call<unknown>('POST', '/files/external/copy', { from, to, ...(o?.host ? { host: o.host } : {}), ...(o?.overwrite ? { overwrite: true } : {}) })
      },
      async search(path: string, q: ExternalSearchQuery, o?: ExternalOpts): Promise<FileSearchHit[]> {
        return (
          await call<FileSearchHit[]>(
            'GET',
            `/files/external/search${query({ path, host: o?.host, glob: q.glob, query: q.query, regex: q.regex ? '1' : undefined, case: q.case ? '1' : undefined, limit: q.limit })}`,
          )
        ).result
      },
      watch(path: string, listener: ExternalUpdateListener, o?: ExternalOpts & { recursive?: boolean }): () => void {
        return watchChannel(`/files/external/events${query({ path, host: o?.host, recursive: o?.recursive ? '1' : undefined })}`, parseExternalEvent, listener, (): ExternalUpdateEvent => ({
          type: 'external_update',
          ...(o?.host ? { host: o.host } : {}),
          paths: [''],
        }))
      },
      // v1.45: место на томе под путём (Ctrl+L), на любом хосте
      async disk(path: string, o?: ExternalOpts): Promise<{ total: number; free: number }> {
        return (await call<{ total: number; free: number }>('GET', `/files/external/disk${query({ path, host: o?.host })}`)).result
      },
      // v1.54: на каких хостах есть путь
      async locate(path: string): Promise<ExternalFileStat[]> {
        return (await call<ExternalFileStat[]>('GET', `/files/external/locate${query({ path })}`)).result
      },
    },
    // v1.54: `host` — хост файла, `on` — машина, где открыть; ответ — что сделано
    host: {
      async reveal(path: string, o?: HostActionOpts): Promise<HostActionResult> {
        return (await call<HostActionResult>('POST', '/host/reveal', { path, ...hostWhere(o) })).result
      },
      async open(path: string, o?: { app?: string } & HostActionOpts): Promise<HostActionResult> {
        return (await call<HostActionResult>('POST', '/host/open', { path, ...(o?.app ? { app: o.app } : {}), ...hostWhere(o) })).result
      },
    },

    // settings-spec §3 (v1.40): слои настроек стенда; контекст — явный, пользователя решает сервер.
    settings: {
      async get(o: SettingsGetOpts): Promise<SettingsSnapshot> {
        const { scopes, noBot, ...ctx } = o
        return (await call<SettingsSnapshot>('GET', `/settings${query({ ...ctx, ...(noBot ? { noBot: 'true' } : {}), scopes: scopes ? JSON.stringify(scopes) : undefined })}`)).result
      },
      async set(o: SettingsSetOpts): Promise<SettingsWriteResult> {
        return (await call<SettingsWriteResult>('PUT', '/settings', o)).result
      },
      async reset(o: SettingsResetOpts): Promise<SettingsWriteResult> {
        return (await call<SettingsWriteResult>('DELETE', '/settings', o)).result
      },
    },

    // personas-spec §3: документ персон сессии целиком — и на чтение, и на запись.
    personas: {
      async list(sid: string): Promise<PersonasDoc> {
        return (await call<PersonasDoc>('GET', `/sessions/${enc(sid)}/personas`)).result
      },
      async save(sid: string, personas: Persona[], userId?: string): Promise<PersonasDoc> {
        const body = userId === undefined ? { personas } : { personas, userId }
        return (await call<PersonasDoc>('PUT', `/sessions/${enc(sid)}/personas`, body)).result
      },
    },

    meta: {
      async get(id: string): Promise<SessionMetaDoc> {
        return (await call<SessionMetaDoc>('GET', `/sessions/${enc(id)}/meta`)).result as SessionMetaDoc
      },
      async patch(id: string, patch: SessionMetaPatch): Promise<SessionMetaDoc> {
        // Возвращается ПРИМЕНЁННЫЙ документ (§2) — клиенту не нужно повторять
        // merge у себя, чтобы узнать, что получилось.
        return (await call<SessionMetaDoc>('PATCH', `/sessions/${enc(id)}`, { meta: patch })).result as SessionMetaDoc
      },
    },

    attachments: {
      async put(sid: string, name: string, data: Uint8Array, mime?: string): Promise<AttachmentPutResult> {
        return putAttachment(sid, name, data, mime)
      },
      async get(sid: string, ref: string): Promise<AttachmentContent> {
        return (await call<AttachmentContent>('GET', `/sessions/${enc(sid)}/attachments/${enc(ref)}`)).result
      },
    },

    async close(): Promise<void> {
      if (closed) return
      closed = true
      capsCache = null
      lifetime.abort()
    },
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Ассет — единственный не-Envelope роут (§9: байты, не JSON)
  // ──────────────────────────────────────────────────────────────────────────

  async function putAttachment(
    sid: string,
    name: string,
    data: Uint8Array,
    mime?: string,
  ): Promise<AttachmentPutResult> {
    ensureOpen()
    const headers = await buildHeaders({
      accept: 'application/json',
      'content-type': mime ?? 'application/octet-stream',
      'x-name': encodeURIComponent(name),
    })

    let res: Response
    try {
      // Копия в свежий Uint8Array: у fetch BodyInit — ArrayBufferView, а вьюшка
      // над пулом Buffer'а могла бы уехать за пределы своего среза.
      res = await doFetch(`${base}/sessions/${enc(sid)}/attachments`, {
        method: 'POST',
        headers,
        body: data.slice(),
        signal: lifetime.signal,
      })
    } catch (err) {
      throw new BackendError(`attachments.put ${sid}: ${errorMessage(err)}`, CODE_CONNECTION_LOST)
    }

    const text = await res.text()
    const envelope = safeEnvelope(text) as WireEnvelope<AttachmentPutResult> | null
    if (!envelope || typeof envelope.ok !== 'boolean') {
      throw new BackendError(
        `attachments.put ${sid}: ответ не Envelope (HTTP ${res.status})`,
        undefined,
        res.status,
      )
    }
    if (!envelope.ok) throw toError(envelope, res.status)
    return envelope.result as AttachmentPutResult
  }

  async function fetchAsset(botId: string, file: string): Promise<AssetData> {
    ensureOpen()
    const res = await doFetch(`${base}/bots/${enc(botId)}/assets/${enc(file)}`, {
      method: 'GET',
      headers: await buildHeaders(),
      signal: lifetime.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw toError(safeEnvelope(text), res.status)
    }
    const mime = res.headers.get('content-type') ?? undefined
    return { data: new Uint8Array(await res.arrayBuffer()), mime: mime ?? undefined }
  }

  /**
   * Файлы пространства (workspace-files-spec §1): все методы всегда; незаявленное
   * приезжает not_supported. watch — SSE с переподключением. `ws` (v1.33) —
   * файлы проекта вкладки: `?workspace=` у каждого запроса; `at(ws)` — то же.
   */
  function filesOps(ws: string | undefined): WorkspaceFilesOps {
    const w = ws === undefined ? {} : { workspace: ws }
    return {
      async list(path?: string): Promise<FileEntry[]> {
        return (await call<FileEntry[]>('GET', `/workspace/files${query({ path, ...w })}`)).result
      },
      async read(path: string, readOpts?: FileReadOpts): Promise<FileContent> {
        return (await call<FileContent>('GET', `/workspace/file${query({ path, maxBytes: readOpts?.maxBytes, ...w })}`)).result
      },
      async write(path: string, content: string, writeOpts?: FileWriteOpts): Promise<{ revision: string }> {
        const body: { path: string; content: string; encoding?: string; revision?: string | null } = { path, content }
        if (writeOpts?.encoding !== undefined) body.encoding = writeOpts.encoding
        // null («создать») обязан доехать; undefined — поля нет вовсе.
        if (writeOpts?.revision !== undefined) body.revision = writeOpts.revision
        return (await call<{ revision: string }>('PUT', `/workspace/file${query(w)}`, body)).result
      },
      async delete(path: string): Promise<void> {
        await call<void>('DELETE', `/workspace/file${query({ path, ...w })}`)
      },
      async rename(from: string, to: string): Promise<void> {
        await call<void>('POST', `/workspace/file/rename${query(w)}`, { from, to })
      },
      async stat(path: string): Promise<FileEntry> {
        return (await call<FileEntry>('GET', `/workspace/file/stat${query({ path, ...w })}`)).result
      },
      // v1.28: гейт workspace.files.search.
      async search(q: FileSearchQuery): Promise<FileSearchHit[]> {
        return (await call<FileSearchHit[]>('POST', `/workspace/files/search${query(w)}`, q)).result
      },
      watch(listener: WorkspaceUpdateListener): () => void {
        return watchWorkspace(listener, ws)
      },
      at: (id: string) => filesOps(id),
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // watch — GET /workspace/events → workspace_update (workspace-files-spec §1)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Подписка на изменения файлов. Синхронная (протокол: `watch → unsubscribe`),
   * канал — фоном: обрыв и 5xx → переподключение с backoff, и после любого
   * подключения, кроме первого, подписчик получает `paths: ['']` — что было
   * между, неизвестно. 4xx и not_supported — канала нет и не будет: без ретраев.
   */
  function watchWorkspace(listener: WorkspaceUpdateListener, ws?: string): () => void {
    return watchChannel(`/workspace/events${query({ workspace: ws })}`, parseWorkspaceEvent, listener, (): WorkspaceUpdateEvent => ({ type: 'workspace_update', paths: [''] }))
  }

  /**
   * Вечный SSE-канал подписки (`/workspace/events`, `/plugins/events`): фоном,
   * обрыв и 5xx → переподключение с backoff; `reconnected` — кадр подписчику
   * после любого подключения, кроме первого (что было между — неизвестно).
   */
  function watchChannel<E>(path: string, parse: (frame: string) => E | null, listener: (event: E) => void, reconnected?: () => E): () => void {
    ensureOpen()
    const ac = new AbortController()
    const onClose = () => ac.abort()
    lifetime.signal.addEventListener('abort', onClose, { once: true })

    const deliver = (event: E) => {
      if (ac.signal.aborted) return
      try {
        listener(event)
      } catch {
        // упавший подписчик — его дело, канал живёт
      }
    }

    void (async () => {
      let attempt = 0
      let backoff = 0
      while (!ac.signal.aborted) {
        if (backoff > 0) await sleep(backoff, ac.signal)
        if (ac.signal.aborted) break
        backoff = Math.min(WATCH_BACKOFF_MAX_MS, backoff ? backoff * 2 : WATCH_BACKOFF_MS)

        let res: Response
        try {
          res = await doFetch(`${base}${path}`, {
            method: 'GET',
            headers: await buildHeaders({ accept: 'text/event-stream' }),
            signal: ac.signal,
          })
        } catch {
          attempt++
          continue
        }
        if (!res.ok || !isEventStream(res) || !res.body) {
          await res.text().catch(() => '')
          if (res.status < 500 || res.status === 501) break
          attempt++
          continue
        }

        if (attempt > 0 && reconnected) deliver(reconnected())
        attempt++
        backoff = WATCH_BACKOFF_MS

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        try {
          for (;;) {
            const chunk = await readIdle(reader, idleMs)
            if (chunk.done) break
            buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n')
            let cut: number
            while ((cut = buffer.indexOf('\n\n')) !== -1) {
              const event = parse(buffer.slice(0, cut))
              buffer = buffer.slice(cut + 2)
              if (event) deliver(event)
            }
          }
        } catch {
          // обрыв провода или abort — решает условие цикла
        } finally {
          await reader.cancel().catch(() => {})
        }
      }
      lifetime.signal.removeEventListener('abort', onClose)
    })()

    return () => ac.abort()
  }

  // ──────────────────────────────────────────────────────────────────────────
  // services.stream — POST → SSE service_event … service_end (v1.11)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Стрим сервиса. Отказ до стрима (not_supported) — throw первого `next()`;
   * соединение кончилось без `service_end` — кадр `error` с `connection_lost`.
   * `return()` рвёт соединение сразу, даже посреди ожидания кадра: сервер
   * видит закрытие и абортит сервис.
   */
  // ──────────────────────────────────────────────────────────────────────────
  // services.subscribe — мультиплекс подписок (v1.68): POST /services/_mux/stream
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Все подписки клиента — один SSE. Набор поменялся — новое соединение со всем
   * набором; старое закрывается, когда новое ответило (кадры не теряются,
   * возможен дубль — подписки это терпят: watch/events). Сервер без маршрута
   * (`not_supported`, 404) — подписки уходят на стрим каждая, навсегда.
   */
  function createMux() {
    type Item = { kind: 'frame'; frame: ServiceFrame } | { kind: 'fallback' }
    type Sub = { key: string; plugin: string; method: string; args: unknown; push(i: Item): void }
    const subs = new Map<string, Sub>()
    let seq = 0
    let broken = false
    let current: AbortController | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = (): void => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        void reopen()
      }, 15)
    }
    const failAll = (keys: Iterable<string>, err: unknown): void => {
      for (const k of keys) {
        const s = subs.get(k)
        if (!s) continue
        subs.delete(k)
        s.push({ kind: 'frame', frame: { type: 'event', event: serviceErrorEvent(err, CODE_CONNECTION_LOST) } })
        s.push({ kind: 'frame', frame: { type: 'end' } })
      }
    }
    lifetime.signal.addEventListener(
      'abort',
      () => {
        for (const s of subs.values()) s.push({ kind: 'frame', frame: { type: 'end' } })
        subs.clear()
      },
      { once: true },
    )
    async function reopen(): Promise<void> {
      if (lifetime.signal.aborted) return
      if (subs.size === 0) {
        current?.abort()
        current = null
        return
      }
      const ac = new AbortController()
      const onClose = (): void => ac.abort()
      lifetime.signal.addEventListener('abort', onClose, { once: true })
      const mine = [...subs.values()]
      const keys = new Set(mine.map((s) => s.key))
      let res: Response
      try {
        res = await doFetch(`${base}/services/_mux/stream`, {
          method: 'POST',
          headers: await buildHeaders({ accept: 'text/event-stream', 'content-type': 'application/json' }),
          body: JSON.stringify({ streams: mine.map((s) => ({ key: s.key, plugin: s.plugin, method: s.method, ...(s.args === undefined ? {} : { args: s.args }) })) }),
          signal: ac.signal,
        })
      } catch (err) {
        lifetime.signal.removeEventListener('abort', onClose)
        if (!ac.signal.aborted) failAll(keys, err)
        return
      }
      if (!res.ok || !isEventStream(res) || !res.body) {
        lifetime.signal.removeEventListener('abort', onClose)
        const text = await res.text().catch(() => '')
        const env = safeEnvelope(text)
        if (res.status === 404 || res.status === 405 || env?.code === CODE_NOT_SUPPORTED) {
          broken = true
          for (const s of mine) {
            subs.delete(s.key)
            s.push({ kind: 'fallback' })
          }
        } else failAll(keys, toError(env, res.status))
        return
      }
      const old = current
      current = ac
      old?.abort()
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const deliver = (raw: string): void => {
        const m = parseServiceMuxFrame(raw)
        if (!m || current !== ac) return
        const s = subs.get(m.key)
        if (!s) return
        if (m.frame.type === 'end') subs.delete(m.key)
        s.push({ kind: 'frame', frame: m.frame })
      }
      try {
        for (;;) {
          const chunk = await readIdle(reader, idleMs)
          if (chunk.done) break
          buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n')
          let cut: number
          while ((cut = buffer.indexOf('\n\n')) !== -1) {
            deliver(buffer.slice(0, cut))
            buffer = buffer.slice(cut + 2)
          }
        }
        deliver(buffer + decoder.decode())
        if (current === ac) failAll(keys, 'mux stream ended')
      } catch (err) {
        if (current === ac && !ac.signal.aborted) failAll(keys, err)
      } finally {
        lifetime.signal.removeEventListener('abort', onClose)
        await reader.cancel().catch(() => {})
        if (current === ac) {
          current = null
          ac.abort()
        }
      }
    }
    function subscribe(plugin: string, method: string, args: unknown): AsyncIterable<ServiceEvent> {
      if (broken) return streamService(plugin, method, args)
      return {
        [Symbol.asyncIterator](): AsyncIterator<ServiceEvent> {
          ensureOpen()
          const key = `s${++seq}`
          const queue: Item[] = []
          let wake: (() => void) | null = null
          let finished = false
          let inner: AsyncIterator<ServiceEvent> | null = null
          const sub: Sub = {
            key,
            plugin,
            method,
            args,
            push(i) {
              queue.push(i)
              wake?.()
              wake = null
            },
          }
          subs.set(key, sub)
          schedule()
          return {
            async next(): Promise<IteratorResult<ServiceEvent>> {
              for (;;) {
                if (inner) return inner.next()
                if (finished) return { value: undefined, done: true }
                const i = queue.shift()
                if (!i) {
                  if (lifetime.signal.aborted) {
                    finished = true
                    continue
                  }
                  await new Promise<void>((r) => (wake = r))
                  continue
                }
                if (i.kind === 'fallback') {
                  inner = streamService(plugin, method, args)[Symbol.asyncIterator]()
                  continue
                }
                if (i.frame.type === 'end') {
                  finished = true
                  continue
                }
                return { value: i.frame.event, done: false }
              }
            },
            async return(): Promise<IteratorResult<ServiceEvent>> {
              finished = true
              wake?.()
              if (inner) await inner.return?.().catch(() => {})
              if (subs.delete(key)) schedule()
              return { value: undefined, done: true }
            },
          }
        },
      }
    }
    return { subscribe }
  }
  const mux = createMux()

  function streamService(plugin: string, method: string, args: unknown): AsyncIterable<ServiceEvent> {
    return {
      [Symbol.asyncIterator]() {
        const ac = new AbortController()
        const inner = readServiceStream(plugin, method, args, ac.signal)
        return {
          next: () => inner.next(),
          async return() {
            ac.abort()
            await inner.return(undefined).catch(() => {})
            return { value: undefined, done: true }
          },
        }
      },
    }
  }

  async function* readServiceStream(
    plugin: string,
    method: string,
    args: unknown,
    signal: AbortSignal,
  ): AsyncGenerator<ServiceEvent, void> {
    ensureOpen()
    const path = `/services/${enc(plugin)}/${enc(method)}/stream`
    const ac = new AbortController()
    const onClose = () => ac.abort()
    signal.addEventListener('abort', onClose, { once: true })
    lifetime.signal.addEventListener('abort', onClose, { once: true })
    try {
      let res: Response
      try {
        res = await doFetch(`${base}${path}`, {
          method: 'POST',
          headers: await buildHeaders({ accept: 'text/event-stream', 'content-type': 'application/json' }),
          body: JSON.stringify(args === undefined ? {} : { args }),
          signal: ac.signal,
        })
      } catch (err) {
        if (signal.aborted) return
        throw new BackendError(`services.stream ${plugin}.${method}: ${errorMessage(err)}`, CODE_CONNECTION_LOST)
      }
      if (!res.ok || !isEventStream(res) || !res.body) {
        const text = await res.text().catch(() => '')
        throw toError(safeEnvelope(text), res.status)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>
          try {
            chunk = await readIdle(reader, idleMs)
          } catch (err) {
            if (signal.aborted) return
            yield serviceErrorEvent(err, CODE_CONNECTION_LOST)
            return
          }
          if (chunk.done) break
          buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n')
          let cut: number
          while ((cut = buffer.indexOf('\n\n')) !== -1) {
            const frame = parseServiceFrame(buffer.slice(0, cut))
            buffer = buffer.slice(cut + 2)
            if (frame?.type === 'end') return
            if (frame) yield frame.event
          }
        }
        const tail = parseServiceFrame(buffer + decoder.decode())
        if (tail?.type === 'end') return
        if (tail) yield tail.event
        if (!signal.aborted) yield serviceErrorEvent('stream ended without service_end', CODE_CONNECTION_LOST)
      } finally {
        await reader.cancel().catch(() => {})
      }
    } finally {
      signal.removeEventListener('abort', onClose)
      lifetime.signal.removeEventListener('abort', onClose)
      ac.abort() // соединение закрыто — сервер абортит сервис, если он ещё жив
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // run — POST → SSE-стрим → AsyncIterable<AnyRunEvent> (§5.2, §9)
  // ──────────────────────────────────────────────────────────────────────────

  function streamRun(id: string, input: RunStartInput): AsyncGenerator<AnyRunEvent> {
    return streamEvents(id, 'run', async () => ({
      method: 'POST',
      headers: await buildHeaders({ accept: 'text/event-stream', 'content-type': 'application/json' }),
      body: JSON.stringify(input ?? {}),
    }))
  }

  /**
   * v1.31 (run-resume-spec §1): GET /sessions/:id/attach → SSE идущего рана —
   * снимок, потом живой поток. Рана нет — пустой стрим, без синтетического
   * обрыва; сам `return()` подписки ран на сервере не трогает.
   */
  function streamAttach(id: string): AsyncGenerator<AnyRunEvent> {
    return streamEvents(id, 'attach', async () => ({ method: 'GET', headers: await buildHeaders({ accept: 'text/event-stream' }) }), true)
  }

  async function* streamEvents(id: string, op: 'run' | 'attach', init: () => Promise<RequestInit>, emptyOk = false): AsyncGenerator<AnyRunEvent> {
    ensureOpen()

    let res: Response
    try {
      res = await doFetch(`${base}/sessions/${enc(id)}/${op}`, { ...(await init()), signal: lifetime.signal })
    } catch (err) {
      // Ран не стартовал — транспортная авария (§2: throw, не run_end)
      throw new BackendError(`${op} ${id}: ${errorMessage(err)}`, CODE_CONNECTION_LOST)
    }

    if (!res.ok || !isEventStream(res)) {
      // Сервер отказал до стрима (not_supported, busy, 500) — Envelope
      const text = await res.text().catch(() => '')
      throw toError(safeEnvelope(text), res.status)
    }
    if (!res.body) throw new BackendError(`${op} ${id}: пустой стрим (HTTP ${res.status})`)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let lastRunId = ''
    let sawRunEnd = false
    // Сторож тишины: сервер, который пингует стрим рана (`: keepalive`),
    // молчать дольше `idleMs` не может — значит, провод мёртв (сон телефона, туннель),
    // и вкладка подхватывает ран заново, а не висит на последней дельте. Без
    // пингов (старый бэкенд) сторожа нет: долгий тул — не обрыв.
    let watched = false

    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>
        try {
          chunk = await readIdle(reader, watched ? idleMs : 0)
        } catch (err) {
          // Провод порвался посреди рана: не throw (ран мог доехать на сервере),
          // а синтетический run_end с кодом — UI различит и ресинкнется (§3.2).
          yield connectionLost(lastRunId, errorMessage(err))
          return
        }
        if (chunk.done) break

        buffer += decoder.decode(chunk.value, { stream: true })

        // Отдаём только целые кадры; хвост копится до следующего чтения.
        const cut = buffer.lastIndexOf('\n\n')
        if (cut === -1) continue
        const complete = buffer.slice(0, cut + 2)
        buffer = buffer.slice(cut + 2)
        if (!watched && KEEPALIVE_LINE.test(complete)) watched = true

        for (const event of parseSSEStream(complete)) {
          if (typeof event.runId === 'string') lastRunId = event.runId
          if (event.type === 'run_end') sawRunEnd = true
          yield event // неизвестные типы — вверх opaque, не фильтруем (§1.2)
        }
      }

      // Хвост без завершающего разделителя (сервер закрылся сразу после кадра).
      buffer += decoder.decode()
      if (buffer.trim() !== '') {
        for (const event of parseSSEStream(buffer)) {
          if (typeof event.runId === 'string') lastRunId = event.runId
          if (event.type === 'run_end') sawRunEnd = true
          yield event
        }
      }

      // Стрим кончился, а run_end не приехал — то же, что обрыв (attach без рана — пусто, это не обрыв).
      if (!sawRunEnd && !(emptyOk && lastRunId === '')) yield connectionLost(lastRunId, 'stream ended without run_end')
    } finally {
      // Отпускаем сокет. Ран на сервере при этом НЕ отменяется (§5.4) —
      // отмена только явным cancel().
      await reader.cancel().catch(() => {})
    }
  }

  return backend
}

// ────────────────────────────────────────────────────────────────────────────
// Хелперы
// ────────────────────────────────────────────────────────────────────────────

const enc = encodeURIComponent

/** Тишина вечного стрима дольше — соединение мёртвое (сервер пингует раз в 25 с). */
const STREAM_IDLE_MS = 60_000

/** Keepalive-комментарий стрима рана — сервер пингует, сторож тишины можно включать. */
const KEEPALIVE_LINE = /^: ?keepalive\b/m

/** `reader.read()` со сторожем тишины: `ms` без байта — throw (`0` — без сторожа). */
function readIdle(reader: ReadableStreamDefaultReader<Uint8Array>, ms: number): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!(ms > 0)) return reader.read()
  let timer: ReturnType<typeof setTimeout> | undefined
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`stream idle ${Math.round(ms / 1000)} s — heartbeat lost`)), ms)
  })
  return Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer))
}

/** Первая пауза переподключения канала `/workspace/events`, мс; дальше — удвоение. */
const WATCH_BACKOFF_MS = 500
const WATCH_BACKOFF_MAX_MS = 30_000

/** Query-строка: `undefined` пропускается, пусто — без `?`. */
function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value))
  }
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}

/** Пауза, которую abort обрывает сразу. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

function isEventStream(res: Response): boolean {
  return (res.headers.get('content-type') ?? '').includes('text/event-stream')
}

function safeEnvelope(text: string): WireEnvelope<unknown> | null {
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as WireEnvelope<unknown>) : null
  } catch {
    return null
  }
}

/** Envelope-ошибка → исключение: not_supported восстанавливается классом (§3.1). */
function toError(envelope: WireEnvelope<unknown> | null, status: number): Error {
  const message = envelope?.error ?? `HTTP ${status}`
  if (envelope?.code === CODE_NOT_SUPPORTED) return new NotSupportedError(undefined, message)
  return new BackendError(message, envelope?.code, status)
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
