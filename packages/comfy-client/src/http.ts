/**
 * HTTP API ComfyUI: `/prompt`, `/history`, `/view`, `/upload/image`,
 * `/interrupt`, `/queue`, `/object_info`. Вынесено из `appz/comfy/lib/api.ts`
 *: там же живут имена `submitPrompt`/`waitForResult`/`viewImage`/
 * `uploadImage`, их держим совместимыми.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { ComfyServer, HistoryEntry, ImageRef, ObjectInfo, Prompt, UiWorkflow } from './types.js'

/** `host:port` | `http(s)://host:port[/база]` → `http(s)://host:port[/база]` без хвостового `/`. */
export function baseUrl(server: ComfyServer): string {
  const s = String(server ?? '').trim().replace(/\/+$/, '')
  if (!s) throw new Error('comfy: не задан адрес сервера')
  return /^https?:\/\//i.test(s) ? s : `http://${s}`
}

/** Адрес websocket: `ws(s)://…/ws?clientId=`. */
export function wsUrl(server: ComfyServer, clientId: string): string {
  return `${baseUrl(server).replace(/^http/i, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`
}

interface ErrorBody {
  error?: { type?: string; message?: string; details?: string; extra_info?: Record<string, unknown> } | string
  node_errors?: Record<string, { errors?: Array<{ message?: string; details?: string; extra_info?: Record<string, unknown> }>; class_type?: string }>
}

/** Ошибка `/prompt` (валидация графа) → читаемый текст. */
export function formatPromptError(data: ErrorBody): string {
  const parts: string[] = []
  if (typeof data.error === 'string') parts.push(data.error)
  else if (data.error) {
    parts.push(`${data.error.type ?? 'error'}: ${data.error.message ?? ''}`.trim())
    if (data.error.details) parts.push(`  ${data.error.details}`)
  }
  for (const [nodeId, nodeErr] of Object.entries(data.node_errors ?? {})) {
    for (const err of nodeErr.errors ?? []) {
      const input = typeof err.extra_info?.input_name === 'string' ? err.extra_info.input_name : ''
      parts.push(`  node [${nodeId}]${input ? '.' + input : ''}: ${err.message ?? ''}`)
      if (err.details) parts.push(`    ${err.details.substring(0, 200)}`)
    }
  }
  return parts.join('\n') || 'Unknown error'
}

/** Ошибка исполнения из записи `/history` → текст; нет ошибки — null. */
export function formatStatusError(entry: HistoryEntry): string | null {
  if (!entry.status) return null
  if (entry.status.status_str !== 'error' && entry.status.completed) return null
  const parts: string[] = [`Execution failed (status: ${entry.status.status_str})`]
  for (const [type, data] of entry.status.messages ?? []) {
    if (type !== 'execution_error') continue
    parts.push(`  ${String(data.node_type ?? '')} [${String(data.node_id ?? '')}]: ${String(data.exception_message ?? '')}`)
    const tb = data.traceback as string[] | undefined
    if (tb?.length) parts.push(`  ${tb[tb.length - 1]?.trim()}`)
  }
  return parts.join('\n')
}

async function request(server: ComfyServer, path: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response> {
  const { timeoutMs, ...rest } = init ?? {}
  try {
    return await fetch(`${baseUrl(server)}${path}`, { ...rest, ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}) })
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code
    throw new Error(`ComfyUI ${baseUrl(server)} недоступен (${path}): ${cause ?? (e as Error).message}`)
  }
}

export interface QueueOpts {
  /** Клиент websocket, которому сервер шлёт события и превью этого prompt. */
  clientId?: string
  /** Свой id prompt (ComfyUI принимает `prompt_id`) — чтобы подписаться ДО отправки. */
  promptId?: string
  /** UI-граф: сервер впишет его в PNG (`extra_pnginfo.workflow`), как фронт ComfyUI. */
  workflow?: UiWorkflow | null
  /** В начало очереди. */
  front?: boolean
  /**
   * Метод превью этого prompt (`extra_data.preview_method`): сервер без
   * `--preview-method` превью не шлёт вовсе. `auto` — TAESD, если есть, иначе
   * latent2rgb. Не задано — как настроен сервер.
   */
  preview?: 'auto' | 'latent2rgb' | 'taesd' | 'none' | 'default'
}

