/**
 * Вложения (attachments-spec §2–3): правила `attachments.put`, общие для бэкендов.
 *
 * Здесь, а не в каждом бэкенде, по той же причине, что и `mergeSessionMeta`:
 * «что считается текстом», «сколько токенов» и «когда отказать» — часть
 * контракта `put`, а не деталь хранилища. backend-pi и store-backend обязаны
 * отвечать одинаково, иначе фикстура nrchat врала бы про живой бэкенд.
 *
 * Чистые функции над байтами, zero-dep: TextDecoder есть и в node, и в браузере.
 */

import type { AttachmentContent, AttachmentsCapability, Capabilities, FilePart, ImagePart } from './types.js'
import { toBase64, utf8Text } from './bytes.js'

// ────────────────────────────────────────────────────────────────────────────
// Словарь типов
// ────────────────────────────────────────────────────────────────────────────

/** Лимит одного файла по умолчанию (attachments-spec §3): 2 МБ. */
export const DEFAULT_ATTACHMENT_MAX_BYTES = 2_000_000

/** Текстовые mime сверх `text/*`: структурированные данные и скрипты. */
const TEXT_MIMES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/javascript',
  'application/x-javascript',
  'application/typescript',
  'application/x-typescript',
  'application/x-sh',
  'application/sql',
  'application/graphql',
  'application/x-ndjson',
])

/**
 * Расширения, которые текстовые независимо от mime.
 *
 * Mime от браузера для исходников ненадёжен: `.ts` приезжает `video/mp2t`,
 * `.py`/`.rs`/`.go` — пустым или `application/octet-stream`. Расширение
 * решает раньше mime для всего, что не `image/*`.
 */
export const TEXT_ATTACHMENT_EXTENSIONS: readonly string[] = [
  // текст и разметка
  'txt', 'md', 'markdown', 'mdx', 'rst', 'adoc', 'org', 'tex', 'log',
  // данные
  'json', 'jsonl', 'ndjson', 'json5', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'csv', 'tsv', 'xml', 'svg', 'html', 'htm', 'css', 'scss', 'sass', 'less',
  // исходники
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte',
  'py', 'rb', 'php', 'pl', 'lua', 'r', 'jl', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'groovy',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'm', 'mm', 'cs', 'fs', 'swift', 'dart', 'zig', 'nim',
  'hs', 'ml', 'ex', 'exs', 'erl', 'clj', 'elm', 'sql', 'graphql', 'gql', 'proto',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'dockerfile', 'makefile', 'cmake', 'gradle',
  'mds', 'mdz', 'mdd', 'ntpl', 'toon',
]

const TEXT_EXTENSION_SET = new Set(TEXT_ATTACHMENT_EXTENSIONS)

/** Картинки по расширению — когда mime не пришёл вовсе. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  heic: 'image/heic',
}

/** Типы, которые v1 принимает (attachments-spec §3) — для `Capabilities.attachments.mimes`. */
export const ATTACHMENT_MIMES: readonly string[] = ['text/*', ...TEXT_MIMES, 'image/*']

/** Вид вложения: текст едет в контекст содержимым, картинка — байтами. */
export type AttachmentKind = 'text' | 'image'

/**
 * Вид вложения по имени и mime; `undefined` — v1 такое не принимает.
 *
 * Порядок: `image/*` по mime → текстовый mime → текстовое расширение → картинка
 * по расширению (mime не пришёл) → отказ. SVG — текст по расширению, но при
 * `image/svg+xml` — картинка: пользователь прислал её как картинку.
 */
export function attachmentKind(name: string, mime?: string): AttachmentKind | undefined {
  const type = normalizeMime(mime)
  if (type?.startsWith('image/')) return 'image'
  if (type && (type.startsWith('text/') || TEXT_MIMES.has(type) || type.endsWith('+json') || type.endsWith('+xml'))) {
    return 'text'
  }
  const ext = extensionOf(name)
  if (ext !== undefined && TEXT_EXTENSION_SET.has(ext)) return 'text'
  if (ext !== undefined && IMAGE_EXTENSIONS[ext] && (type === undefined || type === 'application/octet-stream')) {
    return 'image'
  }
  return undefined
}

