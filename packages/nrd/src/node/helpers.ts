/**
 * helpers — capability-комплект, который получает тело `fn` третьим аргументом.
 *
 * Имена и сигнатуры сохранены (приёмочные файлы не правятся). ФС-хелперы не
 * ходят в `node:fs` сами, а берут её из capability-объекта хоста
 * (`ProgramCapabilities`), поэтому недоверенное звено их просто не получает.
 *
 * Провайдер LLM инъектируется хостом: резолв провайдера — дело хоста (конфиг
 * цепочки, ключи, мок в тестах), программному слою нужен стрим и (для
 * `helpers.embed`) опциональный `embed`.
 */

import { homedir } from 'node:os'
import { extname, join, resolve as resolvePath } from 'node:path'
import { asText, isArray, isContext, parseTable, unescapeOptOut } from '../core/index.js'
import type { IContext } from '../core/index.js'
import type {
  AsyncResult,
  EmbedRequest,
  EmbedResponse,
  EmbedStore,
  ImageMeta,
  ImageProgress,
  ImageProvider,
  LLMMessage,
  MediaKind,
  LLMRequest,
  ScriptMeta,
  ScriptResult,
} from '../contracts/index.js'
import { cachedEmbed } from '../web/embed.js'
import { imageExt, sniffImageMime, toBase64 } from '../web/image/bytes.js'
import { sqliteEmbedStore } from './embed-store.js'
import { requireFs, type ProgramCapabilities } from '../program/capability.js'
import { findDecl, type Decl } from '../program/registry.js'
import {
  chatMessages,
  renderTemplate,
  type RenderedMessage,
  type TemplateEnv,
} from '../program/template.js'

export interface LlmOptions {
  model?: string
  temperature?: number
  maxTokens?: number
  extra?: Record<string, unknown>
  onProgress?: (e: { tokens: number; thinking?: boolean; text?: string }) => void
  /**
   * Конец стрима: почему модель остановилась. Пустой ответ без причины не
   * разобрать — `finish_reason: SAFETY` или `block_reason` говорят «блокировка,
   * повтор не поможет».
   */
  onDone?: (e: LlmDone) => void
}

/** Итог вызова LLM: свёрнутая причина, сырой `finish_reason` провайдера, блокировка промпта. */
export interface LlmDone {
  stop_reason?: string
  finish_reason?: string
  block_reason?: string
}

/** Минимальное лицо провайдера: стрим чанков. Резолв провайдера — у хоста. */
export interface StreamChunk {
  type: string
  text?: string
  stop_reason?: string
  finish_reason?: string
  block_reason?: string
}

export interface StreamProvider {
  stream(req: LLMRequest): AsyncIterable<StreamChunk>
}

export interface EmbedOptions {
  /** Пространство (алиас шлюза); по умолчанию — `$embed_model` цепочки. */
  model?: string
  /** Прогресс докачки промахов; при полном попадании в стор не зовётся. */
  onProgress?: (done: number, total: number) => void
}

export interface ImageOptions {
  /** Модель провайдера (у BFL — путь эндпоинта); по умолчанию `$image_model ?? $model`. */
  model?: string
  /** Референсы — пути относительно `baseDir`, `~` раскрывается. Порядок сохраняется. */
  refs?: string[]
  /** Прочие поля запроса модели как есть (aspect_ratio, resolution, seed…). */
  params?: Record<string, unknown>
  /**
   * Файл результата относительно `baseDir`; расширение — по MIME ответа. N картинок —
   * `name.png`, `name-2.png`… Без `out` — `{dataDir}/image/{дата}/{время}-{n}.{ext}`.
   */
  out?: string
  /**
   * Прогресс генерации от провайдера (image-gen-2-spec §1). Без колбэка —
   * одна строка в stderr на смену `stage`/`status` (не на каждый шаг).
   */
  onProgress?: (e: ImageProgress) => void
}

/**
 * `helpers.video` (media-gen-spec §5): рефы — кадры ролика; `frame`/`lastFrame` —
 * то же короче (первый и последний кадр). Нет ни того, ни другого — text-to-video.
 */
export interface VideoOptions extends ImageOptions {
  /** Первый кадр — путь, как у `refs`. */
  frame?: string
  /** Последний кадр (где модель умеет). */
  lastFrame?: string
}