export interface Queued {
  promptId: string
  /** Номер в очереди сервера. */
  number: number
}

/** Поставить prompt в очередь. Ошибка валидации — throw с разбором `node_errors`. */
export async function queuePrompt(server: ComfyServer, prompt: Prompt, opts: QueueOpts = {}): Promise<Queued> {
  const promptId = opts.promptId ?? randomUUID()
  const body: Record<string, unknown> = { prompt, prompt_id: promptId }
  if (opts.clientId) body.client_id = opts.clientId
  const extra: Record<string, unknown> = {}
  if (opts.workflow) extra.extra_pnginfo = { workflow: opts.workflow }
  if (opts.preview) extra.preview_method = opts.preview
  if (Object.keys(extra).length) body.extra_data = extra
  if (opts.front) body.front = true
  const res = await request(server, '/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await res.text()
  let data: { prompt_id?: string; number?: number } & ErrorBody = {}
  try {
    data = JSON.parse(text) as typeof data
  } catch {
    // не JSON
  }
  if (!res.ok || data.error || (data.node_errors && Object.keys(data.node_errors).length > 0)) {
    throw new Error(data.error || data.node_errors ? formatPromptError(data) : `ComfyUI /prompt ${res.status}: ${text.slice(0, 300)}`)
  }
  return { promptId: data.prompt_id ?? promptId, number: data.number ?? 0 }
}

/** Совместимость с appz/comfy: поставить и вернуть id. */
export async function submitPrompt(server: ComfyServer, prompt: Prompt): Promise<string> {
  return (await queuePrompt(server, prompt)).promptId
}

/** Запись `/history/{id}`; ещё не готово — null. */
export async function history(server: ComfyServer, promptId: string): Promise<HistoryEntry | null> {
  const res = await request(server, `/history/${encodeURIComponent(promptId)}`)
  if (!res.ok) return null
  const data = (await res.json()) as Record<string, HistoryEntry>
  return data[promptId] ?? null
}

/**
 * Опрос `/history/{id}` до результата; ошибка исполнения — throw.
 * `timeoutMs` ограничивает всё ожидание (prompt, потерянный сервером, иначе
 * опрашивался бы вечно). 0 — без предела.
 */
export async function waitForResult(server: ComfyServer, promptId: string, pollInterval = 1000, timeoutMs = 0): Promise<HistoryEntry> {
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity
  for (;;) {
    const entry = await history(server, promptId).catch(() => null)
    if (entry) {
      const err = formatStatusError(entry)
      if (err) throw new Error(err)
      return entry
    }
    if (Date.now() >= deadline) throw new Error(`timeout: no result for prompt ${promptId} after ${Math.round(timeoutMs / 1000)}s`)
    await new Promise((r) => setTimeout(r, pollInterval))
  }
}

/** Все картинки записи истории. */
export function collectOutputFiles(entry: Pick<HistoryEntry, 'outputs'>): ImageRef[] {
  const files: ImageRef[] = []
  for (const out of Object.values(entry.outputs ?? {})) if (out.images) files.push(...out.images)
  return files
}

/** Байты картинки `/view`. */
export async function view(server: ComfyServer, image: ImageRef): Promise<Buffer> {
  const params = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type || 'output' })
  const res = await request(server, `/view?${params}`)
  if (!res.ok) throw new Error(`ComfyUI /view ${res.status} for ${image.filename}`)
  return Buffer.from(await res.arrayBuffer())
}

/** Совместимость с appz/comfy. */
export function viewImage(server: ComfyServer, filename: string, subfolder: string, type: string): Promise<Buffer> {
  return view(server, { filename, subfolder, type })
}

export interface UploadOpts {
  /** Подпапка в `input/`. */
  subfolder?: string
  /** `input` (default) | `temp` | `output`. */
  type?: string
  /** Перезаписать файл с тем же именем (иначе сервер добавит суффикс). */
  overwrite?: boolean
}

