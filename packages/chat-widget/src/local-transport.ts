/**
 * Транспорт `local`: бэкенд в процессе страницы, без HTTP.
 * `<nr-chat backend="local" provider-url=… provider-key=… profile=…>`.
 *
 * Бэкенд в странице виджет не везёт: его подаёт страница — модулем по атрибуту
 * `local-module` (модуль отдаёт `createBrowserHost` и `createLocalBackend`) или
 * готовым объектом (`el.localBackend = await createLocalBackend(…)`). Нет ни того,
 * ни другого — громкая ошибка. Дальше — тот же `nr`-транспорт поверх `clientOf(backend)`.
 */

import { clientOf } from '@kerneldreams/chat-client'
import type { ProtocolBackend } from '@kerneldreams/ui-protocol'
import { NrTransport } from './nr-transport.js'
import type { TransportHost, WidgetOptions } from './transport.js'

/** Что виджет ждёт от модуля `local-module`. */
export interface LocalBackendModule {
  createBrowserHost(opts?: Record<string, unknown>): Promise<unknown>
  createLocalBackend(opts: Record<string, unknown>): Promise<ProtocolBackend>
}

/** Бэкенды по ключу (модуль + провайдер): переподключение виджета их не пересоздаёт. */
const cache = new Map<string, Promise<ProtocolBackend>>()

/** Локальный бэкенд по опциям виджета (кэш на страницу). */
export function localBackendFor(opts: WidgetOptions): Promise<ProtocolBackend> {
  if (opts.localBackend) return Promise.resolve(opts.localBackend)
  if (!opts.providerUrl) return Promise.reject(new Error('nr-chat local: нужен provider-url (OpenAI-совместимый гейт, …/v1)'))
  const moduleUrl = opts.localModule
  if (!moduleUrl) return Promise.reject(new Error('nr-chat local: бэкенд страницы не подан — атрибут local-module (модуль с createBrowserHost / createLocalBackend) или el.localBackend'))
  const key = JSON.stringify([moduleUrl, opts.providerUrl, opts.providerKey ?? '', opts.localStorage ?? 'auto'])
  let p = cache.get(key)
  if (!p) {
    p = (async () => {
      const mod = (await import(/* @vite-ignore */ moduleUrl)) as LocalBackendModule
      const host = await mod.createBrowserHost({ storage: opts.localStorage ?? 'auto' })
      return mod.createLocalBackend({ host, provider: { baseUrl: opts.providerUrl!, ...(opts.providerKey ? { apiKey: opts.providerKey } : {}) }, ...(opts.localOptions ?? {}) })
    })()
    p.catch(() => cache.delete(key))
    cache.set(key, p)
  }
  return p
}

export class LocalTransport extends NrTransport {
  constructor(host: TransportHost, backend: ProtocolBackend) {
    super(host, clientOf(backend, 'local'))
  }
}
