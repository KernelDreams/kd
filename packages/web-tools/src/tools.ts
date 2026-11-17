/**
 * `web_search` / `web_fetch` как обычные тулы для хостов с собственным реестром
 * тулов. Обёртки под конкретные агенты берут описания и схемы отсюда же: один
 * источник правды о том, что видит модель.
 *
 * Схемы — plain JSON Schema. Ошибки — результатом (`isError`), не исключением.
 */

import { errorCode, errorText, webError, type WebError } from './errors.js'
import { browserGet, browserPort, browserWindowHint, type BrowserPage } from './browser.js'
import { clampMaxChars, pageResult, webFetch, DEFAULT_MAX_CHARS, MAX_MAX_CHARS, type WebFetchParams, type WebFetchResult } from './fetch.js'
import { formatHits, formatPage } from './format.js'
import { defaultHttp, type Http } from './http.js'
import { defaultWebEnv } from './machine.js'
import { formatCard } from './product.js'
import { checkResolved, checkUrl, systemLookup, type Lookup } from './ssrf.js'
import { routeLine, routeSearch, DEFAULT_LIMIT, MAX_LIMIT, type WebEnv, type WebSearchParams } from './search/index.js'
import { createBrowserTools } from './tools-browser.js'

export interface WebToolResult {
  text: string
  details: unknown
  isError?: boolean
}

export interface WebToolDef {
  name: string
  description: string
  promptSnippet: string
  promptGuidelines: string[]
  parameters: Record<string, unknown>
  /** Тул виден агенту, только если тот назвал его (`browser_*`). */
  optIn?: true
  execute(args: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<WebToolResult>
}

export interface WebToolsDeps {
  http?: Http
  lookup?: Lookup
  /** Окружение читается на каждый вызов (NR_WEB_SEARCH, BRAVE_API_KEY, …); по умолчанию — `## $web` машины поверх process.env. */
  env?: () => WebEnv
  /** Добавить тулы `browser_*` (opt-in) — хост, который умеет opt-in (backend-nr). */
  browser?: boolean
  /** Тесты: страница через браузер. */
  browserGet?: (port: number, url: string, signal?: AbortSignal) => Promise<BrowserPage>
}

/** Осечки web_fetch, после которых страницу стоит взять настоящим браузером. */
export function wantsBrowser(e: Error): boolean {
  const code = errorCode(e)
  const status = (e as WebError).status
  return code === 'blocked' || code === 'rate_limited' || (code === 'http_error' && (status === 401 || status === 503))
}

export const WEB_SEARCH_DESCRIPTION =
  'Search the web. Returns a list of results: title, url and a short snippet. ' +
  'Use it to find pages, then call web_fetch on the most relevant url to read the page itself; ' +
  'snippets are short and may be stale, do not answer from them alone when details matter. ' +
  'Example: web_search {"query": "node 22 AbortSignal.any"} -> pick a url -> web_fetch {"url": "..."}.'

export const WEB_SEARCH_PARAMETERS = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Search query' },
    limit: { type: 'integer', description: `Max results, default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}` },
    lang: { type: 'string', description: 'Language/region hint, e.g. "en", "ru", "de-de"' },
  },
  required: ['query'],
}

export const WEB_FETCH_DESCRIPTION =
  'Fetch a public web page by url and return its readable text. HTML is converted to plain text ' +
  '(scripts, navigation and footers dropped); JSON and text/* are returned as is; other content types are refused. ' +
  `Output is cut at maxChars (default ${DEFAULT_MAX_CHARS}, max ${MAX_MAX_CHARS}) and marked as truncated. ` +
  'Typical flow: web_search -> pick url -> web_fetch. Only http(s); localhost and private network addresses are refused.'

export const WEB_FETCH_PARAMETERS = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'Absolute http(s) url' },
    maxChars: { type: 'integer', description: `Max characters of text, default ${DEFAULT_MAX_CHARS}` },
  },
  required: ['url'],
}