/**
 * Загрузить картинку в `input/` сервера. Возвращает, где она легла; значение
 * для `LoadImage.image` — {@link imageInputValue}.
 */
export async function upload(server: ComfyServer, bytes: Uint8Array, name: string, opts: UploadOpts = {}): Promise<ImageRef> {
  const form = new FormData()
  form.append('image', new Blob([bytes as Uint8Array<ArrayBuffer>]), name)
  if (opts.subfolder) form.append('subfolder', opts.subfolder)
  if (opts.type) form.append('type', opts.type)
  if (opts.overwrite) form.append('overwrite', 'true')
  const res = await request(server, '/upload/image', { method: 'POST', body: form })
  if (!res.ok) throw new Error(`ComfyUI /upload/image ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = (await res.json()) as { name: string; subfolder?: string; type?: string }
  return { filename: data.name, subfolder: data.subfolder ?? '', type: data.type ?? 'input' }
}

/** Значение входа `LoadImage.image` для загруженной картинки: `подпапка/имя`. */
export const imageInputValue = (ref: ImageRef): string => (ref.subfolder ? `${ref.subfolder}/${ref.filename}` : ref.filename)

/** Совместимость с appz/comfy: загрузить локальный файл, вернуть имя на сервере. */
export async function uploadImage(server: ComfyServer, localPath: string): Promise<string> {
  return imageInputValue(await upload(server, readFileSync(localPath), basename(localPath)))
}

export interface QueueState {
  running: string[]
  pending: string[]
}

/** Id prompt в работе и в ожидании. */
export async function queueState(server: ComfyServer): Promise<QueueState> {
  const res = await request(server, '/queue')
  if (!res.ok) throw new Error(`ComfyUI /queue ${res.status}`)
  const data = (await res.json()) as { queue_running?: unknown[][]; queue_pending?: unknown[][] }
  const ids = (list: unknown[][] | undefined): string[] => (list ?? []).map((item) => String(item[1]))
  return { running: ids(data.queue_running), pending: ids(data.queue_pending) }
}

/**
 * Прервать. Без `promptId` — текущее исполнение сервера (как было в appz/comfy,
 * ошибки глотаются: зовут на выходе). С `promptId`: ждёт в очереди — снимается
 * (`deleted`, событий от сервера не будет), исполняется — прерывается
 * (`interrupted`, придёт `execution_interrupted`), иначе — `none`.
 */
export async function interrupt(server: ComfyServer, promptId?: string): Promise<'interrupted' | 'deleted' | 'none'> {
  if (!promptId) {
    try {
      await request(server, '/interrupt', { method: 'POST' })
    } catch {
      // выходим — не до того
    }
    return 'interrupted'
  }
  const q = await queueState(server)
  if (q.pending.includes(promptId)) {
    await request(server, '/queue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delete: [promptId] }) })
    return 'deleted'
  }
  if (q.running.includes(promptId)) {
    await request(server, '/interrupt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt_id: promptId }) })
    return 'interrupted'
  }
  return 'none'
}

const infoCache = new Map<string, Promise<ObjectInfo>>()

/**
 * `/object_info` — схемы всех нод сервера (мегабайты). Кэш на процесс по
 * адресу; `refresh` — перечитать (поставили ноды, добавили модели).
 */
export function objectInfo(server: ComfyServer, opts: { refresh?: boolean } = {}): Promise<ObjectInfo> {
  const key = baseUrl(server)
  let p = opts.refresh ? undefined : infoCache.get(key)
  if (!p) {
    p = (async () => {
      const res = await request(server, '/object_info', { timeoutMs: 60_000 })
      if (!res.ok) throw new Error(`ComfyUI /object_info ${res.status}`)
      return (await res.json()) as ObjectInfo
    })()
    infoCache.set(key, p)
    // Упавший запрос не кэшируем: следующий вызов попробует снова.
    p.catch(() => infoCache.get(key) === p && infoCache.delete(key))
  }
  return p
}
