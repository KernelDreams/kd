// Приведение Value к тексту — единое правило движка (text-cast-spec §2.1).
//
// Один закон на все значения: есть текстовая проекция — она; нет — json5-дамп
// (как Json5Object в текстовой позиции сегодня). `[object Object]`
// не появляется никогда: это протечка JS-подложки, а не значение.
//
// Текстовая проекция звена (IContext/IArray):
//   1. `cast('text')` вернул непустую строку → она (для блока тело, для
//      NRDocument — тело root). Механика уже есть в кодеке, здесь её вызывают.
//   2. Тела нет, но есть заголовочный хвост (`cast('id')`) → он. Это форма
//      однострочного поля mdd (`## @name Carly & Rob`): значение записано в
//      заголовке, тела у блока не будет никогда.
//   3. Иначе текста нет → дамп.
//
// Дамп собирается ЧЕРЕЗ ПРОТОКОЛ (`cast('keys')` + `get`), а не через внутренности
// реализации: правило работает на любом IContext, включая чужие.

import { isArray, isContext, isInterpolated } from './context.js'
import type { IArray, IContext } from './context.js'
import { stringifyJson5 } from '../json5/index.js'

export interface TextCastOptions {
  /**
   * Раскрытие вложенных `${}` в СТРОКОВЫХ ЛИСТЬЯХ. Резолвер передаёт сюда свой
   * `expand`: подстановка обязана случиться ДО сериализации, иначе значение с
   * кавычкой внутри порвёт json5-дамп.
   */
  expand?: (s: string) => string
  /** Предел вложенности дампа (защита от глубоких и циклических деревьев). */
  maxDepth?: number
}

const DEFAULT_MAX_DEPTH = 8

/** Состояние обхода: хук раскрытия, предел глубины, стек объектов (циклы). */
interface Ctl {
  expand(s: string): string
  maxDepth: number
  seen: Set<object>
}

function ctl(opts: TextCastOptions = {}): Ctl {
  return {
    expand: opts.expand ?? ((s: string) => s),
    maxDepth: opts.maxDepth ?? DEFAULT_MAX_DEPTH,
    seen: new Set<object>(),
  }
}

/**
 * Текстовая проекция звена: тело (`cast('text')`), иначе заголовочный хвост
 * (`cast('id')`). `undefined` — текста у значения нет, дальше дамп.
 *
 * Пустая строка текстом НЕ считается: у блока без тела `cast('text')` отдаёт
 * `''`, и приняв его за текст, `${bot}` дал бы пустоту вместо содержимого (§4.2).
 */
export function textView(v: IContext | IArray): string | undefined {
  const t = v.cast<string>('text')
  if (typeof t === 'string' && t.length > 0) return t
  // Заголовочный хвост — текст только у звена, которому больше нечего сказать
  // (`## @name Carly & Rob` — поле, записанное в заголовке). Если у звена есть
  // ключи, хвост — это ИМЯ записи (`## $bot carly`), а значение звена — дамп
  // его содержимого (§4.2).
  const keys = v.cast<string[]>('keys')
  if (Array.isArray(keys) && keys.length > 0) return undefined
  const id = v.cast<string>('id')
  if (typeof id === 'string' && id.length > 0) return id
  return undefined
}

/**
 * Полное правило §2.1: Value → текст. `undefined` только там, где значения нет вовсе
 * (`undefined`/`null`/несериализуемое) — там резолвер трактует его как
 * нерезолвленное (литерал в lenient, ошибка в strict).
 */
export function toText(v: unknown, opts?: TextCastOptions): string | undefined {
  return textOf(v, ctl(opts), 0)
}

/**
 * Сужающий аксессор: строка, если значение ТЕКСТОВОЕ. Контейнер без текстовой
 * проекции → `undefined`.
 *
 * НЕ коэрсия. Прикладной код использует `undefined` как признак «это не текст»
 * (`asText(a) ?? asText(b)`, `if (!asText(x))`). Дамп здесь ломает эти проверки
 * и утекает содержимым контейнера — в т.ч. секретами из блоков провайдеров.
 * Полное правило §2.1 — `toText`, оно применяется только в точках коэрсии
 * (valueToText резолвера, toString контекстов, интерполяция).
 */
export function asText(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (isInterpolated(v)) return v.raw
  if (isContext(v) || isArray(v)) {
    const t = v.cast<string>('text')
    if (typeof t === 'string') return t
  }
  return undefined
}

