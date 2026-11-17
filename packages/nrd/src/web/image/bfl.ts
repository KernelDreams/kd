/**
 * BFL (Black Forest Labs) — провайдер картинок и видео (`flux-3-video`) поверх
 * fetch (image-gen-spec §2, media-gen-spec §2).
 *
 * Схема моделей — из `GET {baseUrl}/openapi.json`, один раз на экземпляр:
 * поля модели = `properties` тела `POST /v1/{model}`. По ней тело запроса
 * проверяется до сети (лишний ключ, тип, enum — `err`, не тихий отброс и не
 * платный 422), а рефы раскладываются под семью полей модели.
 *
 * Асинхронный протокол: POST → `{id, polling_url, cost}` → опрос строго по
 * `polling_url` (регионы: id другого кластера на глобальном `get_result` —
 * «Task not found») → `Ready` → скачать `result.sample`.
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
import { sniffMediaMime, toBase64 } from './bytes.js'
import { coerce, describeField, Deadline, sleep } from './common.js'
import { progressEmitter, type ProgressEmit } from './progress.js'

export interface BflProviderOptions {
  /** `https://api.bfl.ai` или региональный (`https://api.eu.bfl.ai`). */
  baseUrl: string
  apiKey: string
  /** Общий таймаут генерации (POST + опрос + скачивание), мс. Дефолт 600 000. */
  timeout?: number
  /** Интервал опроса `polling_url`, мс. Дефолт 2000. */
  pollInterval?: number
  /** База паузы ретрая 429/503: пауза = retryDelay·k, k = 1…6. Дефолт 5000 (тесты — меньше). */
  retryDelay?: number
}

const DEFAULT_TIMEOUT = 600_000
const DEFAULT_POLL = 2000
const DEFAULT_RETRY_DELAY = 5000
const MAX_429_RETRIES = 6

/** Имена полей-картинок в схемах BFL. */
const IMAGE_FIELD_NAMES = new Set(['image', 'mask', 'person', 'garment', 'images', 'image_prompt'])
const INPUT_IMAGE_RE = /^input_image(?:_(\d+))?$/

const isImageField = (name: string) => IMAGE_FIELD_NAMES.has(name) || INPUT_IMAGE_RE.test(name)

const PENDING = new Set(['Pending', 'Queued', 'Reasoning', 'Generating'])
const MODERATED = new Set(['Request Moderated', 'Content Moderated'])

// ==================== Схема ====================

type Json = Record<string, unknown>

interface ModelEntry {
  schema: ImageModelSchema
  /** `summary` эндпоинта: «Generate an image with FLUX 3.». */
  name?: string
  /** Поля, по которым раскладываются рефы, по порядку. `images` — одно поле-массив. */
  refFields: string[]
  /**
   * Видео с режимами (`flux-3-video`, media-gen-spec §2): тело — `oneOf` по `mode`;
   * без рефов — `t2v`, с рефами — `i2v` и рефы кадрами в `keyframes`.
   */
  video?: { t2v: string; i2v: string }
}

interface ApiSchema {
  models: Map<string, ModelEntry>
}

