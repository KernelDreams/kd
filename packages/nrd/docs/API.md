# @kerneldreams/nrd

## main
parse(text: string, options?: ParseOptions): Document
> A line that does not match any structured form contributes to body.
coerce(s: string): Scalar
> Coerce a scalar string to a typed value (§3).

Rules:
- `""` (empty) → empty string
- `"..."` (fully quoted) → string with quotes removed (no further coercion)
- `null` → null
- `true` / `false` → boolean
- integer → number (leading `+` → string; leading-zero multi-digit `007` → string)
- decimal → number (note: `1.10` → `1.1`)
- anything else → string (incl. partially quoted `"yes" or "no"` — verbatim)
isFullyQuoted(s: string): boolean
> Является ли `s` целиком одним quoted-скаляром `"..."` — открывающая кавычка
первый символ, закрывающая последний, между ними нет закрывающей (с учётом
эскейпов). Только в такой позиции кавычка имеет силу скаляр-литерала: `${}`
внутри — литерал, а не плейсхолдер (B2/B5), а сами кавычки снимаются.

Частично-кавыченное (`"yes" or "no"`, JSON `{"m":"${x}"}`) — обычный текст:
кавычки его, а не разметки.
scanPlaceholders(s: string): Placeholder[]
> Scan a value or body string for `${...}` placeholders and recognise their
structure. Returns placeholders in source order.

- `\${` is a literal `${` and is NOT a placeholder.
- Unbalanced `${` is silently treated as literal text.
parseExpr(input: string): PlaceholderExpr
> Parse the contents of `${...}` into a structured expression.

Forms (§7.1):
- path:  `a`, `a.b`, `a.b.0`, `a.${b}`
- call:  `fn(arg, arg, ...)` (call name followed immediately by `(`)
- nested: `${...}` inside path segment or call argument
findMatchingBrace(s: string, fromAfterOpen: number): number
> Given that the `${` opens at position `openDollar`, return the offset of the
matching `}` in `s` (or -1 if unbalanced).

Scanner is brace-balanced and aware of:
- escape sequences `\X` (consume both chars)
- nested `${...}` (increment depth; a bare `{` is NOT counted — §7.1 has no
  bare braces outside string literals)
- double-quoted strings (skip over content; honour `\"`)
parseAttributeValue(raw: string, sigil: Sigil): AttributeValue
> Parse the raw text after an attribute's `:` (with surrounding ws stripped
by the caller — single optional space after `:` already consumed; trailing
trimmed). Returns a coerced scalar, a list (flow-literal), or an
InterpolatedValue when `${}` is present.
parseBodyValue(raw: string): BodyValue
> Parse a body string. Body is raw text; we only recognise `${}` and unfold
escapes (§2.5 says escapes act in body too).
unescape(s: string, mode: EscapeMode): string
> Unfold escape sequences in a value (§2.5).

Always recognised: `\$`, `\@`, `\[`, `\\`, `\n`, `\t`, `\${`.
Context-dependent: `\,` (flow only); `\.` only inside `${}` paths and so
is handled by the placeholder parser, not here.

Note on `\${`: this branch is the RESOLVER's final-pass behaviour (run once,
after all recursion settles). The parser must NOT feed `\${`-bearing values
here — see hasOptOutEscape — or opt-out is lost when the value flows through
recursion.

Any other `\X` is preserved verbatim (backslash + char).
serialize(doc: Document, opts?: SerializeOptions): string
> Serialize a Document back to mdd/mdz text (serialize-spec §1).

Canonical output (§1.4): one space after `:`, blocks/attributes in Document
order, minimal-but-sufficient escaping, no explicit block closings (the parser
derives nesting from header levels). Block-closing tokens (`## $@`) are NOT
emitted (§1.3 rule 5).
serializeValue(value: AttributeValue, sigil?: Sigil): string
> Serialize a single attribute value to its canonical text form.

