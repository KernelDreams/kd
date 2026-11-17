/**
 * Google — провайдер медиа поверх fetch (media-gen-spec §2): картинки Gemini
 * (`gemini-*-image`, `gemini-nano-banana-*`), видео Veo (`veo-*`), музыка Lyria 3
 * (`lyria-3*`). Два доступа одним кодом: AI Studio (`googleMediaProvider`, ключ)
 * и Vertex AI (`vertexMediaProvider`, токен ADC инъекцией — ступень web без node).
 *
 * Список моделей — из API, не хардкодом: AI Studio — `GET models`, Vertex —
 * `publishers/google/models` (там только Gemini) плюс проба кандидатов Veo/Lyria
 * (`GET publishers/google/models/{id}` — бесплатно). Параметры модели API не
 * отдаёт — схема по семейству (поля из документации Google, 10.2026).
 *
 * Протоколы: картинки и Lyria — синхронный `:generateContent` (байты в
 * `inlineData`); Veo — `:predictLongRunning` → операция → опрос (AI Studio —
 * `GET {name}`, Vertex — `:fetchPredictOperation`) → ролик (AI Studio — `uri`
 * со скачиванием по ключу, Vertex — `bytesBase64Encoded`). Цены Google в ответе
 * не отдаёт: `meta.cost` — токены (картинки, Lyria) или секунды ролика (Veo).
 */

import {
  imageError,
  type AsyncResult,
  type ImageBatchOptions,
  type Result,
  type ImageModelField,
  type ImageModelInfo,
  type ImageModelSchema,
  type ImageProvider,
  type ImageRequest,
  type ImageResult,
  type MediaKind,
} from '../../contracts/index.js'
import { ok, err } from '../../infra/result.js'
import { fromBase64, sniffImageMime, sniffMediaMime, toBase64 } from './bytes.js'
import { coerce, describeField, Deadline, sleep } from './common.js'
import { progressEmitter, type ProgressEmit } from './progress.js'

export interface GoogleMediaOptions {
  /** Ключ AI Studio (Gemini API). */
  apiKey: string
  /** Таймаут пакетного прогона (`generateBatch`), мс. Дефолт — сутки. */
  batchTimeout?: number
  /** Интервал опроса пакета, мс. Дефолт 30 000. */
  batchPollInterval?: number
  /** Дефолт `https://generativelanguage.googleapis.com/v1beta`. */
  baseUrl?: string
  /** Общий таймаут генерации, мс. Дефолт 900 000 (Veo — минуты). */
  timeout?: number
  /** Интервал опроса операции Veo, мс. Дефолт 10 000. */
  pollInterval?: number
  /** База паузы ретрая 429/503: пауза = retryDelay·k, k = 1…6. Дефолт 5000. */
  retryDelay?: number
}

export interface VertexMediaOptions {
  project: string
  /** Регион Gemini-моделей; дефолт `global`. */
  location?: string
  /** Регион Veo (в `global` его нет; Lyria 3 — наоборот, только `global`); дефолт — `location`, а при `global` — `us-central1`. */
  mediaLocation?: string
  /** Bearer-токен (ADC: `gcloud auth application-default print-access-token`); кэш — здесь, 45 мин. */
  token: () => Promise<string>
  /** Хост вместо `https://[{регион}-]aiplatform.googleapis.com` (тесты, прокси). */
  baseUrl?: string
  /** Кандидаты Veo/Lyria для `models()` поверх списка Gemini; дефолт — `VERTEX_MEDIA_CANDIDATES`. */
  candidates?: string[]
  timeout?: number
  pollInterval?: number
  retryDelay?: number
}

const DEFAULT_TIMEOUT = 900_000
/** Пакет Gemini: цель Google — до 24 ч, через 48 ч — EXPIRED. Ждём сутки. */
const DEFAULT_BATCH_TIMEOUT = 24 * 3600_000
const DEFAULT_BATCH_POLL = 30_000
/** Инлайн-пакет — до 20 МБ на весь запрос (документация Batch API). */
const MAX_BATCH_BYTES = 19 * 1024 * 1024
const DEFAULT_POLL = 10_000
const DEFAULT_RETRY_DELAY = 5000
const MAX_RETRIES = 6
const TOKEN_TTL = 45 * 60_000

/**
 * Veo/Lyria, которые Vertex не отдаёт списком: `models()` пробует каждый
 * (`GET publishers/google/models/{id}`) и показывает только живые.
 */
export const VERTEX_MEDIA_CANDIDATES = [
  'veo-3.1-generate-001',
  'veo-3.1-fast-generate-001',
  'veo-3.1-lite-generate-001',
  'veo-3.1-generate-preview',
  'veo-3.1-fast-generate-preview',
  'veo-3.1-lite-generate-preview',
  'lyria-3.5',
  'lyria-3-pro-preview',
  'lyria-3-clip-preview',
]

