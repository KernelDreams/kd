/**
 * Пользователи стенда (users-spec §2, протокол v1.30): реестр — у хоста.
 *
 * Записи `<$users_dir>/<id>.mdz` читает и пишет хост (appz/pi), фикстуры —
 * память (`createMemoryUsers`). Бэкенд знает реестр интерфейсом `UsersRegistry`
 * и каталог состояния пользователя (`<$users_dir>/<id>/`): ссылки входа и
 * устройства лежат там JSON-ом — **только хэши** (`createCredentials`).
 *
 *   devices.json — [{id, hash, name, createdAt, lastSeenAt, revoked?}]
 *   links.json   — [{kind: join|login, hash, createdAt, expiresAt, usedAt?}]
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UserAuthMethod, UserDevice, UserInfo, UserLink, UserRole } from '@kerneldreams/ui-protocol'

/** Запись пользователя (`<id>.mdz`). */
export interface UserRecord {
  id: string
  name: string
  role: UserRole
  /** `$engines` — разрешённые движки; нет — owner: все, member: `[nr]`. */
  engines?: string[]
  /** `$auth.access` — email Cloudflare Access. */
  access?: string
  /** `$services` — сервисы плагинов, открытые member (owner — все). */
  services?: string[]
  /** `$auth.id` — `sub` сервиса `id` (identity-spec §8): вход по `nr_at`, роли `$members` по нему. */
  sub?: string
}

/** Реестр пользователей стенда. */
export interface UsersRegistry {
  list(): UserRecord[] | Promise<UserRecord[]>
  /** Новый пользователь (id свободен — проверено гейтом). */
  create(rec: UserRecord): Promise<UserRecord>
  /** Правка записи (привязка `sub` при переезде на `id`). Нет — гейт перезаписывает `create`. */
  update?(rec: UserRecord): Promise<UserRecord>
  /** Каталог состояния пользователя: `devices.json`, `links.json`, `home/`. */
  stateDir(id: string): string
}

/** Id личного проекта пользователя (users-spec §2). */
export const homeProjectOf = (userId: string): string => `user-${userId}`

/** Id пользователя: имя файла (латиница, цифры, -, _). */
export const USER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i

/** Движки пользователя: явные, иначе owner — все (`'*'`), member — `[nr]`. */
export function enginesOf(u: UserRecord, all: string[], localId = 'nr'): string[] {
  if (u.role === 'owner') return u.engines?.length ? u.engines.filter((e) => all.includes(e) || e === '*') : all
  return (u.engines?.length ? u.engines : [localId]).filter((e) => all.includes(e))
}

/** Запись → `UserInfo` провода. */
export function userInfo(u: UserRecord, engines: string[], extra: Partial<UserInfo> = {}): UserInfo {
  const auth: UserAuthMethod[] = ['link']
  if (u.access) auth.unshift('access')
  if (u.sub) auth.unshift('id' as UserAuthMethod)
  return { id: u.id, name: u.name, role: u.role, engines, auth, home: homeProjectOf(u.id), ...extra }
}

/** Реестр в памяти (фикстуры, тесты): состояние — в `stateRoot/<id>/`. */
export function createMemoryUsers(opts: { users?: UserRecord[]; stateRoot: string }): UsersRegistry {
  const items = new Map<string, UserRecord>()
  for (const u of opts.users ?? []) items.set(u.id, structuredClone(u))
  return {
    list: () => [...items.values()].map((u) => structuredClone(u)),
    async create(rec) {
      items.set(rec.id, structuredClone(rec))
      return structuredClone(rec)
    },
    stateDir: (id) => join(opts.stateRoot, id),
  }
}

// ── ссылки и устройства ─────────────────────────────────────────────────────

/** Приглашение — 7 дней, ссылка входа — 24 ч (users-spec §2). */
export const JOIN_TTL_MS = 7 * 24 * 3600_000
export const LOGIN_TTL_MS = 24 * 3600_000
/** Кука устройства — 180 дней, продлевается входом. */
export const DEVICE_TTL_MS = 180 * 24 * 3600_000

interface StoredLink {
  kind: 'join' | 'login'
  hash: string
  createdAt: string
  expiresAt: string
  usedAt?: string
}