function deref(node: unknown, root: Json): Json {
  let n = node as Json
  for (let i = 0; i < 16 && n && typeof n.$ref === 'string'; i++) {
    const parts = (n.$ref as string).replace(/^#\//, '').split('/')
    let cur: unknown = root
    for (const p of parts) cur = (cur as Json | undefined)?.[p]
    n = cur as Json
  }
  return n ?? {}
}

/** Развернуть `$ref`/`anyOf`/`oneOf`/`allOf` в плоский список вариантов. */
function variants(node: unknown, root: Json, depth = 0): Json[] {
  const n = deref(node, root)
  if (depth > 8) return [n]
  const alts = (n.anyOf ?? n.oneOf) as unknown[] | undefined
  if (Array.isArray(alts)) return alts.flatMap((a) => variants(a, root, depth + 1))
  if (Array.isArray(n.allOf)) {
    const merged: Json = {}
    for (const part of n.allOf as unknown[]) Object.assign(merged, ...variants(part, root, depth + 1))
    return [merged]
  }
  return [n]
}

function fieldOf(prop: unknown, root: Json): ImageModelField {
  const vs = variants(prop, root).filter((v) => v.type !== 'null')
  const types = new Set<string>()
  const values: unknown[] = []
  let allEnum = vs.length > 0
  let min: number | undefined
  let max: number | undefined
  for (const v of vs) {
    if (v.const !== undefined) {
      values.push(v.const)
      types.add(typeof v.type === 'string' ? v.type : typeof v.const)
    } else if (Array.isArray(v.enum)) {
      values.push(...(v.enum as unknown[]))
      if (typeof v.type === 'string') types.add(v.type)
    } else {
      allEnum = false
      if (typeof v.type === 'string') types.add(v.type)
    }
    if (typeof v.minimum === 'number') min ??= v.minimum
    if (typeof v.maximum === 'number') max ??= v.maximum
  }
  const field: ImageModelField = { type: [...types].join('|') || 'any' }
  if (allEnum && values.length) field.enum = values
  if (min !== undefined) field.min = min
  if (max !== undefined) field.max = max
  if (types.has('array')) field.array = true
  return field
}

const WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }

/**
 * «one to 10 total» / «one to ten total» / «up to 4 images» → число; иначе
 * maxItems варианта-списка (не кортежа `prefixItems`); иначе 10.
 */
function maxImagesFrom(prop: unknown, root: Json): number {
  const desc = String(deref(prop, root).description ?? '').replace(/\b(two|three|four|five|six|seven|eight|nine|ten)\b/gi, (w) => String(WORDS[w.toLowerCase()]))
  const m = desc.match(/(\d+)\s+(?:total|images?|references?)/i) ?? desc.match(/up to (\d+)/i)
  if (m) return Number(m[1])
  for (const v of variants(prop, root)) if (typeof v.maxItems === 'number' && !v.prefixItems) return v.maxItems
  return 10
}

function modelEntry(body: Json, root: Json): ModelEntry {
  const props = (body.properties ?? {}) as Json
  const fields: Record<string, ImageModelField> = {}
  for (const [name, prop] of Object.entries(props)) {
    const f = fieldOf(prop, root)
    if (isImageField(name)) f.image = true
    fields[name] = f
  }
  const names = Object.keys(fields)
  const schema: ImageModelSchema = { fields }
  let refFields: string[] = []
  if ('images' in fields) {
    refFields = ['images']
    schema.maxRefs = maxImagesFrom(props.images, root)
  } else if (names.some((n) => INPUT_IMAGE_RE.test(n))) {
    refFields = names
      .filter((n) => INPUT_IMAGE_RE.test(n))
      .sort((a, b) => Number(a.match(INPUT_IMAGE_RE)![1] ?? 1) - Number(b.match(INPUT_IMAGE_RE)![1] ?? 1))
    schema.maxRefs = refFields.length
  } else if ('image_prompt' in fields) {
    refFields = ['image_prompt']
    schema.maxRefs = 1
  } else {
    // image/mask, person/garment — рефы по порядку полей схемы.
    refFields = names.filter((n) => fields[n].image)
    if (refFields.length) schema.maxRefs = refFields.length
  }
  return { schema, refFields }
}

/** Режим тела по `mode: {const}`. */
const modeOf = (body: Json): string | undefined => {
  const m = (body.properties as Json | undefined)?.mode as Json | undefined
  return typeof m?.const === 'string' ? m.const : undefined
}

/**
 * Видео-эндпоинт с режимами t2v/i2v: поля — из t2v (без `mode`), рефы — кадры
 * `keyframes` режима i2v («one to ten total»: первый начинает, последний заканчивает).
 */
function videoEntry(bodies: Json[], root: Json): ModelEntry | undefined {
  const t2v = bodies.find((b) => modeOf(b) === 't2v')
  const i2v = bodies.find((b) => modeOf(b) === 'i2v')
  if (!t2v || !i2v || !(i2v.properties as Json).keyframes) return undefined
  const props = { ...(t2v.properties as Json) }
  delete props.mode
  const fields: Record<string, ImageModelField> = {}
  for (const [name, prop] of Object.entries(props)) fields[name] = fieldOf(prop, root)
  const schema: ImageModelSchema = {
    fields,
    kind: 'video',
    refRole: 'frames',
    maxRefs: maxImagesFrom((i2v.properties as Json).keyframes, root),
  }
  return { schema, refFields: ['keyframes'], video: { t2v: 't2v', i2v: 'i2v' } }
}

