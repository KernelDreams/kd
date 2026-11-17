/**
 * nano-gpt — провайдер картинок и звука поверх fetch (image-gen-2-spec §3; звук —).
 *
 * Синхронный протокол: `POST {baseUrl}/images` → `{data: [{b64_json}], cost,
 * paymentSource, remainingBalance, requestId}`. Список и схема моделей — из
 * `GET {baseUrl}/images/models` (без ключа), один раз на экземпляр: поля модели
 * собираются из `supported_parameters`, тело проверяется до сети (лишний ключ,
 * тип, enum — `err`). Рефы — `imageDataUrls` (data-URL; см. generate).
 *
 * Звук (SFX, музыка): каталог `GET {baseUrl}/audio-models` (без ключа) — категории
 * `audio_music` / `audio_generation` с `text_to_music` / `text_to_audio` (TTS/STT не берём —
 * голоса у appz speak). Генерация — `POST {origin}/api/tts` (`x-api-key`, тело `{model, text,
 * duration?, …}`) → 202 `{runId, cost}` → опрос `GET /api/tts/status` → `audioUrl` (живьём 10.10).
 * Полей входа каталог не отдаёт — `duration` из `min/max_duration`, остальное — по модели
 * (`AUDIO_EXTRA`, из клиента nano-gpt).
 */

import {
  imageError,
  type AsyncResult,
  type ImageModelField,
  type ImageModelInfo,
  type ImageModelSchema,
  type ImageProvider,
  type ImageRequest,
  type ImageResult,
} from '../../contracts/index.js'
import { ok, err } from '../../infra/result.js'
import { fromBase64, sniffImageMime, sniffMediaMime, toBase64 } from './bytes.js'
import { coerce, describeField, Deadline, sleep } from './common.js'
import { progressEmitter, type ProgressEmit } from './progress.js'

export interface NanogptProviderOptions {
  /** `https://nano-gpt.com/api/v1`. */
  baseUrl: string
  apiKey: string
  /** Таймаут генерации, мс. Дефолт 600 000 (flux-3 — ~43 с). */
  timeout?: number
  /** База паузы ретрая 429: пауза = retryDelay·k, k = 1…6. Дефолт 5000. */
  retryDelay?: number
  /** Интервал опроса звука (`/api/tts/status`), мс. Дефолт 3000. */
  pollInterval?: number
}

const DEFAULT_TIMEOUT = 600_000
const DEFAULT_RETRY_DELAY = 5000
const MAX_429_RETRIES = 6

/** Ключи `supported_parameters`, которые становятся одноимёнными полями запроса. */
const PASS_KEYS = ['seed', 'output_format', 'thinking_level', 'enable_web_search', 'rendering_speed', 'system_prompt', 'loras']

type Json = Record<string, unknown>

interface ModelEntry {
  info: ImageModelInfo
  schema: ImageModelSchema
  /** `capabilities.image_generation`. */
  generation: boolean
  /** Звук: генерация через `/api/tts`. */
  audio?: boolean
}

