// Встроенные collection-фильтры (spec §5.2). Portable.
//
//   unique(arr, key?)   groupBy(arr, key)   sortBy(arr, key)
//   pluck(arr, key)     join(arr, sep)      first(arr)   last(arr)
//   flatten(arr, depth = 1)

import type nunjucks from 'nunjucks'
import type { HelperRegistrar } from '../engine.js'

type Obj = Record<string, unknown>

function field(item: unknown, key: string): unknown {
  return item && typeof item === 'object' ? (item as Obj)[key] : undefined
}

/** Уникальные элементы (порядок первого вхождения). С `key` — дедуп по полю. */
export function unique(arr: unknown, key?: string): unknown[] {
  if (!Array.isArray(arr)) return []
  const seen = new Set<unknown>()
  const out: unknown[] = []
  for (const item of arr) {
    const k = key != null ? field(item, key) : item
    if (seen.has(k)) continue
    seen.add(k)
    out.push(item)
  }
  return out
}

/** Группировка массива объектов по значению поля → `{ groupKey: [...] }`. */
export function groupBy(arr: unknown, key: string): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {}
  if (!Array.isArray(arr)) return out
  for (const item of arr) {
    const k = String(field(item, key) ?? '')
    ;(out[k] ??= []).push(item)
  }
  return out
}

/** Сортировка массива объектов по полю (стабильная, по возрастанию). */
export function sortBy(arr: unknown, key: string): unknown[] {
  if (!Array.isArray(arr)) return []
  return [...arr].sort((a, b) => {
    const av = field(a, key)
    const bv = field(b, key)
    if (av === bv) return 0
    if (av === undefined || av === null) return -1
    if (bv === undefined || bv === null) return 1
    if (typeof av === 'number' && typeof bv === 'number') return av - bv
    return String(av).localeCompare(String(bv))
  })
}

/** Извлечь поле через массив объектов (как `| map(attribute="x")`). */
export function pluck(arr: unknown, key: string): unknown[] {
  if (!Array.isArray(arr)) return []
  return arr.map((item) => field(item, key))
}

/**
 * Расплющить массив массивов на `depth` уровней (по умолчанию один):
 * `sessions | pluck("clues") | flatten | selectattr("found") | length`.
 * Не массив → `[]`.
 */
export function flatten(arr: unknown, depth: unknown = 1): unknown[] {
  if (!Array.isArray(arr)) return []
  const d = typeof depth === 'number' && depth >= 0 ? depth : 1
  return arr.flat(d)
}

/** Join массива (дефолтный разделитель ", "). */
export function join(arr: unknown, sep: unknown = ', '): string {
  if (!Array.isArray(arr)) return ''
  return arr.join(typeof sep === 'string' ? sep : ', ')
}

/** Первый элемент массива/строки. */
export function first(value: unknown): unknown {
  if (Array.isArray(value)) return value[0]
  if (typeof value === 'string') return value[0] ?? ''
  return undefined
}

/** Последний элемент массива/строки. */
export function last(value: unknown): unknown {
  if (Array.isArray(value)) return value[value.length - 1]
  if (typeof value === 'string') return value[value.length - 1] ?? ''
  return undefined
}

/** Зарегистрировать collection-фильтры на Nunjucks env. */
export const registerCollection: HelperRegistrar = (env: nunjucks.Environment) => {
  env.addFilter('unique', unique)
  env.addFilter('groupBy', groupBy)
  env.addFilter('sortBy', sortBy)
  env.addFilter('pluck', pluck)
  env.addFilter('flatten', flatten)
  env.addFilter('join', join)
  env.addFilter('first', first)
  env.addFilter('last', last)
}
