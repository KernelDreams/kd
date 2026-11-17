// LLMErrorCode — тип переехал в @kerneldreams/nrd/contracts (ступень 1);
// класс LLMError и хелперы (parseRetryAfter/errorCodeFromStatus) остаются здесь.
export type { LLMErrorCode } from '../../contracts/index.js'
import type { LLMErrorCode } from '../../contracts/index.js'

/**
 * Структурированная ошибка LLM. Extends Error — проходит через
 * Result<T, Error> прозрачно; кто хочет подробности — instanceof LLMError.
 */
export class LLMError extends Error {
  readonly code: LLMErrorCode
  readonly status?: number
  /** Секунды до повтора (из Retry-After header). */
  readonly retryAfter?: number
  readonly provider?: string
  readonly raw?: unknown

  constructor(
    message: string,
    options: {
      code: LLMErrorCode
      status?: number
      retryAfter?: number
      provider?: string
      raw?: unknown
    }
  ) {
    super(message)
    this.name = 'LLMError'
    this.code = options.code
    this.status = options.status
    this.retryAfter = options.retryAfter
    this.provider = options.provider
    this.raw = options.raw
  }
}

/** Парсинг Retry-After: число (секунды) или HTTP-date. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = parseInt(header, 10)
  if (!isNaN(seconds)) return seconds
  const date = Date.parse(header)
  if (!isNaN(date)) {
    return Math.max(0, Math.ceil((date - Date.now()) / 1000))
  }
  return undefined
}

/** Определить LLMErrorCode по HTTP-статусу. */
export function errorCodeFromStatus(status: number): LLMErrorCode {
  if (status === 429) return 'rate_limit'
  if (status === 401 || status === 403) return 'auth'
  if (status >= 400 && status < 500) return 'invalid_request'
  return 'server'
}
