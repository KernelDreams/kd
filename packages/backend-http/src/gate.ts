/**
 * Гейт пользователей стенда (users-spec §2–5, протокол v1.30): кто пришёл и что
 * ему видно. `serveBackend({users: gate})` спрашивает гейт о каждом запросе и
 * отдаёт роутам бэкенд **глазами пользователя** (`backendFor`) — проверки в
 * сервере, не во фронте.
 *
 * Вход через сервис `id` (identity-spec §8) — опция `id`: короткий
 * токен `nr_at` (кука на общем домене сайтов `id` или `Authorization: Bearer`)
 * проверяется проверяльщиком хоста (`id.verifier` или `identity.createVerifier`); пользователь стенда —
 * запись с тем же `sub` (`$auth.id`), owner `id` — owner стенда, новый `user` —
 * заводится member без движков Claude. Ссылки и Access при этом выключены —
 * их делает `id`; `local` остаётся. Отказ — 401 со ссылкой входа `id`.
 * Переезд стенда со ссылок на `id` (family): `id.legacyDevices` — старые
 * куки устройств ещё пускают своих людей (без повторного входа); первый вход
 * через `id` с такой кукой привязывает `sub` к этой записи. `id.admin` — ключ
 * админки `id`: «пригласить» и «ссылка входа» админки стенда выдаёт `id`
 * (пользователь `id` заводится под запись стенда, ссылка — вход в его `sub`).
 *
 * Без `id` — вход (§2), по порядку:
 *  1. кука устройства (`nrchat_device`) — вход по ссылке; кука есть, но негодна
 *     (отозвана, истекла) — 401, без провала в «локальный»;
 *  2. проверенный JWT Cloudflare Access (`Cf-Access-Jwt-Assertion` / кука
 *     `CF_Authorization`) — email → пользователь с `$auth.access`;
 *  3. локальный процесс: сокет с loopback и **без** заголовков туннеля
 *     (Cloudflare тоже приходит с 127.0.0.1 — отличаем по `cf-*`) — owner стенда.
 *  Иначе 401. Голый `Cf-Access-Authenticated-User-Email` не читается.
 *
 * Видимость (§3–5) — `backendFor(user)`:
 *  - owner стенда — всё как было; список сессий — свои (и старые без автора),
 *    режим «все пользователи» — `sessions.list({all})`; `users.*` — его;
 *  - member — проекты из `$members` и личный (`user-<id>`), текущий проект — свой
 *    (процесс не переключается), файлы — по роли (viewer — чтение); сессии —
 *    свои и расшаренные; движки — `$engines` (по умолчанию `[nr]`): ACP в
 *    capabilities нет, create/setEngine/ход в ACP-сессию — 403 (**каждая**
 *    операция); профили и проекты не правит; сервисы — только `$services`.
 *  - create пишет автора в мету сессии (`sessionMeta.owner`).
 */

import { hasRunAttach, withRunAttach } from './run-attach.js'
import { activityFeedOf } from './session-activity.js'
import type { IncomingMessage } from 'node:http'
import { DEFAULT_PROJECT_ID, NotSupportedError, pageSessions, SESSION_ACTIVITY_SERVICE, SESSION_ACTIVITY_STREAM } from '@kerneldreams/ui-protocol'
import type {
  AnyRunEvent,
  Capabilities,
  ModelInfo,
  ProjectRole,
  ProtocolBackend,
  RunStartInput,
  SessionCreateOpts,
  SessionInfo,
  SessionListOpts,
  SessionShare,
  UserAuthMethod,
  UserInfo,
  UserLink,
  WorkspaceFilesCapability,
  WorkspaceFilesOps,
  WorkspaceInfo,
} from '@kerneldreams/ui-protocol'
import { defaultLoginUrl, defaultTokenOf, idBaseOf, type AccessOpts, type AccessVerifier, type IdUser, type IdVerifier, type IdentityKit } from './access.js'
import { createProjectFilesRouter, type ProjectFilesFactory, type ProjectFilesRouter } from './project-files.js'
import { projectInfo, type ProjectEntry, type ProjectsRegistry } from './projects.js'
import { CODE_FORBIDDEN } from './wire.js'
import { createCredentials, enginesOf, homeProjectOf, userInfo, USER_ID, type Credentials, type UserRecord, type UsersRegistry } from './users.js'


export class ForbiddenError extends Error {
  readonly code = CODE_FORBIDDEN
  constructor(message: string) {
    super(`users: ${message}`)
    this.name = 'ForbiddenError'
  }
}

export class UsersBadRequestError extends Error {
  readonly code = 'bad_request'
  constructor(message: string) {
    super(`users: ${message}`)
    this.name = 'UsersBadRequestError'
  }
}

export interface UsersGateOpts {
  /** Бэкенд стенда — обычно хаб (`createHub`). */
  backend: ProtocolBackend
  users: UsersRegistry
  /** Реестр проектов — `$members`, роли, личные проекты. Нет — у member только `default` не виден. */
  projects?: ProjectsRegistry
  /** Файлы проекта (как у `createStoreBackend`): у member свой текущий проект — свои файлы. */
  projectFiles?: ProjectFilesFactory
  /**
   * Cloudflare Access: готовый проверяльщик либо `{team, aud}` (тогда нужен `identity.createAccessVerifier`).
   * Нет — способа `access` нет.
   */
  access?: AccessOpts | AccessVerifier
  /**
   * Проверка входа от хоста: фабрики проверяльщиков Access и сервиса входа. Реализации в ядре нет —
   * без набора работают только готовые проверяльщики (`access`, `id.verifier`), ссылки и локальный процесс.
   */
  identity?: IdentityKit
  /**
   * Вход через сервис `id` (identity-spec §8): задан — `nr_at` вместо ссылок и
   * Access. `{base?, verifier?, autoUsers?, site?}`.
   */
  id?: IdGateOpts
  /** Доверять локальному процессу (loopback без заголовков туннеля) как owner. Default true. */
  local?: boolean
  /** Встроенный движок (member по умолчанию — он). Default `nr`. */
  localEngine?: string
  /** Первый вход пользователя по ссылке: хост заводит личный проект (`home/`). */
  onFirstLogin?(user: UserRecord): void | Promise<void>
  /**
   * Общие сервисы (FAM-2, `$users_services` стенда): открыты каждому участнику без `$services`
   * в записи, и им гейт подкладывает `$caller` ({user, name, role, owner}) в каждый вызов — owner'у
   * тоже. Многопользовательский плагин (лента, чаты людей) знает, кто зовёт, а клиент это не подделает.
   */
  sharedServices?: string[]
  /** Часы (тесты). */
  now?: () => number
  log?: (msg: string) => void
}

