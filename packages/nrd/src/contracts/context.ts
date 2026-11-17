// Engine core types + guards — протокол доступа к значениям.
// Core never inspects a Value directly — only through IContext / IArray.

import type { Value } from './value.js'

// ---------- Segment ----------

/** A path step: string = object key, number = array index. */
export type Segment = string | number

// ---------- CastMap (type-safe casts) ----------

/**
 * Maps a cast name to its return type. Open set — extend via module
 * augmentation; the `cast<T>(name: string)` fallback keeps it open.
 *
 * ```ts
 * declare module './index.js' {
 *   interface CastMap { imageRaw: Buffer }
 * }
 * ```
 *
 * `NRDocument` подмешивается в CastMap через module augmentation из
 * `@kerneldreams/nrd` (document.ts): протокол не знает о своём биндинге к кодеку.
 */
export interface CastMap {
  text: string
  raw: string
  lines: IArray
  prompts: IArray
  paragraphs: IArray
  records: IArray
  attrs: IArray
  keys: string[]
  tbl: IArray
  messages: IArray
  IContext: IContext
  IArray: IArray
}

// ---------- IContext / IArray ----------

export interface IContext {
  /** Value at a segment path. `${user.email}` → get(['user','email']). */
  get(path: Segment[]): Value | undefined
  /** Call a function with already-resolved args. No such function → undefined. */
  func(name: string, args: Value[]): Value | undefined
  /** View self as another type. Cannot → undefined. */
  cast<K extends keyof CastMap>(name: K): CastMap[K] | undefined
  cast<T>(name: string): T | undefined
  /**
   * Текстовая проекция значения — то же правило, что у интерполяции
   * (text-cast-spec §2.2): тело/заголовок звена, иначе json5-дамп. Объявлено в
   * протоколе, потому что без него `String(ctx)` в чужом коде и в шаблонах
   * отдаёт `[object Object]`. Готовое тело — `contextToString` из `/eval`.
   */
  toString?(): string
}

export interface IArray {
  length(): number
  at(i: number): Value | undefined
  iterate(): Iterable<Value>
  cast<K extends keyof CastMap>(name: K): CastMap[K] | undefined
  cast<T>(name: string): T | undefined
  /** Текстовая проекция — см. {@link IContext.toString}. */
  toString?(): string
}

// ---------- Resolver options ----------

export interface ResolveOptions {
  /** lenient (default): unresolved → literal. strict: unresolved → throw. */
  mode?: 'lenient' | 'strict'
  /**
   * Keep the `\${` opt-out escape in the result instead of unfolding it (§3.1).
   * For values that go BACK into a context (an attribute resolved at build time):
   * the escape must survive until the value leaves through `resolve`/`get`,
   * otherwise the next recursion reads the unfolded `${` as a live placeholder.
   */
  keepOptOut?: boolean
}

// ---------- Guards ----------

/** A scalar primitive (string / number / boolean). null is NOT a scalar here. */
export function isScalar(v: unknown): v is string | number | boolean {
  const t = typeof v
  return t === 'string' || t === 'number' || t === 'boolean'
}

/** Has a `cast` method — the marker that separates engine values from native ones. */
function hasCast(v: object): boolean {
  return typeof (v as { cast?: unknown }).cast === 'function'
}

/**
 * Duck-typed IContext: `get` + `cast`. `cast` is required — without it a `Map`
 * (native `get`) would pass, and `map.get([seg])` silently yields garbage.
 */
export function isContext(v: unknown): v is IContext {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { get?: unknown }).get === 'function' &&
    hasCast(v)
  )
}

/**
 * Duck-typed IArray: `at` + `cast`. `cast` is required — without it a native JS
 * array (Array.prototype.at, Node 16.6+) would pass, and traversal would call
 * `cast` on it and throw a TypeError instead of degrading softly.
 */
export function isArray(v: unknown): v is IArray {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { at?: unknown }).at === 'function' &&
    hasCast(v)
  )
}

/** Check whether a value is an InterpolatedValue ({raw, placeholders}). */
export function isInterpolated(v: unknown): v is { raw: string; placeholders: unknown[] } {
  return typeof v === 'object' && v !== null && 'raw' in v && 'placeholders' in v
}

// Приведение к тексту (`asText`, `textView`) живёт в `./text.js`: правило §2.1
// text-cast-spec тянет json5-сериализацию, а этот файл — протокол и guards.

// ---------- Function registry entry ----------

/** Реестр-функция движка: уже резолвнутые аргументы + контекст → значение. */
export type FuncFn = (args: Value[], ctx: IContext) => Value | undefined
