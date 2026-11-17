/**
 * Поиск картинок: DuckDuckGo без ключа по умолчанию, SearXNG по `SEARXNG_URL` (категория `images`) — первым,
 * если задан. Тот же маршрутизатор, что у `webSearch` по духу: первый ответивший непустой выдачей побеждает, отказ
 * одного — следующий; не ответил никто — ошибка с причиной каждого.
 *
 * DDG картинок нет в html-выдаче: страница `duckduckgo.com/?q=…&iax=images&ia=images` отдаёт токен `vqd`, по нему
 * JSON `duckduckgo.com/i.js` (results[]: image, thumbnail, title, url страницы, width, height). Хрупко к вёрстке —
 * разбор токена и ответа отдельными функциями, у каждой тест.
 */

import { type AsyncResult, ok, err } from '@kerneldreams/nrd'
import { asJson, asText } from '@kerneldreams/web'
import { errorCode, statusError, webError } from '../errors.js'
import { inlineText } from '../html.js'
import { USER_AGENT, request, type Http } from '../http.js'
import type { WebEnv } from './types.js'

export interface ImageHit {
  /** Полная картинка. */
  image: string
  /** Эскиз (быстро в сетке). */
  thumb: string
  title: string
  /** Страница, где картинка нашлась. */
  page: string
  width?: number
  height?: number
  /** Кто нашёл: `ddg`, `searxng`. */
  via: string
}

export interface ImageSearchParams {
  query: string
  limit?: number
  /** `off` — без фильтра взрослого (DDG `p=-1`), иначе умеренный. */
  safe?: 'moderate' | 'off'
}

export interface ImageSearchDeps {
  http: Http
  env: WebEnv
  signal?: AbortSignal
}

export const IMAGE_LIMIT = 40
const MAX = 100

/** Токен `vqd` со страницы DDG: `vqd="4-…"`, `vqd='4-…'` или `vqd=4-…&`. */
export function ddgVqd(html: string): string | undefined {
  return /vqd=["']?([\d-]+)["']?/.exec(html)?.[1]
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function parseDdgImages(json: unknown): ImageHit[] {
  const list = (json as { results?: unknown[] } | null)?.results
  if (!Array.isArray(list)) return []
  return list.flatMap((r) => {
    const o = (r ?? {}) as Record<string, unknown>
    const image = str(o.image)
    if (!/^https?:\/\//.test(image)) return []
    const width = num(o.width)
    const height = num(o.height)
    return [{ image, thumb: str(o.thumbnail) || image, title: inlineText(str(o.title)), page: str(o.url), ...(width ? { width } : {}), ...(height ? { height } : {}), via: 'ddg' }]
  })
}

export function parseSearxngImages(json: unknown): ImageHit[] {
  const list = (json as { results?: unknown[] } | null)?.results
  if (!Array.isArray(list)) return []
  return list.flatMap((r) => {
    const o = (r ?? {}) as Record<string, unknown>
    const image = str(o.img_src)
    if (!/^https?:\/\//.test(image)) return []
    const size = /^(\d+)\s*[x×]\s*(\d+)$/.exec(str(o.resolution).trim())
    return [{ image, thumb: str(o.thumbnail_src) || image, title: inlineText(str(o.title)), page: str(o.url), ...(size ? { width: Number(size[1]), height: Number(size[2]) } : {}), via: 'searxng' }]
  })
}

async function ddgImages(p: ImageSearchParams, d: ImageSearchDeps): AsyncResult<ImageHit[]> {
  const page = await request(d.http, { method: 'GET', url: `https://duckduckgo.com/?q=${encodeURIComponent(p.query)}&iax=images&ia=images`, headers: { 'user-agent': USER_AGENT } }, d.signal)
  if (!page.ok) return page
  if (page.value.status !== 200) return err(statusError('ddg', page.value.status))
  const vqd = ddgVqd(asText(page.value))
  if (!vqd) return err(webError('blocked', 'ddg: нет токена выдачи картинок (vqd) — вёрстка сменилась или анти-бот'))
  const u = new URL('https://duckduckgo.com/i.js')
  u.searchParams.set('l', 'wt-wt')
  u.searchParams.set('o', 'json')
  u.searchParams.set('q', p.query)
  u.searchParams.set('vqd', vqd)
  u.searchParams.set('f', ',,,,,')
  u.searchParams.set('p', p.safe === 'off' ? '-1' : '1')
  const res = await request(d.http, { method: 'GET', url: u.href, headers: { 'user-agent': USER_AGENT, referer: 'https://duckduckgo.com/', accept: 'application/json' } }, d.signal)
  if (!res.ok) return res
  if (res.value.status === 403 || res.value.status === 418) return err(webError('blocked', `ddg: выдача картинок закрыта (HTTP ${res.value.status})`, res.value.status))
  if (res.value.status !== 200) return err(statusError('ddg', res.value.status))
  const json = asJson(res.value)
  if (!json.ok) return err(webError('parse', `ddg: ответ не JSON — ${json.error.message}`))
  return ok(parseDdgImages(json.value))
}

async function searxngImages(p: ImageSearchParams, d: ImageSearchDeps): AsyncResult<ImageHit[]> {
  let u: URL
  try {
    u = new URL('search', (d.env.SEARXNG_URL ?? '').replace(/\/*$/, '/'))
  } catch {
    return err(webError('config', `searxng: некорректный SEARXNG_URL "${d.env.SEARXNG_URL}"`))
  }
  u.searchParams.set('q', p.query)
  u.searchParams.set('format', 'json')
  u.searchParams.set('categories', 'images')
  if (p.safe === 'off') u.searchParams.set('safesearch', '0')
  const res = await request(d.http, { method: 'GET', url: u.href, headers: { accept: 'application/json' } }, d.signal)
  if (!res.ok) return res
  if (res.value.status !== 200) return err(statusError('searxng', res.value.status))
  const json = asJson(res.value)
  if (!json.ok) return err(webError('parse', `searxng: ответ не JSON — ${json.error.message}`))
  return ok(parseSearxngImages(json.value))
}

/** Картинки по запросу: SearXNG (если задан), потом DDG; первый непустой. */
export async function imageSearch(p: ImageSearchParams, d: ImageSearchDeps): AsyncResult<ImageHit[]> {
  const query = p.query.trim()
  if (!query) return err(webError('bad_request', 'поиск картинок: пустой запрос'))
  const limit = Math.min(MAX, Math.max(1, Math.floor(p.limit ?? IMAGE_LIMIT)))
  const order: { name: string; run: () => AsyncResult<ImageHit[]> }[] = [
    ...(d.env.SEARXNG_URL ? [{ name: 'searxng', run: () => searxngImages({ ...p, query }, d) }] : []),
    { name: 'ddg', run: () => ddgImages({ ...p, query }, d) },
  ]
  const fails: string[] = []
  for (const o of order) {
    const r = await o.run()
    if (r.ok && r.value.length) return ok(r.value.slice(0, limit))
    fails.push(r.ok ? `${o.name}: пусто` : `${o.name}: ${r.error.message}`)
    if (!r.ok && errorCode(r.error) === 'bad_request') break
  }
  return fails.every((f) => f.endsWith(': пусто')) ? ok([]) : err(webError('network', `поиск картинок не ответил — ${fails.join('; ')}`))
}