export interface IdGateOpts {
  /** Адрес сервиса (он же `iss`); обязателен, сервиса по умолчанию нет — конфиг стенда. */
  base?: string
  /** Имя куки короткого токена (default `nr_at`). */
  cookie?: string
  /** Готовый проверяльщик (тесты, свой кэш JWKS). */
  verifier?: IdVerifier
  /** Пользователь `id` без записи стенда заводится member (`id-<sub>`). Default true; гостям `id` хаб закрыт всегда. */
  autoUsers?: boolean
  /** Имя сайта на странице входа. Default `chat`. */
  site?: string
  /** Переезд со ссылок: кука устройства стенда ещё пускает; вход через `id` с ней — привязка `sub`. */
  legacyDevices?: boolean
  /** Ключ админки `id` (`ADMIN_KEY`): приглашения и ссылки входа админки стенда — через `id`. */
  admin?: { key: string; fetch?: typeof fetch }
  /** Куда вернуть после входа по ссылке `id` (фронт стенда). */
  returnTo?: string
}

/** Способ входа «через id» (протокол знает его как строку; тип — с nr-ui-protocol, где он заявлен). */
const VIA_ID = 'id' as UserAuthMethod

/** Кто пришёл. */
export interface Identity {
  user: UserRecord
  via: UserAuthMethod
  /** Устройство (вход по ссылке). */
  device?: string
}

export type AuthResult = { ok: true; identity: Identity; setCookie?: string } | { ok: false; reason: string; clearCookie?: boolean; login?: string }

export interface UsersGate {
  authenticate(req: IncomingMessage): Promise<AuthResult>
  /** Погасить ссылку (`/auth/join|login`): кука нового устройства. */
  redeem(kind: 'join' | 'login', token: string, req: IncomingMessage): Promise<{ identity: Identity; setCookie: string } | null>
  /** Выход: устройство этой куки отзывается. */
  logout(identity: Identity): Promise<void>
  backendFor(identity: Identity): ProtocolBackend
  /** Кука, которая стирает устройство. */
  clearCookie(req: IncomingMessage): string
  isOwner(identity: Identity): boolean
  /** Вход через `id`: адрес сервиса и страница входа с возвратом (`/auth/id`); нет `id` — `undefined`. */
  idLogin?(returnTo: string): { base: string; login: string }
}

export const DEVICE_COOKIE = 'nrchat_device'
const DEVICE_MAX_AGE_S = 180 * 24 * 3600

/** Заголовки, которые ставит туннель Cloudflare: есть хоть один — запрос не локальный. */
/** Почты равны без регистра; у gmail.com точки в имени не значат ничего (a.b@ = ab@). */
export function sameEmail(a: string, b: string): boolean {
  const norm = (e: string): string => {
    const [name = '', domain = ''] = e.trim().toLowerCase().split('@')
    return domain === 'gmail.com' || domain === 'googlemail.com' ? `${name.replace(/\./g, '').replace(/\+.*$/, '')}@gmail.com` : `${name}@${domain}`
  }
  return norm(a) === norm(b)
}

const TUNNEL_HEADERS = ['cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry', 'cf-access-jwt-assertion', 'cdn-loop', 'x-forwarded-for']

function cookies(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>()
  const raw = req.headers.cookie
  if (!raw) return out
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()))
  }
  return out
}

function isLoopback(addr: string | undefined): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

/** Запрос локального процесса: loopback и ни одного заголовка туннеля / прокси (строгий режим `raw`). */
export function isLocalRequest(req: IncomingMessage): boolean {
  return isLoopback(req.socket.remoteAddress) && !TUNNEL_HEADERS.some((h) => req.headers[h] !== undefined)
}

/** https по туннелю: `cf-visitor {"scheme":"https"}` / `x-forwarded-proto`. */
function secure(req: IncomingMessage): boolean {
  const v = String(req.headers['cf-visitor'] ?? '')
  return v.includes('https') || String(req.headers['x-forwarded-proto'] ?? '') === 'https'
}

/** Проверяльщик Access по `{team, aud}` — только фабрикой хоста; нет — громкий отказ. */
function accessFromKit(kit: IdentityKit, o: AccessOpts): AccessVerifier {
  if (!kit.createAccessVerifier) throw new Error('users.access: проверка Cloudflare Access не подана хостом (опция identity.createAccessVerifier или готовый проверяльщик)')
  return kit.createAccessVerifier(o)
}

/** Проверяльщик токена сервиса входа — только фабрикой хоста; нет — громкий отказ. */
function verifierFromKit(kit: IdentityKit, base: string, cookie: string | undefined): IdVerifier {
  if (!kit.createVerifier) throw new Error('users.id: проверка токена сервиса входа не подана хостом (опция identity.createVerifier или id.verifier)')
  return kit.createVerifier({ base, ...(cookie ? { cookie } : {}) })
}

function deviceCookie(value: string, req: IncomingMessage): string {
  return `${DEVICE_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${DEVICE_MAX_AGE_S}; HttpOnly; SameSite=Lax${secure(req) ? '; Secure' : ''}`
}

