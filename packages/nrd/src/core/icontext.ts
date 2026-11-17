// Engine core types + guards — домашний реэкспорт из @kerneldreams/nrd/contracts.
//
// Ступень 1 Total Refactor: протокол доступа к значениям (IContext/IArray,
// Value, Segment, CastMap, ResolveOptions + guards) переехал в контракт. Файл
// остаётся домом для внутренних импортов nrd-core (`./icontext.js`) и держит
// публичную поверхность корня `@kerneldreams/nrd` без изменений.
//
// Value — смена владельца (§2.2): контракт объявляет канонический Value, nrd-core
// отдаёт его отсюда; парсер (format/types.ts) держит свой локальный Value = unknown.

export {
  isScalar,
  isContext,
  isArray,
  isInterpolated,
  asText,
  toText,
  textView,
} from '../contracts/index.js'

export type {
  Value,
  Segment,
  IContext,
  IArray,
  CastMap,
  ResolveOptions,
  TextCastOptions,
} from '../contracts/index.js'
