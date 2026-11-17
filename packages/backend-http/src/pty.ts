/**
 * Общий терминал (`nr-far.dev/specs/nr-pty-spec.md`): шов к хосту `@kerneldreams/pty`.
 * Транспорт его не импортирует — тип структурный, хост передаёт стенд (`serveBackend({pty})`).
 *
 * Терминал — shell на хосте стенда, поэтому кроме гейта пользователей (только owner) ещё и
 * проверка `Origin`: браузер со страницы чужого сайта шлёт простой POST и открывает WebSocket
 * без CORS — без проверки любая открытая вкладка набрала бы команду в терминале.
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

export interface PtyOps {
  list(): Promise<unknown[]>
  ensure(id: string, opts?: { cwd?: string; cols?: number; rows?: number }): Promise<unknown>
  info(id: string): Promise<unknown | null>
  run(input: { terminal?: string; command: string; mode?: 'insert' | 'execute'; timeout?: number; wait?: number }): Promise<unknown>
  read(input: { terminal?: string; lines?: number }): Promise<unknown>
  kill(id: string): Promise<boolean>
  /** WebSocket вкладки после авторизации транспортом. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, id: string, query: URLSearchParams): void
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * `Origin` запроса к терминалу допустим: нет заголовка (не браузер — процесс стенда, MCP), origin того же
 * хоста (`Host` / `X-Forwarded-Host`), loopback или маска из `allowed` (`https://far.nr`, `https://*.nr`).
 */
export function ptyOriginAllowed(req: IncomingMessage, allowed: readonly string[] = []): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  if (typeof origin !== 'string' || origin === 'null') return false
  let u: URL
  try {
    u = new URL(origin)
  } catch {
    return false
  }
  if (LOOPBACK.has(u.hostname)) return true
  const hosts = [req.headers.host, ...String(req.headers['x-forwarded-host'] ?? '').split(',')].map((h) => (h ?? '').trim().toLowerCase()).filter(Boolean)
  if (hosts.includes(u.host.toLowerCase())) return true
  return allowed.some((mask) => originMatches(u, mask))
}

function originMatches(u: URL, mask: string): boolean {
  const m = /^(https?):\/\/(\*\.)?([^/:]+)(?::(\d+))?\/?$/i.exec(mask.trim())
  if (!m) return false
  const [, scheme, wild, host, port] = m
  if (`${scheme!.toLowerCase()}:` !== u.protocol) return false
  if (port !== undefined && port !== u.port) return false
  const h = u.hostname.toLowerCase()
  const base = host!.toLowerCase()
  return wild ? h.endsWith(`.${base}`) : h === base
}
