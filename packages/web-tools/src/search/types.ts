/**
 * Контракт провайдера поиска (спека §1): одна функция `(query, opts) →
 * Result<SearchHit[]>`. Новый поисковик = один файл в `src/search/` + строка в
 * реестре `PROVIDERS` (`index.ts`).
 */

import type { AsyncResult } from '@kerneldreams/nrd'
import type { Http } from '../http.js'

export interface SearchHit {
  title: string
  url: string
  snippet: string
}

/** Окружение: ключи и адреса провайдеров читаются на вызов, не при загрузке. */
export type WebEnv = Readonly<Record<string, string | undefined>>

export interface SearchOptions {
  /** Уже зажатый в [1, 10]. */
  limit: number
  lang?: string
  http: Http
  env: WebEnv
  signal?: AbortSignal
}

export interface SearchProvider {
  readonly name: string
  /** Не настроен (нет ключа/адреса) — текст причины; настроен — `undefined`. */
  unconfigured(env: WebEnv): string | undefined
  search(query: string, opts: SearchOptions): AsyncResult<SearchHit[]>
}
