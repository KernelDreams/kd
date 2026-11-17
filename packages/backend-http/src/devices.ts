/**
 * Машины пользователя и подсказка хаба (v1.62): с какой машины пишет человек.
 *
 * Реестр — `## $hosts` стенда (`$devices`): имя, ОС, `match` (короткий hostname), адреса
 * (`$mcp.addr`). Запрос пришёл по tailnet (`*.nr` через Caddy — `X-Forwarded-For`, или прямо
 * на порт хаба) и адрес совпал с адресом машины — хаб знает, откуда реплика: `here` в
 * capabilities и замена догадки по браузеру (`client.guess`) на ране. Через Cloudflare
 * (`cf-*`) и ssh-проброс (loopback без заголовков) адрес не годится — подсказки нет.
 */
import type { DeviceInfo, RunStartInput } from '@kerneldreams/ui-protocol'

/** Адрес клиента запроса — служебный заголовок транспорта; входящий с таким именем стирается. */
export const PEER_HEADER = 'x-nr-peer'

/** Заголовки туннеля Cloudflare: за ними адрес — не адрес машины в tailnet. */
const TUNNEL = ['cf-connecting-ip', 'cf-ray', 'cf-visitor']

function plain(addr: string): string {
  return addr.trim().replace(/^::ffff:/i, '').replace(/^\[|\]$/g, '')
}

function loopback(addr: string): boolean {
  return addr === '::1' || addr.startsWith('127.') || addr === 'localhost'
}

type HeaderBag = Record<string, string | string[] | undefined>

function header(h: HeaderBag, name: string): string | undefined {
  const v = h[name]
  return Array.isArray(v) ? v.join(',') : v
}

/**
 * Адрес машины, с которой пришёл запрос: свой адрес сокета, если не loopback; на loopback —
 * последний `X-Forwarded-For` (его дописал Caddy), но не через туннель Cloudflare.
 */
export function peerAddress(remote: string | undefined, headers: HeaderBag): string | undefined {
  const own = remote ? plain(remote) : ''
  if (own && !loopback(own)) return own
  if (TUNNEL.some((k) => header(headers, k) !== undefined)) return undefined
  const xff = header(headers, 'x-forwarded-for')
  const last = xff?.split(',').map(plain).filter(Boolean).pop()
  return last && !loopback(last) ? last : undefined
}

/** Машина реестра с адресами (`$mcp.addr`) — вход {@link createDevices}. */
export interface DeviceSpec extends DeviceInfo {
  addrs?: string[]
}

export interface StandDevices {
  /** `Capabilities.devices` для запроса с адреса `peer`. */
  capability(peer?: string): { list: DeviceInfo[]; here?: string }
  /** Имя машины по адресу; нет такой — `undefined`. */
  byAddr(peer: string | undefined): string | undefined
  /** `client` рана: догадка (`guess`) → имя машины по адресу; флаг до бэкенда не доходит. */
  client(c: RunStartInput['client'], peer?: string): RunStartInput['client']
}

export function createDevices(specs: readonly DeviceSpec[]): StandDevices {
  const list: DeviceInfo[] = specs.map(({ addrs: _a, ...d }) => d)
  const byAddr = (peer: string | undefined): string | undefined => {
    if (!peer) return undefined
    const p = plain(peer)
    return specs.find((d) => d.addrs?.some((a) => plain(a) === p))?.name
  }
  return {
    capability(peer) {
      const here = byAddr(peer)
      return { list, ...(here ? { here } : {}) }
    },
    byAddr,
    client(c, peer) {
      if (!c) return c
      const { guess, ...rest } = c
      if (!guess) return rest
      const here = byAddr(peer)
      return here ? { ...rest, device: here } : rest
    },
  }
}

/** `client` рана без подсказки: снять флаг догадки (стенд без реестра машин). */
export function stripGuess(c: RunStartInput['client']): RunStartInput['client'] {
  if (!c || !('guess' in c)) return c
  const { guess: _g, ...rest } = c
  return rest
}
