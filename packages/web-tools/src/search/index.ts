/**
 * web_search (спека §1, маршрутизатор —): провайдеры по порядку
 * `NR_WEB_SEARCH` (через запятую); не задан — `searxng,brave,ddg` из
 * настроенных. Первый ответивший непустой выдачей побеждает. Анти-бот
 * (`blocked`: DDG 202/403, капча), 429, таймаут и сеть — переключение на
 * следующего, а не ошибка модели: модель получает итог и имя ответившего.
 * Осёкшийся провайдер остывает (`COOLDOWN_MS`) — следующие вызовы его
 * пропускают, пока остывание не пройдёт, так что повтор того же запроса
 * моделью не бьёт снова в капчу. Остыли все — пробуются все.
 */

import { type AsyncResult, err } from '@kerneldreams/nrd'
import { errorCode, webError, type WebErrorCode } from '../errors.js'
import type { Http } from '../http.js'
import { brave } from './brave.js'
import { ddg } from './ddg.js'
import { searxng } from './searxng.js'
import type { SearchHit, SearchProvider, WebEnv } from './types.js'

export type { SearchHit, SearchProvider, WebEnv } from './types.js'

export const PROVIDERS: Readonly<Record<string, SearchProvider>> = { ddg, brave, searxng }

export const DEFAULT_LIMIT = 5
export const MAX_LIMIT = 10

export interface WebSearchParams {
  query: string
  limit?: number
  lang?: string
}

export interface WebSearchDeps {
  http: Http
  env: WebEnv
  signal?: AbortSignal
  /** Реестр для тестов; по умолчанию — PROVIDERS. */
  providers?: Readonly<Record<string, SearchProvider>>
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)))
}

export const DEFAULT_ORDER = ['searxng', 'brave', 'ddg'] as const
/** Таймаут одного провайдера: лёг — следующий, а не весь вызов. */
export const PROVIDER_TIMEOUT_MS = 12_000
/** Сколько провайдер пропускается после осечки, по классу осечки. */
export const COOLDOWN_MS: Partial<Record<WebErrorCode, number>> = {
  blocked: 15 * 60_000,
  rate_limited: 5 * 60_000,
  timeout: 3 * 60_000,
  network: 2 * 60_000,
  http_error: 2 * 60_000,
}

/** Имена провайдеров из `NR_WEB_SEARCH`, в порядке конфигурации; `undefined` — не задан. */
export function explicitOrder(env: WebEnv): string[] | undefined {
  const names = (env.NR_WEB_SEARCH ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  return names.length ? [...new Set(names)] : undefined
}

/** Порядок опроса: явный или `DEFAULT_ORDER`. */
export function providerOrder(env: WebEnv): string[] {
  return explicitOrder(env) ?? [...DEFAULT_ORDER]
}

export interface SearchAttempt {
  provider: string
  /** Чем кончилось: `ok`, `empty`, код осечки, `skipped` (остывает) или `unconfigured`. */
  result: 'ok' | 'empty' | 'skipped' | 'unconfigured' | WebErrorCode
  message?: string
  ms?: number
}

export interface SearchOutcome {
  hits: SearchHit[]
  /** Кто ответил. */
  provider: string
  attempts: SearchAttempt[]
}

/** Остывание провайдеров — на процесс: переживает вызовы и сессии, не рестарт. */
const sharedCooldowns = new Map<string, { until: number; why: string }>()

export interface RouteDeps extends WebSearchDeps {
  now?: () => number
  cooldowns?: Map<string, { until: number; why: string }>
  providerTimeoutMs?: number
}

function timeoutSignal(outer: AbortSignal | undefined, ms: number): { signal: AbortSignal; timedOut: () => boolean; done: () => void } {
  const ac = new AbortController()
  let fired = false
  const timer = setTimeout(() => {
    fired = true
    ac.abort()
  }, ms)
  const onOuter = () => ac.abort()
  outer?.addEventListener('abort', onOuter, { once: true })
  if (outer?.aborted) ac.abort()
  return {
    signal: ac.signal,
    timedOut: () => fired,
    done: () => {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onOuter)
    },
  }
}