export function createUsersGate(opts: UsersGateOpts): UsersGate {
  // Подхват идущего рана (v1.31): виды пользователей делят один снимок ранов.
  const hub = hasRunAttach(opts.backend) ? opts.backend : withRunAttach(opts.backend)
  const log = opts.log ?? ((m: string) => void process.stderr.write(`users: ${m}\n`))
  const shared: ReadonlySet<string> = new Set(opts.sharedServices ?? [])
  const callerArgs = (plugin: string, args: unknown, user: UserRecord): unknown => callerOf(plugin, args, user, shared)
  const localEngine = opts.localEngine ?? 'nr'
  const trustLocal = opts.local !== false
  const kit: IdentityKit = opts.identity ?? {}
  const access: AccessVerifier | undefined = opts.access ? ('verify' in opts.access ? opts.access : accessFromKit(kit, opts.access)) : undefined

  let cache: { at: number; list: UserRecord[] } | undefined
  async function allUsers(): Promise<UserRecord[]> {
    // Реестр — файлы, правятся руками: перечитываем не чаще раза в 2 с.
    if (cache && Date.now() - cache.at < 2000) return cache.list
    const list = await opts.users.list()
    cache = { at: Date.now(), list }
    return list
  }
  const invalidate = (): void => void (cache = undefined)
  let ids: string[] = []
  const creds: Credentials = createCredentials(opts.users, () => ids, opts.now ? { now: opts.now } : {})
  const refreshIds = async (): Promise<UserRecord[]> => {
    const list = await allUsers()
    ids = list.map((u) => u.id)
    return list
  }
  const standOwner = async (): Promise<UserRecord | undefined> => (await allUsers()).find((u) => u.role === 'owner')

  const idBase = opts.id ? idBaseOf(opts.id.base, 'users.id') : ''
  const idv: IdVerifier | undefined = opts.id ? (opts.id.verifier ?? verifierFromKit(kit, idBase, opts.id.cookie)) : undefined
  const idSite = opts.id?.site ?? 'chat'
  const loginUrl = kit.loginUrl ?? defaultLoginUrl
  const tokenOf = kit.tokenOf ?? defaultTokenOf
  const idLogin = (returnTo: string): { base: string; login: string } => ({ base: idBase, login: loginUrl(returnTo, { base: idBase, site: idSite }) })
  /** Куда вернуть после входа: фронт, с которого пришёл запрос. */
  const returnOf = (req: IncomingMessage): string => String(req.headers.origin ?? req.headers.referer ?? '') || idBase

  /** Пользователь стенда для `sub` из `id`: запись с тем же sub, owner `id` — owner стенда, иначе — новый member. */
  async function userForId(who: IdUser, list: UserRecord[]): Promise<UserRecord | string> {
    const bound = list.find((u) => u.sub === who.sub)
    if (bound) return bound
    if (who.tier === 'owner') return (await standOwner()) ?? 'на стенде нет owner'
    if (who.tier === 'guest') return 'гостям хаб закрыт — войдите (Google, почта или приглашение)'
    if (opts.id?.autoUsers === false) return `${who.name || who.sub} — нет такого пользователя стенда`
    const id = `id-${who.sub.replace(/^u_/, '')}`.slice(0, 64)
    if (!USER_ID.test(id)) return `sub ${who.sub} не годится в id пользователя`
    const rec: UserRecord = { id, name: who.name || id, role: 'member', engines: [localEngine], sub: who.sub }
    const saved = await opts.users.create(rec)
    invalidate()
    await refreshIds()
    log(`${saved.id}: заведён по входу id (${who.sub})`)
    try {
      await opts.onFirstLogin?.(saved)
    } catch (err) {
      log(`${saved.id}: личный проект не заведён — ${(err as Error)?.message ?? err}`)
    }
    return saved
  }

  /** Кука устройства стенда (вход по ссылке); `null` — нет или негодна. */
  function legacyDevice(req: IncomingMessage, list: UserRecord[]): { user: UserRecord; device: string; renew: boolean; cookie: string } | null {
    const dev = cookies(req).get(DEVICE_COOKIE)
    if (!dev) return null
    const got = creds.check(dev)
    const user = got && list.find((u) => u.id === got.userId)
    return got && user ? { user, device: got.device, renew: Boolean(got.renew), cookie: dev } : null
  }

  /** Привязать `sub` к записи стенда (переезд со ссылок на `id`). */
  async function bindSub(user: UserRecord, sub: string): Promise<UserRecord> {
    const rec = { ...user, sub }
    const saved = await (opts.users.update ?? opts.users.create)(rec)
    invalidate()
    await refreshIds()
    log(`${user.id}: привязан к id ${sub}`)
    return saved
  }

  async function authenticateId(req: IncomingMessage, list: UserRecord[]): Promise<AuthResult> {
    const token = tokenOf(req, opts.id?.cookie)
    const legacy = opts.id?.legacyDevices ? legacyDevice(req, list) : null
    if (token) {
      const who = await idv!.verifyToken(token)
      if (who) {
        // Свой человек со старой кукой впервые пришёл через id — это он: привязка, без новой записи.
        if (legacy && !legacy.user.sub && !list.some((u) => u.sub === who.sub) && who.tier !== 'guest') {
          return { ok: true, identity: { user: await bindSub(legacy.user, who.sub), via: VIA_ID } }
        }
        const user = await userForId(who, list)
        if (typeof user !== 'string') return { ok: true, identity: { user, via: VIA_ID } }
        log(`id: ${user}`)
        return { ok: false, reason: `id: ${user}`, login: idLogin(returnOf(req)).login }
      }
      log(`nr_at отклонён: ${idv!.lastError}`)
    }
    if (legacy) return { ok: true, identity: { user: legacy.user, via: 'link', device: legacy.device }, ...(legacy.renew ? { setCookie: deviceCookie(legacy.cookie, req) } : {}) }
    if (trustLocal && isLoopback(req.socket.remoteAddress) && !TUNNEL_HEADERS.some((h) => req.headers[h] !== undefined)) {
      const owner = await standOwner()
      if (owner) return { ok: true, identity: { user: owner, via: 'local' } }
    }
    const idHost = idBase.replace(/^https?:\/\//, '')
    return { ok: false, reason: token ? `вход истёк — обновите через ${idHost}` : `нужен вход через ${idHost}`, login: idLogin(returnOf(req)).login }
  }

  async function authenticate(req: IncomingMessage): Promise<AuthResult> {
    const list = await refreshIds()
    if (idv) return authenticateId(req, list)
    const jar = cookies(req)
    const dev = jar.get(DEVICE_COOKIE)
    if (dev) {
      const got = creds.check(dev)
      const user = got && list.find((u) => u.id === got.userId)
      if (!got || !user) return { ok: false, reason: 'устройство отозвано или ссылка входа устарела', clearCookie: true }
      return { ok: true, identity: { user, via: 'link', device: got.device }, ...(got.renew ? { setCookie: deviceCookie(dev, req) } : {}) }
    }
    const jwt = (req.headers['cf-access-jwt-assertion'] as string | undefined) ?? jar.get('CF_Authorization')
    if (jwt && access) {
      const who = await access.verify(jwt)
      if (who) {
        const user = list.find((u) => u.access !== undefined && sameEmail(u.access, who.email))
        if (user) return { ok: true, identity: { user, via: 'access' } }
        log(`Access: ${who.email} — нет такого пользователя стенда`)
        return { ok: false, reason: `Access: ${who.email} — нет такого пользователя стенда` }
      }
      log(`Access JWT отклонён: ${access.lastError}`)
    }
    if (trustLocal && isLoopback(req.socket.remoteAddress) && !TUNNEL_HEADERS.some((h) => req.headers[h] !== undefined)) {
      const owner = await standOwner()
      if (owner) return { ok: true, identity: { user: owner, via: 'local' } }
    }
    return { ok: false, reason: 'нужен вход: ссылка-приглашение или Cloudflare Access' }
  }

  async function redeem(kind: 'join' | 'login', token: string, req: IncomingMessage) {
    // Ссылки входа стенда при `id` выключены: приглашает сервис `id`.
    if (idv) return null
    const list = await refreshIds()
    const ua = String(req.headers['user-agent'] ?? '').slice(0, 120)
    const got = creds.redeem(kind, token, ua || undefined)
    if (!got) return null
    const user = list.find((u) => u.id === got.userId)
    if (!user) return null
    if (got.firstLogin) {
      try {
        await opts.onFirstLogin?.(user)
      } catch (err) {
        log(`${user.id}: личный проект не заведён — ${(err as Error)?.message ?? err}`)
      }
    }
    log(`${user.id}: вход по ссылке (${kind}), устройство ${got.device}`)
    return { identity: { user, via: 'link' as const, device: got.device }, setCookie: deviceCookie(got.cookie, req) }
  }

  // ── вид бэкенда глазами пользователя ──────────────────────────────────────

  const scoped = new Map<string, { backend: ProtocolBackend; rev: string }>()

  function backendFor(identity: Identity): ProtocolBackend {
    const rev = JSON.stringify(identity.user)
    const hit = scoped.get(identity.user.id)
    if (hit && hit.rev === rev) return withVia(hit.backend, identity.via)
    const b = identity.user.role === 'owner' ? ownerView(identity.user) : memberView(identity.user)
    scoped.set(identity.user.id, { backend: b, rev })
    return withVia(b, identity.via)
  }

  /** Способ входа — в `capabilities().users.me.via` (вид кэшируется на пользователя). */
  function withVia(b: ProtocolBackend, via: UserAuthMethod): ProtocolBackend {
    return {
      ...b,
      async capabilities() {
        const caps = await b.capabilities()
        return caps.users ? { ...caps, users: { ...caps.users, me: { ...caps.users.me, via } } } : caps
      },
    }
  }

  async function engineIds(): Promise<string[]> {
    const caps = await hub.capabilities()
    return caps.engines?.list.map((e) => e.id) ?? [localEngine]
  }

  async function infoOf(u: UserRecord, extra: Partial<UserInfo> = {}): Promise<UserInfo> {
    return userInfo(u, enginesOf(u, await engineIds(), localEngine), extra)
  }

  /** Автор сессии: поле нет — owner стенда (старые сессии). */
  async function authorOf(s: SessionInfo): Promise<string | undefined> {
    return s.owner ?? (await standOwner())?.id
  }

  async function stampOwner(info: SessionInfo, userId: string): Promise<SessionInfo> {
    if (!hub.meta) return info
    try {
      await hub.meta.patch(info.id, { owner: userId } as never)
      return { ...info, owner: userId }
    } catch (err) {
      log(`сессия ${info.id}: автор не записан — ${(err as Error)?.message ?? err}`)
      return info
    }
  }

  async function shareSession(id: string, share: SessionShare | null): Promise<SessionInfo> {
    if (!hub.meta) throw new NotSupportedError('sessions.share')
    const clean = share ? normalizeShare(share) : null
    await hub.meta.patch(id, { shared: clean } as never)
    const info = await hub.sessions.get(id)
    return { ...info, ...(clean ? { shared: clean } : {}), ...(clean ? {} : { shared: undefined }) }
  }

  // ── приглашения через id ───────────────────────────────────────────

  const idAdmin = idv && opts.id?.admin ? opts.id.admin : undefined

  async function idApi<T>(path: string, body: unknown): Promise<T> {
    const res = await (idAdmin!.fetch ?? fetch)(`${idBase}/api/admin${path}`, { method: 'POST', headers: { authorization: `Bearer ${idAdmin!.key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const out = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string }
    if (!res.ok || out.ok === false) throw new Error(`id ${path}: ${out.error ?? `HTTP ${res.status}`}`)
    return out
  }

  /** Пользователь `id` под запись стенда (нет `sub` — заводится с её именем). */
  async function ensureIdUser(u: UserRecord): Promise<UserRecord> {
    if (u.sub) return u
    const r = await idApi<{ user: { sub: string } }>('/users', { name: u.name })
    return bindSub(u, r.user.sub)
  }

  /** Ссылка входа `id` в `sub` записи (24 ч, одна): путь — абсолютный адрес `id` с возвратом на стенд. */
  async function idLink(u: UserRecord): Promise<UserLink> {
    const r = await idApi<{ url: string; expiresAt: string }>('/invites', { sub: u.sub })
    const url = opts.id?.returnTo ? `${r.url}?return=${encodeURIComponent(opts.id.returnTo)}&site=${encodeURIComponent(idSite)}` : r.url
    return { kind: 'login', token: '', path: url, expiresAt: r.expiresAt }
  }

  /** Админка пользователей — owner стенда. */
  function usersOps(): NonNullable<ProtocolBackend['users']> {
    const find = async (id: string): Promise<UserRecord> => {
      const u = (await refreshIds()).find((x) => x.id === id)
      if (!u) throw Object.assign(new Error(`users: нет пользователя ${id}`), { code: 'not_found' })
      return u
    }
    return {
      async list() {
        const list = await refreshIds()
        return Promise.all(list.map((u) => infoOf(u, { ...(u.access ? { email: u.access } : {}), devices: creds.devices(u.id).filter((d) => !d.revoked).length })))
      },
      async create(input) {
        if (!input || typeof input.id !== 'string' || !USER_ID.test(input.id)) throw new UsersBadRequestError('id — латиница, цифры, -, _')
        if ((await refreshIds()).some((u) => u.id === input.id)) throw Object.assign(new Error(`users: ${input.id} уже есть`), { code: 'conflict' })
        const role = input.role === 'owner' ? 'owner' : 'member'
        const all = await engineIds()
        const engines = Array.isArray(input.engines) ? input.engines.filter((e) => typeof e === 'string' && all.includes(e)) : undefined
        const rec: UserRecord = {
          id: input.id,
          name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : input.id,
          role,
          ...(engines?.length ? { engines } : role === 'member' ? { engines: [localEngine] } : {}),
          ...(typeof input.email === 'string' && input.email.includes('@') ? { access: input.email.trim().toLowerCase() } : {}),
        }
        let saved = await opts.users.create(rec)
        invalidate()
        await refreshIds()
        if (idAdmin) {
          saved = await ensureIdUser(saved)
          const link = await idLink(saved)
          log(`${saved.id}: заведён (${saved.role}) и в id (${saved.sub}), ссылка входа до ${link.expiresAt}`)
          return { user: await infoOf(saved), link }
        }
        const link = creds.issue(saved.id, 'join')
        log(`${saved.id}: заведён (${saved.role}), приглашение до ${link.expiresAt}`)
        return { user: await infoOf(saved), link }
      },
      async invite(id): Promise<UserLink> {
        if (idAdmin) return idLink(await ensureIdUser(await find(id)))
        return creds.issue((await find(id)).id, 'join')
      },
      async loginLink(id): Promise<UserLink> {
        if (idAdmin) return idLink(await ensureIdUser(await find(id)))
        return creds.issue((await find(id)).id, 'login')
      },
      async devices(id) {
        return creds.devices((await find(id)).id)
      },
      async revoke(id, deviceId) {
        await find(id)
        if (!creds.revoke(id, deviceId)) throw Object.assign(new Error(`users: нет устройства ${deviceId}`), { code: 'not_found' })
        log(`${id}: устройство ${deviceId} отозвано`)
      },
    }
  }

  // ── owner стенда ──────────────────────────────────────────────────────────

  function ownerView(user: UserRecord): ProtocolBackend {
    const b: ProtocolBackend = {
      ...hub,
      async capabilities(): Promise<Capabilities> {
        const caps = await hub.capabilities()
        return { ...caps, users: { me: { ...(await infoOf(user)), via: 'local' }, admin: true } }
      },
      sessions: {
        ...hub.sessions,
        async list(o?: SessionListOpts) {
          // Поиск и окно (v1.57) — после фильтра видимости, иначе окно пустело бы чужими.
          const { all, query, limit, offset, ...rest } = o ?? {}
          const list = await hub.sessions.list(Object.keys(rest).length ? rest : undefined)
          return pageSessions(all ? list : list.filter((s) => !s.owner || s.owner === user.id || sharedTo(s, user.id, undefined)), { query, limit, offset })
        },
        // v1.38: запущенные — та же видимость, что у списка (owner видит свои, ничьи и поделённые).
        ...(hub.sessions.live
          ? { live: async () => (await hub.sessions.live!()).filter((s) => !s.owner || s.owner === user.id || sharedTo(s, user.id, undefined)) }
          : {}),
        async create(input?: SessionCreateOpts) {
          return stampOwner(await hub.sessions.create(input), user.id)
        },
        ...(hub.sessions.fork
          ? {
              async fork(id: string, at?: string) {
                return stampOwner(await hub.sessions.fork!(id, at), user.id)
              },
            }
          : {}),
        share: shareSession,
      },
      users: usersOps(),
    }
    if (hub.services && shared.size) {
      const services = hub.services
      b.services = {
        ...services,
        call: (plugin: string, method: string, args?: unknown) => services.call(plugin, method, callerArgs(plugin, args, user)),
        stream: (plugin: string, method: string, args?: unknown) => services.stream(plugin, method, callerArgs(plugin, args, user)),
      } as typeof services
    }
    if (hub.workspace) {
      const ws = hub.workspace
      b.workspace = {
        ...ws,
        list: async () => (await ws.list()).map((w) => ({ ...w, role: 'owner' as const })),
        current: async () => ({ ...(await ws.current()), role: 'owner' as const }),
      }
    }
    return b
  }

  // ── member ────────────────────────────────────────────────────────────────

  function memberView(user: UserRecord): ProtocolBackend {
    const home = homeProjectOf(user.id)
    let current: string | undefined
    let files: ProjectFilesRouter | undefined

    const allowedEngines = async (): Promise<string[]> => enginesOf(user, await engineIds(), localEngine)

    async function projects(): Promise<ProjectEntry[]> {
      return opts.projects ? await opts.projects.list() : []
    }
    function roleIn(p: ProjectEntry): ProjectRole | undefined {
      if (p.id === home) return 'owner'
      // `$members` — по id пользователя стенда или по `sub` сервиса `id` (identity-spec §8).
      return p.members?.[user.id] ?? (user.sub ? p.members?.[user.sub] : undefined)
    }
    async function visible(): Promise<Array<{ p: ProjectEntry; role: ProjectRole }>> {
      return (await projects()).flatMap((p) => {
        const role = roleIn(p)
        return role ? [{ p, role }] : []
      })
    }
    async function project(id: string): Promise<{ p: ProjectEntry; role: ProjectRole }> {
      const got = (await visible()).find((x) => x.p.id === id)
      if (!got) throw new ForbiddenError(`проект ${id} — не ваш`)
      return got
    }
    async function currentProject(): Promise<{ p: ProjectEntry; role: ProjectRole }> {
      const vis = await visible()
      const got = vis.find((x) => x.p.id === current) ?? vis.find((x) => x.p.id === home) ?? vis[0]
      if (!got) throw new ForbiddenError('у вас нет проектов')
      current = got.p.id
      return got
    }
    const wsInfo = (x: { p: ProjectEntry; role: ProjectRole }): WorkspaceInfo => ({ ...projectInfo(x.p), role: x.role })

    function filesRouter(): ProjectFilesRouter | undefined {
      if (!opts.projectFiles) return undefined
      files ??= createProjectFilesRouter(
        opts.projectFiles,
        async () => (await currentProject()).p,
        async (id) => (await project(id)).p,
        async (p) => {
          if ((await project(p.id)).role === 'viewer') throw new ForbiddenError('файлы проекта вам — только на чтение')
        },
      )
      return files
    }

    /** Сессия глазами member: видна — `SessionInfo`, чужая — 403 (§8 п.5). */
    async function session(id: string): Promise<SessionInfo> {
      const s = await hub.sessions.get(id)
      if (await canRead(s)) return s
      throw new ForbiddenError(`сессия ${id} — не ваша`)
    }
    async function canRead(s: SessionInfo): Promise<boolean> {
      if ((await authorOf(s)) === user.id) return true
      const ws = s.workspace || DEFAULT_PROJECT_ID
      const role = (await visible()).find((x) => x.p.id === ws)?.role
      return sharedTo(s, user.id, role)
    }
    async function engineOk(s: SessionInfo): Promise<boolean> {
      return (await allowedEngines()).includes(s.engine ?? localEngine)
    }
    /** Ход и правка ленты: автор или `shared.write`, и движок сессии разрешён. */
    async function writable(id: string): Promise<SessionInfo> {
      const s = await session(id)
      if (!(await engineOk(s))) throw new ForbiddenError(`движок ${s.engine} вам недоступен — сессия только на чтение`)
      if ((await authorOf(s)) !== user.id && s.shared?.write !== true) throw new ForbiddenError('сессия открыта вам только на чтение')
      return s
    }
    /** Удалить, переименовать, поделиться, сменить исполнителя — только автор. */
    async function authored(id: string): Promise<SessionInfo> {
      const s = await session(id)
      if ((await authorOf(s)) !== user.id) throw new ForbiddenError('это может только автор сессии')
      if (!(await engineOk(s))) throw new ForbiddenError(`движок ${s.engine} вам недоступен`)
      return s
    }

    const forbid = (what: string) => async (): Promise<never> => {
      throw new ForbiddenError(`${what} — только owner стенда`)
    }

    const b: ProtocolBackend = {
      async capabilities(): Promise<Capabilities> {
        const caps = await hub.capabilities()
        const allowed = await allowedEngines()
        const out: Capabilities = { ...caps, users: { me: { ...(await infoOf(user)), via: 'link' } } }
        if (caps.engines) {
          const list = caps.engines.list.filter((e) => allowed.includes(e.id))
          const dflt = allowed.includes(caps.engines.default) ? caps.engines.default : (list[0]?.id ?? localEngine)
          const canSwitch = caps.engines.switch === true && list.length > 1
          out.engines = { list, default: dflt, ...(canSwitch ? { switch: true } : {}) }
        }
        if (caps.workspace) {
          const { edit: _e, ...ws } = caps.workspace
          const router = filesRouter()
          let filesCap: WorkspaceFilesCapability | undefined
          if (router) {
            const cur = await currentProject().catch(() => undefined)
            filesCap = cur ? await router.capability() : undefined
            if (filesCap && cur?.role === 'viewer') filesCap = { ...filesCap, write: false }
          }
          out.workspace = { ...ws, ...(filesCap ? { files: filesCap } : {}) }
          if (!filesCap) delete out.workspace.files
        }
        if (caps.profiles) out.profiles = { ...caps.profiles, edit: false }
        if (caps.services) {
          // Активность сессий (v1.69) — каждому, события только видимых ему сессий.
          const mine = new Set([...(user.services ?? []), ...shared, SESSION_ACTIVITY_SERVICE])
          out.services = Object.fromEntries(Object.entries(caps.services).filter(([id]) => mine.has(id)))
          if (!Object.keys(out.services).length) delete out.services
        }
        if (caps.skins) out.skins = {}
        return out
      },

      sessions: {
        async list(o?: SessionListOpts) {
          const { all: _all, query, limit, offset, ...rest } = o ?? {}
          const list = await hub.sessions.list(Object.keys(rest).length ? rest : undefined)
          const vis = new Map((await visible()).map((x) => [x.p.id, x.role]))
          const owner = (await standOwner())?.id
          return pageSessions(list.filter((s) => (s.owner ?? owner) === user.id || sharedTo(s, user.id, vis.get(s.workspace || DEFAULT_PROJECT_ID))), { query, limit, offset })
        },
        async create(input?: SessionCreateOpts) {
          const { workspace: want, engine: wantEngine, cwd: _cwd, ...rest } = input ?? {}
          const ws = want ?? (await currentProject()).p.id
          const { p } = await project(ws)
          const allowed = await allowedEngines()
          let engine = wantEngine ?? p.engine ?? (await hub.capabilities()).engines?.default ?? localEngine
          if (!allowed.includes(engine)) {
            if (wantEngine) throw new ForbiddenError(`движок ${wantEngine} вам недоступен`)
            engine = allowed[0] ?? localEngine
          }
          const caps = await hub.capabilities()
          const info = await hub.sessions.create({ ...rest, workspace: ws, ...(caps.engines ? { engine } : {}) })
          return stampOwner(info, user.id)
        },
        get: session,
        async delete(id) {
          await authored(id)
          await hub.sessions.delete(id)
        },
        ...(hub.sessions.fork
          ? {
              async fork(id: string, at?: string) {
                const s = await session(id)
                if (!(await engineOk(s))) throw new ForbiddenError(`движок ${s.engine} вам недоступен`)
                return stampOwner(await hub.sessions.fork!(id, at), user.id)
              },
            }
          : {}),
        ...(hub.sessions.rename
          ? {
              async rename(id: string, title: string) {
                await authored(id)
                await hub.sessions.rename!(id, title)
              },
            }
          : {}),
        ...(hub.sessions.setEngine
          ? {
              async setEngine(id: string, engine: string) {
                await authored(id)
                if (!(await allowedEngines()).includes(engine)) throw new ForbiddenError(`движок ${engine} вам недоступен`)
                return hub.sessions.setEngine!(id, engine)
              },
            }
          : {}),
        async share(id, share) {
          await authored(id)
          return shareSession(id, share)
        },
        ...(hub.sessions.live
          ? {
              async live() {
                const list = await hub.sessions.live!()
                const vis = new Map((await visible()).map((x) => [x.p.id, x.role]))
                const owner = (await standOwner())?.id
                return list.filter((s) => (s.owner ?? owner) === user.id || sharedTo(s, user.id, vis.get(s.workspace || DEFAULT_PROJECT_ID)))
              },
            }
          : {}),
        ...(hub.sessions.release
          ? {
              async release(id: string) {
                await authored(id)
                await hub.sessions.release!(id)
              },
            }
          : {}),
        // v1.31: смотреть идущий ран — тем же правом, что ленту.
        attach(id: string): AsyncIterable<AnyRunEvent> {
          return {
            [Symbol.asyncIterator]() {
              let inner: AsyncIterator<AnyRunEvent> | undefined
              return {
                async next() {
                  if (!inner) {
                    await session(id)
                    inner = hub.sessions.attach!(id)[Symbol.asyncIterator]()
                  }
                  return inner.next()
                },
                async return(value?: unknown) {
                  await inner?.return?.(value as never)
                  return { done: true, value: undefined as never }
                },
              }
            },
          }
        },
      },

      async history(id, hopts) {
        await session(id)
        return hub.history(id, hopts)
      },

      run(id: string, input: RunStartInput): AsyncIterable<AnyRunEvent> {
        return {
          [Symbol.asyncIterator]() {
            let inner: AsyncIterator<AnyRunEvent> | undefined
            return {
              async next() {
                if (!inner) {
                  await writable(id)
                  inner = hub.run(id, input)[Symbol.asyncIterator]()
                }
                return inner.next()
              },
              async return(value?: unknown) {
                await inner?.return?.(value as never)
                return { done: true, value: undefined as never }
              },
            }
          },
        }
      },

      async cancel(id, runId) {
        await writable(id)
        return hub.cancel(id, runId)
      },
    }

    if (hub.respond) {
      const respond = hub.respond.bind(hub)
      b.respond = async (id, askId, answer) => {
        await writable(id)
        return respond(id, askId, answer)
      }
    }

    // Группы по сессии: чтение — видна, запись — writable.
    const guard = <G extends keyof ProtocolBackend>(group: G, read: string[], write: string[]): void => {
      const g = hub[group] as Record<string, unknown> | undefined
      if (!g) return
      const out: Record<string, unknown> = {}
      for (const [k, f] of Object.entries(g)) {
        if (typeof f !== 'function') continue
        if (read.includes(k)) out[k] = async (id: string, ...a: unknown[]) => (await session(id), (f as (...x: unknown[]) => unknown).call(g, id, ...a))
        else if (write.includes(k)) out[k] = async (id: string, ...a: unknown[]) => (await writable(id), (f as (...x: unknown[]) => unknown).call(g, id, ...a))
      }
      ;(b as unknown as Record<string, unknown>)[group] = out
    }
    guard('messages', ['prompt'], ['append', 'edit', 'delete', 'hide', 'swipe'])
    guard('personas', ['list'], ['save'])
    guard('attachments', ['get'], ['put'])

    if (hub.meta) {
      const meta = hub.meta
      b.meta = {
        async get(id) {
          await session(id)
          return meta.get(id)
        },
        async patch(id, patch) {
          await writable(id)
          // Автор и шаринг — не метой: owner пишет гейт, shared — `sessions.share`.
          const { owner: _o, shared: _s, ...rest } = (patch ?? {}) as Record<string, unknown>
          return meta.patch(id, rest as never)
        },
      }
    }

    if (hub.models) {
      const models = hub.models
      b.models = {
        async list(): Promise<ModelInfo[]> {
          const allowed = await allowedEngines()
          return (await models.list()).filter((m) => !m.engine || allowed.includes(m.engine))
        },
        ...(models.set
          ? {
              async set(id: string, m: Parameters<NonNullable<typeof models.set>>[1]) {
                await writable(id)
                return models.set!(id, m)
              },
            }
          : {}),
      } as typeof models
    }

    if (hub.profiles) {
      const profiles = hub.profiles
      b.profiles = {
        list: profiles.list.bind(profiles),
        ...(profiles.get ? { get: profiles.get.bind(profiles) } : {}),
        ...(profiles.set
          ? {
              async set(id: string, p: Parameters<NonNullable<typeof profiles.set>>[1]) {
                await writable(id)
                return profiles.set!(id, p)
              },
            }
          : {}),
        ...(profiles.save ? { save: forbid('правка профилей') } : {}),
        ...(profiles.delete ? { delete: forbid('правка профилей') } : {}),
        ...(profiles.duplicate ? { duplicate: forbid('правка профилей') } : {}),
      } as typeof profiles
    }

    if (hub.workspace) {
      const ws = hub.workspace
      const router = filesRouter()
      const fileOps: WorkspaceFilesOps | undefined = router
        ? {
            ...router.ops,
            ...Object.fromEntries(
              (['write', 'delete', 'rename'] as const).map((k) => [
                k,
                async (...a: unknown[]) => {
                  if ((await currentProject()).role === 'viewer') throw new ForbiddenError('файлы проекта вам — только на чтение')
                  return (router.ops[k] as (...x: unknown[]) => unknown)(...a)
                },
              ]),
            ),
          }
        : undefined
      b.workspace = {
        current: async () => wsInfo(await currentProject()),
        list: async () => (await visible()).map(wsInfo),
        async switch(id: string) {
          const x = await project(id)
          current = x.p.id
          router?.switched()
          return wsInfo(x)
        },
        ...(ws.update
          ? {
              async update(id: string, patch: Parameters<NonNullable<typeof ws.update>>[1]) {
                if ((await project(id)).role !== 'owner') throw new ForbiddenError('правка проекта — его owner')
                if (patch && 'members' in patch) throw new ForbiddenError('участники — owner стенда')
                return ws.update!(id, patch)
              },
            }
          : {}),
        ...(ws.repos
          ? {
              // Проекты пространства (v1.35) — только видимого пользователю.
              async repos(o?: { workspace?: string }) {
                const x = o?.workspace ? await project(o.workspace) : await currentProject()
                return ws.repos!({ workspace: x.p.id })
              },
            }
          : {}),
        ...(fileOps ? { files: fileOps } : {}),
      }
    }

    if (hub.services) {
      const services = hub.services
      const mine = (plugin: string): void => {
        if (!shared.has(plugin) && !(user.services ?? []).includes(plugin)) throw new ForbiddenError(`сервис ${plugin} — не открыт вам ($services)`)
      }
      b.services = {
        ...services,
        async call(plugin: string, method: string, args?: unknown) {
          mine(plugin)
          return services.call(plugin, method, callerArgs(plugin, args, user))
        },
        stream(plugin: string, method: string, args?: unknown) {
          // Активность сессий (v1.69): лента хаба, но только сессии, что member читает.
          const feed = activityFeedOf(hub)
          if (feed && plugin === SESSION_ACTIVITY_SERVICE && method === SESSION_ACTIVITY_STREAM) {
            return feed.stream((a) => session(a.id).then(() => true, () => false))
          }
          mine(plugin)
          return services.stream(plugin, method, callerArgs(plugin, args, user))
        },
      } as typeof services
    }

    for (const k of ['catalogs', 'catalog', 'plugins'] as const) {
      if (hub[k]) (b as unknown as Record<string, unknown>)[k] = hub[k]
    }
    b.close = async () => files?.close()
    return b
  }

  return {
    authenticate,
    redeem,
    async logout(identity) {
      if (identity.device) creds.revoke(identity.user.id, identity.device)
    },
    backendFor,
    clearCookie: (req) => `${DEVICE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure(req) ? '; Secure' : ''}`,
    isOwner: (identity) => identity.user.role === 'owner',
    ...(idv ? { idLogin } : {}),
  }
}

/** Сессия открыта пользователю шарингом: по списку или участникам проекта. */
function sharedTo(s: SessionInfo, userId: string, roleInProject: ProjectRole | undefined): boolean {
  const sh = s.shared
  if (!sh) return false
  if (sh.users?.includes(userId)) return true
  return sh.project === true && roleInProject !== undefined
}

function normalizeShare(v: SessionShare): SessionShare | null {
  if (!v || typeof v !== 'object') throw new UsersBadRequestError('share: ожидается {project?, users?, write?} или null')
  const users = Array.isArray(v.users) ? v.users.filter((u) => typeof u === 'string' && USER_ID.test(u)) : []
  const out: SessionShare = {}
  if (v.project === true) out.project = true
  if (users.length) out.users = users
  if (!out.project && !out.users) return null
  if (v.write === true) out.write = true
  return out
}

/**
 * Кто зовёт сервис (v1.54): участнику (не owner стенда) в вызовы сервисов, которым
 * важно доверие, гейт подкладывает `$caller` поверх присланного — клиент его не подделает.
 * `links` по нему собирает слои гостя без `exec`/`script` (link-resolver-spec §4).
 */
const CALLER_SERVICES = new Set(['links'])
function callerOf(plugin: string, args: unknown, user: UserRecord, shared: ReadonlySet<string>): unknown {
  const isShared = shared.has(plugin)
  if (!isShared && (!CALLER_SERVICES.has(plugin) || user.role === 'owner')) return args
  const base = typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
  const owner = user.role === 'owner'
  return { ...base, $caller: isShared ? { user: user.id, name: user.name, role: user.role, owner } : { user: user.id, owner } }
}
