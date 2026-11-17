/**
 * Capability `image` моста (image-gen-2-spec §9; media-gen-spec §6): артефакт
 * генерирует медиа любым провайдером контракта `ImageProvider` (bfl, nano-gpt, comfy,
 * google, vertex) — картинки, видео, музыку: вид — у модели (`models()[].kind`),
 * `mime` результата — от провайдера; HTTP `/i/…` отвечает на Range (`<video>` в WebKit) —
 * ключи и вызовы на стороне хоста, в iframe их нет. Провайдеры хосту даёт
 * встраивающий (сервис nrchat — через `resolveImageProvider` runz).
 *
 *   providers() → [{name}]                       блоки `## $provider` с картинками
 *   models(provider) → ImageModelInfo[]          с ценой, edit, maxRefs
 *   schema(provider, model) → {fields, maxRefs}  форма модели
 *   generate(provider, {model, prompt, refs, subjects?, params}) → {id}   события — в канал `image` артефакта
 *   cancel(id)
 *   bytes(id, n) → Uint8Array                    результат (в слот, в буфер)
 *   save(id, n, path)                            результат на диск
 *
 * Как у `comfy`: байты по проводу не гоняются на каждый шаг — превью и
 * результат лежат в памяти хоста, событие несёт путь `/i/<key>/<id>/…`,
 * гость ставит его в `<img>`.
 */

/** Прогресс провайдера (контракт nr-contracts `ImageProgress`). */
export interface ImageProgressLike {
  stage: 'queued' | 'running' | 'downloading' | 'done'
  status?: string
  step?: number
  total?: number
  preview?: Uint8Array
}

type R<T> = { ok: true; value: T } | { ok: false; error: Error }

/** Провайдер контракта (структурно — `ImageProvider` nr-contracts). */
export interface ImageProviderLike {
  generate(req: {
    model: string
    prompt?: string
    refs?: Uint8Array[]
    subjects?: Uint8Array[]
    params?: Record<string, unknown>
    signal?: AbortSignal
    onProgress?: (e: ImageProgressLike) => void
  }): Promise<R<{ images: Uint8Array[]; mime: string; meta: Record<string, unknown> }>>
  schema?(model: string): Promise<R<unknown>>
  models?(): Promise<R<unknown[]>>
}

/** Откуда хост берёт провайдеры. */
export interface ImageSource {
  /** Имена провайдеров с картинками. */
  providers(): string[] | Promise<string[]>
  provider(name: string): Promise<ImageProviderLike>
}

export type ImageWireEvent =
  | { id: string; kind: 'progress'; stage: string; status?: string; step?: number; total?: number }
  | { id: string; kind: 'preview'; seq: number; path: string; status?: string }
  | { id: string; kind: 'done'; images: Array<{ index: number; mime: string; path: string }>; meta: Record<string, unknown>; secs: number }
  | { id: string; kind: 'error'; name: string; message: string }
  | { id: string; kind: 'cancelled' }

interface Job {
  id: string
  key: string
  controller: AbortController
  preview: { bytes: Uint8Array; mime: string; seq: number } | null
  result: { images: Uint8Array[]; mime: string } | null
  done: boolean
}

interface Channel {
  listeners: Set<(e: ImageWireEvent) => void>
  backlog: ImageWireEvent[]
}

const MAX_JOBS = 40
const MAX_BACKLOG = 200
const MAX_REFS_BYTES = 80 * 1024 * 1024

export const IMAGE_UNSET = 'image: провайдеры картинок не подключены у хоста (сервис nrchat даёт их из ~/.runz/config.md)'

const errOf = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)))

function sniff(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'image/webp'
  return 'application/octet-stream'
}

export class ImageBridge {
  private readonly providersCache = new Map<string, Promise<ImageProviderLike>>()
  private readonly jobs = new Map<string, Job>()
  private readonly channels = new Map<string, Channel>()
  private seq = 0

  constructor(
    private readonly source: ImageSource | null,
    private readonly warn: (m: string) => void,
  ) {}

  get configured(): boolean {
    return !!this.source
  }

  private src(): ImageSource {
    if (!this.source) throw new Error(IMAGE_UNSET)
    return this.source
  }

  private async provider(name: unknown): Promise<ImageProviderLike> {
    const n = typeof name === 'string' ? name.trim() : ''
    if (!n) throw new Error('image: не задан провайдер')
    const names = await this.src().providers()
    if (!names.includes(n)) throw new Error(`image: провайдера "${n}" нет; есть: ${names.join(', ') || '—'}`)
    let p = this.providersCache.get(n)
    if (!p) {
      p = this.src().provider(n)
      this.providersCache.set(n, p)
      p.catch(() => this.providersCache.get(n) === p && this.providersCache.delete(n))
    }
    return p
  }

  // ── операции моста ─────────────────────────────────────────────────────────

  async providers(): Promise<Array<{ name: string }>> {
    return (await this.src().providers()).map((name) => ({ name }))
  }

  async models(name: unknown): Promise<unknown[]> {
    const p = await this.provider(name)
    if (!p.models) return []
    const r = await p.models()
    if (!r.ok) throw r.error
    return r.value
  }

  async schema(name: unknown, model: unknown): Promise<unknown> {
    if (typeof model !== 'string' || !model) throw new Error('image.schema: нет модели')
    const p = await this.provider(name)
    if (!p.schema) return null
    const r = await p.schema(model)
    if (!r.ok) throw r.error
    return r.value ?? null
  }

