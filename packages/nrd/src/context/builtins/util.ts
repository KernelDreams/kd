// Общие хелперы встроенных плагинов.

import { asText, isArray, type Value, type IContext } from '../../contracts/index.js'
import type { SourceContext } from '../types.js'

/** Value → строка (best-effort). undefined/null → undefined. */
export function asString(v: Value): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  const t = asText(v)
  return t
}

/**
 * Список имён из атрибута: либо flow-литерал (`$[A, B]` → IArray), либо строка
 * через запятую (`"A, B"`). Пустые элементы отбрасываются.
 */
export function asList(v: Value): string[] {
  if (v === undefined || v === null) return []
  if (Array.isArray(v)) {
    return v.map((x) => asString(x) ?? '').map((x) => x.trim()).filter((x) => x.length > 0)
  }
  if (isArray(v)) {
    const out: string[] = []
    for (const item of (v as { iterate(): Iterable<Value> }).iterate()) {
      const s = asString(item)
      if (s !== undefined && s.trim() !== '') out.push(s.trim())
    }
    return out
  }
  const s = asString(v)
  if (s === undefined) return []
  return s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
}

/** Понятная ошибка об отсутствующей capability. */
export function requireCap<K extends keyof SourceContext>(
  ctx: SourceContext,
  cap: K,
  source: string,
): NonNullable<SourceContext[K]> {
  const v = ctx[cap]
  if (v === undefined || v === null) {
    throw new Error(
      `nrd-context: source "${source}" требует capability \`${String(cap)}\` в текущем окружении ` +
        `(передайте её через SourceContext — напр. nodeCapabilities())`,
    )
  }
  return v as NonNullable<SourceContext[K]>
}

/** Прочитать ресурс через storage; ok(undefined) (файла нет) → ошибка. */
export async function readResource(
  ctx: SourceContext,
  path: string,
  source: string,
): Promise<string> {
  const storage = requireCap(ctx, 'storage', source)
  const r = await storage.read(path)
  if (!r.ok) throw r.error
  if (r.value === undefined) {
    throw new Error(`nrd-context: source "${source}" — ресурс не найден: ${path}`)
  }
  return r.value
}

/** Достать тело блока из зарезервированного ключа attrs. */
export function bodyOf(attrs: Record<string, Value>): string {
  const b = attrs['$body']
  return typeof b === 'string' ? b : ''
}

/** Имя source-блока (для сообщений об ошибке). */
export function nameOf(attrs: Record<string, Value>, fallback: string): string {
  const n = attrs['$name']
  return typeof n === 'string' && n.length > 0 ? n : fallback
}

export type { IContext }
