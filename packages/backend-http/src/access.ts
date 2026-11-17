/**
 * Проверка входа — контракт без реализации. Гейт пользователей (`createUsersGate`) не знает, кто
 * проверяет токены: проверяльщики приходят снаружи опцией `identity` (набор фабрик) или готовыми
 * объектами (`access` — проверяльщик JWT Cloudflare Access, `id.verifier` — короткого токена сервиса
 * входа). Нет ни того, ни другого — способа входа нет, гейт работает как без `$auth` (ссылки, ключ
 * `authKey`, локальный процесс).
 */

import type { IncomingMessage } from 'node:http'

/** Опции проверки JWT Cloudflare Access: домен команды и AUD-тег приложения. */
export interface AccessOpts {
  /** Домен команды (`<team>.cloudflareaccess.com`, можно с `https://`). */
  team: string
  /** AUD-тег приложения Access (один или несколько). */
  aud: string | string[]
  /** Сколько верить скачанным ключам, мс. */
  certsTtlMs?: number
  /** Подмена загрузки ключей (тесты): JWKS `{keys: [...]}`. */
  fetchCerts?: () => Promise<{ keys: unknown[] }>
}

export interface AccessIdentity {
  email: string
  /** Стабильный id пользователя команды. */
  sub?: string
}

export interface AccessVerifier {
  /** Проверить JWT; негодный — `null` (причина — в `lastError`). */
  verify(jwt: string): Promise<AccessIdentity | null>
  /** Причина последнего отказа — для лога. */
  readonly lastError: string | undefined
}

/** Уровень пользователя сервиса входа. */
export type IdTier = 'guest' | 'user' | 'owner'

/** Пользователь сервиса входа из проверенного токена. */
export interface IdUser {
  sub: string
  tier: IdTier
  name: string
}

/** Проверяльщик короткого токена сервиса входа. */
export interface IdVerifier {
  /** Проверить токен; негоден — `null` (причина — в `lastError`). */
  verifyToken(token: string): Promise<IdUser | null>
  readonly lastError: string | undefined
}

/**
 * Набор фабрик проверки входа — подаётся хостом (`createUsersGate({identity})`). Реализация живёт вне
 * ядра; ядро зовёт только эти функции.
 */
export interface IdentityKit {
  /** Проверяльщик JWT Cloudflare Access. */
  createAccessVerifier?(opts: AccessOpts): AccessVerifier
  /** Проверяльщик токена сервиса входа по его адресу. */
  createVerifier?(opts: { base: string; cookie?: string }): IdVerifier
  /** Ссылка на страницу входа сервиса с возвратом. */
  loginUrl?(returnTo: string, opts: { base: string; site?: string }): string
  /** Токен из запроса (`Authorization: Bearer` или кука). */
  tokenOf?(req: IncomingMessage, cookie?: string): string | undefined
}

/** Имя куки короткого токена сервиса входа по умолчанию. */
export const ID_COOKIE = 'nr_at'

/** Адрес сервиса входа без хвостового `/`; не задан — ошибка (сервиса по умолчанию нет). */
export function idBaseOf(base: string | undefined, who = 'id'): string {
  const b = (base ?? '').trim().replace(/\/+$/, '')
  if (!b) throw new Error(`${who}: не задан адрес сервиса входа (base)`)
  return b
}

/** Ссылка входа по умолчанию: `<base>/login?return=…&site=…`. */
export function defaultLoginUrl(returnTo: string, opts: { base: string; site?: string }): string {
  const u = new URL('/login', idBaseOf(opts.base, 'loginUrl'))
  u.searchParams.set('return', returnTo)
  if (opts.site) u.searchParams.set('site', opts.site)
  return u.toString()
}

/** Токен по умолчанию: `Authorization: Bearer` (если похож на JWT), иначе кука `cookie`. */
export function defaultTokenOf(req: IncomingMessage, cookie: string = ID_COOKIE): string | undefined {
  const auth = req.headers.authorization
  if (auth && /^bearer\s+/i.test(auth)) {
    const t = auth.replace(/^bearer\s+/i, '').trim()
    if (t.split('.').length === 3) return t
  }
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === cookie) {
      const v = part.slice(i + 1).trim()
      try {
        return decodeURIComponent(v) || undefined
      } catch {
        return v || undefined
      }
    }
  }
  return undefined
}