type Json = Record<string, unknown>

// ==================== Семейства моделей ====================

type Family = 'image' | 'veo' | 'lyria'

export function familyOf(id: string): Family | undefined {
  if (/^gemini-.*image/.test(id) || /^gemini-nano-banana/.test(id)) return 'image'
  if (/^veo-\d/.test(id)) return 'veo'
  if (/^lyria-3/.test(id)) return 'lyria'
  return undefined
}

const KIND: Record<Family, MediaKind> = { image: 'image', veo: 'video', lyria: 'audio' }

const enumField = (values: string[]): ImageModelField => ({ type: 'string', enum: values })

const IMAGE_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']

/**
 * Поле схемы → куда класть в тело. `gen.x` — `generationConfig.x`, `img.x` —
 * `generationConfig.imageConfig.x`, `think.x` — `generationConfig.thinkingConfig.x`,
 * `param.x` — `parameters.x` (Veo).
 */
interface Entry {
  family: Family
  /** Доступ Vertex (у него свои ограничения полей). */
  vertex: boolean
  schema: ImageModelSchema
  /** Поле схемы → путь в теле запроса. */
  map: Record<string, string>
}

/**
 * Схема модели по семейству (поля — из документации Google на 10.2026). `vertex` — доступ
 * Vertex: Lyria там не берёт `seed`/`temperature` (400 «invalid argument», живьём 10.10).
 */
export function entryOf(id: string, vertex = false): Entry | undefined {
  const family = familyOf(id)
  if (!family) return undefined
  const fields: Record<string, ImageModelField> = { prompt: { type: 'string' } }
  const map: Record<string, string> = {}
  const schema: ImageModelSchema = { fields, kind: KIND[family] }

  if (family === 'image') {
    const flash31 = /^gemini-3\.1-flash-image/.test(id) || /^gemini-nano-banana/.test(id)
    const lite = /flash-lite-image/.test(id)
    const legacy = /^gemini-2/.test(id)
    fields.aspect_ratio = enumField(flash31 ? [...IMAGE_RATIOS, '1:4', '4:1', '1:8', '8:1'] : IMAGE_RATIOS)
    map.aspect_ratio = 'img.aspectRatio'
    if (!legacy) {
      fields.image_size = enumField(lite ? ['1K'] : flash31 && !/nano-banana/.test(id) ? ['512', '1K', '2K', '4K'] : ['1K', '2K', '4K'])
      map.image_size = 'img.imageSize'
    }
    if (flash31 || lite) {
      fields.thinking_level = enumField(/nano-banana/.test(id) ? ['minimal', 'medium', 'high'] : ['minimal', 'high'])
      map.thinking_level = 'think.thinkingLevel'
    }
    fields.seed = { type: 'integer' }
    map.seed = 'gen.seed'
    fields.temperature = { type: 'number', min: 0, max: 2 }
    map.temperature = 'gen.temperature'
    // Рефы: 3.x — до 14 (объекты + персонажи + стиль), 2.5 — лучше всего до 3.
    schema.maxRefs = legacy ? 3 : 14
    schema.refRole = 'reference'
  } else if (family === 'veo') {
    const lite = /-lite-/.test(id)
    fields.aspect_ratio = enumField(['16:9', '9:16'])
    map.aspect_ratio = 'param.aspectRatio'
    fields.duration = { type: 'integer', enum: [4, 6, 8] }
    map.duration = 'param.durationSeconds'
    fields.resolution = enumField(lite ? ['720p', '1080p'] : ['720p', '1080p', '4k'])
    map.resolution = 'param.resolution'
    fields.negative_prompt = { type: 'string' }
    map.negative_prompt = 'param.negativePrompt'
    fields.person_generation = enumField(['allow_all', 'allow_adult', 'dont_allow'])
    map.person_generation = 'param.personGeneration'
    fields.seed = { type: 'integer' }
    map.seed = 'param.seed'
    // Кадры: первый (`image`) и последний (`lastFrame`).
    schema.maxRefs = 2
    schema.refRole = 'frames'
    // Персонаж/объект — `referenceImages` (asset), до 3, ролик только 8 с; у lite нет.
    if (!lite && /^veo-3\.1/.test(id)) schema.maxSubjects = 3
  } else {
    if (!vertex) {
      fields.temperature = { type: 'number', min: 0, max: 2 }
      map.temperature = 'gen.temperature'
      fields.seed = { type: 'integer' }
      map.seed = 'gen.seed'
    }
    // Lyria 3 принимает до 10 картинок как вдохновение (документация Gemini API).
    schema.maxRefs = 10
    schema.refRole = 'reference'
  }
  return { family, vertex, schema, map }
}

