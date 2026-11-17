/**
 * ComfyUI за контрактом `ImageProvider` (image-gen-2-spec §4).
 *
 * Модель = шаблон: файл в каталоге шаблонов (`*.json` — API-граф или UI-граф,
 * `*.png` — с вшитым графом), `id` — имя файла без расширения. Схема модели =
 * роли шаблона ({@link roles}): prompt, negative, width/height, seed, steps,
 * denoise; рефы — по слотам `refs`. Других полей нет: тонкая настройка графа —
 * дело `appz/comfy` и его профилей, не этого контракта.
 *
 * generate: граф → роли → рефы загружаются (`/upload/image`) в слоты по
 * порядку, пустые слоты — {@link pruneEmptyLoaders} → очередь через WS с
 * прогрессом (нода, шаги, превью латента) → картинки истории.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import {
  err,
  imageError,
  ok,
  type AsyncResult,
  type ImageModelField,
  type ImageModelInfo,
  type ImageModelSchema,
  type ImageProgress,
  type ImageProvider,
  type ImageResult,
} from '@kerneldreams/nrd/contracts'
import { imageInputValue, objectInfo, upload, view } from './http.js'
import { parsePng } from './png.js'
import { PruneError, pruneEmptyLoaders } from './prune.js'
import { roles, type Roles } from './roles.js'
import type { ComfyServer, ImageRef, ObjectInfo, Prompt, UiWorkflow } from './types.js'
import { detect, uiToApi } from './ui2api.js'
import { connect } from './ws.js'

export interface ComfyProviderOptions {
  /** `host:port` или `http(s)://host:port`. */
  server: ComfyServer
  /** Каталог(и) шаблонов; при совпадении имён побеждает первый. */
  templatesDir: string | string[]
  /** Общий таймаут генерации, мс. Дефолт 30 мин. */
  timeout?: number
  /** Своя реализация WebSocket (тесты). */
  WebSocket?: typeof WebSocket
}

const DEFAULT_TIMEOUT = 30 * 60_000
const SEED_MAX = 2 ** 50

interface Template {
  id: string
  file: string
  prompt: Prompt
  workflow?: UiWorkflow
  roles: Roles
  info?: ObjectInfo
}

const errOf = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)))

/** Имена чекпойнтов сервера (`/object_info`), если известны. */
function ckptNames(info: ObjectInfo | undefined): unknown[] | undefined {
  const spec = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name as unknown[] | undefined
  const head = spec?.[0]
  if (Array.isArray(head)) return head
  const opts = (spec?.[1] as { options?: unknown } | undefined)?.options
  return Array.isArray(opts) ? opts : undefined
}

/** Поля схемы по ролям шаблона. */
function schemaOf(r: Roles, info?: ObjectInfo): ImageModelSchema {
  const fields: Record<string, ImageModelField> = {}
  if (r.prompt) fields.prompt = { type: 'string' }
  if (r.negative) fields.negative = { type: 'string' }
  if (r.size) {
    fields.width = { type: 'integer', min: 16 }
    fields.height = { type: 'integer', min: 16 }
  }
  if (r.seed) fields.seed = { type: 'integer', min: -1 }
  if (r.steps) fields.steps = { type: 'integer', min: 1 }
  if (r.denoise) fields.denoise = { type: 'number', min: 0, max: 1 }
  if (r.ckpt) {
    const names = ckptNames(info)
    fields.ckpt = { type: 'string', ...(names ? { enum: names } : {}) }
  }
  const schema: ImageModelSchema = { fields }
  if (r.refs.length) schema.maxRefs = r.refs.length
  if (r.mask) schema.mask = true
  return schema
}

