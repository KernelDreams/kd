/**
 * serveBackend — серверная сторона шва: ProtocolBackend → HTTP + SSE.
 *
 * Биндинг §9 спеки протокола буквально: роуты оттуда, ответы в Envelope §4,
 * run-события — SSE-кадрами через serializeRunEvent. node:http, zero-dep.
 *
 * Канон: nr-engine/docs/specs/nr-ui-protocol-spec.md §9,
 *        nr-ui-protocol.dev/specs/backends-spec.md §3.1
 */

import { hasRunAttach, withRunAttach } from './run-attach.js'
import {
  MAX_BODY_BYTES,
  SSE_KEEPALIVE_MS,
  WireError,
  badRequest,
  corsHeaders,
  createWireCore,
  errorEnvelope,
  keyMatches,
  methodNotAllowed,
  routeSegments,
} from './fetch-handler.js'
import { Readable } from 'node:stream'
import { createServer, STATUS_CODES, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile, realpath } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import {
  NotSupportedError,
  SERVER_SETTINGS_LAYERS,
  SETTINGS_CHANGED_EVENT,
  SETTINGS_CHANGES_STREAM,
  SETTINGS_SERVICE,
  isSettingsLayer,
  serializeServiceEvent,
  serializePluginChanged,
  serializeExternalEvent,
  serializeWorkspaceEvent,
} from '@kerneldreams/ui-protocol'
import type {
  FileReadOpts,
  FileSearchQuery,
  FileWriteOpts,
  WorkspaceUpdateListener,
  ProtocolBackend,
  SettingsContext,
  SettingsOps,
  SettingsScopes,
  SkinsOps,
  SkinMode,
  PluginsSource,
  UserCreateInput,
  RunStartInput,
  ServicesHost,
} from '@kerneldreams/ui-protocol'
import { isLocalRequest, type UsersGate } from './gate.js'
import type { FileSigner } from './file-sign.js'
import { rawMime, readExternalRaw, thumbKind, thumbMime, winFromWire, type ExternalHost } from './external.js'
import { ptyOriginAllowed, type PtyOps } from './pty.js'
import { PEER_HEADER, peerAddress, type StandDevices } from './devices.js'
import {
  CODE_BAD_REQUEST,
  CODE_NOT_FOUND,
  CODE_UNAUTHORIZED,
  CODE_FORBIDDEN,
  errorMessage,
  normalizeBasePath,
  type WireEnvelope,
} from './wire.js'

// ────────────────────────────────────────────────────────────────────────────
// Опции и хендл
// ────────────────────────────────────────────────────────────────────────────

export interface ServeBackendOpts {
  /** Порт; 0 = свободный (реальный — в ServeHandle.port). Default 0. */
  port?: number
  /** Интерфейс. Default '127.0.0.1' — наружу сервер не торчит без спроса. */
  host?: string
  /** CORS-заголовки + preflight (dev). Default false. */
  cors?: boolean
  /** Префикс всех роутов: '/api' → '/api/sessions'. Default ''. */
  basePath?: string
  /** Максимальный размер тела запроса, байт. Default 10 МБ. */
  maxBodyBytes?: number
  /**
   * Ключ доступа (`$auth_key` окружения): задан — каждый запрос (и
   * SSE) обязан нести `Authorization: Bearer <ключ>` либо `?auth=<ключ>`
   * (ссылки `<img>`/iframe, которым заголовок не поставить); иначе 401
   * Envelope `code: 'unauthorized'`. Preflight (OPTIONS) — без ключа. Нет —
   * как раньше, без проверки.
   */
  authKey?: string
  /**
   * Скины (v1.21, skin-spec §5): источник `SkinsOps` (`createFsSkins` из
   * `@kerneldreams/skins/node`) — общий для всех бэкендов стенда, поэтому
   * опцией транспорта, а не методом бэкенда. Задан — роуты `/skins*` и
   * capability `skins` поверх `backend.capabilities()`; `backend.skins` —
   * запасной вариант. Есть `userCss`+`saveUserCss` — `GET|PUT /skins/user`
   * и `skins.user` (v1.32): пользователь — из гейта `users` (`identity.user.id`),
   * без гейта `userId` не передаётся (источник берёт владельца стенда).
   * PUT общих скинов при гейте — только owner, свой user.css — любой вошедший.
   */
  skins?: SkinsOps
  /**
   * Внешние плагины фронта (v1.24, core-boundary-spec §3): источник бандлов
   * (`createFsPlugins` над папками `$plugins` стенда). Задан — роуты
   * `GET /plugins/<id>/<путь>`, SSE `/plugins/events` и capability `plugins`
   * поверх `backend.capabilities()`.
   */
  plugins?: PluginsSource
  /**
   * Пользователи стенда (v1.30, users-spec §2–5): гейт (`createUsersGate`).
   * Задан — каждый запрос от вошедшего (кука устройства, Access JWT, локальный
   * процесс), иначе 401; роуты получают бэкенд его глазами; `/auth/join|login`
   * — вход по ссылке, `/auth/logout`, `/auth/users*` — админка. Нет — как раньше.
   */
  users?: UsersGate
  /**
   * Настройки по слоям (v1.40, settings-spec §3): хост слоёв (`createFsSettings`) —
   * общий для всех движков стенда, поэтому опцией транспорта. Задан — роуты
   * `GET|PUT|DELETE /settings`, capability `settings` и (есть `watch`) стрим
   * `settings.changes` в пуле сервисов: правка файла слоя снаружи доходит до
   * открытого фронта без нового канала. Пользователь — из гейта (`identity.user.id`).
   */
  settings?: SettingsOps
  /**
   * Файл вне пространств и действия хоста (v1.41): `createExternalHost`.
   * Задан — роуты `GET /files/external/{stat,read,list,raw}?path=`,
   * `POST /host/{reveal,open}` и capability `files.external`/`host` поверх
   * `backend.capabilities()`. При гейте пользователей — только owner стенда.
   */
  external?: ExternalHost
  /**
   * Подписанные адреса `raw` (v1.72): `createFileSigner` с секретом стенда. Задан вместе с
   * `external` — capability `files.sign`, `GET /files/external/sign` (ключ со сроком; при гейте —
   * только owner, как весь `files.external`) и `GET /files/external/raw?…&exp=&sig=` без куки и ключа
   * стенда: подпись проверена — файл, не та — 403, протухла — 401. `strict` — путь `raw` открыт мимо
   * Cloudflare Access: неподписанный `raw` только от гейта / ключа / локального процесса / Access JWT.
   */
  fileSign?: FileSigner
  /**
   * Общий терминал (nr-pty-spec §1): хост `createPtyHost` из `@kerneldreams/pty`.
   * Задан — роуты `GET|POST /pty`, `GET|DELETE /pty/<id>`, `POST /pty/run`, `GET /pty/read`,
   * WebSocket `GET /pty/<id>/attach` (upgrade) и capability `pty`. Терминал — shell на хосте
   * стенда: при гейте пользователей — только owner; запрос из браузера — только с допустимым
   * `Origin` (тот же хост, loopback, `ptyOrigins`).
   */
  pty?: PtyOps
  /** Origin страниц, которым можно в терминал, кроме того же хоста и loopback: `https://far.nr`, `https://*.nr`. */
  ptyOrigins?: string[]
  /**
   * Машины пользователя (v1.62): `createDevices` по реестру `$hosts`. Задан —
   * capability `devices` (с `here` по адресу tailnet) и замена догадки `client.guess` на ране.
   */
  devices?: StandDevices
  /**
   * Хозяин сервисов плагинов контура: его слой сервисов. Задан — `GET /services`
   * отдаёт его capability (свои сервисы, без опроса движков хаба) — по нему хабы ACP и задач
   * (`createRemoteServices`) узнают, что проксировать.
   */
  servicesOwner?: Pick<ServicesHost, 'capability'>
}

