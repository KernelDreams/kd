/**
 * a1111 — провайдер картинок файлом: Automatic1111 / Forge / SD.Next по `sdapi/v1`.
 * Образец провайдера-файла: скопируй в `~/.runz/providers/<type>.ts` или `<стенд>/providers/` и правь —
 * без импортов рантайма (только `import type`), контракт — `ImageProvider` из `@kerneldreams/nrd/contracts`.
 *
 *   ## $provider sd
 *   $type: a1111
 *   $base_url: http://127.0.0.1:7860      // нет — этот адрес
 *   $api_key: user:pass                   // необязателен: --api-auth сервера (Basic)
 *   $timeout: 600000
 *
 * Модели — чекпойнты `GET /sdapi/v1/sd-models` (`id` — title, его же шлём `override_settings.sd_model_checkpoint`;
 * `default` — без переключения). Без рефов — `POST /sdapi/v1/txt2img`; с рефом — `img2img` (`init_images`,
 * маска — `mask`). Сэмплеры схемы — `GET /sdapi/v1/samplers`. Прогресс — опрос `GET /sdapi/v1/progress`.
 */

import type { IContext } from '@kerneldreams/nrd'
import type { ImageModelField, ImageModelInfo, ImageModelSchema, ImageProvider, ImageRequest } from '@kerneldreams/nrd/contracts'

export const kind = 'image'

interface Cfg {
  name: string
  baseUrl?: string
  apiKey?: string
  timeout?: number
}

type Json = Record<string, unknown>
type Res<T> = { ok: true; value: T } | { ok: false; error: Error }

const DEFAULT_URL = 'http://127.0.0.1:7860'
const DEFAULT_TIMEOUT = 600_000
const DEFAULT_MODEL = 'default'

const okR = <T>(value: T): Res<T> => ({ ok: true, value })
const errR = (error: Error): Res<never> => ({ ok: false, error })

function imageError(name: 'AuthError' | 'ImageError', message: string, body?: string): Error {
  const e = new Error(message) as Error & { body?: string }
  e.name = name
  if (body !== undefined) e.body = body
  return e
}

const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64')
const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s.replace(/^data:[^,]*,/, ''), 'base64'))

function sniff(u: Uint8Array): string {
  if (u[0] === 0x89 && u[1] === 0x50) return 'image/png'
  if (u[0] === 0xff && u[1] === 0xd8) return 'image/jpeg'
  if (u[0] === 0x52 && u[1] === 0x49 && u[8] === 0x57 && u[9] === 0x45) return 'image/webp'
  return 'image/png'
}

/** Поля запроса (имена — sdapi; `n` → `batch_size`). */
function fields(samplers: string[]): Record<string, ImageModelField> {
  return {
    prompt: { type: 'string' },
    negative_prompt: { type: 'string' },
    width: { type: 'integer', min: 64, max: 2048 },
    height: { type: 'integer', min: 64, max: 2048 },
    steps: { type: 'integer', min: 1, max: 150 },
    cfg_scale: { type: 'number', min: 1, max: 30 },
    sampler_name: samplers.length ? { type: 'string', enum: samplers } : { type: 'string' },
    seed: { type: 'integer', min: -1 },
    n: { type: 'integer', min: 1, max: 8 },
    denoising_strength: { type: 'number', min: 0, max: 1 },
  }
}

