/**
 * web_fetch (спека §1): url → `{ url, title?, text, truncated }`.
 *
 * `text/html` (и xhtml) → текст через `htmlToText`; `application/json`,
 * `+json`, `text/*` — как есть; остальное — `unsupported_content_type`.
 * Нет заголовка — смотрим, похоже ли тело на HTML; не похоже — та же ошибка:
 * гадать о бинаре модели незачем.
 */

import { type AsyncResult, ok, err } from '@kerneldreams/nrd'
import type { WebResponse } from '@kerneldreams/web'
import { statusError, webError } from './errors.js'
import { isChallenge } from './browser.js'
import { productFromHtml, type ProductCard } from './product.js'
import { htmlToText, truncate } from './html.js'
import { guardedGet, type GuardedGetDeps } from './http.js'

export const DEFAULT_MAX_CHARS = 20_000
/** Потолок maxChars: тулза обязана беречь контекст модели даже от самой модели. */
export const MAX_MAX_CHARS = 100_000

export interface WebFetchParams {
  url: string
  maxChars?: number
}

export interface WebFetchResult {
  url: string
  title?: string
  text: string
  truncated: boolean
  /** Карточка товара (JSON-LD/мета), если страница — товар. */
  product?: ProductCard
  /** Страница взята настоящим браузером профиля: обычный запрос упёрся в анти-бот. */
  via?: 'browser'
}

export function clampMaxChars(maxChars: number | undefined): number {
  if (maxChars === undefined || !Number.isFinite(maxChars)) return DEFAULT_MAX_CHARS
  return Math.min(MAX_MAX_CHARS, Math.max(1, Math.floor(maxChars)))
}

export type BodyKind = 'html' | 'text'

/** Тип тела по content-type (и по самому телу, если заголовка нет). */
export function bodyKind(contentType: string | undefined, head: string): BodyKind | undefined {
  const mime = (contentType ?? '').split(';')[0]!.trim().toLowerCase()
  if (mime === '') return /^\s*(<!doctype html|<html)/i.test(head) ? 'html' : undefined
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime.startsWith('text/') || mime === 'application/json' || mime.endsWith('+json')) return 'text'
  return undefined
}

/** Кодировка: `charset` заголовка, затем `<meta charset>` в голове HTML, иначе utf-8. */
export function decodeBody(res: WebResponse): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(res.headers['content-type'] ?? '')?.[1]
  let charset = fromHeader
  if (!charset) {
    const head = new TextDecoder('latin1').decode(res.body.subarray(0, 2048))
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]
  }
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(res.body)
  } catch {
    // Незнакомая кодировка — лучше utf-8 с заменами, чем ничего.
    return new TextDecoder('utf-8').decode(res.body)
  }
}

export async function webFetch(params: WebFetchParams, deps: GuardedGetDeps): AsyncResult<WebFetchResult> {
  if (typeof params.url !== 'string' || params.url.trim() === '') {
    return err(webError('bad_request', 'url обязателен'))
  }
  const maxChars = clampMaxChars(params.maxChars)

  const got = await guardedGet(params.url.trim(), deps)
  if (!got.ok) return got
  const { url, response } = got.value

  if (response.status < 200 || response.status >= 300) {
    return err(statusError(url, response.status))
  }

  const contentType = response.headers['content-type']
  const head = new TextDecoder('latin1').decode(response.body.subarray(0, 512))
  const kind = bodyKind(contentType, head)
  if (!kind) {
    return err(webError('unsupported_content_type', `${url}: unsupported content-type "${contentType ?? '(нет)'}"`))
  }

  const decoded = decodeBody(response)
  if (kind === 'html') {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(decoded)?.[1] ?? ''
    if (isChallenge(title, decoded)) return err(webError('blocked', `${url}: вместо страницы анти-бот заглушка («${title.trim().slice(0, 60)}»)`, response.status))
  }
  return ok(pageResult(url, decoded, kind, maxChars))
}

/**
 * Тело → результат: текст, заголовок, карточка товара. Общий для обычного
 * запроса и браузера. Заглушка анти-бота с кодом 200 — тоже `blocked`
 * (проверяет вызывающий через `challengeOf`).
 */
export function pageResult(url: string, body: string, kind: BodyKind, maxChars: number): WebFetchResult {
  const page = kind === 'html' ? htmlToText(body) : { text: body }
  const cut = truncate(page.text, maxChars)
  const result: WebFetchResult = { url, text: cut.text, truncated: cut.truncated }
  if (page.title) result.title = page.title
  if (kind === 'html') {
    const product = productFromHtml(body, url)
    if (product) result.product = product
  }
  return result
}
