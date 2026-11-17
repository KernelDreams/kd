// mdd/mdz Document ⇄ обычный JSON (docs/specs/json-spec.md).
//
// Зачем: состояние документа кладётся одной машинной строкой туда, где текст
// формата неуместен (стартовый state бота внутри гритинга). Обычный
// JSON, не JSON5: пишется `JSON.stringify` без пробелов, читается `JSON.parse`.
//
// Чистые функции ядра: ноль environment API, работают в GAS.

import type {
  Document,
  Block,
  Attribute,
  AttributeValue,
  BodyValue,
  InterpolatedValue,
  ListItem,
  Json5Object,
  Sigil,
} from '../md/index.js'

/** Версия формы объекта. Растёт только при несовместимой смене; поля добавляются без неё. */
export const JSON_FORM_VERSION = 1

/**
 * Document → JSON-совместимое значение (json-spec §2).
 *
 * Принимает и `Document` (выход `parse`), и `NRDocument` (выход `parseDocument`) —
 * у второго берётся `.doc`. Прочее — TypeError с типом аргумента.
 *
 * Результат — только объекты, массивы, строки, конечные числа, boolean и null:
 * `JSON.stringify(toJson(doc))` без потерь, `fromJson` восстанавливает Document.
 * Число, не представимое в JSON (NaN, ±Infinity из JSON5-объекта), — TypeError.
 */
export function toJson(doc: Document | { readonly doc: Document }): unknown {
  const d = asDocument(doc)
  return { v: JSON_FORM_VERSION, sigil: d.sigil, root: blockToJson(d.root) }
}

/**
 * Document напрямую или из обёртки с `.doc` (NRDocument). По форме, не через
 * instanceof: класс не тянется в чистый модуль, и две копии пакета в дереве
 * (file:-линки) не ломают проверку.
 */
function asDocument(x: unknown): Document {
  if (isDocumentShape(x)) return x
  if (x !== null && typeof x === 'object' && isDocumentShape((x as { doc?: unknown }).doc)) {
    return (x as { doc: Document }).doc
  }
  throw new TypeError(`toJson: expected Document or NRDocument, got ${describe(x)}`)
}

function isDocumentShape(x: unknown): x is Document {
  if (x === null || typeof x !== 'object') return false
  const root = (x as { root?: unknown }).root
  return root !== null && typeof root === 'object' && typeof (root as { name?: unknown }).name === 'string'
}

function describe(x: unknown): string {
  if (x === null) return 'null'
  if (Array.isArray(x)) return 'array'
  if (typeof x !== 'object') return typeof x
  const ctor = (x as object).constructor
  return ctor && ctor !== Object && ctor.name ? ctor.name : 'object'
}

/**
 * JSON-значение (или его строка) → Document (json-spec §3).
 *
 * Неизвестные поля игнорируются на любом уровне — форма растёт без поломки
 * старых читателей. Нарушение формы (не тот тип у известного поля) — TypeError.
 */
export function fromJson(value: unknown): Document {
  const v = typeof value === 'string' ? (JSON.parse(value) as unknown) : value
  const o = asObject(v, 'document')
  const sigil = o.sigil === undefined ? '@' : o.sigil
  if (sigil !== '@' && sigil !== '$') throw new TypeError(`fromJson: sigil must be "@" or "$", got ${JSON.stringify(sigil)}`)
  const root = o.root === undefined ? { name: '', level: 0 } : o.root
  return { sigil: sigil as Sigil, root: blockFromJson(root, 0, 'root') }
}

// ---------- toJson ----------

function blockToJson(b: Block): Record<string, unknown> {
  const out: Record<string, unknown> = { name: b.name }
  if (b.id !== undefined) out.id = b.id
  out.level = b.level
  if (b.attrs.length > 0) out.attrs = b.attrs.map(attrToJson)
  if (b.body !== undefined) out.body = textToJson(b.body)
  if (b.children.length > 0) out.children = b.children.map(blockToJson)
  return out
}

function attrToJson(a: Attribute): unknown[] {
  return [a.key.slice(), valueToJson(a.value)]
}

function valueToJson(v: AttributeValue): unknown {
  if (Array.isArray(v)) return v.map((item) => (isInterpolated(item) ? interpToJson(item) : scalarToJson(item)))
  if (v !== null && typeof v === 'object') {
    return isInterpolated(v) ? interpToJson(v) : { $o: plainJson(v) }
  }
  return scalarToJson(v)
}

function textToJson(v: BodyValue): unknown {
  return typeof v === 'string' ? v : interpToJson(v)
}

function interpToJson(v: InterpolatedValue): unknown {
  return { $i: v.raw, p: v.placeholders.map((s) => [s.start, s.end]) }
}

