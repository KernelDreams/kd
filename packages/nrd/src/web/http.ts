import { type AsyncResult, type Result, ok, err } from '../infra/result.js'
import type { HttpOptions, HttpResponse } from '../contracts/index.js'

/**
 * HTTP-обёртка над globalThis.fetch с retry и timeout. Ноль зависимостей.
 * Все функции возвращают Result — предсказуемые ошибки (сеть, таймаут, статус)
 * через err(), не throws.
 *
 * HttpOptions/HttpResponse — типы переехали в @kerneldreams/nrd/contracts
 * (ступень 1); реализации (httpGet/httpPost/httpPostStream) остаются здесь.
 */
export type { HttpOptions, HttpResponse } from '../contracts/index.js'

const DEFAULT_TIMEOUT = 30000
const DEFAULT_STREAM_IDLE = 300000
const DEFAULT_RETRIES = 0
const DEFAULT_RETRY_DELAY = 1000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

function makeResponse(status: number, headers: Record<string, string>, body: string): HttpResponse {
  return {
    status,
    headers,
    body,
    json<T>(): Result<T> {
      try {
        return ok(JSON.parse(body) as T)
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)))
      }
    },
  }
}

/**
 * Один fetch под таймаутом. Таймер НЕ снимается по заголовкам: он живёт до
 * done() — вызывающий снимает его после чтения body (или сразу, если body
 * уходит в стрим под своим idle-watchdog). Иначе сервер, отдавший заголовки
 * и замолчавший, держит httpGet/httpPost вечно.
 */
interface Timed {
  res: Response
  signal: AbortSignal
  done: () => void
}

async function fetchWithTimeout(url: string, init: RequestInit, timeout: number): AsyncResult<Timed> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  const done = () => clearTimeout(timer)
  try {
    const res = await globalThis.fetch(url, { ...init, signal: controller.signal })
    return ok({ res, signal: controller.signal, done })
  } catch (e) {
    done()
    return err(timeoutOrError(e, controller.signal, timeout, url))
  }
}

function timeoutOrError(e: unknown, signal: AbortSignal, timeout: number, url: string): Error {
  if (signal.aborted || (e instanceof Error && e.name === 'AbortError')) {
    return new Error(`Request timed out after ${timeout}ms: ${url}`)
  }
  return e instanceof Error ? e : new Error(String(e))
}

/** Прочитать body целиком под тем же таймаутом. Обрыв сети → err, не throw. */
async function readText(t: Timed, timeout: number, url: string): AsyncResult<string> {
  // Гонка с сигналом явная: не полагаемся на то, что реализация fetch рвёт text() по abort.
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new Error('aborted'))
    if (t.signal.aborted) onAbort()
    else t.signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return ok(await Promise.race([t.res.text(), aborted]))
  } catch (e) {
    t.res.body?.cancel().catch(() => {})
    return err(timeoutOrError(e, t.signal, timeout, url))
  } finally {
    t.done()
  }
}

/**
 * Выполнить запрос с retry. Retry только на network error и 5xx, НЕ на 4xx.
 * Возвращает Response (даже на 4xx/5xx — это не ошибка fetch).
 */
async function requestWithRetry(url: string, init: RequestInit, opts: HttpOptions): AsyncResult<Timed> {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT
  const retries = opts.retries ?? DEFAULT_RETRIES
  const retryDelay = opts.retryDelay ?? DEFAULT_RETRY_DELAY

  let last: Result<Timed> = err(new Error('no attempts'))
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = await fetchWithTimeout(url, init, timeout)

    if (last.ok) {
      // 5xx — повторяемая ошибка сервера. 4xx — нет смысла повторять.
      if (last.value.res.status < 500 || attempt === retries) {
        return last
      }
      last.value.done()
      last.value.res.body?.cancel().catch(() => {})
    } else if (attempt === retries) {
      return last
    }

    if (attempt < retries) await delay(retryDelay)
  }
  return last
}

/** Собрать RequestInit. Сериализация body может упасть (циклы, BigInt) — это err, не throw. */
function buildInit(method: string, body: unknown, opts: HttpOptions): Result<RequestInit> {
  const headers: Record<string, string> = { ...opts.headers }
  let bodyStr: string | undefined
  if (body !== undefined) {
    if (typeof body === 'string') {
      bodyStr = body
    } else {
      try {
        bodyStr = JSON.stringify(body)
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)))
      }
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json'
      }
    }
  }
  return ok({ method, headers, body: bodyStr })
}

async function request(url: string, init: Result<RequestInit>, opts: HttpOptions): AsyncResult<HttpResponse> {
  if (!init.ok) return init
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT
  const res = await requestWithRetry(url, init.value, opts)
  if (!res.ok) return res
  const text = await readText(res.value, timeout, url)
  if (!text.ok) return text
  return ok(makeResponse(res.value.res.status, headersToObject(res.value.res.headers), text.value))
}

/** GET-запрос. */
export async function httpGet(url: string, opts: HttpOptions = {}): AsyncResult<HttpResponse> {
  return request(url, buildInit('GET', undefined, opts), opts)
}

/** POST-запрос. Объект body сериализуется в JSON. */
export async function httpPost(
  url: string,
  body: unknown,
  opts: HttpOptions = {},
): AsyncResult<HttpResponse> {
  return request(url, buildInit('POST', body, opts), opts)
}

/**
 * Обернуть стрим idle-watchdog: таймер сбрасывается каждым чанком; простой
 * дольше ms → cancel исходного стрима + error. Без него зависший сервер,
 * держащий соединение, вешает потребителя навечно (timeout действует только
 * до заголовков — httpPostStream снимает его done() перед выдачей стрима).
 */
function withIdleTimeout(
  stream: ReadableStream<Uint8Array>,
  ms: number,
  url: string,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Stream idle timeout after ${ms}ms: ${url}`)),
          ms,
        )
      })
      try {
        const { done, value } = await Promise.race([reader.read(), idle])
        if (done) controller.close()
        else controller.enqueue(value)
      } catch (e) {
        reader.cancel().catch(() => {})
        controller.error(e)
      } finally {
        clearTimeout(timer)
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

/**
 * POST со стримом ответа — для SSE/стриминга. Возвращает raw ReadableStream,
 * потребитель парсит сам. Статус >= 400 трактуется как err.
 * Стрим защищён idle-watchdog (opts.idleTimeout, default 300000, 0 = выключить).
 */
export async function httpPostStream(
  url: string,
  body: unknown,
  opts: HttpOptions = {},
): AsyncResult<ReadableStream<Uint8Array>> {
  const init = buildInit('POST', body, opts)
  if (!init.ok) return init
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT
  const res = await requestWithRetry(url, init.value, opts)
  if (!res.ok) return res
  const { res: response } = res.value
  if (response.status >= 400) {
    const text = await readText(res.value, timeout, url)
    return err(new Error(`HTTP ${response.status}: ${text.ok ? text.value : `<body unreadable: ${text.error.message}>`}`))
  }
  // Заголовки получены, дальше стрим: общий таймаут снимаем, стрим под idle-watchdog.
  res.value.done()
  if (!response.body) {
    return err(new Error('Response has no body stream'))
  }
  const idle = opts.idleTimeout ?? DEFAULT_STREAM_IDLE
  return ok(idle > 0 ? withIdleTimeout(response.body, idle, url) : response.body)
}
