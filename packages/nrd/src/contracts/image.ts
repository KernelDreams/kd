/**
 * Генерация медиа — контракт провайдера (image-gen-spec §1, media-gen-spec §1).
 *
 * Один контракт на картинки, видео и музыку: модель объявляет вид выхода
 * (`ImageModelInfo.kind` / `ImageModelSchema.kind`: `image` | `video` | `audio`),
 * запрос тот же (промпт, рефы, параметры по схеме модели, `onProgress`),
 * результат — файлы этого вида (`mime` говорит какого). Имена `Image*` —
 * исторические, `Media*` — их алиасы.
 *
 * Транспорт-нейтральный словарь: модель, промпт, референсы байтами и прочие
 * поля запроса модели как есть. Раскладку рефов по полям модели и приведение
 * типов делает адаптер — он знает схему своего API. Реализации — в nrd/web
 * (`bflImageProvider`), хост выбирает провайдер по конфигу.
 */

import type { AsyncResult, Result } from './result.js'

export interface ImageRequest {
  /** У BFL — путь эндпоинта: `'flux-3-image'`, `'flux-2-pro'`, `'flux-tools/erase-v1'`. */
  model: string
  prompt?: string
  /**
   * Референсы по порядку; адаптер раскладывает их под поля модели. У модели с
   * `refRole: 'frames'` (видео) — кадры: первый начинает ролик, последний
   * (если модель умеет и рефов ≥ 2) его заканчивает; без рефов — text-to-video.
   */
  refs?: Uint8Array[]
  /**
   * Рефы персонажа/объекта — отдельно от кадров: у видео держат героя между
   * роликами (Veo 3.1 `referenceImages`, до 3). Модель без `maxSubjects` их не принимает.
   */
  subjects?: Uint8Array[]
  /**
   * Маска инпейнта: PNG того же размера, что `refs[0]`, белое = править.
   * Только у модели со `schema.mask` / `ImageModelInfo.mask`.
   */
  mask?: Uint8Array
  /** Прочие поля запроса модели как есть (aspect_ratio, resolution, seed, width…). */
  params?: Record<string, unknown>
  signal?: AbortSignal
  /**
   * Прогресс генерации (image-gen-2-spec §1). Провайдер зовёт на каждой смене
   * `stage`/`status`/`step`; исключение колбэка генерацию не роняет.
   */
  onProgress?: (e: ImageProgress) => void
}

/** Событие прогресса генерации. */
export interface ImageProgress {
  stage: 'queued' | 'running' | 'downloading' | 'done'
  /** Сырой статус провайдера: BFL `'Pending'` | `'Reasoning'` | …, comfy — имя/id ноды. */
  status?: string
  /** Шаг сэмплера (comfy). */
  step?: number
  total?: number
  /** Превью латента (comfy), jpeg/png как пришло. */
  preview?: Uint8Array
}

/** Вид выхода модели. */
export type MediaKind = 'image' | 'video' | 'audio'

/**
 * Роль рефов модели: `reference` — образцы (персонаж, стиль, правка), `frames` —
 * кадры ролика (первый, последний). Нет — `reference`.
 */
export type MediaRefRole = 'reference' | 'frames'

/** Модель провайдера в списке `models()`. */
export interface ImageModelInfo {
  id: string
  name?: string
  /** Вид выхода; нет — `image`. */
  kind?: MediaKind
  /** Роль рефов; нет — `reference`. */
  refRole?: MediaRefRole
  /** Принимает референсы (правка / img2img). */
  edit?: boolean
  /** Инпейнт: принимает `ImageRequest.mask` (правится `refs[0]` под маской). */
  mask?: boolean
  maxRefs?: number
  /** Сколько рефов персонажа (`ImageRequest.subjects`) модель принимает; нет — не принимает. */
  maxSubjects?: number
  /** Модель умеет пакетный режим провайдера (`ImageProvider.generateBatch`). */
  batch?: boolean
  /** Цена строкой провайдера, без пересчёта: `'$0.05/1k, $0.12/2k'`, `'3 cr'`. */
  price?: string
}

