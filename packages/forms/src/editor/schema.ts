// Схема данных описания: вывод JSON Schema из полей (deriveSchema), разрешение путей, типы.
// Схема одна и живёт у типа (spec §2): `$schema` типа или вывод из редактора по умолчанию.

import { isKnown, nodeLabel, type AnyNode, type EditorDef, type FieldNode, type Issue, type JSONSchema } from './types.js'

const SCHEMA_URI = 'https://json-schema.org/draft/2020-12/schema'

/** JSON Schema поля по типу описания. */
export function schemaOfType(type: string): JSONSchema | undefined {
  switch (type) {
    case 'string':
    case 'integer':
    case 'number':
    case 'boolean':
      return { type }
    case 'string[]':
      return { type: 'array', items: { type: 'string' } }
    case 'boolean[]':
      return { type: 'array', items: { type: 'boolean' } }
    case 'object':
      return { type: 'object', properties: {} }
    case 'object[]':
      return { type: 'array', items: { type: 'object', properties: {} } }
    default:
      return undefined
  }
}

/**
 * Тип узла схемы строкой описания: `string`, `integer`, `string[]`, `object[]`… Массив без `items` —
 * `array`; объединение с `null` — по ненулевому.
 */
export function typeOf(s: JSONSchema | undefined): string | undefined {
  if (!s) return undefined
  let t = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type
  if (!t && s.properties) t = 'object'
  if (!t && s.items) t = 'array'
  if (t === 'array') {
    const it = typeOf(s.items)
    return it ? `${it}[]` : 'array'
  }
  return t
}

/** Узел схемы по пути через точку от `scope`; мимо — `undefined`. */
export function resolve(scope: JSONSchema | undefined, path: string | undefined): JSONSchema | undefined {
  if (!scope || !path) return undefined
  let cur: JSONSchema | undefined = scope
  for (const p of path.split('.')) {
    cur = cur?.properties?.[p]
    if (!cur) return undefined
  }
  return cur
}

export interface Derived {
  schema: JSONSchema
  /** Конфликты: поле объявлено дважды с разными типами, путь через не-объект, тип не из списка. */
  issues: Issue[]
}

/** Вывести схему из типизированных полей описания (mdz пишет тип в узле поля). */
export function derive(def: EditorDef): Derived {
  const schema: JSONSchema = { $schema: SCHEMA_URI, type: 'object', properties: {} }
  const issues: Issue[] = []
  const put = (scope: JSONSchema, path: string, s: JSONSchema, where: string, required?: boolean): JSONSchema | undefined => {
    const parts = path.split('.')
    let cur = scope
    for (const p of parts.slice(0, -1)) {
      cur.properties ??= {}
      const next: JSONSchema = (cur.properties[p] ??= { type: 'object', properties: {} })
      if (typeOf(next) !== 'object') {
        issues.push({ code: 'E_PATH', where, message: `путь ${path}: ${p} — не объект (${typeOf(next)})` })
        return undefined
      }
      cur = next
    }
    const last = parts.at(-1)!
    cur.properties ??= {}
    const had = cur.properties[last]
    if (had) {
      const a = typeOf(had)
      const b = typeOf(s)
      if (a !== b) {
        issues.push({ code: 'E_TYPE', where, message: `поле ${path} уже объявлено с типом ${a}, здесь ${b}`, hint: 'одно поле — один тип; второй вид того же поля — тем же $type' })
        return undefined
      }
      // Объект, объявленный полем и группой (json-виджет над объектом + вложенные поля) — один узел.
      if (s.properties && had.properties) Object.assign(had.properties, s.properties)
      return had
    }
    cur.properties[last] = s
    if (required) (cur.required ??= []).includes(last) || cur.required.push(last)
    return s
  }

  const walk = (nodes: AnyNode[], scope: JSONSchema, where: string): void => {
    for (const n of nodes) {
      const here = `${where ? `${where} / ` : ''}${nodeLabel(n)}`
      if (!isKnown(n)) {
        walk((n as { children?: AnyNode[] }).children ?? [], scope, here)
        continue
      }
      if (n.kind === 'section') walk(n.children, scope, here)
      else if (n.kind === 'group') {
        if (n.path) put(scope, n.path, { type: 'object', properties: {} }, here)
        walk(n.children, scope, here)
      } else if (n.kind === 'repeat') {
        if (!n.path) continue
        const s = put(scope, n.path, { type: 'array', items: { type: 'object', properties: {} } }, here)
        if (s?.items) walk(n.children, s.items, here)
      } else if (n.kind === 'field') {
        if (!n.path || !n.type) continue
        const s = fieldSchema(n)
        if (!s) {
          issues.push({ code: 'E_TYPE', where: here, message: `тип "${n.type}" не из списка`, hint: 'string | integer | number | boolean | string[] | boolean[] | object | object[]' })
          continue
        }
        put(scope, n.path, s, here, n.required === true)
      }
    }
  }
  walk(def.nodes, schema, '')
  return { schema, issues }
}

/** Схема одного поля: тип + подпись, enum, границы, дефолт. */
export function fieldSchema(n: FieldNode): JSONSchema | undefined {
  const s = n.type ? schemaOfType(n.type) : undefined
  if (!s) return undefined
  if (n.label) s.title = n.label
  if (n.description) s.description = n.description
  if (n.enum) s.enum = n.enum
  if (n.min !== undefined) s.minimum = n.min
  if (n.max !== undefined) s.maximum = n.max
  if (n.default !== undefined) s.default = n.default
  return s
}

/** JSON Schema 2020-12 из описания (типизированные поля, группы, повторители). */
export function deriveSchema(def: EditorDef): JSONSchema {
  return derive(def).schema
}

/** Схема, против которой проверяется описание: схема типа → своя схема описания → вывод. */
export function schemaFor(def: EditorDef, typeSchema?: JSONSchema): JSONSchema {
  return typeSchema ?? def.schema ?? deriveSchema(def)
}

/** Образец данных по схеме: дефолты, иначе непустые значения; строки массивов объектов — с `_id`. */
export function sample(s: JSONSchema | undefined, depth = 0): unknown {
  if (!s) return undefined
  if (s.default !== undefined) return s.default
  const t = typeOf(s)
  if (t === 'object') return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, sample(v, depth + 1)]))
  if (t?.endsWith('[]') || t === 'array') {
    const it = s.items
    if (typeOf(it) === 'object') return [1, 2].map((i) => ({ _id: `r${depth}${i}`, ...(sample(it, depth + 1) as object) }))
    return [sample(it, depth + 1), sample(it, depth + 1)]
  }
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0]
  if (t === 'boolean') return true
  if (t === 'integer' || t === 'number') return s.minimum !== undefined && s.minimum > 2 ? s.minimum : 2
  return 'x'
}

/** Листья схемы: скаляры и массивы; строки массивов объектов — `путь[].поле`. */
export function leaves(s: JSONSchema, prefix = ''): string[] {
  const out: string[] = []
  const t = typeOf(s)
  if (t === 'object' && s.properties && Object.keys(s.properties).length) {
    for (const [k, v] of Object.entries(s.properties)) out.push(...leaves(v, prefix ? `${prefix}.${k}` : k))
  } else if (t === 'object[]') {
    out.push(prefix)
    for (const [k, v] of Object.entries(s.items?.properties ?? {})) out.push(...leaves(v, `${prefix}[].${k}`))
  } else out.push(prefix)
  return out
}
