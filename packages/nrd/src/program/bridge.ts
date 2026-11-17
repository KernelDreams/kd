/**
 * Мост mds → блоки.
 *
 * `nr-chat.parse(text)` → `ChatMessage[]` → псевдо-`Block[]`. Форма совпадает
 * 1:1: роль ↔ имя блока, name ↔ id, `{meta}` ↔ attrs, тело ↔ body. Дальше —
 * существующий пайплайн (реестр деклараций, сборка контекста) без изменений.
 *
 * Ключевое: строковые значения меты прогоняются через `scanPlaceholders` и при
 * наличии спанов становятся `InterpolatedValue`. Без этого
 * `{path: './bots/${name}.json'}` в mds не резолвился бы, а в mdz резолвится —
 * асимметрия недопустима.
 */

import { parse as parseChat } from '../chat/index.js'
import { scanPlaceholders } from '../core/index.js'
import type {
  Attribute,
  AttributeValue,
  Block,
  InterpolatedValue,
  Json5Object,
  ListItem,
} from '../md/index.js'

/** Роль ноды-конверта файла: её мета — корневые атрибуты документа. */
export const META_ROLE = 'meta'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Строка → InterpolatedValue, если в ней есть `${…}`; иначе строка как есть. */
export function lexValue(s: string): string | InterpolatedValue {
  const found = scanPlaceholders(s)
  if (found.length === 0) return s
  return {
    raw: s,
    placeholders: found.map((p) => ({ raw: p.raw, start: p.start, end: p.end })),
  }
}

/** Значение json5-меты → AttributeValue. Вложенные объекты атомарны. */
export function valueFromMeta(v: unknown): AttributeValue {
  if (typeof v === 'string') return lexValue(v)
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v
  if (Array.isArray(v)) {
    return v.map((item) =>
      typeof item === 'string' ? lexValue(item) : (item as ListItem),
    ) as ListItem[]
  }
  if (isPlainObject(v)) return v as Json5Object
  // undefined и прочее — не значение атрибута
  return String(v)
}

/** Мета ноды → `Attribute[]` в порядке ключей. */
export function attrsFromMeta(meta?: Record<string, unknown>): Attribute[] {
  if (!meta) return []
  return Object.entries(meta).map(([key, value]) => ({
    key: key.split('.'),
    value: valueFromMeta(value),
  }))
}

/**
 * Лента mds → корневой псевдо-блок.
 *
 * Ноды `%meta` — конверт файла: их мета становится корневыми атрибутами
 * (несколько нод сливаются по порядку, last-wins), тело — телом корня.
 * Остальные ноды — дочерние блоки уровня 1.
 */
export function mdsToRoot(text: string): Block {
  const messages = parseChat(text)
  const rootAttrs: Attribute[] = []
  const bodies: string[] = []
  const children: Block[] = []

  for (const msg of messages) {
    if (msg.role === META_ROLE) {
      rootAttrs.push(...attrsFromMeta(msg.meta))
      if (msg.body.trim() !== '') bodies.push(msg.body)
      continue
    }
    children.push({
      name: msg.role,
      id: msg.name,
      level: 1,
      attrs: attrsFromMeta(msg.meta),
      body: msg.body,
      children: [],
    })
  }

  return {
    name: '',
    level: 0,
    attrs: rootAttrs,
    body: bodies.length > 0 ? bodies.join('\n') : undefined,
    children,
  }
}
