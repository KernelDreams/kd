/**
 * Ошибки тулз — `Error` с кодом, чтобы `Result<T>` из nrd оставался дефолтным
 * (`E = Error`), а модель и `/web` видели не только текст, но и класс осечки.
 *
 * Спека §1: ошибки уходят текстом в tool_result, а не исключением — код и
 * сообщение форматируются в `errorText`.
 */

export type WebErrorCode =
  /** Кривые параметры, запрещённый url (SSRF-стоп). */
  | 'bad_request'
  /** Провайдер не настроен (нет ключа/адреса) или неизвестен. */
  | 'config'
  | 'network'
  | 'timeout'
  | 'aborted'
  /** Тело больше лимита транспорта. */
  | 'too_large'
  | 'too_many_redirects'
  /** Ответ не 2xx. */
  | 'http_error'
  | 'unsupported_content_type'
  /** Ответ пришёл, но разобрать его нельзя. */
  | 'parse'
  /** Поисковик или сайт отдал капчу/анти-бот вместо ответа (202/403 у DDG, страница-заглушка). */
  | 'blocked'
  /** 429: провайдер просит подождать. */
  | 'rate_limited'

export class WebError extends Error {
  readonly code: WebErrorCode
  /** HTTP-статус ответа, если ошибка из него (web_fetch решает по нему, идти ли в браузер). */
  readonly status?: number

  constructor(code: WebErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'WebError'
    this.code = code
    if (status !== undefined) this.status = status
  }
}

export function webError(code: WebErrorCode, message: string, status?: number): WebError {
  return new WebError(code, message, status)
}

/**
 * Не-2xx ответ → ошибка с честным классом: 202 и 403 у поисковиков и магазинов —
 * анти-бот (DDG отдаёт 202 с пустой страницей), 429 — «подожди», прочее — http_error.
 */
export function statusError(who: string, status: number): WebError {
  const code: WebErrorCode = status === 429 ? 'rate_limited' : status === 202 || status === 403 ? 'blocked' : 'http_error'
  return webError(code, `${who}: HTTP ${status}`, status)
}

/** Код любой ошибки: чужой `Error` без кода — сетевая осечка. */
export function errorCode(e: Error): WebErrorCode {
  return e instanceof WebError ? e.code : 'network'
}

/**
 * Ошибка транспорта nr-web → ошибка тулзы. nr-web различает осечки по `name`
 * (`TimeoutError`, `BodyTooLargeError`, `AbortError`), всё прочее — сеть.
 */
export function fromTransportError(e: Error, url: string): WebError {
  switch (e.name) {
    case 'TimeoutError':
      return webError('timeout', `${url}: ${e.message}`)
    case 'BodyTooLargeError':
      return webError('too_large', `${url}: ${e.message}`)
    case 'AbortError':
      return webError('aborted', `${url}: запрос отменён`)
    default:
      return webError('network', `${url}: ${e.message}`)
  }
}

export function errorText(tool: string, e: Error): string {
  return `${tool} failed [${errorCode(e)}]: ${e.message}`
}
