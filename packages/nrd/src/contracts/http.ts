import type { Result } from './result.js'

/**
 * HTTP-контракт: опции запроса и форма ответа. Реализации (httpGet/httpPost/
 * httpPostStream над globalThis.fetch) — в потребителе (nr-infra).
 */
export interface HttpOptions {
  headers?: Record<string, string>
  /** ms, default 30000 */
  timeout?: number
  /** default 0 */
  retries?: number
  /** ms, default 1000 */
  retryDelay?: number
  /** Стрим: максимальный простой между чанками, ms. 0 = отключить. Default 300000. */
  idleTimeout?: number
}

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: string
  /** Парсит body как JSON. Result, не throws — невалидный JSON предсказуем. */
  json<T>(): Result<T>
}
