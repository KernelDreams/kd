/**
 * Представление результатов текстом — для модели (content tool_result) и для
 * человека (`/web`). Структура целиком уезжает в `details`.
 */

import type { WebFetchResult } from './fetch.js'
import type { SearchHit } from './search/index.js'

export function formatHits(hits: readonly SearchHit[]): string {
  if (hits.length === 0) return 'No results.'
  return hits
    .map((h, i) => [`${i + 1}. ${h.title || h.url}`, `   ${h.url}`, ...(h.snippet ? [`   ${h.snippet}`] : [])].join('\n'))
    .join('\n\n')
}

/**
 * Страница для модели: шапка (url, title) и текст. Обрезка помечается и в
 * конце текста — модель должна видеть, что это не всё, даже не читая details.
 */
export function formatPage(page: WebFetchResult): string {
  const head = [`URL: ${page.url}`, ...(page.title ? [`Title: ${page.title}`] : [])].join('\n')
  const tail = page.truncated ? `\n\n[truncated: output cut at ${page.text.length} chars; raise maxChars to read more]` : ''
  return `${head}\n\n${page.text}${tail}`
}
