/**
 * Websocket ComfyUI (`/ws?clientId=`): типизированные события исполнения и
 * бинарные кадры превью; {@link ComfyConnection.queue} — prompt с итератором
 * событий ТОЛЬКО своего prompt, конец — на success / error / interrupt.
 *
 * Id prompt назначаем сами (`prompt_id` в `/prompt`) и подписываемся ДО
 * отправки: быстрый (кэшированный) prompt успевает закончиться раньше ответа
 * `/prompt`, и события, пришедшие до него, иначе потерялись бы.
 *
 * Бинарный кадр: 4 байта BE — тип события. 1 — превью: 4 байта BE формат
 * (1 JPEG, 2 PNG) + байты картинки, без id prompt — приписываем исполняемому
 * сейчас (последний `executing`/`progress`). 4 — превью с метаданными
 * (`supports_preview_metadata`): 4 байта BE длина JSON `{prompt_id, node_id,
 * image_type}` + JSON + картинка.
 */

import { randomUUID } from 'node:crypto'
import type { QueueOpts } from './http.js'
import { interrupt, queuePrompt, wsUrl } from './http.js'
import type { ComfyServer, ImageRef, NodeOutput, Prompt } from './types.js'

export type ComfyEvent =
  | { kind: 'status'; queueRemaining: number; sid?: string }
  | { kind: 'execution_start'; promptId: string }
  | { kind: 'execution_cached'; promptId: string; nodes: string[] }
  | { kind: 'executing'; promptId: string; node: string | null }
  | { kind: 'progress'; promptId: string; node: string | null; value: number; max: number }
  | { kind: 'executed'; promptId: string; node: string; output: NodeOutput; images: ImageRef[] }
  | { kind: 'execution_success'; promptId: string }
  | { kind: 'execution_error'; promptId: string; node: string | null; nodeType: string; message: string; exceptionType: string; traceback: string[] }
  | { kind: 'execution_interrupted'; promptId: string; node: string | null }
  | { kind: 'preview'; mime: string; bytes: Uint8Array; promptId?: string; node?: string }
  | { kind: 'other'; type: string; data: unknown }

export type TerminalKind = 'execution_success' | 'execution_error' | 'execution_interrupted'

export const isTerminal = (e: ComfyEvent): e is Extract<ComfyEvent, { kind: TerminalKind }> =>
  e.kind === 'execution_success' || e.kind === 'execution_error' || e.kind === 'execution_interrupted'

const str = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null)

/** Текстовое сообщение `{type, data}` → событие. */
export function parseMessage(msg: { type?: unknown; data?: unknown }): ComfyEvent {
  const type = String(msg.type ?? '')
  const d = (msg.data && typeof msg.data === 'object' ? msg.data : {}) as Record<string, unknown>
  const promptId = str(d.prompt_id) ?? ''
  switch (type) {
    case 'status': {
      const info = (d.status as { exec_info?: { queue_remaining?: number } } | undefined)?.exec_info
      return { kind: 'status', queueRemaining: Number(info?.queue_remaining ?? 0), ...(typeof d.sid === 'string' ? { sid: d.sid } : {}) }
    }
    case 'execution_start':
      return { kind: 'execution_start', promptId }
    case 'execution_cached':
      return { kind: 'execution_cached', promptId, nodes: Array.isArray(d.nodes) ? d.nodes.map(String) : [] }
    case 'executing':
      return { kind: 'executing', promptId, node: str(d.node) }
    case 'progress':
      return { kind: 'progress', promptId, node: str(d.node), value: Number(d.value ?? 0), max: Number(d.max ?? 0) }
    case 'executed': {
      const output = (d.output && typeof d.output === 'object' ? d.output : {}) as NodeOutput
      return { kind: 'executed', promptId, node: str(d.node) ?? '', output, images: Array.isArray(output.images) ? output.images : [] }
    }
    case 'execution_success':
      return { kind: 'execution_success', promptId }
    case 'execution_error':
      return {
        kind: 'execution_error',
        promptId,
        node: str(d.node_id),
        nodeType: String(d.node_type ?? ''),
        message: String(d.exception_message ?? 'execution error').trim(),
        exceptionType: String(d.exception_type ?? ''),
        traceback: Array.isArray(d.traceback) ? d.traceback.map(String) : [],
      }
    case 'execution_interrupted':
      return { kind: 'execution_interrupted', promptId, node: str(d.node_id) }
    default:
      return { kind: 'other', type, data: msg.data }
  }
}

const IMAGE_MIME: Record<number, string> = { 1: 'image/jpeg', 2: 'image/png' }