/** Символов на токен для ASCII (латиница, код, разметка) — attachments-spec §2. */
const TOKEN_CHARS_ASCII = 4.4
/** Символов на токен для остального (кириллица, эмодзи, CJK) — attachments-spec §2. */
const TOKEN_CHARS_NON_ASCII = 2.75

/**
 * Оценка токенов текста: `ascii / 4.4 + nonAscii / 2.75` (attachments-spec §2).
 *
 * Оценка, а не счёт — токенизатора у протокола нет и не будет. Коэффициенты —
 * калибровка по `usage` облачной модели (разовый скрипт на корпусе сессий, вне ядра):
 * кириллица кодируется плотнее латиницы, один общий делитель занижал русский
 * текст и завышал код. Считает по code points, не по UTF-16: суррогатная пара
 * (эмодзи) — один символ.
 */
export function estimateTokens(text: string): number {
  let ascii = 0
  let nonAscii = 0
  for (const ch of text) {
    if (ch.charCodeAt(0) < 0x80) ascii++
    else nonAscii++
  }
  return Math.ceil(ascii / TOKEN_CHARS_ASCII + nonAscii / TOKEN_CHARS_NON_ASCII)
}

// ────────────────────────────────────────────────────────────────────────────
// Отказ
// ────────────────────────────────────────────────────────────────────────────

/**
 * Вложение не принято: тип вне v1, лимит, не UTF-8 (attachments-spec §3).
 *
 * Код `bad_request` — транспорт отдаёт 400 с текстом, UI показывает текст как
 * есть, поэтому сообщение пишется для человека.
 */