export function allowHostsOf(env: WebEnv): string[] {
  return (env.NR_WEB_FETCH_ALLOW_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

export function failureOf(tool: string, e: Error): WebToolResult {
  return { text: errorText(tool, e), details: { error: { code: errorCode(e), message: e.message } }, isError: true }
}

export function createWebTools(deps: WebToolsDeps = {}): WebToolDef[] {
  const http = deps.http ?? defaultHttp()
  const lookup = deps.lookup ?? systemLookup
  const readEnv = deps.env ?? (() => defaultWebEnv())
  const viaBrowser = deps.browserGet ?? browserGet

  /** Страница браузером профиля; заглушка не ушла — честная ошибка «нужен человек». */
  async function fetchByBrowser(url: string, maxChars: number, first: Error, env: WebEnv, signal?: AbortSignal): Promise<WebToolResult> {
    const port = browserPort(env)
    if (!port) return failureOf('web_fetch', first)
    try {
      const p = await viaBrowser(port, url, signal)
      if (p.challenge) {
        return failureOf('web_fetch', webError('blocked', `${url}: анти-бот и в браузере — нужно пройти капчу или войти руками в окне профиля${browserWindowHint(env)}; первая осечка: ${first.message}`))
      }
      const page: WebFetchResult = { ...pageResult(p.url, p.html, 'html', maxChars), via: 'browser' }
      return { text: fetchText(page), details: page }
    } catch (e) {
      return failureOf('web_fetch', webError('network', `${url}: браузер не открыл страницу (${(e as Error).message}); первая осечка: ${first.message}`))
    }
  }

  const tools: WebToolDef[] = [
    {
      name: 'web_search',
      description: WEB_SEARCH_DESCRIPTION,
      promptSnippet: 'Search the web for pages (title, url, snippet)',
      promptGuidelines: [
        'Use web_search to find current or external information, then web_fetch the most relevant result url before answering from it.',
      ],
      parameters: WEB_SEARCH_PARAMETERS,
      async execute(args, opts = {}) {
        const res = await routeSearch(args as unknown as WebSearchParams, { http, env: readEnv(), ...(opts.signal ? { signal: opts.signal } : {}) })
        if (!res.ok) return failureOf('web_search', res.error)
        const { hits, provider, attempts } = res.value
        return { text: `${routeLine(res.value)}\n${formatHits(hits)}`, details: { hits, provider, attempts } }
      },
    },
    {
      name: 'web_fetch',
      description: WEB_FETCH_DESCRIPTION,
      promptSnippet: 'Fetch a web page by url as readable text',
      promptGuidelines: ['Use web_fetch to read a page found with web_search; if the result is truncated, call web_fetch again with a larger maxChars only when needed.'],
      parameters: WEB_FETCH_PARAMETERS,
      async execute(args, opts = {}) {
        const env = readEnv()
        const params = args as unknown as WebFetchParams
        const res = await webFetch(params, { http, lookup, allowHosts: allowHostsOf(env), ...(opts.signal ? { signal: opts.signal } : {}) })
        if (res.ok) return { text: fetchText(res.value), details: res.value }
        if (!wantsBrowser(res.error)) return failureOf('web_fetch', res.error)
        // В браузер — только публичный url: SSRF-стоп тот же, что у запроса.
        const url = String(params.url).trim()
        const parsed = checkUrl(url, allowHostsOf(env))
        const safe = parsed.ok ? await checkResolved(parsed.value, lookup, allowHostsOf(env)) : parsed
        if (!safe.ok) return failureOf('web_fetch', res.error)
        return fetchByBrowser(url, clampMaxChars(params.maxChars), res.error, env, opts.signal)
      },
    },
  ]
  if (deps.browser) tools.push(...createBrowserTools({ env: readEnv }))
  return tools
}

/** Страница для модели: текст, пометка браузера, карточка товара. */
export function fetchText(page: WebFetchResult): string {
  const via = page.via === 'browser' ? '[via browser: обычный запрос упёрся в анти-бот]\n' : ''
  const card = page.product ? `\n\n${formatCard(page.product)}` : ''
  return `${via}${formatPage(page)}${card}`
}