/** Значение параметра к типу поля; строка — текст ошибки. */
function coerce(name: string, v: unknown, f: ImageModelField): { value: unknown } | string {
  let value = v
  if (f.type !== 'string' && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) value = Number(v)
  if (f.type === 'string') {
    if (typeof value !== 'string') return `параметр "${name}": ожидается string`
    return { value }
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return `параметр "${name}": ожидается ${f.type}, получено ${JSON.stringify(v)}`
  if (f.type === 'integer' && !Number.isInteger(value)) return `параметр "${name}": ожидается integer, получено ${value}`
  if (f.min !== undefined && value < f.min) return `параметр "${name}": ${value} меньше минимума ${f.min}`
  if (f.max !== undefined && value > f.max) return `параметр "${name}": ${value} больше максимума ${f.max}`
  return { value }
}

const nodeLabel = (p: Prompt, id: string): string => {
  const n = p[id]
  const t = n?._meta?.title
  return t ? String(t) : n ? `${n.class_type} [${id}]` : id
}

const extOf = (b: Uint8Array): string => (b[0] === 0xff && b[1] === 0xd8 ? 'jpg' : b[0] === 0x52 && b[1] === 0x49 ? 'webp' : 'png')

function mimeOf(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'image/webp'
  return 'application/octet-stream'
}

/**
 * Человеческое имя шаблона — из шапки его профиля `<id>.md` рядом с графом: первая строка
 * `// qwen21-edit — Qwen-Image 2.1 Edit: промпт + до 10 рефов…` → «Qwen-Image 2.1 Edit» (до `:` `,` `(` или «. »).
 * Профиля или шапки нет — `undefined` (имя в каталоге — id).
 */
export function templateName(file: string, id: string): string | undefined {
  let head: string
  try {
    head = readFileSync(join(dirname(file), `${id}.md`), 'utf8').split('\n', 1)[0] ?? ''
  } catch {
    return undefined
  }
  const m = /^\/\/\s*(\S+)\s+[—–-]+\s+(.+)$/.exec(head.trim())
  if (!m || m[1] !== id) return undefined
  const name = m[2]!.split(/[:,(]|\.\s|\.$/)[0]!.trim()
  return name || undefined
}

/** ComfyUI-провайдер картинок: модель = шаблон из `templatesDir`. */
export function comfyImageProvider(opts: ComfyProviderOptions): ImageProvider & {
  /** Шаблон по id: API-граф, UI-граф (если был), роли — для UI поверх контракта. */
  template(id: string): Promise<Template>
} {
  const dirs = Array.isArray(opts.templatesDir) ? opts.templatesDir : [opts.templatesDir]
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT
  const server = opts.server

  /** id → файл; первый каталог побеждает. Читается на каждый вызов: шаблоны добавляют на ходу. */
  function files(): Map<string, string> {
    const out = new Map<string, string>()
    for (const dir of dirs) {
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch {
        continue
      }
      for (const name of names.sort((a, b) => a.localeCompare(b))) {
        const ext = extname(name).toLowerCase()
        if (ext !== '.json' && ext !== '.png') continue
        const id = name.slice(0, -ext.length)
        const file = join(dir, name)
        if (out.has(id)) continue
        try {
          if (!statSync(file).isFile()) continue
        } catch {
          continue
        }
        out.set(id, file)
      }
    }
    return out
  }

  const info = (): Promise<ObjectInfo | undefined> => objectInfo(server).catch(() => undefined)

  const cache = new Map<string, { mtime: number; t: Template }>()

  async function template(id: string): Promise<Template> {
    const file = files().get(id)
    if (!file) {
      const all = [...files().keys()]
      throw imageError('ImageError', `comfy: шаблона ${id} нет; есть: ${all.slice(0, 30).join(', ')}${all.length > 30 ? '…' : ''}`)
    }
    const mtime = statSync(file).mtimeMs
    const hit = cache.get(file)
    if (hit && hit.mtime === mtime) return hit.t
    const bytes = readFileSync(file)
    let found: { prompt?: Prompt; workflow?: UiWorkflow }
    if (extname(file).toLowerCase() === '.png') {
      const meta = parsePng(bytes)
      found = { ...(meta.prompt ? { prompt: meta.prompt } : {}), ...(meta.workflow ? { workflow: meta.workflow } : {}) }
      if (!found.prompt && !found.workflow) throw imageError('ImageError', `comfy: в ${file} нет вшитого графа`)
    } else {
      try {
        found = detect(JSON.parse(bytes.toString('utf8')))
      } catch (e) {
        throw imageError('ImageError', `comfy: ${file} — ${errOf(e).message}`)
      }
    }
    const oi = await info()
    let prompt = found.prompt
    if (!prompt) {
      if (!oi) throw imageError('ImageError', `comfy: ${id} — UI-граф, а /object_info сервера ${server} недоступен`)
      prompt = uiToApi(found.workflow, oi).prompt
    }
    const t: Template = { id, file, prompt, roles: roles(prompt, oi), ...(found.workflow ? { workflow: found.workflow } : {}), ...(oi ? { info: oi } : {}) }
    cache.set(file, { mtime, t })
    return t
  }

  return {
    template,

    async models(): AsyncResult<ImageModelInfo[]> {
      const list: ImageModelInfo[] = []
      for (const id of files().keys()) {
        try {
          const t = await template(id)
          const n = t.roles.refs.length
          const name = templateName(t.file, id)
          list.push({ id, ...(name ? { name } : {}), edit: n > 0, ...(n ? { maxRefs: n } : {}), ...(t.roles.mask ? { mask: true } : {}) })
        } catch {
          // не шаблон (или UI-граф без сервера) — в списке нет
        }
      }
      return ok(list)
    },

    async schema(model): AsyncResult<ImageModelSchema | undefined> {
      try {
        const t = await template(model)
        return ok(schemaOf(t.roles, t.info))
      } catch (e) {
        return err(errOf(e))
      }
    },

    async generate(req): AsyncResult<ImageResult> {
      const progress = (e: ImageProgress): void => {
        try {
          req.onProgress?.(e)
        } catch (x) {
          console.warn(`comfy: onProgress бросил исключение — ${errOf(x).message}`)
        }
      }
      let t: Template
      try {
        t = await template(req.model)
      } catch (e) {
        return err(errOf(e))
      }
      const schema = schemaOf(t.roles, t.info)
      const fieldList = Object.keys(schema.fields).join(', ') || '—'
      const values: Record<string, unknown> = {}
      if (req.prompt !== undefined) {
        if (!t.roles.prompt) return err(imageError('ImageError', `comfy ${req.model}: у шаблона нет роли prompt; поля: ${fieldList}`))
        values.prompt = req.prompt
      }
      for (const [k, v] of Object.entries(req.params ?? {})) {
        if (v === undefined) continue
        const f = schema.fields[k]
        if (!f) return err(imageError('ImageError', `comfy ${req.model}: параметр "${k}" — нет у шаблона; поля: ${fieldList}`))
        if (k === 'prompt' && req.prompt !== undefined) return err(imageError('ImageError', 'prompt задан и аргументом, и в params'))
        const c = coerce(k, v, f)
        if (typeof c === 'string') return err(imageError('ImageError', `comfy ${req.model}: ${c}`))
        values[k] = c.value
      }
      const refs = req.refs ?? []
      if (refs.length > t.roles.refs.length) {
        return err(
          imageError(
            'ImageError',
            t.roles.refs.length ? `comfy ${req.model}: шаблон принимает до ${t.roles.refs.length} реф., передано ${refs.length}` : `comfy ${req.model}: шаблон не принимает референсы`,
          ),
        )
      }

      if (req.mask && !t.roles.mask) return err(imageError('ImageError', `comfy ${req.model}: шаблон не принимает маску (нет LoadImage с титулом mask)`))
      if (t.roles.mask && !req.mask) return err(imageError('ImageError', `comfy ${req.model}: шаблон инпейнта — нужна маска (mask)`))
      if (t.roles.mask && refs.length === 0) return err(imageError('ImageError', `comfy ${req.model}: шаблон инпейнта — нужна картинка (refs[0])`))

      const p = structuredClone(t.prompt)
      const set = (role: { nodeId: string; input: string } | null, v: unknown): void => {
        if (role && v !== undefined && p[role.nodeId]) p[role.nodeId]!.inputs[role.input] = v
      }
      set(t.roles.prompt, values.prompt)
      set(t.roles.negative, values.negative)
      if (t.roles.size) {
        if (values.width !== undefined) p[t.roles.size.nodeId]!.inputs.width = values.width
        if (values.height !== undefined) p[t.roles.size.nodeId]!.inputs.height = values.height
      }
      let seed: number | undefined
      if (t.roles.seed) {
        const s = values.seed as number | undefined
        seed = s === undefined || s < 0 ? Math.floor(Math.random() * SEED_MAX) : s
        set(t.roles.seed, seed)
      }
      set(t.roles.steps, values.steps)
      set(t.roles.denoise, values.denoise)
      set(t.roles.ckpt, values.ckpt)
      // Чекпойнта шаблона нет на этом сервере (шаблон комплекта на чистой машине) — первый стоящий, а не
      // отказ ComfyUI «value not in list».
      if (t.roles.ckpt && values.ckpt === undefined) {
        const names = (ckptNames(t.info) ?? []).map(String)
        const node = p[t.roles.ckpt.nodeId]
        if (node && names.length && !names.includes(String(node.inputs[t.roles.ckpt.input]))) node.inputs[t.roles.ckpt.input] = names[0]
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('timeout')), timeout)
      const onOuter = (): void => controller.abort(req.signal!.reason)
      if (req.signal) {
        if (req.signal.aborted) onOuter()
        else req.signal.addEventListener('abort', onOuter, { once: true })
      }
      let conn: Awaited<ReturnType<typeof connect>> | undefined
      try {
        // Рефы: загрузить и вписать в слоты по порядку, пустые — prune.
        for (let i = 0; i < t.roles.refs.length; i++) {
          const slot = t.roles.refs[i]!
          let value = ''
          if (i < refs.length) {
            const r = await upload(server, refs[i]!, `nrimg-${randomUUID()}.${extOf(refs[i]!)}`)
            value = imageInputValue(r)
          }
          if (p[slot.nodeId]) p[slot.nodeId]!.inputs[slot.input] = value
        }
        if (t.roles.mask && req.mask) {
          const r = await upload(server, req.mask, `nrmask-${randomUUID()}.${extOf(req.mask)}`)
          set(t.roles.mask, imageInputValue(r))
        }
        try {
          pruneEmptyLoaders(p, t.info)
        } catch (e) {
          if (e instanceof PruneError) return err(imageError('ImageError', `comfy ${req.model}: ${e.message}`))
          throw e
        }
        if (controller.signal.aborted) throw controller.signal.reason

        conn = await connect(server, opts.WebSocket ? { WebSocket: opts.WebSocket } : {})
        const job = await conn.queue(p, t.workflow ? { workflow: t.workflow } : {})
        progress({ stage: 'queued' })
        const onAbort = (): void => void job.cancel().catch(() => undefined)
        controller.signal.addEventListener('abort', onAbort, { once: true })

        let node: string | null = null
        for await (const e of job) {
          if (e.kind === 'executing' && e.node) {
            node = nodeLabel(p, e.node)
            progress({ stage: 'running', status: node })
          } else if (e.kind === 'progress') {
            progress({ stage: 'running', ...(node ? { status: node } : {}), step: e.value, total: e.max })
          } else if (e.kind === 'preview') {
            progress({ stage: 'running', ...(node ? { status: node } : {}), preview: e.bytes })
          }
        }
        const end = await job.done
        controller.signal.removeEventListener('abort', onAbort)
        if (end.status === 'interrupted' || controller.signal.aborted) throw controller.signal.reason ?? new Error('interrupted')
        if (end.status === 'error') return err(imageError('ImageError', `comfy ${req.model}: ${end.error ?? 'ошибка исполнения'}`))

        const outputs = end.images.filter((i: ImageRef) => i.type === 'output')
        const refsOut = outputs.length ? outputs : end.images
        if (!refsOut.length) return err(imageError('ImageError', `comfy ${req.model}: исполнено, но картинок нет`))
        progress({ stage: 'downloading' })
        const images: Uint8Array[] = []
        for (const r of refsOut) images.push(new Uint8Array(await view(server, r)))
        progress({ stage: 'done' })
        const meta: ImageResult['meta'] = { model: req.model, id: job.promptId }
        if (seed !== undefined) meta.seed = seed
        return ok({ images, mime: mimeOf(images[0]!), meta })
      } catch (e) {
        if (controller.signal.aborted) {
          if (req.signal?.aborted) {
            const a = new Error('comfy: запрос отменён')
            a.name = 'AbortError'
            return err(a)
          }
          return err(imageError('ImageError', `comfy ${req.model}: таймаут ${timeout} мс`))
        }
        return err(errOf(e))
      } finally {
        clearTimeout(timer)
        req.signal?.removeEventListener('abort', onOuter)
        conn?.close()
      }
    },
  }
}