/** Модель списка API → инфо; не медиа — undefined. */
function infoOf(id: string, name?: string, vertex = false): ImageModelInfo | undefined {
  const e = entryOf(id, vertex)
  if (!e) return undefined
  const info: ImageModelInfo = { id, kind: e.schema.kind }
  if (name) info.name = name
  if (e.schema.refRole) info.refRole = e.schema.refRole
  if (e.schema.maxRefs) {
    info.maxRefs = e.schema.maxRefs
    info.edit = e.family === 'image'
  }
  if (e.schema.maxSubjects) info.maxSubjects = e.schema.maxSubjects
  // Пакетный режим (Gemini Batch API) — только AI Studio и только generateContent-семейства.
  if (!vertex && e.family !== 'veo') info.batch = true
  return info
}

// ==================== Транспорт ====================

interface Transport {
  who: string
  /** Доступ Vertex — схема по `entryOf(id, true)`. */
  vertex: boolean
  /** URL метода модели: `generateContent` | `predictLongRunning`. */
  url(model: string, family: Family, method: string): string
  headers(): Promise<Record<string, string>>
  /** Опрос операции Veo: вернуть свежий объект операции. */
  pollOp(model: string, family: Family, name: string, signal: AbortSignal): Promise<Response>
  /** Ролики из `response` готовой операции. */
  videos(response: Json, signal: AbortSignal, emit: ProgressEmit): Promise<Uint8Array[]>
  list(): Promise<ImageModelInfo[]>
  /** Пакетный режим (Gemini Batch API) — только AI Studio. */
  batch?: BatchTransport
}

interface BatchTransport {
  /** URL создания: `models/{model}:batchGenerateContent`. */
  createUrl(model: string): string
  /** URL пакета: `batches/{id}`. */
  url(name: string): string
  /** Скачать файл ответов (`responsesFile`), если Google отдал файлом. */
  fileUrl(file: string): string
}

function errorOf(status: number, text: string, who: string, what: string): Error {
  if (status === 401 || status === 403) return imageError('AuthError', `${who} ${what}: ${status} — доступ не принят: ${short(text)}`, text)
  if (MODERATION_RE.test(text) && status === 400) {
    return imageError('ModerationError', `${who} ${what}: ${short(text)}`, text)
  }
  return imageError('ImageError', `${who} ${what}: ${status} ${short(text)}`, text)
}

/** Отказ модерации в тексте ошибки: в т.ч. Veo «input image violates usage guidelines» (живьём 10.10). */
const MODERATION_RE = /SAFETY|PROHIBITED|BLOCKLIST|RAI|responsible AI|usage guidelines|violates? .*polic/i

function short(text: string): string {
  try {
    const m = ((JSON.parse(text) as Json).error as Json | undefined)?.message
    if (typeof m === 'string') return m.slice(0, 500)
  } catch {
    // не JSON
  }
  return text.slice(0, 500)
}

async function fetchRetry(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  retryDelay: number,
  who: string,
  what: string,
): Promise<Json> {
  for (let attempt = 0; ; attempt++) {
    const res = await globalThis.fetch(url, { ...init, signal })
    const text = await res.text()
    if (res.status === 429 || res.status === 503) {
      if (attempt >= MAX_RETRIES) {
        throw res.status === 429
          ? imageError('RateLimitError', `${who} ${what}: 429 после ${MAX_RETRIES} ретраев — ${short(text)}`, text)
          : imageError('ImageError', `${who} ${what}: 503 после ${MAX_RETRIES} ретраев — ${short(text)}`, text)
      }
      await sleep(retryDelay * (attempt + 1), signal)
      continue
    }
    if (!res.ok) throw errorOf(res.status, text, who, what)
    try {
      return JSON.parse(text) as Json
    } catch {
      throw imageError('ImageError', `${who} ${what}: ответ не JSON`, text)
    }
  }
}

// ==================== Тело запроса ====================

function setPath(body: Json, path: string, value: unknown): void {
  const [scope, key] = path.split('.') as [string, string]
  const gen = (body.generationConfig ??= {}) as Json
  if (scope === 'gen') gen[key] = value
  else if (scope === 'img') ((gen.imageConfig ??= {}) as Json)[key] = value
  else if (scope === 'think') ((gen.thinkingConfig ??= {}) as Json)[key] = value
  else if (scope === 'param') ((body.parameters ??= {}) as Json)[key] = value
}

