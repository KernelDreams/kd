// `_id` строк массивов объектов (spec §2, objects-spec §2): команды, поля PDF и «Сравнить»
// адресуют строку по `_id`, а не по индексу. В описании `_id` не пишется — его ставит движок.

import { typeOf } from './schema.js'
import type { JSONSchema } from './types.js'

export interface EnsureIdsOptions {
  /** Генератор id; по умолчанию — 6 символов base36. */
  id?: () => string
}

const randomId = (): string => Math.random().toString(36).slice(2, 8).padEnd(6, '0')

/**
 * Проставить `_id` строкам всех массивов объектов по схеме (вглубь, в том числе повторители в
 * повторителях). Пустой или повторный в своём массиве `_id` заменяется. Исходный объект не
 * меняется: новые объекты — только там, где что-то проставлено.
 */
export function ensureIds<T>(object: T, schema: JSONSchema, opts: EnsureIdsOptions = {}): T {
  const gen = opts.id ?? randomId
  const walk = (v: unknown, s: JSONSchema | undefined): unknown => {
    if (!s || v === null || typeof v !== 'object') return v
    const t = typeOf(s)
    if (Array.isArray(v)) {
      if (!t?.endsWith('[]') && t !== 'array') return v
      const it = s.items
      const rows = typeOf(it) === 'object'
      const seen = new Set<string>()
      let changed = false
      const out = v.map((row) => {
        let next = walk(row, it)
        if (rows && next && typeof next === 'object' && !Array.isArray(next)) {
          const cur = (next as { _id?: unknown })._id
          if (typeof cur !== 'string' || !cur || seen.has(cur)) {
            let id = gen()
            while (seen.has(id)) id = gen()
            const { _id: _old, ...rest } = next as Record<string, unknown>
            next = { _id: id, ...rest }
          }
          seen.add((next as { _id: string })._id)
        }
        if (next !== row) changed = true
        return next
      })
      return changed ? out : v
    }
    if (t !== 'object' || !s.properties) return v
    let out: Record<string, unknown> | undefined
    for (const [k, ps] of Object.entries(s.properties)) {
      const cur = (v as Record<string, unknown>)[k]
      const next = walk(cur, ps)
      if (next !== cur) (out ??= { ...(v as Record<string, unknown>) })[k] = next
    }
    return out ?? v
  }
  return walk(object, schema) as T
}
