/**
 * Вход по ссылке (users-spec §2, протокол v1.30): транспорт, не `ProtocolBackend` —
 * сервер ставит устройству куку (`HttpOnly`) ответом на `POST /auth/join|login`,
 * дальше каждый запрос того же origin несёт её сам.
 *
 * `base` — тот же URL, что у `createHttpBackend` (с basePath: `/api`).
 */

import type { UserInfo } from '@kerneldreams/ui-protocol'
import { BackendError } from './wire.js'

/** Хэш-маршрут ссылки входа: `#/join/<токен>` | `#/login/<токен>`; иначе `null`. */
export function parseAuthLink(hash: string): { kind: 'join' | 'login'; token: string } | null {
  const m = /^#?\/(join|login)\/([A-Za-z0-9_-]{16,})\/?$/.exec(hash)
  return m ? { kind: m[1] as 'join' | 'login', token: m[2]! } : null
}

async function post<T>(base: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const env = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; error?: string; code?: string } | null
  if (!env || env.ok !== true) throw new BackendError(env?.error ?? `HTTP ${res.status}`, env?.code, res.status)
  return env.result as T
}

/** Войти по ссылке: устройство получает куку, ответ — кто вошёл. */
export function authWithLink(base: string, kind: 'join' | 'login', token: string): Promise<{ user: UserInfo }> {
  return post(base, `/auth/${kind}`, { token })
}

/** Выйти: устройство этой куки отзывается, кука стирается. */
export function authLogout(base: string): Promise<void> {
  return post(base, '/auth/logout', {})
}