- scalars → coerced literal with reverse escaping (§1.5)
- list (flow-literal) → `sigil[a, b, c]`
- InterpolatedValue → its raw text (placeholders and `\${` opt-out restored)
serializeTable(records: Record_[], opts?: TableSerializeOptions): string
> Serialize an array of flat records to a tbl table (serialize-spec §2 / §5).

Header from the keys of the first record (or `opts.columns`), then one line
per record with cells joined by ` | `. Cells carrying `|`, `//`, quotes, edge
whitespace, or that would coerce to another type are quoted (open item §2.1).
serializeTypedTable(records: TableRecord[], columns: TypedColumn[], opts?: { eol?: "\n" | "\r\n" | undefined; }): string
> Serialize records to a tbl table with a TYPED header (serialize-spec §2.3).

The header emits `name[:type][!]` annotations (with `\:` escaping); list-typed
cells are joined by their separator. Round-trips with .
parseTable(text: string): TableRecord[]
> Parse a tbl table back into records (inverse of , §5).

First significant line is the header; each later significant line is a record.
Blank lines, decorative lines (`#`/`*`/`` ` ``) and `//` comments are ignored
(§5.2). Cells are trimmed and coerced (§3); typed headers (§2.3) coerce
homogeneously and throw on bad cells.
parseTableTyped(text: string): { columns: TypedColumn[]; records: TableRecord[]; }
> Parse a tbl table into its typed columns + records (serialize-spec §2.3).

The header cells are parsed as `name[:type][!]` annotations; typed columns are
coerced homogeneously and raise  on impossible values
or empty required cells. Un-annotated headers behave exactly like the legacy
per-cell coercion (§3) — full backward compatibility.
TableSerializeOptions { columns?, eol? }
TableRecord = { [k: string]: Scalar | Scalar[] }
parseHeaderCell(cell: string): TypedColumn
> Parse a single header cell (`name[:type][!]`, §2.3).

- A fully double-quoted cell is a literal name — no annotation.
- `\:` escapes a literal colon in the name; `\\` a literal backslash.
- `!` (after the optional type) marks the column required.
- Un-annotated cells keep legacy behaviour (per-cell coercion §3).
emitHeaderCell(col: TypedColumn, plainCell: (s: string) => string): string
> Emit a header cell. Typed columns emit `name[:type][!]` with `\:` escaping;
un-annotated columns fall back to the caller's plain cell serializer.
coerceTyped(raw: string, col: TypedColumn): Scalar | Scalar[]
> Coerce a raw cell to the column's declared type (§2.3). Un-annotated columns
fall back to §3 coercion. Impossible coercions and empty required cells throw
 — never a silent string.
tableSchema(columns: TypedColumn[]): JSONSchema
> Derive a JSON Schema fragment from a typed header (serialize-spec §2.3).

`weight:number` → `{type:'number'}`, `!` → required, `list(;)` →
`{type:'array', 'x-mdd':{separator:';'}}`. The result is derived, never stored.
TableParseError {  }
> Loud, non-silent table-parse error (serialize-spec §6).
TypedColumn { name, type?, required }
ColumnType = | { kind: 'string' } | { kind: 'number' } | { kind: 'boolean' } | { kind: 'list'; sep: string }
serializeWithSchema(obj: unknown, schema: JSONSchema, opts?: SchemaSerializeOptions): string
> Serialize an object to mdd/mdz text through a JSON Schema (serialize-spec §3.3).

Layout by `x-storage` (attr | body | name | id) and `x-mdd` (list: flow | tbl |
lines | blocks, unknown: block). Field order = order of schema `properties` —
deterministic, so the same object always serializes byte-for-byte identically.
parseWithSchema<T = unknown>(text: string, schema: JSONSchema, opts?: ParseWithSchemaOptions): T
> Parse mdd/mdz text back into an object through a JSON Schema (serialize-spec §3.3).

Inverse of : reassembles the object from x-storage
placement and coerces each field by its schema type (schema type wins over
YAML coercion). Generic `<T>` is a TS-only convenience — no runtime effect.
validate(obj: unknown, schema: JSONSchema, opts?: ValidateOptions): ValidationResult
> Validate an object against a schema (serialize-spec §3.4).

Delegates to Ajv2020 with `addVocabulary(['x-storage','x-mdd','x-ui'])` so the
strict mode does not choke on our x-extensions (nr-schema §5). Ajv is an
OPTIONAL peer — when it is not installed and no `opts.validator` is provided,
a clear error is thrown ("install ajv or provide a validator").
UNKNOWN_KEY: "$unknown"
UNKNOWN_OVERFLOW_BLOCK: "_unknown"
JSONSchema = { [k: string]: unknown }
XStorage = 'attr' | 'body' | 'name' | 'id' | 'block'
XListMode = 'flow' | 'tbl' | 'lines' | 'blocks'
XAs = 'json'
SchemaSerializeOptions { sigil?, baseLevel?, eol?, warn? }
ParseWithSchemaOptions { sigil?, baseLevel?, warn? }
ValidationResult { valid, errors }
ValidationError { path, message }
ValidateOptions { validator? }
isScalar(v: unknown): boolean
> A scalar primitive (string / number / boolean). null is NOT a scalar here.
isContext(v: unknown): boolean
> Duck-typed IContext: `get` + `cast`. `cast` is required — without it a `Map`
(native `get`) would pass, and `map.get([seg])` silently yields garbage.
isArray(v: unknown): boolean
> Duck-typed IArray: `at` + `cast`. `cast` is required — without it a native JS
array (Array.prototype.at, Node 16.6+) would pass, and traversal would call
`cast` on it and throw a TypeError instead of degrading softly.
isInterpolated(v: unknown): boolean
> Check whether a value is an InterpolatedValue ({raw, placeholders}).
asText(v: unknown): string | undefined
> Best-effort text view: scalar → string; InterpolatedValue → raw; context/array → cast('text').
Value = unknown
Segment = string | number
IContext { get, func, cast, cast }
IArray { length, at, iterate, cast, cast }
CastMap { text, raw, lines, prompts, paragraphs, records, attrs, keys, tbl, messages, IContext, IArray, NRDocument }
ResolveOptions { mode? }
resolve(text: string, ctx: IContext | Record<string, unknown>, opts?: ResolveOptions | undefined): string
> Resolve every `${expr}` in `text` against `ctx`.

- `ctx` may be a plain Record (auto-wrapped via objectContext, §8.1).
- lenient (default): unresolved placeholder → left literal. strict → throws.
- Cycle detection throws in both modes.
get(path: string | Segment[], ctx?: IContext | Record<string, unknown> | undefined): unknown
> Convenience get (§8.1): parse a string path, wrap a Record, traverse via walk.
walk(val: unknown, segments: Segment[], opts: ResolveOptions): unknown
> Walk a Value along `segments`, one hop per segment.

- IContext + segment → `get([seg])`
- IArray  + number   → `at(seg)`
- IArray  + name     → cross-cast to IContext, then `get([seg])`
- unknown + name     → cross-cast to IContext; unknown + number → IArray

Soft (JS-like) in lenient mode; visible errors in strict mode.
objectContext(obj: Record<string, unknown>): IContext
> Plain object → IContext (nested objects/arrays wrapped lazily).
chainContext(ctxs: IContext[]): IContext
ChainContext { get, func, cast }
> First-hit chain. Parent-chain implemented outside the engine as a utility.

Serialization casts (`text`/`raw`) return undefined: first-hit there would
yield the first link's text, but callers want a specific link's text — they
fetch the link (e.g. `cast('NRDocument')`) and cast that.
emptyContext: IContext
funcContext(fns: Record<string, FuncFn>): IContext
> Function registry → IContext (implements only `func`).
arrayValue(items: unknown[]): IArray
> Plain array → IArray. Elements wrapped on access so nesting traverses.
wrapValue(v: unknown): unknown
> Wrap a raw JS value so further traversal works:
- scalar / null / undefined → as-is
- existing IContext / IArray → as-is
- plain array → arrayValue
- plain object → objectContext
FuncFn = (args: Value[], ctx: IContext) => Value | undefined
NRDocument { get, func, cast, split }
parseDocument(text: string, opts?: ParseOptions | undefined, load?: ExtendsLoader | undefined): NRDocument
> Parse text and wrap it as an NRDocument (keeps the source for `raw`).

`load` — загрузчик `$nr-extends` (см. NRDocument). Без него поведение прежнее:
блоки с `$nr-extends` не наследуют, чтение унаследованного ключа — ошибка.
blockSelf(block: Block, source?: string, load?: ExtendsLoader | undefined): IContext
> Композитный `self` блока (C2): `chainContext(own-атрибуты, $nr-extends база)`.
own-wins (база = дефолты). Virtual dispatch: ссылки базы на `${self.x}` видят
переопределения наследника, потому что own стоит первым в цепочке.
selfScope(self: IContext, opts?: SelfOptions): IContext
> Контекст резолва с привязанным `self` (C2). Голый `${x}` проваливается в
reader (свободная переменная-параметр, C1); `${self.x}` — связан к композиту.
Функции — из opts.functions или stdlib.
resolveBlockValue(block: Block, name: string, opts?: SelfOptions): string
> Резолв значения атрибута (или тела) блока с привязанным `self` (C2/C3).

`name === 'body'`/`'text'` — тело блока (или унаследованное от базы); иначе —
атрибут (own или из `$nr-extends` базы). Сырое значение берётся ИЗ self, а
резолвится об `selfScope`, поэтому virtual dispatch работает: json из базы с
`${self.model}` видит model наследника.
SelfOptions { reader?, load?, functions?, mode? }
ExtendsLoader = (path: string) => string
coreFunctions: Record<string, FuncFn>
resolveIncludes(text: string, readFile: (path: string) => string | undefined, opts?: IncludeOptions | undefined): string
> Resolve file includes in text. Replaces `$[[path]]` / `$[[path#section]]`
with file/section content, recursively. Cycle detection by path.

readFile: `(path: string) => string | undefined` — returns file content
or undefined if not found (left as-is in output).

Async version: resolveIncludesAsync.
resolveIncludesAsync(text: string, readFile: (path: string) => Promise<string | undefined>, opts?: IncludeOptions | undefined): Promise<string>
> Async version — readFile returns Promise.
extractSection(content: string, sectionName: string): string | undefined
> Extract a section from markdown by heading name. Case-insensitive.
Returns content from that heading until next heading of same/higher level.
Returns undefined if not found.
IncludeOptions { maxDepth?, sigil? }
cartesian(collections: Map<string, IArray>, opts?: CartesianOptions | undefined): IContext[]
> Cartesian product of named collections.

Each combo → IContext where name → element (scalar or IContext, as-is).
Empty collection in the set → 0 combos (mathematically correct).
Zero collections → one empty combo (template without variables = one result).
CartesianOptions { order? }
Sigil = '@' | '$'
ParseOptions { sigil?, baseLevel? }
SerializeOptions { sigil?, baseLevel?, eol? }
Document { sigil, root }
Block { name, id?, level, attrs, body?, children }
Attribute { key, value }
AttributeValue = Scalar | ListItem[] | InterpolatedValue
BodyValue = string | InterpolatedValue
Scalar = string | number | boolean | null
ListItem = Scalar | InterpolatedValue
InterpolatedValue { raw, placeholders }
Placeholder { raw, expr, start, end }
PlaceholderExpr = | { kind: 'path'; segments: PathSegment[] } | { kind: 'call'; name: string; args: PlaceholderArg[] }
PlaceholderArg = | { kind: 'path'; segments: PathSegment[] } | { kind: 'literal'; value: string | number | boolean | null } | { kind: 'placeholder'; value: Placeholder }
PathSegment = | { kind: 'name'; value: string } | { kind: 'index'; value: number } | { kind: 'placeholder'; value: Placeholder }