function scalarToJson(v: unknown): unknown {
  if (typeof v === 'number' && !Number.isFinite(v)) {
    throw new TypeError(`toJson: number ${v} is not representable in JSON`)
  }
  return v
}

function plainJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(plainJson)
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v)) out[k] = plainJson((v as Record<string, unknown>)[k])
    return out
  }
  return scalarToJson(v)
}

// ---------- fromJson ----------

function blockFromJson(v: unknown, defaultLevel: number, where: string): Block {
  const o = asObject(v, where)
  const name = o.name === undefined ? '' : o.name
  if (typeof name !== 'string') throw new TypeError(`fromJson: ${where}.name must be a string`)
  const level = o.level === undefined ? defaultLevel : o.level
  if (typeof level !== 'number' || !Number.isInteger(level)) throw new TypeError(`fromJson: ${where}.level must be an integer`)

  const block: Block = { name, level, attrs: [], children: [] }
  if (o.id !== undefined) {
    if (typeof o.id !== 'string') throw new TypeError(`fromJson: ${where}.id must be a string`)
    block.id = o.id
  }
  if (o.attrs !== undefined) {
    block.attrs = asArray(o.attrs, `${where}.attrs`).map((a, i) => attrFromJson(a, `${where}.attrs[${i}]`))
  }
  if (o.body !== undefined) block.body = textFromJson(o.body, `${where}.body`)
  if (o.children !== undefined) {
    block.children = asArray(o.children, `${where}.children`).map((c, i) =>
      blockFromJson(c, level + 1, `${where}.children[${i}]`),
    )
  }
  return block
}

function attrFromJson(v: unknown, where: string): Attribute {
  const pair = asArray(v, where)
  if (pair.length < 2) throw new TypeError(`fromJson: ${where} must be [key, value]`)
  const rawKey = pair[0]
  const key = typeof rawKey === 'string' ? [rawKey] : asArray(rawKey, `${where}[0]`)
  if (key.length === 0 || !key.every((s) => typeof s === 'string')) {
    throw new TypeError(`fromJson: ${where}[0] must be a non-empty array of strings`)
  }
  return { key: key as string[], value: valueFromJson(pair[1], `${where}[1]`) }
}

function valueFromJson(v: unknown, where: string): AttributeValue {
  if (Array.isArray(v)) return v.map((item, i) => listItemFromJson(item, `${where}[${i}]`))
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if ('$i' in o) return interpFromJson(o, where)
    if ('$o' in o) return asObject(o.$o, `${where}.$o`) as Json5Object
    throw new TypeError(`fromJson: ${where}: object value without a known tag ($i, $o)`)
  }
  return scalarFromJson(v, where)
}

function listItemFromJson(v: unknown, where: string): ListItem {
  if (v !== null && typeof v === 'object' && !Array.isArray(v) && '$i' in v) {
    return interpFromJson(v as Record<string, unknown>, where)
  }
  return scalarFromJson(v, where)
}

function textFromJson(v: unknown, where: string): BodyValue {
  if (typeof v === 'string') return v
  if (v !== null && typeof v === 'object' && !Array.isArray(v) && '$i' in v) {
    return interpFromJson(v as Record<string, unknown>, where)
  }
  throw new TypeError(`fromJson: ${where} must be a string or {$i}`)
}

function interpFromJson(o: Record<string, unknown>, where: string): InterpolatedValue {
  const raw = o.$i
  if (typeof raw !== 'string') throw new TypeError(`fromJson: ${where}.$i must be a string`)
  const spans = o.p === undefined ? [] : asArray(o.p, `${where}.p`)
  const placeholders = spans.map((s, i) => {
    const pair = asArray(s, `${where}.p[${i}]`)
    const start = pair[0]
    const end = pair[1]
    if (!Number.isInteger(start) || !Number.isInteger(end) || (start as number) < 0 || (end as number) > raw.length || (start as number) + 3 > (end as number)) {
      throw new TypeError(`fromJson: ${where}.p[${i}] is not a valid [start, end] span`)
    }
    return { raw: raw.slice((start as number) + 2, (end as number) - 1), start: start as number, end: end as number }
  })
  return { raw, placeholders }
}

function scalarFromJson(v: unknown, where: string): string | number | boolean | null {
  if (v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number') return v
  throw new TypeError(`fromJson: ${where} must be a scalar`)
}

// ---------- guards ----------

function isInterpolated(v: unknown): v is InterpolatedValue {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    typeof (v as InterpolatedValue).raw === 'string' &&
    Array.isArray((v as InterpolatedValue).placeholders)
  )
}

function asObject(v: unknown, where: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new TypeError(`fromJson: ${where} must be an object`)
  return v as Record<string, unknown>
}

function asArray(v: unknown, where: string): unknown[] {
  if (!Array.isArray(v)) throw new TypeError(`fromJson: ${where} must be an array`)
  return v
}