/** Поля звуковых моделей, которых нет в каталоге (из веб-клиента nano-gpt, 10.2026). */
const AUDIO_EXTRA: Array<[RegExp, Record<string, ImageModelField>]> = [
  [/^elevenlabs\/sound-effects/, { loop: { type: 'boolean' }, prompt_influence: { type: 'number', min: 0, max: 1 } }],
  [/^elevenlabs\/music/, { lyrics: { type: 'string' }, force_instrumental: { type: 'boolean' } }],
  [
    /^stable-audio-3\//,
    {
      duration: { type: 'number', min: 1, max: 120 },
      negative_prompt: { type: 'string' },
      seed: { type: 'integer', min: -1 },
      output_format: { type: 'string', enum: ['mp3', 'wav', 'flac', 'ogg'] },
    },
  ],
  [/^google\/lyria-3-pro\//, { negative_prompt: { type: 'string' }, seed: { type: 'integer' } }],
]

/** Цена звука: `$0.002/с`, `$0.75/мин`, `$0.11`. */
function audioPrice(p: unknown): string | undefined {
  const o = (p ?? {}) as Json
  if (typeof o.per_second === 'number' && o.per_second > 0) return `${fmtUsd(o.per_second)}/с`
  if (typeof o.per_billing_interval === 'number') return `${fmtUsd(o.per_billing_interval)}/${o.billing_interval_seconds === 60 ? 'мин' : `${String(o.billing_interval_seconds)} с`}`
  if (typeof o.per_generation === 'number') return fmtUsd(o.per_generation)
  if (typeof o.minimum === 'number' && o.minimum > 0) return `от ${fmtUsd(o.minimum)}`
  return undefined
}

/** Модель каталога `audio-models` → запись; не SFX/музыка из текста — undefined. */
function audioEntry(m: Json): ModelEntry | undefined {
  const cat = String(m.category ?? '')
  const caps = (m.capabilities ?? {}) as Json
  if (cat !== 'audio_music' && cat !== 'audio_generation') return undefined
  if (!caps.text_to_music && !caps.text_to_audio) return undefined
  if (caps.podcast_generation) return undefined
  const sp = (m.supported_parameters ?? {}) as Json
  const fields: Record<string, ImageModelField> = { prompt: { type: 'string' } }
  if (typeof sp.min_duration === 'number' || typeof sp.max_duration === 'number') {
    fields.duration = { type: 'number', ...(typeof sp.min_duration === 'number' ? { min: sp.min_duration } : {}), ...(typeof sp.max_duration === 'number' ? { max: sp.max_duration } : {}) }
  }
  // Поля JSON-schema вида {type: 'string'} (yue2: lyrics, style) — как есть; URI (image_url) — нет.
  for (const [k, v] of Object.entries(sp)) {
    const o = v as Json
    if (o && typeof o === 'object' && !Array.isArray(o) && typeof o.type === 'string' && o.format !== 'uri') fields[k] = { type: o.type }
  }
  if (typeof sp.sample_count_parameter === 'string') fields[sp.sample_count_parameter] = { type: 'integer', min: Number(sp.min_samples ?? 1), max: Number(sp.max_samples ?? 1) }
  if (typeof sp.generation_count_parameter === 'string') fields[sp.generation_count_parameter] = { type: 'integer', min: 1, max: Number(sp.max_generations ?? 1) }
  const id = String(m.id)
  for (const [re, extra] of AUDIO_EXTRA) if (re.test(id)) Object.assign(fields, extra)
  const info: ImageModelInfo = { id, kind: 'audio' }
  if (typeof m.name === 'string') info.name = m.name
  const price = audioPrice(m.pricing)
  if (price) info.price = price
  return { info, schema: { fields, kind: 'audio' }, generation: true, audio: true }
}

/** Тип поля по значению в ответе: массив → enum, boolean → boolean, `{type}` → тип, иначе string/number. */
function fieldFromValue(v: unknown): ImageModelField {
  if (Array.isArray(v)) {
    const types = [...new Set(v.map((x) => typeof x))]
    return { type: types.join('|') || 'string', enum: v }
  }
  if (typeof v === 'boolean') return { type: 'boolean' }
  if (typeof v === 'number') return { type: 'number' }
  if (v && typeof v === 'object') {
    const o = v as Json
    if (typeof o.type === 'string') return { type: o.type }
    // loras: {max_items, item: {path, scale}} — массив объектов.
    if (typeof o.max_items === 'number') return { type: 'array', array: true, max: o.max_items }
    return { type: 'any' }
  }
  return { type: 'string' }
}

function fmtUsd(n: number): string {
  return `$${Number(n.toPrecision(4))}`
}

/** `{1k: 0.05, 2k: 0.12}` → «$0.05/1k, $0.12/2k»; одна цена на всё — «$0.05». */
function priceOf(pricing: unknown): string | undefined {
  const per = (pricing as Json | undefined)?.per_image
  if (typeof per === 'number') return fmtUsd(per)
  if (!per || typeof per !== 'object') return undefined
  const entries = Object.entries(per as Json).filter((e): e is [string, number] => typeof e[1] === 'number')
  if (!entries.length) return undefined
  const distinct = new Set(entries.map((e) => e[1]))
  if (distinct.size === 1) return fmtUsd(entries[0][1])
  return entries.map(([k, v]) => `${fmtUsd(v)}/${k}`).join(', ')
}

function modelEntry(m: Json): ModelEntry {
  const caps = (m.capabilities ?? {}) as Json
  const sp = (m.supported_parameters ?? {}) as Json
  const fields: Record<string, ImageModelField> = {
    prompt: { type: 'string' },
    n: { type: 'integer', min: 1, ...(typeof sp.max_images === 'number' ? { max: sp.max_images } : {}) },
  }
  if (Array.isArray(sp.resolutions)) fields.resolution = fieldFromValue(sp.resolutions)
  if (Array.isArray(sp.aspect_ratio)) fields.aspect_ratio = fieldFromValue(sp.aspect_ratio)
  for (const k of PASS_KEYS) if (k in sp) fields[k] = fieldFromValue(sp[k])
  const schema: ImageModelSchema = { fields }
  const edit = caps.image_to_image === true
  const maxIn = typeof sp.max_input_images === 'number' ? sp.max_input_images : 0
  if (edit && maxIn > 0) schema.maxRefs = maxIn
  const info: ImageModelInfo = { id: String(m.id), edit }
  if (typeof m.name === 'string') info.name = m.name
  if (schema.maxRefs) info.maxRefs = schema.maxRefs
  const price = priceOf(m.pricing)
  if (price) info.price = price
  return { info, schema, generation: caps.image_generation === true }
}

const MODERATION_RE = /^(CONTENT_POLICY|MODERATION)/i

function errorOf(status: number, text: string, model: string): Error {
  if (status === 401 || status === 403) return imageError('AuthError', `nano-gpt ${model}: ${status} — ключ не принят`, text)
  let type = ''
  let message = text.slice(0, 500)
  try {
    const j = JSON.parse(text) as Json
    const e = j.error
    if (e && typeof e === 'object') {
      type = String((e as Json).type ?? (e as Json).code ?? j.type ?? '')
      message = String((e as Json).message ?? message)
    } else {
      type = String(j.type ?? j.code ?? '')
      if (e !== undefined) message = String(e)
    }
  } catch {
    // тело не JSON — текст как есть
  }
  if (MODERATION_RE.test(type)) return imageError('ModerationError', `nano-gpt ${model}: ${type} — ${message}`, text)
  const free = type === 'IMAGE_PROCESSING_FAILED' || /not (been )?charged|no charge/i.test(message) ? ' (не списано)' : ''
  return imageError('ImageError', `nano-gpt ${model}: ${status}${type ? ' ' + type : ''} — ${message}${free}`, text)
}

/** nano-gpt-провайдер картинок. Список моделей грузится лениво, один раз на экземпляр. */
export function nanogptImageProvider(opts: NanogptProviderOptions): ImageProvider {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT
  const retryDelay = opts.retryDelay ?? DEFAULT_RETRY_DELAY
  const pollMs = opts.pollInterval ?? 3000

  let listPromise: Promise<Map<string, ModelEntry>> | undefined
  const list = (): Promise<Map<string, ModelEntry>> => {
    listPromise ??= (async () => {
      const res = await globalThis.fetch(`${base}/images/models`, { headers: { accept: 'application/json' } })
      const text = await res.text()
      if (!res.ok) throw imageError('ImageError', `nano-gpt images/models: ${res.status} ${text.slice(0, 300)}`, text)
      const data = (JSON.parse(text) as Json).data
      const map = new Map<string, ModelEntry>()
      for (const m of Array.isArray(data) ? (data as Json[]) : []) {
        if (typeof m.id === 'string') map.set(m.id, modelEntry(m))
      }
      // Звук — вторым каталогом; не ответил — картинки всё равно есть (звука просто нет).
      try {
        const ra = await globalThis.fetch(`${base}/audio-models`, { headers: { accept: 'application/json' } })
        if (ra.ok) {
          const audio = (JSON.parse(await ra.text()) as Json).data
          for (const m of Array.isArray(audio) ? (audio as Json[]) : []) {
            const e = typeof m.id === 'string' && !map.has(m.id) ? audioEntry(m) : undefined
            if (e) map.set(e.info.id, e)
          }
        }
      } catch {
        // каталог звука недоступен
      }
      return map
    })()
    listPromise.catch(() => (listPromise = undefined))
    return listPromise
  }

  const origin = base.replace(/\/api\/v\d+$/, '').replace(/\/v\d+$/, '')

  /** Звук: `/api/tts` → (202 → опрос `/api/tts/status`) → скачать `audioUrl`. */
  async function generateAudio(req: ImageRequest, entry: ModelEntry, signal: AbortSignal, emit: ProgressEmit): AsyncResult<ImageResult> {
    const { fields } = entry.schema
    const fieldList = () => Object.entries(fields).map(([k, f]) => describeField(k, f)).join(', ')
    if (req.refs?.length) return err(imageError('ImageError', `nano-gpt ${req.model}: звуковая модель рефов не принимает`))
    const prompt = req.prompt ?? (typeof req.params?.prompt === 'string' ? req.params.prompt : undefined)
    if (!prompt?.trim()) return err(imageError('ImageError', `nano-gpt ${req.model}: нужен промпт`))
    const body: Json = { model: req.model, text: prompt }
    for (const [k, v] of Object.entries(req.params ?? {})) {
      if (v === undefined || k === 'prompt') continue
      const f = fields[k]
      if (!f) return err(imageError('ImageError', `nano-gpt ${req.model}: параметр "${k}" — нет у модели; поля: ${fieldList()}`))
      const c = coerce(k, v, f)
      if (typeof c === 'string') return err(imageError('ImageError', `nano-gpt ${req.model}: ${c}`))
      body[k] = c.value
    }
    const headers = { 'x-api-key': opts.apiKey, 'content-type': 'application/json', accept: 'application/json' }
    emit({ stage: 'running' })
    let json: Json | undefined
    let raw: Uint8Array | undefined
    let rawMime = ''
    for (let attempt = 0; !json && !raw; attempt++) {
      const res = await globalThis.fetch(`${origin}/api/tts`, { method: 'POST', headers, body: JSON.stringify(body), signal })
      if (res.status === 429) {
        if (attempt >= MAX_429_RETRIES) return err(imageError('RateLimitError', `nano-gpt: 429 после ${MAX_429_RETRIES} ретраев`))
        await sleep(retryDelay * (attempt + 1), signal)
        continue
      }
      const ct = res.headers.get('content-type') ?? ''
      if (res.ok && /^audio\//.test(ct)) {
        raw = new Uint8Array(await res.arrayBuffer())
        rawMime = ct.split(';')[0]
        break
      }
      const text = await res.text()
      if (!res.ok) return err(errorOf(res.status, text, req.model))
      try {
        json = JSON.parse(text) as Json
      } catch {
        return err(imageError('ImageError', `nano-gpt ${req.model}: ответ не JSON`, text))
      }
    }
    const meta: ImageResult['meta'] = { model: req.model }
    if (json) {
      if (typeof json.cost === 'number') meta.cost = json.cost
      if (typeof json.paymentSource === 'string') meta.cost_unit = json.paymentSource.toLowerCase()
      if (typeof json.runId === 'string') meta.id = json.runId
    }
    // 202: опрос статуса, пока не completed/error.
    while (json && !json.audioUrl && !json.audio && json.status !== 'completed' && json.runId) {
      if (json.status === 'error' || json.status === 'failed') break
      emit({ stage: json.queuePosition !== undefined ? 'queued' : 'running', status: json.queuePosition !== undefined ? `очередь ${String(json.queuePosition)}` : String(json.status ?? '') })
      await sleep(pollMs, signal)
      const q = new URLSearchParams({
        runId: String(json.runId ?? meta.id),
        model: String(json.model ?? req.model),
        cost: String(meta.cost ?? ''),
        paymentSource: String(json.paymentSource ?? meta.cost_unit ?? '').toUpperCase(),
        isApiRequest: 'true',
      })
      const res = await globalThis.fetch(`${origin}/api/tts/status?${q}`, { headers: { 'x-api-key': opts.apiKey, accept: 'application/json' }, signal })
      const text = await res.text()
      if (res.status === 429 || res.status >= 500) continue
      if (!res.ok) return err(errorOf(res.status, text, req.model))
      const next = JSON.parse(text) as Json
      json = { runId: json.runId, model: json.model, paymentSource: json.paymentSource, ...next }
    }
    if (json && (json.status === 'error' || json.status === 'failed')) {
      const code = String(json.code ?? '')
      const msg = `nano-gpt ${req.model}: ${code ? code + ' — ' : ''}${String(json.error ?? json.message ?? 'ошибка генерации')}`
      return err(imageError(MODERATION_RE.test(code) || /CONTENT_POLICY/.test(code) ? 'ModerationError' : 'ImageError', msg, JSON.stringify(json)))
    }
    if (!raw) {
      const url = typeof json?.audioUrl === 'string' ? json.audioUrl : Array.isArray(json?.audioUrls) ? String(json.audioUrls[0]) : undefined
      if (typeof json?.audio === 'string') raw = fromBase64(json.audio)
      else if (url) {
        emit({ stage: 'downloading' })
        const r = await globalThis.fetch(url, { signal })
        if (!r.ok) return err(imageError('ImageError', `nano-gpt: скачивание звука — ${r.status}`))
        raw = new Uint8Array(await r.arrayBuffer())
        rawMime = String(json?.contentType ?? r.headers.get('content-type') ?? '').split(';')[0]
      } else return err(imageError('ImageError', `nano-gpt ${req.model}: в ответе нет звука`, JSON.stringify(json).slice(0, 2000)))
    }
    emit({ stage: 'done' })
    if (typeof body.seed === 'number' && body.seed >= 0) meta.seed = body.seed
    const sniffed = sniffMediaMime(raw)
    return ok({ images: [raw], mime: sniffed !== 'application/octet-stream' ? sniffed : rawMime || 'audio/mpeg', meta })
  }

  return {
    async models(): AsyncResult<ImageModelInfo[]> {
      try {
        const all = await list()
        return ok([...all.values()].filter((e) => e.generation).map((e) => e.info))
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)))
      }
    },

    async schema(model): AsyncResult<ImageModelSchema | undefined> {
      try {
        return ok((await list()).get(model)?.schema)
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)))
      }
    },

    async generate(req): AsyncResult<ImageResult> {
      const dl = new Deadline(timeout, req.signal)
      const emit = progressEmitter(req.onProgress, 'nano-gpt')
      try {
        const entry = (await list()).get(req.model)
        if (!entry) return err(imageError('ImageError', `модели ${req.model} нет в nano-gpt images/models и audio-models`))
        if (entry.audio) return await generateAudio(req, entry, dl.signal, emit)
        const { fields } = entry.schema
        const fieldList = () => Object.entries(fields).map(([k, f]) => describeField(k, f)).join(', ')

        const body: Json = { model: req.model }
        if (req.prompt !== undefined) body.prompt = req.prompt
        for (const [k, v] of Object.entries(req.params ?? {})) {
          if (v === undefined) continue
          const f = fields[k]
          if (!f) return err(imageError('ImageError', `nano-gpt ${req.model}: параметр "${k}" — нет у модели; поля: ${fieldList()}`))
          if (k === 'prompt' && req.prompt !== undefined) return err(imageError('ImageError', 'prompt задан и аргументом, и в params'))
          if (f.type === 'array' || f.type === 'any') {
            body[k] = v
            continue
          }
          const c = coerce(k, v, f)
          if (typeof c === 'string') return err(imageError('ImageError', `nano-gpt ${req.model}: ${c}`))
          body[k] = c.value
        }

        const refs = req.refs ?? []
        if (refs.length) {
          const max = entry.schema.maxRefs ?? 0
          if (max === 0) return err(imageError('ImageError', `nano-gpt ${req.model}: модель не принимает референсы`))
          if (refs.length > max) {
            return err(imageError('ImageError', `nano-gpt ${req.model}: модель принимает до ${max} реф., передано ${refs.length}`))
          }
          // Не `input_references`: нормализованное поле документации flux-3/edit не видит
          // («requires between 1 and 10 reference images», живьём 07.10), легаси-алиас
          // `imageDataUrls` маршрут принимает для всех моделей. Смешивать нельзя (conflicting_image_inputs).
          body.imageDataUrls = refs.map((r) => `data:${sniffImageMime(r)};base64,${toBase64(r)}`)
        }

        const payload = JSON.stringify(body)
        let json: Json | undefined
        emit({ stage: 'running' })
        for (let attempt = 0; !json; attempt++) {
          const res = await globalThis.fetch(`${base}/images`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${opts.apiKey}`,
              'content-type': 'application/json',
              accept: 'application/json',
            },
            body: payload,
            signal: dl.signal,
          })
          const text = await res.text()
          if (res.status === 429) {
            if (attempt >= MAX_429_RETRIES) {
              return err(imageError('RateLimitError', `nano-gpt: 429 после ${MAX_429_RETRIES} ретраев`, text))
            }
            await sleep(retryDelay * (attempt + 1), dl.signal)
            continue
          }
          if (!res.ok) return err(errorOf(res.status, text, req.model))
          try {
            json = JSON.parse(text) as Json
          } catch {
            return err(imageError('ImageError', `nano-gpt ${req.model}: ответ не JSON`, text))
          }
        }

        const images: Uint8Array[] = []
        for (const d of Array.isArray(json.data) ? (json.data as Json[]) : []) {
          if (typeof d.b64_json === 'string') images.push(fromBase64(d.b64_json))
          else if (typeof d.url === 'string') {
            emit({ stage: 'downloading' })
            const r = await globalThis.fetch(d.url, { signal: dl.signal })
            if (!r.ok) return err(imageError('ImageError', `nano-gpt: скачивание результата — ${r.status}`))
            images.push(new Uint8Array(await r.arrayBuffer()))
          }
        }
        if (!images.length) return err(imageError('ImageError', `nano-gpt ${req.model}: в ответе нет картинок`, JSON.stringify(json).slice(0, 2000)))
        emit({ stage: 'done' })

        const meta: ImageResult['meta'] = { model: req.model }
        if (typeof json.requestId === 'string') meta.id = json.requestId
        if (typeof json.cost === 'number') meta.cost = json.cost
        if (typeof json.paymentSource === 'string') meta.cost_unit = json.paymentSource.toLowerCase()
        if (typeof json.remainingBalance === 'number') meta.balance = json.remainingBalance
        if (typeof body.seed === 'number' && body.seed >= 0) meta.seed = body.seed
        return ok({ images, mime: sniffImageMime(images[0]), meta })
      } catch (e) {
        if (dl.signal.aborted) {
          if (req.signal?.aborted) {
            const a = new Error('nano-gpt: запрос отменён')
            a.name = 'AbortError'
            return err(a)
          }
          const reason = dl.signal.reason
          if (reason instanceof Error && reason.message === 'timeout') {
            return err(imageError('ImageError', `nano-gpt ${req.model}: таймаут ${timeout} мс`))
          }
        }
        return err(e instanceof Error ? e : new Error(String(e)))
      } finally {
        dl.dispose()
      }
    },
  }
}
