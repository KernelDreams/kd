// Stdlib чистых функций резолвера (core-hardening-spec §C5).
//
// ТОЛЬКО чистые функции, ноль IO. IO (load*/readFile) живёт в nrd-context —
// разделение по пакетам физически совпадает с границей доверия: coreFunctions
// безопасны в ЛЮБОЙ цепочке резолва (untrusted-текст об untrusted-цепочку).
//
// Подключение: funcContext(coreFunctions) в цепочку (§8). Аргументы приходят
// уже вычисленными (резолвер, §3): голые true/false/null/числа — литералы,
// "..." — строка, прочее голое — путь.

import type { FuncFn } from './contexts.js'
import type { Value } from '../value.js'

/**
 * truthy по конвенции формата: false / null / undefined / '' → ложь, остальное
 * — истина. (Резолвер преобразует литерал `null` в undefined перед вызовом —
 * оба трактуются одинаково.)
 */
function truthy(v: Value): boolean {
  return !(v === false || v === null || v === undefined || v === '')
}

/**
 * Реестр чистых функций ядра. Реэкспортируется из index; потребитель кладёт его
 * в цепочку через `funcContext(coreFunctions)`.
 *
 * - `if_else(cond, a, b)` — cond truthy → a, иначе b.
 * - `not(x)` — логическое отрицание по truthy-конвенции.
 * - `eq(a, b)` — строгое равенство (`===`), без коэрции типов.
 * - `default(x, fallback)` — x === undefined|null → fallback, иначе x.
 */
export const coreFunctions: Record<string, FuncFn> = {
  if_else: (args) => (truthy(args[0]) ? args[1] : args[2]),
  not: (args) => !truthy(args[0]),
  eq: (args) => args[0] === args[1],
  default: (args) => (args[0] === undefined || args[0] === null ? args[1] : args[0]),
}