export async function routeSearch(params: WebSearchParams, deps: RouteDeps): AsyncResult<SearchOutcome> {
  const query = typeof params.query === 'string' ? params.query.trim() : ''
  if (query === '') return err(webError('bad_request', 'query обязателен'))

  const registry = deps.providers ?? PROVIDERS
  const now = deps.now ?? Date.now
  const cooldowns = deps.cooldowns ?? sharedCooldowns
  const explicit = explicitOrder(deps.env)
  const attempts: SearchAttempt[] = []

  const ready: string[] = []
  for (const name of explicit ?? DEFAULT_ORDER) {
    const provider = registry[name]
    if (!provider) {
      if (explicit) attempts.push({ provider: name, result: 'unconfigured', message: `неизвестный провайдер (есть: ${Object.keys(registry).join(', ')})` })
      continue
    }
    const why = provider.unconfigured(deps.env)
    if (why) {
      // В порядке по умолчанию ненастроенный — не событие; в явном — причина в отчёт.
      if (explicit) attempts.push({ provider: name, result: 'unconfigured', message: why })
      continue
    }
    ready.push(name)
  }
  if (ready.length === 0) {
    const why = attempts.map((a) => `${a.provider}: ${a.message}`).join('; ')
    return err(webError('config', `нет настроенного провайдера (NR_WEB_SEARCH=${deps.env.NR_WEB_SEARCH ?? '—'})${why ? `: ${why}` : ''}`))
  }

  const t0 = now()
  const cold = ready.filter((n) => (cooldowns.get(n)?.until ?? 0) <= t0)
  // Остыли все — пробуем всех: лучше ещё раз в капчу, чем отказ без попытки.
  const order = cold.length ? cold : ready
  for (const n of ready) {
    if (!order.includes(n)) {
      const c = cooldowns.get(n)!
      attempts.push({ provider: n, result: 'skipped', message: `остывает после «${c.why}», ещё ${Math.ceil((c.until - t0) / 60_000)} мин` })
    }
  }

  let empty: SearchOutcome | undefined
  let lastError: Error | undefined
  for (const name of order) {
    const started = now()
    const t = timeoutSignal(deps.signal, deps.providerTimeoutMs ?? PROVIDER_TIMEOUT_MS)
    const res = await registry[name]!.search(query, {
      limit: clampLimit(params.limit),
      http: deps.http,
      env: deps.env,
      signal: t.signal,
      ...(params.lang ? { lang: params.lang } : {}),
    })
    t.done()
    const ms = now() - started
    if (deps.signal?.aborted) return err(webError('aborted', 'поиск отменён'))
    if (res.ok) {
      cooldowns.delete(name)
      if (res.value.length) {
        attempts.push({ provider: name, result: 'ok', ms })
        return { ok: true, value: { hits: res.value, provider: name, attempts } }
      }
      attempts.push({ provider: name, result: 'empty', ms })
      empty ??= { hits: [], provider: name, attempts }
      continue
    }
    const code: WebErrorCode = t.timedOut() ? 'timeout' : errorCode(res.error)
    const message = t.timedOut() ? `нет ответа за ${Math.round((deps.providerTimeoutMs ?? PROVIDER_TIMEOUT_MS) / 1000)} с` : res.error.message
    attempts.push({ provider: name, result: code, message, ms })
    lastError = res.error
    const cool = COOLDOWN_MS[code]
    if (cool) cooldowns.set(name, { until: now() + cool, why: code })
  }
  if (empty) return { ok: true, value: { ...empty, attempts } }

  const why = attempts.map((a) => `${a.provider}: [${a.result}] ${a.message ?? ''}`.trim()).join('; ')
  const code = lastError ? errorCode(lastError) : 'network'
  return err(webError(code === 'bad_request' ? code : 'network', `ни один провайдер не ответил: ${why}`))
}

/** Только хиты — прежний контракт (`/web`, внешние вызовы). */
export async function webSearch(params: WebSearchParams, deps: RouteDeps): AsyncResult<SearchHit[]> {
  const r = await routeSearch(params, deps)
  return r.ok ? { ok: true, value: r.value.hits } : r
}

/** Сводка маршрута для модели: кто ответил и кого пропустили, одной строкой. */
export function routeLine(o: SearchOutcome): string {
  // Ненастроенные (brave без ключа) — не событие для модели; они есть в details.attempts.
  const others = o.attempts.filter((a) => a.result !== 'unconfigured' && (a.provider !== o.provider || a.result !== 'ok'))
  const tail = others.length ? `; ${others.map((a) => `${a.provider}: ${a.result}`).join(', ')}` : ''
  return `[search via ${o.provider}${tail}]`
}
