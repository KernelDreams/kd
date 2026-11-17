// Грамматика `${}` (§7) — фасад.
//
// Ступень 3 Total Refactor: язык выражений `${}` переехал в
// `@kerneldreams/nrd/contracts/eval`. Файл держит публичную поверхность nrd-core
// (`./placeholder.js`) без изменений — реэкспорт 1:1.

export { scanPlaceholders, parseExpr, findMatchingBrace } from '../contracts/eval/index.js'
export type { Placeholder, PlaceholderExpr, PlaceholderArg, PathSegment } from '../contracts/eval/index.js'