export interface ImageMeta {
  model: string
  /** Id задачи у провайдера. */
  id?: string
  /** Стоимость в единицах провайдера (у BFL — кредиты). */
  cost?: number
  /**
   * Единица `cost`: `'credits'` (BFL), `'usd'` (nano-gpt), `'tokens'` (Gemini image,
   * Lyria — токены ответа), `'seconds'` (Veo — секунды ролика). Без пересчёта в деньги.
   */
  cost_unit?: string
  seed?: number
  [k: string]: unknown
}

export interface ImageResult {
  /** Файлы результата — вида модели (картинки, ролики, треки); имя поля историческое. */
  images: Uint8Array[]
  /**
   * По сигнатуре байтов: `'image/png'` | `'image/jpeg'` | `'image/webp'`,
   * `'video/mp4'` | `'video/webm'`, `'audio/mpeg'` | `'audio/wav'` | `'audio/ogg'`.
   */
  mime: string
  meta: ImageMeta
}

/** Поле запроса модели (из схемы транспорта). */
export interface ImageModelField {
  /** `'string'` | `'integer'` | `'number'` | `'boolean'` | `'array'` | … ; несколько — через `|`. */
  type: string
  enum?: unknown[]
  min?: number
  max?: number
  /** Поле принимает картинку (base64 / URL). */
  image?: boolean
  /** Поле принимает массив. */
  array?: boolean
}

export interface ImageModelSchema {
  fields: Record<string, ImageModelField>
  /** Сколько рефов модель принимает; нет — рефы не поддерживаются. */
  maxRefs?: number
  /** Сколько рефов персонажа (`ImageRequest.subjects`) модель принимает. */
  maxSubjects?: number
  /** Вид выхода; нет — `image`. */
  kind?: MediaKind
  /** Роль рефов; нет — `reference`. */
  refRole?: MediaRefRole
  /** Инпейнт: принимает `ImageRequest.mask`. */
  mask?: boolean
}

/** Опции пакетного прогона. */
export interface ImageBatchOptions {
  signal?: AbortSignal
  /** Состояние пакета: `queued` → `running` (status — сырое состояние провайдера) → `downloading` → `done`. */
  onProgress?: (e: ImageProgress) => void
  /** Имя пакета у провайдера (видно в его консоли). */
  name?: string
}

export interface ImageProvider {
  generate(req: ImageRequest): AsyncResult<ImageResult>
  /** Схема параметров модели (имя → тип/enum), если транспорт её знает. */
  schema?(model: string): AsyncResult<ImageModelSchema | undefined>
  /** Список моделей провайдера, если транспорт его знает. */
  models?(): AsyncResult<ImageModelInfo[]>
  /**
   * Пакетный режим: все запросы одной моделью одним пакетом у провайдера — дешевле,
   * но асинхронно (минуты–часы; Gemini Batch API — −50%). Ответ — по запросу, в том же порядке;
   * `meta.batch` — имя пакета. Внешний `err` — пакет не создан/не дождались; ошибка одного
   * запроса — его элемент. Есть не у всех провайдеров и моделей (`ImageModelInfo.batch`).
   */
  generateBatch?(reqs: ImageRequest[], opts?: ImageBatchOptions): AsyncResult<Result<ImageResult>[]>
}

/**
 * Имена ошибок провайдера картинок (`Error.name`):
 * `AuthError` — 401/403; `RateLimitError` — 429 после ретраев;
 * `ModerationError` — модерация запроса или результата; `ImageError` — прочее.
 */
export type ImageErrorName = 'AuthError' | 'RateLimitError' | 'ModerationError' | 'ImageError'

/** Ошибка провайдера картинок: `Error` с `name` из словаря и телом ответа, если было. */
export function imageError(name: ImageErrorName, message: string, body?: string): Error & { body?: string } {
  const e = new Error(message) as Error & { body?: string }
  e.name = name
  if (body !== undefined) e.body = body
  return e
}

// ---------- Алиасы media-gen (media-gen-spec §1): тот же контракт, имя по смыслу ----------

export type MediaRequest = ImageRequest
export type MediaProgress = ImageProgress
export type MediaModelInfo = ImageModelInfo
export type MediaMeta = ImageMeta
export type MediaResult = ImageResult
export type MediaModelField = ImageModelField
export type MediaModelSchema = ImageModelSchema
export type MediaProvider = ImageProvider
export type MediaBatchOptions = ImageBatchOptions
