// DEPRECATED 07.2026: канон — @kerneldreams/nrd/web (транспорт) + @kerneldreams/engine resolveProviderConfig (конфиг). Новый код сюда не добавлять.
/**
 * @kerneldreams/runz-runtime/llm — errors
 */

export type LLMErrorCode =
  | 'rate_limit'
  | 'auth'
  | 'invalid_request'
  | 'server'
  | 'timeout'
  | 'network'
  | 'config'

export class LLMError extends Error {
  readonly code: LLMErrorCode
  readonly status?: number
  readonly provider?: string

  constructor(message: string, code: LLMErrorCode, opts: { status?: number; provider?: string } = {}) {
    super(message)
    this.name = 'LLMError'
    this.code = code
    this.status = opts.status
    this.provider = opts.provider
  }
}

/** Map an HTTP status to an error code. */
export function codeForStatus(status: number): LLMErrorCode {
  if (status === 429) return 'rate_limit'
  if (status === 401 || status === 403) return 'auth'
  if (status >= 400 && status < 500) return 'invalid_request'
  return 'server'
}