function textOf(v: unknown, c: Ctl, depth: number): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === 'string') return c.expand(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (isInterpolated(v)) return c.expand(v.raw)
  if (typeof v !== 'object') return undefined
  if (depth >= c.maxDepth) return undefined

  // Массивы (нативные и IArray) — last-wins (engine-spec §3.4): в текстовой
  // позиции коллекция звучит последним элементом, а не перечислением.
  if (Array.isArray(v)) {
    if (v.length > 0) {
      const last = textOf(v[v.length - 1], c, depth + 1)
      if (last !== undefined) return last
    }
    return dumpOf(v, c, depth)
  }
  if (isArray(v)) {
    const t = textView(v)
    if (t !== undefined) return c.expand(t)
    const n = v.length()
    if (n > 0) {
      const last = textOf(v.at(n - 1), c, depth + 1)
      if (last !== undefined) return last
    }
    return dumpOf(v, c, depth)
  }
  if (isContext(v)) {
    const t = textView(v)
    if (t !== undefined) return c.expand(t)
    if (isEmptyNode(v)) return '' // пустое поле звучит пустотой, а не `{}`
    return dumpOf(v, c, depth)
  }
  if (isPlainData(v)) return dumpOf(v, c, depth) // Json5Object и прочие данные
  return undefined // Map/Set/Date/… — не значения формата, текста у них нет
}

/**
 * Пустое звено кодека: текстовая проекция есть, но пуста (`cast('text')` вернул
 * `''`), и перечислять нечего. Это пустое ПОЛЕ (`## @system_prompt` без тела), а
 * не объект: `{}` в его позиции ломал бы паритет с плоским источником, где то
 * же поле — пустая строка. Звено с атрибутами сюда не попадает — у него есть
 * ключи, и дамп несёт данные (§4.2).
 */
function isEmptyNode(v: IContext): boolean {
  if (typeof v.cast<string>('text') !== 'string') return false
  const keys = v.cast<string[]>('keys')
  return Array.isArray(keys) && keys.length === 0
}

/**
 * Данные, у которых json5-дамп осмыслен: литеральный объект (или `Object.create(null)`)
 * и всё, что умеет `toJSON`. `Map`/`Set`/классы движка сюда не попадают — дамп
 * отдал бы `{}` и соврал.
 */
function isPlainData(v: object): boolean {
  if (typeof (v as { toJSON?: unknown }).toJSON === 'function') return true
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function dumpOf(v: unknown, c: Ctl, depth: number): string | undefined {
  const data = dataOf(v, c, depth)
  if (data === undefined) return undefined
  if (typeof data === 'string') return data
  return stringifyJson5(data)
}

/** Значение → json5-совместимые данные (протокольный обход, без внутренностей). */
function dataOf(v: unknown, c: Ctl, depth: number): unknown {
  if (v === undefined || v === null) return undefined
  if (typeof v === 'string') return c.expand(v)
  if (typeof v === 'number' || typeof v === 'boolean') return v
  if (isInterpolated(v)) return c.expand(v.raw)
  if (typeof v !== 'object') return undefined
  if (depth >= c.maxDepth || c.seen.has(v)) return undefined
  c.seen.add(v)
  try {
    if (Array.isArray(v)) return v.map((x) => dataOf(x, c, depth + 1) ?? null)
    if (isArray(v)) return [...v.iterate()].map((x) => dataOf(x, c, depth + 1) ?? null)
    if (typeof (v as { toJSON?: unknown }).toJSON === 'function') return v // Date и т.п.
    if (isContext(v)) {
      // Звено с текстом внутри дампа — лист: тело блока читается лучше, чем
      // объект с одним ключом-телом.
      const t = textView(v)
      if (t !== undefined) return c.expand(t)
      const keys = v.cast<string[]>('keys')
      if (!Array.isArray(keys)) return undefined // контекст себя не перечисляет
      return record(keys, (k) => dataOf(v.get([k]), c, depth + 1))
    }
    if (!isPlainData(v)) return undefined
    return record(Object.keys(v), (k) => dataOf((v as Record<string, unknown>)[k], c, depth + 1))
  } finally {
    c.seen.delete(v)
  }
}

function record(keys: string[], read: (k: string) => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) {
    const d = read(k)
    if (d !== undefined) out[k] = d
  }
  return out
}
