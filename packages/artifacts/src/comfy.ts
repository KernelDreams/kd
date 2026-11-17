/**
 * Capability `comfy` моста: артефакт генерирует картинки ComfyUI
 * с прогрессом и превью, не зная адреса сервера и не ходя в него сам.
 * Транспорт — бэкенд: он видит ComfyUI в LAN, гость (вкладка, телефон через
 * туннель) — только бэкенд; CORS не нужен. Клиент — `@kerneldreams/comfy-client`.
 *
 *   parse(bytes) → {prompt?, workflow?}      метаданные PNG
 *   objectInfo(classes?) → схемы нод          кэш на процесс
 *   inputs(prompt) → EditableInput[]         виджеты для формы
 *   upload(bytes, name) → {filename, subfolder, type, value}   value — для LoadImage.image
 *   queue(prompt, {workflow?}) → {id}        события — в канал артефакта (`events`)
 *   interrupt(id)
 *   view(image) → путь `/c/<key>/view?…`    байты — HTTP хоста (и через бэкенд)
 *   save(image, {prompt, workflow}, path)    PNG с воркфлоу на диск
 *
 * Превью по проводу не едут base64 на каждый шаг: хост держит последнее
 * превью job в памяти, событие несёт путь `/c/<key>/p/<id>?seq=n`, гость
 * ставит его в `<img>` — картинку отдаёт HTTP хоста (удалённому клиенту —
 * маршрут бэкенда `/services/artifacts/http/…`, как статику).
 */

import type { ComfyConnection, ComfyEvent, ComfyJob, ImageRef, ObjectInfo, Prompt, UiWorkflow } from '@kerneldreams/comfy-client'
import { connect, editableInputs, embedWorkflow, imageInputValue, interrupt, isPng, objectInfo, parsePng, upload, view } from '@kerneldreams/comfy-client'

/** Картинка в событии гостю: адрес сервера + путь для `<img>`. */
export interface WireImage extends ImageRef {
  path: string
}

/** Событие job для гостя (канал `comfy`). */
export type ComfyWireEvent =
  | { id: string; kind: 'execution_start' }
  | { id: string; kind: 'execution_cached'; nodes: string[] }
  | { id: string; kind: 'executing'; node: string | null }
  | { id: string; kind: 'progress'; node: string | null; value: number; max: number }
  | { id: string; kind: 'preview'; mime: string; seq: number; path: string; node?: string }
  | { id: string; kind: 'executed'; node: string; images: WireImage[] }
  | { id: string; kind: 'execution_success'; images: WireImage[] }
  | { id: string; kind: 'execution_error'; message: string; node?: string | null; nodeType?: string }
  | { id: string; kind: 'execution_interrupted' }

interface Job {
  id: string
  key: string
  prompt: Prompt
  workflow: UiWorkflow | null
  handle: ComfyJob | null
  preview: { mime: string; bytes: Uint8Array; seq: number } | null
  images: ImageRef[]
  done: boolean
}

interface Channel {
  listeners: Set<(e: ComfyWireEvent) => void>
  /** События без слушателя (вкладка ещё не открыла стрим) — отдаются при подписке. */
  backlog: ComfyWireEvent[]
}

const MAX_JOBS = 100
const MAX_BACKLOG = 200
const MAX_UPLOAD = 50 * 1024 * 1024

export const COMFY_UNSET = 'comfy: адрес ComfyUI не задан — `$comfy: http://host:8188` в окружении бэкенда (pi-nr.mdz) или NR_COMFY'

export class ComfyBridge {
  private conn: Promise<ComfyConnection> | null = null
  private readonly jobs = new Map<string, Job>()
  private readonly channels = new Map<string, Channel>()

  constructor(
    private readonly server: string | null,
    private readonly warn: (m: string) => void,
    /** Открыть websocket (тесты подменяют). */
    private readonly open: (server: string) => Promise<ComfyConnection> = connect,
  ) {}

  get configured(): boolean {
    return !!this.server
  }

  private srv(): string {
    if (!this.server) throw new Error(COMFY_UNSET)
    return this.server
  }

  /** Одно соединение на хост; закрылось — откроется заново. */
  private connection(): Promise<ComfyConnection> {
    const srv = this.srv()
    if (!this.conn) {
      this.conn = this.open(srv).then(
        (c) => c,
        (e: unknown) => {
          this.conn = null
          throw e
        },
      )
    }
    return this.conn.then((c) => {
      if (!c.closed) return c
      this.conn = null
      return this.connection()
    })
  }

