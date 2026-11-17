/**
 * Сервисы плагинов (plugin-services-spec §2, протокол v1.11): Node-половина
 * плагина за проводом — `services.call` (RPC) и `services.stream` (push).
 *
 * Здесь форма провода и правила, общие для транспортов: гейт по capability,
 * кадр ошибки стрима, SSE-кадры HTTP-биндинга. Контракт самого `service.ts`
 * (`ServiceMeta`) — subpath `@kerneldreams/ui-protocol/service`.
 */

import type { Capabilities } from './types.js'

// ────────────────────────────────────────────────────────────────────────────
// Типы
// ────────────────────────────────────────────────────────────────────────────

/** Кадр стрима сервиса: имя события и произвольный JSON (байты — base64). */
export interface ServiceEvent {
  name: string
  payload?: unknown
}

/** Что сервис плагина зарегистрировал: `meta.on` → methods, `meta.stream` → streams. */
export interface ServiceDescriptor {
  methods: string[]
  streams: string[]
}

/**
 * Capability `services`: ключ — `plugin.id`. Заявлена ⇔ у бэкенда есть слой
 * сервисов; пустой объект — слой есть, сервисов нет.
 */
export type ServicesCapability = Record<string, ServiceDescriptor>

/**
 * HTTP сервиса (v1.14): метод с именем {@link SERVICE_HTTP_METHOD}, если сервис
 * его зарегистрировал, HTTP-транспорт отдаёт браузеру как обычный GET —
 * `GET /services/<plugin>/http/<путь>?<query>` → `call(plugin, 'http',
 * ServiceHttpRequest)` → ответ {@link ServiceHttpResponse} как есть (статус,
 * заголовки, тело). Так статика плагина (страница артефакта в iframe) ходит
 * тем же адресом, что и бэкенд — через туннель и с чужого устройства. URL для
 * браузера — `ServicesOps.url` (есть только у транспорта с HTTP).
 */
export const SERVICE_HTTP_METHOD = 'http'

export interface ServiceHttpRequest {
  method: 'GET' | 'HEAD'
  /** Путь после `/services/<plugin>/http`, с ведущим `/`, раскодированный по сегментам. */
  path: string
  /** Строка запроса как есть, с `?` (или `''`). */
  query: string
  headers: Record<string, string>
}

export interface ServiceHttpResponse {
  status: number
  headers?: Record<string, string>
  /** Строка (utf-8) или байты по проводу — `{__b64}`. */
  body?: string | { __b64: string }
}

/** Вид операции сервиса: `call` ищется в `methods`, `stream` — в `streams`. */
export type ServiceKind = 'call' | 'stream'

// ────────────────────────────────────────────────────────────────────────────
// Константы
// ────────────────────────────────────────────────────────────────────────────

/**
 * Имя кадра, которым кончается упавший стрим: throw хендлера после открытия
 * (или обрыв провода на клиенте) — `{name: 'error', payload: {message, code?}}`,
 * затем конец стрима. Ошибка ДО открытия (`not_supported`) — throw, не кадр.
 */
export const SERVICE_ERROR_EVENT = 'error'

// ────────────────────────────────────────────────────────────────────────────
// Гейты
// ────────────────────────────────────────────────────────────────────────────

/**
 * Можно ли звать `method` сервиса плагина `plugin`: capability `services`
 * заявлена и плагин зарегистрировал этот метод. Без `kind` — любой из видов.
 */
export function canService(
  caps: Capabilities | null | undefined,
  plugin: string,
  method: string,
  kind?: ServiceKind,
): boolean {
  const services = caps?.services
  if (!services || !Object.hasOwn(services, plugin)) return false
  const service = services[plugin]!
  if (kind === 'call') return service.methods.includes(method)
  if (kind === 'stream') return service.streams.includes(method)
  return service.methods.includes(method) || service.streams.includes(method)
}

// ────────────────────────────────────────────────────────────────────────────
// Кадры
// ────────────────────────────────────────────────────────────────────────────

export function isServiceEvent(value: unknown): value is ServiceEvent {
  const v = value as { name?: unknown } | null
  return typeof v === 'object' && v !== null && typeof v.name === 'string' && v.name !== ''
}

/** Ошибка → кадр `error` (message + строковый `code`, если есть). */
export function serviceErrorEvent(err: unknown, code?: string): ServiceEvent {
  const message = err instanceof Error ? err.message : String(err)
  const own = (err as { code?: unknown } | null | undefined)?.code
  const c = code ?? (typeof own === 'string' && own !== '' ? own : undefined)
  return { name: SERVICE_ERROR_EVENT, payload: c !== undefined ? { message, code: c } : { message } }
}

