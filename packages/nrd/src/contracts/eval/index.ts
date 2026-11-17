// @kerneldreams/nrd/contracts/eval — семантика `${}` и IContext-механика.
//
// Ступень 3 Total Refactor: eval-ядро вынесено из nrd-core сюда,
// subpath-раздел контракта. Импорт корня contracts НЕ тащит движок — /eval
// подключается явно. Единственный рантайм-деп слоя: `@kerneldreams/nrd/json5`
// (сериализация JSON5-объекта при интерполяции). nrd-core реэкспортирует эти
// имена под прежними путями — поверхность потребителей 1:1.

// ---------- Грамматика `${}` (§7) ----------
export { scanPlaceholders, parseExpr, findMatchingBrace } from './placeholder.js'
export type { Placeholder, PlaceholderExpr, PlaceholderArg, PathSegment } from './placeholder.js'

// ---------- Resolver + walk (§3, §4, §8.1) ----------
export { resolve, resolveValue, get, unescapeOptOut } from './resolve.js'
export { walk } from './walk.js'

// ---------- Standard implementations (§5, §8) ----------
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

// ---------- Stdlib чистых функций (core-hardening §C5) ----------
export { coreFunctions } from './functions.js'

// ---------- Fan-out (§7) ----------
export { cartesian } from './cartesian.js'
export type { CartesianOptions } from './cartesian.js'