/** Параметры запроса → тело по карте семейства; проверка до сети. */
function applyParams(req: ImageRequest, e: Entry, body: Json): string | undefined {
  const { fields } = e.schema
  const fieldList = () => Object.entries(fields).map(([k, f]) => describeField(k, f)).join(', ')
  for (const [k, v] of Object.entries(req.params ?? {})) {
    if (v === undefined || v === null || v === '') continue
    if (k === 'prompt') {
      if (req.prompt !== undefined) return 'prompt задан и аргументом, и в params'
      continue
    }
    const f = fields[k]
    const path = e.map[k]
    if (!f || !path) return `параметр "${k}" — нет у модели ${req.model}; поля: ${fieldList()}`
    const c = coerce(k, v, f)
    if (typeof c === 'string') return c
    setPath(body, path, c.value)
  }
  const refs = req.refs ?? []
  const max = e.schema.maxRefs ?? 0
  if (refs.length > max) return `модель ${req.model} принимает до ${max} реф., передано ${refs.length}`
  const subj = req.subjects?.length ?? 0
  if (subj > (e.schema.maxSubjects ?? 0)) {
    return e.schema.maxSubjects ? `модель ${req.model} принимает до ${e.schema.maxSubjects} реф. персонажа, передано ${subj}` : `модель ${req.model} рефы персонажа не принимает`
  }
  return undefined
}

const promptOf = (req: ImageRequest): string | undefined =>
  req.prompt ?? (typeof req.params?.prompt === 'string' ? (req.params.prompt as string) : undefined)

function contentBody(req: ImageRequest, e: Entry): { body: Json } | string {
  const parts: Json[] = []
  for (const r of req.refs ?? []) parts.push({ inlineData: { mimeType: sniffImageMime(r), data: toBase64(r) } })
  const prompt = promptOf(req)
  if (prompt) parts.push({ text: prompt })
  if (!parts.length) return `модель ${req.model}: нужен промпт`
  const body: Json = { contents: [{ role: 'user', parts }] }
  const bad = applyParams(req, e, body)
  if (bad) return bad
  const gen = (body.generationConfig ??= {}) as Json
  gen.responseModalities = e.family === 'image' ? ['TEXT', 'IMAGE'] : ['AUDIO', 'TEXT']
  return { body }
}

/**
 * Кадр Veo — `{bytesBase64Encoded, mimeType}` у обоих доступов: `inlineData` из
 * документации AI Studio модель отвергает («inlineData isn't supported», живьём 10.10).
 */
const veoImage = (bytes: Uint8Array): Json => ({ bytesBase64Encoded: toBase64(bytes), mimeType: sniffImageMime(bytes) })

function veoBody(req: ImageRequest, e: Entry): { body: Json; seconds: number } | string {
  const instance: Json = {}
  const prompt = promptOf(req)
  if (prompt) instance.prompt = prompt
  const refs = req.refs ?? []
  if (refs[0]) instance.image = veoImage(refs[0])
  if (refs[1]) instance.lastFrame = veoImage(refs[1])
  const subjects = req.subjects ?? []
  if (subjects.length) instance.referenceImages = subjects.map((b) => ({ image: veoImage(b), referenceType: 'asset' }))
  if (!prompt && !refs.length && !subjects.length) return `модель ${req.model}: нужен промпт или первый кадр`
  const body: Json = { instances: [instance] }
  const bad = applyParams(req, e, body)
  if (bad) return bad
  delete body.generationConfig
  const params = (body.parameters ??= {}) as Json
  if (subjects.length) {
    // С персонажем Veo делает только 8 с (документация Gemini API / Vertex, 10.2026).
    if (params.durationSeconds !== undefined && params.durationSeconds !== 8) return `с персонажем ролик только 8 с, задано ${String(params.durationSeconds)}`
    params.durationSeconds = 8
  }
  // Дефолт allow_adult: с кадром/персонажем allow_all API отвергает, а без значения
  // Veo отказывает на кадрах с людьми. AI Studio text-to-video allow_adult не берёт («not
  // supported», живьём 10.10) — там без поля; Vertex принимает allow_adult всегда (его дефолт).
  if (params.personGeneration === undefined && (refs.length || subjects.length || e.vertex)) params.personGeneration = 'allow_adult'
  const seconds = typeof params.durationSeconds === 'number' ? params.durationSeconds : 8
  return { body, seconds }
}

// ==================== Ответы ====================

const BLOCK_FINISH = new Set(['SAFETY', 'IMAGE_SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION'])

