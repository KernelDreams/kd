// Словарь деклараций `nr.X` (rz-slice-1 §3.3). Одна декларация — три записи:
//
//   mdz плоско:   $nr-type: file          (рукописная/легаси форма, дефис бесплатен)
//   mdz путём:    $nr.type: file          (dotted-ключ, тот же путь)
//   вложенно:     $nr: {type: 'file'}     ≡  mds-мета {nr: {type: 'file'}}
//
// Биекция `$nr-X` ≡ `nr.X` механическая: вложенный объект `nr` (и dotted `nr.X`)
// разворачивается в плоские `nr-*` ДО диспатча, дальше потребитель знает только
// плоскую форму. Плоская запись побеждает при конфликте — она ближе к точке
// употребления (рукописная правка поверх пресета).
//
// `nr-*` = словарь хоста; ключи без префикса — схема плагина (`path`, `keys`).

import type { Value } from '../contracts/index.js'

export const NR_PREFIX = 'nr-'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Свести все записи декларации к плоским `nr-*`.
 *
 * Возвращает НОВЫЙ объект (вход не мутируется). Ключи `nr` и `nr.X` из
 * результата убираются — после нормализации их нет.
 */
export function normalizeNrAttrs(attrs: Record<string, Value>): Record<string, Value> {
  const nested = attrs['nr']
  const dotted = Object.keys(attrs).filter((k) => k.startsWith('nr.'))
  if (!isPlainObject(nested) && dotted.length === 0) return attrs

  const out: Record<string, Value> = {}
  if (isPlainObject(nested)) {
    for (const [k, v] of Object.entries(nested)) out[NR_PREFIX + k] = v as Value
  }
  for (const k of dotted) out[NR_PREFIX + k.slice(3)] = attrs[k]
  // плоская форма поверх развёрнутой
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'nr' || k.startsWith('nr.')) continue
    out[k] = v
  }
  return out
}

/**
 * Значение системного ключа с легаси-фолбэком: `nr-X` (канон) → `X` (легаси).
 * Симметрично существующей паре `nr-type` / `type` (§4.6).
 */
export function nrKey(attrs: Record<string, Value>, key: string): Value {
  const canon = attrs[NR_PREFIX + key]
  return canon === undefined ? attrs[key] : canon
}