export interface ServeHandle {
  server: Server
  /** Базовый URL с basePath — то, что скармливать createHttpBackend. */
  url: string
  port: number
  /** Закрыть сервер (backend.close() не трогает — жизнь бэкенда чужая). */
  close(): Promise<void>
}

/** Keepalive-комментарий долгих SSE-каналов Node-маршрутов (`/workspace/events`, плагины, настройки), мс. */
const WORKSPACE_EVENTS_KEEPALIVE_MS = SSE_KEEPALIVE_MS

// ────────────────────────────────────────────────────────────────────────────
// serveBackend
// ────────────────────────────────────────────────────────────────────────────

/**
 * Поднимает HTTP-сервер над бэкендом (§9).
 *
 * ```ts
 * const srv = await serveBackend(backend, { port: 7331 })
 * const client = createHttpBackend(srv.url)
 * ```
 */
export async function serveBackend(
  givenBackend: ProtocolBackend,
  opts: ServeBackendOpts = {},
): Promise<ServeHandle> {
  const users = opts.users
  // Подхват идущего рана (v1.31): ран живёт в процессе, а не в потоке запроса.
  // С пользователями оборачивает гейт — его виды делят один снимок.
  const rootBackend = users || hasRunAttach(givenBackend) ? givenBackend : withRunAttach(givenBackend)
  const host = opts.host ?? '127.0.0.1'
  const basePath = normalizeBasePath(opts.basePath)
  const cors = opts.cors ?? false
  const maxBody = opts.maxBodyBytes ?? MAX_BODY_BYTES
  const authKey = opts.authKey === '' ? undefined : opts.authKey

  /** Ключ из заголовка `Authorization: Bearer` или query `auth`; сравнение постоянного времени. */
  function authorized(req: IncomingMessage, query: URLSearchParams): boolean {
    return keyMatches(req.headers.authorization, query, authKey!)
  }

  /** Строгий режим `raw` без гейта и ключа: локальный процесс или подтверждённый JWT Cloudflare Access. */
  async function rawTrusted(req: IncomingMessage): Promise<boolean> {
    if (isLocalRequest(req)) return true
    const access = opts.fileSign?.access
    if (!access) return false
    const jar = String(req.headers.cookie ?? '')
    const jwt = (req.headers['cf-access-jwt-assertion'] as string | undefined) ?? /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(jar)?.[1]
    if (!jwt) return false
    return (await access.verify(jwt).catch(() => null)) != null
  }

  // Ядро провода: маршруты `createStoreBackend` — тем же кодом, что `createFetchHandler`.
  // Транспорт достраивает capabilities своими опциями (скины, плагины, настройки, файлы вне пространств, терминал).
  const core = createWireCore({
    cors,
    maxBodyBytes: maxBody,
    capabilities: async (given, request) => {
      let caps = given
      if (opts.skins) caps = { ...caps, skins: { ...(opts.skins.save ? { save: true } : {}), ...(opts.skins.select ? { select: true } : {}), ...(opts.skins.userCss && opts.skins.saveUserCss ? { user: true } : {}) } }
      if (opts.plugins) caps = { ...caps, plugins: await opts.plugins.list() }
      if (opts.settings) {
        const watch = opts.settings.watch !== undefined
        caps = {
          ...caps,
          settings: { layers: [...SERVER_SETTINGS_LAYERS], ...(watch ? { watch: true } : {}) },
          ...(watch ? { services: { ...caps.services, [SETTINGS_SERVICE]: { methods: [], streams: [SETTINGS_CHANGES_STREAM] } } } : {}),
        }
      }
      if (opts.external) {
        const ext = opts.external.capability()
        caps = { ...caps, ...ext, ...(opts.fileSign ? { files: { ...caps.files, ...ext.files, sign: true } } : {}) }
      }
      if (opts.pty) caps = { ...caps, pty: { run: true } } as typeof caps
      if (opts.devices) caps = { ...caps, devices: opts.devices.capability(request.headers.get(PEER_HEADER) ?? undefined) }
      return caps
    },
    ...(opts.devices ? { client: (c: NonNullable<RunStartInput['client']>, request: Request) => opts.devices!.client(c, request.headers.get(PEER_HEADER) ?? undefined) } : {}),
  })

  const server = createServer((req, res) => {
    // Клиент вправе отвалиться на любом байте (SSE рвут регулярно — §5.4).
    // Без слушателей EPIPE/ECONNRESET прилетают необработанным 'error' на
    // стриме и роняют весь процесс — сервер обязан это пережить молча.
    res.on('error', () => {})
    req.on('error', () => {})

    handle(req, res).catch((err) => {
      // Последний рубеж: до сюда долетает только баг самого биндинга.
      if (!res.headersSent) sendEnvelope(res, 500, { ok: false, error: errorMessage(err) }, cors)
      else res.end()
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (cors && req.method === 'OPTIONS') {
      // Private Network Access: страница с публичного origin (или `null` —
      // песочница iframe) к 127.0.0.1 — Chrome спрашивает разрешение preflight'ом.
      const pna = req.headers['access-control-request-private-network'] === 'true'
      res.writeHead(204, { ...corsHeaders(), ...(pna ? { 'access-control-allow-private-network': 'true' } : {}) })
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    // v1.72: подписанный адрес сырого файла — сам себе пропуск (кадр без куки, мимо Access).
    const rawSegs = opts.external && opts.fileSign ? routeSegments(url.pathname, basePath) : null
    const isRaw = rawSegs?.length === 3 && rawSegs[0] === 'files' && rawSegs[1] === 'external' && rawSegs[2] === 'raw'
    if (isRaw && url.searchParams.has('sig')) {
      const q = url.searchParams
      const verdict = opts.fileSign!.check({ path: q.get('path') ?? '', host: q.get('host'), thumb: q.get('thumb'), exp: q.get('exp'), sig: q.get('sig') })
      if (verdict !== 'ok') {
        const expired = verdict === 'expired'
        sendEnvelope(
          res,
          expired ? 401 : 403,
          { ok: false, error: expired ? 'files.external.raw: подпись адреса истекла — обновите страницу' : 'files.external.raw: подпись адреса не сходится', code: expired ? CODE_UNAUTHORIZED : CODE_FORBIDDEN },
          cors,
        )
        return
      }
      try {
        await route(rootBackend, req, res, req.method ?? 'GET', rawSegs!, maxBody, q, undefined)
      } catch (err) {
        const { status, body } = errorEnvelope(err)
        if (!res.headersSent) sendEnvelope(res, status, body, cors)
        else res.end()
      }
      return
    }
    // Строгий режим: путь `raw` открыт мимо Access — без подписи только признанный запрос.
    if (isRaw && opts.fileSign!.strict && !users && authKey === undefined && !(await rawTrusted(req))) {
      sendEnvelope(res, 401, { ok: false, error: 'files.external.raw: нужен подписанный адрес (exp, sig) или вход', code: CODE_UNAUTHORIZED }, cors)
      return
    }
    if (authKey !== undefined && !authorized(req, url.searchParams)) {
      res.setHeader('www-authenticate', 'Bearer')
      sendEnvelope(res, 401, { ok: false, error: 'unauthorized: нужен ключ (Authorization: Bearer …)', code: CODE_UNAUTHORIZED }, cors)
      return
    }
    // Декодируем ПОСЛЕ нарезки: %2F внутри id — часть id, а не граница сегмента.
    const segs = routeSegments(url.pathname, basePath)
    if (!segs) {
      sendEnvelope(res, 404, { ok: false, error: `No route for ${url.pathname}`, code: CODE_NOT_FOUND }, cors)
      return
    }
    const method = req.method ?? 'GET'

    try {
      // Пользователи стенда (v1.30): вход по ссылке — до проверки; дальше каждый
      // запрос — от имени вошедшего, роуты видят бэкенд его глазами.
      let backend = rootBackend
      /** Пользователь запроса (гейт пользователей); нет гейта — `undefined` (владелец стенда решает источник). */
      let userId: string | undefined
      if (users) {
        if (segs[0] === 'auth' && segs.length === 2 && (segs[1] === 'join' || segs[1] === 'login')) {
          if (method !== 'POST') throw methodNotAllowed(method, `/auth/${segs[1]}`)
          const body = await readJson<{ token?: unknown }>(req, maxBody)
          if (typeof body.token !== 'string' || body.token === '') throw badRequest('auth: нужен token')
          const got = await users.redeem(segs[1], body.token, req)
          if (!got) throw new WireError('ссылка недействительна: уже использована, истекла или отозвана', CODE_UNAUTHORIZED, 401)
          res.setHeader('set-cookie', got.setCookie)
          const caps = await users.backendFor(got.identity).capabilities()
          return sendEnvelope(res, 200, { ok: true, result: { user: caps.users?.me } }, cors)
        }
        // Вход через сервис `id` (identity-spec §8): куда идти и где обновить токен — без входа.
        if (segs[0] === 'auth' && segs.length === 2 && segs[1] === 'id' && method === 'GET') {
          const id = users.idLogin?.(url.searchParams.get('return') ?? String(req.headers.origin ?? req.headers.referer ?? ''))
          if (!id) throw new WireError('вход через id не настроен', 'not_found', 404)
          return sendEnvelope(res, 200, { ok: true, result: id }, cors)
        }
        const auth = await users.authenticate(req)
        if (!auth.ok) {
          if (auth.clearCookie) res.setHeader('set-cookie', users.clearCookie(req))
          return sendEnvelope(res, 401, { ok: false, error: `unauthorized: ${auth.reason}`, code: CODE_UNAUTHORIZED, ...(auth.login ? { login: auth.login } : {}) } as never, cors)
        }
        if (auth.setCookie) res.setHeader('set-cookie', auth.setCookie)
        if (segs[0] === 'auth' && segs.length === 2 && segs[1] === 'logout' && method === 'POST') {
          await users.logout(auth.identity)
          res.setHeader('set-cookie', users.clearCookie(req))
          return sendEnvelope(res, 200, { ok: true }, cors)
        }
        // Скины стенда общие (выбор и запись) — только owner стенда.
        // user.css (v1.32) — свой у каждого: пишет любой вошедший, в свой файл.
        if (opts.external && ((segs[0] === 'files' && segs[1] === 'external') || segs[0] === 'host') && !users.isOwner(auth.identity)) {
          throw new WireError('файлы вне пространств и действия хоста — только owner стенда', CODE_FORBIDDEN, 403)
        }
        if (opts.pty && segs[0] === 'pty' && !users.isOwner(auth.identity)) {
          throw new WireError('терминал — только owner стенда', CODE_FORBIDDEN, 403)
        }
        if (segs[0] === 'skins' && segs[1] !== 'user' && method === 'PUT' && !users.isOwner(auth.identity)) {
          throw new WireError('skins: только owner стенда', CODE_FORBIDDEN, 403)
        }
        backend = users.backendFor(auth.identity)
        userId = auth.identity.user.id
      }
      await route(backend, req, res, method, segs, maxBody, url.searchParams, userId)
    } catch (err) {
      const { status, body } = errorEnvelope(err)
      if (!res.headersSent) sendEnvelope(res, status, body, cors)
      else res.end()
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Таблица роутов §9
  // ──────────────────────────────────────────────────────────────────────────

  async function route(
    backend: ProtocolBackend,
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    segs: string[],
    maxBody: number,
    query: URLSearchParams,
    userId?: string,
  ): Promise<void> {
    const ok = <T>(result?: T, version?: string) =>
      sendEnvelope(res, 200, { ok: true, result, version }, cors)

    // Файл вне пространств (v1.41): GET /files/external/{stat,read,list,raw}?path=
    // v1.42: `host=` у всех; POST /files/external/{write,mkdir,rename,delete,copy},
    // GET /files/external/search?path=&glob=&query=, SSE GET /files/external/events?path=, raw?thumb=
    if (segs[0] === 'files' && segs[1] === 'external' && segs.length === 3 && opts.external) {
      const ext = opts.external
      const op = segs[2]!
      if (method === 'POST') {
        const body = await readJson<Record<string, unknown>>(req, maxBody)
        const str = (k: string): string => {
          const v = body[k]
          if (typeof v !== 'string' || v === '') throw badRequest(`files.external.${op}: нужен ${k}`)
          return v
        }
        const where = typeof body.host === 'string' && body.host !== '' ? { host: body.host } : {}
        const need = <T>(fn: T | undefined): T => {
          if (!fn) throw new NotSupportedError(`files.external.${op}`)
          return fn
        }
        switch (op) {
          case 'write': {
            if (typeof body.content !== 'string') throw badRequest('files.external.write: нужен content')
            const revision = body.revision === null ? null : typeof body.revision === 'string' ? body.revision : undefined
            return ok(
              await need(ext.write)(str('path'), body.content, {
                ...where,
                ...(body.encoding === 'base64' ? { encoding: 'base64' as const } : {}),
                ...(revision !== undefined ? { revision } : {}),
              }),
            )
          }
          case 'mkdir':
            await need(ext.mkdir)(str('path'), where)
            return ok({})
          case 'rename':
            await need(ext.rename)(str('from'), str('to'), where)
            return ok({})
          case 'delete':
            return ok(await need(ext.delete)(str('path'), { ...where, ...(body.permanent === true ? { permanent: true } : {}) }))
          case 'copy':
            await need(ext.copy)(str('from'), str('to'), { ...where, ...(body.overwrite === true ? { overwrite: true } : {}) })
            return ok({})
        }
        throw new WireError(`No route for POST /files/external/${op}`, CODE_NOT_FOUND, 404)
      }
      if (method !== 'GET' && method !== 'HEAD') throw methodNotAllowed(method, '/files/external/…')
      // v1.72: ключ подписи адресов `raw` — тому, кому можно `files.external` (гейт проверил выше).
      if (op === 'sign') {
        if (!opts.fileSign) throw new NotSupportedError('files.sign')
        res.setHeader('cache-control', 'no-store')
        return ok(opts.fileSign.issue())
      }
      const p = requirePath(query, `files.external.${op}`)
      const hostQ = query.get('host')
      const where = hostQ ? { host: hostQ } : {}
      switch (op) {
        case 'stat':
          return ok(await ext.stat(p, where))
        // v1.54: на каких хостах есть путь
        case 'locate':
          if (!ext.locate) throw new NotSupportedError('files.external.locate')
          return ok(await ext.locate(p))
        case 'read': {
          const max = query.get('maxBytes')
          return ok(await ext.read(p, { ...where, ...(max ? { maxBytes: Number(max) } : {}) }))
        }
        case 'list':
          return ok(await ext.list(p, where))
        case 'raw': {
          const thumb = Number(query.get('thumb') ?? '')
          // v1.45: чужой хост — эскиз из кэша хаба, иначе оригинал потоком кусков
          const remote = hostQ && ext.openRaw ? ext.openRaw.bind(ext) : null
          const thumbFile = remote && thumb > 0 && thumbKind(p) ? await ext.thumb(p, thumb, where) : null
          if (remote && thumb > 0 && thumbKind(p) && !thumbFile) throw Object.assign(new Error(`эскиз не сделан, файл не читается: ${p}`), { code: 'unreadable' })
          if (thumbFile) {
            const data = await readFile(thumbFile)
            if (notModified(req, res, bytesTag(data), null, THUMB_CACHE)) return
            return sendAsset(res, new Uint8Array(data.buffer, data.byteOffset, data.byteLength), thumbMime(data.subarray(0, 12)))
          }
          // Имя файла при «Сохранить как» и скачивании; `?download=1` — сразу файлом, не в окне.
          const name = p.slice(p.replace(/\/+$/, '').lastIndexOf('/') + 1) || 'file'
          const disposition = `${query.get('download') === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`
          // Чужой хост: тоже с Range и `accept-ranges` — без них WebKit (Safari, NR Pics.app) медиа не играет.
          if (remote) {
            const st = await ext.stat(p, where)
            if (!st.exists) throw Object.assign(new Error(`файла нет: ${st.path}`), { code: 'not_found' })
            if (st.kind !== 'file') throw Object.assign(new Error(`это каталог: ${st.path}`), { code: 'bad_request' })
            const size = st.size ?? 0
            const range = byteRange(req.headers.range, size)
            if (range === 'bad') {
              res.writeHead(416, { 'content-range': `bytes */${size}`, ...(cors ? corsHeaders() : {}) })
              res.end()
              return
            }
            // валидатор по stat — повторное открытие отвечает 304, файл через агента машины не тянется.
            const tag = statTag(st)
            if (!range && notModified(req, res, tag, st.mtime, RAW_CACHE)) return
            const [start, end] = range ?? [0, size - 1]
            const stream = method === 'HEAD' || size === 0 ? null : await remote(p, { ...where, range: [start, end] })
            res.writeHead(range ? 206 : 200, {
              'content-type': rawMime(st.path) ?? stream?.mime ?? 'application/octet-stream',
              'content-length': Math.max(0, end - start + 1),
              'accept-ranges': 'bytes',
              'content-disposition': disposition,
              ...validators(tag, st.mtime, RAW_CACHE),
              ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
              ...(cors ? corsHeaders() : {}),
            })
            if (stream) {
              for await (const chunk of stream.chunks) {
                if (res.destroyed) break
                if (!res.write(chunk)) await new Promise<void>((go) => res.once('drain', go))
              }
            }
            res.end()
            return
          }
          // Видео и звук на этом хосте (pics-spec §2): потоком и с Range — перемотка, файлы больше 50 МБ.
          if (!(thumb > 0) && MEDIA_RE.test(p)) {
            const st = await ext.stat(p, where)
            if (!st.exists) throw Object.assign(new Error(`файла нет: ${st.path}`), { code: 'not_found' })
            if (st.kind !== 'file') throw Object.assign(new Error(`это каталог: ${st.path}`), { code: 'bad_request' })
            const real = await realpath(process.platform === 'win32' ? winFromWire(st.path) : st.path)
            const size = st.size ?? 0
            const range = byteRange(req.headers.range, size)
            if (range === 'bad') {
              res.writeHead(416, { 'content-range': `bytes */${size}`, ...(cors ? corsHeaders() : {}) })
              res.end()
              return
            }
            const tag = statTag(st)
            if (!range && notModified(req, res, tag, st.mtime, RAW_CACHE)) return
            const [start, end] = range ?? [0, size - 1]
            res.writeHead(range ? 206 : 200, {
              'content-type': rawMime(st.path) ?? st.mime ?? 'application/octet-stream',
              'content-length': Math.max(0, end - start + 1),
              'accept-ranges': 'bytes',
              'content-disposition': disposition,
              ...validators(tag, st.mtime, RAW_CACHE),
              ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
              ...(cors ? corsHeaders() : {}),
            })
            if (method === 'HEAD' || size === 0) return void res.end()
            const stream = createReadStream(real, { start, end })
            res.on('close', () => stream.destroy())
            stream.on('error', () => res.destroy())
            stream.pipe(res)
            return
          }
          const file = await readExternalRaw(ext, p, { ...where, ...(thumb > 0 ? { thumb } : {}) })
          if (!(thumb > 0)) res.setHeader('content-disposition', disposition)
          const tag = thumb > 0 ? bytesTag(file.data) : statTag(file)
          if (notModified(req, res, tag, thumb > 0 ? null : file.mtime, thumb > 0 ? THUMB_CACHE : RAW_CACHE)) return
          return sendAsset(res, file.data, file.mime)
        }
        case 'search': {
          if (!ext.search) throw new NotSupportedError('files.external.search')
          const q = (k: string): string | undefined => query.get(k) ?? undefined
          const limit = q('limit')
          return ok(
            await ext.search(
              p,
              {
                ...(q('glob') ? { glob: q('glob')! } : {}),
                ...(q('query') ? { query: q('query')! } : {}),
                ...(q('regex') === '1' || q('regex') === 'true' ? { regex: true } : {}),
                ...(q('case') === '1' || q('case') === 'true' ? { case: true } : {}),
                ...(limit ? { limit: Number(limit) } : {}),
              },
              where,
            ),
          )
        }
        case 'disk':
          // v1.45: место на томе под путём — Ctrl+L панели на любом хосте
          if (!ext.disk) throw new NotSupportedError('files.external.disk')
          return ok(await ext.disk(p, where))
        case 'events': {
          const watch = ext.watch
          if (!watch) throw new NotSupportedError('files.external.watch')
          const recursive = query.get('recursive') === '1' || query.get('recursive') === 'true'
          return streamEvents(res, (listener) => watch(p, listener, { ...where, ...(recursive ? { recursive: true } : {}) }), serializeExternalEvent, 'external events')
        }
      }
      throw new WireError(`No route for /files/external/${op}`, CODE_NOT_FOUND, 404)
    }

    // Общий терминал: GET|POST /pty, POST /pty/run, GET /pty/read, GET|DELETE /pty/<id>
    if (segs[0] === 'pty' && opts.pty) {
      const pty = opts.pty
      if (!ptyOriginAllowed(req, opts.ptyOrigins)) throw new WireError('терминал: чужой Origin', CODE_FORBIDDEN, 403)
      if (segs.length === 1) {
        if (method === 'GET') return ok(await pty.list())
        if (method !== 'POST') throw methodNotAllowed(method, '/pty')
        const body = await readJson<{ id?: unknown; cwd?: unknown; cols?: unknown; rows?: unknown }>(req, maxBody)
        const id = typeof body.id === 'string' && body.id ? body.id : `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
        return ok(
          await pty.ensure(id, {
            ...(typeof body.cwd === 'string' && body.cwd ? { cwd: body.cwd } : {}),
            ...(typeof body.cols === 'number' ? { cols: body.cols } : {}),
            ...(typeof body.rows === 'number' ? { rows: body.rows } : {}),
          }),
        )
      }
      if (segs.length === 2 && segs[1] === 'run') {
        if (method !== 'POST') throw methodNotAllowed(method, '/pty/run')
        const body = await readJson<{ terminal?: unknown; command?: unknown; mode?: unknown; timeout?: unknown; wait?: unknown }>(req, maxBody)
        if (typeof body.command !== 'string' || body.command.trim() === '') throw badRequest('terminal.run: нужна command')
        if (body.mode !== undefined && body.mode !== 'insert' && body.mode !== 'execute') throw badRequest('terminal.run: mode — insert или execute')
        return ok(
          await pty.run({
            command: body.command,
            ...(typeof body.terminal === 'string' && body.terminal ? { terminal: body.terminal } : {}),
            ...(body.mode ? { mode: body.mode } : {}),
            ...(typeof body.timeout === 'number' ? { timeout: body.timeout } : {}),
            ...(typeof body.wait === 'number' ? { wait: body.wait } : {}),
          }),
        )
      }
      if (segs.length === 2 && segs[1] === 'read') {
        if (method !== 'GET') throw methodNotAllowed(method, '/pty/read')
        const terminal = query.get('terminal')
        const lines = Number(query.get('lines'))
        return ok(await pty.read({ ...(terminal ? { terminal } : {}), ...(lines > 0 ? { lines } : {}) }))
      }
      if (segs.length === 2) {
        if (method === 'GET') {
          const info = await pty.info(segs[1]!)
          if (!info) throw new WireError(`терминала «${segs[1]}» нет`, CODE_NOT_FOUND, 404)
          return ok(info)
        }
        if (method === 'DELETE') return ok({ killed: await pty.kill(segs[1]!) })
        throw methodNotAllowed(method, '/pty/<id>')
      }
      throw new WireError('No route for /pty/…', CODE_NOT_FOUND, 404)
    }

    // Действия хоста (v1.41): POST /host/reveal {path, dryRun?}, POST /host/open {path, app?, dryRun?}
    // v1.54: `host` — хост файла, `on` — машина, где открыть (роутер хостов)
    if (segs[0] === 'host' && segs.length === 2 && opts.external) {
      const host = opts.external.host
      if (!host) throw new NotSupportedError(`host.${segs[1]}`)
      if (method !== 'POST') throw methodNotAllowed(method, `/host/${segs[1]}`)
      const body = await readJson<{ path?: unknown; app?: unknown; dryRun?: unknown; host?: unknown; on?: unknown }>(req, maxBody)
      if (typeof body.path !== 'string' || body.path === '') throw badRequest(`host.${segs[1]}: нужен path`)
      const dryRun = body.dryRun === true
      const where = {
        ...(typeof body.host === 'string' && body.host !== '' ? { host: body.host } : {}),
        ...(typeof body.on === 'string' && body.on !== '' ? { on: body.on } : {}),
      }
      if (segs[1] === 'reveal') return ok(await host.reveal(body.path, { dryRun, ...where }))
      if (segs[1] === 'open') return ok(await host.open(body.path, { ...(typeof body.app === 'string' ? { app: body.app } : {}), dryRun, ...where }))
      throw new WireError(`No route for /host/${segs[1]}`, CODE_NOT_FOUND, 404)
    }

    // Хозяин сервисов контура: GET /services — capability его сервисов для хабов-соседей
    if (segs[0] === 'services' && segs.length === 1 && opts.servicesOwner) {
      if (method !== 'GET') throw methodNotAllowed(method, '/services')
      return ok(await opts.servicesOwner.capability())
    }

    // Внешние плагины (v1.24): GET /plugins/events — SSE пересборок, GET /plugins/<id>/<путь> — файл бандла
    if (segs[0] === 'plugins' && opts.plugins) {
      if (method !== 'GET' && method !== 'HEAD') throw methodNotAllowed(method, '/plugins/…')
      if (segs.length === 2 && segs[1] === 'events') {
        const watch = opts.plugins.watch?.bind(opts.plugins)
        if (!watch) throw new NotSupportedError('plugins.watch')
        return streamEvents(res, watch, serializePluginChanged, 'plugin events')
      }
      if (segs.length < 3) throw new WireError('plugins: нужен /plugins/<id>/<путь>', CODE_NOT_FOUND, 404)
      const file = await opts.plugins.file(segs[1]!, segs.slice(2).join('/'))
      if (!file) throw new WireError(`plugins: нет ${segs.slice(1).join('/')}`, CODE_NOT_FOUND, 404)
      // Версия — в `?v=` адреса; сам файл не кэшируется: пересборка видна перезагрузкой.
      res.setHeader('cache-control', 'no-cache')
      return sendAsset(res, file.data, file.mime)
    }

    // Настройки по слоям (v1.40, settings-spec §3): GET|PUT|DELETE /settings
    if (segs[0] === 'settings' && segs.length === 1) {
      const settings = opts.settings
      if (!settings) throw new NotSupportedError('settings')
      if (method === 'GET') {
        const ctx = settingsContext(query)
        let scopes: SettingsScopes | undefined
        const rawScopes = query.get('scopes')
        if (rawScopes) {
          try {
            scopes = JSON.parse(rawScopes) as SettingsScopes
          } catch {
            throw badRequest('settings.get: scopes — JSON')
          }
        }
        return ok(await settings.get({ ...ctx, ...(scopes ? { scopes } : {}) }, userId))
      }
      if (method === 'PUT' || method === 'DELETE') {
        const body = await readJson<{ plugin?: unknown; key?: unknown; value?: unknown; layer?: unknown; context?: unknown }>(req, maxBody)
        if (typeof body.plugin !== 'string' || typeof body.key !== 'string') throw badRequest('settings: нужны plugin:string и key:string')
        if (!isSettingsLayer(body.layer)) throw badRequest('settings: layer — один из слоёв')
        const context = bodyContext(body.context)
        const target = { plugin: body.plugin, key: body.key, layer: body.layer, context }
        if (method === 'DELETE') return ok(await settings.reset(target, userId))
        if (!('value' in body)) throw badRequest('settings.set: нужен value')
        return ok(await settings.set({ ...target, value: body.value }, userId))
      }
      throw methodNotAllowed(method, '/settings')
    }

    // Скины (v1.21, skin-spec §5): GET /skins, GET|PUT /skins/<имя>.css, PUT /skins/current;
    // user.css (v1.32): GET|PUT /skins/user — пользователя запроса.
    if (segs[0] === 'skins') {
      const skins = opts.skins ?? backend.skins
      if (!skins) throw new NotSupportedError('skins.list')
      const sessionId = query.get('session') || undefined
      const listOpts = sessionId ? { sessionId } : undefined
      if (segs.length === 2 && segs[1] === 'user') {
        const who = userId ? { userId } : undefined
        if (method === 'GET') {
          if (!skins.userCss) throw new NotSupportedError('skins.user')
          const css = await skins.userCss(who)
          res.writeHead(200, {
            'content-type': 'text/css; charset=utf-8',
            'content-length': Buffer.byteLength(css),
            'cache-control': 'no-cache',
            ...(cors ? corsHeaders() : {}),
          })
          res.end(css)
          return
        }
        if (method === 'PUT') {
          if (!skins.saveUserCss) throw new NotSupportedError('skins.user')
          const body = await readJson<{ css?: unknown }>(req, maxBody)
          if (typeof body.css !== 'string') throw badRequest('skins.user requires css:string')
          await skins.saveUserCss(body.css, who)
          return ok()
        }
        throw methodNotAllowed(method, '/skins/user')
      }
      if (segs.length === 1) {
        if (method !== 'GET') throw methodNotAllowed(method, '/skins')
        return ok(await skins.list(listOpts))
      }
      if (segs.length === 2 && segs[1] === 'current') {
        if (method !== 'PUT') throw methodNotAllowed(method, '/skins/current')
        if (!skins.select) throw new NotSupportedError('skins.select')
        const body = await readJson<{ name?: unknown; mode?: unknown }>(req, maxBody)
        if (typeof body.name !== 'string' || body.name === '' || (body.mode !== 'light' && body.mode !== 'dark')) {
          throw badRequest("skins.select requires name:string and mode:'light'|'dark'")
        }
        await skins.select({ name: body.name, mode: body.mode })
        return ok()
      }
      if (segs.length === 2 && segs[1]!.endsWith('.css')) {
        const name = segs[1]!.slice(0, -'.css'.length)
        if (method === 'GET') {
          const css = await skins.css(name, listOpts)
          res.writeHead(200, {
            'content-type': 'text/css; charset=utf-8',
            'content-length': Buffer.byteLength(css),
            'cache-control': 'no-cache',
            ...(cors ? corsHeaders() : {}),
          })
          res.end(css)
          return
        }
        if (method === 'PUT') {
          if (!skins.save) throw new NotSupportedError('skins.save')
          const body = await readJson<{ css?: unknown; sessionId?: unknown; description?: unknown; mode?: unknown; base?: unknown; origin?: unknown; license?: unknown; author?: unknown }>(req, maxBody)
          if (typeof body.css !== 'string') throw badRequest('skins.save requires css:string')
          const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
          const mode = body.mode === 'light' || body.mode === 'dark' || body.mode === 'both' ? (body.mode as SkinMode) : undefined
          const saveOpts = {
            ...(str(body.sessionId) ? { sessionId: str(body.sessionId)! } : {}),
            ...(str(body.description) ? { description: str(body.description)! } : {}),
            ...(mode ? { mode } : {}),
            ...(str(body.base) ? { base: str(body.base)! } : {}),
            // Шапка импорта темы: откуда, лицензия, автор.
            ...(str(body.origin) ? { origin: str(body.origin)! } : {}),
            ...(str(body.license) ? { license: str(body.license)! } : {}),
            ...(str(body.author) ? { author: str(body.author)! } : {}),
          }
          return ok(await skins.save(name, body.css, saveOpts))
        }
        throw methodNotAllowed(method, '/skins/:name.css')
      }
      throw new WireError(`No route for /skins/${segs.slice(1).join('/')}`, CODE_NOT_FOUND, 404)
    }

    // GET /workspace/repos?workspace= — проекты пространства (v1.35, spaces-spec §2)
    if (segs.length === 2 && segs[0] === 'workspace' && segs[1] === 'repos') {
      if (method !== 'GET') throw methodNotAllowed(method, '/workspace/repos')
      if (!backend.workspace?.repos) throw new NotSupportedError('workspace.repos')
      const ws = query.get('workspace')
      return ok(await backend.workspace.repos(ws ? { workspace: ws } : undefined))
    }

    // Файлы пространства (workspace-files-spec §1): /workspace/files,
    // /workspace/file[/rename|/stat], /workspace/events. Вход проверяется до
    // бэкенда; «не умею» — not_supported, как у остальных опциональных ops.
    if (segs[0] === 'workspace' && segs.length >= 2) {
      // ?workspace= (v1.33) — файлы проекта вкладки; бэкенд без `at` — как есть.
      const tabWs = query.get('workspace')
      const all = backend.workspace?.files
      const files = tabWs && all?.at ? all.at(tabWs) : all
      const op = segs.slice(1).join('/')

      // GET /workspace/files?path= → list (без path — корень)
      if (op === 'files' && method === 'GET') {
        if (!files) throw new NotSupportedError('workspace.files.list')
        return ok(await files.list(query.get('path') ?? undefined))
      }

      if (op === 'file') {
        // GET /workspace/file?path=&maxBytes= → read
        if (method === 'GET') {
          const path = requirePath(query, 'read')
          const raw = query.get('maxBytes')
          let readOpts: FileReadOpts | undefined
          if (raw !== null) {
            const maxBytes = Number(raw)
            if (raw === '' || !Number.isInteger(maxBytes) || maxBytes < 0) {
              throw badRequest('read: maxBytes must be a non-negative integer')
            }
            readOpts = { maxBytes }
          }
          if (!files) throw new NotSupportedError('workspace.files.read')
          return ok(await files.read(path, readOpts))
        }
        // PUT /workspace/file {path, content, encoding?, revision?} → write
        if (method === 'PUT') {
          const body = await readJson<{ path?: unknown; content?: unknown; encoding?: unknown; revision?: unknown }>(req, maxBody)
          if (typeof body.path !== 'string' || body.path === '') throw badRequest('write requires path: non-empty string')
          if (typeof body.content !== 'string') throw badRequest('write requires content: string')
          if (body.encoding !== undefined && body.encoding !== 'utf8' && body.encoding !== 'base64') {
            throw badRequest("write: encoding must be 'utf8' or 'base64'")
          }
          if (body.revision !== undefined && body.revision !== null && typeof body.revision !== 'string') {
            throw badRequest('write: revision must be a string or null')
          }
          if (!files?.write) throw new NotSupportedError('workspace.files.write')
          const writeOpts: FileWriteOpts = {}
          if (body.encoding !== undefined) writeOpts.encoding = body.encoding
          // null на проводе — «создать»; поля нет — запись как есть.
          if (body.revision !== undefined) writeOpts.revision = body.revision
          return ok(await files.write(body.path, body.content, writeOpts))
        }
        // DELETE /workspace/file?path= → delete (в корзину пространства)
        if (method === 'DELETE') {
          const path = requirePath(query, 'delete')
          if (!files?.delete) throw new NotSupportedError('workspace.files.delete')
          await files.delete(path)
          return ok()
        }
        throw methodNotAllowed(method, '/workspace/file')
      }

      // POST /workspace/file/rename {from, to}
      if (op === 'file/rename' && method === 'POST') {
        const body = await readJson<{ from?: unknown; to?: unknown }>(req, maxBody)
        if (typeof body.from !== 'string' || body.from === '' || typeof body.to !== 'string' || body.to === '') {
          throw badRequest('rename requires from and to: non-empty strings')
        }
        if (!files?.rename) throw new NotSupportedError('workspace.files.rename')
        await files.rename(body.from, body.to)
        return ok()
      }

      // GET /workspace/file/stat?path= (роута §1 не даёт — добавлен по симметрии с list/read)
      if (op === 'file/stat' && method === 'GET') {
        if (!files?.stat) throw new NotSupportedError('workspace.files.stat')
        return ok(await files.stat(query.get('path') ?? ''))
      }

      // POST /workspace/files/search {query, regex?, case?, glob?, limit?} (v1.28)
      if (op === 'files/search' && method === 'POST') {
        const body = await readJson<FileSearchQuery>(req, maxBody)
        if (!files?.search) throw new NotSupportedError('workspace.files.search')
        return ok(await files.search(body))
      }

      // GET /workspace/events → SSE workspace_update (capability workspace.files.watch)
      if (op === 'events' && method === 'GET') {
        if (!files?.watch) throw new NotSupportedError('workspace.files.watch')
        return streamWorkspaceEvents(res, files.watch.bind(files))
      }
    }

    // GET /workspace, POST /workspace {id} (workspace-spec §3)
    if (segs.length === 1 && segs[0] === 'workspace') {
      if (method === 'GET') {
        if (!backend.workspace) throw new NotSupportedError('workspace.current')
        return ok(await backend.workspace.current())
      }
      if (method === 'POST') {
        const body = await readJson<{ id?: string }>(req, maxBody)
        if (typeof body.id !== 'string' || body.id === '') throw badRequest('workspace requires id:string')
        if (!backend.workspace?.switch) throw new NotSupportedError('workspace.switch')
        return ok(await backend.workspace.switch(body.id))
      }
      throw methodNotAllowed(method, '/workspace')
    }

    // GET /workspaces (workspace-spec §3); POST /workspaces {project} — новый проект (v1.26)
    if (segs.length === 1 && segs[0] === 'workspaces') {
      if (method === 'GET') {
        if (!backend.workspace) throw new NotSupportedError('workspace.list')
        return ok(await backend.workspace.list())
      }
      if (method === 'POST') {
        const body = await readJson<Record<string, unknown>>(req, maxBody)
        if (!backend.workspace?.create) throw new NotSupportedError('workspace.create')
        return ok(await backend.workspace.create(body as never))
      }
      throw methodNotAllowed(method, '/workspaces')
    }

    // PATCH /workspaces/:id {patch} — правка проекта (v1.26, capability workspace.edit)
    if (segs.length === 2 && segs[0] === 'workspaces') {
      if (method !== 'PATCH') throw methodNotAllowed(method, '/workspaces/:id')
      const body = await readJson<Record<string, unknown>>(req, maxBody)
      if (!backend.workspace?.update) throw new NotSupportedError('workspace.update')
      return ok(await backend.workspace.update(segs[1]!, body as never))
    }

    // Пользователи стенда (v1.30, users-spec §2) — capability users.admin
    if (segs[0] === 'auth' && segs[1] === 'users') {
      const u = backend.users
      if (!u) {
        if (users) throw new WireError('users: только owner стенда', CODE_FORBIDDEN, 403)
        throw new NotSupportedError('users.list')
      }
      if (segs.length === 2) {
        if (method === 'GET') return ok(await u.list())
        if (method === 'POST') return ok(await u.create(await readJson<UserCreateInput>(req, maxBody)))
        throw methodNotAllowed(method, '/auth/users')
      }
      const uid = segs[2]!
      if (segs.length === 4 && segs[3] === 'invite' && method === 'POST') return ok(await u.invite(uid))
      if (segs.length === 4 && segs[3] === 'login-link' && method === 'POST') return ok(await u.loginLink(uid))
      if (segs.length === 4 && segs[3] === 'devices' && method === 'GET') return ok(await u.devices(uid))
      if (segs.length === 5 && segs[3] === 'devices' && method === 'DELETE') {
        await u.revoke(uid, segs[4]!)
        return ok()
      }
      throw new WireError(`No route for ${method} /${segs.join('/')}`, CODE_NOT_FOUND, 404)
    }

    // GET /bots, /bots/:id, /bots/:id/assets/:file
    if (segs[0] === 'bots' && method === 'GET') {
      if (segs.length === 1) {
        if (!backend.catalog) throw new NotSupportedError('catalog.bots')
        return ok(await backend.catalog.bots())
      }
      if (segs.length === 2) {
        if (!backend.catalog) throw new NotSupportedError('catalog.bot')
        return ok(await backend.catalog.bot(segs[1]))
      }
      if (segs.length === 4 && segs[2] === 'assets') {
        if (!backend.catalog?.asset) throw new NotSupportedError('catalog.asset')
        const asset = await backend.catalog.asset(segs[1], segs[3])
        return sendAsset(res, asset.data, asset.mime)
      }
    }

    // Изменения слоёв настроек — стрим сервиса `settings.changes` (v1.40): хост слоёв, не плагин
    if (opts.settings?.watch && segs[0] === 'services' && segs.length === 4 && segs[1] === SETTINGS_SERVICE && segs[2] === SETTINGS_CHANGES_STREAM && segs[3] === 'stream') {
      if (method !== 'POST') throw methodNotAllowed(method, '/services/settings/changes/stream')
      return streamEvents(res, opts.settings.watch.bind(opts.settings), (e) => serializeServiceEvent({ name: SETTINGS_CHANGED_EVENT, payload: e }), 'settings changes')
    }

    // Ядро провода: сессии, ран, сервисы, модели, агенты — одна реализация с fetch-обработчиком
    const response = await core.route(backend, toWebRequest(req), segs, query)
    if (response) return sendWebResponse(res, response, method)

    throw new WireError(`No route for ${method} /${segs.join('/')}`, CODE_NOT_FOUND, 404)
  }

  /** Контекст запроса настроек из строки запроса. */
  function settingsContext(q: URLSearchParams): SettingsContext {
    const out: SettingsContext = {}
    for (const k of ['session', 'space', 'project', 'agent', 'bot'] as const) {
      const v = q.get(k)
      if (v) out[k] = v
    }
    if (q.get('noBot') === 'true') out.noBot = true
    return out
  }

  /** Контекст из тела запроса: только известные строковые поля. */
  function bodyContext(raw: unknown): SettingsContext {
    const out: SettingsContext = {}
    if (typeof raw !== 'object' || raw === null) return out
    for (const k of ['session', 'space', 'project', 'agent', 'bot'] as const) {
      const v = (raw as Record<string, unknown>)[k]
      if (typeof v === 'string' && v !== '') out[k] = v
    }
    if ((raw as Record<string, unknown>).noBot === true) out.noBot = true
    return out
  }


  // ──────────────────────────────────────────────────────────────────────────
  // GET /workspace/events → SSE workspace_update (workspace-files-spec §1)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Канал изменений файлов: живёт, пока клиент держит соединение. Подписка —
   * ДО заголовков: закрытое пространство бросит и уедет обычным Envelope.
   * Keepalive-комментарий не даёт прокси и таймаутам закрыть молчащий канал.
   */
  function streamWorkspaceEvents(res: ServerResponse, watch: (listener: WorkspaceUpdateListener) => () => void): void {
    streamEvents(res, watch, serializeWorkspaceEvent, 'workspace events')
  }

  /** Вечный SSE-канал событий подписки `watch` (файлы пространства, пересборки плагинов). */
  function streamEvents<E>(res: ServerResponse, watch: (listener: (event: E) => void) => () => void, serialize: (event: E) => string, hello: string): void {
    let open = false
    const early: string[] = []
    const unsubscribe = watch((event) => {
      const frame = serialize(event)
      if (!open) early.push(frame)
      else if (!res.writableEnded && !res.destroyed) res.write(frame)
    })

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...(cors ? corsHeaders() : {}),
    })
    res.flushHeaders()
    open = true
    res.write(`: ${hello}\n\n`)
    for (const frame of early) res.write(frame)

    const keepalive = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n')
    }, WORKSPACE_EVENTS_KEEPALIVE_MS)
    keepalive.unref()

    let stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      clearInterval(keepalive)
      unsubscribe()
    }
    res.on('close', stop)
    res.on('error', stop)
    if (res.destroyed) stop()
  }



  function sendEnvelope<T>(
    res: ServerResponse,
    status: number,
    body: WireEnvelope<T>,
    withCors: boolean,
  ): void {
    const json = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(json),
      ...(withCors ? corsHeaders() : {}),
    })
    res.end(json)
  }

  /**
   * кэш сырых файлов. Оригинал — `no-cache` с валидатором (каждый раз сверка, ответ 304 без тела):
   * файл могут переписать на месте (поворот, правка), устаревший кадр хуже лишнего stat. Эскиз — час без
   * сверки, потом по валидатору.
   */
  function validators(tag: string | null, mtime: string | null | undefined, cache: string): Record<string, string> {
    const lm = mtime ? new Date(mtime) : null
    return {
      'cache-control': cache,
      ...(tag ? { etag: tag } : {}),
      ...(lm && !Number.isNaN(lm.getTime()) ? { 'last-modified': lm.toUTCString() } : {}),
    }
  }
  /** Ставит заголовки кэша; совпал валидатор (`If-None-Match`, иначе `If-Modified-Since`) — 304 и `true`. */
  function notModified(req: IncomingMessage, res: ServerResponse, tag: string | null, mtime: string | null | undefined, cache: string): boolean {
    const h = validators(tag, mtime, cache)
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v)
    const inm = req.headers['if-none-match']
    let hit = false
    if (inm) {
      const bare = (t: string): string => t.trim().replace(/^W\//, '')
      hit = !!tag && inm.split(',').some((t) => t.trim() === '*' || bare(t) === bare(tag))
    } else if (h['last-modified']) {
      const since = Date.parse(req.headers['if-modified-since'] ?? '')
      // Last-Modified — с точностью до секунды.
      if (!Number.isNaN(since)) hit = Math.floor(Date.parse(mtime!) / 1000) <= Math.floor(since / 1000)
    }
    if (!hit) return false
    res.writeHead(304, cors ? corsHeaders() : {})
    res.end()
    return true
  }

  function sendAsset(res: ServerResponse, data: Uint8Array, mime?: string): void {
    res.writeHead(200, {
      'content-type': mime ?? 'application/octet-stream',
      'content-length': data.byteLength,
      ...(cors ? corsHeaders() : {}),
    })
    res.end(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
  }

  /** Вкладки терминала (WebSocket): `closeAllConnections` их не видит — закрываем сами. */
  const upgraded = new Set<Duplex>()
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => {})
    upgradeRequest(req, socket, head).catch((err) => rejectSocket(socket, 500, errorMessage(err)))
  })

  /** WebSocket `GET /pty/<id>/attach`: те же ключ, база пути и гейт, что у HTTP; плюс Origin. */
  async function upgradeRequest(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const segs = routeSegments(url.pathname, basePath)
    if (!segs) return rejectSocket(socket, 404, 'not found')
    if (!opts.pty || segs.length !== 3 || segs[0] !== 'pty' || segs[2] !== 'attach') return rejectSocket(socket, 404, 'not found')
    if (authKey !== undefined && !authorized(req, url.searchParams)) return rejectSocket(socket, 401, 'unauthorized')
    if (!ptyOriginAllowed(req, opts.ptyOrigins)) return rejectSocket(socket, 403, 'терминал: чужой Origin')
    if (users) {
      const auth = await users.authenticate(req)
      if (!auth.ok) return rejectSocket(socket, 401, `unauthorized: ${auth.reason}`)
      if (!users.isOwner(auth.identity)) return rejectSocket(socket, 403, 'терминал — только owner стенда')
    }
    upgraded.add(socket)
    socket.once('close', () => upgraded.delete(socket))
    opts.pty.upgrade(req, socket, head, segs[1]!, url.searchParams)
  }

  // Дольше, чем держит соединения прокси (cloudflared — 90 с): иначе Node закрывает
  // простаивающий сокет через 5 с, прокси шлёт по нему запрос и ловит reset.
  server.keepAliveTimeout = 125_000
  server.headersTimeout = 126_000

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const addr = server.address() as AddressInfo
  const hostPart = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address

  return {
    server,
    url: `http://${hostPart}:${addr.port}${basePath}`,
    port: addr.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        for (const s of upgraded) s.destroy()
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Разбор запроса / ошибки
// ────────────────────────────────────────────────────────────────────────────

/** Отказ на upgrade до рукопожатия WebSocket. */
function rejectSocket(socket: Duplex, status: number, message: string): void {
  const body = JSON.stringify({ ok: false, error: message })
  try {
    socket.write(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  } finally {
    socket.destroy()
  }
}

async function readJson<T>(req: IncomingMessage, maxBytes: number): Promise<T> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > maxBytes) throw new WireError('Request body too large', CODE_BAD_REQUEST, 413)
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw === '') return {} as T // пустое тело = пустой вход (§5.1: «продолжай»)
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') throw new Error('body must be a JSON object')
    return parsed as T
  } catch (err) {
    throw new WireError(`Invalid JSON body: ${errorMessage(err)}`, CODE_BAD_REQUEST, 400)
  }
}

/** Обязательный `?path=` файловой операции: пусто — корень, а read/delete корня не бывает. */
function requirePath(query: URLSearchParams, op: string): string {
  const path = query.get('path')
  if (path === null || path === '') throw badRequest(`${op} requires path query parameter`)
  return path
}

// ────────────────────────────────────────────────────────────────────────────
// Адаптер Node ⇄ Web Fetch для ядра провода
// ────────────────────────────────────────────────────────────────────────────

/** IncomingMessage → Web `Request`: тело — потоком, его читает ядро (с лимитом размера). */
function toWebRequest(req: IncomingMessage): Request {
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || k === PEER_HEADER) continue
    if (Array.isArray(v)) for (const one of v) headers.append(k, one)
    else headers.set(k, v)
  }
  // Адрес машины клиента — только от транспорта: входящий заголовок стёрт выше.
  const peer = peerAddress(req.socket.remoteAddress, req.headers)
  if (peer) headers.set(PEER_HEADER, peer)
  const method = req.method ?? 'GET'
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const hasBody = method !== 'GET' && method !== 'HEAD'
  return new Request(url, {
    method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
  } as RequestInit)
}

/**
 * Web `Response` → ServerResponse. SSE (и любой ответ без длины) — потоком,
 * кадр за кадром с немедленным сбросом; клиент ушёл — `cancel()` потока
 * (ран дочитывается в фоне, подписки отписываются — решает ядро).
 */
async function sendWebResponse(res: ServerResponse, response: Response, method: string): Promise<void> {
  const headers: Record<string, string | string[]> = {}
  response.headers.forEach((v, k) => {
    headers[k] = v
  })
  const cookies = response.headers.getSetCookie?.() ?? []
  if (cookies.length) headers['set-cookie'] = cookies
  const streaming = !response.headers.has('content-length')
  if (!response.body || method === 'HEAD') {
    res.writeHead(response.status, headers)
    res.end()
    void response.body?.cancel().catch(() => {})
    return
  }
  if (!streaming) {
    const data = new Uint8Array(await response.arrayBuffer())
    res.writeHead(response.status, headers)
    res.end(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
    return
  }
  const reader = response.body.getReader()
  let gone = false
  const stop = (): void => {
    if (gone) return
    gone = true
    void reader.cancel().catch(() => {})
  }
  res.on('close', stop)
  res.on('error', stop)
  res.writeHead(response.status, headers)
  res.flushHeaders()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done || gone) break
      res.write(value)
    }
  } catch {
    // поток ответа упал — ядро уже сказало, что могло, кадром
  } finally {
    if (!gone) res.end()
  }
}

/** кэш оригинала — сверка каждый раз (304 без тела); эскиза — час без сверки. */
const RAW_CACHE = 'private, no-cache'
const THUMB_CACHE = 'private, max-age=3600'
/** Валидатор оригинала по stat: размер и время правки (одинаковы у своего хоста и у агента машины). */
function statTag(st: { size?: number; mtime?: string }): string | null {
  const t = st.mtime ? Date.parse(st.mtime) : NaN
  if (Number.isNaN(t)) return null
  return `W/"${(st.size ?? 0).toString(36)}-${t.toString(36)}"`
}
/** Валидатор эскиза — по байтам (эскиз мал и лежит в кэше хаба). */
function bytesTag(data: Uint8Array): string {
  return `"${createHash('sha1').update(data).digest('base64url').slice(0, 22)}"`
}

/** Видео и звук — отдаются потоком с Range (`GET /files/external/raw`). */
const MEDIA_RE = /\.(mp4|m4v|mov|webm|mkv|avi|ogv|mp3|wav|ogg|oga|opus|flac|m4a|aac)$/i

/**
 * Один диапазон `Range: bytes=a-b` (`a-`, `-n`) → `[start, end]` включительно; нет заголовка или
 * несколько диапазонов — `null` (весь файл); за пределами файла — `'bad'` (416).
 */
export function byteRange(header: string | undefined, size: number): [number, number] | null | 'bad' {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start: number
  let end: number
  if (m[1] === '') {
    const n = Number(m[2])
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || start > end) return 'bad'
  return [start, end]
}
