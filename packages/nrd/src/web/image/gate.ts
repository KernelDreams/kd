/**
 * llm-gate как провайдер медиа (gate-media-spec §7): `MediaProvider` поверх
 * задач гейта — ключи BFL/Google/Vertex/nano-gpt живут на гейте, клиент знает
 * только адрес и ключ гейта, а модель — алиас гейта (`flux-pro`) либо
 * `провайдер/модель`, если ключу открыт провайдер.
 *
 * Протокол: `POST /v1/media` → `202 {id}` → опрос `GET /v1/media/{id}`
 * (`progress` → `onProgress`) → `done` → файлы `GET /v1/media/{id}/files/{n}`.
 * `signal` прекращает только ожидание: задача на гейте доводится и остаётся в
 * его галерее. Пакетного режима у гейта нет — `generateBatch` не реализован.
 */

import {
  imageError,
  type AsyncResult,
  type ImageErrorName,
  type ImageModelInfo,
  type ImageModelSchema,
  type ImageProgress,
  type ImageProvider,
  type ImageRequest,
  type ImageResult,
} from '../../contracts/index.js'
import { ok, err } from '../../infra/result.js'
import { sniffMediaMime, toBase64 } from './bytes.js'
import { Deadline, sleep } from './common.js'
import { progressEmitter } from './progress.js'

export interface GateMediaOptions {
  /** Адрес гейта: `https://llm.example.com` (с `/v1` или без). */
  baseUrl: string
  apiKey?: string
  /** Интервал опроса задачи, мс. Дефолт 2000. */
  poll?: number
  /** Общий потолок ожидания задачи, мс. Дефолт 3 600 000 — видео идут минутами. */
  timeout?: number
}

const DEFAULT_POLL = 2000
const DEFAULT_TIMEOUT = 3_600_000

type Json = Record<string, any>

/** Задача гейта (`GET /v1/media/{id}`), поля, которые читает клиент. */
interface GateJob {
  id: string
  status: 'queued' | 'running' | 'done' | 'failed'
  progress?: Partial<ImageProgress>
  files?: Array<{ n: number; mime?: string; url: string }>
  meta?: Json
  error?: { message?: string; status?: number; name?: string }
}

const ERROR_NAMES = new Set<ImageErrorName>(['AuthError', 'RateLimitError', 'ModerationError', 'ImageError'])

/** Имя ошибки по статусу: 401/403 — доступ, 429 — лимит; имя от провайдера гейта сильнее. */
function errorName(status: number | undefined, name: string | undefined): ImageErrorName {
  if (name && ERROR_NAMES.has(name as ImageErrorName)) return name as ImageErrorName
  if (status === 401 || status === 403) return 'AuthError'
  if (status === 429) return 'RateLimitError'
  return 'ImageError'
}

function failure(message: string, status?: number, name?: string, body?: string): Error {
  const e = imageError(errorName(status, name), message, body) as Error & { status?: number }
  if (status !== undefined) e.status = status
  return e
}

/** `https://h/v1/` → `https://h`: пути гейта начинаются с `/v1`. */
export function gateRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
}