interface StoredDevice {
  id: string
  hash: string
  name?: string
  createdAt: string
  lastSeenAt?: string
  revoked?: boolean
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
const token = (): string => randomBytes(24).toString('base64url')

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function readJson<T>(file: string): T[] {
  if (!existsSync(file)) return []
  try {
    const v = JSON.parse(readFileSync(file, 'utf-8'))
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}

function writeJson(file: string, v: unknown): void {
  const tmp = `${file}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`
  writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n')
  renameSync(tmp, file)
}

export interface Credentials {
  /** Новая ссылка: `join` гасит прежние неиспользованные приглашения. */
  issue(userId: string, kind: 'join' | 'login'): UserLink
  /**
   * Погасить ссылку и завести устройство: годна — `{userId, cookie, firstLogin}`
   * (кука `<user>.<device>.<секрет>`), иначе `null` (нет, истекла, уже была).
   */
  redeem(kind: 'join' | 'login', token: string, deviceName?: string): { userId: string; cookie: string; device: string; firstLogin: boolean } | null
  /** Кука → пользователь и устройство; отозвано/нет — `null`. `touch` — отметить вход. */
  check(cookie: string): { userId: string; device: string; renew: boolean } | null
  devices(userId: string): UserDevice[]
  revoke(userId: string, deviceId: string): boolean
}

/**
 * Ссылки и устройства на диске (`stateDir(id)`): в файлах — sha256 токенов и
 * секретов устройств, сами они живут только в ссылке и куке.
 */
export function createCredentials(users: Pick<UsersRegistry, 'stateDir'>, listIds: () => string[], opts: { now?: () => number } = {}): Credentials {
  const now = opts.now ?? Date.now
  const linksFile = (id: string): string => join(users.stateDir(id), 'links.json')
  const devicesFile = (id: string): string => join(users.stateDir(id), 'devices.json')
  const ensure = (id: string): void => void mkdirSync(users.stateDir(id), { recursive: true })

  return {
    issue(userId, kind) {
      ensure(userId)
      const t = token()
      const at = now()
      const ttl = kind === 'join' ? JOIN_TTL_MS : LOGIN_TTL_MS
      const live = readJson<StoredLink>(linksFile(userId)).filter((l) => !l.usedAt && Date.parse(l.expiresAt) > at && l.kind !== kind)
      const link: StoredLink = { kind, hash: sha256(t), createdAt: new Date(at).toISOString(), expiresAt: new Date(at + ttl).toISOString() }
      writeJson(linksFile(userId), [...live, link])
      return { kind, token: t, path: `#/${kind}/${t}`, expiresAt: link.expiresAt }
    },

    redeem(kind, t, deviceName) {
      const h = sha256(t)
      const at = now()
      for (const userId of listIds()) {
        const links = readJson<StoredLink>(linksFile(userId))
        const i = links.findIndex((l) => l.kind === kind && sameHash(l.hash, h))
        if (i < 0) continue
        const link = links[i]!
        if (link.usedAt || Date.parse(link.expiresAt) <= at) return null
        link.usedAt = new Date(at).toISOString()
        writeJson(linksFile(userId), links)
        const devices = readJson<StoredDevice>(devicesFile(userId))
        const firstLogin = devices.length === 0
        const id = randomBytes(6).toString('hex')
        const secret = token()
        devices.push({ id, hash: sha256(secret), ...(deviceName ? { name: deviceName.slice(0, 120) } : {}), createdAt: link.usedAt, lastSeenAt: link.usedAt })
        writeJson(devicesFile(userId), devices)
        return { userId, cookie: `${userId}.${id}.${secret}`, device: id, firstLogin }
      }
      return null
    },

    check(cookie) {
      const m = /^([^.]+)\.([0-9a-f]+)\.([A-Za-z0-9_-]+)$/.exec(cookie)
      if (!m) return null
      const [, userId, id, secret] = m
      if (!USER_ID.test(userId!) || !listIds().includes(userId!)) return null
      const devices = readJson<StoredDevice>(devicesFile(userId!))
      const d = devices.find((x) => x.id === id)
      if (!d || d.revoked || !sameHash(d.hash, sha256(secret!))) return null
      const at = now()
      const last = d.lastSeenAt ? Date.parse(d.lastSeenAt) : 0
      if (at - last > DEVICE_TTL_MS) return null
      // Продление — не чаще раза в сутки: файл не пишется на каждый запрос.
      const renew = at - last > 24 * 3600_000
      if (renew) {
        d.lastSeenAt = new Date(at).toISOString()
        writeJson(devicesFile(userId!), devices)
      }
      return { userId: userId!, device: id!, renew }
    },

    devices(userId) {
      return readJson<StoredDevice>(devicesFile(userId)).map(({ hash: _h, ...d }) => d)
    },

    revoke(userId, deviceId) {
      const devices = readJson<StoredDevice>(devicesFile(userId))
      const d = devices.find((x) => x.id === deviceId)
      if (!d) return false
      d.revoked = true
      writeJson(devicesFile(userId), devices)
      return true
    },
  }
}