function contentResult(json: Json, req: ImageRequest, e: Entry, who: string): ImageResult {
  const fb = json.promptFeedback as Json | undefined
  if (fb?.blockReason) {
    throw imageError('ModerationError', `${who} ${req.model}: промпт заблокирован — ${String(fb.blockReason)}`, JSON.stringify(json).slice(0, 2000))
  }
  const cand = (Array.isArray(json.candidates) ? json.candidates[0] : undefined) as Json | undefined
  const parts = (((cand?.content as Json | undefined)?.parts ?? []) as Json[]).filter((p) => !p.thought)
  const files: Uint8Array[] = []
  let mime = ''
  const text: string[] = []
  for (const p of parts) {
    const d = (p.inlineData ?? p.inline_data) as Json | undefined
    if (d && typeof d.data === 'string') {
      const bytes = fromBase64(d.data)
      files.push(bytes)
      mime ||= sniffMediaMime(bytes) !== 'application/octet-stream' ? sniffMediaMime(bytes) : String(d.mimeType ?? d.mime_type ?? '')
    } else if (typeof p.text === 'string') text.push(p.text)
  }
  const finish = typeof cand?.finishReason === 'string' ? cand.finishReason : undefined
  if (!files.length) {
    const why = finish && finish !== 'STOP' ? ` (finishReason ${finish})` : ''
    const said = text.join('').trim()
    const msg = `${who} ${req.model}: в ответе нет ${e.family === 'image' ? 'картинки' : 'звука'}${why}${said ? ` — модель ответила: ${said.slice(0, 300)}` : ''}`
    throw imageError(finish && BLOCK_FINISH.has(finish) ? 'ModerationError' : 'ImageError', msg, JSON.stringify(json).slice(0, 2000))
  }
  const meta: ImageResult['meta'] = { model: req.model }
  const usage = json.usageMetadata as Json | undefined
  if (usage) {
    if (typeof usage.totalTokenCount === 'number') {
      meta.cost = usage.totalTokenCount
      meta.cost_unit = 'tokens'
    }
    meta.usage = usage
  }
  if (typeof json.responseId === 'string') meta.id = json.responseId
  if (typeof (req.params?.seed) === 'number') meta.seed = req.params.seed as number
  if (text.length) meta.text = text.join('').trim()
  if (finish) meta.finish_reason = finish
  return { images: files, mime: mime || 'application/octet-stream', meta }
}

// ==================== Провайдер ====================

interface CoreOptions {
  timeout?: number
  pollInterval?: number
  retryDelay?: number
  /** Таймаут пакета, мс (дефолт — сутки). */
  batchTimeout?: number
  /** Интервал опроса пакета, мс (дефолт 30 000). */
  batchPollInterval?: number
}