/** `helpers.audio` (media-gen-spec §4–5): рефы — картинки-вдохновение (Lyria 3). */
export type AudioOptions = ImageOptions

export interface ImageOutput {
  /** Абсолютные пути записанных картинок; рядом с каждой — `<файл>.json` (провенанс). */
  files: string[]
  meta: ImageMeta
}

/** Результат `helpers.video`/`helpers.audio` — та же форма, что у картинок. */
export type MediaOutput = ImageOutput

/** Провайдер картинок, который хост собрал из цепочки (`$image_provider ?? $provider …`). */
export interface ImageSetup {
  provider: ImageProvider
  /** Имя выбранного провайдера — для провенанса и сообщений об ошибке. */
  name: string
}

/** Дефолтный каталог CAS-стора векторов; override — `$embed_dir` цепочки. */
export const EMBED_DIR = '~/.nr/embed'

/** Провайдер плюс дефолты запроса, которые хост вычитал из цепочки. */
export interface ProviderSetup {
  /** Хост кладёт собранный LLMProvider целиком: `embed` есть не у всех транспортов. */
  provider: StreamProvider & { embed?(req: EmbedRequest): AsyncResult<EmbedResponse> }
  model: string
  temperature?: number
  maxTokens?: number
  /** Имя выбранного провайдера — для логов и сообщений об ошибке. */
  name: string
}

export interface ProgramHelpers {
  /**
   * Скалярное значение из цепочки (CLI > документ > конфиг). Ключа нет →
   * `undefined`; значение есть, но не скаляр (`$[…]`, объект) → ошибка с
   * подсказкой, чем его взять. Выход наружу: opt-out `\${` свёрнут в `${`.
   */
  attr(key: string): string | undefined
  /**
   * Список строк из цепочки: `$[a, b]` → `['a', 'b']`, одиночный скаляр →
   * `[x]`, `$[]` → `[]`. Ключа нет → `undefined`. Элемент-не-скаляр → ошибка.
   * Opt-out `\${` в элементах свёрнут, как у `attr`.
   */
  list(key: string): string[] | undefined
  /** Рендер шаблона → сообщения (шаблонизатор + разбор чат-разметки). */
  render(templateId: string, data: Record<string, unknown>): RenderedMessage[]
  /** Вызов LLM (стрим + свёртка). thinking-чанки идут только в onProgress. */
  llm(messages: RenderedMessage[], opts?: LlmOptions): Promise<string>
  /**
   * Эмбеды через CAS-стор: вектора в порядке `texts`, промахи докачиваются
   * провайдером хоста. Пространство — `opts.model ?? $embed_model`, иначе ошибка.
   */
  embed(texts: string[], opts?: EmbedOptions): Promise<Float32Array[]>
  /**
   * Эмбеды картинок через тот же CAS-стор: элемент — путь к файлу, байты или data URL; ключ — хеш data URL
   * (содержимое). Пространство — `opts.model ?? $embed_image_model`, иначе ошибка. Картинка — RGB:
   * PNG с альфой — ошибка до сети (сервер роняет на ней всю пачку), сведи на фон.
   */
  embedImages(images: (string | Uint8Array)[], opts?: EmbedOptions): Promise<Float32Array[]>
  /**
   * Картинка(и) по промпту через провайдер хоста: файлы + `.json` провенанса рядом.
   * Модель — `opts.model ?? $image_model ?? $model`, иначе ошибка.
   */
  image(prompt: string, opts?: ImageOptions): Promise<ImageOutput>
  /**
   * Ролик по промпту и/или кадрам (media-gen-spec §5): файлы `.mp4` + провенанс.
   * Модель — `opts.model ?? $video_model`; провайдер — хоста (`$video_provider …`).
   */
  video(prompt: string, opts?: VideoOptions): Promise<MediaOutput>
  /** Музыка по промпту (Lyria): модель — `opts.model ?? $audio_model`. */
  audio(prompt: string, opts?: AudioOptions): Promise<MediaOutput>
  /** Чтение .tbl → массив записей. */
  readTbl(filePath: string): Record<string, unknown>[]
  read(filePath: string): string | undefined
  write(filePath: string, content: string): void
  exists(filePath: string): boolean
  /** Базовая директория (от файла программы). */
  baseDir: string
  listDir(dirPath: string): string[]
  /** Лог в stderr. */
  log(msg: string): void
  /** Запуск другого `fn` по id. */
  run(fnId: string): Promise<ScriptResult>
}