function parseApi(doc: Json): ApiSchema {
  const models = new Map<string, ModelEntry>()
  for (const [p, item] of Object.entries((doc.paths ?? {}) as Json)) {
    const post = (item as Json | undefined)?.post as Json | undefined
    if (!post || !p.startsWith('/v1/')) continue
    const content = ((post.requestBody as Json | undefined)?.content as Json | undefined)?.['application/json'] as
      | Json
      | undefined
    if (!content?.schema) continue
    const bodies = variants(content.schema, doc).filter((v) => v.properties)
    const body = bodies[0] ?? {}
    const entry = videoEntry(bodies, doc) ?? modelEntry(body, doc)
    if (typeof post.summary === 'string') entry.name = post.summary
    models.set(p.slice('/v1/'.length), entry)
  }
  return { models }
}

function levenshtein(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]
    d[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j]
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return d[b.length]
}

/** Ближайшие по имени модели — для сообщения «модели нет». */
function nearest(name: string, all: string[], n = 5): string[] {
  return all
    .map((m) => ({ m, d: m.includes(name) || name.includes(m) ? 0 : levenshtein(name, m) }))
    .sort((a, b) => a.d - b.d || a.m.localeCompare(b.m))
    .slice(0, n)
    .map((x) => x.m)
}

/**
 * Эндпоинты, которые не модели генерации: файнтюны, удаление, видео-инструменты
 * (апскейл/правка ролика — вход видео, image-gen-2-spec §2). `flux-3-video` — модель
 * вида `video` (media-gen-spec §2).
 */
function isModel(id: string): boolean {
  return !/finetune/.test(id) && !id.startsWith('delete_') && !id.startsWith('flux-tools/video-')
}

// ==================== Тело запроса ====================

/** Поле-картинка из params: байты → base64, строка (URL/base64) — как есть. */
function imageValue(v: unknown): unknown {
  if (v instanceof Uint8Array) return toBase64(v)
  if (Array.isArray(v)) return v.map(imageValue)
  return v
}

function buildBody(req: ImageRequest, entry: ModelEntry): { body: Json } | string {
  const { fields } = entry.schema
  const fieldList = () => Object.entries(fields).map(([k, f]) => describeField(k, f)).join(', ')
  const body: Json = {}

  if (req.prompt !== undefined) {
    if (!('prompt' in fields)) return `модель ${req.model} не принимает prompt; поля: ${fieldList()}`
    body.prompt = req.prompt
  }

  for (const [k, v] of Object.entries(req.params ?? {})) {
    if (v === undefined) continue
    const f = fields[k]
    if (!f) return `параметр "${k}" — нет у модели ${req.model}; поля: ${fieldList()}`
    if (k === 'prompt' && req.prompt !== undefined) return 'prompt задан и аргументом, и в params'
    if (f.image) {
      body[k] = imageValue(v)
      continue
    }
    const c = coerce(k, v, f)
    if (typeof c === 'string') return c
    body[k] = c.value
  }

  const refs = req.refs ?? []
  if (entry.video) {
    if (refs.length > (entry.schema.maxRefs ?? 0)) return `модель ${req.model} принимает до ${entry.schema.maxRefs} кадров, передано ${refs.length}`
    if ('keyframes' in body || 'mode' in body) return 'кадры — рефами, не params.keyframes/mode'
    body.mode = refs.length ? entry.video.i2v : entry.video.t2v
    if (refs.length) body.keyframes = refs.map(toBase64)
    return { body }
  }
  if (refs.length) {
    const max = entry.schema.maxRefs ?? 0
    if (max === 0) return `модель ${req.model} не принимает референсы`
    if (refs.length > max) return `модель ${req.model} принимает до ${max} реф., передано ${refs.length}`
    if (entry.refFields[0] === 'images') {
      if ('images' in body) return 'рефы и params.images одновременно — выбери одно'
      body.images = refs.map(toBase64)
    } else {
      for (let i = 0; i < refs.length; i++) {
        const name = entry.refFields[i]
        if (name in body) return `реф №${i + 1} ложится в поле "${name}", а оно уже задано в params`
        body[name] = toBase64(refs[i])
      }
    }
  }
  return { body }
}