/** Бинарный кадр → превью; незнакомый тип — null. */
export function parseBinary(buf: ArrayBuffer | Uint8Array): Extract<ComfyEvent, { kind: 'preview' }> | null {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  if (bytes.length < 8) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const event = view.getUint32(0)
  if (event === 1) {
    const mime = IMAGE_MIME[view.getUint32(4)]
    return mime ? { kind: 'preview', mime, bytes: bytes.slice(8) } : null
  }
  if (event === 4) {
    const len = view.getUint32(4)
    if (8 + len > bytes.length) return null
    let meta: { prompt_id?: string; node_id?: string; display_node_id?: string; image_type?: string } = {}
    try {
      meta = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + len))) as typeof meta
    } catch {
      return null
    }
    return {
      kind: 'preview',
      mime: meta.image_type || 'image/jpeg',
      bytes: bytes.slice(8 + len),
      ...(meta.prompt_id ? { promptId: meta.prompt_id } : {}),
      ...(meta.display_node_id || meta.node_id ? { node: String(meta.display_node_id ?? meta.node_id) } : {}),
    }
  }
  return null
}

export interface JobResult {
  status: 'success' | 'error' | 'interrupted'
  /** Картинки всех `executed` этого prompt. */
  images: ImageRef[]
  error?: string
}

/** Поставленный prompt: async-итератор его событий (один потребитель) + итог. */
export interface ComfyJob extends AsyncIterable<ComfyEvent> {
  readonly promptId: string
  readonly number: number
  /** Итог — резолвится и без итерации. */
  readonly done: Promise<JobResult>
  /** Прервать (исполняется) или снять с очереди (ждёт). */
  cancel(): Promise<'interrupted' | 'deleted' | 'none'>
}

export interface ComfyConnection {
  readonly server: ComfyServer
  readonly clientId: string
  readonly closed: boolean
  /** Все события соединения (и чужих prompt — `status`). */
  on(listener: (e: ComfyEvent) => void): () => void
  /** Поставить prompt; события — только его. Превью по умолчанию — `auto` (соединение ради них и открыто). */
  queue(prompt: Prompt, opts?: Omit<QueueOpts, 'clientId'>): Promise<ComfyJob>
  close(): void
}

export interface ConnectOpts {
  clientId?: string
  /** Таймаут открытия сокета, мс. Default 10 000. */
  timeoutMs?: number
  /** Своя реализация WebSocket (тесты). Default — глобальный (Node ≥ 22). */
  WebSocket?: typeof WebSocket
}

/** Превью в буфере неитерируемого job: держим последние, байты не копим. */
const MAX_BUFFERED_PREVIEWS = 2

/** Открыть websocket. Резолвится на open. */
export function connect(server: ComfyServer, opts: ConnectOpts = {}): Promise<ComfyConnection> {
  const clientId = opts.clientId ?? randomUUID()
  const WS = opts.WebSocket ?? globalThis.WebSocket
  if (!WS) return Promise.reject(new Error('comfy: нет глобального WebSocket (нужен Node ≥ 22)'))
  const ws = new WS(wsUrl(server, clientId))
  ws.binaryType = 'arraybuffer'
  const listeners = new Set<(e: ComfyEvent) => void>()
  const jobs = new Map<string, JobState>()
  /** Исполняемое сейчас — для превью без метаданных. */
  let current: { promptId: string; node: string | null } | null = null
  let closed = false

  const dispatch = (e: ComfyEvent): void => {
    if (e.kind === 'executing' || e.kind === 'progress') current = e.promptId ? { promptId: e.promptId, node: e.node } : current
    if (e.kind === 'execution_start') current = { promptId: e.promptId, node: null }
    if (e.kind === 'preview' && !e.promptId && current) {
      e = { ...e, promptId: current.promptId, ...(current.node ? { node: current.node } : {}) }
    }
    for (const l of listeners) l(e)
    const pid = 'promptId' in e ? e.promptId : undefined
    if (pid) jobs.get(pid)?.push(e)
    if (e.kind === 'executing' && e.node === null) {
      // Старый сервер без execution_success: executing(null) — конец prompt.
      const job = jobs.get(e.promptId)
      if (job && !job.ended) job.push({ kind: 'execution_success', promptId: e.promptId })
      if (current?.promptId === e.promptId) current = null
    }
  }

  const failAll = (reason: string): void => {
    for (const job of jobs.values()) job.fail(new Error(reason))
    jobs.clear()
  }

  return new Promise<ComfyConnection>((resolveP, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`comfy: websocket ${wsUrl(server, clientId)} не открылся за ${opts.timeoutMs ?? 10_000} мс`))
      try {
        ws.close()
      } catch {
        // уже закрыт
      }
    }, opts.timeoutMs ?? 10_000)

    ws.addEventListener('open', () => {
      clearTimeout(timer)
      // Превью с id prompt и ноды (тип 4) — сервер шлёт, если клиент заявил.
      try {
        ws.send(JSON.stringify({ type: 'feature_flags', data: { supports_preview_metadata: true } }))
      } catch {
        // старый сервер — превью типом 1
      }
      resolveP(conn)
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      if (!closed) reject(new Error(`comfy: websocket ${wsUrl(server, clientId)} — ошибка соединения`))
    })
    ws.addEventListener('close', () => {
      clearTimeout(timer)
      closed = true
      failAll('comfy: websocket закрыт до конца prompt')
    })
    ws.addEventListener('message', (ev: MessageEvent) => {
      const data: unknown = ev.data
      if (typeof data === 'string') {
        let msg: { type?: unknown; data?: unknown }
        try {
          msg = JSON.parse(data) as typeof msg
        } catch {
          return
        }
        dispatch(parseMessage(msg))
      } else if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
        const p = parseBinary(data)
        if (p) dispatch(p)
      }
    })

    const conn: ComfyConnection = {
      server,
      clientId,
      get closed() {
        return closed
      },
      on(listener) {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
      async queue(prompt, qopts = {}) {
        if (closed) throw new Error('comfy: соединение закрыто')
        const promptId = qopts.promptId ?? randomUUID()
        const state = new JobState(server, promptId)
        jobs.set(promptId, state)
        void state.done.finally(() => jobs.get(promptId) === state && jobs.delete(promptId))
        try {
          const q = await queuePrompt(server, prompt, { preview: 'auto', ...qopts, promptId, clientId })
          state.number = q.number
        } catch (e) {
          jobs.delete(promptId)
          throw e
        }
        return state.job()
      },
      close() {
        closed = true
        try {
          ws.close()
        } catch {
          // уже закрыт
        }
        failAll('comfy: соединение закрыто')
      },
    }
  })
}