export interface HelpersOptions {
  ctx: IContext
  meta: ScriptMeta
  decls: Decl[]
  caps: ProgramCapabilities
  provider: ProviderSetup
  /** Рендер-движок (создаётся хостом один раз). */
  env: TemplateEnv
  /** Запуск соседнего `fn` — замыкается хостом. */
  runFn: (fnId: string) => Promise<ScriptResult>
  /**
   * Провайдер картинок — лениво, по первому `helpers.image`: документ без
   * картинок не резолвит провайдер и не тянет транспорт.
   */
  image?: () => Promise<ImageSetup>
  /**
   * Провайдер медиа по виду (media-gen-spec §5) — лениво, по первому `helpers.video`/
   * `audio`; нет — `image` (тот же провайдер на все виды).
   */
  media?: (kind: MediaKind) => Promise<ImageSetup>
  /** Стор векторов; по умолчанию — sqlite в `$embed_dir ?? ~/.nr/embed`, один на процесс. */
  embedStore?: EmbedStore
}

/** sqlite-сторы процесса по каталогу: один на процесс, а не на вызов. */
const embedStores = new Map<string, EmbedStore>()

function processEmbedStore(dir: string): EmbedStore {
  let s = embedStores.get(dir)
  if (!s) embedStores.set(dir, (s = sqliteEmbedStore(dir)))
  return s
}

const elements = (n: number) =>
  `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'элемента' : 'элементов'}`

/** Человеческое имя формы значения — для текста ошибок. */
function shapeOf(v: unknown): string {
  if (isArray(v)) return `список из ${elements(v.length())}`
  if (Array.isArray(v)) return `массив из ${elements(v.length)}`
  if (isContext(v)) return 'объект (IContext)'
  return v === null ? 'null' : typeof v
}

/**
 * Строковый аргумент хелпера. Нестроку не коэрсим: `read(IArray)` уходил в
 * `path.resolve`, ловил TypeError внутри try и молча отдавал `undefined`.
 */
function needString(where: string, arg: string, v: unknown): string {
  if (typeof v === 'string') return v
  const hint = isArray(v) || Array.isArray(v) ? ' — элементы списка передавай по одному' : ''
  throw new Error(`nrd: helpers.${where} — ${arg} должен быть строкой, получен ${shapeOf(v)}${hint}`)
}

/** Простой объект данных (литерал/JSON), не класс и не IContext. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || isContext(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * Первый IArray в данных шаблона — с путём до него (`data.a.b`, `data.xs[2].c`).
 * Обходятся простые объекты и JS-массивы; IContext — аксессор шаблонизатора,
 * внутрь не лезем.
 */
function findIArray(
  v: unknown,
  path: string,
  seen: WeakSet<object> = new WeakSet(),
): { path: string; value: unknown } | undefined {
  if (isArray(v)) return { path, value: v }
  if (typeof v !== 'object' || v === null || seen.has(v)) return undefined
  if (Array.isArray(v)) {
    seen.add(v)
    for (let i = 0; i < v.length; i++) {
      const hit = findIArray(v[i], `${path}[${i}]`, seen)
      if (hit) return hit
    }
    return undefined
  }
  if (!isPlainObject(v)) return undefined
  seen.add(v)
  for (const [k, item] of Object.entries(v)) {
    const hit = findIArray(item, `${path}.${k}`, seen)
    if (hit) return hit
  }
  return undefined
}

/** `~` и `~/x` → домашний каталог; остальное как есть. */
function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** Пути результата: `out` → name.ext, name-2.ext…; без `out` — `{dir}/{время}-{n}.ext` без коллизий. */
/** Дефолтный прогресс `helpers.image`/`video`/`audio`: строка в stderr на смену stage/status, шаги — молча. */
function stderrProgress(label: string, kind: MediaKind = 'image'): (e: ImageProgress) => void {
  let last = ''
  return (e) => {
    const line = e.status ? `${e.stage} ${e.status}` : e.stage
    if (line === last) return
    last = line
    process.stderr.write(`[${kind} ${label}] ${line}\n`)
  }
}