export default function a1111(cfg: Cfg, _ctx?: IContext): ImageProvider {
  const base = (cfg.baseUrl || DEFAULT_URL).replace(/\/+$/, '')
  const timeout = Number(cfg.timeout) || DEFAULT_TIMEOUT
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cfg.apiKey) headers.authorization = 'Basic ' + Buffer.from(cfg.apiKey).toString('base64')

  async function call(path: string, body?: Json, signal?: AbortSignal): Promise<Res<unknown>> {
    const sig = AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])])
    let res: Response
    try {
      res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal: sig })
    } catch (e) {
      return errR(imageError('ImageError', `a1111 ${cfg.name}: ${base}${path} — ${e instanceof Error ? e.message : String(e)}`))
    }
    const text = await res.text()
    if (res.status === 401 || res.status === 403) return errR(imageError('AuthError', `a1111 ${cfg.name}: ${res.status} — нужен $api_key user:pass (--api-auth)`, text))
    if (!res.ok) {
      let msg = text.slice(0, 500)
      try {
        const j = JSON.parse(text) as Json
        msg = String(j.detail ?? j.error ?? j.errors ?? msg)
      } catch {
        // не JSON — текст как есть
      }
      return errR(imageError('ImageError', `a1111 ${cfg.name}: ${path} ${res.status} — ${msg}`, text))
    }
    try {
      return okR(JSON.parse(text))
    } catch {
      return errR(imageError('ImageError', `a1111 ${cfg.name}: ${path} — ответ не JSON (это точно sdapi? ${base})`, text.slice(0, 500)))
    }
  }

  let samplers: Promise<string[]> | undefined
  const samplerList = (): Promise<string[]> =>
    (samplers ??= call('/sdapi/v1/samplers').then((r) => (r.ok && Array.isArray(r.value) ? r.value.map((s) => String((s as Json).name)).filter(Boolean) : [])))

  const schemaOf = async (): Promise<ImageModelSchema> => ({ fields: fields(await samplerList()), maxRefs: 1, mask: true })

  return {
    async models() {
      const r = await call('/sdapi/v1/sd-models')
      if (!r.ok) return r
      if (!Array.isArray(r.value)) return errR(imageError('ImageError', `a1111 ${cfg.name}: /sdapi/v1/sd-models — не список`))
      const list: ImageModelInfo[] = r.value.map((m) => {
        const o = m as Json
        return { id: String(o.title ?? o.model_name), name: String(o.model_name ?? o.title), edit: true, mask: true, maxRefs: 1 }
      })
      return okR(list)
    },

    async schema() {
      return okR(await schemaOf())
    },

    async generate(req: ImageRequest) {
      const p = { ...(req.params ?? {}) } as Json
      const n = Math.max(1, Number(p.n) || 1)
      delete p.n
      const body: Json = { prompt: req.prompt ?? '', ...p, batch_size: n }
      if (req.model && req.model !== DEFAULT_MODEL) {
        body.override_settings = { ...((p.override_settings as Json | undefined) ?? {}), sd_model_checkpoint: req.model }
      }
      const ref = req.refs?.[0]
      if (ref) {
        body.init_images = [b64(ref)]
        if (req.mask) body.mask = b64(req.mask)
      }
      const path = ref ? '/sdapi/v1/img2img' : '/sdapi/v1/txt2img'

      // Прогресс — опросом, пока идёт запрос; сбой колбэка генерацию не роняет.
      const emit = (e: Parameters<NonNullable<ImageRequest['onProgress']>>[0]): void => {
        try {
          req.onProgress?.(e)
        } catch {
          // колбэк хоста — не наша ошибка
        }
      }
      emit({ stage: 'queued' })
      let polling = !!req.onProgress
      const poll = async (): Promise<void> => {
        while (polling) {
          await new Promise((r) => setTimeout(r, 1000))
          if (!polling) break
          const r = await call('/sdapi/v1/progress?skip_current_image=true')
          if (!polling || !r.ok) continue
          const st = ((r.value as Json).state ?? {}) as Json
          const step = Number(st.sampling_step)
          const total = Number(st.sampling_steps)
          if (total > 0) emit({ stage: 'running', step, total })
        }
      }
      const poller = poll()
      const r = await call(path, body, req.signal)
      polling = false
      await poller
      if (!r.ok) return r

      const out = r.value as Json
      const raw = Array.isArray(out.images) ? (out.images as unknown[]).filter((x): x is string => typeof x === 'string') : []
      if (!raw.length) return errR(imageError('ImageError', `a1111 ${cfg.name}: ${path} — нет картинок в ответе`))
      // Forge/ControlNet докладывает служебные картинки после основных — берём первые n.
      const images = raw.slice(0, n).map(unb64)
      let seed: number | undefined
      try {
        const info = typeof out.info === 'string' ? (JSON.parse(out.info) as Json) : ((out.info ?? {}) as Json)
        if (typeof info.seed === 'number') seed = info.seed
      } catch {
        // info не JSON — без сида
      }
      emit({ stage: 'done' })
      return okR({ images, mime: sniff(images[0]), meta: { model: req.model, ...(seed !== undefined ? { seed } : {}) } })
    },
  }
}
