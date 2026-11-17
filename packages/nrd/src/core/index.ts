// nrd/core — формат-движок (бывший @kerneldreams/nrd 4.x).
// Parser (§1–§7) + engine: IContext/IArray, resolver, walk, contexts, NRDocument.
//
// Кодек mdd/mdz с ступени 2 Total Refactor живёт в `@kerneldreams/nrd/md`
// и реэкспортируется отсюда под прежними именами — поверхность 1:1. Собственный
// код nrd-core: eval (resolve/walk/contexts/functions/cartesian), грамматика `${}`,
// сплиттер ленты и склейка (NRDocument).

// ---------- Parser (format-spec §1–§7) ----------
export { parse } from '../md/index.js'
export { coerce, isFullyQuoted } from '../md/index.js'
export { scanPlaceholders, parseExpr, findMatchingBrace } from './placeholder.js'
export { parseAttributeValue, parseBodyValue, unescape } from '../md/index.js'

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
export { toJson, fromJson, JSON_FORM_VERSION } from './json.js'

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

// ---------- Engine: types + guards (engine-spec §2) ----------
export { isScalar, isContext, isArray, isInterpolated, asText, toText, textView } from './icontext.js'
export type { Value, Segment, IContext, IArray, CastMap, ResolveOptions, TextCastOptions } from './icontext.js'

// ---------- Engine: resolver + walk (engine-spec §3, §4, §8.1) ----------
export { resolve, resolveValue, get, unescapeOptOut } from './resolve.js'
export { walk } from './walk.js'

// ---------- Engine: standard implementations (engine-spec §5, §8) ----------
export {
  objectContext,
  chainContext,
  ChainContext,
  emptyContext,
  funcContext,
  arrayValue,
  wrapValue,
  contextToString,
} from './contexts.js'
export type { FuncFn } from './contexts.js'

// ---------- Engine: NRDocument (engine-spec §6) ----------
export { NRDocument, parseDocument } from './document.js'

// ---------- Engine: слоистые контексты — self / $nr-extends (core-hardening §C) ----------
export { blockSelf, selfScope, resolveBlockValue } from './document.js'
export type { SelfOptions, ExtendsLoader } from './document.js'

// ---------- Engine: stdlib чистых функций (core-hardening §C5) ----------
export { coreFunctions } from './functions.js'

// ---------- Engine: includes (format-spec §2.6) ----------
export { resolveIncludes, resolveIncludesAsync, extractSection } from '../md/index.js'
export type { IncludeOptions } from '../md/index.js'

// ---------- Engine: fan-out (engine-spec §7) ----------
export { cartesian } from './cartesian.js'
export type { CartesianOptions } from './cartesian.js'

// ---------- Parser types ----------
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
export type { Placeholder, PlaceholderExpr, PlaceholderArg, PathSegment } from './placeholder.js'