function mediaProvider(t: Transport, o: CoreOptions): ImageProvider {
  const opts = o
  const timeout = o.timeout ?? DEFAULT_TIMEOUT
  const pollInterval = o.pollInterval ?? DEFAULT_POLL
  const retryDelay = o.retryDelay ?? DEFAULT_RETRY_DELAY
  const who = t.who

  let listPromise: Promise<ImageModelInfo[]> | undefined
  const list = (): Promise<ImageModelInfo[]> => {
    listPromise ??= t.list()
    listPromise.catch(() => (listPromise = undefined))
    return listPromise
  }

  async function post(url: string, body: Json, signal: AbortSignal, what: string): Promise<Json> {
    return fetchRetry(
      url,
      { method: 'POST', headers: { ...(await t.headers()), 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) },
      signal,
      retryDelay,
      who,
      what,
    )
  }

  async function runVeo(req: ImageRequest, e: Entry, signal: AbortSignal, emit: ProgressEmit, seen: { id?: string; status?: string }): Promise<ImageResult> {
    const built = veoBody(req, e)
    if (typeof built === 'string') throw imageError('ImageError', `${who} ${req.model}: ${built}`)
    let op = await post(t.url(req.model, 'veo', 'predictLongRunning'), built.body, signal, `${req.model}:predictLongRunning`)
    const name = typeof op.name === 'string' ? op.name : ''
    if (!name) throw imageError('ImageError', `${who} ${req.model}: в ответе нет операции`, JSON.stringify(op))
    seen.id = name
    emit({ stage: 'queued' })
    while (!op.done) {
      await sleep(pollInterval, signal)
      const res = await t.pollOp(req.model, 'veo', name, signal)
      const text = await res.text()
      if (res.status === 429 || res.status >= 500) continue
      if (!res.ok) throw errorOf(res.status, text, who, 'опрос операции')
      try {
        op = JSON.parse(text) as Json
      } catch {
        throw imageError('ImageError', `${who}: опрос операции — ответ не JSON`, text)
      }
      const pct = (op.metadata as Json | undefined)?.progressPercent
      seen.status = typeof pct === 'number' ? `${pct}%` : 'running'
      emit({ stage: 'running', status: seen.status })
    }
    if (op.error) {
      const e2 = op.error as Json
      const msg = String(e2.message ?? JSON.stringify(e2))
      throw imageError(/safety|responsible|RAI|blocked|filtered/i.test(msg) || MODERATION_RE.test(msg) ? 'ModerationError' : 'ImageError', `${who} ${req.model}: ${msg}`, JSON.stringify(op).slice(0, 2000))
    }
    const response = (op.response ?? {}) as Json
    const inner = (response.generateVideoResponse ?? response) as Json
    const filtered = Number(inner.raiMediaFilteredCount ?? 0)
    emit({ stage: 'downloading' })
    const files = await t.videos(response, signal, emit)
    if (!files.length) {
      const reasons = Array.isArray(inner.raiMediaFilteredReasons) ? (inner.raiMediaFilteredReasons as unknown[]).join('; ') : ''
      throw imageError(filtered ? 'ModerationError' : 'ImageError', `${who} ${req.model}: ролика нет${filtered ? ` — отфильтровано (${reasons || filtered})` : ''}`, JSON.stringify(op).slice(0, 2000))
    }
    const meta: ImageResult['meta'] = { model: req.model, id: name, cost: built.seconds, cost_unit: 'seconds' }
    const seed = (built.body.parameters as Json | undefined)?.seed
    if (typeof seed === 'number') meta.seed = seed
    return { images: files, mime: sniffMediaMime(files[0]), meta }
  }

  /**
   * Пакет Gemini: все запросы — одним `batchGenerateContent` инлайн, опрос
   * `batches/{id}` до `BATCH_STATE_SUCCEEDED`, ответы — по `metadata.key` (индекс запроса).
   */
  async function runBatch(reqs: ImageRequest[], o: ImageBatchOptions & CoreOptions): Promise<Result<ImageResult>[]> {
    const b = t.batch!
    const emit = progressEmitter(o.onProgress, who)
    const dl = new Deadline(o.batchTimeout ?? DEFAULT_BATCH_TIMEOUT, o.signal)
    let name = ''
    try {
      const model = reqs[0]?.model
      if (!model) throw imageError('ImageError', `${who}: пакет пуст`)
      if (reqs.some((r) => r.model !== model)) throw imageError('ImageError', `${who}: в пакете — одна модель (${model})`)
      const e = entryOf(model, t.vertex)
      if (!e || e.family === 'veo') throw imageError('ImageError', `${who} ${model}: пакетом — только Gemini image и Lyria`)
      const requests: Json[] = []
      let bytes = 0
      for (const [i, r] of reqs.entries()) {
        const built = contentBody(r, e)
        if (typeof built === 'string') throw imageError('ImageError', `${who} ${model}: запрос ${i + 1}: ${built}`)
        bytes += (r.refs ?? []).reduce((a, x) => a + x.length * 1.34, 0) + (r.prompt?.length ?? 0)
        requests.push({ request: built.body, metadata: { key: String(i) } })
      }
      if (bytes > MAX_BATCH_BYTES) throw imageError('ImageError', `${who} ${model}: пакет больше 20 МБ (рефы) — раздели на меньшие`)
      const display = o.name ?? `nrd-${model}-${Date.now()}`
      const op = await post(b.createUrl(model), { batch: { displayName: display, inputConfig: { requests: { requests } } } }, dl.signal, `${model}:batchGenerateContent`)
      name = typeof op.name === 'string' ? op.name : ''
      if (!name) throw imageError('ImageError', `${who} ${model}: в ответе нет пакета`, JSON.stringify(op).slice(0, 2000))
      emit({ stage: 'queued', status: name })
      let cur = op
      for (;;) {
        const state = String((cur.metadata as Json | undefined)?.state ?? '')
        if (cur.done || /SUCCEEDED|FAILED|CANCELLED|EXPIRED/.test(state)) break
        await sleep(o.batchPollInterval ?? DEFAULT_BATCH_POLL, dl.signal)
        const res = await globalThis.fetch(b.url(name), { headers: await t.headers(), signal: dl.signal })
        const text = await res.text()
        if (res.status === 429 || res.status >= 500) continue
        if (!res.ok) throw errorOf(res.status, text, who, `пакет ${name}`)
        cur = JSON.parse(text) as Json
        const st = String((cur.metadata as Json | undefined)?.state ?? 'running').replace(/^BATCH_STATE_/, '').toLowerCase()
        const stats = (cur.metadata as Json | undefined)?.batchStats as Json | undefined
        emit({ stage: 'running', status: stats ? `${st} ${Number(stats.successfulRequestCount ?? 0)}/${Number(stats.requestCount ?? reqs.length)}` : st })
      }
      const state = String((cur.metadata as Json | undefined)?.state ?? '')
      if (cur.error || (state && !/SUCCEEDED/.test(state))) {
        const msg = String(((cur.error as Json | undefined)?.message as string | undefined) ?? state)
        throw imageError('ImageError', `${who} ${model}: пакет ${name} — ${msg}`, JSON.stringify(cur).slice(0, 2000))
      }
      emit({ stage: 'downloading' })
      const response = (cur.response ?? {}) as Json
      let items = ((response.inlinedResponses as Json | undefined)?.inlinedResponses ?? []) as Json[]
      if (!items.length && typeof response.responsesFile === 'string') {
        const res = await globalThis.fetch(b.fileUrl(response.responsesFile), { headers: await t.headers(), signal: dl.signal })
        const text = await res.text()
        if (!res.ok) throw errorOf(res.status, text, who, `ответы пакета ${name}`)
        items = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Json)
      }
      const out: Result<ImageResult>[] = reqs.map(() => err(imageError('ImageError', `${who} ${model}: пакет ${name} — ответа на запрос нет`)))
      for (const [j, it] of items.entries()) {
        const key = Number((it.metadata as Json | undefined)?.key ?? (it as Json).key ?? j)
        if (!Number.isInteger(key) || key < 0 || key >= reqs.length) continue
        if (it.error) {
          const er = it.error as Json
          out[key] = err(imageError('ImageError', `${who} ${model}: ${String(er.message ?? JSON.stringify(er))}`, JSON.stringify(er)))
          continue
        }
        try {
          const r = contentResult((it.response ?? {}) as Json, reqs[key], e, who)
          r.meta.batch = name
          out[key] = ok(r)
        } catch (x) {
          out[key] = err(x instanceof Error ? x : new Error(String(x)))
        }
      }
      emit({ stage: 'done' })
      return out
    } catch (x) {
      if (dl.signal.aborted && name) {
        // Отмена/таймаут: пакет у Google тоже гасим, чтобы не списал.
        void globalThis.fetch(`${b.url(name)}:cancel`, { method: 'POST', headers: await t.headers() }).catch(() => {})
      }
      throw x
    } finally {
      dl.dispose()
    }
  }

  return {
    ...(t.batch
      ? {
          async generateBatch(reqs: ImageRequest[], o: ImageBatchOptions = {}): AsyncResult<Result<ImageResult>[]> {
            try {
              return ok(await runBatch(reqs, { ...o, batchTimeout: opts.batchTimeout, batchPollInterval: opts.batchPollInterval }))
            } catch (x) {
              return err(x instanceof Error ? x : new Error(String(x)))
            }
          },
        }
      : {}),

    async models(): AsyncResult<ImageModelInfo[]> {
      try {
        return ok(await list())
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)))
      }
    },

    async schema(model): AsyncResult<ImageModelSchema | undefined> {
      return ok(entryOf(model, t.vertex)?.schema)
    },

    async generate(req): AsyncResult<ImageResult> {
      const dl = new Deadline(timeout, req.signal)
      const emit = progressEmitter(req.onProgress, who)
      const seen: { id?: string; status?: string } = {}
      try {
        const e = entryOf(req.model, t.vertex)
        if (!e) {
          return err(imageError('ImageError', `${who}: модель ${req.model} — не медиа Google (ждём gemini-*-image, veo-*, lyria-3*)`))
        }
        if (e.family === 'veo') {
          const r = await runVeo(req, e, dl.signal, emit, seen)
          emit({ stage: 'done' })
          return ok(r)
        }
        const built = contentBody(req, e)
        if (typeof built === 'string') return err(imageError('ImageError', `${who} ${req.model}: ${built}`))
        emit({ stage: 'running' })
        const json = await post(t.url(req.model, e.family, 'generateContent'), built.body, dl.signal, `${req.model}:generateContent`)
        const r = contentResult(json, req, e, who)
        emit({ stage: 'done' })
        return ok(r)
      } catch (x) {
        if (dl.signal.aborted) {
          if (req.signal?.aborted) {
            const a = new Error(`${who}: запрос отменён`)
            a.name = 'AbortError'
            return err(a)
          }
          const reason = dl.signal.reason
          if (reason instanceof Error && reason.message === 'timeout') {
            const where = seen.id ? `операция ${seen.id}, последний статус ${seen.status ?? '—'}` : 'операция не создана'
            return err(imageError('ImageError', `${who} ${req.model}: таймаут ${timeout} мс (${where})`))
          }
        }
        return err(x instanceof Error ? x : new Error(String(x)))
      } finally {
        dl.dispose()
      }
    },
  }
}