export function gateMediaProvider(opts: GateMediaOptions): ImageProvider {
  const root = gateRoot(opts.baseUrl)
  const poll = opts.poll ?? DEFAULT_POLL
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT
  const auth: Record<string, string> = opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}

  async function call(path: string, init: RequestInit & { signal: AbortSignal }): Promise<Response> {
    return fetch(root + path, { ...init, headers: { ...auth, ...(init.headers as Record<string, string> | undefined) } })
  }

  /** Ответ не 2xx → ошибка с текстом гейта (`{error: {message}}`) и его статусом. */
  async function fail(res: Response, what: string): Promise<Error> {
    const body = await res.text().catch(() => '')
    let message = body.slice(0, 300)
    try {
      message = (JSON.parse(body) as Json).error?.message ?? message
    } catch {
      /* не JSON — как есть */
    }
    return failure(`gate: ${what} → ${res.status}${message ? `: ${message}` : ''}`, res.status, undefined, body)
  }

  async function generate(req: ImageRequest): AsyncResult<ImageResult> {
    const emit = progressEmitter(req.onProgress, 'gate')
    const deadline = new Deadline(timeout, req.signal)
    try {
      const body: Json = { model: req.model }
      if (req.prompt !== undefined) body.prompt = req.prompt
      if (req.refs?.length) body.refs = req.refs.map(toBase64)
      if (req.subjects?.length) body.subjects = req.subjects.map(toBase64)
      if (req.params && Object.keys(req.params).length) body.params = req.params
      const created = await call('/v1/media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: deadline.signal,
      })
      if (!created.ok) return err(await fail(created, `POST /v1/media (${req.model})`))
      const { id } = (await created.json()) as { id: string }
      emit({ stage: 'queued' })

      let job: GateJob
      for (;;) {
        const res = await call(`/v1/media/${encodeURIComponent(id)}`, { signal: deadline.signal })
        if (!res.ok) return err(await fail(res, `GET /v1/media/${id}`))
        job = (await res.json()) as GateJob
        if (job.status === 'done' || job.status === 'failed') break
        const p = job.progress
        emit({ stage: job.status === 'running' ? 'running' : 'queued', ...(p?.status ? { status: p.status } : {}), ...(p?.step !== undefined ? { step: p.step } : {}), ...(p?.total !== undefined ? { total: p.total } : {}) })
        await sleep(poll, deadline.signal)
      }
      if (job.status === 'failed') {
        const e = job.error ?? {}
        return err(failure(`gate: задача ${id} (${req.model}) — ${e.message ?? 'failed'}`, e.status, e.name))
      }

      emit({ stage: 'downloading' })
      const images: Uint8Array[] = []
      for (const f of job.files ?? []) {
        const res = await call(f.url.startsWith('/') ? f.url : `/v1/media/${encodeURIComponent(id)}/files/${f.n}`, { signal: deadline.signal })
        if (!res.ok) return err(await fail(res, `файл ${f.n} задачи ${id}`))
        images.push(new Uint8Array(await res.arrayBuffer()))
      }
      if (!images.length) return err(failure(`gate: задача ${id} (${req.model}) — готова, но без файлов`))
      emit({ stage: 'done' })
      const meta = { model: req.model, ...(job.meta ?? {}), gate: { id } }
      return ok({ images, mime: job.files?.[0]?.mime ?? sniffMediaMime(images[0]), meta })
    } catch (e) {
      if (req.signal?.aborted) return err(failure('gate: ожидание прервано (задача на гейте продолжается)'))
      if (deadline.signal.aborted) return err(failure(`gate: задача не готова за ${Math.round(timeout / 1000)} с (продолжается на гейте)`))
      return err(failure(`gate: ${e instanceof Error ? e.message : String(e)}`))
    } finally {
      deadline.dispose()
    }
  }

  async function models(): AsyncResult<ImageModelInfo[]> {
    const deadline = new Deadline(30_000)
    try {
      const res = await call('/v1/media/models', { signal: deadline.signal })
      if (!res.ok) return err(await fail(res, 'GET /v1/media/models'))
      const data = ((await res.json()) as { data?: Json[] }).data ?? []
      return ok(data.map((m) => {
        const info: ImageModelInfo = { id: String(m.id) }
        if (m.name) info.name = String(m.name)
        if (m.output === 'image' || m.output === 'video' || m.output === 'audio') info.kind = m.output
        for (const k of ['refRole', 'maxRefs', 'maxSubjects', 'edit', 'price'] as const) {
          if (m[k] !== undefined && m[k] !== null) (info as Json)[k] = m[k]
        }
        return info
      }))
    } catch (e) {
      return err(failure(`gate: GET /v1/media/models — ${e instanceof Error ? e.message : String(e)}`))
    } finally {
      deadline.dispose()
    }
  }

  async function schema(model: string): AsyncResult<ImageModelSchema | undefined> {
    const deadline = new Deadline(30_000)
    try {
      const res = await call(`/v1/media/schema?model=${encodeURIComponent(model)}`, { signal: deadline.signal })
      if (res.status === 204) return ok(undefined)
      if (!res.ok) return err(await fail(res, `GET /v1/media/schema (${model})`))
      const sc = (await res.json()) as ImageModelSchema | null
      return ok(sc ?? undefined)
    } catch (e) {
      return err(failure(`gate: GET /v1/media/schema — ${e instanceof Error ? e.message : String(e)}`))
    } finally {
      deadline.dispose()
    }
  }

  return { generate, models, schema }
}
