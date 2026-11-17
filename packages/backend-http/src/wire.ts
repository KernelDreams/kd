/**
 * Общий контракт провода: Envelope §4 + коды ошибок + нормализация basePath.
 *
 * Делится между serveBackend и createHttpBackend — обе стороны обязаны
 * эволюционировать синхронно (backends-spec §3), поэтому форма ответа
 * описана один раз здесь, а не дважды по разные стороны сокета.
 */

import type { Envelope } from '@kerneldreams/ui-protocol'
import { NOT_SUPPORTED_CODE } from '@kerneldreams/ui-protocol'

/**
 * Envelope §4 с кодом ошибки.
 *
 * `code` в §4 спеки протокола нет, но backends-spec §3.1 требует
 * `{ok:false, error, code:'not_supported'}` — код едет дополнительным полем.
 * Легально: §1.2 «неизвестные поля в известных структурах игнорируются»,
 * так что клиент, не знающий про `code`, не ломается.
 */
export interface WireEnvelope<T> extends Envelope<T> {
  code?: string
}

/** Операция не заявлена в capabilities (backends-spec §2). */
export const CODE_NOT_SUPPORTED = NOT_SUPPORTED_CODE
/** Роут не найден. */
export const CODE_NOT_FOUND = 'not_found'
/** Сессия занята живым раном (§10.1: один активный run на сессию). */
export const CODE_BUSY = 'busy'
/** Тело/параметры запроса не разобрались. */
export const CODE_BAD_REQUEST = 'bad_request'
/** Стрим оборвался на транспорте — синтетический код клиента (§3.2). */
export const CODE_CONNECTION_LOST = 'connection_lost'
/** Нет ключа доступа или чужой (`ServeBackendOpts.authKey`, HTTP 401). */
export const CODE_UNAUTHORIZED = 'unauthorized'
/** Вошедшему нельзя (пользователи стенда v1.30, HTTP 403). */
export const CODE_FORBIDDEN = 'forbidden'

/**
 * Нормализует basePath: '' | '/api' | 'api/' → '' | '/api'.
 * Пустая строка = биндинг в корень.
 */
export function normalizeBasePath(basePath?: string): string {
  if (!basePath) return ''
  const trimmed = basePath.replace(/^\/+|\/+$/g, '')
  return trimmed === '' ? '' : `/${trimmed}`
}

/** Текст ошибки для Envelope: Error → message, прочее → String(). */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