  async generate(key: string, name: unknown, req: unknown, refs: Uint8Array[], subjects: Uint8Array[] = []): Promise<{ id: string }> {
    const o = (req && typeof req === 'object' ? req : {}) as Record<string, unknown>
    const model = typeof o.model === 'string' ? o.model : ''
    if (!model) throw new Error('image.generate: нет модели')
    const total = [...refs, ...subjects].reduce((a, b) => a + b.length, 0)
    if (total > MAX_REFS_BYTES) throw new Error(`image.generate: рефы больше ${MAX_REFS_BYTES >> 20} МБ`)
    const provider = await this.provider(name)
    const id = `g${Date.now().toString(36)}${(++this.seq).toString(36)}`
    const job: Job = { id, key, controller: new AbortController(), preview: null, result: null, done: false }
    this.remember(job)
    const started = Date.now()
    const onProgress = (e: ImageProgressLike): void => {
      if (e.preview && e.preview.length) {
        const seq = (job.preview?.seq ?? 0) + 1
        job.preview = { bytes: e.preview, mime: sniff(e.preview), seq }
        this.emit(key, { id, kind: 'preview', seq, path: `/i/${key}/${id}/p?seq=${seq}`, ...(e.status ? { status: e.status } : {}) })
        return
      }
      this.emit(key, {
        id,
        kind: 'progress',
        stage: e.stage,
        ...(e.status ? { status: e.status } : {}),
        ...(typeof e.step === 'number' ? { step: e.step } : {}),
        ...(typeof e.total === 'number' ? { total: e.total } : {}),
      })
    }
    void (async () => {
      try {
        const r = await provider.generate({
          model,
          ...(typeof o.prompt === 'string' ? { prompt: o.prompt } : {}),
          ...(refs.length ? { refs } : {}),
          ...(subjects.length ? { subjects } : {}),
          ...(o.params && typeof o.params === 'object' ? { params: o.params as Record<string, unknown> } : {}),
          signal: job.controller.signal,
          onProgress,
        })
        if (!r.ok) {
          if (r.error.name === 'AbortError' || job.controller.signal.aborted) this.emit(key, { id, kind: 'cancelled' })
          else this.emit(key, { id, kind: 'error', name: r.error.name, message: r.error.message })
          return
        }
        job.result = { images: r.value.images, mime: r.value.mime }
        this.emit(key, {
          id,
          kind: 'done',
          images: r.value.images.map((_, i) => ({ index: i, mime: r.value.mime, path: `/i/${key}/${id}/${i}` })),
          meta: r.value.meta,
          secs: (Date.now() - started) / 1000,
        })
      } catch (e) {
        const err = errOf(e)
        this.emit(key, { id, kind: 'error', name: err.name, message: err.message })
      } finally {
        job.done = true
      }
    })()
    return { id }
  }

  cancel(key: string, id: unknown): boolean {
    const job = this.jobs.get(String(id ?? ''))
    if (!job) return false
    if (job.key !== key) throw new Error('image.cancel: чужая генерация')
    if (job.done) return false
    job.controller.abort()
    return true
  }

  /** Байты результата `n` (с 0). */
  bytes(key: string, id: unknown, n: unknown): { bytes: Uint8Array; mime: string } {
    const job = this.jobs.get(String(id ?? ''))
    if (!job || job.key !== key) throw new Error('image: генерации нет (или она чужая)')
    if (!job.result) throw new Error('image: генерация не закончилась')
    const i = Number(n ?? 0)
    const bytes = job.result.images[i]
    if (!bytes) throw new Error(`image: картинки №${i} нет (всего ${job.result.images.length})`)
    return { bytes, mime: job.result.mime }
  }

  preview(key: string, id: string): { bytes: Uint8Array; mime: string } | null {
    const job = this.jobs.get(id)
    if (!job || job.key !== key || !job.preview) return null
    return { bytes: job.preview.bytes, mime: job.preview.mime }
  }

  // ── канал событий артефакта ────────────────────────────────────────────────

  subscribe(key: string, listener: (e: ImageWireEvent) => void): () => void {
    const ch = this.channel(key)
    ch.listeners.add(listener)
    for (const e of ch.backlog.splice(0)) listener(e)
    return () => void ch.listeners.delete(listener)
  }

  private channel(key: string): Channel {
    let ch = this.channels.get(key)
    if (!ch) this.channels.set(key, (ch = { listeners: new Set(), backlog: [] }))
    return ch
  }

  private emit(key: string, e: ImageWireEvent): void {
    const ch = this.channel(key)
    if (ch.listeners.size === 0) {
      if (e.kind === 'preview' || e.kind === 'progress') {
        const i = ch.backlog.findIndex((b) => b.kind === e.kind && b.id === e.id)
        if (i !== -1) ch.backlog.splice(i, 1)
      }
      ch.backlog.push(e)
      if (ch.backlog.length > MAX_BACKLOG) ch.backlog.splice(0, ch.backlog.length - MAX_BACKLOG)
      return
    }
    for (const l of ch.listeners) {
      try {
        l(e)
      } catch (err) {
        this.warn(`image: слушатель упал: ${errOf(err).message}`)
      }
    }
  }

  private remember(job: Job): void {
    this.jobs.set(job.id, job)
    if (this.jobs.size <= MAX_JOBS) return
    for (const [id, j] of this.jobs) {
      if (this.jobs.size <= MAX_JOBS) break
      if (j.done) this.jobs.delete(id)
    }
  }

  close(): void {
    for (const j of this.jobs.values()) if (!j.done) j.controller.abort()
    for (const ch of this.channels.values()) ch.listeners.clear()
  }
}