export class AttachmentRejectedError extends Error {
  readonly code = 'bad_request'
  constructor(message: string) {
    super(message)
    this.name = 'AttachmentRejectedError'
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Сборка части
// ────────────────────────────────────────────────────────────────────────────

export interface AttachmentPartInput {
  name: string
  data: Uint8Array
  mime?: string
  /** Ref, под которым бэкенд сохранил байты. */
  ref: string
  /** Default {@link DEFAULT_ATTACHMENT_MAX_BYTES}. */
  maxBytes?: number
}

/**
 * Проверить вложение и собрать готовую часть для `put` → `{ref, part}`.
 *
 * Текст: `text` = содержимое (BOM срезан), `meta.tokens` = оценка. Картинка:
 * `meta.mime/ref`, `alt` = имя, токенов нет — правило у каждого провайдера своё.
 *
 * Звать ДО записи байтов: отказ не должен оставлять в хранилище сирот.
 * `ref` можно передать заранее вычисленным — он от байтов, а не от записи.
 *
 * @throws AttachmentRejectedError лимит, тип вне v1, текст не в UTF-8
 */
export function attachmentPart(input: AttachmentPartInput): FilePart | ImagePart {
  const { name, data, ref } = input
  const maxBytes = input.maxBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES
  if (data.byteLength > maxBytes) {
    throw new AttachmentRejectedError(
      `Файл «${name}» — ${formatBytes(data.byteLength)}, лимит вложения — ${formatBytes(maxBytes)}`,
    )
  }

  const kind = attachmentKind(name, input.mime)
  if (kind === undefined) {
    const shown = normalizeMime(input.mime) ?? 'без типа'
    throw new AttachmentRejectedError(
      `Файл «${name}» (${shown}) не поддержан: принимаются текстовые файлы и картинки`,
    )
  }

  if (kind === 'image') {
    const mime = imageMime(name, input.mime)
    const part: ImagePart = { type: 'image', meta: { ref, alt: name } }
    if (mime !== undefined) part.meta.mime = mime
    return part
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    throw new AttachmentRejectedError(`Файл «${name}» не читается как текст UTF-8`)
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  return {
    type: 'file',
    text,
    meta: { name, mime: textMime(input.mime), ref, tokens: estimateTokens(text) },
  }
}

/**
 * Лимиты из capabilities в одной форме (attachments-spec §2: `true | {…}`).
 *
 * `undefined` — вложений нет; `{}` — есть, лимиты не объявлены.
 */
export function attachmentLimits(caps: Pick<Capabilities, 'attachments'>): AttachmentsCapability | undefined {
  const value = caps.attachments
  if (value === undefined || value === false) return undefined
  if (value === true) return {}
  return value
}

// ────────────────────────────────────────────────────────────────────────────
// Чтение (v1.10)
// ────────────────────────────────────────────────────────────────────────────

export interface AttachmentContentInput {
  ref: string
  data: Uint8Array
  mime?: string
}

/**
 * Байты вложения → `AttachmentContent` для `attachments.get`. Кодировка — то же
 * правило, что у `fileContent`: один файл не должен приезжать то текстом, то
 * байтами в зависимости от бэкенда.
 */
export function attachmentContent(input: AttachmentContentInput): AttachmentContent {
  const { ref, data } = input
  const text = utf8Text(data)
  const out: AttachmentContent =
    text !== undefined
      ? { ref, content: text, encoding: 'utf8', size: data.byteLength }
      : { ref, content: toBase64(data), encoding: 'base64', size: data.byteLength }
  const mime = normalizeMime(input.mime)
  if (mime !== undefined) out.mime = mime
  return out
}

/**
 * `data:`-URL вложения — прямо в `<img src>`. Без mime — `application/octet-stream`
 * (картинку такой браузер не покажет: mime кладёт `put`).
 */
export function attachmentDataUrl(content: Pick<AttachmentContent, 'content' | 'encoding' | 'mime'>): string {
  const mime = content.mime ?? 'application/octet-stream'
  if (content.encoding === 'base64') return `data:${mime};base64,${content.content}`
  return `data:${mime};charset=utf-8,${encodeURIComponent(content.content)}`
}

/** Есть ли у бэкенда `attachments.get` (capability `attachments.get`). */
export function canGetAttachment(caps: Pick<Capabilities, 'attachments'>): boolean {
  return attachmentLimits(caps)?.get === true
}

// ────────────────────────────────────────────────────────────────────────────
// Мелочи
// ────────────────────────────────────────────────────────────────────────────

/** `text/markdown; charset=utf-8` → `text/markdown`; пусто → undefined. */
function normalizeMime(mime: string | undefined): string | undefined {
  const type = mime?.split(';')[0]?.trim().toLowerCase()
  return type ? type : undefined
}

function extensionOf(name: string): string | undefined {
  const base = name.split(/[\\/]/).pop() ?? name
  const dot = base.lastIndexOf('.')
  // Файлы без расширения, но с говорящим именем (Dockerfile, Makefile).
  if (dot <= 0) return base === '' ? undefined : base.toLowerCase()
  return base.slice(dot + 1).toLowerCase()
}

/** Mime текстового файла: пришедший, если он текстовый, иначе `text/plain`. */
function textMime(mime: string | undefined): string {
  const type = normalizeMime(mime)
  if (type && type !== 'application/octet-stream' && !type.startsWith('video/')) return type
  return 'text/plain'
}

function imageMime(name: string, mime: string | undefined): string | undefined {
  const type = normalizeMime(mime)
  if (type?.startsWith('image/')) return type
  const ext = extensionOf(name)
  return ext !== undefined ? IMAGE_EXTENSIONS[ext] : undefined
}

function formatBytes(n: number): string {
  if (n < 1000) return `${n} Б`
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} КБ`
  return `${(n / 1_000_000).toFixed(1)} МБ`
}
