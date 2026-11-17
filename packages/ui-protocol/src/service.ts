/**
 * @kerneldreams/ui-protocol/service — контракт `service.ts` плагина
 * (plugin-services-spec §3). Только типы.
 *
 * ```ts
 * import type { IContext } from '@kerneldreams/nrd'
 * import type { ServiceMeta } from './service.js'
 *
 * export default async function (ctx: IContext, meta: ServiceMeta) {
 *   meta.on('translate', async (params) => ({ text: '...' }))
 *   meta.stream('translate', async (params, sink, signal) => { sink('chunk', { text }) })
 * }
 * ```
 *
 * Хост (`@kerneldreams/backend-local/services`) грузит модуль в процессе бэкенда
 * лениво, зовёт default-экспорт один раз и отдаёт зарегистрированное в
 * capability `services`. Состояние между вызовами — только на диске: хост
 * вправе перезапустить сервис в любой момент (restart-прозрачность).
 */

export type { ServiceEvent } from './services.js'

/** Хендлер `services.call`: результат — JSON; throw — `ok:false` с message (и `code`, если есть). */
export type ServiceCallHandler = (params: unknown) => unknown | Promise<unknown>

/** Отправить кадр стрима. После конца стрима или abort — no-op. */
export type ServiceSink = (name: string, payload?: unknown) => void

/**
 * Хендлер `services.stream`: кадры — `sink`, return — конец стрима; throw —
 * кадр `error` и конец. `signal` абортится, когда клиент закрыл стрим
 * (`stream.close`, `break` в for-await) или хост закрывается.
 */
export type ServiceStreamHandler = (params: unknown, sink: ServiceSink, signal: AbortSignal) => void | Promise<void>

/** Второй аргумент default-экспорта `service.ts`. */
export interface ServiceMeta {
  /** `plugin.id` — ключ в capability `services`. */
  pluginId: string
  /** Корень пространства — тот же, что у бэкенда. */
  root: string
  /** Каталог данных по конвенции runz для имени `nrchat-{pluginId}`. Хост его не создаёт. */
  dataDir: string
  /** Каталог плагина (где лежит `service.ts|.mjs`). */
  pluginDir: string
  /** Зарегистрировать RPC-метод. Повторная регистрация — last-wins. */
  on(method: string, handler: ServiceCallHandler): void
  /** Зарегистрировать стрим. Повторная регистрация — last-wins. */
  stream(method: string, handler: ServiceStreamHandler): void
}

/** Default-экспорт `service.ts`. `Ctx` — `IContext` из `@kerneldreams/nrd` у настоящего хоста. */
export type ServiceFn<Ctx = unknown> = (ctx: Ctx, meta: ServiceMeta) => unknown | Promise<unknown>