function imagePaths(count: number, ext: string, out: string | undefined, defaultDir: string, exists: (p: string) => boolean): string[] {
  if (out) {
    const stem = out.slice(0, out.length - extname(out).length)
    return Array.from({ length: count }, (_, i) => `${stem}${i ? `-${i + 1}` : ''}.${ext}`)
  }
  const now = new Date()
  const dir = join(defaultDir, `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`)
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const paths: string[] = []
  for (let n = 1; paths.length < count; n++) {
    const p = join(dir, `${time}-${n}.${ext}`)
    if (!exists(p)) paths.push(p)
  }
  return paths
}

export function buildHelpers(o: HelpersOptions): ProgramHelpers {
  const fs = () => requireFs(o.caps, 'helpers')

  /** Генерация медиа вида `kind` (image-gen-spec §3, media-gen-spec §5): файлы + `.json` провенанса. */
  async function media(kind: MediaKind, prompt: string, opts: ImageOptions | undefined): Promise<ImageOutput> {
    const fn = kind
    needString(fn, 'prompt', prompt)
    const model =
      opts?.model ?? (kind === 'image' ? (helpers.attr('image_model') ?? helpers.attr('model')) : helpers.attr(`${kind}_model`))
    if (!model) {
      throw new Error(
        kind === 'image'
          ? 'nrd: helpers.image — нет модели: opts.model, $image_model или $model'
          : `nrd: helpers.${kind} — нет модели: opts.model или $${kind}_model`,
      )
    }
    const byKind = o.media ? () => o.media!(kind) : undefined
    const resolve = kind === 'image' ? (o.image ?? byKind) : (byKind ?? o.image)
    if (!resolve) throw new Error(`nrd: helpers.${fn} — хост не дал провайдер ${kind === 'image' ? 'картинок' : 'медиа'}`)
    const store = fs()
    if (!store.readBytes || !store.writeBytes) {
      throw new Error(`nrd: helpers.${fn} — у storage-capability нет бинарного IO (readBytes/writeBytes)`)
    }
    const refPaths = (opts?.refs ?? []).map((p, i) => needString(fn, `refs[${i}]`, p))
    const refs = refPaths.map((p) => {
      const bytes = store.readBytes!(expandHome(p))
      if (!bytes) throw new Error(`nrd: helpers.${fn} — ${kind === 'video' ? 'кадр' : 'реф'} не найден: ${p}`)
      return bytes
    })

    const setup = await resolve()
    // Вид модели — по схеме, если провайдер её знает: картинка вместо ролика — ошибка до денег.
    if (kind !== 'image' || setup.provider.schema) {
      const sc = setup.provider.schema ? await setup.provider.schema(model) : undefined
      const got = sc && sc.ok ? (sc.value?.kind ?? (sc.value ? 'image' : undefined)) : undefined
      if (got && got !== kind) {
        throw new Error(`nrd: helpers.${fn} — модель ${model} у "${setup.name}" — вида ${got}; бери helpers.${got}`)
      }
    }
    const r = await setup.provider.generate({
      model,
      prompt,
      refs,
      params: opts?.params,
      onProgress: opts?.onProgress ?? stderrProgress(`${setup.name} · ${model}`, kind),
    })
    if (!r.ok) throw r.error
    const { images, mime, meta } = r.value

    const abs = (p: string) => resolvePath(store.root, p)
    const defaultDir = join(o.meta?.dataDir || o.caps.baseDir, kind)
    const out = opts?.out !== undefined ? expandHome(needString(fn, 'opts.out', opts.out)) : undefined
    const paths = imagePaths(images.length, imageExt(mime), out, defaultDir, (p) => store.exists(p))
    const provenance = {
      kind,
      prompt,
      model,
      provider: setup.name,
      params: opts?.params ?? {},
      refs: refPaths,
      meta,
    }
    const files = paths.map((p, i) => {
      store.writeBytes!(p, images[i])
      store.write(`${p}.json`, JSON.stringify({ ...provenance, mime, index: i + 1 }, null, 2) + '\n')
      return abs(p)
    })
    return { files, meta }
  }

  const helpers: ProgramHelpers = {
    attr(key) {
      const v = o.ctx.get([key])
      if (v === undefined || v === null) return undefined
      if (isArray(v) || Array.isArray(v)) {
        throw new Error(
          `nrd: helpers.attr — ключ "${key}" — ${shapeOf(v)}, не скаляр: helpers.list('${key}')`,
        )
      }
      const text = asText(v)
      if (text === undefined) {
        throw new Error(
          `nrd: helpers.attr — ключ "${key}" — ${shapeOf(v)}, не скаляр: ctx.get(['${key}'])`,
        )
      }
      // Выход наружу: opt-out `\${` сворачивается здесь, в контексте он жив (§3.1).
      return unescapeOptOut(text)
    },

    list(key) {
      const v = o.ctx.get([key])
      if (v === undefined || v === null) return undefined
      if (isContext(v)) {
        throw new Error(
          `nrd: helpers.list — ключ "${key}" — ${shapeOf(v)}, не список: ctx.get(['${key}'])`,
        )
      }
      const items: unknown[] = isArray(v) ? [...v.iterate()] : Array.isArray(v) ? v : [v]
      return items.map((item, i) => {
        const text = isArray(item) || Array.isArray(item) ? undefined : asText(item)
        if (text === undefined) {
          throw new Error(
            `nrd: helpers.list — ключ "${key}", элемент [${i}] — ${shapeOf(item)}, не скаляр: ctx.get(['${key}'])`,
          )
        }
        return unescapeOptOut(text)
      })
    },

    render(templateId, data) {
      needString('render', 'templateId', templateId)
      // Хелперы шаблонизатора видят только JS-массивы: IArray в данных молча
      // превращался в пустоту (`{% for %}`, коллекционные хелперы) — на любой глубине.
      const bad = findIArray(data ?? {}, 'data')
      if (bad) {
        throw new Error(
          `nrd: helpers.render("${templateId}") — ${bad.path} — ${shapeOf(bad.value)} (IArray): передай helpers.list(...) или массив`,
        )
      }
      const decl = findDecl(o.decls, 'template', templateId)
      if (!decl) throw new Error(`nrd: template "${templateId}" не найден`)
      // helpers.render — контракт «дай сообщения»: текстовый результат
      // доразбирается чат-разметкой.
      const out = renderTemplate({ ...decl, parse: decl.parse ?? 'chat' }, data, o.env, o.caps)
      return typeof out === 'string' ? chatMessages(out) : out
    },

    async llm(messages, opts) {
      const req: LLMRequest = {
        model: opts?.model ?? o.provider.model,
        messages: messages as LLMMessage[],
        stream: true,
      }
      const temperature = opts?.temperature ?? o.provider.temperature
      if (temperature !== undefined) req.temperature = temperature
      const maxTokens = opts?.maxTokens ?? o.provider.maxTokens
      if (maxTokens !== undefined) req.max_tokens = maxTokens
      if (opts?.extra) req.extra = opts.extra

      let text = ''
      let tokens = 0
      const done: LlmDone = {}
      for await (const chunk of o.provider.provider.stream(req)) {
        if (chunk.type === 'text' && chunk.text) {
          text += chunk.text
          tokens += 1
          opts?.onProgress?.({ tokens, text: chunk.text })
        } else if (chunk.type === 'thinking' && chunk.text) {
          opts?.onProgress?.({ tokens, thinking: true, text: chunk.text })
        } else if (chunk.type === 'done') {
          // done приходит не единожды (finish_reason, потом usage): причины не затираются пустыми.
          for (const k of ['stop_reason', 'finish_reason', 'block_reason'] as const) if (chunk[k]) done[k] = chunk[k]
        }
      }
      opts?.onDone?.(done)
      return text
    },

    async embed(texts, opts) {
      if (!Array.isArray(texts)) {
        throw new Error(`nrd: helpers.embed — texts должен быть массивом строк, получен ${shapeOf(texts)}`)
      }
      const space = opts?.model ?? helpers.attr('embed_model')
      if (!space) {
        throw new Error('nrd: helpers.embed — нет $embed_model в цепочке (и opts.model не задан)')
      }
      const provider = o.provider.provider
      if (typeof provider.embed !== 'function') {
        throw new Error(`nrd: helpers.embed — у провайдера "${o.provider.name}" нет embed`)
      }
      const store = o.embedStore ?? processEmbedStore(helpers.attr('embed_dir') ?? EMBED_DIR)
      return cachedEmbed(texts, {
        space,
        store,
        embedder: (input) => provider.embed!({ model: space, input }),
        onProgress: opts?.onProgress,
      })
    },

    async embedImages(images, opts) {
      if (!Array.isArray(images)) {
        throw new Error(`nrd: helpers.embedImages — images должен быть массивом, получен ${shapeOf(images)}`)
      }
      const space = opts?.model ?? helpers.attr('embed_image_model')
      if (!space) {
        throw new Error('nrd: helpers.embedImages — нет $embed_image_model в цепочке (и opts.model не задан)')
      }
      const provider = o.provider.provider
      if (typeof provider.embed !== 'function') {
        throw new Error(`nrd: helpers.embedImages — у провайдера "${o.provider.name}" нет embed`)
      }
      const urls = images.map((x, i) => {
        if (typeof x === 'string' && x.startsWith('data:')) return x
        let bytes: Uint8Array | undefined
        if (typeof x === 'string') {
          const store = fs()
          if (!store.readBytes) throw new Error('nrd: helpers.embedImages — у storage-capability нет readBytes')
          bytes = store.readBytes(expandHome(x)) ?? undefined
          if (!bytes) throw new Error(`nrd: helpers.embedImages — картинка не найдена: ${x}`)
        } else if (x instanceof Uint8Array) bytes = x
        else throw new Error(`nrd: helpers.embedImages — images[${i}]: путь, байты или data URL, получен ${shapeOf(x)}`)
        const mime = sniffImageMime(bytes)
        if (!mime.startsWith('image/')) throw new Error(`nrd: helpers.embedImages — images[${i}] не картинка (${mime})`)
        // PNG IHDR: тип цвета 4 (серый + альфа) или 6 (RGBA)
        if (mime === 'image/png' && (bytes[25] === 4 || bytes[25] === 6)) {
          throw new Error(`nrd: helpers.embedImages — images[${i}] PNG с альфой: сведи на фон (RGB) до эмбеда`)
        }
        return `data:${mime};base64,${toBase64(bytes)}`
      })
      const store = o.embedStore ?? processEmbedStore(helpers.attr('embed_dir') ?? EMBED_DIR)
      return cachedEmbed(urls, {
        space,
        store,
        batch: 16,
        embedder: (input) => provider.embed!({ model: space, input, modality: 'image' }),
        onProgress: opts?.onProgress,
      })
    },

    image(prompt, opts) {
      return media('image', prompt, opts)
    },

    async video(prompt, opts) {
      const refs = [...(opts?.refs ?? [])]
      if (opts?.frame !== undefined || opts?.lastFrame !== undefined) {
        if (refs.length) throw new Error('nrd: helpers.video — кадры либо refs, либо frame/lastFrame')
        if (opts.frame === undefined) throw new Error('nrd: helpers.video — lastFrame без frame')
        refs.push(opts.frame)
        if (opts.lastFrame !== undefined) refs.push(opts.lastFrame)
      }
      return media('video', prompt, { ...opts, refs })
    },

    audio(prompt, opts) {
      return media('audio', prompt, opts)
    },

    readTbl(filePath) {
      needString('readTbl', 'filePath', filePath)
      const text = fs().read(filePath)
      if (text === undefined) throw new Error(`nrd: readTbl — файл не найден: ${filePath}`)
      return parseTable(text) as Record<string, unknown>[]
    },

    read(filePath) {
      needString('read', 'filePath', filePath)
      return fs().read(filePath)
    },

    write(filePath, content) {
      needString('write', 'filePath', filePath)
      needString('write', 'content', content)
      fs().write(filePath, content)
    },

    exists(filePath) {
      needString('exists', 'filePath', filePath)
      return fs().exists(filePath)
    },

    baseDir: o.caps.baseDir,

    listDir(dirPath) {
      needString('listDir', 'dirPath', dirPath)
      return fs().list(dirPath)
    },

    log(msg) {
      process.stderr.write(msg + '\n')
    },

    run(fnId) {
      return o.runFn(fnId)
    },
  }
  return helpers
}