/** Состояние одного prompt: буфер событий, ожидающий потребитель, итог. */
class JobState {
  number = 0
  ended = false
  private buffer: ComfyEvent[] = []
  private waiting: ((r: IteratorResult<ComfyEvent>) => void) | null = null
  private failWaiting: ((e: Error) => void) | null = null
  private error: Error | null = null
  private images: ImageRef[] = []
  private resolveDone!: (r: JobResult) => void
  readonly done: Promise<JobResult>

  constructor(
    private readonly server: ComfyServer,
    readonly promptId: string,
  ) {
    this.done = new Promise((r) => (this.resolveDone = r))
  }

  push(e: ComfyEvent): void {
    if (this.ended) return
    if (e.kind === 'executed') this.images.push(...e.images)
    if (isTerminal(e)) {
      this.ended = true
      this.resolveDone(
        e.kind === 'execution_success'
          ? { status: 'success', images: this.images }
          : e.kind === 'execution_error'
            ? { status: 'error', images: this.images, error: `${e.nodeType} [${e.node ?? '?'}]: ${e.message}` }
            : { status: 'interrupted', images: this.images },
      )
    }
    if (this.waiting) {
      const w = this.waiting
      this.waiting = null
      this.failWaiting = null
      w({ value: e, done: false })
      return
    }
    if (e.kind === 'preview') {
      const previews = this.buffer.filter((b) => b.kind === 'preview')
      if (previews.length >= MAX_BUFFERED_PREVIEWS) this.buffer.splice(this.buffer.indexOf(previews[0]!), 1)
    }
    this.buffer.push(e)
  }

  fail(err: Error): void {
    if (this.ended) return
    this.ended = true
    this.error = err
    this.resolveDone({ status: 'error', images: this.images, error: err.message })
    if (this.failWaiting) {
      const f = this.failWaiting
      this.waiting = null
      this.failWaiting = null
      f(err)
    }
  }

  job(): ComfyJob {
    const self = this
    let finished = false
    return {
      promptId: this.promptId,
      number: this.number,
      done: this.done,
      async cancel() {
        const r = await interrupt(self.server, self.promptId)
        // Снятый с очереди prompt сервер не объявит — событие делаем сами.
        if (r === 'deleted') self.push({ kind: 'execution_interrupted', promptId: self.promptId, node: null })
        return r
      },
      [Symbol.asyncIterator](): AsyncIterator<ComfyEvent> {
        return {
          next(): Promise<IteratorResult<ComfyEvent>> {
            if (finished) return Promise.resolve({ value: undefined, done: true })
            const e = self.buffer.shift()
            if (e) {
              if (isTerminal(e)) finished = true
              return Promise.resolve({ value: e, done: false })
            }
            if (self.ended) {
              finished = true
              return self.error ? Promise.reject(self.error) : Promise.resolve({ value: undefined, done: true })
            }
            return new Promise((resolveP, reject) => {
              self.waiting = (r) => {
                if (!r.done && isTerminal(r.value)) finished = true
                resolveP(r)
              }
              self.failWaiting = reject
            })
          },
          return(): Promise<IteratorResult<ComfyEvent>> {
            finished = true
            return Promise.resolve({ value: undefined, done: true })
          },
        }
      },
    }
  }
}

/**
 * Поставить prompt и получить события только его. Без `connection` — своё
 * соединение на время prompt (закрывается на конце).
 */
export async function queue(server: ComfyServer, prompt: Prompt, opts: Omit<QueueOpts, 'clientId'> & { connection?: ComfyConnection; clientId?: string } = {}): Promise<ComfyJob> {
  const { connection, clientId, ...qopts } = opts
  const conn = connection ?? (await connect(server, clientId ? { clientId } : {}))
  try {
    const job = await conn.queue(prompt, qopts)
    if (!connection) void job.done.finally(() => conn.close())
    return job
  } catch (e) {
    if (!connection) conn.close()
    throw e
  }
}
