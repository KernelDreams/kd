// @kerneldreams/nrd/format — поверхность кодека mdd/mdz (текст ↔ структура).
//
// С ступени 2 Total Refactor сам кодек живёт в standalone-пакете
// `@kerneldreams/nrd/md`; этот модуль — ФАСАД: те же имена по тому же пути,
// внешние потребители не меняют ни одного импорта. Собственного кода здесь
// два куска, и оба не принадлежат кодеку:
//   - grammar `${}` (placeholder.ts) — язык eval, не блочная грамматика (§0.2);
//   - schema-слой (schema.ts) — переезжает в `@kerneldreams/nrd/md/schema`, фаза C.

// ---------- Parser (format-spec §1–§7) ----------
export { parse } from '../md/index.js'
export { coerce, isFullyQuoted } from '../md/index.js'
export { parseAttributeValue, parseBodyValue, unescape } from '../md/index.js'

// ---------- Грамматика `${}` (§7) — дом nrd-core, не кодека ----------
export { scanPlaceholders, parseExpr, findMatchingBrace } from '../core/placeholder.js'

// ---------- JSON5-объект как значение атрибута (§3; json5-scalar-spec) ----------
export { isJson5Shaped, isJson5Object, parseJson5Object, Json5ParseError, FlowParseError, stripBom } from '../md/index.js'

// ---------- Serialization (serialize-spec §1, §2) ----------
export {
  serialize,
  serializeValue,
  serializeTable,
  serializeTypedTable,
  parseTable,
  parseTableTyped,
} from '../md/index.js'
export type { TableSerializeOptions, TableRecord } from '../md/index.js'

// ---------- Document ⇄ JSON (json-spec) ----------
export { toJson, fromJson, JSON_FORM_VERSION } from '../core/json.js'

// ---------- Typed tbl header + tableSchema (serialize-spec §2.3) ----------
export { parseHeaderCell, emitHeaderCell, coerceTyped, tableSchema, TableParseError } from '../md/index.js'
export type { TypedColumn, ColumnType } from '../md/index.js'

// ---------- Schema layer (serialize-spec §3) ----------
export {
  serializeWithSchema,
  parseWithSchema,
  validate,
  UNKNOWN_KEY,
  UNKNOWN_OVERFLOW_BLOCK,
} from '../md/schema.js'
export type {
  JSONSchema,
  XStorage,
  XListMode,
  XAs,
  SchemaSerializeOptions,
  ParseWithSchemaOptions,
  ValidationResult,
  ValidationError,
  ValidateOptions,
} from '../md/schema.js'

// ---------- Includes (format-spec §2.6) ----------
export { resolveIncludes, resolveIncludesAsync, extractSection, IncludeCycleError } from '../md/index.js'
export type { IncludeOptions } from '../md/index.js'

// ---------- Типы формата ----------
export type { Value } from '../core/icontext.js'
export type {
  Sigil,
  ParseOptions,
  SerializeOptions,
  Document,
  Block,
  Attribute,
  AttributeValue,
  BodyValue,
  Scalar,
  ListItem,
  Json5Object,
  Json5Value,
  InterpolatedValue,
} from '../md/index.js'
export type { Placeholder, PlaceholderExpr, PlaceholderArg, PathSegment } from '../core/placeholder.js'
