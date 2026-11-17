/**
 * `@kerneldreams/web-tools` — поиск и чтение веба для агента: `web_search` (ddg / brave / searxng) и
 * `web_fetch` (html → текст, SSRF-стоп) — функциями и готовыми тулами (`createWebTools`, `./tools`).
 * Без состояния и без кэша. Ошибки уходят текстом в результат тула, а не исключением.
 *
 * Окружение (читается на каждый вызов):
 *   NR_WEB_SEARCH            провайдеры через запятую, default `ddg` (ddg|brave|searxng)
 *   BRAVE_API_KEY            ключ Brave Search API
 *   SEARXNG_URL              адрес инстанса SearXNG
 *   NR_WEB_FETCH_ALLOW_HOSTS hostname через запятую, для которых снят SSRF-стоп (отладка, смоук)
 */
export { webFetch, clampMaxChars, bodyKind, decodeBody } from './fetch.js'
export type { WebFetchParams, WebFetchResult } from './fetch.js'
export { webSearch, clampLimit, providerOrder, PROVIDERS } from './search/index.js'
export type { SearchHit, SearchProvider, WebEnv, WebSearchParams } from './search/index.js'
export { parseDdgHtml } from './search/ddg.js'
export { imageSearch, parseDdgImages, parseSearxngImages, ddgVqd, IMAGE_LIMIT } from './search/images.js'
export type { ImageHit, ImageSearchParams, ImageSearchDeps } from './search/images.js'
export { htmlToText, truncate, decodeEntities } from './html.js'
export { checkUrl, checkResolved, isPrivateAddress } from './ssrf.js'
export { WebError } from './errors.js'
export type { WebErrorCode } from './errors.js'
export { formatHits, formatPage } from './format.js'
export { createWebTools, WEB_SEARCH_DESCRIPTION, WEB_SEARCH_PARAMETERS, WEB_FETCH_DESCRIPTION, WEB_FETCH_PARAMETERS } from './tools.js'
export type { WebToolDef, WebToolResult, WebToolsDeps } from './tools.js'
export { errorText } from './errors.js'
export { defaultHttp } from './http.js'
export type { Http } from './http.js'
export { defaultWebEnv } from './machine.js'
export type { Lookup } from './ssrf.js'
