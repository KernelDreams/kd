/**
 * Сервисы плагинов чужим процессом: у контура один хозяин сервисов (стенд nr),
 * хабы ACP и задач своих копий не держат — `call`/`stream`/`http` и capability `services`
 * уходят к хозяину по HTTP. Копия читала `~/.runz/config.md` один раз и расходилась
 * состоянием с соседями; теперь правка конфига или рестарт хозяина хабы не трогает.
 *
 * Capability — маршрутом хозяина `GET /services` (его собственные сервисы, без опроса
 * движков: хаб nr сам опрашивает ACP, `/capabilities` дал бы круг). Последний известный
 * список держится: хозяин лёг — вкладка видит плагины, вызовы отвечают
 * `service_unavailable` (503) «сервис недоступен», а не «не настроен».
 */

import { NotSupportedError } from '@kerneldreams/ui-protocol'
import type { ServiceEvent, ServicesCapability, ServicesHost } from '@kerneldreams/ui-protocol'
import { createHttpBackend } from './client.js'

/** Код ошибки: хозяин сервисов контура не отвечает. HTTP 503. */
export const SERVICE_UNAVAILABLE_CODE = 'service_unavailable'

export interface RemoteServicesOpts {
  /** База API хозяина: `http://127.0.0.1:7800/api`. */
  url: string
  /** `$auth_key` хозяина, если есть. */
  auth?: string
  /** Сколько мс верить capability хозяина; default 5000. Лежит — переспрос не чаще этого. */
  ttlMs?: number
  /** Таймаут запроса capability, мс; default 3000. */
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
  log?: (m: string) => void
}

export interface RemoteServices extends ServicesHost {
  /** Хозяин ответил на последний запрос capability. */
  available(): boolean
}

export class ServiceUnavailableError extends Error {
  readonly code = SERVICE_UNAVAILABLE_CODE
}

export function createRemoteServices(o: RemoteServicesOpts): RemoteServices {
  const base = o.url.replace(/\/+$/, '')
  const doFetch = o.fetch ?? globalThis.fetch
  const ttl = o.ttlMs ?? 5000
  const client = createHttpBackend(base, { capabilitiesTtl: 0, ...(o.auth ? { auth: o.auth } : {}), ...(o.fetch ? { fetch: o.fetch } : {}) })
  let last: ServicesCapability | undefined
  let checkedAt = 0
  let up: boolean | undefined
  let pending: Promise<ServicesCapability> | undefined
  let closed = false

  const unavailable = (why: string): ServiceUnavailableError =>
    new ServiceUnavailableError(`сервис недоступен: хозяин сервисов контура ${base} не отвечает (${why})`)

  function mark(ok: boolean, why?: string): void {
    if (ok !== up) o.log?.(ok ? `сервисы: хозяин ${base} доступен` : `сервисы: хозяин ${base} недоступен — ${why ?? ''}`)
    up = ok
  }

  async function fetchCapability(): Promise<ServicesCapability> {
    try {
      const res = await doFetch(`${base}/services`, {
        headers: o.auth ? { authorization: `Bearer ${o.auth}` } : {},
        signal: AbortSignal.timeout(o.timeoutMs ?? 3000),
      })
      const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: unknown; error?: string } | null
      if (!res.ok || !body?.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
      const caps = body.result && typeof body.result === 'object' ? (body.result as ServicesCapability) : {}
      last = caps
      mark(true)
    } catch (err) {
      mark(false, err instanceof Error ? ((err.cause as Error | undefined)?.message ?? err.message) : String(err))
    }
    checkedAt = Date.now()
    return last ?? {}
  }

  /** Ошибка связи с хозяином → `service_unavailable`; ошибки самого сервиса — как есть. */
  function wrap(err: unknown): unknown {
    const code = (err as { code?: unknown } | null)?.code
    if (code === 'connection_lost') {
      mark(false, (err as Error).message)
      checkedAt = 0
      return unavailable((err as Error).message)
    }
    return err
  }

  return {
    async capability() {
      if (closed) return {}
      if (Date.now() - checkedAt < ttl) return last ?? {}
      return (pending ??= fetchCapability().finally(() => (pending = undefined)))
    },
    available: () => up === true,
    async call(plugin, method, args) {
      if (closed) throw new NotSupportedError('services.call', 'Services host is closed')
      try {
        return await client.services!.call(plugin, method, args)
      } catch (err) {
        throw wrap(err)
      }
    },
    stream(plugin, method, args): AsyncIterable<ServiceEvent> {
      if (closed) throw new NotSupportedError('services.stream', 'Services host is closed')
      const inner = client.services!.stream(plugin, method, args)
      return {
        [Symbol.asyncIterator]() {
          const it = inner[Symbol.asyncIterator]()
          return {
            async next() {
              try {
                return await it.next()
              } catch (err) {
                throw wrap(err)
              }
            },
            async return(v?: unknown) {
              await it.return?.(v)
              return { value: undefined, done: true as const }
            },
          }
        },
      }
    },
    async close() {
      closed = true
      await client.close?.()
    },
  }
}