// ==================== Сеть ====================

function statusError(status: number, body: string, what: string): Error {
  if (status === 401 || status === 403) return imageError('AuthError', `BFL ${what}: ${status} — ключ не принят`, body)
  if (/Moderated/i.test(body)) return imageError('ModerationError', `BFL ${what}: ${body.slice(0, 300)}`, body)
  return imageError('ImageError', `BFL ${what}: ${status} ${body.slice(0, 500)}`, body)
}

/** BFL-провайдер картинок. Схема API грузится лениво, один раз на экземпляр. */
export function bflImageProvider(opts: BflProviderOptions): ImageProvider {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT
  const pollInterval = opts.pollInterval ?? DEFAULT_POLL
  const retryDelay = opts.retryDelay ?? DEFAULT_RETRY_DELAY
  const headers = { 'x-key': opts.apiKey, accept: 'application/json' }

  let apiPromise: Promise<ApiSchema> | undefined
  const api = (): Promise<ApiSchema> => {
    apiPromise ??= (async () => {
      const res = await globalThis.fetch(`${base}/openapi.json`, { headers: { accept: 'application/json' } })
      const text = await res.text()
      if (!res.ok) throw statusError(res.status, text, 'openapi.json')
      return parseApi(JSON.parse(text) as Json)
    })()
    // Неудача не кешируется: следующий вызов попробует снова.
    apiPromise.catch(() => (apiPromise = undefined))
    return apiPromise
  }

  async function entryFor(model: string): Promise<ModelEntry> {
    const { models } = await api()
    const entry = models.get(model)
    if (!entry) {
      const near = nearest(model, [...models.keys()])
      throw imageError('ImageError', `модель ${model} нет в API BFL; ближайшие: ${near.join(', ')}`)
    }
    return entry
  }

  async function post(model: string, body: Json, signal: AbortSignal): Promise<Json> {
    const payload = JSON.stringify(body)
    for (let attempt = 0; ; attempt++) {
      const res = await globalThis.fetch(`${base}/v1/${model}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: payload,
        signal,
      })
      const text = await res.text()
      // 503 у BFL — «over capacity, retry shortly»: та же семантика, что 429.
      if (res.status === 429 || res.status === 503) {
        if (attempt >= MAX_429_RETRIES) {
          throw res.status === 429
            ? imageError('RateLimitError', `BFL: 429 после ${MAX_429_RETRIES} ретраев`, text)
            : imageError('ImageError', `BFL POST /v1/${model}: 503 после ${MAX_429_RETRIES} ретраев — ${text.slice(0, 300)}`, text)
        }
        await sleep(retryDelay * (attempt + 1), signal)
        continue
      }
      if (!res.ok) throw statusError(res.status, text, `POST /v1/${model}`)
      try {
        return JSON.parse(text) as Json
      } catch {
        throw imageError('ImageError', `BFL POST /v1/${model}: ответ не JSON`, text)
      }
    }
  }

  async function poll(url: string, signal: AbortSignal, seen: { status?: string }, emit: ProgressEmit): Promise<Json> {
    for (;;) {
      await sleep(pollInterval, signal)
      const res = await globalThis.fetch(url, { headers, signal })
      const text = await res.text()
      // Транзиентное на опросе (429/5xx) — ждём дальше, задача на сервере идёт.
      if (res.status === 429 || res.status >= 500) continue
      if (!res.ok) throw statusError(res.status, text, 'polling')
      let r: Json
      try {
        r = JSON.parse(text) as Json
      } catch {
        throw imageError('ImageError', 'BFL polling: ответ не JSON', text)
      }
      const status = String(r.status ?? '')
      seen.status = status
      if (status === 'Ready') return r
      if (PENDING.has(status)) {
        emit({ stage: 'running', status })
        continue
      }
      if (MODERATED.has(status)) throw imageError('ModerationError', `BFL: ${status}`, text)
      throw imageError('ImageError', `BFL: статус "${status}"`, text)
    }
  }

  async function download(url: string, signal: AbortSignal): Promise<Uint8Array> {
    const res = await globalThis.fetch(url, { signal })
    if (!res.ok) throw imageError('ImageError', `BFL: скачивание результата — ${res.status}`, await res.text())
    return new Uint8Array(await res.arrayBuffer())
  }

  return {
    async models(): AsyncResult<ImageModelInfo[]> {
      try {
        const { models } = await api()
        const list: ImageModelInfo[] = []
        for (const [id, e] of models) {
          if (!isModel(id)) continue
          const info: ImageModelInfo = { id, edit: !e.video && (e.schema.maxRefs ?? 0) > 0 }
          if (e.schema.kind) info.kind = e.schema.kind
          if (e.schema.refRole) info.refRole = e.schema.refRole
          if (e.name) info.name = e.name
          if (e.schema.maxRefs) info.maxRefs = e.schema.maxRefs
          list.push(info)
        }
        return ok(list)
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)))
      }
    },

    async schema(model): AsyncResult<ImageModelSchema | undefined> {
      try {
        const { models } = await api()
        return ok(models.get(model)?.schema)
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)))
      }
    },

    async generate(req): AsyncResult<ImageResult> {
      const dl = new Deadline(timeout, req.signal)
      const seen: { id?: string; status?: string } = {}
      const emit = progressEmitter(req.onProgress, 'BFL')
      try {
        const entry = await entryFor(req.model)
        const built = buildBody(req, entry)
        if (typeof built === 'string') return err(imageError('ImageError', `BFL ${req.model}: ${built}`))

        const task = await post(req.model, built.body, dl.signal)
        if (typeof task.id === 'string') seen.id = task.id
        emit({ stage: 'queued' })
        const pollingUrl = task.polling_url
        if (typeof pollingUrl !== 'string' || !pollingUrl) {
          return err(imageError('ImageError', 'BFL: в ответе POST нет polling_url', JSON.stringify(task)))
        }
        const done = await poll(pollingUrl, dl.signal, seen, emit)
        const result = (done.result ?? {}) as Json
        const sample = result.sample ?? result.video ?? result.url
        if (typeof sample !== 'string') {
          return err(imageError('ImageError', 'BFL: Ready без result.sample', JSON.stringify(done)))
        }
        emit({ stage: 'downloading' })
        const bytes = await download(sample, dl.signal)
        emit({ stage: 'done' })

        const meta: ImageResult['meta'] = { model: req.model, cost_unit: 'credits' }
        if (typeof task.id === 'string') meta.id = task.id
        const cost = typeof task.cost === 'number' ? task.cost : typeof done.cost === 'number' ? done.cost : undefined
        if (cost !== undefined) meta.cost = cost
        if (typeof result.seed === 'number') meta.seed = result.seed
        for (const k of ['input_mp', 'output_mp'] as const) if (typeof task[k] === 'number') meta[k] = task[k]
        if (typeof result.duration === 'number') meta.duration = result.duration
        return ok({ images: [bytes], mime: sniffMediaMime(bytes), meta })
      } catch (e) {
        if (dl.signal.aborted) {
          const reason = dl.signal.reason
          if (req.signal?.aborted) {
            const a = new Error('BFL: запрос отменён')
            a.name = 'AbortError'
            return err(a)
          }
          if (reason instanceof Error && reason.message === 'timeout') {
            const where = seen.id
              ? `задача ${seen.id}, последний статус ${seen.status ?? '—'}`
              : 'задача не создана'
            return err(imageError('ImageError', `BFL ${req.model}: таймаут ${timeout} мс (${where})`))
          }
        }
        return err(e instanceof Error ? e : new Error(String(e)))
      } finally {
        dl.dispose()
      }
    },
  }
}
