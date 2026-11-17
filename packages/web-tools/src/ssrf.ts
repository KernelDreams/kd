/**
 * SSRF-стоп web_fetch (спека §1): модель не должна ходить тулзой в локальную
 * сеть машины, на которой крутится агент.
 *
 * Два слоя. `checkUrl` — синхронный, по литералу url: схема только http(s),
 * `localhost`, приватные и служебные диапазоны IPv4/IPv6 (включая IPv4-mapped
 * IPv6 — WHATWG URL нормализует `[::ffff:127.0.0.1]` в `[::ffff:7f00:1]`, а
 * `http://2130706433/` — в `127.0.0.1`, поэтому проверяется уже разобранный
 * hostname). `checkResolved` — DNS: имя, резолвящееся в приватный адрес
 * (`localtest.me` → 127.0.0.1), режется так же.
 *
 * DNS-rebinding между проверкой и самим запросом этим не закрыт — fetch
 * резолвит имя заново. Для v1 принято (DEBT).
 *
 * `allowHosts` — точные hostname, для которых стоп снят. Нужен смоуку (стаб на
 * 127.0.0.1) и локальной отладке; в обычной конфигурации пуст.
 */

import { isIP } from 'node:net'
import { type AsyncResult, type Result, ok, err } from '@kerneldreams/nrd'
import { webError } from './errors.js'

/** DNS-резолв имени во все адреса — инъецируется, чтобы юниты не ходили в сеть. */
export type Lookup = (hostname: string) => Promise<string[]>

/** Hostname без скобок IPv6 и финальной точки FQDN. */
export function normalizeHost(hostname: string): string {
  let host = hostname.toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (host.endsWith('.')) host = host.slice(0, -1)
  return host
}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false
  const [a, b] = parts as [number, number, number, number]
  return (
    a === 0 || // «этот» хост
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, облачные метаданные
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast, reserved, broadcast
  )
}

function isPrivateV6(ip: string): boolean {
  const host = ip.toLowerCase()
  if (host === '::' || host === '::1') return true

  // IPv4-mapped: `::ffff:127.0.0.1` и нормализованная форма `::ffff:7f00:1`.
  const mapped = /^::ffff:(.+)$/.exec(host)
  if (mapped) {
    const tail = mapped[1]!
    if (isIP(tail) === 4) return isPrivateV4(tail)
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail)
    if (hex) {
      const hi = parseInt(hex[1]!, 16)
      const lo = parseInt(hex[2]!, 16)
      return isPrivateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
    }
  }

  const first = parseInt(host.split(':')[0] || '0', 16)
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 // fe80::/10 link-local
  )
}

/** Адрес (IPv4/IPv6-литерал) в приватном или служебном диапазоне. */
export function isPrivateAddress(ip: string): boolean {
  const host = normalizeHost(ip)
  const kind = isIP(host)
  if (kind === 4) return isPrivateV4(host)
  if (kind === 6) return isPrivateV6(host)
  return false
}

function refused(url: string, why: string) {
  return webError('bad_request', `${url}: запрещено (${why}) — web_fetch ходит только в публичный веб`)
}

/** Проверка url по литералу. Ок — разобранный URL. */
export function checkUrl(raw: string, allowHosts: readonly string[] = []): Result<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return err(webError('bad_request', `некорректный url: ${raw}`))
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return err(refused(raw, `схема ${url.protocol}`))
  }
  if (url.username || url.password) {
    return err(refused(raw, 'креды в url'))
  }

  const host = normalizeHost(url.hostname)
  if (allowHosts.includes(host)) return ok(url)
  if (host === 'localhost' || host.endsWith('.localhost')) return err(refused(raw, 'localhost'))
  if (isPrivateAddress(host)) return err(refused(raw, `приватный адрес ${host}`))
  return ok(url)
}

/** DNS-слой: имя не должно резолвиться в приватный адрес. Литералы уже проверены. */
export async function checkResolved(url: URL, lookup: Lookup, allowHosts: readonly string[] = []): AsyncResult<URL> {
  const host = normalizeHost(url.hostname)
  if (allowHosts.includes(host) || isIP(host) !== 0) return ok(url)

  let addresses: string[]
  try {
    addresses = await lookup(host)
  } catch (e) {
    return err(webError('network', `${host}: DNS — ${e instanceof Error ? e.message : String(e)}`))
  }
  const bad = addresses.find(isPrivateAddress)
  if (bad !== undefined) return err(refused(url.href, `${host} резолвится в ${bad}`))
  return ok(url)
}

/** Штатный резолв через системный DNS. */
export const systemLookup: Lookup = async (hostname) => {
  const { lookup } = await import('node:dns/promises')
  const found = await lookup(hostname, { all: true })
  return found.map((a) => a.address)
}