  // ── пути для <img> ─────────────────────────────────────────────────────────

  viewPath(key: string, image: ImageRef): string {
    const q = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type || 'output' })
    return `/c/${key}/view?${q}`
  }

  private wireImages(key: string, images: ImageRef[]): WireImage[] {
    return images.map((i) => ({ filename: i.filename, subfolder: i.subfolder ?? '', type: i.type || 'output', path: this.viewPath(key, i) }))
  }

  // ── операции моста ─────────────────────────────────────────────────────────

  parse(bytes: Uint8Array): { prompt?: Prompt; workflow?: UiWorkflow } {
    if (!isPng(bytes)) throw new Error('comfy.parse: нужен PNG (байты картинки ComfyUI)')
    return parsePng(bytes)
  }

  async objectInfo(classes?: unknown): Promise<ObjectInfo> {
    const info = await objectInfo(this.srv())
    if (!Array.isArray(classes) || classes.length === 0) return info
    const out: ObjectInfo = {}
    for (const c of classes) if (typeof c === 'string' && info[c]) out[c] = info[c]
    return out
  }

  async inputs(prompt: unknown): Promise<ReturnType<typeof editableInputs>> {
    if (!prompt || typeof prompt !== 'object') throw new Error('comfy.inputs: нужен prompt (API-формат)')
    return editableInputs(prompt as Prompt, await objectInfo(this.srv()))
  }

  async upload(bytes: Uint8Array, name: unknown): Promise<ImageRef & { value: string }> {
    if (bytes.length === 0) throw new Error('comfy.upload: пустые байты')
    if (bytes.length > MAX_UPLOAD) throw new Error(`comfy.upload: больше ${MAX_UPLOAD >> 20} МБ`)
    const safe = String(name ?? '').split(/[\\/]/).pop()?.trim() || `upload-${Date.now()}.png`
    const ref = await upload(this.srv(), bytes, safe)
    return { ...ref, value: imageInputValue(ref) }
  }

  async queue(key: string, prompt: unknown, opts: { workflow?: unknown } | null): Promise<{ id: string; number: number }> {
    if (!prompt || typeof prompt !== 'object') throw new Error('comfy.queue: нужен prompt (API-формат)')
    const conn = await this.connection()
    const workflow = opts?.workflow && typeof opts.workflow === 'object' ? (opts.workflow as UiWorkflow) : null
    const handle = await conn.queue(prompt as Prompt, workflow ? { workflow } : {})
    const job: Job = { id: handle.promptId, key, prompt: prompt as Prompt, workflow, handle, preview: null, images: [], done: false }
    this.remember(job)
    void this.pump(job, handle)
    return { id: job.id, number: handle.number }
  }

  async interrupt(key: string, id: unknown): Promise<string> {
    const jobId = String(id ?? '')
    const job = this.jobs.get(jobId)
    if (job && job.key !== key) throw new Error('comfy.interrupt: чужой job')
    if (job?.done) return 'none'
    if (job?.handle) return job.handle.cancel()
    if (!jobId) throw new Error('comfy.interrupt: нет id')
    return interrupt(this.srv(), jobId)
  }

  /** Байты PNG с воркфлоу: метаданные — переданные, иначе job, из которого картинка. Пишет на диск хост (путь проверен там). */
  async saveBytes(image: unknown, meta: { prompt?: unknown; workflow?: unknown } | null): Promise<Uint8Array> {
    const ref = toImageRef(image)
    let bytes: Uint8Array = await view(this.srv(), ref)
    const job = [...this.jobs.values()].find((j) => j.images.some((i) => i.filename === ref.filename && (i.subfolder ?? '') === ref.subfolder && i.type === ref.type))
    const prompt = (meta?.prompt as Prompt | undefined) ?? job?.prompt
    const workflow = (meta?.workflow as UiWorkflow | undefined) ?? job?.workflow ?? undefined
    if (isPng(bytes) && (prompt || workflow)) {
      // Не затираем то, что уже вписал сервер, пустотой: нет своего workflow — берём из файла.
      const own = parsePng(bytes)
      bytes = embedWorkflow(bytes, { prompt: prompt ?? own.prompt ?? null, workflow: workflow ?? own.workflow ?? null })
    }
    return bytes
  }

  // ── HTTP хоста: /c/<key>/view, /c/<key>/p/<id> ─────────────────────────────

  async fetchView(query: URLSearchParams): Promise<{ mime: string; bytes: Uint8Array }> {
    const ref = toImageRef({ filename: query.get('filename'), subfolder: query.get('subfolder') ?? '', type: query.get('type') ?? 'output' })
    const bytes = await view(this.srv(), ref)
    return { mime: mimeOf(ref.filename), bytes }
  }

  preview(key: string, id: string): { mime: string; bytes: Uint8Array } | null {
    const job = this.jobs.get(id)
    if (!job || job.key !== key || !job.preview) return null
    return { mime: job.preview.mime, bytes: job.preview.bytes }
  }

  // ── канал событий артефакта ────────────────────────────────────────────────

  subscribe(key: string, listener: (e: ComfyWireEvent) => void): () => void {
    const ch = this.channel(key)
    ch.listeners.add(listener)
    const backlog = ch.backlog.splice(0)
    for (const e of backlog) listener(e)
    return () => void ch.listeners.delete(listener)
  }

  private channel(key: string): Channel {
    let ch = this.channels.get(key)
    if (!ch) this.channels.set(key, (ch = { listeners: new Set(), backlog: [] }))
    return ch
  }

  private emit(key: string, e: ComfyWireEvent): void {
    const ch = this.channel(key)
    if (ch.listeners.size === 0) {
      // Превью без слушателя копить незачем — оставляем последнее.
      if (e.kind === 'preview') {
        const i = ch.backlog.findIndex((b) => b.kind === 'preview' && b.id === e.id)
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
        this.warn(`comfy: слушатель упал: ${(err as Error).message}`)
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

  private async pump(job: Job, handle: ComfyJob): Promise<void> {
    const id = job.id
    try {
      for await (const e of handle) this.forward(job, e)
    } catch (err) {
      this.emit(job.key, { id, kind: 'execution_error', message: (err as Error).message })
    } finally {
      job.done = true
      job.handle = null
    }
  }

  private forward(job: Job, e: ComfyEvent): void {
    const id = job.id
    const key = job.key
    switch (e.kind) {
      case 'execution_start':
        return this.emit(key, { id, kind: 'execution_start' })
      case 'execution_cached':
        return this.emit(key, { id, kind: 'execution_cached', nodes: e.nodes })
      case 'executing':
        return this.emit(key, { id, kind: 'executing', node: e.node })
      case 'progress':
        return this.emit(key, { id, kind: 'progress', node: e.node, value: e.value, max: e.max })
      case 'preview': {
        const seq = (job.preview?.seq ?? 0) + 1
        job.preview = { mime: e.mime, bytes: e.bytes, seq }
        return this.emit(key, { id, kind: 'preview', mime: e.mime, seq, path: `/c/${key}/p/${encodeURIComponent(id)}?seq=${seq}`, ...(e.node ? { node: e.node } : {}) })
      }
      case 'executed':
        job.images.push(...e.images)
        return this.emit(key, { id, kind: 'executed', node: e.node, images: this.wireImages(key, e.images) })
      case 'execution_success':
        return this.emit(key, { id, kind: 'execution_success', images: this.wireImages(key, job.images) })
      case 'execution_error':
        return this.emit(key, { id, kind: 'execution_error', message: e.message, node: e.node, nodeType: e.nodeType })
      case 'execution_interrupted':
        return this.emit(key, { id, kind: 'execution_interrupted' })
      default:
        return
    }
  }

  close(): void {
    const c = this.conn
    this.conn = null
    void c?.then((x) => x.close()).catch(() => {})
    for (const ch of this.channels.values()) ch.listeners.clear()
  }
}

function toImageRef(v: unknown): ImageRef {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const filename = typeof o.filename === 'string' ? o.filename : ''
  if (!filename || /[\\/]/.test(filename)) throw new Error('comfy: картинка — {filename, subfolder, type} из события executed')
  const subfolder = typeof o.subfolder === 'string' ? o.subfolder : ''
  if (subfolder.split(/[\\/]/).includes('..')) throw new Error('comfy: недопустимый subfolder')
  const type = typeof o.type === 'string' && /^(output|temp|input)$/.test(o.type) ? o.type : 'output'
  return { filename, subfolder, type }
}

const mimeOf = (name: string): string => {
  const ext = name.toLowerCase().split('.').pop()
  return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : ext === 'mp4' ? 'video/mp4' : ext === 'webm' ? 'video/webm' : 'image/png'
}
