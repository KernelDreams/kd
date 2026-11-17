/**
 * Метаданные PNG ComfyUI: `SaveImage` пишет текстовые чанки `prompt`
 * (API-формат) и `workflow` (UI-граф). Читаем tEXt / iTXt / zTXt, пишем tEXt
 * с JSON в ASCII (`\uXXXX`) — как `json.dumps` сервера: tEXt — latin1, и
 * кириллица промпта иначе побилась бы.
 */

import { crc32, inflateSync } from 'node:zlib'
import type { Prompt, UiWorkflow } from './types.js'

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const META_KEYS = new Set(['prompt', 'workflow'])

export interface PngChunk {
  type: string
  data: Uint8Array
}

export const isPng = (bytes: Uint8Array): boolean => bytes.length >= 8 && SIGNATURE.every((b, i) => bytes[i] === b)

/** Чанки PNG по порядку. Не PNG — throw. */
export function readChunks(bytes: Uint8Array): PngChunk[] {
  if (!isPng(bytes)) throw new Error('не PNG (нет сигнатуры)')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: PngChunk[] = []
  let at = 8
  while (at + 12 <= bytes.length) {
    const len = view.getUint32(at)
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
    if (at + 12 + len > bytes.length) throw new Error(`PNG обрезан: чанк ${type}`)
    out.push({ type, data: bytes.subarray(at + 8, at + 8 + len) })
    at += 12 + len
    if (type === 'IEND') break
  }
  return out
}

const latin1 = new TextDecoder('latin1')
const utf8 = new TextDecoder('utf-8')

/** Текстовый чанк → `[ключ, текст]`; не текстовый или битый — null. */
export function textOf(chunk: PngChunk): [string, string] | null {
  const d = chunk.data
  const nul = d.indexOf(0)
  if (nul <= 0) return null
  const key = latin1.decode(d.subarray(0, nul))
  try {
    if (chunk.type === 'tEXt') {
      // По спеке latin1; ComfyUI пишет ASCII, сторонние утилиты — бывает UTF-8.
      const raw = d.subarray(nul + 1)
      return [key, utf8Strict(raw) ?? latin1.decode(raw)]
    }
    if (chunk.type === 'zTXt') return [key, latin1.decode(inflateSync(d.subarray(nul + 2)))]
    if (chunk.type === 'iTXt') {
      const compressed = d[nul + 1] === 1
      let at = nul + 3
      const lang = d.indexOf(0, at)
      if (lang < 0) return null
      const translated = d.indexOf(0, lang + 1)
      if (translated < 0) return null
      at = translated + 1
      const body = d.subarray(at)
      return [key, utf8.decode(compressed ? inflateSync(body) : body)]
    }
  } catch {
    return null
  }
  return null
}

function utf8Strict(b: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b)
  } catch {
    return null
  }
}

/** Все текстовые чанки: ключ → текст (последний выигрывает). */
export function readText(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of readChunks(bytes)) {
    if (c.type !== 'tEXt' && c.type !== 'iTXt' && c.type !== 'zTXt') continue
    const kv = textOf(c)
    if (kv) out[kv[0]] = kv[1]
  }
  return out
}

export interface PngMeta {
  /** API-формат (`/prompt`). */
  prompt?: Prompt
  /** UI-граф фронта ComfyUI. */
  workflow?: UiWorkflow
}

const parseJson = (s: string | undefined): Record<string, unknown> | undefined => {
  if (!s) return undefined
  try {
    // Питон пишет NaN/Infinity — JSON их не знает.
    const v = JSON.parse(s.replace(/\bNaN\b/g, 'null').replace(/-?\bInfinity\b/g, 'null')) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** `prompt` / `workflow` из PNG. Нет чанка или битый JSON — поля нет. */
export function parsePng(bytes: Uint8Array): PngMeta {
  const text = readText(bytes)
  const prompt = parseJson(text.prompt) as Prompt | undefined
  const workflow = parseJson(text.workflow)
  return { ...(prompt ? { prompt } : {}), ...(workflow ? { workflow } : {}) }
}

/** JSON в ASCII: не-ASCII → `\uXXXX` (tEXt — latin1). */
export const asciiJson = (v: unknown): string => JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  const typeBytes = Uint8Array.from(type, (c) => c.charCodeAt(0))
  out.set(typeBytes, 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

function textChunk(key: string, text: string): Uint8Array {
  const k = Uint8Array.from(key, (c) => c.charCodeAt(0))
  const t = Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff)
  const data = new Uint8Array(k.length + 1 + t.length)
  data.set(k, 0)
  data.set(t, k.length + 1)
  return chunk('tEXt', data)
}

/**
 * PNG с метаданными: прежние `prompt`/`workflow` (любого текстового вида)
 * убираются, новые — tEXt сразу после IHDR. `undefined`/`null` — чанка не будет.
 */
export function embedWorkflow(png: Uint8Array, meta: { prompt?: Prompt | null; workflow?: UiWorkflow | null }): Uint8Array {
  const chunks = readChunks(png)
  const parts: Uint8Array[] = [SIGNATURE]
  for (const c of chunks) {
    const isText = c.type === 'tEXt' || c.type === 'iTXt' || c.type === 'zTXt'
    if (isText && META_KEYS.has(textOf(c)?.[0] ?? '')) continue
    parts.push(chunk(c.type, c.data))
    if (c.type === 'IHDR') {
      if (meta.prompt) parts.push(textChunk('prompt', asciiJson(meta.prompt)))
      if (meta.workflow) parts.push(textChunk('workflow', asciiJson(meta.workflow)))
    }
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