// ────────────────────────────────────────────────────────────────────────────
// SSE (HTTP-биндинг: POST /services/:plugin/:method/stream)
// ────────────────────────────────────────────────────────────────────────────

/** Кадр события стрима сервиса. */
export const SERVICE_EVENT_SSE = 'service_event'
/** Кадр штатного конца стрима: без него закрытое соединение — обрыв. */
export const SERVICE_END_SSE = 'service_end'

/** Событие → SSE-кадр `service_event`. */
export function serializeServiceEvent(event: ServiceEvent): string {
  const data = event.payload === undefined ? { name: event.name } : { name: event.name, payload: event.payload }
  return `event: ${SERVICE_EVENT_SSE}\ndata: ${JSON.stringify(data)}\n\n`
}

/** SSE-кадр конца стрима. */
export function serializeServiceEnd(): string {
  return `event: ${SERVICE_END_SSE}\ndata: {}\n\n`
}

/** Разобранный SSE-кадр стрима сервиса. */
export type ServiceFrame = { type: 'event'; event: ServiceEvent } | { type: 'end' }

/** SSE-кадр → событие или конец; комментарий, чужой или битый кадр — `null`, не throw. */
export function parseServiceFrame(frame: string): ServiceFrame | null {
  let kind = ''
  const dataLines: string[] = []
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line === '' || line.startsWith(':')) continue
    const idx = line.indexOf(':')
    const field = idx === -1 ? line : line.slice(0, idx)
    let value = idx === -1 ? '' : line.slice(idx + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') kind = value
    else if (field === 'data') dataLines.push(value)
  }
  if (kind === SERVICE_END_SSE) return { type: 'end' }
  if (kind !== SERVICE_EVENT_SSE) return null
  try {
    const parsed: unknown = JSON.parse(dataLines.join('\n'))
    if (!isServiceEvent(parsed)) return null
    const event: ServiceEvent = { name: parsed.name }
    if (parsed.payload !== undefined) event.payload = parsed.payload
    return { type: 'event', event }
  } catch {
    return null
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Мультиплекс подписок (v1.68): POST /services/_mux/stream
// ────────────────────────────────────────────────────────────────────────────

/**
 * Путь мультиплекса: один SSE на все вечные подписки вкладки. У браузера 6
 * соединений HTTP/1.1 на хост (loopback, ssh-проброс — без HTTP/2): по
 * стриму на подписку пул кончался, и обычные запросы (`respond`, `links/rules`)
 * вставали в «pending» навсегда. Старый сервер отвечает на него
 * `not_supported` (маршрут call плагина `_mux`) — клиент откатывается на
 * стрим на подписку.
 */
export const SERVICE_MUX_PATH = '/services/_mux/stream'
/** Кадр мультиплекса: `data: {key, name?, payload?, end?}`. */
export const SERVICE_MUX_SSE = 'service_mux'

/** Подписка в теле мультиплекса: `{streams: ServiceMuxStream[]}`. */
export interface ServiceMuxStream {
  /** Ключ подписки — им помечены кадры; уникален в одном запросе. */
  key: string
  plugin: string
  method: string
  args?: unknown
}

/** Событие подписки `key` (или её конец, `event: null`) → кадр `service_mux`. */
export function serializeServiceMux(key: string, event: ServiceEvent | null): string {
  const data = event === null ? { key, end: true } : event.payload === undefined ? { key, name: event.name } : { key, name: event.name, payload: event.payload }
  return `event: ${SERVICE_MUX_SSE}\ndata: ${JSON.stringify(data)}\n\n`
}

/** Кадр мультиплекса → ключ и кадр подписки; чужой или битый — `null`. */
export function parseServiceMuxFrame(frame: string): { key: string; frame: ServiceFrame } | null {
  let kind = ''
  const dataLines: string[] = []
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line === '' || line.startsWith(':')) continue
    const idx = line.indexOf(':')
    const field = idx === -1 ? line : line.slice(0, idx)
    let value = idx === -1 ? '' : line.slice(idx + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') kind = value
    else if (field === 'data') dataLines.push(value)
  }
  if (kind !== SERVICE_MUX_SSE) return null
  try {
    const d = JSON.parse(dataLines.join('\n')) as { key?: unknown; end?: unknown; name?: unknown; payload?: unknown }
    const key = d?.key
    if (typeof key !== 'string') return null
    if (d.end === true) return { key, frame: { type: 'end' } }
    if (typeof d.name !== 'string' || d.name === '') return null
    const event: ServiceEvent = { name: d.name }
    if (d.payload !== undefined) event.payload = d.payload
    return { key, frame: { type: 'event', event } }
  } catch {
    return null
  }
}
