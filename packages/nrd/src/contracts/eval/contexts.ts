// Standard IContext / IArray implementations (§8 of engine-spec.md).

import type { IArray, IContext, Segment } from '../context.js'
import { isArray, isContext, isInterpolated, isScalar } from '../context.js'
import { toText } from '../text.js'
import type { Value } from '../value.js'
// FuncFn — тип реестра функций движка живёт в контракте; реэкспортируется
// отсюда для потребителей, собирающих цепочку контекстов.
import type { FuncFn } from '../context.js'
export type { FuncFn } from '../context.js'

// ---------- toString на контекстах (text-cast-spec §2.2) ----------
//
// Чужой код и шаблоны не знают про касты и делают `String(v)` / конкатенацию.
// Без `toString` правило §2.1 работало бы только внутри нашей интерполяции, а
// снаружи снова протекал бы `[object Object]`. Тело одно на все реализации.

/** Текст значения-контейнера по §2.1; текста нет вовсе → пустая строка. */
export function contextToString(v: IContext | IArray): string {
  return toText(v) ?? ''
}

// ---------- Value wrapping ----------

/**
 * Wrap a raw JS value so further traversal works:
 * - scalar / null / undefined → as-is
 * - InterpolatedValue → as-is (атом формата, не запись)
 * - existing IContext / IArray → as-is
 * - plain array → arrayValue
 * - plain object → objectContext
 *
 * InterpolatedValue исключён намеренно: `{raw, placeholders}` — внутреннее
 * представление незарезолвленного значения, а не данные. Обёрнутый в
 * objectContext, он терял себя: `asText` не узнавал его форму, а `${x}` внутри
 * `raw` не резолвился — наружу уезжала пара служебных ключей. Форму знают и
 * `asText`, и резолвер; тут её достаточно не ломать.
 */
export function wrapValue(v: Value): Value {
  if (v === undefined || v === null) return v
  if (isScalar(v)) return v
  if (isInterpolated(v)) return v
  if (isContext(v) || isArray(v)) return v
  if (Array.isArray(v)) return arrayValue(v as Value[])
  if (typeof v === 'object') return objectContext(v as Record<string, Value>)
  return v
}

/** Step one segment into a raw value (used by objectContext traversal). */
function stepInto(cur: Value, seg: Segment): Value {
  if (cur === undefined || cur === null) return undefined
  if (isContext(cur)) return cur.get([seg])
  if (isArray(cur)) {
    if (typeof seg === 'number') return cur.at(seg)
    const asCtx = cur.cast<IContext>('IContext')
    return asCtx ? asCtx.get([seg]) : undefined
  }
  if (Array.isArray(cur)) {
    return typeof seg === 'number' ? cur[seg] : undefined
  }
  if (typeof cur === 'object') {
    {
        // __proto__/constructor из недоверенных путей не должны ходить по
        // прототипной цепочке (ревью 03.07 §6).
        const key = String(seg)
        if (!Object.hasOwn(cur as object, key)) return undefined
        return (cur as Record<string, Value>)[key]
      }
  }
  return undefined // scalar with remaining segments
}

// ---------- objectContext ----------

/** Plain object → IContext (nested objects/arrays wrapped lazily). */
export function objectContext(obj: Record<string, Value>): IContext {
  return {
    get(path: Segment[]): Value | undefined {
      let cur: Value = obj
      for (const seg of path) {
        cur = stepInto(cur, seg)
        if (cur === undefined) return undefined
      }
      return wrapValue(cur)
    },
    func(): Value | undefined {
      return undefined
    },
    cast(name: string): any {
      if (name === 'keys') return Object.keys(obj)
      return undefined
    },
    toString(): string {
      return contextToString(this)
    },
  }
}

// ---------- arrayValue ----------

/** Plain array → IArray. Elements wrapped on access so nesting traverses. */
export function arrayValue(items: Value[]): IArray {
  return {
    length: () => items.length,
    at: (i: number) => wrapValue(items[i]),
    iterate: () => items,
    cast(_name: string): any {
      return undefined
    },
    toString(): string {
      return contextToString(this)
    },
  }
}

// ---------- ChainContext ----------

/**
 * First-hit chain. Parent-chain implemented outside the engine as a utility.
 *
 * Serialization casts (`text`/`raw`) return undefined: first-hit there would
 * yield the first link's text, but callers want a specific link's text — they
 * fetch the link (cast it to the codec node type) and cast that.
 */
export class ChainContext implements IContext {
  constructor(private chain: IContext[]) {}
  get(path: Segment[]): Value | undefined {
    for (const c of this.chain) {
      const v = c.get(path)
      if (v !== undefined) return v
    }
    return undefined
  }
  func(name: string, args: Value[]): Value | undefined {
    for (const c of this.chain) {
      const v = c.func(name, args)
      if (v !== undefined) return v
    }
    return undefined
  }
  cast(name: string): any {
    if (name === 'text' || name === 'raw') return undefined
    if (name === 'keys') {
      // union с дедупом, first-layer-first (консистентно с first-hit get())
      const seen = new Set<string>()
      const result: string[] = []
      for (const c of this.chain) {
        const keys = c.cast('keys') as string[] | undefined
        if (keys) {
          for (const k of keys) {
            if (!seen.has(k)) {
              seen.add(k)
              result.push(k)
            }
          }
        }
      }
      return result
    }
    for (const c of this.chain) {
      const v = c.cast(name)
      if (v !== undefined) return v
    }
    return undefined
  }
  toString(): string {
    return contextToString(this)
  }
}

export function chainContext(...ctxs: IContext[]): IContext {
  return new ChainContext(ctxs)
}

// ---------- emptyContext ----------

/** Singleton empty context — every method returns undefined. */
export const emptyContext: IContext = {
  get: () => undefined,
  func: () => undefined,
  cast: (name: string): any => (name === 'keys' ? [] : undefined),
  toString: () => '',
}

// ---------- funcContext ----------

/**
 * Function registry → IContext (implements only `func`).
 *
 * `ctx` — контекст, который получит `FuncFn` вторым аргументом. По умолчанию
 * пустой (функции ядра чисты и его не читают); хост кладёт сюда СЛУЖЕБНЫЕ
 * значения — те, что функция не может вывести из аргументов (baseDir и т.п.).
 * Это отдельный контекст, а не пользовательская цепочка: коллизия служебного
 * ключа с атрибутом документа невозможна по построению (resolve-fix §1.5).
 */
export function funcContext(fns: Record<string, FuncFn>, ctx: IContext = emptyContext): IContext {
  return {
    get: () => undefined,
    func(name: string, args: Value[]): Value | undefined {
      const f = fns[name]
      return f ? f(args, ctx) : undefined
    },
    cast: (name: string): any => (name === 'keys' ? [] : undefined),
    // Реестр функций данных не поставляет — дампить нечего.
    toString: () => '',
  }
}
