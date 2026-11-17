/**
 * embed — контент-адресные эмбеды (embed-cas-spec §2).
 *
 * Вектор адресуется текстом: `sha256(normText(text))` в пространстве `space`
 * (алиас шлюза, пинящий модель и параметры). Здесь — всё портируемое:
 * нормализация, хеш (`crypto.subtle`), f16-кодек, memory-стор и `cachedEmbed`
 * (стор → промахи пачками → embedder → стор). Файловый стор — `nrd/node`.
 */

import type { AsyncResult } from '../infra/result.js'
import type { EmbedResponse, EmbedStore } from '../contracts/index.js'

// ==================== Нормализация и хеш ====================

/**
 * Версия нормализации. Любое изменение `normText` = новая версия и новый ключ:
 * sqlite-стор пишет её в meta и отказывается открывать файл с другой.
 */
export const NORM_V = 1

/**
 * Нормализация текста перед хешем (NORM_V = 1): CRLF/CR → LF, пробельные
 * прогоны внутри строки → один пробел (хвостовые — срезаются, строка из одних
 * пробелов становится пустой), 2+ пустые строки подряд → одна, trim.
 */
export function normText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').replace(/ $/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

/** hex sha256 от `normText(text)` через `crypto.subtle` (WinterCG). */
export async function textHash(text: string): Promise<string> {
  return sha256Hex(normText(text))
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  let out = ''
  for (const b of new Uint8Array(buf)) out += HEX[b]
  return out
}

// ==================== f16-кодек ====================

// Float16Array — little-endian платформы (формат на диске — LE); иначе ручная
// конверсия через DataView.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- в lib ES2022 типа нет
const F16: any =
  typeof (globalThis as any).Float16Array === 'function' &&
  new Uint8Array(new Uint16Array([1]).buffer)[0] === 1
    ? (globalThis as any).Float16Array
    : undefined

const f32 = new Float32Array(1)
const u32 = new Uint32Array(f32.buffer)

/** float32 → биты half (round-to-nearest-even). */
function toHalf(x: number): number {
  f32[0] = x
  const bits = u32[0]
  const sign = (bits >>> 16) & 0x8000
  const exp = (bits >>> 23) & 0xff
  let mant = bits & 0x7fffff

  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0) // Inf / NaN
  let e = exp - 127 + 15
  if (e >= 0x1f) return sign | 0x7c00 // переполнение → Inf
  if (e <= 0) {
    if (e < -10) return sign // слишком мало → ±0
    mant |= 0x800000
    const shift = 14 - e
    const half = mant >>> shift
    const rem = mant & ((1 << shift) - 1)
    const mid = 1 << (shift - 1)
    return sign | (rem > mid || (rem === mid && half & 1) ? half + 1 : half)
  }
  const half = (e << 10) | (mant >>> 13)
  const rem = mant & 0x1fff
  // перенос из мантиссы в экспоненту корректен сам по себе (вплоть до Inf)
  return sign | (rem > 0x1000 || (rem === 0x1000 && half & 1) ? half + 1 : half)
}

/** Биты half → float32. */
function fromHalf(h: number): number {
  const sign = h & 0x8000 ? -1 : 1
  const exp = (h >>> 10) & 0x1f
  const mant = h & 0x3ff
  if (exp === 0) return sign * mant * 2 ** -24
  if (exp === 0x1f) return mant ? NaN : sign * Infinity
  return sign * (1 + mant / 1024) * 2 ** (exp - 15)
}

/** Float32Array → байты f16 (LE). Вдвое компактнее, для эмбедов без потерь смысла. */
export function toF16Bytes(v: Float32Array): Uint8Array {
  if (F16) {
    const h = new F16(v.length)
    for (let i = 0; i < v.length; i++) h[i] = v[i]
    return new Uint8Array(h.buffer)
  }
  const out = new Uint8Array(v.length * 2)
  const dv = new DataView(out.buffer)
  for (let i = 0; i < v.length; i++) dv.setUint16(i * 2, toHalf(v[i]), true)
  return out
}

/** Байты f16 (LE) → Float32Array. */
export function fromF16Bytes(b: Uint8Array): Float32Array {
  if (b.byteLength % 2) throw new Error(`nrd: fromF16Bytes — нечётная длина ${b.byteLength}`)
  const n = b.byteLength / 2
  const out = new Float32Array(n)
  if (F16) {
    // копия: у входа может быть невыровненный byteOffset
    const h = new F16(b.slice().buffer)
    for (let i = 0; i < n; i++) out[i] = h[i]
    return out
  }
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  for (let i = 0; i < n; i++) out[i] = fromHalf(dv.getUint16(i * 2, true))
  return out
}

