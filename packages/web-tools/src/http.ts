/**
 * HTTP тулз — `nr-web` `fetchTransport` с лимитами спеки §1: таймаут 20 с,
 * тело ≤ 5 МБ. Редиректы для web_fetch ведутся здесь вручную (≤ 5), потому что
 * каждый хоп обязан пройти SSRF-стоп заново: иначе публичный url с `302 →
 * http://169.254.169.254/` увёл бы запрос во внутреннюю сеть.
 *
 * `Http` — инъекция: юниты подсовывают стаб, расширение — `defaultHttp()`.
 */

import { fetchTransport } from '@kerneldreams/web'
import type { WebRequest, WebResponse } from '@kerneldreams/web'
import { type AsyncResult, ok, err } from '@kerneldreams/nrd'
import { fromTransportError, webError } from './errors.js'
import { checkResolved, checkUrl, type Lookup } from './ssrf.js'

export const TIMEOUT_MS = 20_000
export const MAX_BYTES = 5 * 1024 * 1024
export const MAX_REDIRECTS = 5

/**
 * Браузерный UA: с «честным» ботовым UA часть сайтов (и html-выдача DDG)
 * отдаёт заглушку вместо страницы.
 */
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

export interface HttpOptions {
  redirect?: 'follow' | 'manual'
  timeoutMs?: number
  signal?: AbortSignal
}

export type Http = (req: WebRequest, opts?: HttpOptions) => AsyncResult<WebResponse>

export function defaultHttp(): Http {
  return (req, opts = {}) =>
    fetchTransport({
      timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
      maxBytes: MAX_BYTES,
      redirect: opts.redirect ?? 'follow',
      ...(opts.signal ? { signal: opts.signal } : {}),
    }).deliver(req)
}

/** Запрос к настроенному эндпоинту (поисковики): без SSRF, ошибки транспорта → WebError. */
export async function request(http: Http, req: WebRequest, signal?: AbortSignal): AsyncResult<WebResponse> {
  const res = await http(req, signal ? { signal } : {})
  if (!res.ok) return err(fromTransportError(res.error, req.url))
  return res
}

export interface GuardedGetDeps {
  http: Http
  lookup: Lookup
  allowHosts: readonly string[]
  signal?: AbortSignal
}

/** Итог GET: финальный url после редиректов и ответ. */
export interface GuardedResponse {
  url: string
  response: WebResponse
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * GET публичного url: SSRF-стоп на каждом хопе, редиректы ≤ MAX_REDIRECTS,
 * общий таймаут на всю цепочку (а не по TIMEOUT_MS на хоп — иначе пять
 * редиректов растягивали бы вызов до двух минут).
 */
export async function guardedGet(rawUrl: string, deps: GuardedGetDeps): AsyncResult<GuardedResponse> {
  const deadline = Date.now() + TIMEOUT_MS
  let current = rawUrl

  for (let hop = 0; ; hop++) {
    const literal = checkUrl(current, deps.allowHosts)
    if (!literal.ok) return literal
    const resolved = await checkResolved(literal.value, deps.lookup, deps.allowHosts)
    if (!resolved.ok) return resolved
    const url = resolved.value.href

    const remaining = deadline - Date.now()
    if (remaining <= 0) return err(webError('timeout', `${rawUrl}: timed out after ${TIMEOUT_MS} ms`))

    const res = await deps.http(
      {
        method: 'GET',
        url,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/*;q=0.8,*/*;q=0.5',
        },
      },
      { redirect: 'manual', timeoutMs: remaining, ...(deps.signal ? { signal: deps.signal } : {}) },
    )
    if (!res.ok) return err(fromTransportError(res.error, url))

    const location = res.value.headers['location']
    if (!REDIRECT_STATUSES.has(res.value.status) || !location) {
      return ok({ url, response: res.value })
    }
    if (hop >= MAX_REDIRECTS) {
      return err(webError('too_many_redirects', `${rawUrl}: больше ${MAX_REDIRECTS} редиректов`))
    }
    try {
      current = new URL(location, url).href
    } catch {
      return err(webError('bad_request', `${url}: некорректный location "${location}"`))
    }
  }
}