// ==================== AI Studio ====================

/** Google AI Studio (Gemini API, ключ): Gemini image, Veo, Lyria 3. */
export function googleMediaProvider(opts: GoogleMediaOptions): ImageProvider {
  const base = (opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '').replace(/\/openai$/, '')
  const keyHeader = { 'x-goog-api-key': opts.apiKey }
  const who = 'Google'
  const t: Transport = {
    who,
    vertex: false,
    batch: {
      createUrl: (model) => `${base}/models/${model}:batchGenerateContent`,
      url: (name) => `${base}/${name}`,
      fileUrl: (file) => `${base.replace(/\/v1beta$/, '')}/download/v1beta/${file}:download?alt=media`,
    },
    url: (model, _f, method) => `${base}/models/${model}:${method}`,
    headers: async () => keyHeader,
    pollOp: (_m, _f, name, signal) => globalThis.fetch(`${base}/${name}`, { headers: keyHeader, signal }),
    async videos(response, signal) {
      const samples = ((response.generateVideoResponse as Json | undefined)?.generatedSamples ?? []) as Json[]
      const out: Uint8Array[] = []
      for (const s of samples) {
        const v = s.video as Json | undefined
        if (typeof v?.uri === 'string') {
          const res = await globalThis.fetch(v.uri, { headers: keyHeader, signal, redirect: 'follow' })
          if (!res.ok) throw imageError('ImageError', `${who}: скачивание ролика — ${res.status}`, await res.text())
          out.push(new Uint8Array(await res.arrayBuffer()))
        } else if (typeof v?.bytesBase64Encoded === 'string') out.push(fromBase64(v.bytesBase64Encoded))
      }
      return out
    },
    async list() {
      const out: ImageModelInfo[] = []
      let page = ''
      for (let i = 0; i < 20; i++) {
        const res = await globalThis.fetch(`${base}/models?pageSize=1000${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`, { headers: keyHeader })
        const text = await res.text()
        if (!res.ok) throw errorOf(res.status, text, who, 'models')
        const j = JSON.parse(text) as Json
        for (const m of (j.models ?? []) as Json[]) {
          const id = String(m.name ?? '').replace(/^models\//, '')
          const methods = (m.supportedGenerationMethods ?? []) as string[]
          const fam = familyOf(id)
          if (!fam) continue
          if (fam === 'veo' ? !methods.includes('predictLongRunning') : !methods.includes('generateContent')) continue
          const info = infoOf(id, typeof m.displayName === 'string' ? m.displayName : undefined)
          if (info) out.push(info)
        }
        page = typeof j.nextPageToken === 'string' ? j.nextPageToken : ''
        if (!page) break
      }
      return out
    },
  }
  return mediaProvider(t, opts)
}

// ==================== Vertex AI ====================

/** Vertex AI (токен ADC): те же семейства; Veo — в региональном эндпоинте (живьём 10.10). */
export function vertexMediaProvider(opts: VertexMediaOptions): ImageProvider {
  const location = opts.location ?? 'global'
  const mediaLocation = opts.mediaLocation ?? (location === 'global' ? 'us-central1' : location)
  const host = (loc: string) =>
    opts.baseUrl?.replace(/\/+$/, '') ?? (loc === 'global' ? 'https://aiplatform.googleapis.com' : `https://${loc}-aiplatform.googleapis.com`)
  const locOf = (f: Family) => (f === 'veo' ? mediaLocation : location)
  const modelUrl = (model: string, f: Family) =>
    `${host(locOf(f))}/v1/projects/${opts.project}/locations/${locOf(f)}/publishers/google/models/${model}`
  const who = 'Vertex'

  let cached: { token: string; at: number } | undefined
  const headers = async (): Promise<Record<string, string>> => {
    if (!cached || Date.now() - cached.at > TOKEN_TTL) {
      const token = (await opts.token()).trim()
      if (!token) throw imageError('AuthError', `${who}: пустой токен`)
      cached = { token, at: Date.now() }
    }
    return { authorization: `Bearer ${cached.token}`, 'x-goog-user-project': opts.project }
  }

  const t: Transport = {
    who,
    vertex: true,
    url: (model, f, method) => `${modelUrl(model, f)}:${method}`,
    headers,
    pollOp: async (model, f, name, signal) =>
      globalThis.fetch(`${modelUrl(model, f)}:fetchPredictOperation`, {
        method: 'POST',
        headers: { ...(await headers()), 'content-type': 'application/json' },
        body: JSON.stringify({ operationName: name }),
        signal,
      }),
    async videos(response) {
      const out: Uint8Array[] = []
      for (const v of (response.videos ?? []) as Json[]) {
        if (typeof v.bytesBase64Encoded === 'string') out.push(fromBase64(v.bytesBase64Encoded))
        else if (typeof v.gcsUri === 'string') {
          throw imageError('ImageError', `${who}: ролик в GCS (${v.gcsUri}) — storageUri не задаём, ждём байты`)
        }
      }
      return out
    },
    async list() {
      const h = await headers()
      const out: ImageModelInfo[] = []
      const res = await globalThis.fetch(`${host(location)}/v1beta1/publishers/google/models?pageSize=300`, { headers: h })
      const text = await res.text()
      if (!res.ok) throw errorOf(res.status, text, who, 'publishers/google/models')
      for (const m of ((JSON.parse(text) as Json).publisherModels ?? []) as Json[]) {
        const id = String(m.name ?? '').replace(/^publishers\/google\/models\//, '')
        const info = infoOf(id, undefined, true)
        if (info && !out.some((x) => x.id === id)) out.push(info)
      }
      const probes = await Promise.all(
        (opts.candidates ?? VERTEX_MEDIA_CANDIDATES)
          .filter((id) => !out.some((x) => x.id === id))
          .map(async (id) => {
            const f = familyOf(id)
            if (!f) return undefined
            const r = await globalThis.fetch(`${host(locOf(f))}/v1beta1/publishers/google/models/${id}`, { headers: h })
            await r.body?.cancel()
            return r.ok ? infoOf(id, undefined, true) : undefined
          }),
      )
      for (const p of probes) if (p) out.push(p)
      return out
    },
  }
  return mediaProvider(t, opts)
}