// ==================== memory-стор ====================

/** EmbedStore в памяти процесса: тесты, короткоживущие воркеры. */
export function memoryEmbedStore(): EmbedStore {
  const spaces = new Map<string, Map<string, Float32Array>>()
  const of = (space: string) => {
    let m = spaces.get(space)
    if (!m) spaces.set(space, (m = new Map()))
    return m
  }
  return {
    async get(space, hashes) {
      const m = spaces.get(space)
      const out = new Map<string, Float32Array>()
      if (!m) return out
      for (const h of hashes) {
        const v = m.get(h)
        if (v) out.set(h, v)
      }
      return out
    },
    async put(space, entries) {
      const m = of(space)
      const dim = m.size ? m.values().next().value!.length : null
      for (const [h, v] of entries) {
        if (dim !== null && v.length !== dim) {
          throw new Error(`nrd: embed store "${space}" — размерность ${v.length}, в пространстве ${dim}`)
        }
      }
      for (const [h, v] of entries) if (!m.has(h)) m.set(h, v)
    },
    async stat(space) {
      const m = spaces.get(space)
      if (!m?.size) return { count: 0, dim: null }
      return { count: m.size, dim: m.values().next().value!.length }
    },
    async spaces() {
      return [...spaces.keys()].filter((s) => spaces.get(s)!.size)
    },
  }
}

// ==================== cachedEmbed ====================

export type Embedder = (input: string[]) => AsyncResult<EmbedResponse>

export interface CachedEmbedOptions {
  /** Пространство — алиас шлюза (`embed/gemini`). */
  space: string
  store: EmbedStore
  embedder: Embedder
  /** Размер пачки промахов на один вызов embedder. */
  batch?: number
  /** Прогресс докачки: зовётся только при промахах, после каждой пачки. */
  onProgress?: (done: number, total: number) => void
}

/**
 * Вектора для `texts` в порядке входа: стор → промахи пачками по `batch` →
 * embedder → `store.put` после каждой пачки (упал на середине — оплаченное
 * сохранено). Дубли внутри вызова считаются один раз.
 */
export async function cachedEmbed(texts: readonly string[], o: CachedEmbedOptions): Promise<Float32Array[]> {
  const batch = Math.max(1, o.batch ?? 64)
  const norm = texts.map((t, i) => {
    if (typeof t !== 'string') throw new Error(`nrd: cachedEmbed — texts[${i}] не строка`)
    const n = normText(t)
    if (!n) throw new Error(`nrd: cachedEmbed — texts[${i}] пуст после нормализации`)
    return n
  })
  const hashes = await Promise.all(norm.map(sha256Hex))

  // уникальные хеши → нормализованный текст (первое вхождение)
  const unique = new Map<string, string>()
  hashes.forEach((h, i) => { if (!unique.has(h)) unique.set(h, norm[i]) })

  const found = await o.store.get(o.space, [...unique.keys()])
  const misses = [...unique.keys()].filter((h) => !found.has(h))

  if (misses.length) {
    let dim = (await o.store.stat(o.space)).dim
    let done = 0
    for (let at = 0; at < misses.length; at += batch) {
      const chunk = misses.slice(at, at + batch)
      const r = await o.embedder(chunk.map((h) => unique.get(h)!))
      if (!r.ok) throw r.error
      const { vectors } = r.value
      if (vectors.length !== chunk.length) {
        throw new Error(`nrd: cachedEmbed "${o.space}" — ${vectors.length} векторов на ${chunk.length} входов`)
      }
      const entries = new Map<string, Float32Array>()
      for (let i = 0; i < chunk.length; i++) {
        const v = vectors[i]
        if (dim === null) dim = v.length
        else if (v.length !== dim) {
          throw new Error(`nrd: cachedEmbed "${o.space}" — размерность ${v.length}, в пространстве ${dim}`)
        }
        entries.set(chunk[i], v)
        found.set(chunk[i], v)
      }
      await o.store.put(o.space, entries)
      done += chunk.length
      o.onProgress?.(done, misses.length)
    }
  }

  return hashes.map((h) => found.get(h)!)
}
